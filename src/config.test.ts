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
    // Compose files often pass an empty value, as in GATUS_URL: ${GATUS_URL:-}.
    expect(loadConfig({ MCP_TOKEN: token, GATUS_URL: "" }).gatusUrl).toBeUndefined();
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

  it("turns Jellyfin on with both its URL and API key, and leaves it off with neither", () => {
    expect(loadConfig({ MCP_TOKEN: token }).jellyfin).toBeUndefined();
    expect(
      loadConfig({ MCP_TOKEN: token, JELLYFIN_URL: "", JELLYFIN_API_KEY: "" }).jellyfin,
    ).toBeUndefined();
    const config = loadConfig({
      MCP_TOKEN: token,
      JELLYFIN_URL: "http://media.example:8096",
      JELLYFIN_API_KEY: "test-api-key",
    });
    expect(config.jellyfin).toEqual({ url: "http://media.example:8096", apiKey: "test-api-key" });
    expect(sourcesOn(config)).toBe("Docker, Disk (root), Jellyfin");
  });

  it.each([
    [{ JELLYFIN_URL: "http://media.example:8096" }],
    [{ JELLYFIN_API_KEY: "secret-api-key-value" }],
  ])("refuses only one of the two Jellyfin settings, never echoing the key (%o)", (settings) => {
    const error = catchError(() => loadConfig({ MCP_TOKEN: token, ...settings }));
    expect(error.message).toBe(
      "JELLYFIN_URL and JELLYFIN_API_KEY must be set together, or neither",
    );
    expect(error.message).not.toContain("secret-api-key-value");
  });

  it("turns the Report on with REPORT_PATH, allowing 26 hours before it's stale unless told otherwise", () => {
    expect(loadConfig({ MCP_TOKEN: token }).report).toBeUndefined();
    expect(loadConfig({ MCP_TOKEN: token, REPORT_PATH: "" }).report).toBeUndefined();
    const config = loadConfig({ MCP_TOKEN: token, REPORT_PATH: "/reports/morning.txt" });
    expect(config.report).toEqual({ path: "/reports/morning.txt", maxAgeHours: 26 });
    expect(sourcesOn(config)).toBe("Docker, Disk (root), Report");
    expect(
      loadConfig({
        MCP_TOKEN: token,
        REPORT_PATH: "/reports/morning.txt",
        REPORT_MAX_AGE_HOURS: "48",
      }).report?.maxAgeHours,
    ).toBe(48);
  });

  it.each(["soon", "0", "-5", "0.5"])("refuses REPORT_MAX_AGE_HOURS=%s", (hours) => {
    const error = catchError(() =>
      loadConfig({
        MCP_TOKEN: token,
        REPORT_PATH: "/reports/morning.txt",
        REPORT_MAX_AGE_HOURS: hours,
      }),
    );
    expect(error.message).toBe("REPORT_MAX_AGE_HOURS must be a whole number of hours above 0");
  });

  it("refuses REPORT_MAX_AGE_HOURS without REPORT_PATH, rather than ignoring it", () => {
    const error = catchError(() => loadConfig({ MCP_TOKEN: token, REPORT_MAX_AGE_HOURS: "48" }));
    expect(error.message).toBe("REPORT_MAX_AGE_HOURS only applies with REPORT_PATH set");
  });

  it("refuses a REPORT_PATH that isn't absolute, without echoing it", () => {
    const error = catchError(() =>
      loadConfig({ MCP_TOKEN: token, REPORT_PATH: "reports/morning.txt" }),
    );
    expect(error.message).toBe("REPORT_PATH must be an absolute path");
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

  it("treats every empty setting as unset, as Compose passes for a variable left blank", () => {
    const empty = { PORT: "", DOCKER_URL: "", PRIVATE_CONTAINERS: "", DISK_PATHS: "" };
    expect(loadConfig({ MCP_TOKEN: token, ...empty })).toEqual(loadConfig({ MCP_TOKEN: token }));
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

describe("loadConfig in admin mode", () => {
  const adminToken = "a".repeat(32);
  const admin = {
    MCP_TOKEN: token,
    ADMIN_TOKEN: adminToken,
    ADMIN_REPO_PATH: "/host/stacks",
    ADMIN_DEPLOY_KEY_FILE: "/run/secrets/deploy-key",
    ADMIN_KNOWN_HOSTS_FILE: "/run/secrets/known-hosts",
    ADMIN_COMPOSE_FILES: "proxy/compose.yaml, media/compose.yml",
    ADMIN_SERVICE: "homelab-mcp-admin",
  };

  it("stays in read-only mode without ADMIN_TOKEN", () => {
    expect(loadConfig({ MCP_TOKEN: token }).admin).toBeUndefined();
    expect(loadConfig({ MCP_TOKEN: token, ADMIN_TOKEN: "" }).admin).toBeUndefined();
  });

  it("turns admin mode on with ADMIN_TOKEN and the config repo's details", () => {
    expect(loadConfig(admin).admin).toEqual({
      token: adminToken,
      repoPath: "/host/stacks",
      composeFiles: ["proxy/compose.yaml", "media/compose.yml"],
      service: "homelab-mcp-admin",
      dockerSocket: "/var/run/docker.sock",
      keyFile: "/run/secrets/deploy-key",
      knownHostsFile: "/run/secrets/known-hosts",
    });
  });

  it("reaches Docker through ADMIN_DOCKER_SOCKET when it's set", () => {
    const config = loadConfig({ ...admin, ADMIN_DOCKER_SOCKET: "/run/docker.sock" });
    expect(config.admin?.dockerSocket).toBe("/run/docker.sock");
  });

  it("refuses an ADMIN_DOCKER_SOCKET that isn't absolute, without echoing it", () => {
    const error = catchError(() => loadConfig({ ...admin, ADMIN_DOCKER_SOCKET: "docker.sock" }));
    expect(error.message).toBe("ADMIN_DOCKER_SOCKET must be an absolute path");
  });

  it("refuses a short admin Token, naming the variable but never its value", () => {
    const short = "short-admin-secret";
    const error = catchError(() => loadConfig({ ...admin, ADMIN_TOKEN: short }));
    expect(error.message).toBe("ADMIN_TOKEN must be at least 32 characters");
  });

  it("refuses the read-only Token as the admin Token, without echoing either", () => {
    const error = catchError(() => loadConfig({ ...admin, ADMIN_TOKEN: token }));
    expect(error.message).toBe("ADMIN_TOKEN must be different from MCP_TOKEN");
    expect(error.message).not.toContain(token);
  });

  it.each([
    "ADMIN_REPO_PATH",
    "ADMIN_COMPOSE_FILES",
    "ADMIN_SERVICE",
    "ADMIN_DEPLOY_KEY_FILE",
    "ADMIN_KNOWN_HOSTS_FILE",
  ])("refuses admin mode without %s", (name) => {
    const error = catchError(() => loadConfig({ ...admin, [name]: undefined }));
    expect(error.message).toBe(`${name} is required in admin mode`);
  });

  it("refuses an ADMIN_REPO_PATH that isn't absolute, without echoing it", () => {
    const error = catchError(() => loadConfig({ ...admin, ADMIN_REPO_PATH: "volume1/stacks" }));
    expect(error.message).toBe("ADMIN_REPO_PATH must be an absolute path");
  });

  it.each([
    "/host/stacks/proxy/compose.yaml",
    "../other/compose.yaml",
    "proxy/../../compose.yaml",
    "proxy/README.md",
    "proxy/composeyaml",
    "proxy/compose.yaml,proxy/compose.yaml",
    " , ",
  ])("refuses ADMIN_COMPOSE_FILES=%s, naming the variable but never its value", (value) => {
    const error = catchError(() => loadConfig({ ...admin, ADMIN_COMPOSE_FILES: value }));
    expect(error.message).toBe(
      "ADMIN_COMPOSE_FILES must be different .yaml or .yml paths inside the config repo, separated by commas, such as proxy/compose.yaml",
    );
  });

  it.each(["-admin", "homelab mcp", "admin;rm"])(
    "refuses an ADMIN_SERVICE name Compose couldn't have (%s)",
    (name) => {
      const error = catchError(() => loadConfig({ ...admin, ADMIN_SERVICE: name }));
      expect(error.message).toBe("ADMIN_SERVICE must be a Service name, such as homelab-mcp-admin");
    },
  );

  it("refuses admin settings without ADMIN_TOKEN, rather than ignoring them", () => {
    const error = catchError(() =>
      loadConfig({ MCP_TOKEN: token, ADMIN_REPO_PATH: "/host/stacks" }),
    );
    expect(error.message).toBe(
      "ADMIN_REPO_PATH, ADMIN_COMPOSE_FILES, ADMIN_SERVICE, ADMIN_DEPLOY_KEY_FILE, ADMIN_KNOWN_HOSTS_FILE and ADMIN_DOCKER_SOCKET only apply with ADMIN_TOKEN set",
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
