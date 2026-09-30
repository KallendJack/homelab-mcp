import { type Config, ConfigError, loadConfig, sourcesOn } from "./config.ts";
import { startServer } from "./server.ts";
import { disk } from "./sources/disk.ts";
import { docker } from "./sources/docker.ts";
import { gatus } from "./sources/gatus.ts";
import { jellyfin } from "./sources/jellyfin.ts";
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

const config = configOrExit();
const sources = {
  docker: docker(fetch, config.dockerUrl),
  disk: disk(config.diskPaths),
  ...(config.gatusUrl ? { gatus: gatus(fetch, config.gatusUrl) } : {}),
  ...(config.jellyfin
    ? { jellyfin: jellyfin(fetch, config.jellyfin.url, config.jellyfin.apiKey, () => new Date()) }
    : {}),
};
const tools = buildTools(sources, { privateContainers: config.privateContainers });
const server = await startServer(config, tools);
const privateList = config.privateContainers.join(", ") || "none";
console.log(
  `homelab-mcp listening on port ${config.port}. Sources on: ${sourcesOn(config)}. Private containers: ${privateList}.`,
);

// Docker sends SIGTERM to stop a container: finish cleanly rather than being killed.
process.on("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});
