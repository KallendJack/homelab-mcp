import { z } from "zod";
import type { Channel, Dispatcharr, Stream } from "../sources/dispatcharr.ts";
import type { Tool } from "../tools.ts";
import { count } from "../wording.ts";

/** The most Channels find_channel shows: enough to pick from, few enough to read. */
const MOST_CHANNELS = 10;

const findInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("Part of the Channel's name, such as sky sports or bbc one"),
});

/** "EPL", "EPL and UCL", "EPL, F1 and UCL". */
function listOf(words: string[]): string {
  const last = words.at(-1) ?? "";
  return words.length < 2 ? last : `${words.slice(0, -1).join(", ")} and ${last}`;
}

function streamLine(stream: Stream, position: number): string {
  const details = [stream.account, ...(stream.resolution ? [stream.resolution] : [])];
  return `  ${position}. ${stream.name} (${details.join(", ")})${stream.stale ? ", stale" : ""}`;
}

function profilesLine(channel: Channel, profileCount: number): string {
  if (channel.profiles.length === 0) return "- In no channel profile.";
  if (channel.profiles.length === profileCount) return "- In every channel profile.";
  return `- In channel ${channel.profiles.length === 1 ? "profile" : "profiles"} ${listOf(channel.profiles)}.`;
}

function channelBlock(channel: Channel, profileCount: number): string[] {
  return [
    `${channel.number} ${channel.name}${channel.group ? ` (${channel.group})` : ""}`,
    channel.guide ? `- Guide: ${channel.guide.name} (${channel.guide.tvgId})` : "- No Guide link.",
    ...(channel.streams.length === 0
      ? ["- No Stream, so it can't play."]
      : [
          "- Streams, in the order Dispatcharr tries them:",
          ...channel.streams.map((s, i) => streamLine(s, i + 1)),
        ]),
    profilesLine(channel, profileCount),
  ];
}

/** find_channel: a read Tool, so it only asks Dispatcharr what it has. */
export function findChannel(dispatcharr: Dispatcharr): Tool {
  return {
    name: "find_channel",
    description:
      "Finds live TV Channels in Dispatcharr by part of their name and shows up to 10, in channel number order: " +
      "each Channel's number and group, the Guide entry it's linked to, its Streams in the order Dispatcharr " +
      "tries them (the first that works plays) with each Stream's provider account and resolution, and the " +
      "channel profiles it's in. Use it to answer where a channel is, why it won't play or shows the wrong " +
      "Guide, and which Streams back it.",
    inputSchema: findInput.shape,
    async handler(args) {
      const { name } = findInput.parse(args);
      const { channels, total, profileCount } = await dispatcharr.findChannels(name, MOST_CHANNELS);
      if (channels.length === 0) return `No Channel in Dispatcharr is named like "${name}".`;
      const heading =
        total > channels.length
          ? `${channels.length} of ${total} Channels named like "${name}". Add more of the name to narrow it.`
          : `${count(channels.length, "Channel")} named like "${name}".`;
      return [heading, ...channels.flatMap((c) => ["", ...channelBlock(c, profileCount)])].join(
        "\n",
      );
    },
  };
}
