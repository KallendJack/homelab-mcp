import { z } from "zod";
import type { Action } from "./allowlist.ts";
import { closestNames } from "./closest-names.ts";
import { Refusal } from "./refusal.ts";
import { CONTAINER_NAME, type DockerAdmin } from "./sources/docker.ts";

const input = z.object({
  name: z
    .string()
    .regex(CONTAINER_NAME)
    .describe("The exact name of the stopped Container to start"),
});

/**
 * Starts one stopped Container, such as a VPN client Docker gave up on after a reboot. It checks the Container
 * exists and is stopped before asking Docker, so a mistyped or running one is refused without touching the Host.
 */
export function startContainer(docker: DockerAdmin): Action {
  return {
    name: "start_container",
    description:
      "Starts one stopped Docker container on the homelab host, such as one that didn't come back after a reboot. " +
      "Refuses a container that is already running or doesn't exist. It only starts the container as it is; to " +
      "apply a changed config, recreate its Service instead.",
    inputSchema: input.shape,
    async handler(args) {
      const { name } = input.parse(args);
      const containers = await docker.containers();
      const container = containers.find((c) => c.name === name);
      if (container === undefined) {
        const closest = closestNames(
          name,
          containers.map((c) => c.name),
        );
        const suggestion = closest.length === 0 ? "" : ` Closest: ${closest.join(", ")}.`;
        throw new Refusal(`No Container is named "${name}".${suggestion}`);
      }
      if (container.state === "running") throw alreadyRunning(name);

      const result = await docker.start(name);
      if (result === "already running") throw alreadyRunning(name);
      if (result === "no such container") throw new Refusal(`${name} no longer exists.`);
      return `Started ${name}. It was ${container.state}.`;
    },
  };
}

function alreadyRunning(name: string): Refusal {
  return new Refusal(`${name} is already running, so there's nothing to start.`);
}
