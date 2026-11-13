import { describe, expect, it } from "vitest";
import { Refusal } from "./refusal.ts";
import { dockerAdmin } from "./sources/docker.ts";
import { SourceError } from "./sources/source-error.ts";
import { startContainer } from "./start-container.ts";
import { type FakeAnswer, fakeFetch, fixture } from "./testing/fake-fetch.ts";

const dockerUrl = "http://docker";
const list = `${dockerUrl}/containers/json?all=true`;
const startUrl = (name: string) => `${dockerUrl}/containers/${name}/start`;

/** The Action over a fake Docker that lists the fixture Containers and answers starts from `starts`. */
function action(starts: Record<string, FakeAnswer> = {}) {
  const fake = fakeFetch({
    [list]: fixture("docker/containers.json"),
    ...Object.fromEntries(Object.entries(starts).map(([name, answer]) => [startUrl(name), answer])),
  });
  return { tool: startContainer(dockerAdmin(fake.fetch, dockerUrl)), requests: fake.requests };
}

const posts = (requests: ReturnType<typeof action>["requests"]) =>
  requests.filter((r) => r.init?.method === "POST").map((r) => r.url);

describe("start_container", () => {
  it("starts a stopped Container", async () => {
    const { tool, requests } = action({ "backup-job": { status: 204, body: "" } });
    await expect(tool.handler({ name: "backup-job" })).resolves.toBe(
      "Started backup-job. It was exited.",
    );
    expect(posts(requests)).toEqual([startUrl("backup-job")]);
  });

  it("refuses a running Container without asking Docker to start it", async () => {
    const { tool, requests } = action();
    await expect(tool.handler({ name: "dashboard" })).rejects.toThrow(
      new Refusal("dashboard is already running, so there's nothing to start."),
    );
    expect(posts(requests)).toEqual([]);
  });

  it("refuses an unknown Container and names the closest ones", async () => {
    const { tool, requests } = action();
    await expect(tool.handler({ name: "backup" })).rejects.toThrow(
      new Refusal('No Container is named "backup". Closest: backup-job.'),
    );
    expect(posts(requests)).toEqual([]);
  });

  it("says so when the Container started by itself before Docker got the request", async () => {
    const { tool } = action({ "backup-job": { status: 304, body: "" } });
    await expect(tool.handler({ name: "backup-job" })).rejects.toThrow(
      new Refusal("backup-job is already running, so there's nothing to start."),
    );
  });

  it("says so when the Container was removed before Docker got the request", async () => {
    const missing = { ...fixture("docker/start-no-such-container.json"), status: 404 };
    const { tool } = action({ "backup-job": missing });
    await expect(tool.handler({ name: "backup-job" })).rejects.toThrow(
      new Refusal("backup-job no longer exists."),
    );
  });

  it("reports Docker's failure to start as a plain sentence", async () => {
    const { tool } = action({ "backup-job": { status: 500, body: '{"message":"oci runtime"}' } });
    await expect(tool.handler({ name: "backup-job" })).rejects.toThrow(
      new SourceError("Docker couldn't start backup-job: oci runtime"),
    );
  });

  it("rejects a name Docker couldn't have, before asking Docker anything", async () => {
    const { tool, requests } = action();
    await expect(tool.handler({ name: "../etc" })).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});
