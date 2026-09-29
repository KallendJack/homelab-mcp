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

  it("gives up on Docker after 10 seconds", async () => {
    const { fetch, requests } = fakeFetch({
      [containersUrl]: new DOMException("The operation timed out.", "TimeoutError"),
    });

    await expect(listContainers(fetch).handler({})).rejects.toThrow(
      new SourceError("Docker didn't answer within 10 seconds."),
    );
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("says so when Docker can't be reached", async () => {
    const { fetch } = fakeFetch({ [containersUrl]: new TypeError("fetch failed") });

    const failure = listContainers(fetch).handler({});
    await expect(failure).rejects.toBeInstanceOf(SourceError);
    await expect(failure).rejects.toThrow("Couldn't reach Docker (fetch failed).");
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
