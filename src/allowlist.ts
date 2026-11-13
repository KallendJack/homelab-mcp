import { Refusal } from "./refusal.ts";
import type { Tool } from "./tools.ts";

/** A Tool that changes the Host. The Allowlist adds its marking, logging and the one-at-a-time rule. */
export type Action = Omit<Tool, "changesHost" | "logArguments">;

/**
 * Turns Actions into the Tools admin mode offers. Only one runs at a time, across every Client:
 * two deploys at once could leave the Host half-way through both.
 */
export function allowlist(actions: Action[]): Tool[] {
  let running: string | undefined;

  return actions.map((action) => ({
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
      try {
        return await action.handler(args);
      } finally {
        running = undefined;
      }
    },
  }));
}

/** What admin mode logs at start: the Action names and the config repo's path. */
export function adminStartUp(repoPath: string, tools: Tool[]): string {
  const names = tools.map((tool) => tool.name).join(", ") || "none";
  return `Allowlist: ${names}. Config repo: ${repoPath}. Notifications: off.`;
}
