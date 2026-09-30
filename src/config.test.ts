import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const token = "t".repeat(32);

describe("loadConfig", () => {
  it("uses the defaults when only the Token is set", () => {
    expect(loadConfig({ MCP_TOKEN: token })).toEqual({
      token,
      port: 8765,
      dockerUrl: "http://socket-proxy:2375",
      privateContainers: [],
    });
  });

  it("reads Private containers as a comma-separated list, ignoring spaces and empty entries", () => {
    const config = loadConfig({ MCP_TOKEN: token, PRIVATE_CONTAINERS: " chat-bridge, finance ,," });
    expect(config.privateContainers).toEqual(["chat-bridge", "finance"]);
  });

  it.each(["/chat-bridge", "chat bridge", "finance;rm"])(
    "refuses a Private container name Docker couldn't have (%s), so none is silently unprotected",
    (name) => {
      const error = catchError(() => loadConfig({ MCP_TOKEN: token, PRIVATE_CONTAINERS: name }));
      expect(error.message).toBe(
        "PRIVATE_CONTAINERS must be Container names separated by commas, such as chat-bridge,finance",
      );
    },
  );

  it("refuses to start without a Token", () => {
    expect(() => loadConfig({})).toThrow(/MCP_TOKEN/);
  });

  it("refuses a short Token, naming the variable but never its value", () => {
    const short = "short-secret-value";
    const error = catchError(() => loadConfig({ MCP_TOKEN: short }));
    expect(error.message).toMatch(/MCP_TOKEN/);
    expect(error.message).toMatch(/32 characters/);
    expect(error.message).not.toContain(short);
  });

  it.each(["abc", "0", "70000", "80.5"])("refuses PORT=%s", (port) => {
    expect(() => loadConfig({ MCP_TOKEN: token, PORT: port })).toThrow(
      "PORT must be a whole number from 1 to 65535",
    );
  });

  it("refuses a DOCKER_URL that isn't an http address, without echoing it", () => {
    const error = catchError(() =>
      loadConfig({ MCP_TOKEN: token, DOCKER_URL: "socket-proxy:2375" }),
    );
    expect(error.message).toBe("DOCKER_URL must be an http:// or https:// address");
  });

  it("reports every problem at once", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(
      "MCP_TOKEN is required; PORT must be a whole number from 1 to 65535",
    );
  });
});

function catchError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected an error");
}
