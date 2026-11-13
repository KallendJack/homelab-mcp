import { z } from "zod";
import type { DiskPath } from "./sources/disk.ts";
import { CONTAINER_NAME } from "./sources/docker.ts";

export type Config = {
  token: string;
  port: number;
  dockerUrl: string;
  /** Container names whose logs are never returned, matched exactly. */
  privateContainers: string[];
  /** Where disk_usage looks, in the order to report them. */
  diskPaths: DiskPath[];
  /** Gatus's base URL. Set, it turns on the Gatus Source and its Tool (ADR 0001). */
  gatusUrl?: string;
  /** Jellyfin's base URL and API key. Both set, they turn on the Jellyfin Source and its Tool. */
  jellyfin?: { url: string; apiKey: string };
  /** The Report file and how old it may be before it's a Stale report. Set, it turns on the Report Source. */
  report?: { path: string; maxAgeHours: number };
  /** Set, the server runs in admin mode: it offers the Allowlist instead of the read Tools. */
  admin?: AdminConfig;
};

export type AdminConfig = {
  /** The Token for admin mode, never the read-only one. */
  token: string;
  /** The config repo, mounted at the same path it has on the Host, since Compose resolves bind mounts there. */
  repoPath: string;
  /** The Compose files, relative to the config repo. */
  composeFiles: string[];
  /** The admin server's own Service, which it must never recreate. */
  service: string;
};

/** A setting that stops the server at start. Its message names variables, never their values. */
export class ConfigError extends Error {}

const portError = "PORT must be a whole number from 1 to 65535";
const reportAgeError = "REPORT_MAX_AGE_HOURS must be a whole number of hours above 0";
const DEFAULT_REPORT_MAX_AGE_HOURS = 26;
const diskPathsError =
  "DISK_PATHS must be label=path pairs separated by commas, such as data=/host/volume1. Each label is a different word of letters, digits, - _ or ., and each path is absolute, without = or ,";

const composeFilesError =
  "ADMIN_COMPOSE_FILES must be different .yaml or .yml paths inside the config repo, separated by commas, such as proxy/compose.yaml";
const ADMIN_DETAILS = ["ADMIN_REPO_PATH", "ADMIN_COMPOSE_FILES", "ADMIN_SERVICE"] as const;

