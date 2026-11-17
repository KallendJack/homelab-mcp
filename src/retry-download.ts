import { z } from "zod";
import type { Action } from "./allowlist.ts";
import { Refusal } from "./refusal.ts";
import type { Arr, QueueState } from "./sources/arr.ts";

const input = z.object({
  app: z
    .enum(["Sonarr", "Radarr"])
    .describe("Which app's queue the download is in, as download_queue shows"),
  id: z.number().int().positive().describe("The download's queue id, as download_queue shows it"),
  discard_downloaded: z
    .boolean()
    .optional()
    .describe(
      "Set to true only to retry a download whose files have already arrived, throwing them away. Left out, such a download is refused",
    ),
});

/** States whose files are already downloaded: retrying throws them away, so it needs saying twice. */
const DOWNLOADED: QueueState[] = ["import blocked", "import pending", "importing", "completed"];

/**
 * Gives up on one download and gets another: the app removes it from its queue and the download client,
 * blocklists the release so it isn't grabbed again, and searches for a replacement.
 */
export function retryDownload(apps: Arr[]): Action {
  return {
    name: "retry_download",
    description:
      "Gives up on one stuck or failed download in Sonarr or Radarr and gets another: removes it from the app's " +
      "queue and the download client, blocklists that release so it isn't grabbed again, and has the app search " +
      "for a replacement. Takes the app and queue id that download_queue shows. Refuses a download whose files " +
      "have already arrived (try manual_import first) unless discard_downloaded is true.",
    inputSchema: input.shape,
    async handler(args) {
      const { app: name, id, discard_downloaded: discard = false } = input.parse(args);
      const app = apps.find((a) => a.app === name);
      if (!app) throw new Refusal(`${name} isn't configured on this server.`);

      const item = (await app.queue()).items.find((i) => i.recordIds.includes(id));
      if (!item) {
        throw new Refusal(
          `${name}'s queue has no download ${id}. download_queue shows each one's id.`,
        );
      }
      if (DOWNLOADED.includes(item.state) && !discard) {
        throw new Refusal(
          `${item.title} has finished downloading (${item.state}), so retrying would throw its files away. ` +
            "Try manual_import first, or call again with discard_downloaded set to true.",
        );
      }

      if ((await app.removeFromQueue(item.id)) === "gone") {
        throw new Refusal(`${item.title} is no longer in ${name}'s queue, so nothing was removed.`);
      }
      const release = item.release && item.release !== item.title ? `, ${item.release}` : "";
      const removed = `Removed ${item.title} from ${name}'s queue and the download client, and blocklisted its release${release}.`;
      const kind = name === "Sonarr" ? "a series" : "a film";
      return item.matched
        ? `${removed} ${name} is searching for a replacement.`
        : `${removed} It isn't matched to ${kind}, so ${name} won't search for a replacement.`;
    },
  };
}
