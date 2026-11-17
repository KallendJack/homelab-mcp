import { z } from "zod";
import type { Action } from "./allowlist.ts";
import { downloadInput, findDownload } from "./queue-lookup.ts";
import { Refusal } from "./refusal.ts";
import type { Arr } from "./sources/arr.ts";

const input = z.object({
  ...downloadInput,
  discard_downloaded: z
    .boolean()
    .optional()
    .describe(
      "Set to true only to retry a download whose files have already arrived, throwing them away. Left out, such a download is refused",
    ),
});

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
      const { app, item } = await findDownload(apps, name, id);
      if (item.waiting) {
        throw new Refusal(
          `${item.title} hasn't started downloading yet (it's waiting for ${name}'s delay), so there's nothing to retry.`,
        );
      }
      // Retrying deletes the files from the download client, so a finished download needs saying twice.
      if (item.downloaded && !discard) {
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
      if (!item.matched) {
        return `${removed} It isn't matched to ${kind}, so ${name} won't search for a replacement.`;
      }
      const searches = await app.redownloadsFailed();
      if (searches === undefined)
        return `${removed} ${name} was asked to search for a replacement.`;
      return searches
        ? `${removed} ${name} is searching for a replacement.`
        : `${removed} ${name}'s Redownload Failed setting is off, so it won't search for a replacement by itself.`;
    },
  };
}
