import { describe, expect, it } from "vitest";
import { dispatcharr } from "../sources/dispatcharr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { findChannel } from "./find-channel.ts";

const url = "http://dispatcharr.example:9191";
const api = `${url}/api`;
const search = (name: string) =>
  `${api}/channels/channels/?name=${name}&ordering=channel_number&page_size=10`;

/** A recorded fixture as JSON. */
function json(path: string) {
  return JSON.parse(new TextDecoder().decode(fixture(`dispatcharr/${path}`).body));
}
const answer = (body: unknown): FakeAnswer => ({ body: JSON.stringify(body) });

/** Dispatcharr's recorded answers to finding "tnt sports", with `change` applied first. */
function recorded(change: (data: Recorded) => void = () => {}): Record<string, FakeAnswer> {
  const data: Recorded = {
    channels: json("channels-tnt-sports-recorded.json"),
    streams: json("channel-streams-tnt-sports-recorded.json"),
    guide: json("epgdata-tnt-sports-recorded.json"),
    groups: json("groups-tnt-sports-recorded.json"),
    profiles: json("profiles-recorded.json"),
  };
  change(data);
  return {
    [search("tnt%20sports")]: answer(data.channels),
    ...Object.fromEntries(
      Object.entries(data.streams).map(([id, streams]) => [
        `${api}/channels/channels/${id}/streams/`,
        answer(streams),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(data.guide).map(([id, entry]) => [`${api}/epg/epgdata/${id}/`, answer(entry)]),
    ),
    ...Object.fromEntries(
      Object.entries(data.groups).map(([id, group]) => [
        `${api}/channels/groups/${id}/`,
        answer(group),
      ]),
    ),
    [`${api}/channels/profiles/`]: answer(data.profiles),
    [`${api}/m3u/accounts/`]: fixture("dispatcharr/m3u-accounts-recorded.json"),
  };
}
type Recorded = {
  channels: { count: number; next: string | null; results: Record<string, unknown>[] };
  streams: Record<string, Record<string, unknown>[]>;
  guide: Record<string, unknown>;
  groups: Record<string, unknown>;
  profiles: { name: string; channels: number[] }[];
};

function setUp(answers: Record<string, FakeAnswer>) {
  const { fetch, requests } = fakeFetch(answers);
  return { tool: findChannel(dispatcharr(fetch, url, "test-dispatcharr-key")), requests };
}

describe("find_channel", () => {
  it("shows each Channel's Guide link, its Streams in Dispatcharr's order, and its channel profiles", async () => {
    const { tool, requests } = setUp(recorded());

    expect(await tool.handler({ name: "tnt sports" })).toBe(
      [
        `10 of 13 Channels named like "tnt sports". Add more of the name to narrow it.`,
        "",
        "410 TNT Sports 1 HD (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS 1 HEVC 4K (IPTV, 1920x1080)",
        "  2. UK: TNT SPORTS 1 HEVC HD (IPTV, 1280x720)",
        "  3. UK: TNT SPORTS 1 ᴴᴰ ◉ (IPTV, 1280x720)",
        "- In every channel profile.",
        "",
        "411 TNT Sports 2 HD (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS 2 HEVC 4K (IPTV, 1920x1080)",
        "  2. UK: TNT SPORTS 2 HEVC HD (IPTV)",
        "  3. UK: TNT SPORTS 2 ᴴᴰ ◉ (IPTV)",
        "- In every channel profile.",
        "",
        "413 TNT Sports 3 HD (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS 3 HEVC 4K (IPTV)",
        "  2. UK: TNT SPORTS 3 HEVC HD (IPTV)",
        "  3. UK: TNT SPORTS 3 ᴴᴰ ◉ (IPTV)",
        "- In every channel profile.",
        "",
        "414 TNT Sports 4 HD (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS 4 HEVC 4K (IPTV)",
        "  2. UK: TNT SPORTS 4 HEVC HD (IPTV)",
        "  3. UK: TNT SPORTS 4 ᴴᴰ ◉ (IPTV)",
        "- In every channel profile.",
        "",
        "490 TNT Sports Box Office HD (Sky: Sports)",
        "- No Guide link.",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS BOX OFFICE HD (IPTV)",
        "  2. UK: TNT SPORTS BOX OFFICE 4K (IPTV)",
        "  3. UK: TNT SPORTS BOX OFFICE HEVC (IPTV)",
        "  4. UK: TNT SPORTS BOX OFFICE SD (IPTV)",
        "- In every channel profile.",
        "",
        "493 TNT Sports Ultimate UHD (Sky: Sports)",
        "- No Guide link.",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. VIP: TNT SPORTS ULTIMATE ⁴ᵏ & ³⁸⁴⁰ᴾ (IPTV, 3840x2160)",
        "- In every channel profile.",
        "",
        "494 TNT Sports Box Office 2 HD (Sky: Sports)",
        "- No Guide link.",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS BOX OFFICE HD (IPTV)",
        "  2. UK: TNT SPORTS BOX OFFICE 4K (IPTV)",
        "  3. UK: TNT SPORTS BOX OFFICE HEVC (IPTV)",
        "  4. UK: TNT SPORTS BOX OFFICE SD (IPTV)",
        "- In every channel profile.",
        "",
        "3006 TNT Sports 5 HD (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- No Stream, so it can't play.",
        "- In every channel profile.",
        "",
        "3007 TNT Sports 6 (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- Streams, in the order Dispatcharr tries them:",
        "  1. UK: TNT SPORTS 6 ᴴᴰ (IPTV)",
        "- In every channel profile.",
        "",
        "3008 TNT Sports 7 (Sky: Sports)",
        "- Guide: ARG: TNT SPORTS ᴿᴬᵂ (tntsports.ar)",
        "- No Stream, so it can't play.",
        "- In every channel profile.",
      ].join("\n"),
    );
    // Reads only: every request is a GET with the key in its header, and the Guide entry and group shared by
    // every Channel are each asked for once.
    expect(requests.every((r) => r.init?.method === undefined)).toBe(true);
    expect(requests.every((r) => r.init?.headers)).toBe(true);
    expect(requests.filter((r) => r.url.endsWith("/epg/epgdata/39432/"))).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith("/channels/groups/950/"))).toHaveLength(1);
  });

  it("keeps Dispatcharr's order of a Channel's Streams, whatever order they're listed in", async () => {
    const { tool } = setUp(
      recorded((data) => {
        const first = data.channels.results[0] as { streams: number[] };
        Object.assign(first, { name: "Provider name", epg_data_id: null });
        first.streams = [44871, 44984, 44939];
        data.channels.results = [data.channels.results[0] as Record<string, unknown>];
        data.channels.count = 1;
      }),
    );

    const text = await tool.handler({ name: "tnt sports" });

    expect(text).toContain(
      [
        "  1. UK: TNT SPORTS 1 ᴴᴰ ◉ (IPTV, 1280x720)",
        "  2. UK: TNT SPORTS 1 HEVC 4K (IPTV, 1920x1080)",
        "  3. UK: TNT SPORTS 1 HEVC HD (IPTV, 1280x720)",
      ].join("\n"),
    );
    expect(text).toContain("410 TNT Sports 1 HD");
    expect(text).toContain("tntsports.ar");
    expect(text.startsWith(`1 Channel named like "tnt sports".\n`)).toBe(true);
  });

  it("names the channel profiles a Channel is in, when it isn't in all of them", async () => {
    const { tool } = setUp(
      recorded((data) => {
        data.channels.results = [data.channels.results[0] as Record<string, unknown>];
        data.channels.count = 1;
        for (const profile of data.profiles) {
          if (profile.name !== "EPL" && profile.name !== "UCL") profile.channels = [];
        }
      }),
    );

    expect(await tool.handler({ name: "tnt sports" })).toContain(
      "- In channel profiles EPL and UCL.",
    );
  });

  it("says when no Channel has the name, and encodes it for the address", async () => {
    const { tool } = setUp({
      [search("sky%20sports%20%2B%20%26%20more")]: answer({
        count: 0,
        next: null,
        previous: null,
        results: [],
      }),
    });

    expect(await tool.handler({ name: "sky sports + & more" })).toBe(
      `No Channel in Dispatcharr is named like "sky sports + & more".`,
    );
  });
});
