import {
  type Arr,
  type ArrApp,
  PROBLEM_STATES,
  QUEUE_STATES,
  type Queue,
  type QueueItem,
} from "./sources/arr.ts";
import { SourceError } from "./sources/source-error.ts";
import { count, section } from "./wording.ts";

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
    ...read.flatMap(({ app, queue: { shortOf } }) =>
      shortOf
        ? [`Only ${shortOf.read} of ${shortOf.total} ${app} queue records could be read.`]
        : [],
    ),
  ];
  if (items.length === 0) {
    const names = read.map((r) => r.app).join(" and ");
    return [`The download queue is empty (${names}).`, ...notes].join("\n");
  }

  const order = (a: QueueItem, b: QueueItem) =>
    QUEUE_STATES.indexOf(a.state) - QUEUE_STATES.indexOf(b.state) ||
    a.app.localeCompare(b.app) ||
    a.title.localeCompare(b.title);
  const problems = items.filter((i) => PROBLEM_STATES.includes(i.state)).sort(order);
  const others = items.filter((i) => !PROBLEM_STATES.includes(i.state)).sort(order);
  return [
    `${count(items.length, "download")} in the queue, ${problems.length} with problems.`,
    ...notes,
    ...section("Problems:", problems, line),
    ...section("Downloading or waiting:", others, line),
  ].join("\n");
}

/** "Sonarr 102: Second Show S01E10, stalled, 12%: The download is stalled with no connections". */
function line(item: QueueItem): string {
  const state = item.state === "downloading" ? [] : [item.state];
  const progress = item.progress === undefined ? [] : [`${item.progress}%`];
  const head = [`${item.app} ${item.id}: ${item.title}`, ...state, ...progress].join(", ");
  return item.message ? `${head}: ${item.message}` : head;
}
