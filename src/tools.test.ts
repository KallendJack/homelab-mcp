import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Refusal } from "./refusal.ts";
import { type DiskPath, disk } from "./sources/disk.ts";
import { docker } from "./sources/docker.ts";
import { gatus } from "./sources/gatus.ts";
import { jellyfin } from "./sources/jellyfin.ts";
import { report } from "./sources/report.ts";
import { SourceError } from "./sources/source-error.ts";
import { fakeFetch, fixture } from "./testing/fake-fetch.ts";
import { buildTools, type Sources, type Tool } from "./tools.ts";

const dockerUrl = "http://proxy.example:2375";
const containersUrl = `${dockerUrl}/containers/json?all=true`;

function tool(
  name: string,
  fetch: typeof globalThis.fetch,
  privateContainers: string[] = [],
  diskPaths: DiskPath[] = [{ label: "root", path: tmpdir() }],
): Tool {
  const sources = { docker: docker(fetch, dockerUrl), disk: disk(diskPaths) };
  const found = buildTools(sources, { privateContainers }).find((t) => t.name === name);
  if (!found) throw new Error(`${name} isn't offered`);
  return found;
}

const listContainers = (fetch: typeof globalThis.fetch) => tool("list_containers", fetch);

function logsUrl(name: string, tail: number): string {
  return `${dockerUrl}/containers/${name}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`;
}

describe("list_containers", () => {
  it("lists every Container, the ones needing attention first, each group by name", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: fixture("docker/containers.json") });

    expect(await listContainers(fetch).handler({})).toBe(
      [
        "5 Containers, 3 need attention.",
        "",
        "Need attention:",
        "- backup-job: exited, Exited (1) 3 hours ago (alpine:3.20)",
        "- media-server: running, Up 2 days (unhealthy) (jellyfin/jellyfin:10.11.0)",
        "- sync-worker: restarting, Restarting (1) 20 seconds ago (example/sync:1.4.0)",
        "",
        "Running normally:",
        "- dashboard: Up 2 days (glanceapp/glance:v0.8.6)",
        "- dns: Up 5 hours (healthy) (adguard/adguardhome:v0.107.79)",
      ].join("\n"),
    );
  });

  it("tells the Client when Docker times out, and asks with a time limit", async () => {
    const { fetch, requests } = fakeFetch({
      [containersUrl]: new DOMException("The operation timed out.", "TimeoutError"),
    });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker didn't answer within 10 seconds."),
    );
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a timeout while reading Docker's answer as a timeout", async () => {
    const stalledBody = new ReadableStream({
      pull: (controller) =>
        controller.error(new DOMException("The operation timed out.", "TimeoutError")),
    });
    const fetch = (async () => new Response(stalledBody)) as typeof globalThis.fetch;

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker didn't answer within 10 seconds."),
    );
  });

  it("says Docker can't be reached, giving only the network error code", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:2375"), {
        code: "ECONNREFUSED",
      }),
    });
    const { fetch } = fakeFetch({ [containersUrl]: refused });

    const failure = listContainers(fetch).handler({});
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    await expect(failure).rejects.toThrow("Couldn't reach Docker (ECONNREFUSED).");
  });

  it("never passes a network error's own text to the Client, which could name the Host", async () => {
    const { fetch } = fakeFetch({
      [containersUrl]: new TypeError("Failed to parse URL from http://nas.example:2375"),
    });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Couldn't reach Docker."),
    );
  });

  it("passes on an error status from Docker", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: { status: 403, body: "Forbidden" } });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker answered with HTTP 403."),
    );
  });

  it("says so when Docker's answer isn't the expected shape", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: { body: '{"message":"page not found"}' } });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker answered with something unexpected."),
    );
  });
});