/** Compose's rule for Service names, starting with a letter or digit so a name can't pass for a CLI option. */
export const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** "proxy/compose.yaml" is inside the repo; "/abs.yaml", "../x.yaml" and "a//b.yaml" aren't. */
function isComposeFile(path: string): boolean {
  const parts = path.split("/");
  return (
    /\.ya?ml$/.test(path) &&
    !path.includes("\\") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** A label is shown to the Client, so it's one plain word. */
const DISK_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/;

/** "a, b,,c" becomes ["a", "b", "c"]. */
function commaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** "data=/host/volume1" becomes { label: "data", path: "/host/volume1" }, or undefined if it isn't one. */
function diskPath(pair: string): DiskPath | undefined {
  const [label = "", path = "", ...rest] = pair.split("=").map((part) => part.trim());
  if (rest.length > 0 || !DISK_LABEL.test(label) || !path.startsWith("/")) return undefined;
  return { label, path };
}

const schema = z
  .object({
    MCP_TOKEN: z
      .string({ error: "MCP_TOKEN is required" })
      .min(32, { error: "MCP_TOKEN must be at least 32 characters" }),
    PORT: z.coerce
      .number({ error: portError })
      .int({ error: portError })
      .min(1, { error: portError })
      .max(65535, { error: portError })
      .default(8765),
    DOCKER_URL: z
      .url({ protocol: /^https?$/, error: "DOCKER_URL must be an http:// or https:// address" })
      .default("http://socket-proxy:2375"),
    PRIVATE_CONTAINERS: z
      .string()
      .default("")
      .transform(commaList)
      // Docker's own rule for names. A name it couldn't have would never match, leaving that Container unprotected.
      .refine((names) => names.every((name) => CONTAINER_NAME.test(name)), {
        error:
          "PRIVATE_CONTAINERS must be Container names separated by commas, such as chat-bridge,finance",
      }),
    GATUS_URL: z
      .url({ protocol: /^https?$/, error: "GATUS_URL must be an http:// or https:// address" })
      .optional(),
    JELLYFIN_URL: z
      .url({ protocol: /^https?$/, error: "JELLYFIN_URL must be an http:// or https:// address" })
      .optional(),
    JELLYFIN_API_KEY: z.string().optional(),
    REPORT_PATH: z
      .string()
      .refine((path) => path.startsWith("/"), { error: "REPORT_PATH must be an absolute path" })
      .optional(),
    REPORT_MAX_AGE_HOURS: z.coerce
      .number({ error: reportAgeError })
      .int({ error: reportAgeError })
      .positive({ error: reportAgeError })
      .optional(),
    DISK_PATHS: z
      .string()
      .default("root=/")
      .transform((value, context) => {
        const pairs = commaList(value);
        const paths = pairs.map(diskPath).filter((p): p is DiskPath => p !== undefined);
        const labels = new Set(paths.map((p) => p.label));
        if (paths.length === 0 || paths.length !== pairs.length || labels.size !== paths.length) {
          context.addIssue({ code: "custom", message: diskPathsError });
          return z.NEVER;
        }
        return paths;
      }),
    ADMIN_TOKEN: z
      .string()
      .min(32, { error: "ADMIN_TOKEN must be at least 32 characters" })
      .optional(),
    ADMIN_REPO_PATH: z
      .string()
      .refine((path) => path.startsWith("/"), { error: "ADMIN_REPO_PATH must be an absolute path" })
      .optional(),
    ADMIN_COMPOSE_FILES: z
      .string()
      .transform((value, context) => {
        const files = commaList(value);
        if (
          files.length === 0 ||
          !files.every(isComposeFile) ||
          new Set(files).size !== files.length
        ) {
          context.addIssue({ code: "custom", message: composeFilesError });
          return z.NEVER;
        }
        return files;
      })
      .optional(),
    ADMIN_SERVICE: z
      .string()
      .regex(SERVICE_NAME, {
        error: "ADMIN_SERVICE must be a Service name, such as homelab-mcp-admin",
      })
      .optional(),
  })
  .refine((env) => (env.JELLYFIN_URL === undefined) === (env.JELLYFIN_API_KEY === undefined), {
    error: "JELLYFIN_URL and JELLYFIN_API_KEY must be set together, or neither",
  })
  // A half-set pair stops the server, as a max age with nothing to apply it to would otherwise be ignored.
  .refine((env) => env.REPORT_MAX_AGE_HOURS === undefined || env.REPORT_PATH !== undefined, {
    error: "REPORT_MAX_AGE_HOURS only applies with REPORT_PATH set",
  })
  .superRefine((env, context) => {
    if (env.ADMIN_TOKEN === undefined) {
      // Admin details without the Token that turns admin mode on are a mistake, not a choice.
      if (ADMIN_DETAILS.some((name) => env[name] !== undefined)) {
        context.addIssue({
          code: "custom",
          message:
            "ADMIN_REPO_PATH, ADMIN_COMPOSE_FILES and ADMIN_SERVICE only apply with ADMIN_TOKEN set",
        });
      }
      return;
    }
    // One Token for both would let any read-only Client perform Actions.
    if (env.ADMIN_TOKEN === env.MCP_TOKEN) {
      context.addIssue({ code: "custom", message: "ADMIN_TOKEN must be different from MCP_TOKEN" });
    }
    for (const name of ADMIN_DETAILS) {
      if (env[name] === undefined) {
        context.addIssue({ code: "custom", message: `${name} is required in admin mode` });
      }
    }
  });

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Empty counts as unset, so defaults apply: Compose files often pass NAME: ${NAME:-}.
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = schema.safeParse(set);
  if (!result.success) {
    // One message per problem: a value can fail several checks with the same message.
    const messages = new Set(result.error.issues.map((issue) => issue.message));
    throw new ConfigError([...messages].join("; "));
  }
  const parsed = result.data;
  return {
    token: parsed.MCP_TOKEN,
    port: parsed.PORT,
    dockerUrl: parsed.DOCKER_URL,
    privateContainers: parsed.PRIVATE_CONTAINERS,
    diskPaths: parsed.DISK_PATHS,
    ...(parsed.GATUS_URL ? { gatusUrl: parsed.GATUS_URL } : {}),
    ...(parsed.JELLYFIN_URL && parsed.JELLYFIN_API_KEY
      ? { jellyfin: { url: parsed.JELLYFIN_URL, apiKey: parsed.JELLYFIN_API_KEY } }
      : {}),
    ...(parsed.REPORT_PATH
      ? {
          report: {
            path: parsed.REPORT_PATH,
            maxAgeHours: parsed.REPORT_MAX_AGE_HOURS ?? DEFAULT_REPORT_MAX_AGE_HOURS,
          },
        }
      : {}),
    ...(parsed.ADMIN_TOKEN &&
    parsed.ADMIN_REPO_PATH &&
    parsed.ADMIN_COMPOSE_FILES &&
    parsed.ADMIN_SERVICE
      ? {
          admin: {
            token: parsed.ADMIN_TOKEN,
            repoPath: parsed.ADMIN_REPO_PATH,
            composeFiles: parsed.ADMIN_COMPOSE_FILES,
            service: parsed.ADMIN_SERVICE,
          },
        }
      : {}),
  };
}

/** The Sources that are on, for the start-up log: names and disk labels only, never an address. */
export function sourcesOn(config: Config): string {
  const labels = config.diskPaths.map((p) => p.label).join(", ");
  return [
    "Docker",
    `Disk (${labels})`,
    ...(config.gatusUrl ? ["Gatus"] : []),
    ...(config.jellyfin ? ["Jellyfin"] : []),
    ...(config.report ? ["Report"] : []),
  ].join(", ");
}
