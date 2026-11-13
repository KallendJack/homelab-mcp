import { afterEach, describe, expect, it } from "vitest";
import { previewService, recreateService } from "./recreate-service.ts";
import { Refusal } from "./refusal.ts";
import { compose } from "./sources/compose.ts";
import { dockerAdmin, serviceContainersUrl } from "./sources/docker.ts";
import { SourceError } from "./sources/source-error.ts";
import { type ComposeAnswer, fakeCompose } from "./testing/fake-compose.ts";
import { fakeFetch } from "./testing/fake-fetch.ts";

const dockerUrl = "http://docker";
const ops = ["-f", "/host/stacks/ops/compose.yaml"];
const media = ["-f", "/host/stacks/media/compose.yaml"];
const k = (file: string[], ...args: string[]) => [...file, ...args].join(" ");

const models: Record<string, ComposeAnswer> = {
  [k(ops, "config", "--format", "json")]: {
    stdout: JSON.stringify({ name: "ops", services: { dashboard: {}, "homelab-admin": {} } }),
  },
  [k(media, "config", "--format", "json")]: {
    stdout: JSON.stringify({
      name: "media",
      services: {
        "vpn-client": {},
        downloader: { network_mode: "service:vpn-client" },
      },
    }),
  },
};

/** One Container of a Service, as Docker lists it, with Compose's labels. */
function listed(name: string, configHash: string, status = "Up 2 days") {
  return {
    Names: [`/${name}`],
    State: "running",
    Status: status,
    Image: "example/image",
    Labels: { "com.docker.compose.config-hash": configHash },
  };
}

let fake: ReturnType<typeof fakeCompose> | undefined;
afterEach(() => fake?.cleanUp());

/** The two Actions over a fake Compose and a fake Docker that lists `containers` for each "project/service". */
function setUp(answers: Record<string, ComposeAnswer>, containers: Record<string, unknown[]>) {
  fake = fakeCompose({ ...models, ...answers });
  const { fetch } = fakeFetch(
    Object.fromEntries(
      Object.entries(containers).map(([key, list]) => {
        const [project = "", service = ""] = key.split("/");
        return [serviceContainersUrl(dockerUrl, project, service), { body: JSON.stringify(list) }];
      }),
    ),
  );

  const settings = {
    compose: compose({
      command: fake.command,
      repoPath: "/host/stacks",
      dockerSocket: "/run/d.sock",
    }),
    docker: dockerAdmin(fetch, dockerUrl),
    composeFiles: ["ops/compose.yaml", "media/compose.yaml"],
    ownService: "homelab-admin",
  };
  return { preview: previewService(settings), recreate: recreateService(settings) };
}

const composeCalls = () => fake?.calls().map((call) => call.args.slice(2).join(" ")) ?? [];

describe("preview_service", () => {
  it("says what a recreate would do to the Service's Container, with Compose's own dry run", async () => {
    const { preview } = setUp(
      {
        [k(ops, "config", "--hash", "dashboard")]: { stdout: "dashboard new111\n" },
        [k(ops, "--dry-run", "up", "-d", "--no-deps", "dashboard")]: {
          stderr: "DRY-RUN MODE -  Container dashboard  Recreate\n",
        },
      },
      { "ops/dashboard": [listed("dashboard", "old000")] },
    );
    expect(await preview.handler({ service: "dashboard" })).toBe(
      [
        "dashboard (ops/compose.yaml):",
        "- dashboard: recreate",
        "Nothing else would be disturbed.",
        "Compose's dry run:",
        "DRY-RUN MODE -  Container dashboard  Recreate",
      ].join("\n"),
    );
  });

  it("names the Services a recreate would disturb, and says recreate_service would refuse", async () => {
    const { preview } = setUp(
      {
        [k(media, "config", "--hash", "vpn-client")]: { stdout: "vpn-client same22\n" },
        [k(media, "--dry-run", "up", "-d", "--no-deps", "vpn-client")]: { stderr: "" },
      },
      { "media/vpn-client": [listed("vpn-client", "same22")] },
    );
    const answer = await preview.handler({ service: "vpn-client" });
    expect(answer).toContain("- vpn-client: leave alone");
    expect(answer).toContain(
      "It would disturb downloader, which share its network or restart with it, so recreate_service refuses it.",
    );
  });

  it("refuses an unknown Service and names the closest ones", async () => {
    const { preview } = setUp({}, {});
    await expect(preview.handler({ service: "dashbord" })).rejects.toThrow(
      new Refusal('No Service is named "dashbord". Closest: dashboard.'),
    );
  });
});

describe("recreate_service", () => {
  it("pulls the image, recreates only that Service and reports how it came back", async () => {
    const { recreate } = setUp(
      {
        [k(ops, "pull", "dashboard")]: {},
        [k(ops, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "dashboard")]: {},
      },
      {
        // Listed after the recreate, to report how it came back.
        "ops/dashboard": [listed("dashboard", "new111", "Up 4 seconds (healthy)")],
      },
    );
    expect(await recreate.handler({ service: "dashboard" })).toBe(
      "Recreated dashboard (ops/compose.yaml).\n- dashboard: Up 4 seconds (healthy)",
    );
    expect(composeCalls()).toEqual([
      "config --format json",
      "config --format json",
      "pull dashboard",
      "up -d --no-deps --wait --wait-timeout 120 dashboard",
    ]);
  });

  it("refuses a Service others share a network with, before pulling anything", async () => {
    const { recreate } = setUp({}, {});
    await expect(recreate.handler({ service: "vpn-client" })).rejects.toThrow(
      new Refusal(
        "Recreating vpn-client would also disturb downloader, which share its network or restart with it. " +
          "Do it from the Host, with those in mind.",
      ),
    );
    expect(composeCalls().some((call) => call.startsWith("pull"))).toBe(false);
  });

  it("refuses the server's own Service without asking Compose anything", async () => {
    const { recreate } = setUp({}, {});
    await expect(recreate.handler({ service: "homelab-admin" })).rejects.toThrow(
      new Refusal(
        "homelab-admin is this server's own Service, and recreating it would stop the request doing it. " +
          "Recreate it from the Host instead.",
      ),
    );
    expect(composeCalls()).toEqual([]);
  });

  it("reports a Service that didn't come back healthy, with Compose's reason", async () => {
    const { recreate } = setUp(
      {
        [k(ops, "pull", "dashboard")]: {},
        [k(ops, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "dashboard")]: {
          stderr: "container dashboard is unhealthy\n",
          exitCode: 1,
        },
      },
      { "ops/dashboard": [listed("dashboard", "old000")] },
    );
    await expect(recreate.handler({ service: "dashboard" })).rejects.toThrow(
      new SourceError("Compose couldn't recreate dashboard: container dashboard is unhealthy"),
    );
  });

  it("is given five minutes before it's reported as timed out", () => {
    const { recreate } = setUp({}, {});
    expect(recreate.timeLimitSeconds).toBe(300);
  });
});
