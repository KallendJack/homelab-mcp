import type { z } from "zod";
import { SourceError, safeErrorCode } from "./source-error.ts";
import { TIME_LIMIT_SECONDS } from "./time-limit.ts";

/** The requests a Source that speaks HTTP makes to its system. Every failure is a SourceError naming the system. */
export type HttpRequests = {
  /** The whole answer to `path` as bytes, within the time limit. */
  get(path: string): Promise<Uint8Array>;
  /** The answer to `path` as JSON, checked against `schema`. */
  getJson<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  /**
   * A body-less POST to `path`; the Allowlist owns its time limit. Any status comes back, since for an Action a status such as
   * 304 or 404 is an answer to word, not a failure; only not getting an answer is a SourceError.
   */
  post(path: string, body?: PostBody): Promise<{ status: number; bytes: Uint8Array; text: string }>;
};

/**
 * What a POST sends: `json` as JSON or `text` as it is, extra `headers`, and `timeLimited` for a request that may
 * give up after the time limit. Writes to Docker leave it off: Docker may still be changing the Host.
 */
export type PostBody = {
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  timeLimited?: boolean;
};

/**
 * Asks `system` (such as "Docker" or "Gatus", used in error sentences) at `baseUrl`, sending `headers` with
 * every request. Secrets such as API keys go in headers, never in a URL, which can end up in logs and errors.
 * Every failure becomes a plain sentence: the time limit passed, it couldn't be reached, it answered with an
 * error status or something unexpected, or it stopped answering part way through.
 */
export function httpRequests(
  fetch: typeof globalThis.fetch,
  baseUrl: string,
  system: string,
  headers: Record<string, string> = {},
): HttpRequests {
  async function get(path: string): Promise<Uint8Array> {
    // The time limit covers reading the body too, so a timeout can surface in either await.
    const signal = AbortSignal.timeout(TIME_LIMIT_SECONDS * 1000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, { signal, headers });
    } catch (error) {
      throw networkFailure(error);
    }
    if (!response.ok) throw new SourceError(`${system} answered with HTTP ${response.status}.`);
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isTimeout(error)) throw networkFailure(error);
      throw new SourceError(`${system} stopped answering part way through.`);
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
    if (!parsed.success) throw new SourceError(`${system} answered with something unexpected.`);
    return parsed.data;
  }

  /**
   * A network error's own text can name the Host (a URL, an address), so the Client only ever
   * sees a fixed sentence, plus the error code, such as ECONNREFUSED, when there is one.
   */
  function networkFailure(error: unknown): SourceError {
    if (isTimeout(error)) {
      return new SourceError(`${system} didn't answer within ${TIME_LIMIT_SECONDS} seconds.`);
    }
    const code = safeErrorCode((error as { cause?: unknown }).cause);
    return new SourceError(`Couldn't reach ${system}${code ? ` (${code})` : ""}.`);
  }

  async function post(path: string, body: PostBody = {}) {
    // A write to Docker isn't aborted on the time limit: Docker may still be changing the Host.
    // The Allowlist reports its deadline while holding the lock until this request settles.
    const signal = body.timeLimited ? AbortSignal.timeout(TIME_LIMIT_SECONDS * 1000) : undefined;
    const content =
      body.json !== undefined
        ? { body: JSON.stringify(body.json), type: { "Content-Type": "application/json" } }
        : { body: body.text, type: {} };
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { ...headers, ...content.type, ...body.headers },
        ...(content.body !== undefined ? { body: content.body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw networkFailure(error);
    }
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, bytes, text: new TextDecoder().decode(bytes) };
    } catch (error) {
      if (isTimeout(error)) throw networkFailure(error);
      throw new SourceError(`${system} stopped answering part way through.`);
    }
  }

  return { get, getJson, post };
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}
