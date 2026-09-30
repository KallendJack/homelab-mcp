import { z } from "zod";
import { httpSource } from "./http.ts";

/** One Gatus check of a URL or port, from its latest result. */
export type HealthCheck = {
  /** Gatus's group, such as "media", or "" when it has none. */
  group: string;
  name: string;
  /** How the latest check went, or undefined if Gatus hasn't checked it yet. */
  latest: { passing: boolean; responseMs: number } | undefined;
};

export type Gatus = {
  healthChecks(): Promise<HealthCheck[]>;
};

const statuses = z.array(
  z.object({
    name: z.string(),
    group: z.string().default(""),
    results: z.array(
      z.object({
        success: z.boolean(),
        /** Nanoseconds. */
        duration: z.number(),
      }),
    ),
  }),
);

/** Reads Health checks from Gatus at `url`. */
export function gatus(fetch: typeof globalThis.fetch, url: string): Gatus {
  const { getJson } = httpSource(fetch, url, "Gatus");
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
            responseMs: Math.round(latest.duration / 1_000_000),
          },
        };
      });
    },
  };
}
