import { z } from "zod";

export type Config = {
  token: string;
  port: number;
  dockerUrl: string;
  /** Container names whose logs are never returned, matched exactly. */
  privateContainers: string[];
};

/** A setting that stops the server at start. Its message names variables, never their values. */
export class ConfigError extends Error {}

const portError = "PORT must be a whole number from 1 to 65535";

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
    .transform((list) =>
      list
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    )
    // Docker's own rule for names. A name it couldn't have would never match, leaving that Container unprotected.
    .refine((names) => names.every((name) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)), {
      error:
        "PRIVATE_CONTAINERS must be Container names separated by commas, such as chat-bridge,finance",
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
  };
}
