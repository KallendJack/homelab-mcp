import { describe, expect, it } from "vitest";
import { Refusal } from "./refusal.ts";
import { type ComposeModel, dependentsOf, findService, planFor } from "./service-plan.ts";

/** A resolved Compose model in the shape `docker compose config --format json` gives, with placeholder names. */
const media: ComposeModel = {
  file: "media/compose.yaml",
  project: "media",
  services: {
    "vpn-client": {},
    downloader: {
      network_mode: "service:vpn-client",
      depends_on: { "vpn-client": { condition: "service_healthy", restart: true } },
    },
    indexer: { network_mode: "service:vpn-client" },
    "media-server": { depends_on: { downloader: { condition: "service_started" } } },
  },
};
const ops: ComposeModel = {
  file: "ops/compose.yaml",
  project: "ops",
  services: { dashboard: {}, "uptime-checks": {} },
};

describe("findService", () => {
  it("finds which Compose file and project a Service is in", () => {
    expect(findService([media, ops], "dashboard")).toBe(ops);
  });

  it("refuses an unknown Service and names the closest ones", () => {
    expect(() => findService([media, ops], "dashbord")).toThrow(
      new Refusal('No Service is named "dashbord". Closest: dashboard.'),
    );
  });

  it("refuses a name that's a Service in two Compose files, since it can't tell which is meant", () => {
    const other = { ...ops, file: "other/compose.yaml", project: "other" };
    expect(() => findService([ops, other], "dashboard")).toThrow(
      new Refusal(
        "dashboard is a Service in more than one Compose file (ops/compose.yaml, other/compose.yaml), so it " +
          "can't tell which is meant.",
      ),
    );
  });
});

describe("dependentsOf", () => {
  it("names the Services that share its network or restart with it", () => {
    expect(dependentsOf(media, "vpn-client")).toEqual(["downloader", "indexer"]);
  });

  it("doesn't count a plain start-order dependency, which a recreate leaves running", () => {
    expect(dependentsOf(media, "downloader")).toEqual([]);
  });

  it("is empty for a Service nothing else relies on", () => {
    expect(dependentsOf(ops, "dashboard")).toEqual([]);
  });
});

describe("planFor", () => {
  const hash = "abc123";

  it("says a Service with no Container would be created", () => {
    expect(planFor([], hash)).toEqual([{ container: undefined, change: "create" }]);
  });

  it("says a Container with a different config hash would be recreated", () => {
    expect(planFor([{ name: "dashboard", configHash: "old999" }], hash)).toEqual([
      { container: "dashboard", change: "recreate" },
    ]);
  });

  it("says a Container with the same config hash would be left alone", () => {
    expect(planFor([{ name: "dashboard", configHash: hash }], hash)).toEqual([
      { container: "dashboard", change: "leave alone" },
    ]);
  });

  it("treats a Container without a config hash as one to recreate, since Compose didn't make it", () => {
    expect(planFor([{ name: "dashboard", configHash: undefined }], hash)).toEqual([
      { container: "dashboard", change: "recreate" },
    ]);
  });
});
