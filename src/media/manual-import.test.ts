import { afterEach, describe, expect, it, vi } from "vitest";
import { Refusal } from "../refusal.ts";
import { arr } from "../sources/arr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { importCandidates, manualImport } from "./manual-import.ts";

const sonarrUrl = "http://sonarr.example:8989";
const radarrUrl = "http://radarr.example:7878";
const sonarrQueue = `${sonarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true`;
const radarrQueue = `${radarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true&includeMovie=true`;
const packDownload = "CCCC3333CCCC3333CCCC3333CCCC3333CCCC3333";
const candidatesUrl = (url: string, downloadId: string) =>
  `${url}/api/v3/manualimport?downloadId=${downloadId}&filterExistingFiles=true`;
const commandUrl = `${sonarrUrl}/api/v3/command`;
const command = (status: string, extra: object = {}) => ({
  body: JSON.stringify({ id: 77, name: "ManualImport", status, ...extra }),
});

function sonarr(answers: Record<string, FakeAnswer>) {
  const { fetch, requests } = fakeFetch({
    [sonarrQueue]: fixture("sonarr/queue.json"),
    [candidatesUrl(sonarrUrl, packDownload)]: fixture("sonarr/manualimport.json"),
    ...answers,
  });
  return { apps: [arr(fetch, sonarrUrl, "test-sonarr-key-0000", "Sonarr")], requests };
}

