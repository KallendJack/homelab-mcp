import type { z } from "zod";
import type { Container, Docker } from "./sources/docker.ts";

/** One capability offered to Clients. The handler's text is what the Client reads. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler(args: Record<string, unknown>): Promise<string>;
};

export type Sources = {
  docker: Docker;
};

export function buildTools(sources: Sources): Tool[] {
  return [
    {
      name: "list_containers",
      description:
        "Lists every Docker container on the homelab host, running or not, with its state, status and image. " +
        "Containers that are stopped, restarting or unhealthy come first. Use it to see what's running or to find " +
        "a container's exact name before reading its logs.",
      inputSchema: {},
      handler: async () => formatContainers(await sources.docker.containers()),
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

  const lines = [`${containers.length} Containers, ${attention.length} need attention.`];
  if (attention.length > 0) {
    lines.push("", "Need attention:");
    lines.push(...attention.map((c) => `- ${c.name}: ${c.state}, ${c.status} (${c.image})`));
  }
  if (normal.length > 0) {
    lines.push("", "Running normally:");
    lines.push(...normal.map((c) => `- ${c.name}: ${c.status} (${c.image})`));
  }
  return lines.join("\n");
}
