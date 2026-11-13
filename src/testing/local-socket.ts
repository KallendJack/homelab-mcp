import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh path for a local socket, as Docker listens on: a Unix socket, or a named pipe on Windows. */
export function localSocketPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\homelab-mcp-test-${randomUUID()}`
    : join(tmpdir(), `homelab-mcp-test-${randomUUID()}.sock`);
}

/** A real HTTP server on a local socket, standing in for Docker. Close it when the test ends. */
export async function serveOnLocalSocket(
  handler: RequestListener,
): Promise<{ path: string; close(): Promise<void> }> {
  const path = localSocketPath();
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
