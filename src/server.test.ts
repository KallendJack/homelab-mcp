import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Refusal } from "./refusal.ts";
import { type RunningServer, startServer } from "./server.ts";
import { docker } from "./sources/docker.ts";
import { SourceError } from "./sources/source-error.ts";
import { fakeFetch, fixture } from "./testing/fake-fetch.ts";
import { buildTools, type Tool } from "./tools.ts";

const token = "test-token-0123456789-0123456789-abcdef";
const dockerUrl = "http://proxy.example:2375";

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
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

function realTools(): Tool[] {
  const { fetch } = fakeFetch({
    [`${dockerUrl}/containers/json?all=true`]: fixture("docker/containers.json"),
    [`${dockerUrl}/containers/sync-worker/logs?stdout=1&stderr=1&timestamps=1&tail=5`]:
      fixture("docker/logs-plain.txt"),
  });
  return buildTools({ docker: docker(fetch, dockerUrl) }, { privateContainers: [] });
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

describe("the Server", () => {
  it("offers the Tools to a Client with the right Token", async () => {
    const { url } = await start(realTools());
    const client = await connect(url);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_containers", "container_logs"]);
    expect(tools[0]?.description).toMatch(/every Docker container/);
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

  it("hides the details of an unexpected error from the Client and logs them", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url } = await start([toolThatThrows(new Error("secret internal detail"))]);
    const client = await connect(url);

    const result = await client.callTool({ name: "broken_tool", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "broken_tool failed unexpectedly; the server log has the details." },
    ]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/^broken_tool crashed after \d+ ms$/),
      expect.objectContaining({ message: "secret internal detail" }),
    );
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
});
