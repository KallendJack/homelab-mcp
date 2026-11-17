import { z } from "zod";
import { Refusal } from "./refusal.ts";
import type { Arr, QueueItem } from "./sources/arr.ts";

/** The app and queue id that download_queue shows, as every media Tool about one download takes them. */
export const downloadInput = {
  app: z
    .enum(["Sonarr", "Radarr"])
    .describe("Which app's queue the download is in, as download_queue shows"),
  id: z.number().int().positive().describe("The download's queue id, as download_queue shows it"),
};

/**
 * The configured app called `name`, and its download with queue id `id`: any record of a season pack finds it.
 * Refuses an app that isn't configured or an id that isn't in its queue.
 */
export async function findDownload(
  apps: Arr[],
  name: string,
  id: number,
): Promise<{ app: Arr; item: QueueItem }> {
  const app = apps.find((a) => a.app === name);
  if (!app) throw new Refusal(`${name} isn't configured on this server.`);
  const item = (await app.queue()).items.find((i) => i.recordIds.includes(id));
  if (!item) {
    throw new Refusal(`${name}'s queue has no download ${id}. download_queue shows each one's id.`);
  }
  return { app, item };
}
