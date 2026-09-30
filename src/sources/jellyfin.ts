import { z } from "zod";
import { httpRequests } from "./http.ts";

/** A film or TV episode in the Host's Jellyfin library. */
export type MediaItem =
  | { kind: "film"; name: string; year: number | undefined }
  | { kind: "episode"; series: string; season: number | undefined; episode: number | undefined };

export type RecentMedia = {
  items: MediaItem[];
  /** True when a library had more new items than Jellyfin was asked for, so there may be more. */
  cutShort: boolean;
};

export type Jellyfin = {
  /** Media items added in the last `days` days, counted back from now. */
  recentMedia(days: number): Promise<RecentMedia>;
};

/** Only these library types hold Media items: a library of another type, or none, is skipped. */
const MEDIA_LIBRARIES = ["movies", "tvshows"];

/** The newest items read from each library: enough for 30 days of additions on a home server, usually. */
export const ITEMS_PER_LIBRARY = 500;

const libraries = z.array(z.object({ CollectionType: z.string().optional(), ItemId: z.string() }));

const jellyfinItem = z.object({
  Name: z.string(),
  Type: z.string(),
  ProductionYear: z.number().optional(),
  SeriesName: z.string().optional(),
  ParentIndexNumber: z.number().optional(),
  IndexNumber: z.number().optional(),
  // A date that doesn't parse would compare as never old, so every item would look new.
  DateCreated: z.string().refine((date) => !Number.isNaN(Date.parse(date))),
});
type JellyfinItem = z.infer<typeof jellyfinItem>;

const items = z.object({ Items: z.array(jellyfinItem) });

/** Reads Media items from Jellyfin at `url`, sending `apiKey` in a header. `now` sets the window's end. */
export function jellyfin(
  fetch: typeof globalThis.fetch,
  url: string,
  apiKey: string,
  now: () => Date,
): Jellyfin {
  const { getJson } = httpRequests(fetch, url, "Jellyfin", {
    Authorization: `MediaBrowser Token="${apiKey}"`,
  });

  return {
    async recentMedia(days) {
      const since = now().getTime() - days * 24 * 60 * 60 * 1000;
      const isNew = (item: JellyfinItem) => Date.parse(item.DateCreated) >= since;
      const mediaLibraries = (await getJson("/Library/VirtualFolders", libraries)).filter(
        (library) => MEDIA_LIBRARIES.includes(library.CollectionType ?? ""),
      );
      const found: MediaItem[] = [];
      let cutShort = false;
      for (const library of mediaLibraries) {
        const query =
          `ParentId=${encodeURIComponent(library.ItemId)}&Recursive=true&IncludeItemTypes=Movie,Episode` +
          `&Fields=DateCreated&SortBy=DateCreated&SortOrder=Descending&Limit=${ITEMS_PER_LIBRARY}`;
        const { Items } = await getJson(`/Items?${query}`, items);
        const newItems = Items.filter(isNew);
        // A full page whose oldest item is still new means older new items were left out.
        if (Items.length >= ITEMS_PER_LIBRARY && newItems.length === Items.length) cutShort = true;
        for (const item of newItems) {
          const media = mediaItem(item);
          if (media) found.push(media);
        }
      }
      return { items: found, cutShort };
    },
  };
}

function mediaItem(item: JellyfinItem): MediaItem | undefined {
  if (item.Type === "Movie") {
    return { kind: "film", name: withoutFolderTags(item.Name), year: item.ProductionYear };
  }
  if (item.Type === "Episode" && item.SeriesName) {
    return {
      kind: "episode",
      series: withoutFolderTags(item.SeriesName),
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
    };
  }
  return undefined;
}

/**
 * "Second Show {tvdb-438604}" becomes "Second Show": tags such as {tvdb-…}, [tmdbid=…] or {anidb-…} help Jellyfin
 * match folders but aren't part of the name. The pattern is anchored at the bracket and capped, so it stays fast
 * on any name; spaces are tidied after.
 */
function withoutFolderTags(name: string): string {
  return name
    .replace(/[{[](?:tvdb|tmdb|imdb|tvmaze|anidb)(?:id)?[-=][^}\]]{0,64}[}\]]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