describe("container_logs", () => {
  const containerLogs = (fetch: typeof globalThis.fetch, privateContainers: string[] = []) =>
    tool("container_logs", fetch, privateContainers);

  it("returns Docker's framed log stream as clean lines, stdout and stderr in order, with timestamps", async () => {
    const { fetch } = fakeFetch({
      [containersUrl]: fixture("docker/containers.json"),
      [logsUrl("media-server", 100)]: fixture("docker/logs-framed.bin"),
    });

    expect(await containerLogs(fetch).handler({ name: "media-server" })).toBe(
      [
        "media-server: last 7 log lines, oldest first.",
        "",
        "2026-09-30 07:59:58 Starting media server 10.11.0",
        "2026-09-30 07:59:59 Loading libraries",
        "2026-09-30 08:00:02 Libraries loaded: 3",
        "2026-09-30 08:00:05 [WRN] Transcode cache is 91% full",
        "2026-09-30 08:00:07 Scheduled task 'Scan media library' completed after 00:00:04.21",
        "2026-09-30 08:00:09 Client connected: device=living-room-tv app=Jellyfin Android TV 0.18.2 user-agent=Mozilla/5.0 (Linux; Android 12) playback=direct-play",
        "2026-09-30 08:00:11 [ERR] Failed to probe /media/films/example.mkv: file not found",
      ].join("\n"),
    );
  });

  it.each([
    [20, 20],
    [500, 500],
    [900, 500],
  ])("asks Docker for %i lines as %i, since 500 is the most it returns", async (asked, sent) => {
    const { fetch, requests } = fakeFetch({
      [containersUrl]: fixture("docker/containers.json"),
      [logsUrl("sync-worker", sent)]: fixture("docker/logs-plain.txt"),
    });

    await containerLogs(fetch).handler({ name: "sync-worker", lines: asked });
    expect(requests.map((r) => r.url)).toContain(logsUrl("sync-worker", sent));
  });

  it("refuses a Private container without contacting Docker", async () => {
    const { fetch, requests } = fakeFetch({});

    await expect(
      containerLogs(fetch, ["chat-bridge"]).handler({ name: "chat-bridge" }),
    ).rejects.toThrow(
      new Refusal(
        "chat-bridge is a Private container, so its logs are never returned. Its status still shows in list_containers.",
      ),
    );
    expect(requests).toEqual([]);
  });

  it.each([
    [
      "media",
      'No Container is named "media". Closest: media-server. list_containers shows every name.',
    ],
    [
      "sync-wroker",
      'No Container is named "sync-wroker". Closest: sync-worker. list_containers shows every name.',
    ],
    [
      "Media-Server",
      'No Container is named "Media-Server". Closest: media-server. list_containers shows every name.',
    ],
    ["postgres", 'No Container is named "postgres". list_containers shows every name.'],
  ])("refuses the unknown name %s, suggesting only names that are close", async (name, message) => {
    const { fetch } = fakeFetch({ [containersUrl]: fixture("docker/containers.json") });

    await expect(containerLogs(fetch).handler({ name })).rejects.toThrow(new Refusal(message));
  });

  it("asks for logs only by an exact Container name, never an ID, which could reach a Private container", async () => {
    const { fetch, requests } = fakeFetch({ [containersUrl]: fixture("docker/containers.json") });
    const idOfMediaServer = "2a4b6c8d0e1f";

    await expect(containerLogs(fetch).handler({ name: idOfMediaServer })).rejects.toBeInstanceOf(
      Refusal,
    );
    expect(requests.map((r) => r.url)).toEqual([containersUrl]);
  });

  it.each([
    ["a line break, which could fake a line in the server log", "media-server\nFAKE ok"],
    ["thousands of characters", "a".repeat(5000)],
  ])("rejects a name no Container could have (%s) without contacting Docker", async (_, name) => {
    const { fetch, requests } = fakeFetch({});

    await expect(containerLogs(fetch).handler({ name })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("says so when the connection drops while Docker is sending the logs", async () => {
    const list = fakeFetch({ [containersUrl]: fixture("docker/containers.json") });
    const brokenBody = new ReadableStream({
      pull: (controller) => controller.error(new TypeError("terminated")),
    });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === containersUrl
        ? list.fetch(input, init)
        : new Response(brokenBody)) as typeof globalThis.fetch;

    await expect(containerLogs(fetch).handler({ name: "media-server" })).rejects.toThrow(
      new SourceError("Docker stopped answering part way through."),
    );
  });

  it("says so when a Container has no log lines", async () => {
    const { fetch } = fakeFetch({
      [containersUrl]: fixture("docker/containers.json"),
      [logsUrl("dashboard", 100)]: { body: "" },
    });

    expect(await containerLogs(fetch).handler({ name: "dashboard" })).toBe(
      "dashboard has no log lines.",
    );
  });

  it("passes on Docker's error when a Container goes between the list and its logs", async () => {
    const { fetch } = fakeFetch({
      [containersUrl]: fixture("docker/containers.json"),
      [logsUrl("backup-job", 100)]: { status: 404, body: '{"message":"No such container"}' },
    });

    await expect(containerLogs(fetch).handler({ name: "backup-job" })).rejects.toThrow(
      new SourceError("Docker answered with HTTP 404."),
    );
  });

  it("returns a plain log stream, from a Container with a terminal, just as cleanly", async () => {
    const { fetch } = fakeFetch({
      [containersUrl]: fixture("docker/containers.json"),
      [logsUrl("sync-worker", 100)]: fixture("docker/logs-plain.txt"),
    });

    expect(await containerLogs(fetch).handler({ name: "sync-worker" })).toBe(
      [
        "sync-worker: last 3 log lines, oldest first.",
        "",
        "2026-09-30 09:15:00 sync started",
        "2026-09-30 09:15:03 copied 42 files",
        "2026-09-30 09:15:04 sync finished in 4s",
      ].join("\n"),
    );
  });
});

describe("disk_usage", () => {
  const scratchFolders: string[] = [];
  const scratchFolder = () => {
    const folder = mkdtempSync(join(tmpdir(), "disk-usage-"));
    scratchFolders.push(folder);
    return folder;
  };
  afterEach(() => {
    for (const folder of scratchFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  const diskUsage = (diskPaths: DiskPath[]) =>
    tool("disk_usage", fakeFetch({}).fetch, [], diskPaths);
  const size = String.raw`(\d+(?:\.\d+)?) (B|kB|MB|GB|TB|PB)`;
  const reportLine = (label: string) =>
    new RegExp(
      String.raw`^- ${label}: (\d{1,3})% used \(${size} used, ${size} free, ${size} total\)$`,
    );

  it("reports used, free and total space and percent used for each path, in order", async () => {
    const scratch = scratchFolder();

    const text = await diskUsage([
      { label: "scratch", path: scratch },
      { label: "temp", path: tmpdir() },
    ]).handler({});

    const [heading, blank, ...lines] = text.split("\n");
    expect(heading).toBe("Disk space for 2 paths.");
    expect(blank).toBe("");
    expect(lines).toEqual([
      expect.stringMatching(reportLine("scratch")),
      expect.stringMatching(reportLine("temp")),
    ]);
  });

  it("gives figures that agree with each other: the percent is used out of used plus free", async () => {
    const text = await diskUsage([{ label: "temp", path: tmpdir() }]).handler({});

    expect(text.split("\n")[0]).toBe("Disk space for 1 path.");
    const match = text.split("\n")[2]?.match(reportLine("temp"));
    if (!match) throw new Error(`unexpected line in: ${text}`);
    const [, percent, usedValue, usedUnit, freeValue, freeUnit, totalValue, totalUnit] = match;
    const used = bytes(usedValue, usedUnit);
    const free = bytes(freeValue, freeUnit);
    expect(Math.abs(Number(percent) - (used / (used + free)) * 100)).toBeLessThanOrEqual(1.5);
    expect(used + free).toBeLessThanOrEqual(bytes(totalValue, totalUnit) * 1.01);
  });

  // Only Linux has a filesystem with no size (/proc), so this runs in CI, not on Windows.
  it.runIf(process.platform === "linux")(
    "reads 0% for a filesystem with no size at all, rather than dividing by zero",
    async () => {
      const text = await diskUsage([{ label: "proc", path: "/proc" }]).handler({});
      expect(text.split("\n")[2]).toBe("- proc: 0% used (0 B used, 0 B free, 0 B total)");
    },
  );

  it("reports a path that can't be read on its own line, and still reports the others", async () => {
    const gone = join(scratchFolder(), "not-there");

    const text = await diskUsage([
      { label: "gone", path: gone },
      { label: "temp", path: tmpdir() },
    ]).handler({});

    const lines = text.split("\n").slice(2);
    expect(lines[0]).toBe("- gone: couldn't be read (ENOENT).");
    expect(lines[1]).toMatch(reportLine("temp"));
  });
});

/** "4.43", "TB" as a number of bytes, counting in thousands as the output does. */
function bytes(value: string | undefined, unit: string | undefined): number {
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  return Number(value) * 1000 ** units.indexOf(unit ?? "B");
}

describe("list_health_checks", () => {
  const gatusUrl = "http://gatus.example:8080";
  const statusesUrl = `${gatusUrl}/api/v1/endpoints/statuses?page=1&pageSize=1`;
  const toolNames = (sources: Sources) =>
    buildTools(sources, { privateContainers: [] }).map((t) => t.name);
  const withoutGatus = (fetch: typeof globalThis.fetch): Sources => ({
    docker: docker(fetch, dockerUrl),
    disk: disk([]),
  });
  const withGatus = (fetch: typeof globalThis.fetch): Sources => ({
    ...withoutGatus(fetch),
    gatus: gatus(fetch, gatusUrl),
  });
  const listHealthChecks = (fetch: typeof globalThis.fetch) => {
    const found = buildTools(withGatus(fetch), { privateContainers: [] }).find(
      (t) => t.name === "list_health_checks",
    );
    if (!found) throw new Error("list_health_checks isn't offered");
    return found;
  };

  it("is offered only when the Gatus Source is on", () => {
    const { fetch } = fakeFetch({});
    expect(toolNames(withoutGatus(fetch))).not.toContain("list_health_checks");
    expect(toolNames(withGatus(fetch))).toContain("list_health_checks");
  });

  it("lists each Health check with its group, whether it's passing and its latest time, failing first", async () => {
    const { fetch } = fakeFetch({ [statusesUrl]: fixture("gatus/statuses.json") });

    expect(await listHealthChecks(fetch).handler({})).toBe(
      [
        "5 Health checks, 2 failing.",
        "",
        "Failing:",
        "- media / media-server: failing (5012 ms)",
        "- network / vpn-tunnel: failing (no response)",
        "",
        "Passing:",
        "- core / dashboard: passing (12 ms)",
        "- core / dns: passing (3 ms)",
        "",
        "Not checked yet:",
        "- backup-job",
      ].join("\n"),
    );
  });

  it.each([
    ["[]", "Gatus has no Health checks."],
    [
      '[{"name":"dns","results":[{"success":true,"duration":3000000}]}]',
      ["1 Health check, 0 failing.", "", "Passing:", "- dns: passing (3 ms)"].join("\n"),
    ],
  ])("words a short list plainly: %s", async (body, expected) => {
    const { fetch } = fakeFetch({ [statusesUrl]: { body } });
    expect(await listHealthChecks(fetch).handler({})).toBe(expected);
  });

  it("says Gatus can't be reached, which is different from a Health check failing", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:8080"), {
        code: "ECONNREFUSED",
      }),
    });
    const { fetch } = fakeFetch({ [statusesUrl]: refused });

    await expect(listHealthChecks(fetch).handler({})).rejects.toThrow(
      new SourceError("Couldn't reach Gatus (ECONNREFUSED)."),
    );
  });

  it("says so when Gatus's answer isn't the expected shape", async () => {
    const { fetch } = fakeFetch({ [statusesUrl]: { body: '{"error":"not found"}' } });

    await expect(listHealthChecks(fetch).handler({})).rejects.toThrow(
      new SourceError("Gatus answered with something unexpected."),
    );
  });
});

