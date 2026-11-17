import {
  type Arr,
  type ArrApp,
  QUEUE_PAGE_SIZE,
  type Queue,
  type QueueItem,
  type QueueState,
} from "./sources/arr.ts";
import { SourceError } from "./sources/source-error.ts";
import { count, section } from "./wording.ts";

/** Worst first: what needs a person, then what's waiting, then what's just downloading. */
const RANK: Record<QueueState, number> = {
  failed: 0,
  "import blocked": 1,
  "import pending": 2,
  stalled: 3,
  warning: 4,
  importing: 5,
  downloading: 6,
  queued: 7,
  paused: 8,
  completed: 9,
};
const PROBLEMS: QueueState[] = ["failed", "import blocked", "import pending", "stalled", "warning"];

type Read = { app: ArrApp; queue: Queue };
type Unread = { app: ArrApp; error: SourceError };

/** Reads every configured app's queue, so one app that can't be read doesn't hide the other's. */
export async function downloadQueue(apps: Arr[]): Promise<string> {
  const results: (Read | Unread)[] = await Promise.all(
    apps.map(async (a): Promise<Read | Unread> => {
      try {
        return { app: a.app, queue: await a.queue() };
      } catch (error) {
        if (error instanceof SourceError) return { app: a.app, error };
        throw error;
      }
    }),
  );
  const read = results.filter((r): r is Read => "queue" in r);
  const failed = results.filter((r): r is Unread => "error" in r);
  if (read.length === 0) throw new SourceError(failed.map((f) => f.error.message).join(" "));

  const items = read.flatMap((r) => r.queue.items);
  const notes = [
    ...failed.map((f) => `${f.app} couldn't be read: ${f.error.message}`),
    ...read.flatMap((r) =>
      r.queue.total
        ? [
            `Only the first ${QUEUE_PAGE_SIZE} of ${r.queue.total} ${r.app} queue records were read.`,
          ]
        : [],
    ),
  ];
  if (items.length === 0) {
    const names = read.map((r) => r.app).join(" and ");
    return [`The download queue is empty (${names}).`, ...notes].join("\n");
  }

  const order = (a: QueueItem, b: QueueItem) =>
    RANK[a.state] - RANK[b.state] || a.app.localeCompare(b.app) || a.title.localeCompare(b.title);
  const problems = items.filter((i) => PROBLEMS.includes(i.state)).sort(order);
  const others = items.filter((i) => !PROBLEMS.includes(i.state)).sort(order);
  return [
    `${count(items.length, "download")} in the queue, ${problems.length} with problems.`,
    ...notes,
    ...section("Problems:", problems, line),
    ...section("Downloading:", others, line),
  ].join("\n");
}

/** "Sonarr 102: Second Show S01E10, stalled, 12%: The download is stalled with no connections". */
function line(item: QueueItem): string {
  const state = item.state === "downloading" ? [] : [item.state];
  const progress = item.progress === undefined ? [] : [`${item.progress}%`];
  const head = [`${item.app} ${item.id}: ${item.title}`, ...state, ...progress].join(", ");
  return item.message ? `${head}: ${item.message}` : head;
}
