import { z } from "zod";
import { httpRequests } from "./http.ts";

/** Sonarr or Radarr: both speak the same v3 API, with series and episodes in one and films in the other. */
export type ArrApp = "Sonarr" | "Radarr";

/** What a Queue item is doing, from the app's own status and tracked state, worst first. */
export const QUEUE_STATES = [
  "failed",
  "download client unavailable",
  "import blocked",
  "import pending",
  "stalled",
  "warning",
  "importing",
  "downloading",
  "queued",
  "paused",
  "completed",
  "ignored",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** The states that need a person, or at least a look. */
export const PROBLEM_STATES: readonly QueueState[] = QUEUE_STATES.slice(0, 6);

/** One download the app is tracking. A season pack is one download, even though the app lists each episode. */
export type QueueItem = {
  app: ArrApp;
  /** The app's id for this download's worst queue record, which the Actions take. */
  id: number;
  /** "Example Show S02E03", "Pack Show, 2 episodes", "Example Film (2025)", or the release name when unmatched. */
  title: string;
  state: QueueState;
  /** Percent downloaded, while it's still downloading. Never 100 until it's finished. */
  progress?: number;
  /** The app's own warning or error, as it words it. */
  message?: string;
};

export type Queue = {
  items: QueueItem[];
  /** Set when fewer records could be read than the app says it has. */
  shortOf?: { read: number; total: number };
};

export type Arr = {
  app: ArrApp;
  queue(): Promise<Queue>;
};

const PAGE_SIZE = 100;
/** Enough for a queue full of season packs; a queue longer than this is said to be read in part. */
const MAX_PAGES = 10;

const record = z.object({
  id: z.number(),
  title: z.string().optional(),
  size: z.number().optional(),
  sizeleft: z.number().optional(),
  status: z.string().optional(),
  trackedDownloadStatus: z.string().optional(),
  trackedDownloadState: z.string().optional(),
  statusMessages: z.array(z.object({ messages: z.array(z.string()).optional() })).optional(),
  errorMessage: z.string().optional(),
  downloadId: z.string().optional(),
  series: z.object({ title: z.string() }).optional(),
  episode: z.object({ seasonNumber: z.number(), episodeNumber: z.number() }).optional(),
  movie: z.object({ title: z.string(), year: z.number().optional() }).optional(),
});
type QueueRecord = z.infer<typeof record>;

const page = z.object({ totalRecords: z.number(), records: z.array(record) });

/** Reads Sonarr's or Radarr's queue at `url`, sending `apiKey` in the X-Api-Key header. */
export function arr(fetch: typeof globalThis.fetch, url: string, apiKey: string, app: ArrApp): Arr {
  const { getJson } = httpRequests(fetch, url, app, { "X-Api-Key": apiKey });
  const include =
    app === "Sonarr"
      ? "includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true"
      : "includeUnknownMovieItems=true&includeMovie=true";

  return {
    app,
    async queue() {
      // Every page, so the downloads on later pages are counted: a season pack is one record per episode.
      const records: QueueRecord[] = [];
      let total = 0;
      for (let n = 1; n <= MAX_PAGES; n++) {
        const answer = await getJson(
          `/api/v3/queue?page=${n}&pageSize=${PAGE_SIZE}&${include}`,
          page,
        );
        total = answer.totalRecords;
        records.push(...answer.records);
        if (answer.records.length === 0 || records.length >= total) break;
      }
      return {
        items: downloads(records).map((group) => queueItem(app, group)),
        ...(records.length < total ? { shortOf: { read: records.length, total } } : {}),
      };
    },
  };
}

/**
 * Records grouped by download, in the app's order. A season pack has one record per episode, sharing a download
 * id; one still waiting to start has none yet, so its release name stands in.
 */
function downloads(records: QueueRecord[]): QueueRecord[][] {
  const groups = new Map<string, QueueRecord[]>();
  for (const r of records) {
    const key = r.downloadId
      ? `download:${r.downloadId}`
      : r.title
        ? `release:${r.title}`
        : `record:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

const rank = (state: QueueState) => QUEUE_STATES.indexOf(state);

function queueItem(app: ArrApp, group: QueueRecord[]): QueueItem {
  // The worst episode speaks for the pack: one blocked import is the problem, even if the rest are fine.
  const [worst] = [...group].sort((a, b) => rank(stateOf(a)) - rank(stateOf(b))) as [
    QueueRecord,
    ...QueueRecord[],
  ];
  const state = stateOf(worst);
  const message = messageOf(worst);
  const downloading = (
    ["download client unavailable", "stalled", "warning", "downloading", "paused"] as QueueState[]
  ).includes(state);
  const { size, sizeleft } = worst;
  const progress =
    downloading && size && size > 0 && sizeleft !== undefined
      ? Math.floor(((size - sizeleft) * 100) / size)
      : undefined;
  return {
    app,
    id: worst.id,
    title: titleOf(group),
    state,
    ...(progress !== undefined ? { progress } : {}),
    ...(message ? { message } : {}),
  };
}

function stateOf(r: QueueRecord): QueueState {
  const tracked = r.trackedDownloadState;
  if (tracked === "failed" || tracked === "failedPending" || r.status === "failed") return "failed";
  if (r.trackedDownloadStatus === "error") return "failed";
  if (r.status === "downloadClientUnavailable") return "download client unavailable";
  if (tracked === "ignored") return "ignored";
  if (tracked === "importBlocked") return "import blocked";
  if (tracked === "importPending") return "import pending";
  if (tracked === "importing") return "importing";
  if (r.status === "warning" || r.trackedDownloadStatus === "warning") {
    return /stalled/i.test(messageOf(r) ?? "") ? "stalled" : "warning";
  }
  if (r.status === "queued" || r.status === "delay") return "queued";
  if (r.status === "paused") return "paused";
  if (r.status === "completed") return "completed";
  return "downloading";
}

function messageOf(r: QueueRecord): string | undefined {
  if (r.errorMessage) return r.errorMessage;
  const messages = (r.statusMessages ?? []).flatMap((m) => m.messages ?? []);
  return messages.length > 0 ? messages.join("; ") : undefined;
}

function titleOf(group: QueueRecord[]): string {
  const [first] = group as [QueueRecord, ...QueueRecord[]];
  if (first.movie) {
    return first.movie.year ? `${first.movie.title} (${first.movie.year})` : first.movie.title;
  }
  if (first.series) {
    if (group.length > 1) return `${first.series.title}, ${group.length} episodes`;
    if (first.episode) {
      const two = (n: number) => String(n).padStart(2, "0");
      return `${first.series.title} S${two(first.episode.seasonNumber)}E${two(first.episode.episodeNumber)}`;
    }
    return first.series.title;
  }
  return first.title ?? `queue record ${first.id}`;
}
