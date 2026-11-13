import { describe, expect, it } from "vitest";
import { Refusal } from "./refusal.ts";
import { reloadProxy } from "./reload-proxy.ts";
import { dockerAdmin } from "./sources/docker.ts";
import { type FakeAnswer, fakeFetch } from "./testing/fake-fetch.ts";

const dockerUrl = "http://docker";
const proxy = { container: "proxy", command: ["proxy", "reload", "--config", "/etc/proxy/config"] };
const created = `${dockerUrl}/containers/proxy/exec`;
const started = `${dockerUrl}/exec/e1/start`;
const inspected = `${dockerUrl}/exec/e1/json`;

/** Docker's framed stream for a command without a terminal: stream 1 (stdout) or 2 (stderr), then the size. */
function framed(...chunks: [1 | 2, string][]): Uint8Array<ArrayBuffer> {
  const parts = chunks.map(([stream, text]) => {
    const body = new TextEncoder().encode(text);
    const header = new Uint8Array(8);
    header[0] = stream;
    new DataView(header.buffer).setUint32(4, body.length);
    return [header, body];
  });
  const all = parts.flat();
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of all) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function action(answers: Record<string, FakeAnswer>) {
  const fake = fakeFetch(answers);
  return { tool: reloadProxy(dockerAdmin(fake.fetch, dockerUrl), proxy), requests: fake.requests };
}

describe("reload_proxy", () => {
  it("runs the proxy's own reload command in its Container and says the new config was accepted", async () => {
    const { tool, requests } = action({
      [created]: { status: 201, body: '{"Id":"e1"}' },
      [started]: { body: framed([2, "INFO using config from file\n"]) },
      [inspected]: { body: '{"ExitCode":0,"Running":false}' },
    });
    expect(await tool.handler({})).toBe(
      "The proxy accepted its new config.\nINFO using config from file",
    );
    const create = requests.find((r) => r.url === created);
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["proxy", "reload", "--config", "/etc/proxy/config"],
    });
  });

  it("says the old config is still running when the proxy rejects the new one, and why", async () => {
    const { tool } = action({
      [created]: { status: 201, body: '{"Id":"e1"}' },
      [started]: {
        body: framed([1, "loading...\n"], [2, "Error: unrecognized directive: tls_typo\n"]),
      },
      [inspected]: { body: '{"ExitCode":1,"Running":false}' },
    });
    await expect(tool.handler({})).rejects.toThrow(
      new Refusal(
        "The proxy rejected its new config, so the old config is still running.\nloading...\n" +
          "Error: unrecognized directive: tls_typo",
      ),
    );
  });

  it("refuses when the proxy's Container doesn't exist", async () => {
    const { tool } = action({
      [created]: { status: 404, body: '{"message":"No such container: proxy"}' },
    });
    await expect(tool.handler({})).rejects.toThrow(
      new Refusal("There's no Container called proxy to reload."),
    );
  });

  it("refuses when the proxy's Container isn't running", async () => {
    const { tool } = action({
      [created]: { status: 409, body: '{"message":"container proxy is not running"}' },
    });
    await expect(tool.handler({})).rejects.toThrow(
      new Refusal("proxy isn't running, so there's no config to reload. Start it first."),
    );
  });

  it("takes no input: what runs is fixed by config, never by the Client", () => {
    const { tool } = action({});
    expect(tool.inputSchema).toEqual({});
  });
});
