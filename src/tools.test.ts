import { describe, expect, it } from "vitest";
import { docker } from "./sources/docker.ts";
import { SourceError } from "./sources/source-error.ts";
import { fakeFetch, fixture } from "./testing/fake-fetch.ts";
import { buildTools, type Tool } from "./tools.ts";

const dockerUrl = "http://proxy.example:2375";
const containersUrl = `${dockerUrl}/containers/json?all=true`;

function listContainers(fetch: typeof globalThis.fetch): Tool {
  const tool = buildTools({ docker: docker(fetch, dockerUrl) }).find(
    (t) => t.name === "list_containers",
  );
  if (!tool) throw new Error("list_containers isn't offered");
  return tool;
}

describe("list_containers", () => {
  it("lists every Container, the ones needing attention first, each group by name", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: fixture("docker/containers.json") });

    expect(await listContainers(fetch).handler({})).toBe(
      [
        "5 Containers, 3 need attention.",
        "",
        "Need attention:",
        "- backup-job: exited, Exited (1) 3 hours ago (alpine:3.20)",
        "- media-server: running, Up 2 days (unhealthy) (jellyfin/jellyfin:10.11.0)",
        "- sync-worker: restarting, Restarting (1) 20 seconds ago (example/sync:1.4.0)",
        "",
        "Running normally:",
        "- dashboard: Up 2 days (glanceapp/glance:v0.8.6)",
        "- dns: Up 5 hours (healthy) (adguard/adguardhome:v0.107.79)",
      ].join("\n"),
    );
  });

  it("tells the Client when Docker times out, and asks with a time limit", async () => {
    const { fetch, requests } = fakeFetch({
      [containersUrl]: new DOMException("The operation timed out.", "TimeoutError"),
    });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker didn't answer within 10 seconds."),
    );
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a timeout while reading Docker's answer as a timeout", async () => {
    const stalledBody = new ReadableStream({
      pull: (controller) =>
        controller.error(new DOMException("The operation timed out.", "TimeoutError")),
    });
    const fetch = (async () => new Response(stalledBody)) as typeof globalThis.fetch;

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker didn't answer within 10 seconds."),
    );
  });

  it("says Docker can't be reached, giving only the network error code", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:2375"), {
        code: "ECONNREFUSED",
      }),
    });
    const { fetch } = fakeFetch({ [containersUrl]: refused });

    const failure = listContainers(fetch).handler({});
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    await expect(failure).rejects.toThrow("Couldn't reach Docker (ECONNREFUSED).");
  });

  it("never passes a network error's own text to the Client, which could name the Host", async () => {
    const { fetch } = fakeFetch({
      [containersUrl]: new TypeError("Failed to parse URL from http://nas.example:2375"),
    });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Couldn't reach Docker."),
    );
  });

  it("passes on an error status from Docker", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: { status: 403, body: "Forbidden" } });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker answered with HTTP 403."),
    );
  });

  it("says so when Docker's answer isn't the expected shape", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: { body: '{"message":"page not found"}' } });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker answered with something unexpected."),
    );
  });
});
