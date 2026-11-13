import { Refusal } from "./refusal.ts";
import type { Tool } from "./tools.ts";

/** A Tool that changes the Host. The Allowlist adds its marking, logging, time limit and the one-at-a-time rule. */
export type Action = Omit<Tool, "changesHost" | "logArguments"> & {
  /** How long it may take before the Client is told it timed out. One minute if left out. */
  timeLimitSeconds?: number;
};

const DEFAULT_TIME_LIMIT_SECONDS = 60;

/**
 * Turns Actions into the Tools admin mode offers. Only one runs at a time, across every Client:
 * two deploys at once could leave the Host half-way through both.
 */
export function allowlist(actions: Action[]): Tool[] {
  let running: string | undefined;

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
      const work = startNow(() => action.handler(args)).finally(() => {
        running = undefined;
      });
      return await withinLimit(work, action.name, timeLimitSeconds);
    },
  }));
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

/** What admin mode logs at start: the Action names and the config repo's path. */
export function adminStartUp(repoPath: string, tools: Tool[]): string {
  const names = tools.map((tool) => tool.name).join(", ") || "none";
  return `Allowlist: ${names}. Config repo: ${repoPath}. Notifications: off.`;
}
