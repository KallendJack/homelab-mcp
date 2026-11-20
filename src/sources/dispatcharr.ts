import { z } from "zod";
import { httpRequests } from "./http.ts";

/** One provider account Dispatcharr imports Streams from. */
export type M3uAccount = {
  name: string;
  active: boolean;
  refresh: string;
  /** How many Streams the provider allows at once, and how many Dispatcharr is using. */
  connections: number;
  inUse: number;
  /** The provider's expiry date, when Dispatcharr knows it. */
  expires?: Date;
};

/** One of a Channel's Streams. */
export type Stream = {
  name: string;
  /** The M3U account it comes from. */
  account: string;
  /** Such as "1920x1080", when Dispatcharr has measured it. */
  resolution?: string;
  /** Gone from the provider's last list, though Dispatcharr still keeps it. */
  stale: boolean;
};

export type Channel = {
  /** Dispatcharr allows numbers such as 3006.5. */
  number: number;
  name: string;
  group?: string;
  /** The Guide entry it's linked to, by its name and tvg-id. */
  guide?: { name: string; tvgId: string };
  /** In the order Dispatcharr tries them: the first that works plays. */
  streams: Stream[];
  /** The names of the channel profiles it's in. */
  profiles: string[];
};

export type ChannelSearch = {
  channels: Channel[];
  /** How many Channels match in all, beyond those returned. */
  total: number;
  /** How many channel profiles Dispatcharr has. */
  profileCount: number;
};

/** A programme in the Guide, with the Channels showing it. */
export type Programme = {
  title: string;
  start: Date;
  end: Date;
  /** By number and name, in Dispatcharr's order. */
  channels: { number: number; name: string }[];
  /** How many imported Streams carry its Guide entry, on a Channel or not. */
  streamCount: number;
};

export type GuideSearch = { programmes: Programme[]; total: number };

export type Dispatcharr = {
  m3uAccounts(): Promise<M3uAccount[]>;
  /** Up to `most` Channels whose name contains `name`, in channel number order. */
  findChannels(name: string, most: number): Promise<ChannelSearch>;
  /** Up to `most` programmes whose title matches `title` (Dispatcharr's search syntax) between `from` and `to`. */
  searchGuide(title: string, from: Date, to: Date, most: number): Promise<GuideSearch>;
};

const m3uAccount = z.object({
  id: z.number(),
  name: z.string(),
  is_active: z.boolean(),
  locked: z.boolean(),
  status: z.string(),
  max_streams: z.number(),
  earliest_expiration: z.iso.datetime({ offset: true }).nullable(),
  profiles: z.array(z.object({ current_viewers: z.number() })),
});

const channelPage = z.object({
  count: z.number(),
  results: z.array(
    z.object({
      id: z.number(),
      effective_channel_number: z.number(),
      effective_name: z.string(),
      effective_channel_group_id: z.number().nullable(),
      effective_epg_data_id: z.number().nullable(),
      streams: z.array(z.number()),
    }),
  ),
});
const stream = z.object({
  id: z.number(),
  name: z.string(),
  m3u_account: z.number().nullable(),
  is_stale: z.boolean(),
  stream_stats: z.object({ resolution: z.string().optional() }).nullable(),
});
const programmePage = z.object({
  count: z.number(),
  results: z.array(
    z.object({
      title: z.string(),
      start_time: z.iso.datetime({ offset: true }),
      end_time: z.iso.datetime({ offset: true }),
      channels: z.array(z.object({ channel_number: z.number(), name: z.string() })),
      streams: z.array(z.unknown()),
    }),
  ),
});
const guideEntry = z.object({ name: z.string(), tvg_id: z.string() });
const group = z.object({ name: z.string() });
const profiles = z.array(z.object({ name: z.string(), channels: z.array(z.number()) }));

/** "1920x1080"; Dispatcharr reports "0x0" before it has measured a Stream. */
function resolutionOf(raw: z.infer<typeof stream>): { resolution?: string } {
  const resolution = raw.stream_stats?.resolution;
  return resolution && resolution !== "0x0" ? { resolution } : {};
}

/** "2026-11-20T14:11:38Z": to the second, as Dispatcharr's search takes it. */
const isoSecond = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

