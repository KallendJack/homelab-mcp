import { z } from "zod";
import { humanBytes } from "./bytes.ts";
import { closestNames } from "./closest-names.ts";
import { Refusal } from "./refusal.ts";
import type { Disk, DiskFailure, DiskUsage } from "./sources/disk.ts";
import { CONTAINER_NAME, type Container, type Docker } from "./sources/docker.ts";
import type { Gatus, HealthCheck } from "./sources/gatus.ts";

/** One capability offered to Clients. The handler's text is what the Client reads. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler(args: Record<string, unknown>): Promise<string>;
  /** What the server log may show about a call's arguments. Left out, it shows none. */
  logArguments?(args: Record<string, unknown>): string;
};

export type Sources = {
  docker: Docker;
  disk: Disk;
  /** Optional: off unless configured, and its Tool isn't offered while off (ADR 0001). */
  gatus?: Gatus;
};

export type ToolOptions = {
  /** Container names whose logs are never returned (from config). */
  privateContainers: string[];
};

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 500;

const logsInput = z.object({
  name: z
    .string()
    .regex(CONTAINER_NAME)
    .describe("The Container's exact name, as list_containers shows it"),
  lines: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `How many of the latest lines to return: ${DEFAULT_LOG_LINES} if left out, at most ${MAX_LOG_LINES}`,
    ),
});

export function buildTools(sources: Sources, options: ToolOptions): Tool[] {
  return [
    {
      name: "list_containers",
      description:
        "Lists every Docker container on the homelab host, running or not, with its state, status and image. " +
        "Containers that are stopped, restarting or unhealthy come first. Use it to see what's running, what has " +
        "stopped, or a container's exact name.",
      inputSchema: {},
      handler: async () => formatContainers(await sources.docker.containers()),
    },
    {
      name: "container_logs",
      description:
        "Returns the latest lines of one container's logs, oldest first, each with its date and time. Use it to " +
        "find out why a container is failing or what it has been doing. Needs the exact name from list_containers.",
      inputSchema: logsInput.shape,
      logArguments: (args) => String(args.name),
      handler: async (args) => {
        const { name, lines = DEFAULT_LOG_LINES } = logsInput.parse(args);
        // Checked before Docker is asked anything, so a Private container's logs never reach this server.
        if (options.privateContainers.includes(name)) {
          throw new Refusal(
            `${name} is a Private container, so its logs are never returned. Its status still shows in list_containers.`,
          );
        }
        // Docker also finds a Container by part of its ID, which would get round the Private check, so logs are
        // only ever asked for by a name taken from the list.
        const names = (await sources.docker.containers()).map((c) => c.name);
        if (!names.includes(name)) throw new Refusal(unknownName(name, names));
        return formatLogs(name, await sources.docker.logs(name, Math.min(lines, MAX_LOG_LINES)));
      },
    },
    {
      name: "disk_usage",
      description:
        "Shows how full each configured disk on the homelab host is: percent used, and space used, free and " +
        "total. Use it when something may have run out of space, or to check how much room is left.",
      inputSchema: {},
      handler: async () => formatDiskUsage(await sources.disk.usage()),
    },
    ...optionalTools(sources),
  ];
}

/** The Tools of optional Sources, each only when its Source is on. */
function optionalTools({ gatus }: Sources): Tool[] {
  const tools: Tool[] = [];
  if (gatus) {
    tools.push({
      name: "list_health_checks",
      description:
        "Lists every Gatus health check on the homelab host, failing ones first, with whether each is passing " +
        "and how long its latest check took. Use it to see which services are down or slow from the outside, " +
        "rather than whether their containers are running.",
      inputSchema: {},
      handler: async () => formatHealthChecks(await gatus.healthChecks()),
    });
  }
  return tools;
}

function needsAttention(c: Container): boolean {
  return c.state !== "running" || c.status.includes("(unhealthy)");
}

function formatContainers(containers: Container[]): string {
  const byName = (a: Container, b: Container) => a.name.localeCompare(b.name);
  const attention = containers.filter(needsAttention).sort(byName);
  const normal = containers.filter((c) => !needsAttention(c)).sort(byName);

  return [
    `${containers.length} Containers, ${attention.length} need attention.`,
    ...section(
      "Need attention:",
      attention,
      (c) => `${c.name}: ${c.state}, ${c.status} (${c.image})`,
    ),
    ...section("Running normally:", normal, (c) => `${c.name}: ${c.status} (${c.image})`),
  ].join("\n");
}

function formatLogs(name: string, lines: string[]): string {
  if (lines.length === 0) return `${name} has no log lines.`;
  return [`${name}: last ${lines.length} log lines, oldest first.`, "", ...lines].join("\n");
}

function formatDiskUsage(usage: DiskUsage[]): string {
  const line = (u: DiskUsage) => {
    if ("failure" in u) return `- ${u.label}: ${describeFailure(u.failure)}`;
    // As df counts it: used out of what's usable, so a full disk reads 100% even with space kept back. A
    // filesystem with no size at all, such as /proc, reads 0%.
    const usable = u.used + u.free;
    const percent = usable === 0 ? 0 : Math.round((u.used / usable) * 100);
    const sizes = `${humanBytes(u.used)} used, ${humanBytes(u.free)} free, ${humanBytes(u.total)} total`;
    return `- ${u.label}: ${percent}% used (${sizes})`;
  };
  const paths = usage.length === 1 ? "1 path" : `${usage.length} paths`;
  return [`Disk space for ${paths}.`, "", ...usage.map(line)].join("\n");
}

function formatHealthChecks(checks: HealthCheck[]): string {
  const byGroupThenName = (a: HealthCheck, b: HealthCheck) =>
    a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
  const sorted = [...checks].sort(byGroupThenName);
  const failing = sorted.filter((c) => c.latest?.passing === false);
  const passing = sorted.filter((c) => c.latest?.passing === true);
  const unchecked = sorted.filter((c) => c.latest === undefined);
  const title = (c: HealthCheck) => (c.group === "" ? c.name : `${c.group} / ${c.name}`);
  const result = (c: HealthCheck) =>
    `${title(c)}: ${c.latest?.passing ? "passing" : "failing"} (${c.latest?.responseMs} ms)`;

  return [
    `${checks.length} Health checks, ${failing.length} failing.`,
    ...section("Failing:", failing, result),
    ...section("Passing:", passing, result),
    ...section("Not checked yet:", unchecked, title),
  ].join("\n");
}

function describeFailure(failure: DiskFailure): string {
  if (failure.kind === "timed out") return `didn't answer within ${failure.seconds} seconds.`;
  return `couldn't be read${failure.code ? ` (${failure.code})` : ""}.`;
}

function unknownName(wanted: string, names: string[]): string {
  const closest = closestNames(wanted, names);
  const suggestion = closest.length === 0 ? "" : ` Closest: ${closest.join(", ")}.`;
  return `No Container is named "${wanted}".${suggestion} list_containers shows every name.`;
}

/** A titled list after a blank line, or nothing when there are no items. */
function section<T>(title: string, items: T[], line: (item: T) => string): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `- ${line(item)}`)];
}
