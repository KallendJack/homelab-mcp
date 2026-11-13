import { adminStartUp, allowlist } from "./allowlist.ts";
import { type AdminConfig, type Config, ConfigError, loadConfig, sourcesOn } from "./config.ts";
import { pullConfig } from "./pull-config.ts";
import { previewService, recreateService } from "./recreate-service.ts";
import { reloadProxy } from "./reload-proxy.ts";
import { type RunningServer, startServer } from "./server.ts";
import { compose } from "./sources/compose.ts";
import { disk } from "./sources/disk.ts";
import { docker, dockerAdmin } from "./sources/docker.ts";
import { gatus } from "./sources/gatus.ts";
import { jellyfin } from "./sources/jellyfin.ts";
import { ntfy } from "./sources/ntfy.ts";
import { report } from "./sources/report.ts";
import { socketFetch } from "./sources/socket-fetch.ts";
import { startContainer } from "./start-container.ts";
import { buildTools } from "./tools.ts";

function configOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`homelab-mcp can't start: ${error.message}`);
    process.exit(1);
  }
}

/** The everyday server: the read Tools, through the read-only socket proxy. */
async function startReadOnly(config: Config): Promise<RunningServer> {
  const sources = {
    docker: docker(fetch, config.dockerUrl),
    disk: disk(config.diskPaths),
    ...(config.gatusUrl ? { gatus: gatus(fetch, config.gatusUrl) } : {}),
    ...(config.jellyfin
      ? { jellyfin: jellyfin(fetch, config.jellyfin.url, config.jellyfin.apiKey, () => new Date()) }
      : {}),
    ...(config.report
      ? { report: report(config.report.path, config.report.maxAgeHours, () => new Date()) }
      : {}),
  };
  const tools = buildTools(sources, { privateContainers: config.privateContainers });
  const server = await startServer(config, tools);
  const privateList = config.privateContainers.join(", ") || "none";
  console.log(
    `homelab-mcp listening on port ${config.port}. Sources on: ${sourcesOn(config)}. Private containers: ${privateList}.`,
  );
  return server;
}

/** The admin server: only the Allowlist, behind its own Token, and never a read Tool. */
async function startAdmin(admin: AdminConfig, port: number): Promise<RunningServer> {
  // The host in this URL is a placeholder: socketFetch sends every request to Docker's own socket.
  const host = dockerAdmin(socketFetch(admin.dockerSocket), "http://docker");
  const services = {
    compose: compose({
      command: ["docker", "compose"],
      repoPath: admin.repoPath,
      dockerSocket: admin.dockerSocket,
    }),
    docker: host,
    composeFiles: admin.composeFiles,
    ownService: admin.service,
  };
  const notifier = admin.notifications
    ? ntfy(fetch, admin.notifications.url, admin.notifications.topic)
    : undefined;
  const tools = allowlist(
    [
      pullConfig(admin),
      previewService(services),
      recreateService(services),
      startContainer(host),
      // Offered only when configured, as an optional Source's Tool is.
      ...(admin.proxy ? [reloadProxy(host, admin.proxy)] : []),
    ],
    notifier ? { notifier } : {},
  );
  const server = await startServer({ token: admin.token, port }, tools);
  const startUp = adminStartUp(admin.repoPath, tools, notifier !== undefined);
  console.log(`homelab-mcp admin mode listening on port ${port}. ${startUp}`);
  return server;
}

const config = configOrExit();
const server = config.admin
  ? await startAdmin(config.admin, config.port)
  : await startReadOnly(config);

// Docker sends SIGTERM to stop a container: finish cleanly rather than being killed.
process.on("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});
