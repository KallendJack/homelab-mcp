import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ComposeModel } from "../service-plan.ts";
import { SourceError, safeErrorCode } from "./source-error.ts";

const execFileAsync = promisify(execFile);

export type ComposeSettings = {
  /** The command that runs Compose: `docker compose` on the Host, a fake in tests. */
  command: string[];
  /** The config repo, at the same path the Host has, since Compose resolves bind mounts there. */
  repoPath: string;
  /** Docker's own socket, which Compose reaches through DOCKER_HOST. */
  dockerSocket: string;
};

export type Compose = {
  /** A Compose file's project and Services, from its resolved model. Nothing else, Secrets included, leaves here. */
  model(file: string): Promise<ComposeModel>;
  /** The config hash Compose would stamp on a new Container of the Service now. */
  hash(file: string, service: string): Promise<string>;
  /** What Compose says recreating the Service would do, in its own words, for a person to read. */
  dryRun(file: string, service: string): Promise<string>;
  pull(file: string, service: string): Promise<void>;
  /** Recreates and starts only the Service, if anything changed, then waits up to two minutes for it. */
  up(file: string, service: string): Promise<void>;
};

const dependency = z.object({ condition: z.string().optional(), restart: z.boolean().optional() });
const resolvedModel = z.object({
  name: z.string(),
  services: z.record(
    z.string(),
    z.object({
      network_mode: z.string().optional(),
      depends_on: z.record(z.string(), dependency).optional(),
    }),
  ),
});

/** Runs Compose against one Compose file at a time, through Docker's own socket. */
export function compose(settings: ComposeSettings): Compose {
  const [program = "docker", ...baseArgs] = settings.command;

  /** Compose's stdout and stderr, kept apart: it writes warnings to stderr even when it succeeds. */
  async function run(
    file: string,
    args: string[],
    doing: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const path = posix.join(settings.repoPath, file);
    try {
      return await execFileAsync(program, [...baseArgs, "-f", path, ...args], {
        env: { ...process.env, DOCKER_HOST: `unix://${settings.dockerSocket}` },
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const output = (error as { stderr?: string }).stderr ?? "";
      const lastLine = output.trim().split("\n").at(-1)?.trim();
      if (lastLine) throw new SourceError(`Compose couldn't ${doing}: ${lastLine}`);
      const code = safeErrorCode(error);
      throw new SourceError(`Couldn't run Compose to ${doing}${code ? ` (${code})` : ""}.`);
    }
  }

  return {
    async model(file) {
      const { stdout: text } = await run(file, ["config", "--format", "json"], `read ${file}`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const parsed = resolvedModel.safeParse(body);
      if (!parsed.success) {
        throw new SourceError(`Compose answered with something unexpected for ${file}.`);
      }
      // Only these fields are kept: the full model holds every Service's environment, Secrets included.
      const services = Object.fromEntries(
        Object.entries(parsed.data.services).map(([name, svc]) => [name, pickPlanFields(svc)]),
      );
      return { file, project: parsed.data.name, services };
    },

    async hash(file, service) {
      const args = ["config", "--hash", service];
      const { stdout: text } = await run(file, args, `read ${service}'s config`);
      // "service hash", one per line.
      const line = text.split("\n").find((l) => l.startsWith(`${service} `));
      const hash = line?.trim().split(/\s+/)[1];
      if (hash === undefined) {
        throw new SourceError(
          `Compose answered with something unexpected for ${service}'s config.`,
        );
      }
      return hash;
    },

    async dryRun(file, service) {
      const args = ["--dry-run", "up", "-d", "--no-deps", service];
      const { stdout, stderr } = await run(file, args, `preview ${service}`);
      // Compose reports its progress on stderr.
      return `${stdout}${stderr}`.trim();
    },

    async pull(file, service) {
      await run(file, ["pull", service], `pull ${service}`);
    },

    async up(file, service) {
      const args = ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", service];
      await run(file, args, `recreate ${service}`);
    },
  };
}

type PlanFields = ComposeModel["services"][string];

function pickPlanFields(svc: z.infer<typeof resolvedModel>["services"][string]): PlanFields {
  const fields: PlanFields = {};
  if (svc.network_mode !== undefined) fields.network_mode = svc.network_mode;
  if (svc.depends_on !== undefined) {
    fields.depends_on = Object.fromEntries(
      Object.entries(svc.depends_on).map(([name, dep]) => [
        name,
        {
          ...(dep.condition !== undefined ? { condition: dep.condition } : {}),
          ...(dep.restart !== undefined ? { restart: dep.restart } : {}),
        },
      ]),
    );
  }
  return fields;
}
