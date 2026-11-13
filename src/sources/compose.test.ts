import { afterEach, describe, expect, it } from "vitest";
import { type ComposeAnswer, fakeCompose } from "../testing/fake-compose.ts";
import { compose } from "./compose.ts";
import { SourceError } from "./source-error.ts";

const repoPath = "/host/stacks";
const file = "media/compose.yaml";
const dashed = ["-f", "/host/stacks/media/compose.yaml"];

let fake: ReturnType<typeof fakeCompose> | undefined;
afterEach(() => fake?.cleanUp());

function withAnswers(answers: Record<string, ComposeAnswer>) {
  fake = fakeCompose(answers);
  return compose({ command: fake.command, repoPath, dockerSocket: "/run/docker.sock" });
}
const key = (...args: string[]) => [...dashed, ...args].join(" ");

describe("compose", () => {
  it("reads a Compose file's project and Services from its resolved model", async () => {
    const model = JSON.stringify({
      name: "media",
      services: {
        "vpn-client": { image: "example/vpn", environment: { PASSWORD: "not-returned" } },
        downloader: {
          network_mode: "service:vpn-client",
          depends_on: {
            "vpn-client": { condition: "service_healthy", restart: true, required: true },
          },
        },
      },
    });
    const c = withAnswers({ [key("config", "--format", "json")]: { stdout: model } });
    expect(await c.model(file)).toEqual({
      file,
      project: "media",
      services: {
        "vpn-client": {},
        downloader: {
          network_mode: "service:vpn-client",
          depends_on: { "vpn-client": { condition: "service_healthy", restart: true } },
        },
      },
    });
  });

  it("still reads the model when Compose also prints a warning", async () => {
    const c = withAnswers({
      [key("config", "--format", "json")]: {
        stdout: JSON.stringify({ name: "ops", services: { dashboard: {} } }),
        stderr: 'WARN[0000] The "TZ" variable is not set. Defaulting to a blank string.\n',
      },
    });
    expect((await c.model(file)).services).toEqual({ dashboard: {} });
  });

  it("reaches Docker through the socket it was given", async () => {
    const c = withAnswers({
      [key("config", "--hash", "downloader")]: { stdout: "downloader 4f2a\n" },
    });
    await c.hash(file, "downloader");
    expect(fake?.calls()).toEqual([
      {
        args: [...dashed, "config", "--hash", "downloader"],
        dockerHost: "unix:///run/docker.sock",
      },
    ]);
  });

  it("reads a Service's config hash", async () => {
    const c = withAnswers({
      [key("config", "--hash", "downloader")]: { stdout: "downloader 4f2a\n" },
    });
    expect(await c.hash(file, "downloader")).toBe("4f2a");
  });

  it("returns a dry run's own words, which go to the person to read", async () => {
    const c = withAnswers({
      [key("--dry-run", "up", "-d", "--no-deps", "downloader")]: {
        stderr: " DRY-RUN MODE -  Container downloader  Recreate\n",
      },
    });
    expect(await c.dryRun(file, "downloader")).toBe(
      "DRY-RUN MODE -  Container downloader  Recreate",
    );
  });

  it("pulls one Service's image, then recreates only it and waits for it", async () => {
    const c = withAnswers({
      [key("pull", "downloader")]: {},
      [key("up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "downloader")]: {},
    });
    await c.pull(file, "downloader");
    await c.up(file, "downloader");
    expect(fake?.calls().map((call) => call.args.slice(2).join(" "))).toEqual([
      "pull downloader",
      "up -d --no-deps --wait --wait-timeout 120 downloader",
    ]);
  });

  it("reports a failed command with Compose's last line, as a plain sentence", async () => {
    const c = withAnswers({
      [key("pull", "downloader")]: {
        stderr: "Pulling downloader\nError response from daemon: manifest unknown\n",
        exitCode: 1,
      },
    });
    await expect(c.pull(file, "downloader")).rejects.toThrow(
      new SourceError(
        "Compose couldn't pull downloader: Error response from daemon: manifest unknown",
      ),
    );
  });

  it("says so when Compose answers something it can't read", async () => {
    const c = withAnswers({ [key("config", "--format", "json")]: { stdout: "not json" } });
    await expect(c.model(file)).rejects.toThrow(
      new SourceError("Compose answered with something unexpected for media/compose.yaml."),
    );
  });
});
