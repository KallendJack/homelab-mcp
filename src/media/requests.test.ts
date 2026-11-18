import { describe, expect, it } from "vitest";
import { Refusal } from "../refusal.ts";
import { jellyseerr } from "../sources/jellyseerr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { requestMedia, searchMedia } from "./requests.ts";

const url = "http://jellyseerr.example:5055";
const api = `${url}/api/v1`;
const search = (query: string) => `${api}/search?query=${query}&page=1`;

function setUp(answers: Record<string, FakeAnswer>) {
  const { fetch, requests } = fakeFetch(answers);
  const source = jellyseerr(fetch, url, "test-jellyseerr-key-0000");
  return { search: searchMedia(source), request: requestMedia(source), requests };
}

/** A fixture as JSON, to change one field for a case it doesn't show. */
function edited(path: string, change: (body: Record<string, unknown>) => void): FakeAnswer {
  const body = JSON.parse(new TextDecoder().decode(fixture(path).body));
  change(body);
  return { body: JSON.stringify(body) };
}

const created = (status = 2): FakeAnswer => ({
  status: 201,
  ...edited("jellyseerr/request-created.json", (b) => {
    b.status = status;
  }),
});

function sentBody(requests: ReturnType<typeof setUp>["requests"]): unknown {
  const post = requests.find((r) => r.init?.method === "POST");
  return post ? JSON.parse(String(post.init?.body)) : undefined;
}

describe("search_media", () => {
  it("lists up to 10 films and series with where each stands and the id to request it by", async () => {
    const { search: tool, requests } = setUp({
      [search("example")]: fixture("jellyseerr/search.json"),
    });

    expect(await tool.handler({ name: "example" })).toBe(
      [
        `Jellyseerr's top 10 for "example". Jellyseerr has more; add more of the name to narrow it.`,
        "",
        "- Example Film (2021): film, not requested (film 900001)",
        "- Example Show (2024): series, available (series 900002)",
        "- Example Film: Part Two (2024): film, requested (film 900003)",
        "- Partial Show (2023): series, partly available (series 900004)",
        "- Pending Film (1984): film, requested (film 900006)",
        "- Blocked Film (2020): film, blocklisted (film 900007)",
        "- Gone Show (1980): series, not requested (series 900008)",
        "- Undated Film: film, not requested (film 900009)",
        "- Old Show (2000): series, not requested (series 900010)",
        "- Another Film (2014): film, not requested (film 900011)",
      ].join("\n"),
    );
    expect(requests[0]?.init?.headers).toEqual({ "X-Api-Key": "test-jellyseerr-key-0000" });
  });

  it("says when nothing was found", async () => {
    const { search: tool } = setUp({
      [search("nothing")]: fixture("jellyseerr/search-empty-recorded.json"),
    });

    expect(await tool.handler({ name: "nothing" })).toBe(
      `Jellyseerr found no film or series called "nothing".`,
    );
  });

  it("encodes every reserved character, since Jellyseerr refuses a query with any of them", async () => {
    const { search: tool, requests } = setUp({
      [search("It%27s%20%28Not%29%20Over%21")]: fixture("jellyseerr/search-empty-recorded.json"),
    });

    await tool.handler({ name: "It's (Not) Over!" });
    expect(requests).toHaveLength(1);
  });

  it("doesn't mention more results when the first page holds them all", async () => {
    const { search: tool } = setUp({
      [search("old")]: edited("jellyseerr/search.json", (b) => {
        b.totalPages = 1;
        b.results = (b.results as unknown[]).slice(8, 10);
      }),
    });

    expect(await tool.handler({ name: "old" })).toBe(
      [
        `Jellyseerr's top 2 for "old".`,
        "",
        "- Undated Film: film, not requested (film 900009)",
        "- Old Show (2000): series, not requested (series 900010)",
      ].join("\n"),
    );
  });

  it("reports Jellyseerr being down as a plain sentence", async () => {
    const { search: tool } = setUp({
      [search("example")]: new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    });

    await expect(tool.handler({ name: "example" })).rejects.toThrow(
      "Couldn't reach Jellyseerr (ECONNREFUSED).",
    );
  });
});

