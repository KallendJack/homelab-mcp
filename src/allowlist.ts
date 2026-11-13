import { redact } from "./redaction.ts";
import { Refusal } from "./refusal.ts";
import type { Notifier } from "./sources/ntfy.ts";
import type { Tool } from "./tools.ts";

/** A Tool that changes the Host. The Allowlist adds its marking, logging, time limit and the one-at-a-time rule. */
export type Action = Omit<Tool, "changesHost" | "logArguments"> & {
  /** How long it may take before the Client is told it timed out. One minute if left out. */
  timeLimitSeconds?: number;
};

const DEFAULT_TIME_LIMIT_SECONDS = 60;
/** ntfy caps a message at 4 KB; an Action's answer is cut well short of that. */
const NOTIFICATION_MAX_CHARS = 1000;

export type AllowlistOptions = {
  /** Set, every Action sends one Notification when it really ends, whether it worked or not. */
  notifier?: Notifier;
};

/**
 * Turns Actions into the Tools admin mode offers. Only one runs at a time, across every Client:
 * two deploys at once could leave the Host half-way through both.
 */
export function allowlist(actions: Action[], options: AllowlistOptions = {}): Tool[] {
  let running: string | undefined;
  const tell = notify(options.notifier);

  return actions.map(({ timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS, ...action }) => ({
    ...action,
    changesHost: true,
    // Every argument is logged, so the log is a full record of what was asked of the Host.
    logArguments: (args) => JSON.stringify(args),
    async handler(args) {
      if (running !== undefined) {
        throw new Refusal(
          `${running} is still running. Only one Action runs at a time, so try again when it has finished.`,
        );
      }
      running = action.name;
      // The lock is released when the work really ends, not when the Client gives up waiting:
      // a timed-out Action can still be changing the Host.
      // The Notification goes out before the lock is released, so it always describes the latest Action.
      const work = startNow(() => action.handler(args))
        .then(
          async (answer) => {
            await tell(action.name, args, answer, false);
            return answer;
          },
          async (error: unknown) => {
            await tell(
              action.name,
              args,
              error instanceof Error ? error.message : String(error),
              true,
            );
            throw error;
          },
        )
        .finally(() => {
          running = undefined;
        });
      return await withinLimit(work, action.name, timeLimitSeconds);
    },
  }));
}

/**
 * Sends an Action's Notification, if Notifications are on. Its text is redacted like every answer, and a
 * Notification that can't be sent is logged and never fails the Action it describes.
 */
function notify(notifier: Notifier | undefined) {
  return async (name: string, args: Record<string, unknown>, outcome: string, failed: boolean) => {
    if (notifier === undefined) return;
    const message = redact(`Asked: ${JSON.stringify(args)}
${outcome}`).slice(0, NOTIFICATION_MAX_CHARS);
    try {
      await notifier.send({ title: `${name} ${failed ? "failed" : "done"}`, message, failed });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      console.log(`${name}'s Notification couldn't be sent: ${redact(why)}`);
    }
  };
}

/** Starts `run` at once, turning a throw before its first await into a rejection, so the lock is always released. */
function startNow(run: () => Promise<string>): Promise<string> {
  try {
    return run();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** `work`'s result, or a Refusal saying the Action timed out if `seconds` pass first. */
async function withinLimit(work: Promise<string>, name: string, seconds: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Refusal(
            `${name} didn't finish within ${seconds} seconds. It may still be running, so the Host may be ` +
              "part-way through: check before trying again.",
          ),
        ),
      seconds * 1000,
    );
  });
  // A timed-out Action that later fails has nobody to tell; this stops Node reporting it as unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** What admin mode logs at start: the Action names, the config repo's path and whether Notifications are on. */
export function adminStartUp(repoPath: string, tools: Tool[], notificationsOn: boolean): string {
  const names = tools.map((tool) => tool.name).join(", ") || "none";
  const notifications = notificationsOn ? "on" : "off";
  return `Allowlist: ${names}. Config repo: ${repoPath}. Notifications: ${notifications}.`;
}
