/** A Source couldn't answer. The message is a plain sentence the Client is shown as it is. */
export class SourceError extends Error {}

/**
 * An error's code, such as ECONNREFUSED or ENOENT, if it has a plain one. The error's own text can name the
 * Host (a URL, an address, a path), so only this code is ever shown to the Client.
 */
export function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : undefined;
}
