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
};

/** A setting that stops the server at start. Its message names variables, never their values. */
export class ConfigError extends Error {}

const portError = "PORT must be a whole number from 1 to 65535";
const reportAgeError = "REPORT_MAX_AGE_HOURS must be a whole number of hours above 0";
const DEFAULT_REPORT_MAX_AGE_HOURS = 26;
const diskPathsError =
  "DISK_PATHS must be label=path pairs separated by commas, such as data=/host/volume1. Each label is a different word of letters, digits, - _ or ., and each path is absolute, without = or ,";

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

/** An optional setting, where empty counts as unset: compose files often pass NAME: ${NAME:-}. */
function optional<T extends z.ZodType>(setting: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), setting.optional());
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
    GATUS_URL: optional(
      z.url({ protocol: /^https?$/, error: "GATUS_URL must be an http:// or https:// address" }),
    ),
    JELLYFIN_URL: optional(
      z.url({ protocol: /^https?$/, error: "JELLYFIN_URL must be an http:// or https:// address" }),
    ),
    JELLYFIN_API_KEY: optional(z.string()),
    REPORT_PATH: optional(
      z
        .string()
        .refine((path) => path.startsWith("/"), { error: "REPORT_PATH must be an absolute path" }),
    ),
    REPORT_MAX_AGE_HOURS: optional(
      z.coerce
        .number({ error: reportAgeError })
        .int({ error: reportAgeError })
        .positive({ error: reportAgeError }),
    ),
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
  })
  .refine((env) => (env.JELLYFIN_URL === undefined) === (env.JELLYFIN_API_KEY === undefined), {
    error: "JELLYFIN_URL and JELLYFIN_API_KEY must be set together, or neither",
  })
  // A half-set pair stops the server, as a max age with nothing to apply it to would otherwise be ignored.
  .refine((env) => env.REPORT_MAX_AGE_HOURS === undefined || env.REPORT_PATH !== undefined, {
    error: "REPORT_MAX_AGE_HOURS only applies with REPORT_PATH set",
  });

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
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
