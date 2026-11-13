import { request } from "node:http";

/**
 * A `fetch` that sends every request to the HTTP server on a local socket, such as Docker's own
 * `/var/run/docker.sock`, which Node's `fetch` can't reach. Only the URL's path and query are used; its host is a
 * placeholder. It handles what the Sources need: a method, headers, a body-less request and a time-limit signal.
 */
export function socketFetch(socketPath: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const req = request(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: { ...(init?.headers as Record<string, string> | undefined), host: "docker" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", (error) => reject(signal?.aborted ? signal.reason : error));
          res.on("end", () => {
            const status = res.statusCode ?? 500;
            // A Response for 204 or 304 must have no body at all, not an empty one.
            const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status }));
          });
        },
      );
      // The same failure fetch gives: the network error as the cause, so its code (ECONNREFUSED) survives.
      req.on("error", (error) => {
        reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: error }));
      });
      signal?.addEventListener("abort", () => req.destroy(), { once: true });
      req.end();
    });
  }) as typeof fetch;
}
