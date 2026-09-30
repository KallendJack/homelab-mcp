import { z } from "zod";
import { SourceError, safeErrorCode } from "./source-error.ts";
import { TIME_LIMIT_SECONDS } from "./time-limit.ts";

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
  /** The last `lines` lines of a Container's logs, oldest first, each starting with its date and time. */
  logs(name: string, lines: number): Promise<string[]>;
};

/** Docker's rule for Container names. Nothing else can be one, so anything else can be refused early. */
export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

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
  /** Asks Docker for `path` and reads the answer's body with `readBody`, within the time limit. */
  /** Asks Docker for `path` and returns the whole answer as bytes, within the time limit. */
  async function get(path: string): Promise<Uint8Array> {
    // The time limit covers reading the body too, so a timeout can surface in either await.
    const signal = AbortSignal.timeout(TIME_LIMIT_SECONDS * 1000);
    let response: Response;
    try {
      response = await fetch(`${url}${path}`, { signal });
    } catch (error) {
      throw networkFailure(error);
    }
    if (!response.ok) throw new SourceError(`Docker answered with HTTP ${response.status}.`);
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isTimeout(error)) throw networkFailure(error);
      throw new SourceError("Docker stopped answering part way through.");
    }
  }

  async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const text = new TextDecoder().decode(await get(path));
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
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
      return new SourceError(`Docker didn't answer within ${TIME_LIMIT_SECONDS} seconds.`);
    }
    const code = safeErrorCode((error as { cause?: unknown }).cause);
    return new SourceError(`Couldn't reach Docker${code ? ` (${code})` : ""}.`);
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

    async logs(name, lines) {
      const query = `stdout=1&stderr=1&timestamps=1&tail=${lines}`;
      const path = `/containers/${encodeURIComponent(name)}/logs?${query}`;
      const bytes = await get(path);
      const text = new TextDecoder().decode(isFramed(bytes) ? unframe(bytes) : bytes);
      return text
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map(shortenTimestamp);
    },
  };
}

/**
 * Docker frames the logs of a Container that has no terminal: each chunk starts with an 8-byte header of
 * stream (0 to 2), three zero bytes and the chunk's size. A Container with a terminal sends plain text,
 * which can't start that way.
 */
function isFramed(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 && (bytes[0] ?? 3) <= 2 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0
  );
}

/** Joins the chunks of a framed log stream, dropping their headers. Docker sends them in the order written. */
function unframe(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4);
    chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks);
}

/** "2026-09-30T08:00:02.450000000Z text" becomes "2026-09-30 08:00:02 text": seconds are enough to read by. */
function shortenTimestamp(line: string): string {
  return line.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z /, "$1 $2 ");
}
