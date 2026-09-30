import { z } from "zod";
import { closestNames } from "./closest-names.ts";
import { Refusal } from "./refusal.ts";
import { CONTAINER_NAME, type Container, type Docker } from "./sources/docker.ts";

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
  ];
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

function unknownName(wanted: string, names: string[]): string {
  const closest = closestNames(wanted, names);
  const suggestion = closest.length === 0 ? "" : ` Closest: ${closest.join(", ")}.`;
  return `No Container is named "${wanted}".${suggestion} list_containers shows every name.`;
}

/** A titled list after a blank line, or nothing when there are no items. */
function section<T>(title: string, items: T[], line: (item: T) => string): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `- ${line(item)}`)];
}
