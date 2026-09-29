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

const TIMEOUT_SECONDS = 10;

const containerList = z.array(
  z.object({
    Names: z.array(z.string()).min(1),
    State: z.string(),
    Status: z.string(),
    Image: z.string(),
  }),
);

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** Reads Containers through the read-only socket proxy at `url` (ADR 0002). */
export function docker(fetch: typeof globalThis.fetch, url: string): Docker {
  async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    // The time limit covers reading the body too, so a timeout can surface in either await.
    const signal = AbortSignal.timeout(TIMEOUT_SECONDS * 1000);
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { signal });
    } catch (error) {
      throw networkFailure(error);
    }
    if (!response.ok) throw new SourceError(`Docker answered with HTTP ${response.status}.`);

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (isTimeout(error)) throw networkFailure(error);
      body = undefined;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new SourceError("Docker answered with something unexpected.");
    return parsed.data;
  }

  /**
   * A network error's own text can name the Host (a URL, an address), so the Client only ever
   * sees a fixed sentence, plus the error code, such as ECONNREFUSED, when there is one.
   */
  function networkFailure(error: unknown): SourceError {
    if (isTimeout(error)) {
      return new SourceError(`Docker didn't answer within ${TIMEOUT_SECONDS} seconds.`);
    }
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    const safeCode = typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` (${code})` : "";
    return new SourceError(`Couldn't reach Docker${safeCode}.`);
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
