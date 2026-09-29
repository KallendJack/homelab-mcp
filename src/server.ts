import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import { SourceError } from "./sources/source-error.ts";
import type { Tool } from "./tools.ts";

export type RunningServer = {
  /** Where the server listens, such as http://127.0.0.1:8765. */
  url: string;
  close(): Promise<void>;
};

/** Serves the Tools over MCP to Clients that send the Token (ADR 0003). */
export async function startServer(
  options: Pick<Config, "token" | "port">,
  tools: Tool[],
): Promise<RunningServer> {
  const expected = digest(`Bearer ${options.token}`);

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
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) {
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

  await new Promise<void>((resolve) => http.listen(options.port, resolve));
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

function mcpServer(tools: Tool[]): McpServer {
  const mcp = new McpServer({ name: "homelab-mcp", version: packageJson.version });
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        const started = performance.now();
        const took = () => `${Math.round(performance.now() - started)} ms`;
        try {
          const text = await tool.handler(args);
          console.log(`${tool.name} ok in ${took()}`);
          return { content: [{ type: "text", text }] };
        } catch (error) {
          if (error instanceof SourceError) {
            console.log(`${tool.name} failed in ${took()}: ${error.message}`);
            return { content: [{ type: "text", text: error.message }], isError: true };
          }
          // Anything else is a bug: its details stay in the server log.
          console.error(`${tool.name} crashed after ${took()}`, error);
          const text = `${tool.name} failed unexpectedly; the server log has the details.`;
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    );
  }
  return mcp;
}
