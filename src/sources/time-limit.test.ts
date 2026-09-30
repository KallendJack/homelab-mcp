import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTimeLimit } from "./time-limit.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("withinTimeLimit", () => {
  it("gives up after the time limit, answering with the fallback instead of waiting forever", async () => {
    vi.useFakeTimers();
    const neverFinishes = new Promise<string>(() => {});

    const result = withinTimeLimit(neverFinishes, 10, () => "gave up");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe("gave up");
  });

  it("answers with the work's own result when it finishes in time, and leaves no timer behind", async () => {
    vi.useFakeTimers();

    await expect(withinTimeLimit(Promise.resolve("done"), 10, () => "gave up")).resolves.toBe(
      "done",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
