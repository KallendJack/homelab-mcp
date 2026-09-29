import { z } from "zod";
import { SourceError } from "./source-error.ts";

export type Container = {
  name: string;
  /** Docker's state: running, exited, restarting, paused, created, removing or dead. */
  state: string;
  /** Docker's status text, such as "Up 2 days (unhealthy)". */
  status: string;
  image: string;
};

export type Docker = {
  containers(): Promise<Container[]>;
};

const TIMEOUT_MS = 10_000;

const containerList = z.array(
  z.object({
    Names: z.array(z.string()).min(1),
    State: z.string(),
    Status: z.string(),
    Image: z.string(),
  }),
);

/** Reads Containers through the read-only socket proxy at `url` (ADR 0002). */
export function docker(fetch: typeof globalThis.fetch, url: string): Docker {
  async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new SourceError("Docker didn't answer within 10 seconds.");
      }
      throw new SourceError(`Couldn't reach Docker (${(error as Error).message}).`);
    }
    if (!response.ok) throw new SourceError(`Docker answered with HTTP ${response.status}.`);

    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new SourceError("Docker answered with something unexpected.");
    return parsed.data;
  }

  return {
    async containers() {
      const list = await getJson("/containers/json?all=true", containerList);
      return list.map((c) => ({
        // Docker prefixes names with a slash.
        name: (c.Names[0] ?? "").replace(/^\//, ""),
        state: c.State,
        status: c.Status,
        image: c.Image,
      }));
    },
  };
}
