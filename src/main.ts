import { type Config, ConfigError, loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { docker } from "./sources/docker.ts";
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
const tools = buildTools(
  { docker: docker(fetch, config.dockerUrl) },
  { privateContainers: config.privateContainers },
);
const server = await startServer(config, tools);
console.log(`homelab-mcp listening on port ${config.port}. Sources on: Docker.`);

// Docker sends SIGTERM to stop a container: finish cleanly rather than being killed.
process.on("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});