/** Reads live TV from Dispatcharr at `url`, sending `apiKey` in a header. */
export function dispatcharr(
  fetch: typeof globalThis.fetch,
  url: string,
  apiKey: string,
): Dispatcharr {
  const http = httpRequests(fetch, `${url}/api`, "Dispatcharr", { "X-API-Key": apiKey });

  /** Each id fetched once, however many Channels share it. */
  function once<T>(fetchOne: (id: number) => Promise<T>) {
    const asked = new Map<number, Promise<T>>();
    return (id: number) => {
      const known = asked.get(id);
      if (known) return known;
      const answer = fetchOne(id);
      asked.set(id, answer);
      return answer;
    };
  }

  return {
    async m3uAccounts() {
      const accounts = await http.getJson("/m3u/accounts/", z.array(m3uAccount));
      return (
        accounts
          // Dispatcharr's own locked account holds hand-made Streams and has no provider to refresh from.
          .filter((a) => !a.locked)
          .map((a) => ({
            name: a.name,
            active: a.is_active,
            refresh: a.status,
            connections: a.max_streams,
            inUse: a.profiles.reduce((sum, p) => sum + p.current_viewers, 0),
            ...(a.earliest_expiration ? { expires: new Date(a.earliest_expiration) } : {}),
          }))
      );
    },

    async findChannels(name, most) {
      const page = await http.getJson(
        `/channels/channels/?name=${encodeURIComponent(name)}&ordering=channel_number&page_size=${most}`,
        channelPage,
      );
      if (page.results.length === 0) return { channels: [], total: page.count, profileCount: 0 };
      const guideOf = once((id) => http.getJson(`/epg/epgdata/${id}/`, guideEntry));
      const groupOf = once((id) => http.getJson(`/channels/groups/${id}/`, group));
      const [accounts, allProfiles] = await Promise.all([
        http.getJson("/m3u/accounts/", z.array(m3uAccount)),
        http.getJson("/channels/profiles/", profiles),
      ]);
      const accountName = (id: number | null) =>
        accounts.find((a) => a.id === id)?.name ?? "an unknown account";

      const channels = await Promise.all(
        page.results.map(async (raw): Promise<Channel> => {
          const [streams, guide, groupOfChannel] = await Promise.all([
            raw.streams.length === 0
              ? []
              : http.getJson(`/channels/channels/${raw.id}/streams/`, z.array(stream)),
            raw.effective_epg_data_id === null ? undefined : guideOf(raw.effective_epg_data_id),
            raw.effective_channel_group_id === null
              ? undefined
              : groupOf(raw.effective_channel_group_id),
          ]);
          // The Channel's own list holds the order; the Streams' answer isn't relied on for it.
          const ordered = raw.streams.flatMap((id) => streams.filter((s) => s.id === id));
          return {
            number: raw.effective_channel_number,
            name: raw.effective_name,
            ...(groupOfChannel ? { group: groupOfChannel.name } : {}),
            ...(guide ? { guide: { name: guide.name, tvgId: guide.tvg_id } } : {}),
            streams: ordered.map((s) => ({
              name: s.name,
              account: accountName(s.m3u_account),
              stale: s.is_stale,
              ...resolutionOf(s),
            })),
            profiles: allProfiles.filter((p) => p.channels.includes(raw.id)).map((p) => p.name),
          };
        }),
      );
      return { channels, total: page.count, profileCount: allProfiles.length };
    },

    async searchGuide(title, from, to, most) {
      // Ending after `from` takes in what's on now, as well as what starts before `to`.
      const page = await http.getJson(
        `/epg/programs/search/?title=${encodeURIComponent(title)}&end_after=${isoSecond(from)}` +
          `&start_before=${isoSecond(to)}&page_size=${most}`,
        programmePage,
      );
      const programmes = page.results
        .map((p) => ({
          title: p.title,
          start: new Date(p.start_time),
          end: new Date(p.end_time),
          channels: p.channels.map((c) => ({ number: c.channel_number, name: c.name })),
          streamCount: p.streams.length,
        }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      return { programmes, total: page.count };
    },
  };
}