describe("recent_media", () => {
  const jellyfinUrl = "http://media.example:8096";
  const apiKey = "test-api-key-0000";
  const noon = new Date("2026-09-30T12:00:00Z");
  const librariesUrl = `${jellyfinUrl}/Library/VirtualFolders`;
  const itemsUrl = (libraryId: string) =>
    `${jellyfinUrl}/Items?ParentId=${libraryId}&Recursive=true&IncludeItemTypes=Movie,Episode` +
    "&Fields=DateCreated&SortBy=DateCreated&SortOrder=Descending&Limit=500";
  // Only the film and TV libraries have answers: asking for the music or placeholder library fails the test.
  const answers = {
    [librariesUrl]: fixture("jellyfin/virtual-folders.json"),
    [itemsUrl("f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1")]: fixture("jellyfin/items-films.json"),
    [itemsUrl("a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2")]: fixture("jellyfin/items-tv.json"),
  };
  const sources = (fetch: typeof globalThis.fetch, now = noon, on = true): Sources => ({
    docker: docker(fetch, dockerUrl),
    disk: disk([]),
    ...(on ? { jellyfin: jellyfin(fetch, jellyfinUrl, apiKey, () => now) } : {}),
  });
  const recentMedia = (fetch: typeof globalThis.fetch, now = noon) => {
    const found = buildTools(sources(fetch, now), { privateContainers: [] }).find(
      (t) => t.name === "recent_media",
    );
    if (!found) throw new Error("recent_media isn't offered");
    return found;
  };

  it("is offered only when the Jellyfin Source is on", () => {
    const { fetch } = fakeFetch({});
    const names = (on: boolean) =>
      buildTools(sources(fetch, noon, on), { privateContainers: [] }).map((t) => t.name);
    expect(names(false)).not.toContain("recent_media");
    expect(names(true)).toContain("recent_media");
  });

  it("lists films, then episodes by series, added in the last day, from film and TV libraries only", async () => {
    const { fetch } = fakeFetch(answers);

    expect(await recentMedia(fetch).handler({})).toBe(
      [
        "2 films and 3 episodes added in the last day.",
        "",
        "Films:",
        "- Another Example (2023)",
        "- Example Film (2024)",
        "",
        "Episodes:",
        "- Example Show: S01E03, S01E04",
        "- Second Show: S02E01",
      ].join("\n"),
    );
  });

  it("looks further back when asked for more days", async () => {
    const { fetch } = fakeFetch(answers);

    const text = await recentMedia(fetch).handler({ days: 7 });
    expect(text.split("\n")[0]).toBe("3 films and 4 episodes added in the last 7 days.");
    expect(text).toContain("- Older Film (1999)");
    expect(text).toContain("- Example Show: S01E01, S01E03, S01E04");
  });

  it("says so plainly when nothing is new", async () => {
    const { fetch } = fakeFetch(answers);
    const tenDaysLater = new Date("2026-10-10T12:00:00Z");

    expect(await recentMedia(fetch, tenDaysLater).handler({})).toBe(
      "No films or episodes added in the last day.",
    );
  });

  it.each([0, 31, 2.5])("refuses days=%s, since it's a whole number from 1 to 30", async (days) => {
    const { fetch, requests } = fakeFetch(answers);

    await expect(recentMedia(fetch).handler({ days })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("sends the API key in a header, never in a URL that could reach a log", async () => {
    const { fetch, requests } = fakeFetch(answers);

    await recentMedia(fetch).handler({});
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.url).not.toContain(apiKey);
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        `MediaBrowser Token="${apiKey}"`,
      );
    }
  });

  describe("with items made up for each case", () => {
    const added = "2026-09-30T08:00:00.0000000Z";
    const answersWith = (films: object[], episodes: object[] = []) => ({
      [librariesUrl]: fixture("jellyfin/virtual-folders.json"),
      [itemsUrl("f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1")]: { body: JSON.stringify({ Items: films }) },
      [itemsUrl("a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2")]: { body: JSON.stringify({ Items: episodes }) },
    });
    const film = (name: string, date = added) => ({ Name: name, Type: "Movie", DateCreated: date });
    const episode = (season?: number, number?: number) => ({
      Name: "Episode",
      Type: "Episode",
      SeriesName: "Show",
      ParentIndexNumber: season,
      IndexNumber: number,
      DateCreated: added,
    });

    it("says Jellyfin's answer is unexpected when a date isn't a date, rather than counting it as new", async () => {
      const { fetch } = fakeFetch(answersWith([film("Film", "sometime last week")]));

      await expect(recentMedia(fetch).handler({})).rejects.toThrow(
        new SourceError("Jellyfin answered with something unexpected."),
      );
    });

    it("removes other folder-tag styles too, such as [tmdbid=603] and {anidb-123}", async () => {
      const { fetch } = fakeFetch(
        answersWith([film("First Film [tmdbid=603]"), film("Second {anidb-123}")]),
      );

      const text = await recentMedia(fetch).handler({});
      expect(text).toContain("- First Film\n- Second");
    });

    it("tidies a name of 50,000 spaces in well under a second", async () => {
      const { fetch } = fakeFetch(answersWith([film(`A${" ".repeat(50_000)}B {tvdb-1}`)]));

      const started = performance.now();
      await recentMedia(fetch).handler({});
      expect(performance.now() - started).toBeLessThan(250);
    });

    it("orders episode numbers as numbers, and counts unnumbered episodes once", async () => {
      const episodes = [episode(1, 100), episode(1, 99), episode(), episode()];
      const { fetch } = fakeFetch(answersWith([], episodes));

      const text = await recentMedia(fetch).handler({});
      expect(text).toContain("- Show: S01E99, S01E100, 2 unnumbered episodes");
    });

    it("says there may be more when a library's list was cut short while still inside the window", async () => {
      const films = Array.from({ length: 500 }, (_, i) => film(`Film ${i}`));
      const { fetch } = fakeFetch(answersWith(films));

      const text = await recentMedia(fetch).handler({});
      expect(text.split("\n")[1]).toBe(
        "Only the newest 500 items in each library were read, so there may be more.",
      );
    });
  });

  it("says Jellyfin can't be reached, giving only the error code", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const { fetch } = fakeFetch({ [librariesUrl]: refused });

    await expect(recentMedia(fetch).handler({})).rejects.toThrow(
      new SourceError("Couldn't reach Jellyfin (ECONNREFUSED)."),
    );
  });
});

