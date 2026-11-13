import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Action, allowlist } from "./allowlist.ts";
import { Refusal } from "./refusal.ts";
import { type RunningServer, startServer } from "./server.ts";
import { disk } from "./sources/disk.ts";
import { docker, dockerAdmin } from "./sources/docker.ts";
import { gatus } from "./sources/gatus.ts";
import { report } from "./sources/report.ts";
import { socketFetch } from "./sources/socket-fetch.ts";
import { SourceError } from "./sources/source-error.ts";
import { startContainer } from "./start-container.ts";
import { fakeFetch, fixture } from "./testing/fake-fetch.ts";
import { serveOnLocalSocket } from "./testing/local-socket.ts";
import { buildTools, type Tool } from "./tools.ts";

const token = "test-token-0123456789-0123456789-abcdef";
const dockerUrl = "http://proxy.example:2375";

let server: RunningServer | undefined;
let fakeDocker: { close(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  await fakeDocker?.close();
  fakeDocker = undefined;
  vi.restoreAllMocks();
});

async function start(tools: Tool[]): Promise<RunningServer> {
  server = await startServer({ token, port: 0 }, tools);
  return server;
}

async function connect(url: string, bearer = token): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  // The SDK's transport types predate exactOptionalPropertyTypes (see server.ts).
  await client.connect(transport as Transport);
  return client;
}

const gatusUrl = "http://gatus.example:8080";

function realTools(options: { gatus?: boolean; reportPath?: string } = {}): Tool[] {
  const { fetch } = fakeFetch({
    [`${gatusUrl}/api/v1/endpoints/statuses?page=1&pageSize=1`]: fixture("gatus/statuses.json"),
    [`${dockerUrl}/containers/json?all=true`]: fixture("docker/containers.json"),
    [`${dockerUrl}/containers/sync-worker/logs?stdout=1&stderr=1&timestamps=1&tail=5`]:
      fixture("docker/logs-plain.txt"),
  });
  const sources = {
    docker: docker(fetch, dockerUrl),
    disk: disk([{ label: "temp", path: tmpdir() }]),
    ...(options.gatus ? { gatus: gatus(fetch, gatusUrl) } : {}),
    ...(options.reportPath ? { report: report(options.reportPath, 26, () => new Date()) } : {}),
  };
  return buildTools(sources, { privateContainers: [] });
}

function toolThatThrows(error: Error): Tool {
  return {
    name: "broken_tool",
    description: "Always fails.",
    inputSchema: {},
    handler: async () => {
      throw error;
    },
  };
}

/** A stand-in for a real Action, which takes a Container name. */
function fakeAction(handler: () => Promise<string>): Action {
  return {
    name: "start_container",
    description: "Starts a stopped Container.",
    inputSchema: { name: z.string(), note: z.string().optional() },
    handler,
  };
}

