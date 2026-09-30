import { describe, expect, it } from "vitest";
import { loadConfig, sourcesOn } from "./config.ts";

const token = "t".repeat(32);

describe("loadConfig", () => {
  it("uses the defaults when only the Token is set", () => {
    expect(loadConfig({ MCP_TOKEN: token })).toEqual({
      token,
      port: 8765,
      dockerUrl: "http://socket-proxy:2375",
      privateContainers: [],
      diskPaths: [{ label: "root", path: "/" }],
    });
  });

  it("leaves Gatus off unless GATUS_URL is set", () => {
    expect(loadConfig({ MCP_TOKEN: token }).gatusUrl).toBeUndefined();
    expect(loadConfig({ MCP_TOKEN: token, GATUS_URL: "http://gatus:8080" }).gatusUrl).toBe(
      "http://gatus:8080",
    );
  });

  it("names the Sources that are on, for the start-up log, without any address", () => {
    expect(sourcesOn(loadConfig({ MCP_TOKEN: token }))).toBe("Docker, Disk (root)");
    const withGatus = loadConfig({
      MCP_TOKEN: token,
      DISK_PATHS: "data=/host/volume1,root=/",
      GATUS_URL: "http://gatus:8080",
    });
    expect(sourcesOn(withGatus)).toBe("Docker, Disk (data, root), Gatus");
  });

  it("refuses a GATUS_URL that isn't an http address, without echoing it", () => {
    const error = catchError(() => loadConfig({ MCP_TOKEN: token, GATUS_URL: "gatus:8080" }));
    expect(error.message).toBe("GATUS_URL must be an http:// or https:// address");
  });

  it("reads DISK_PATHS as label=path pairs, in order, ignoring spaces", () => {
    const config = loadConfig({ MCP_TOKEN: token, DISK_PATHS: "data=/host/volume1, root=/" });
    expect(config.diskPaths).toEqual([
      { label: "data", path: "/host/volume1" },
      { label: "root", path: "/" },
    ]);
  });

  it.each([
    "/host/volume1",
    "data=",
    "=/host/volume1",
    "data=host/volume1",
    "data=/a,data=/b",
    " , ",
  ])("refuses DISK_PATHS=%s, naming the variable but never its value", (value) => {
    const error = catchError(() => loadConfig({ MCP_TOKEN: token, DISK_PATHS: value }));
    expect(error.message).toBe(
      "DISK_PATHS must be label=path pairs separated by commas, such as data=/host/volume1. Each label is a different word of letters, digits, - _ or ., and each path is absolute, without = or ,",
    );
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