describe("import_candidates", () => {
  it("names exact episodes even across gaps and seasons", async () => {
    const rows = JSON.parse(new TextDecoder().decode(fixture("sonarr/manualimport.json").body));
    rows[0].episodes = [
      { id: 901, seasonNumber: 1, episodeNumber: 1 },
      { id: 903, seasonNumber: 1, episodeNumber: 3 },
      { id: 904, seasonNumber: 2, episodeNumber: 1 },
    ];
    const { apps } = sonarr({
      [candidatesUrl(sonarrUrl, packDownload)]: { body: JSON.stringify(rows) },
    });
    expect(await importCandidates(apps).handler({ app: "Sonarr", id: 103 })).toContain(
      "Pack Show S01E01, S01E03, S02E01",
    );
  });
  it("shows what a manual import would do with each file, importing nothing", async () => {
    const { apps, requests } = sonarr({});

    expect(await importCandidates(apps).handler({ app: "Sonarr", id: 103 })).toBe(
      [
        "Pack Show, 2 episodes (Sonarr 103): 2 of 4 files can be imported.",
        "",
        "Would import:",
        "- Pack.Show.S01E01.1080p.BluRay.x265-PACK.mkv: Pack Show S01E01, Bluray-1080p",
        "- Pack.Show.S01E02.1080p.BluRay.x265-PACK.mkv: Pack Show S01E02, Bluray-1080p",
        "",
        "Would skip:",
        "- Sample/pack.show.s01e01.sample.mkv: Pack Show S01E01, Bluray-1080p; Sample",
        "- Extras/Behind.The.Scenes.mkv: not matched, Unknown (Unknown Series)",
      ].join("\n"),
    );
    expect(requests.every((r) => (r.init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("refuses a download that hasn't reached the download client yet", async () => {
    const delayed = {
      totalRecords: 1,
      records: [{ id: 301, title: "Later.Show.S02E01-LATE", status: "delay" }],
    };
    const { apps } = sonarr({ [sonarrQueue]: { body: JSON.stringify(delayed) } });

    await expect(importCandidates(apps).handler({ app: "Sonarr", id: 301 })).rejects.toThrow(
      new Refusal(
        "Later.Show.S02E01-LATE hasn't reached the download client yet, so it has no files to import.",
      ),
    );
  });

  it("refuses an id that isn't in the queue", async () => {
    const { apps } = sonarr({});

    await expect(importCandidates(apps).handler({ app: "Sonarr", id: 999 })).rejects.toThrow(
      new Refusal("Sonarr's queue has no download 999. download_queue shows each one's id."),
    );
  });

  it("says when the app finds no video files in the download", async () => {
    const { apps } = sonarr({ [candidatesUrl(sonarrUrl, packDownload)]: { body: "[]" } });

    expect(await importCandidates(apps).handler({ app: "Sonarr", id: 103 })).toBe(
      "Pack Show, 2 episodes (Sonarr 103): Sonarr found no video files to import.",
    );
  });
});

describe("manual_import", () => {
  afterEach(() => vi.useRealTimers());
  it("imports the matched files, skips the rest and waits for the app to finish", async () => {
    const { apps, requests } = sonarr({
      [commandUrl]: command("queued"),
      [`${commandUrl}/77`]: command("completed", { result: "successful" }),
    });

    expect(await manualImport(apps).handler({ app: "Sonarr", id: 103 })).toBe(
      [
        "Sonarr finished the import command for 2 files from Pack Show, 2 episodes: Pack Show S01E01, Pack Show S01E02. Check download_queue and the library to confirm they arrived.",
        "",
        "Skipped:",
        "- Sample/pack.show.s01e01.sample.mkv: Pack Show S01E01, Bluray-1080p; Sample",
        "- Extras/Behind.The.Scenes.mkv: not matched, Unknown (Unknown Series)",
      ].join("\n"),
    );

    const post = requests.find((r) => r.init?.method === "POST");
    const body = JSON.parse(String(post?.init?.body));
    expect(body.name).toBe("ManualImport");
    expect(body.importMode).toBe("auto");
    expect(body.files.map((f: { path: string }) => f.path.split("/").pop())).toEqual([
      "Pack.Show.S01E01.1080p.BluRay.x265-PACK.mkv",
      "Pack.Show.S01E02.1080p.BluRay.x265-PACK.mkv",
    ]);
    expect(body.files[0]).toMatchObject({
      seriesId: 9,
      seasonNumber: 1,
      episodeIds: [901],
      downloadId: packDownload,
      quality: { quality: { id: 7, name: "Bluray-1080p", resolution: 1080 } },
    });
  });

  it("imports a film in Radarr with its film's id", async () => {
    const { fetch, requests } = fakeFetch({
      [radarrQueue]: fixture("radarr/queue.json"),
      [candidatesUrl(radarrUrl, "1111AAAA1111AAAA1111AAAA1111AAAA1111AAAA")]: fixture(
        "radarr/manualimport.json",
      ),
      [`${radarrUrl}/api/v3/command`]: command("queued"),
      [`${radarrUrl}/api/v3/command/77`]: command("completed", { result: "successful" }),
    });
    const apps = [arr(fetch, radarrUrl, "test-radarr-key-0000", "Radarr")];

    expect(await manualImport(apps).handler({ app: "Radarr", id: 202 })).toBe(
      "Radarr finished the import command for 1 file from Second Film (2019): Second Film (2019). Check download_queue and the library to confirm they arrived.",
    );
    const body = JSON.parse(String(requests.find((r) => r.init?.method === "POST")?.init?.body));
    expect(body.files[0]).toMatchObject({
      movieId: 32,
      downloadId: "1111AAAA1111AAAA1111AAAA1111AAAA1111AAAA",
    });
    expect(body.files[0]).not.toHaveProperty("seriesId");
  });

  it("refuses, importing nothing, when no file can be imported", async () => {
    const onlyRejected = JSON.parse(
      new TextDecoder().decode(fixture("sonarr/manualimport.json").body),
    ).slice(2);
    const { apps, requests } = sonarr({
      [candidatesUrl(sonarrUrl, packDownload)]: { body: JSON.stringify(onlyRejected) },
    });

    await expect(manualImport(apps).handler({ app: "Sonarr", id: 103 })).rejects.toThrow(
      new Refusal(
        "None of the 2 files in Pack Show, 2 episodes can be imported, so nothing was imported. Sample/pack.show.s01e01.sample.mkv: Pack Show S01E01, Bluray-1080p; Sample. Extras/Behind.The.Scenes.mkv: not matched, Unknown (Unknown Series). Fix the matches in Sonarr's own Manual Import.",
      ),
    );
    expect(requests.some((r) => r.init?.method === "POST")).toBe(false);
  });

  it("says the import is still running when the app hasn't finished in time", async () => {
    const { apps } = sonarr({
      [commandUrl]: command("queued"),
      [`${commandUrl}/77`]: command("started"),
    });

    vi.useFakeTimers();
    const pending = manualImport(apps).handler({ app: "Sonarr", id: 103 });
    await vi.runAllTimersAsync();
    expect(await pending).toMatch(
      /^Sonarr is still importing 2 files from Pack Show, 2 episodes\. download_queue shows when it's done\./,
    );
  });

  it("refuses with the app's own message when the import fails", async () => {
    const { apps } = sonarr({
      [commandUrl]: command("queued"),
      [`${commandUrl}/77`]: command("failed", { message: "Destination already exists" }),
    });

    await expect(manualImport(apps).handler({ app: "Sonarr", id: 103 })).rejects.toThrow(
      "Sonarr's import failed: Destination already exists",
    );
  });
});
