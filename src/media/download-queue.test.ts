import { describe, expect, it } from "vitest";
import { arr } from "../sources/arr.ts";
import { disk } from "../sources/disk.ts";
import { docker } from "../sources/docker.ts";
import { SourceError } from "../sources/source-error.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { buildTools, type Sources, type Tool } from "../tools.ts";

const sonarrUrl = "http://sonarr.example:8989";
const radarrUrl = "http://radarr.example:7878";
const sonarrKey = "test-sonarr-key-0000";
const radarrKey = "test-radarr-key-0000";
const sonarrQueue = `${sonarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true`;
const radarrQueue = `${radarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownMovieItems=true&includeMovie=true`;

function sources(
  fetch: typeof globalThis.fetch,
  on: { sonarr?: boolean; radarr?: boolean } = { sonarr: true, radarr: true },
): Sources {
  return {
    docker: docker(fetch, "http://proxy.example:2375"),
    disk: disk([]),
    ...(on.sonarr ? { sonarr: arr(fetch, sonarrUrl, sonarrKey, "Sonarr") } : {}),
    ...(on.radarr ? { radarr: arr(fetch, radarrUrl, radarrKey, "Radarr") } : {}),
  };
}

function downloadQueue(
  answers: Record<string, FakeAnswer>,
  on?: { sonarr?: boolean; radarr?: boolean },
): { tool: Tool; requests: ReturnType<typeof fakeFetch>["requests"] } {
  const { fetch, requests } = fakeFetch(answers);
  const tool = buildTools(sources(fetch, on), { privateContainers: [] }).find(
    (t) => t.name === "download_queue",
  );
  if (!tool) throw new Error("download_queue isn't offered");
  return { tool, requests };
}

