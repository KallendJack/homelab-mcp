import { closestNames } from "./closest-names.ts";
import { Refusal } from "./refusal.ts";
import type { ServiceContainer } from "./sources/docker.ts";

/** What admin mode needs from one Compose file's resolved model (`docker compose config --format json`). */
export type ComposeModel = {
  /** The Compose file, relative to the config repo. */
  file: string;
  /** Compose's project name, which labels every Container it creates. */
  project: string;
  services: Record<
    string,
    {
      network_mode?: string;
      depends_on?: Record<string, { condition?: string; restart?: boolean }>;
    }
  >;
};

/** What recreating a Service would do to one of its Containers. */
export type PlannedChange = {
  /** The Container's name, or undefined when there is none yet. */
  container: string | undefined;
  change: "create" | "recreate" | "leave alone";
};

/** The Compose file a Service is in. Refuses an unknown name, or one that's in more than one file. */
export function findService(models: ComposeModel[], name: string): ComposeModel {
  const matches = models.filter((model) => name in model.services);
  const [only] = matches;
  if (matches.length > 1) {
    const files = matches.map((model) => model.file).join(", ");
    throw new Refusal(
      `${name} is a Service in more than one Compose file (${files}), so it can't tell which is meant.`,
    );
  }
  if (only === undefined) {
    const all = models.flatMap((model) => Object.keys(model.services));
    const closest = closestNames(name, all);
    const suggestion = closest.length === 0 ? "" : ` Closest: ${closest.join(", ")}.`;
    throw new Refusal(`No Service is named "${name}".${suggestion}`);
  }
  return only;
}

/**
 * The other Services a recreate would disturb: ones sharing its network, which lose it when it's recreated, and
 * ones Compose restarts with it (`depends_on` with `restart: true`). A plain start-order dependency isn't one.
 */
export function dependentsOf(model: ComposeModel, name: string): string[] {
  return Object.entries(model.services)
    .filter(
      ([other, svc]) =>
        other !== name &&
        (svc.network_mode === `service:${name}` || svc.depends_on?.[name]?.restart === true),
    )
    .map(([other]) => other)
    .sort();
}

/** What a recreate would do, from each Container's config hash against the one Compose would use now. */
export function planFor(
  containers: Pick<ServiceContainer, "name" | "configHash">[],
  configHash: string,
): PlannedChange[] {
  if (containers.length === 0) return [{ container: undefined, change: "create" }];
  return containers.map(({ name, configHash: current }) => ({
    container: name,
    change: current === configHash ? "leave alone" : "recreate",
  }));
}
