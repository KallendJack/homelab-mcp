import { z } from "zod";
import { httpRequests } from "./http.ts";

/** One Gatus check of a URL or port, from its latest result. */
export type HealthCheck = {
  /** Gatus's group, such as "media", or "" when it has none. */
  group: string;
  name: string;
  /** How the latest check went, or undefined if Gatus hasn't checked it yet. */
  latest: HealthCheckResult | undefined;
};

export type HealthCheckResult = {
  passing: boolean;
  /** How long the answer took, or undefined when nothing answered at all (Gatus records 0). */
  responseMs: number | undefined;
};

export type Gatus = {
  healthChecks(): Promise<HealthCheck[]>;
};

const statuses = z.array(
  z.object({
    name: z.string(),
    // Gatus leaves out an empty group, and sends null for a check it hasn't run yet.
    group: z.string().default(""),
    results: z
      .array(
        z.object({
          success: z.boolean(),
          /** Nanoseconds. */
          duration: z.number(),
        }),
      )
      .nullable()
      .transform((results) => results ?? []),
  }),
);

/** Reads Health checks from Gatus at `url`. */
export function gatus(fetch: typeof globalThis.fetch, url: string): Gatus {
  const { getJson } = httpRequests(fetch, url, "Gatus");
  return {
    async healthChecks() {
      // One result per check is enough: only the latest is reported.
      const list = await getJson("/api/v1/endpoints/statuses?page=1&pageSize=1", statuses);
      return list.map((check) => {
        const latest = check.results.at(-1);
        return {
          group: check.group,
          name: check.name,
          latest: latest && {
            passing: latest.success,
            responseMs: latest.duration === 0 ? undefined : Math.round(latest.duration / 1_000_000),
          },
        };
      });
    },
  };
}