describe("download_queue", () => {
  it("is offered when Sonarr or Radarr is on, and not when neither is", () => {
    const { fetch } = fakeFetch({});
    const names = (on: { sonarr?: boolean; radarr?: boolean }) =>
      buildTools(sources(fetch, on), { privateContainers: [] }).map((t) => t.name);
    expect(names({})).not.toContain("download_queue");
    expect(names({ sonarr: true })).toContain("download_queue");
    expect(names({ radarr: true })).toContain("download_queue");
    expect(names({})).not.toContain("import_candidates");
    expect(names({ sonarr: true })).toContain("import_candidates");
    expect(names({ radarr: true })).toContain("import_candidates");
    expect(names({ sonarr: true, radarr: true })).not.toContain("manual_import");
  });

  it("lists both queues together, problems first, one line per download with the app's own message", async () => {
    const { tool } = downloadQueue({
      [sonarrQueue]: fixture("sonarr/queue.json"),
      [radarrQueue]: fixture("radarr/queue.json"),
    });

    expect(await tool.handler({})).toBe(
      [
        "7 downloads in the queue, 5 with problems.",
        "",
        "Problems:",
        "- Sonarr 104: Broken Show S04E01, failed: The download is missing files",
        "- Radarr 202: Second Film (2019), import blocked: No files found are eligible for import",
        "- Sonarr 103: Pack Show, 2 episodes, import blocked: Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible.",
        "- Sonarr 105: Mystery.Release.2026.1080p.WEB.h264-NOBODY, import pending",
        "- Sonarr 102: Second Show S01E10, stalled, 12%: The download is stalled with no connections",
        "",
        "Downloading or waiting:",
        "- Radarr 201: Example Film (2025), 75%",
        "- Sonarr 101: Example Show S02E03, 42%",
      ].join("\n"),
    );
  });

  it("sends each app's API key in a header, never in the URL", async () => {
    const { tool, requests } = downloadQueue({
      [sonarrQueue]: fixture("sonarr/queue-empty-recorded.json"),
      [radarrQueue]: fixture("radarr/queue-empty-recorded.json"),
    });
    await tool.handler({});

    const headers = (url: string) =>
      new Headers(requests.find((r) => r.url === url)?.init?.headers).get("X-Api-Key");
    expect(headers(sonarrQueue)).toBe(sonarrKey);
    expect(headers(radarrQueue)).toBe(radarrKey);
    for (const { url } of requests) {
      expect(url).not.toContain(sonarrKey);
      expect(url).not.toContain(radarrKey);
    }
  });

  it("says the queue is empty, naming the apps it asked", async () => {
    const both = downloadQueue({
      [sonarrQueue]: fixture("sonarr/queue-empty-recorded.json"),
      [radarrQueue]: fixture("radarr/queue-empty-recorded.json"),
    });
    expect(await both.tool.handler({})).toBe("The download queue is empty (Sonarr and Radarr).");

    const one = downloadQueue(
      { [sonarrQueue]: fixture("sonarr/queue-empty-recorded.json") },
      { sonarr: true },
    );
    expect(await one.tool.handler({})).toBe("The download queue is empty (Sonarr).");
  });

  it("still lists one app's queue when the other can't be reached, saying so", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.10:7878"), {
        code: "ECONNREFUSED",
      }),
    });
    const { tool } = downloadQueue({
      [sonarrQueue]: fixture("sonarr/queue.json"),
      [radarrQueue]: refused,
    });

    const text = await tool.handler({});
    expect(text.split("\n").slice(0, 2)).toEqual([
      "5 downloads in the queue, 4 with problems.",
      "Radarr couldn't be read: Couldn't reach Radarr (ECONNREFUSED).",
    ]);
    expect(text).not.toContain("192.0.2.10");
  });

  it("fails with both apps' sentences when neither can be read", async () => {
    const { tool } = downloadQueue({
      [sonarrQueue]: { status: 401, body: '{"error":"Unauthorized"}' },
      [radarrQueue]: { status: 500, body: "" },
    });

    await expect(tool.handler({})).rejects.toThrow(
      new SourceError("Sonarr answered with HTTP 401. Radarr answered with HTTP 500."),
    );
  });

  const radarrPage = (n: number) =>
    `${radarrUrl}/api/v3/queue?page=${n}&pageSize=100&includeUnknownMovieItems=true&includeMovie=true`;
  const page = (totalRecords: number, records: object[]) => ({
    body: JSON.stringify({ totalRecords, records }),
  });
  const film = (id: number, extra: object) => ({
    id,
    movie: { title: `Film ${id}`, year: 2020 },
    size: 1000,
    sizeleft: 500,
    status: "downloading",
    trackedDownloadStatus: "ok",
    trackedDownloadState: "downloading",
    downloadId: `D${id}`,
    ...extra,
  });

  it("reads every page of a long queue, so a big season pack can't push other downloads out", async () => {
    const { tool } = downloadQueue(
      {
        [radarrPage(1)]: page(3, [film(1, {}), film(2, {})]),
        [radarrPage(2)]: page(3, [film(3, { status: "failed", trackedDownloadStatus: "error" })]),
      },
      { radarr: true },
    );

    const text = await tool.handler({});
    expect(text).toMatch(/^3 downloads in the queue, 1 with problems\./);
    expect(text).toContain("- Radarr 3: Film 3 (2020), failed");
  });

  it("says when a queue stops answering pages before every record was read", async () => {
    const { tool } = downloadQueue(
      { [radarrPage(1)]: page(150, [film(1, {})]), [radarrPage(2)]: page(150, []) },
      { radarr: true },
    );

    expect(await tool.handler({})).toContain("Only 1 of 150 Radarr queue records could be read.");
  });

  it("shows a download client that's down as a problem, not as downloading", async () => {
    const { tool } = downloadQueue(
      {
        [radarrPage(1)]: page(1, [
          film(4, {
            status: "downloadClientUnavailable",
            statusMessages: [{ messages: ["Download client is unavailable"] }],
          }),
        ]),
      },
      { radarr: true },
    );

    expect(await tool.handler({})).toBe(
      [
        "1 download in the queue, 1 with problems.",
        "",
        "Problems:",
        "- Radarr 4: Film 4 (2020), download client unavailable, 50%: Download client is unavailable",
      ].join("\n"),
    );
  });

  it("shows a season pack at its worst episode's state, and groups a delayed pack that has no download yet", async () => {
    const episode = (id: number, extra: object) => ({
      id,
      series: { title: "Pack Show" },
      episode: { seasonNumber: 1, episodeNumber: id },
      title: "Pack.Show.S01.1080p-PACK",
      size: 1000,
      sizeleft: 0,
      status: "completed",
      trackedDownloadStatus: "ok",
      trackedDownloadState: "importPending",
      downloadId: "PACK",
      ...extra,
    });
    const delayed = (id: number) => ({
      id,
      series: { title: "Later Show" },
      episode: { seasonNumber: 2, episodeNumber: id },
      title: "Later.Show.S02.1080p-LATE",
      status: "delay",
    });
    const { tool } = downloadQueue(
      {
        [sonarrQueue]: page(5, [
          episode(1, {}),
          episode(2, {
            trackedDownloadStatus: "warning",
            trackedDownloadState: "importBlocked",
            statusMessages: [{ messages: ["Episode file already imported"] }],
          }),
          episode(3, {}),
          delayed(11),
          delayed(12),
        ]),
      },
      { sonarr: true },
    );

    expect(await tool.handler({})).toBe(
      [
        "2 downloads in the queue, 1 with problems.",
        "",
        "Problems:",
        "- Sonarr 2: Pack Show, 3 episodes, import blocked: Episode file already imported",
        "",
        "Downloading or waiting:",
        "- Sonarr 11: Later Show, 2 episodes, queued",
      ].join("\n"),
    );
  });

  it("never shows an unfinished download as 100%", async () => {
    const { tool } = downloadQueue(
      { [radarrPage(1)]: page(1, [film(5, { size: 1000, sizeleft: 1 })]) },
      { radarr: true },
    );

    expect(await tool.handler({})).toContain("- Radarr 5: Film 5 (2020), 99%");
  });

  it("says an answer that isn't a queue is unexpected", async () => {
    const { tool } = downloadQueue(
      { [radarrQueue]: { body: '{"records":"no"}' } },
      { radarr: true },
    );

    await expect(tool.handler({})).rejects.toThrow(
      new SourceError("Radarr answered with something unexpected."),
    );
  });
});