describe("read_report", () => {
  const noon = new Date("2026-09-30T12:00:00Z");
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  /** A real Report file with the given text, last written at `writtenAt`. */
  const reportFile = (text: string, writtenAt: Date) => {
    const folder = mkdtempSync(join(tmpdir(), "report-"));
    folders.push(folder);
    const path = join(folder, "morning.txt");
    writeFileSync(path, text);
    utimesSync(path, writtenAt, writtenAt);
    return path;
  };
  const sources = (path: string | undefined): Sources => ({
    docker: docker(fakeFetch({}).fetch, dockerUrl),
    disk: disk([]),
    ...(path ? { report: report(path, 26, () => noon) } : {}),
  });
  const readReport = (path: string) => {
    const found = buildTools(sources(path), { privateContainers: [] }).find(
      (t) => t.name === "read_report",
    );
    if (!found) throw new Error("read_report isn't offered");
    return found;
  };
  const text = "All 17 checks passing.\nDisk 71% used.\n";

  it("is offered only when the Report Source is on", () => {
    const names = (path: string | undefined) =>
      buildTools(sources(path), { privateContainers: [] }).map((t) => t.name);
    expect(names(undefined)).not.toContain("read_report");
    expect(names("/reports/morning.txt")).toContain("read_report");
  });

  it("returns the Report exactly as written, with when it was written", async () => {
    const path = reportFile(text, new Date("2026-09-30T06:00:00Z"));

    expect(await readReport(path).handler({})).toBe(
      `Report written 2026-09-30 06:00 UTC, 6 hours ago.\n\n${text}`,
    );
  });

  it("starts a Stale report with a warning saying how old it is", async () => {
    const path = reportFile(text, new Date("2026-09-28T06:00:00Z"));

    expect(await readReport(path).handler({})).toBe(
      [
        "Warning: this Report is 2 days old, more than the 26 hours it should be, so it may no longer describe the Host.",
        "Report written 2026-09-28 06:00 UTC, 2 days ago.",
        "",
        text,
      ].join("\n"),
    );
  });

  it("says when the Report file is missing, without naming its path", async () => {
    const folder = mkdtempSync(join(tmpdir(), "report-"));
    folders.push(folder);

    await expect(readReport(join(folder, "morning.txt")).handler({})).rejects.toThrow(
      new SourceError("There's no Report file yet."),
    );
  });
});