describe("request_media", () => {
  it("requests a film that isn't requested yet", async () => {
    const { request, requests } = setUp({
      [`${api}/movie/900001`]: fixture("jellyseerr/movie-new.json"),
      [`${api}/request`]: created(),
    });

    expect(await request.handler({ type: "film", id: 900001 })).toBe(
      "Requested Example Film (2021). Jellyseerr approved it and passes it to Radarr; download_queue shows it once a download starts.",
    );
    expect(sentBody(requests)).toEqual({ mediaType: "movie", mediaId: 900001 });
  });

  it("says when a request is waiting for approval", async () => {
    const { request } = setUp({
      [`${api}/movie/900001`]: fixture("jellyseerr/movie-new.json"),
      [`${api}/request`]: created(1),
    });

    expect(await request.handler({ type: "film", id: 900001 })).toBe(
      "Requested Example Film (2021). It's waiting for approval in Jellyseerr.",
    );
  });

  it("refuses a film that's already requested, asking Jellyseerr for nothing", async () => {
    const { request, requests } = setUp({
      [`${api}/movie/900003`]: fixture("jellyseerr/movie-requested.json"),
    });

    await expect(request.handler({ type: "film", id: 900003 })).rejects.toThrow(
      new Refusal("Example Film: Part Two (2024) is already requested, so nothing was requested."),
    );
    expect(sentBody(requests)).toBeUndefined();
  });

  it("refuses a film that's already available", async () => {
    const { request } = setUp({
      [`${api}/movie/900001`]: edited("jellyseerr/movie-new.json", (b) => {
        b.mediaInfo = { status: 5 };
      }),
    });

    await expect(request.handler({ type: "film", id: 900001 })).rejects.toThrow(
      new Refusal("Example Film (2021) is already available, so nothing was requested."),
    );
  });

  it("requests every season of a series, leaving out specials", async () => {
    const { request, requests } = setUp({
      [`${api}/tv/900010`]: fixture("jellyseerr/tv-new.json"),
      [`${api}/request`]: created(),
    });

    expect(await request.handler({ type: "series", id: 900010 })).toBe(
      "Requested Old Show (2000), seasons 1 and 2. Jellyseerr approved it and passes it to Sonarr; download_queue shows it once a download starts.",
    );
    expect(sentBody(requests)).toEqual({ mediaType: "tv", mediaId: 900010, seasons: [1, 2] });
  });

  it("requests only the seasons not already there, saying which were left out", async () => {
    const { request, requests } = setUp({
      [`${api}/tv/900004`]: fixture("jellyseerr/tv-partly-available.json"),
      [`${api}/request`]: created(),
    });

    expect(await request.handler({ type: "series", id: 900004 })).toBe(
      "Requested Partial Show (2023), season 4. Jellyseerr approved it and passes it to Sonarr; " +
        "download_queue shows it once a download starts. " +
        "Left out, already in Jellyseerr: seasons 1 and 2 available, season 3 requested.",
    );
    expect(sentBody(requests)).toEqual({ mediaType: "tv", mediaId: 900004, seasons: [4] });
  });

  it("refuses named seasons that are all already there, saying which", async () => {
    const { request, requests } = setUp({
      [`${api}/tv/900004`]: fixture("jellyseerr/tv-partly-available.json"),
    });

    await expect(request.handler({ type: "series", id: 900004, seasons: [2, 3] })).rejects.toThrow(
      new Refusal(
        "Partial Show (2023) has nothing left to request (season 2 available, season 3 requested), so nothing was requested.",
      ),
    );
    expect(sentBody(requests)).toBeUndefined();
  });

  it("counts a season named only in an open request as requested", async () => {
    const { request } = setUp({
      [`${api}/tv/900004`]: edited("jellyseerr/tv-partly-available.json", (b) => {
        (b.mediaInfo as { seasons: unknown[] }).seasons = [];
      }),
    });

    await expect(request.handler({ type: "series", id: 900004, seasons: [3] })).rejects.toThrow(
      new Refusal(
        "Partial Show (2023) has nothing left to request (season 3 requested), so nothing was requested.",
      ),
    );
  });

  it("refuses a season the series doesn't have", async () => {
    const { request } = setUp({ [`${api}/tv/900010`]: fixture("jellyseerr/tv-new.json") });

    await expect(request.handler({ type: "series", id: 900010, seasons: [2, 7] })).rejects.toThrow(
      new Refusal("Old Show (2000) has no season 7; it has seasons 1 and 2."),
    );
  });

  it("refuses seasons for a film", async () => {
    const { request } = setUp({});

    await expect(request.handler({ type: "film", id: 900001, seasons: [1] })).rejects.toThrow(
      new Refusal("A film has no seasons. Leave seasons out to request it."),
    );
  });

  it("refuses something blocklisted in Jellyseerr", async () => {
    const { request } = setUp({
      [`${api}/movie/900001`]: edited("jellyseerr/movie-new.json", (b) => {
        b.mediaInfo = { status: 6 };
      }),
    });

    await expect(request.handler({ type: "film", id: 900001 })).rejects.toThrow(
      new Refusal("Example Film (2021) is blocklisted in Jellyseerr, so it can't be requested."),
    );
  });

  it("refuses when Jellyseerr finds it already requested or available", async () => {
    const { request } = setUp({
      [`${api}/movie/900001`]: fixture("jellyseerr/movie-new.json"),
      [`${api}/request`]: { status: 409, ...fixture("jellyseerr/request-duplicate.json") },
    });

    await expect(request.handler({ type: "film", id: 900001 })).rejects.toThrow(
      new Refusal(
        "Jellyseerr says Example Film (2021) is already requested or available, so nothing was requested.",
      ),
    );
  });

  it("passes on Jellyseerr's own reason when it refuses, such as a quota", async () => {
    const { request } = setUp({
      [`${api}/tv/900010`]: fixture("jellyseerr/tv-new.json"),
      [`${api}/request`]: {
        status: 403,
        body: JSON.stringify({ message: "Series Quota exceeded." }),
      },
    });

    await expect(request.handler({ type: "series", id: 900010 })).rejects.toThrow(
      new Refusal("Jellyseerr refused to request Old Show (2000): Series Quota exceeded."),
    );
  });

  it("reports an unknown id as Jellyseerr's error status", async () => {
    const { request } = setUp({ [`${api}/movie/1`]: { status: 404, body: "{}" } });

    await expect(request.handler({ type: "film", id: 1 })).rejects.toThrow(
      "Jellyseerr answered with HTTP 404.",
    );
  });
});
