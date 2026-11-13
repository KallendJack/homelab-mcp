import { z } from "zod";
import type { Action } from "./allowlist.ts";
import { SERVICE_NAME } from "./config.ts";
import { Refusal } from "./refusal.ts";
import { type ComposeModel, dependentsOf, findService, planFor } from "./service-plan.ts";
import type { Compose } from "./sources/compose.ts";
import type { DockerAdmin } from "./sources/docker.ts";

export type RecreateSettings = {
  compose: Compose;
  docker: DockerAdmin;
  /** The Compose files, relative to the config repo, that hold the Services an Action may touch. */
  composeFiles: string[];
  /** The admin server's own Service, which it never recreates. */
  ownService: string;
};

const input = z.object({
  service: z.string().regex(SERVICE_NAME).describe("The Service's name, as in its Compose file"),
});

/** Five minutes: pulling an image and waiting for a healthcheck can take a while on a small Host. */
const RECREATE_TIME_LIMIT_SECONDS = 300;

/** A dry run: what recreating one Service would do, without doing it. */
export function previewService(settings: RecreateSettings): Action {
  return {
    name: "preview_service",
    description:
      "Shows what recreating one Service on the homelab host would do, without doing it: for each of its " +
      "containers whether it would be created, recreated or left alone, which other Services it would disturb, " +
      "and Compose's own dry run. Use it before recreate_service, and after pull_config names a changed Service.",
    inputSchema: input.shape,
    async handler(args) {
      const { service } = input.parse(args);
      const model = findService(await models(settings), service);
      const [containers, hash] = await Promise.all([
        settings.docker.serviceContainers(model.project, service),
        settings.compose.hash(model.file, service),
      ]);
      const plan = planFor(containers, hash).map(
        ({ container, change }) => `- ${container ?? "(new container)"}: ${change}`,
      );
      const dryRun = await settings.compose.dryRun(model.file, service);
      return [
        `${service} (${model.file}):`,
        ...plan,
        disturbance(model, service),
        "Compose's dry run:",
        dryRun || "(Compose printed nothing)",
      ].join("\n");
    },
  };
}

/** Pulls one Service's image and recreates only that Service, after refusing anything that would disturb others. */
export function recreateService(settings: RecreateSettings): Action {
  return {
    name: "recreate_service",
    description:
      "Pulls one Service's image and recreates only that Service on the homelab host, then waits up to two " +
      "minutes for it to be running, and healthy if it has a healthcheck. Never touches its dependencies. Refuses " +
      "a Service that others share a network with or restart with, and this server's own Service. Run " +
      "preview_service first to see what it would do.",
    inputSchema: input.shape,
    timeLimitSeconds: RECREATE_TIME_LIMIT_SECONDS,
    async handler(args) {
      const { service } = input.parse(args);
      // Checked before asking Compose anything: recreating itself would kill the request doing it.
      if (service === settings.ownService) {
        throw new Refusal(
          `${service} is this server's own Service, and recreating it would stop the request doing it. ` +
            "Recreate it from the Host instead.",
        );
      }
      const model = findService(await models(settings), service);
      const others = dependentsOf(model, service);
      if (others.length > 0) {
        throw new Refusal(
          `Recreating ${service} would also disturb ${others.join(", ")}, which share its network or restart ` +
            "with it. Do it from the Host, with those in mind.",
        );
      }

      await settings.compose.pull(model.file, service);
      await settings.compose.up(model.file, service);
      const after = await settings.docker.serviceContainers(model.project, service);
      return [
        `Recreated ${service} (${model.file}).`,
        ...after.map((c) => `- ${c.name}: ${c.status}`),
      ].join("\n");
    },
  };
}

function models(settings: RecreateSettings): Promise<ComposeModel[]> {
  return Promise.all(settings.composeFiles.map((file) => settings.compose.model(file)));
}

function disturbance(model: ComposeModel, service: string): string {
  const others = dependentsOf(model, service);
  if (others.length === 0) return "Nothing else would be disturbed.";
  return (
    `It would disturb ${others.join(", ")}, which share its network or restart with it, so ` +
    "recreate_service refuses it."
  );
}
