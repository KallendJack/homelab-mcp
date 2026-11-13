import { describe, expect, it } from "vitest";
import { type Action, adminStartUp, allowlist } from "./allowlist.ts";
import { Refusal } from "./refusal.ts";

/** An Action that runs until the test lets it finish. */
function heldAction(name: string) {
  let finish: (outcome: Error | string) => void = () => {};
  const action: Action = {
    name,
    description: "A fake Action for tests.",
    inputSchema: {},
    handler: () =>
      new Promise((resolve, reject) => {
        finish = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
      }),
  };
  return { action, finish: (outcome: Error | string) => finish(outcome) };
}

describe("allowlist", () => {
  it("refuses a second Action while one runs, naming the one running", async () => {
    const pull = heldAction("pull_config");
    const start = heldAction("start_container");
    const [pullTool, startTool] = allowlist([pull.action, start.action]);

    const running = pullTool?.handler({});
    await expect(startTool?.handler({})).rejects.toThrow(
      new Refusal(
        "pull_config is still running. Only one Action runs at a time, so try again when it has finished.",
      ),
    );
    pull.finish("pulled");
    await expect(running).resolves.toBe("pulled");
  });

  it("refuses the same Action again while it runs", async () => {
    const pull = heldAction("pull_config");
    const [pullTool] = allowlist([pull.action]);

    const running = pullTool?.handler({});
    await expect(pullTool?.handler({})).rejects.toThrow(/pull_config is still running/);
    pull.finish("pulled");
    await running;
  });

  it("lets the next Action run once the last one has finished, whether it worked or not", async () => {
    const pull = heldAction("pull_config");
    const start = heldAction("start_container");
    const [pullTool, startTool] = allowlist([pull.action, start.action]);

    const failed = pullTool?.handler({});
    pull.finish(new Error("git failed"));
    await expect(failed).rejects.toThrow("git failed");

    const next = startTool?.handler({});
    start.finish("started");
    await expect(next).resolves.toBe("started");
  });

  it("marks every Action as one that changes the Host, and logs all its arguments", () => {
    const [tool] = allowlist([heldAction("start_container").action]);
    expect(tool?.changesHost).toBe(true);
    expect(tool?.logArguments?.({ name: "vpn-client" })).toBe('{"name":"vpn-client"}');
  });
});

describe("adminStartUp", () => {
  it("names the Allowlist, the config repo and whether Notifications are on", () => {
    const tools = allowlist([
      heldAction("pull_config").action,
      heldAction("start_container").action,
    ]);
    const line = adminStartUp("/host/stacks", tools);
    expect(line).toBe(
      "Allowlist: pull_config, start_container. Config repo: /host/stacks. Notifications: off.",
    );
  });

  it("says so when the Allowlist is empty", () => {
    expect(adminStartUp("/host/stacks", [])).toMatch(/^Allowlist: none\./);
  });
});
