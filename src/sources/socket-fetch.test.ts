import type { RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { localSocketPath, serveOnLocalSocket } from "../testing/local-socket.ts";
import { socketFetch } from "./socket-fetch.ts";

let server: { close(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serveOnSocket(handler: RequestListener): Promise<string> {
  const served = await serveOnLocalSocket(handler);
  server = served;
  return served.path;
}

describe("socketFetch", () => {
  it("sends a GET to the path on the socket and returns the answer", async () => {
    const path = await serveOnSocket((request, response) => {
      response.end(`${request.method} ${request.url}`);
    });
    const response = await socketFetch(path)("http://docker/containers/json?all=true");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("GET /containers/json?all=true");
  });

  it("sends a POST and passes an empty answer's status through", async () => {
    let seen = "";
    const path = await serveOnSocket((request, response) => {
      seen = `${request.method} ${request.url}`;
      response.statusCode = 204;
      response.end();
    });
    const response = await socketFetch(path)("http://docker/containers/backup-job/start", {
      method: "POST",
    });
    expect(seen).toBe("POST /containers/backup-job/start");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("gives up when the signal times out, with the signal's own reason", async () => {
    const path = await serveOnSocket(() => {
      // Never answers.
    });
    const signal = AbortSignal.timeout(50);
    const error = await socketFetch(path)("http://docker/containers/json", { signal }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  it("fails with the system's error code when nothing listens on the socket", async () => {
    const missing = localSocketPath();
    const error = await socketFetch(missing)("http://docker/containers/json").catch(
      (e: unknown) => e,
    );
    expect((error as { cause?: { code?: string } }).cause?.code).toMatch(/^E[A-Z]+$/);
  });
});
