import { z } from "zod";
import type { Dispatcharr, Programme } from "../sources/dispatcharr.ts";
import type { Tool } from "../tools.ts";
import { count } from "../wording.ts";

/** The most programmes search_guide shows. */
const MOST_PROGRAMMES = 20;
const HOUR_MS = 60 * 60 * 1000;

const guideInput = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "Words in the programme's title, such as arsenal or premier league. Dispatcharr's search syntax works too: " +
        'OR between alternatives, and "quotes" for an exact phrase',
    ),
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe("How many hours ahead to look, from 1 to 168 (a week): 24 if left out"),
});

/** "2026-11-20 17:00-18:00"; the end's date is left out, since it's almost always the same day. */
function timesOf(programme: Programme): string {
  const start = programme.start.toISOString();
  return `${start.slice(0, 10)} ${start.slice(11, 16)}-${programme.end.toISOString().slice(11, 16)}`;
}

function whereOn(programme: Programme): string {
  if (programme.channels.length > 0) {
    return programme.channels.map((c) => `${c.number} ${c.name}`).join("; ");
  }
  return `on no Channel; ${count(programme.streamCount, "imported Stream")} carry its Guide entry`;
}

/** search_guide: a read Tool, so it only asks Dispatcharr what it has. */
export function searchGuide(dispatcharr: Dispatcharr, now: () => Date): Tool {
  return {
    name: "search_guide",
    description:
      "Searches Dispatcharr's live TV Guide by programme title for what's on now or starting in the next 24 " +
      "hours (up to a week), and lists up to 20 matches by start time with the Channels showing each, or how " +
      "many imported Streams carry it when no Channel does. Use it to answer where a game or show is on. A " +
      "game missing from the Guide may still be on: its rights holder's Channels are the place to look next.",
    inputSchema: guideInput.shape,
    async handler(args) {
      const { title, hours = 24 } = guideInput.parse(args);
      const from = now();
      const to = new Date(from.getTime() + hours * HOUR_MS);
      const { programmes, total } = await dispatcharr.searchGuide(title, from, to, MOST_PROGRAMMES);
      const window = `on now or starting in the next ${count(hours, "hour")}`;
      if (programmes.length === 0) {
        return `Nothing in the Guide matches "${title}" on now or in the next ${count(hours, "hour")}.`;
      }
      const heading =
        total > programmes.length
          ? `The first ${programmes.length} of ${total} programmes in the Guide matching "${title}", ${window}. ` +
            "Add more of the title or fewer hours to narrow it. Times are UTC."
          : `${count(programmes.length, "programme")} in the Guide ${programmes.length === 1 ? "matches" : "match"} ` +
            `"${title}", ${window}. Times are UTC.`;
      return [
        heading,
        "",
        ...programmes.map((p) => `- ${timesOf(p)} ${p.title}: ${whereOn(p)}`),
      ].join("\n");
    },
  };
}
