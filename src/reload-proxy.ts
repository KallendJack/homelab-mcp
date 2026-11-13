import type { Action } from "./allowlist.ts";
import { Refusal } from "./refusal.ts";
import type { DockerAdmin } from "./sources/docker.ts";

export type ProxySettings = {
  /** The reverse proxy's Container. */
  container: string;
  /** Its own reload command, as separate words. Set by config, never by the Client. */
  command: string[];
};

/**
 * Reloads the reverse proxy's config, which it doesn't do by itself after a pull. It runs the proxy's own reload
 * command, which keeps the old config running if the new one is rejected.
 */
export function reloadProxy(docker: DockerAdmin, proxy: ProxySettings): Action {
  return {
    name: "reload_proxy",
    description:
      "Reloads the homelab's reverse proxy so it uses its config as it is now, after pull_config changed it. " +
      "Says whether the proxy accepted the new config; if it rejected it, the old config keeps running and the " +
      "answer says why. Takes no input: the command it runs is fixed by the server's config.",
    inputSchema: {},
    async handler() {
      const result = await docker.exec(proxy.container, proxy.command);
      if (!result.ran) {
        if (result.reason === "no such container") {
          throw new Refusal(`There's no Container called ${proxy.container} to reload.`);
        }
        throw new Refusal(
          `${proxy.container} isn't running, so there's no config to reload. Start it first.`,
        );
      }
      const output = result.output ? `\n${result.output}` : "";
      if (result.exitCode !== 0) {
        throw new Refusal(
          `The proxy rejected its new config, so the old config is still running.${output}`,
        );
      }
      return `The proxy accepted its new config.${output}`;
    },
  };
}
