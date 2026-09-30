import { describe, expect, it } from "vitest";
import { humanBytes } from "./bytes.ts";

describe("humanBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1_500, "1.50 kB"],
    [71_200_000, "71.2 MB"],
    [812_000_000_000, "812 GB"],
    [4_430_000_000_000, "4.43 TB"],
    [5_000_000_000_000_000_000, "5000 PB"],
  ])("shows %i bytes as %s, in the thousands disks are sold in", (bytes, text) => {
    expect(humanBytes(bytes)).toBe(text);
  });

  it.each([
    [999_950, "1.00 MB"],
    [99_996_000, "100 MB"],
    [9_996_000_000, "10.0 GB"],
  ])(
    "rounds before choosing the unit, so %i bytes is %s, never 1000 of the smaller unit",
    (bytes, text) => {
      expect(humanBytes(bytes)).toBe(text);
    },
  );
});
