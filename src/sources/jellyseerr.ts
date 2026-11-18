import { z } from "zod";
import { httpRequests } from "./http.ts";
import { SourceError } from "./source-error.ts";

/** Jellyseerr's words are "movie" and "tv"; the Client is shown "film" and "series". */
export type MediaType = "film" | "series";

/** Where a film, series or season stands in Jellyseerr. */
export type Availability =
  | "available"
  | "partly available"
  | "requested"
  | "not requested"
  | "blocklisted";

/** One film or series Jellyseerr knows, by the id request_media takes (TMDB's). */
export type Title = {
  type: MediaType;
  id: number;
  name: string;
  year?: number;
  availability: Availability;
};

/** A series' seasons, specials left out, each with where it stands. */
export type Season = { number: number; availability: Availability };

export type SearchResults = {
  /** Films and series only, in Jellyseerr's order: people are left out. */
  titles: Title[];
  /** Whether Jellyseerr has more pages of results than the first. */
  morePages: boolean;
};

/** What Jellyseerr did with a request. */
export type RequestAnswer =
  | { outcome: "requested"; approved: boolean }
  /** It already had a request, or nothing asked for was left to request. */
  | { outcome: "duplicate" }
  /** It refused, in its own words, such as a quota being used up. */
  | { outcome: "refused"; message: string };

export type Jellyseerr = {
  search(query: string): Promise<SearchResults>;
  /** One title, with its seasons for a series. */
  details(type: MediaType, id: number): Promise<Title & { seasons: Season[] }>;
  /** Requests a film, or the given seasons of a series. */
  request(type: MediaType, id: number, seasons: number[]): Promise<RequestAnswer>;
};

/** Jellyseerr's MediaStatus numbers (server/constants/media.ts in 2.7). */
function availabilityOf(status: number | undefined): Availability {
  switch (status) {
    case 2: // pending
    case 3: // processing
      return "requested";
    case 4:
      return "partly available";
    case 5:
      return "available";
    case 6: // Jellyseerr calls it blacklisted
      return "blocklisted";
    default: // 1 unknown, 7 deleted, or no record at all
      return "not requested";
  }
}

/** A request still in play: not declined (3) or completed (5), in MediaRequestStatus numbers. */
const isOpenRequest = (status: number) => status !== 3 && status !== 5;
const APPROVED = 2;

const mediaInfo = z.object({
  status: z.number(),
  requests: z
    .array(
      z.object({
        status: z.number(),
        is4k: z.boolean(),
        seasons: z.array(z.object({ seasonNumber: z.number() })).default([]),
      }),
    )
    .default([]),
  seasons: z.array(z.object({ seasonNumber: z.number(), status: z.number() })).default([]),
});
type MediaInfo = z.infer<typeof mediaInfo>;

const film = z.object({
  id: z.number(),
  title: z.string(),
  releaseDate: z.string().optional(),
  mediaInfo: mediaInfo.optional(),
});
const series = z.object({
  id: z.number(),
  name: z.string(),
  firstAirDate: z.string().optional(),
  mediaInfo: mediaInfo.optional(),
});

const searchResults = z.object({
  page: z.number(),
  totalPages: z.number(),
  // People, and any kind Jellyseerr may add, keep only their type and are left out.
  results: z.array(
    z.union([
      film.extend({ mediaType: z.literal("movie") }),
      series.extend({ mediaType: z.literal("tv") }),
      z.object({ mediaType: z.string() }),
    ]),
  ),
});
const seriesDetails = series.extend({
  seasons: z.array(z.object({ seasonNumber: z.number() })),
});
const createdRequest = z.object({ status: z.number() });
const errorMessage = z.object({ message: z.string() });

/** "2021-09-15" is 2021; an empty or missing date has no year. */
function yearOf(date: string | undefined): number | undefined {
  const year = Number.parseInt(date?.slice(0, 4) ?? "", 10);
  return Number.isNaN(year) ? undefined : year;
}

function titleOf(raw: z.infer<typeof film> | z.infer<typeof series>): Title {
  const isFilm = "title" in raw;
  return {
    type: isFilm ? "film" : "series",
    id: raw.id,
    name: isFilm ? raw.title : raw.name,
    ...withYear(yearOf(isFilm ? raw.releaseDate : raw.firstAirDate)),
    availability: availabilityOf(raw.mediaInfo?.status),
  };
}

function withYear(year: number | undefined): { year?: number } {
  return year === undefined ? {} : { year };
}

/** Each season's own status, or requested when an open request names it. */
function seasonsOf(numbers: number[], info: MediaInfo | undefined): Season[] {
  const requested = new Set(
    (info?.requests ?? [])
      .filter((r) => !r.is4k && isOpenRequest(r.status))
      .flatMap((r) => r.seasons.map((s) => s.seasonNumber)),
  );
  return numbers
    .filter((number) => number > 0)
    .map((number) => {
      const own = availabilityOf(info?.seasons.find((s) => s.seasonNumber === number)?.status);
      const availability = own === "not requested" && requested.has(number) ? "requested" : own;
      return { number, availability };
    });
}

/**
 * Jellyseerr refuses a query holding any reserved character, and encodeURIComponent leaves ! ' ( ) * as they are,
 * so "It's" would find nothing.
 */
function encodeQuery(query: string): string {
  return encodeURIComponent(query).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const apiType = (type: MediaType) => (type === "film" ? "movie" : "tv");

/** Reads and requests films and series in Jellyseerr at `url`, sending `apiKey` in a header. */
export function jellyseerr(
  fetch: typeof globalThis.fetch,
  url: string,
  apiKey: string,
): Jellyseerr {
  const http = httpRequests(fetch, `${url}/api/v1`, "Jellyseerr", { "X-Api-Key": apiKey });

  return {
    async search(query) {
      const answer = await http.getJson(
        `/search?query=${encodeQuery(query)}&page=1`,
        searchResults,
      );
      const titles = answer.results.flatMap((r) => ("id" in r ? [titleOf(r)] : []));
      return { titles, morePages: answer.totalPages > answer.page };
    },

    async details(type, id) {
      if (type === "film")
        return { ...titleOf(await http.getJson(`/movie/${id}`, film)), seasons: [] };
      const raw = await http.getJson(`/tv/${id}`, seriesDetails);
      const numbers = raw.seasons.map((s) => s.seasonNumber);
      return { ...titleOf(raw), seasons: seasonsOf(numbers, raw.mediaInfo) };
    },

    async request(type, id, seasons) {
      const json = {
        mediaType: apiType(type),
        mediaId: id,
        ...(type === "series" ? { seasons } : {}),
      };
      const answer = await http.post("/request", { json, timeLimited: true });
      // 202 is Jellyseerr's "No seasons available to request"; 409 a request that already exists.
      if (answer.status === 202 || answer.status === 409) return { outcome: "duplicate" };
      if (answer.status === 201) {
        const created = createdRequest.safeParse(parse(answer.text));
        if (!created.success)
          throw new SourceError("Jellyseerr answered with something unexpected.");
        return { outcome: "requested", approved: created.data.status === APPROVED };
      }
      const refusal = errorMessage.safeParse(parse(answer.text));
      if (answer.status === 403 && refusal.success) {
        return { outcome: "refused", message: refusal.data.message };
      }
      throw new SourceError(`Jellyseerr answered with HTTP ${answer.status}.`);
    },
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