describe("the Server", () => {
  it("offers the Tools to a Client with the right Token", async () => {
    const { url } = await start(realTools());
    const client = await connect(url);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_containers", "container_logs", "disk_usage"]);
    expect(tools[0]?.description).toMatch(/every Docker container/);
  });

  it("offers list_health_checks only when the Gatus Source is on, and it works end to end", async () => {
    const off = await connect((await startServer({ token, port: 0 }, realTools())).url);
    expect((await off.listTools()).tools.map((t) => t.name)).not.toContain("list_health_checks");

    const { url } = await start(realTools({ gatus: true }));
    const client = await connect(url);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_health_checks");
    const result = await client.callTool({ name: "list_health_checks", arguments: {} });
    expect(result.content).toEqual([
      { type: "text", text: expect.stringMatching(/^5 Health checks, 2 failing\./) },
    ]);
  });

  it("returns a Tool's text when the Client calls it", async () => {
    const { url } = await start(realTools());
    const client = await connect(url);

    const result = await client.callTool({ name: "list_containers", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: expect.stringMatching(/^5 Containers, 3 need attention\./) },
    ]);
  });

  it.each([
    ["no Token", {}],
    ["a wrong Token", { Authorization: `Bearer ${"x".repeat(token.length)}` }],
    ["a Token without the Bearer scheme", { Authorization: token }],
  ])("answers 401 and nothing else to a request with %s", async (_, headers) => {
    const { url } = await start(realTools());

    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("answers /healthz without a Token, revealing nothing", async () => {
    const { url } = await start(realTools());

    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("shows the Client a Source's own sentence when the Source fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { url } = await start([toolThatThrows(new SourceError("Docker didn't answer."))]);
    const client = await connect(url);

    const result = await client.callTool({ name: "broken_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Docker didn't answer." }]);
  });

  it("redacts every Tool's answer, so a Tool can't leak a Secret even if it tries", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const careless: Tool = {
      name: "careless_tool",
      description: "Returns a Secret.",
      inputSchema: {},
      handler: async () => "connected with DB_PASSWORD=hunter2",
    };
    const { url } = await start([careless]);
    const client = await connect(url);

    const result = await client.callTool({ name: "careless_tool", arguments: {} });
    expect(result.content).toEqual([
      { type: "text", text: "connected with DB_PASSWORD=[redacted]" },
    ]);
  });

  it("redacts error messages too", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const leaky = new SourceError("Docker refused Authorization: Bearer abcDEF123456789xyz.");
    const { url } = await start([toolThatThrows(leaky)]);
    const client = await connect(url);

    const result = await client.callTool({ name: "broken_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Docker refused Authorization: Bearer [redacted]" },
    ]);
  });

  it("shows the Client a Tool's refusal as its own sentence", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const refusal = new Refusal(
      "chat-bridge is a Private container, so its logs are never returned.",
    );
    const { url } = await start([toolThatThrows(refusal)]);
    const client = await connect(url);

    const result = await client.callTool({ name: "broken_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: refusal.message }]);
  });

  it("hides the details of an unexpected error from the Client and logs them, redacted", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const crash = new Error("internal detail from a command run with TOKEN=abc123secret");
    const { url } = await start([toolThatThrows(crash)]);
    const client = await connect(url);

    const result = await client.callTool({ name: "broken_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "broken_tool failed unexpectedly; the server log has the details." },
    ]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(
        /^broken_tool crashed after \d+ ms: Error: internal detail from a command run with TOKEN=\[redacted\]\n\s+at /,
      ),
    );
    expect(String(logged.mock.calls[0])).not.toContain("abc123secret");
  });

  it("offers read Tools with no hints, exactly as before admin mode existed", async () => {
    const { url } = await start(realTools());
    const client = await connect(url);

    const [tool] = (await client.listTools()).tools;
    expect(tool?.annotations).toBeUndefined();
  });

  it("keeps serving the other Tools after one fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failing = toolThatThrows(new SourceError("Docker didn't answer."));
    const { url } = await start([failing, ...realTools()]);
    const client = await connect(url);

    await client.callTool({ name: "broken_tool", arguments: {} });
    const result = await client.callTool({ name: "list_containers", arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it("logs each Tool call with its name, how long it took and whether it worked", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { url } = await start(realTools());
    const client = await connect(url);

    await client.callTool({ name: "list_containers", arguments: {} });
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^list_containers ok in \d+ ms$/));
  });

  it("logs the Container name for container_logs, and no other argument", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { url } = await start(realTools());
    const client = await connect(url);

    await client.callTool({ name: "container_logs", arguments: { name: "sync-worker", lines: 5 } });
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/^container_logs sync-worker ok in \d+ ms$/),
    );
  });

  it("answers an empty Tool list when admin mode has no Actions yet", async () => {
    const { url } = await start(allowlist([]));
    const client = await connect(url);

    expect((await client.listTools()).tools).toEqual([]);
  });

  it("tells the Client that an Action changes the Host, so it asks the person first", async () => {
    const { url } = await start(allowlist([fakeAction(async () => "started")]));
    const client = await connect(url);

    const [tool] = (await client.listTools()).tools;
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("logs each Action with its name, arguments, how long it took and its result, redacted", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = fakeAction(async () => "Started vpn-client.\nIt is running.");
    const { url } = await start(allowlist([action]));
    const client = await connect(url);

    await client.callTool({
      name: "start_container",
      arguments: { name: "vpn-client", note: "API_KEY=hunter2" },
    });
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(
        /^start_container \{"name":"vpn-client","note":"API_KEY=\[redacted\]"\} ok in \d+ ms: Started vpn-client\. \/ It is running\.$/,
      ),
    );
  });

  it("logs and redacts a failed Action's error", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const action = fakeAction(async () => {
      throw new Refusal("vpn-client won't start: TOKEN=abc123secret");
    });
    const { url } = await start(allowlist([action]));
    const client = await connect(url);

    const result = await client.callTool({
      name: "start_container",
      arguments: { name: "vpn-client" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "vpn-client won't start: TOKEN=[redacted]" },
    ]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(
        /^start_container \{"name":"vpn-client"\} failed in \d+ ms: vpn-client won't start: TOKEN=\[redacted\]$/,
      ),
    );
  });

  it("starts a stopped Container end to end, through Docker's own socket", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const started: string[] = [];
    const dockerOnSocket = await serveOnLocalSocket((request, response) => {
      if (request.method === "GET" && request.url === "/containers/json?all=true") {
        response.end(readFileSync(new URL("../fixtures/docker/containers.json", import.meta.url)));
      } else if (request.method === "POST" && request.url === "/containers/backup-job/start") {
        started.push("backup-job");
        response.statusCode = 204;
        response.end();
      } else {
        response.statusCode = 404;
        response.end('{"message":"page not found"}');
      }
    });
    fakeDocker = dockerOnSocket;
    const action = startContainer(dockerAdmin(socketFetch(dockerOnSocket.path), "http://docker"));
    const { url } = await start(allowlist([action]));
    const client = await connect(url);

    const result = await client.callTool({
      name: "start_container",
      arguments: { name: "backup-job" },
    });
    expect(result.content).toEqual([{ type: "text", text: "Started backup-job. It was exited." }]);
    expect(started).toEqual(["backup-job"]);
  });

  it("runs the Report through Redaction like every other answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const folder = mkdtempSync(join(tmpdir(), "report-"));
    try {
      const path = join(folder, "morning.txt");
      writeFileSync(path, "Backup ran with DB_PASSWORD=hunter2\n");
      const { url } = await start(realTools({ reportPath: path }));
      const client = await connect(url);

      const result = await client.callTool({ name: "read_report", arguments: {} });
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("Backup ran with DB_PASSWORD=[redacted]") },
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
