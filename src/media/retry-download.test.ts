import { describe, expect, it } from "vitest";
import { Refusal } from "../refusal.ts";
import { arr } from "../sources/arr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { retryDownload } from "./retry-download.ts";

const sonarrUrl = "http://sonarr.example:8989";
const sonarrKey = "test-sonarr-key-0000";
const queueUrl = `${sonarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true`;
const removeUrl = (id: number) =>
  `${sonarrUrl}/api/v3/queue/${id}?removeFromClient=true&blocklist=true&skipRedownload=false`;

const settingsUrl = `${sonarrUrl}/api/v3/config/downloadclient`;
const redownloadOn = { body: '{"id":1,"autoRedownloadFailed":true}' };

function retry(answers: Record<string, FakeAnswer>) {
  const { fetch, requests } = fakeFetch({
    [queueUrl]: fixture("sonarr/queue.json"),
    [settingsUrl]: redownloadOn,
    ...answers,
  });
  const action = retryDownload([arr(fetch, sonarrUrl, sonarrKey, "Sonarr")]);
  const deletes = () => requests.filter((r) => r.init?.method === "DELETE");
  return { action, deletes };
}

describe("retry_download", () => {
  it("removes a stuck download, blocklists its release and has the app search for another", async () => {
    const { action, deletes } = retry({ [removeUrl(102)]: { body: "" } });

    expect(await action.handler({ app: "Sonarr", id: 102 })).toBe(
      "Removed Second Show S01E10 from Sonarr's queue and the download client, and blocklisted its release, " +
        "Second.Show.S01E10.720p.HDTV.x264-OTHER. Sonarr is searching for a replacement.",
    );
    expect(deletes().map((r) => r.url)).toEqual([removeUrl(102)]);
    expect(new Headers(deletes()[0]?.init?.headers).get("X-Api-Key")).toBe(sonarrKey);
  });

  it("finds a season pack by any of its episodes' ids", async () => {
    const { action, deletes } = retry({ [removeUrl(103)]: { body: "" } });

    expect(await action.handler({ app: "Sonarr", id: 106, discard_downloaded: true })).toMatch(
      /^Removed Pack Show, 2 episodes from Sonarr's queue/,
    );
    expect(deletes().map((r) => r.url)).toEqual([removeUrl(103)]);
  });

  it("refuses a download whose files have arrived, pointing to manual_import, and touches nothing", async () => {
    const { action, deletes } = retry({});

    await expect(action.handler({ app: "Sonarr", id: 103 })).rejects.toThrow(
      new Refusal(
        "Pack Show, 2 episodes has finished downloading (import blocked), so retrying would throw its files away. " +
          "Try manual_import first, or call again with discard_downloaded set to true.",
      ),
    );
    expect(deletes()).toEqual([]);
  });

  it("says when an unmatched download can't be searched for again", async () => {
    const { action } = retry({ [removeUrl(105)]: { body: "" } });

    expect(await action.handler({ app: "Sonarr", id: 105, discard_downloaded: true })).toBe(
      "Removed Mystery.Release.2026.1080p.WEB.h264-NOBODY from Sonarr's queue and the download client, and " +
        "blocklisted its release. It isn't matched to a series, so Sonarr won't search for a replacement.",
    );
  });

  it("refuses an id that isn't in the queue", async () => {
    const { action, deletes } = retry({});

    await expect(action.handler({ app: "Sonarr", id: 999 })).rejects.toThrow(
      new Refusal("Sonarr's queue has no download 999. download_queue shows each one's id."),
    );
    expect(deletes()).toEqual([]);
  });

  it("refuses an app that isn't configured", async () => {
    const { action } = retry({});

    await expect(action.handler({ app: "Radarr", id: 1 })).rejects.toThrow(
      new Refusal("Radarr isn't configured on this server."),
    );
  });

  it("says when the download left the queue before it could be removed", async () => {
    const { action } = retry({ [removeUrl(102)]: { status: 404, body: "" } });

    await expect(action.handler({ app: "Sonarr", id: 102 })).rejects.toThrow(
      new Refusal("Second Show S01E10 is no longer in Sonarr's queue, so nothing was removed."),
    );
  });
  it("says the app won't search again when its Redownload Failed setting is off", async () => {
    const { action } = retry({
      [removeUrl(102)]: { body: "" },
      [settingsUrl]: { body: '{"id":1,"autoRedownloadFailed":false}' },
    });

    expect(await action.handler({ app: "Sonarr", id: 102 })).toMatch(
      /blocklisted its release, Second\.Show\.S01E10\.720p\.HDTV\.x264-OTHER\. Sonarr's Redownload Failed setting is off, so it won't search for a replacement by itself\.$/,
    );
  });

  it("only says a search was asked for when the setting can't be read", async () => {
    const { action } = retry({
      [removeUrl(102)]: { body: "" },
      [settingsUrl]: { status: 500, body: "" },
    });

    expect(await action.handler({ app: "Sonarr", id: 102 })).toMatch(
      /Sonarr was asked to search for a replacement\.$/,
    );
  });

  it("refuses a download still waiting for the app's delay: nothing has reached the download client", async () => {
    const delayed = {
      totalRecords: 1,
      records: [
        {
          id: 301,
          series: { title: "Later Show" },
          episode: { seasonNumber: 2, episodeNumber: 1 },
          title: "Later.Show.S02E01.1080p-LATE",
          status: "delay",
        },
      ],
    };
    const { action, deletes } = retry({ [queueUrl]: { body: JSON.stringify(delayed) } });

    await expect(action.handler({ app: "Sonarr", id: 301 })).rejects.toThrow(
      new Refusal(
        "Later Show S02E01 hasn't started downloading yet (it's waiting for Sonarr's delay), so there's nothing to retry.",
      ),
    );
    expect(deletes()).toEqual([]);
  });

  it("treats a season pack as downloaded when any of its episodes has arrived", async () => {
    const record = (id: number, extra: object) => ({
      id,
      series: { title: "Mixed Show" },
      episode: { seasonNumber: 1, episodeNumber: id },
      title: "Mixed.Show.S01-MIX",
      downloadId: "MIX",
      status: "completed",
      trackedDownloadStatus: "ok",
      trackedDownloadState: "importPending",
      ...extra,
    });
    const mixed = {
      totalRecords: 2,
      records: [
        record(401, {
          status: "failed",
          trackedDownloadStatus: "error",
          trackedDownloadState: "failed",
        }),
        record(402, {}),
      ],
    };
    const { action, deletes } = retry({ [queueUrl]: { body: JSON.stringify(mixed) } });

    await expect(action.handler({ app: "Sonarr", id: 401 })).rejects.toThrow(
      /has finished downloading/,
    );
    expect(deletes()).toEqual([]);
  });

  it("retries a film in Radarr the same way", async () => {
    const radarrUrl = "http://radarr.example:7878";
    const { fetch } = fakeFetch({
      [`${radarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true&includeMovie=true`]:
        fixture("radarr/queue.json"),
      [`${radarrUrl}/api/v3/config/downloadclient`]: redownloadOn,
      [`${radarrUrl}/api/v3/queue/201?removeFromClient=true&blocklist=true&skipRedownload=false`]: {
        body: "",
      },
    });
    const action = retryDownload([arr(fetch, radarrUrl, "test-radarr-key-0000", "Radarr")]);

    expect(await action.handler({ app: "Radarr", id: 201 })).toBe(
      "Removed Example Film (2025) from Radarr's queue and the download client, and blocklisted its release, " +
        "Example.Film.2025.2160p.WEB.h265-GROUP. Radarr is searching for a replacement.",
    );
  });
});
