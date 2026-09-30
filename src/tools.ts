import { z } from "zod";
import { humanBytes } from "./bytes.ts";
import { closestNames } from "./closest-names.ts";
import { formatReport } from "./read-report.ts";
import { formatRecentMedia, recentMediaInput } from "./recent-media.ts";
import { Refusal } from "./refusal.ts";
import type { Disk, DiskFailure, DiskUsage } from "./sources/disk.ts";
import { CONTAINER_NAME, type Container, type Docker } from "./sources/docker.ts";
import type { Gatus, HealthCheck, HealthCheckResult } from "./sources/gatus.ts";
import type { Jellyfin } from "./sources/jellyfin.ts";
import type { ReportSource } from "./sources/report.ts";
import { count, section } from "./wording.ts";

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
  jellyfin?: Jellyfin;
  report?: ReportSource;
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
function optionalTools({ gatus, jellyfin, report }: Sources): Tool[] {
  const tools: Tool[] = [];
  if (gatus) {
    tools.push({
      name: "list_health_checks",
      description:
        "Lists every Gatus health check on the homelab host, failing ones first, with whether each is passing " +
        "and how long its latest check took. Use it to see which Health checks are failing or slow from the " +
        "outside, rather than whether containers are running.",
      inputSchema: {},
      handler: async () => formatHealthChecks(await gatus.healthChecks()),
    });
  }
  if (jellyfin) {
    tools.push({
      name: "recent_media",
      description:
        "Lists the films and TV episodes added to the homelab host's Jellyfin library in the last few days: films " +
        "with their year, then episodes grouped by series with season and episode numbers. Use it to answer " +
        "what's new to watch.",
      inputSchema: recentMediaInput.shape,
      handler: async (args) => {
        const { days = 1 } = recentMediaInput.parse(args);
        return formatRecentMedia(await jellyfin.recentMedia(days), days);
      },
    });
  }
  if (report) {
    tools.push({
      name: "read_report",
      description:
        "Returns the homelab host's scheduled Report, such as its daily status message, exactly as written, with " +
        "when it was written. Starts with a warning if it's older than it should be. Use it to read what the " +
        "Host has already reported about itself, before asking the other tools.",
      inputSchema: {},
      handler: async () => formatReport(await report.read()),
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
  return [`Disk space for ${count(usage.length, "path")}.`, "", ...usage.map(line)].join("\n");
}

function formatHealthChecks(checks: HealthCheck[]): string {
  if (checks.length === 0) return "Gatus has no Health checks.";
  const byGroupThenName = (a: HealthCheck, b: HealthCheck) =>
    a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
  const title = (c: HealthCheck) => (c.group === "" ? c.name : `${c.group} / ${c.name}`);

  const checked: { check: HealthCheck; latest: HealthCheckResult }[] = [];
  const unchecked: HealthCheck[] = [];
  for (const check of [...checks].sort(byGroupThenName)) {
    if (check.latest) checked.push({ check, latest: check.latest });
    else unchecked.push(check);
  }
  const failing = checked.filter((c) => !c.latest.passing);
  const passing = checked.filter((c) => c.latest.passing);
  const result = ({ check, latest }: (typeof checked)[number]) => {
    const time = latest.responseMs === undefined ? "no response" : `${latest.responseMs} ms`;
    return `${title(check)}: ${latest.passing ? "passing" : "failing"} (${time})`;
  };

  return [
    `${count(checks.length, "Health check")}, ${failing.length} failing.`,
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
