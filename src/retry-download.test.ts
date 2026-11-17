import { describe, expect, it } from "vitest";
import { Refusal } from "./refusal.ts";
import { retryDownload } from "./retry-download.ts";
import { arr } from "./sources/arr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "./testing/fake-fetch.ts";

const sonarrUrl = "http://sonarr.example:8989";
const sonarrKey = "test-sonarr-key-0000";
const queueUrl = `${sonarrUrl}/api/v3/queue?page=1&pageSize=100&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true`;
const removeUrl = (id: number) =>
  `${sonarrUrl}/api/v3/queue/${id}?removeFromClient=true&blocklist=true&skipRedownload=false`;

function retry(answers: Record<string, FakeAnswer>) {
  const { fetch, requests } = fakeFetch({ [queueUrl]: fixture("sonarr/queue.json"), ...answers });
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
});
