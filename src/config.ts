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
};

/** A setting that stops the server at start. Its message names variables, never their values. */
export class ConfigError extends Error {}

const portError = "PORT must be a whole number from 1 to 65535";
const diskPathsError =
  "DISK_PATHS must be label=path pairs with absolute paths and different labels, separated by commas, such as data=/host/volume1";

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
  if (rest.length > 0 || label === "" || !path.startsWith("/")) return undefined;
  return { label, path };
}

const schema = z.object({
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
  DISK_PATHS: z
    .string()
    .default("root=/")
    .transform((value, context) => {
      const paths = commaList(value).map(diskPath);
      const labels = new Set(paths.map((p) => p?.label));
      if (paths.length === 0 || paths.includes(undefined) || labels.size !== paths.length) {
        context.addIssue({ code: "custom", message: diskPathsError });
        return z.NEVER;
      }
      return paths as DiskPath[];
    }),
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
  };
}
