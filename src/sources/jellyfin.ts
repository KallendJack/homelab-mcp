import { z } from "zod";
import { httpRequests } from "./http.ts";

/** A film or TV episode in the Host's Jellyfin library. */
export type MediaItem =
  | { kind: "film"; name: string; year: number | undefined }
  | { kind: "episode"; series: string; season: number | undefined; episode: number | undefined };

export type Jellyfin = {
  /** Media items added in the last `days` days, counted back from now. */
  recentMedia(days: number): Promise<MediaItem[]>;
};

/** Only these library types hold Media items: a library of another type, or none, is skipped. */
const MEDIA_LIBRARIES = ["movies", "tvshows"];

/** Enough of the newest items per library to cover 30 days of additions on a home server. */
const ITEMS_PER_LIBRARY = 500;

const libraries = z.array(z.object({ CollectionType: z.string().optional(), ItemId: z.string() }));

const items = z.object({
  Items: z.array(
    z.object({
      Name: z.string(),
      Type: z.string(),
      ProductionYear: z.number().optional(),
      SeriesName: z.string().optional(),
      ParentIndexNumber: z.number().optional(),
      IndexNumber: z.number().optional(),
      DateCreated: z.string(),
    }),
  ),
});

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
      const mediaLibraries = (await getJson("/Library/VirtualFolders", libraries)).filter(
        (library) => MEDIA_LIBRARIES.includes(library.CollectionType ?? ""),
      );
      const found: MediaItem[] = [];
      for (const library of mediaLibraries) {
        const query =
          `ParentId=${encodeURIComponent(library.ItemId)}&Recursive=true&IncludeItemTypes=Movie,Episode` +
          `&Fields=DateCreated&SortBy=DateCreated&SortOrder=Descending&Limit=${ITEMS_PER_LIBRARY}`;
        const { Items } = await getJson(`/Items?${query}`, items);
        for (const item of Items) {
          if (Date.parse(item.DateCreated) < since) continue;
          const media = mediaItem(item);
          if (media) found.push(media);
        }
      }
      return found;
    },
  };
}

function mediaItem(item: z.infer<typeof items>["Items"][number]): MediaItem | undefined {
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

/** "Second Show {tvdb-438604}" becomes "Second Show": tags that help Jellyfin match folders, not part of the name. */
function withoutFolderTags(name: string): string {
  return name.replace(/\s*[{[](?:tvdb|tmdb|imdb|tvmaze)(?:id)?-[^}\]]*[}\]]/gi, "").trim();
}
