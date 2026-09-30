import { z } from "zod";
import { ITEMS_PER_LIBRARY, type MediaItem, type RecentMedia } from "./sources/jellyfin.ts";
import { count, section } from "./wording.ts";

/** recent_media's input: how far back to look. */
export const recentMediaInput = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe("How many days back to look, from 1 to 30: 1 if left out"),
});

type Episode = Extract<MediaItem, { kind: "episode" }>;

/** Films by name, then each series with its episode codes in order. */
export function formatRecentMedia({ items, cutShort }: RecentMedia, days: number): string {
  const window = days === 1 ? "the last day" : `the last ${days} days`;
  const films = items.filter((i) => i.kind === "film").sort((a, b) => a.name.localeCompare(b.name));
  const episodes = items.filter((i) => i.kind === "episode");
  if (films.length === 0 && episodes.length === 0)
    return `No films or episodes added in ${window}.`;

  const bySeries = new Map<string, Episode[]>();
  for (const e of episodes) bySeries.set(e.series, [...(bySeries.get(e.series) ?? []), e]);
  const series = [...bySeries.entries()].sort(([a], [b]) => a.localeCompare(b));

  return [
    `${count(films.length, "film")} and ${count(episodes.length, "episode")} added in ${window}.`,
    ...(cutShort
      ? [
          `Only the newest ${ITEMS_PER_LIBRARY} items in each library were read, so there may be more.`,
        ]
      : []),
    ...section("Films:", films, (f) => (f.year ? `${f.name} (${f.year})` : f.name)),
    ...section("Episodes:", series, ([name, list]) => `${name}: ${episodeCodes(list)}`),
  ].join("\n");
}

/** "S01E99, S01E100, 2 unnumbered episodes": numbered ones in order, then a count of any Jellyfin hasn't numbered. */
function episodeCodes(episodes: Episode[]): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const numbered = episodes
    .filter((e) => e.season !== undefined && e.episode !== undefined)
    .map((e) => ({ season: e.season ?? 0, episode: e.episode ?? 0 }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .map((e) => `S${two(e.season)}E${two(e.episode)}`);
  const unnumbered = episodes.length - numbered.length;
  return [...numbered, ...(unnumbered > 0 ? [count(unnumbered, "unnumbered episode")] : [])].join(
    ", ",
  );
}
