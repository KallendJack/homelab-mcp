import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { redact } from "./redaction.ts";
import { Refusal } from "./refusal.ts";
import { SourceError } from "./sources/source-error.ts";
import type { Tool } from "./tools.ts";

export type RunningServer = {
  /** Where the server listens, such as http://127.0.0.1:8765. */
  url: string;
  close(): Promise<void>;
};

/** Serves the Tools over MCP to Clients that send the Token (ADR 0003). */
export async function startServer(
  config: Pick<Config, "token" | "port">,
  tools: Tool[],
): Promise<RunningServer> {
  const expectedDigest = digest(`Bearer ${config.token}`);

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("request failed", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    // Compare fixed-length digests so the check takes the same time whatever was sent.
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expectedDigest)) {
      response.writeHead(401).end();
      return;
    }

    // Stateless: a fresh MCP server and transport for each request, since Tools keep no state.
    // Leaving out `sessionIdGenerator` is what puts the transport in stateless mode.
    const mcp = mcpServer(tools);
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    // The SDK's transport types predate exactOptionalPropertyTypes; the object is a valid Transport.
    await mcp.connect(transport as Transport);
    await transport.handleRequest(request, response);
  }

  await new Promise<void>((resolve) => http.listen(config.port, resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        // Clients keep connections open between requests; without this, close() waits for them.
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The one way a Tool's text leaves the server: always through Redaction, answers and errors alike. */
function reply(text: string, options: { isError?: true } = {}) {
  return { content: [{ type: "text" as const, text: redact(text) }], ...options };
}

/** An Action carries the hints a Client reads to decide whether to ask the person first; a read Tool carries none. */
function annotations(tool: Tool) {
  return tool.changesHost ? { annotations: { readOnlyHint: false, destructiveHint: true } } : {};
}

/** An error's message and stack, redacted, since a failed command's error can quote its environment. */
function crashDetails(error: unknown): string {
  return redact(error instanceof Error ? (error.stack ?? String(error)) : String(error));
}

function mcpServer(tools: Tool[]): McpServer {
  const mcp = new McpServer({ name: "homelab-mcp", version: packageJson.version });
  if (tools.length === 0) {
    // The SDK answers tools/list only once a Tool is registered; admin mode with no Actions still answers it.
    mcp.server.registerCapabilities({ tools: {} });
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  }
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, ...annotations(tool) },
      async (args) => {
        const started = performance.now();
        const took = () => `${Math.round(performance.now() - started)} ms`;
        const call = tool.logArguments
          ? `${tool.name} ${redact(tool.logArguments(args))}`
          : tool.name;
        try {
          const text = await tool.handler(args);
          // An Action's answer is the record of what it did, kept on one log line. A read Tool's is too
          // long, and too private, to log.
          const result = tool.changesHost ? `: ${redact(text).split("\n").join(" / ")}` : "";
          console.log(`${call} ok in ${took()}${result}`);
          return reply(text);
        } catch (error) {
          // A Source failing or a Tool refusing has a sentence written for the Client.
          if (error instanceof SourceError || error instanceof Refusal) {
            console.log(`${call} failed in ${took()}: ${redact(error.message)}`);
            return reply(error.message, { isError: true });
          }
          // Anything else is a bug: its details stay in the server log.
          console.error(`${call} crashed after ${took()}: ${crashDetails(error)}`);
          return reply(`${tool.name} failed unexpectedly; the server log has the details.`, {
            isError: true,
          });
        }
      },
    );
  }
  return mcp;
}
