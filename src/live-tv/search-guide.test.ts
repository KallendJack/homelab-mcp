import { describe, expect, it } from "vitest";
import { dispatcharr } from "../sources/dispatcharr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { searchGuide } from "./search-guide.ts";

const url = "http://dispatcharr.example:9191";
/** When the fixture was recorded. */
const recordedAt = new Date("2026-11-20T14:11:38Z");
const programmes = (title: string, from: string, to: string) =>
  `${url}/api/epg/programs/search/?title=${title}&end_after=${from}&start_before=${to}&page_size=20`;
const premierLeague = programmes(
  "premier%20league",
  "2026-11-20T14:11:38Z",
  "2026-11-21T14:11:38Z",
);

function setUp(answers: Record<string, FakeAnswer>) {
  const { fetch, requests } = fakeFetch(answers);
  return {
    tool: searchGuide(dispatcharr(fetch, url, "test-dispatcharr-key"), () => recordedAt),
    requests,
  };
}

/** The recorded search as JSON, to change it for a case it doesn't show. */
function edited(
  change: (search: { count: number; results: Record<string, unknown>[] }) => void,
): FakeAnswer {
  const search = JSON.parse(
    new TextDecoder().decode(fixture("dispatcharr/programs-premier-league-recorded.json").body),
  );
  change(search);
  return { body: JSON.stringify(search) };
}

describe("search_guide", () => {
  it("lists what's on now or soon with the Channels showing it, by start time", async () => {
    const { tool, requests } = setUp({
      [premierLeague]: fixture("dispatcharr/programs-premier-league-recorded.json"),
    });

    expect(await tool.handler({ title: "premier league" })).toBe(
      [
        `9 programmes in the Guide match "premier league", on now or starting in the next 24 hours. Times are UTC.`,
        "",
        "- 2026-11-20 17:00-18:00 Premier League fixture 6: 409 Sky Sports News HD",
        "- 2026-11-20 17:00-18:00 Premier League fixture 1: 409 Sky Sports News HD",
        "- 2026-11-20 18:00-19:00 Premier League fixture 1: 409 Sky Sports News HD",
        "- 2026-11-20 18:00-19:00 Premier League fixture 6: 409 Sky Sports News HD",
        "- 2026-11-21 10:00-11:30 Premier League fixture 4: 401 Sky Sports Main Event UHD",
        "- 2026-11-21 10:00-11:30 Premier League fixture 4: 409 Sky Sports News HD",
        "- 2026-11-21 10:00-11:30 Premier League fixture 3: 409 Sky Sports News HD",
        "- 2026-11-21 12:00-12:30 Premier League fixture 2: 1262 USA",
        "- 2026-11-21 12:30-14:30 Premier League fixture 5: 1262 USA",
      ].join("\n"),
    );
    expect(requests.map((r) => r.url)).toEqual([premierLeague]);
    expect(requests[0]?.init?.method).toBeUndefined();
  });

  it("says when a programme is on no Channel, with how many imported Streams carry its Guide entry", async () => {
    const { tool } = setUp({
      [premierLeague]: edited((search) => {
        search.count = 1;
        search.results = [{ ...search.results[4], channels: [] }];
      }),
    });

    expect(await tool.handler({ title: "premier league" })).toContain(
      "- 2026-11-21 10:00-11:30 Premier League fixture 4: on no Channel; 3 imported Streams carry its Guide entry",
    );
  });

  it("looks as far ahead as asked, and says when there are more than it shows", async () => {
    const week = programmes("arsenal", "2026-11-20T14:11:38Z", "2026-11-27T14:11:38Z");
    const { tool } = setUp({
      [week]: edited((search) => {
        search.count = 45;
      }),
    });

    expect(await tool.handler({ title: "arsenal", hours: 168 })).toMatch(
      /^The first 9 of 45 programmes in the Guide matching "arsenal", on now or starting in the next 168 hours\. Add more of the title or fewer hours to narrow it\. Times are UTC\.\n/,
    );
  });

  it("says when nothing in the Guide matches", async () => {
    const { tool } = setUp({
      [programmes("arsenal", "2026-11-20T14:11:38Z", "2026-11-21T14:11:38Z")]: {
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      },
    });

    expect(await tool.handler({ title: "arsenal" })).toBe(
      `Nothing in the Guide matches "arsenal" on now or in the next 24 hours.`,
    );
  });
});
