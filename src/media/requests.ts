import { z } from "zod";
import type { Action } from "../admin/allowlist.ts";
import { Refusal } from "../refusal.ts";
import type { Jellyseerr, Listing, Season } from "../sources/jellyseerr.ts";
import type { Tool } from "../tools.ts";

/** The most results search_media shows: enough to pick from, few enough to read. */
const MOST_RESULTS = 10;

const searchInput = z.object({
  name: z.string().trim().min(1).max(100).describe("The film or series name to search for"),
});

const requestInput = z.object({
  type: z.enum(["film", "series"]).describe("film or series, as search_media shows it"),
  id: z.number().int().positive().describe("The id search_media shows beside the title"),
  seasons: z
    .array(z.number().int().positive())
    .min(1)
    .optional()
    .describe("A series' season numbers to request. Left out, every season is requested"),
});

/** "Example Film (2021)", or just the name when Jellyseerr has no date. */
function labelOf(listing: Listing): string {
  return listing.year === undefined ? listing.name : `${listing.name} (${listing.year})`;
}

/** "season 2", "seasons 1, 2 and 4". */
function seasonList(numbers: number[]): string {
  const words = numbers.map(String);
  const last = words.pop();
  const list = words.length === 0 ? last : `${words.join(", ")} and ${last}`;
  return `${numbers.length === 1 ? "season" : "seasons"} ${list}`;
}

/** search_media: a read Tool, so it only asks Jellyseerr what it has. */
export function searchMedia(jellyseerr: Jellyseerr): Tool {
  return {
    name: "search_media",
    description:
      "Searches Jellyseerr for a film or series by name and lists up to 10 matches: title, year, film or " +
      "series, and whether each is available, partly available, requested or not requested yet. Each line ends " +
      "with the type and id request_media takes. Use it before requesting something, to find the right one.",
    inputSchema: searchInput.shape,
    logArguments: (args) => String(args.name),
    async handler(args) {
      const { name } = searchInput.parse(args);
      const { listings, morePages } = await jellyseerr.search(name);
      if (listings.length === 0) return `Jellyseerr found no film or series called "${name}".`;
      const shown = listings.slice(0, MOST_RESULTS);
      const more =
        listings.length > shown.length || morePages
          ? " Jellyseerr has more; add more of the name to narrow it."
          : "";
      return [
        `Jellyseerr's top ${shown.length} for "${name}".${more}`,
        "",
        ...shown.map((t) => `- ${labelOf(t)}: ${t.type}, ${t.availability} (${t.type} ${t.id})`),
      ].join("\n");
    },
  };
}

/** Which of the wanted seasons can still be requested, and why the rest can't. */
function splitSeasons(wanted: Season[]): { open: number[]; taken: string[] } {
  const open = wanted.filter((s) => s.availability === "not requested").map((s) => s.number);
  const taken = (["available", "partly available", "requested", "blocklisted"] as const).flatMap(
    (availability) => {
      const numbers = wanted.filter((s) => s.availability === availability).map((s) => s.number);
      return numbers.length === 0 ? [] : [`${seasonList(numbers)} ${availability}`];
    },
  );
  return { open, taken };
}

/** request_media: asks Jellyseerr for a film or a series' seasons, refusing what it already has. */
export function requestMedia(jellyseerr: Jellyseerr): Action {
  return {
    name: "request_media",
    description:
      "Requests one film or series in Jellyseerr, which passes it to Radarr or Sonarr to download. Takes the type " +
      "and id that search_media shows. A series gets every season unless seasons are named. Refuses something " +
      "already available or requested, saying which; for a series, seasons already there are left out.",
    inputSchema: requestInput.shape,
    async handler(args) {
      const { type, id, seasons: asked } = requestInput.parse(args);
      if (type === "film" && asked) {
        throw new Refusal("A film has no seasons. Leave seasons out to request it.");
      }
      const listing = await jellyseerr.details(type, id);
      const label = labelOf(listing);
      if (listing.availability === "blocklisted") {
        throw new Refusal(`${label} is blocklisted in Jellyseerr, so it can't be requested.`);
      }

      let toRequest: number[] = [];
      let leftOut = "";
      if (type === "film") {
        if (listing.availability !== "not requested") {
          throw new Refusal(
            `${label} is already ${listing.availability}, so nothing was requested.`,
          );
        }
      } else {
        const unknown = (asked ?? []).filter((n) => !listing.seasons.some((s) => s.number === n));
        if (unknown.length > 0) {
          const has = listing.seasons.map((s) => s.number);
          throw new Refusal(
            `${label} has no ${seasonList(unknown)}; it has ${has.length === 0 ? "none listed" : seasonList(has)}.`,
          );
        }
        const wanted = asked
          ? listing.seasons.filter((s) => asked.includes(s.number))
          : listing.seasons;
        const { open, taken } = splitSeasons(wanted);
        if (open.length === 0) {
          const why = taken.length > 0 ? taken.join(", ") : "no seasons listed";
          throw new Refusal(
            `${label} has nothing left to request (${why}), so nothing was requested.`,
          );
        }
        toRequest = open;
        if (taken.length > 0) leftOut = ` Left out, already in Jellyseerr: ${taken.join(", ")}.`;
      }

      const answer = await jellyseerr.request(type, id, toRequest);
      if (answer.outcome === "duplicate") {
        throw new Refusal(
          `Jellyseerr says ${label} is already requested or available, so nothing was requested.`,
        );
      }
      if (answer.outcome === "refused") {
        throw new Refusal(`Jellyseerr refused to request ${label}: ${answer.message}`);
      }
      const what = type === "film" ? label : `${label}, ${seasonList(toRequest)}`;
      const app = type === "film" ? "Radarr" : "Sonarr";
      const next = answer.approved
        ? `Jellyseerr approved it and passes it to ${app}; download_queue shows it once a download starts.`
        : "It's waiting for approval in Jellyseerr.";
      return `Requested ${what}. ${next}${leftOut}`;
    },
  };
}
