import { describe, expect, it, vi } from "vitest";
import { type Action, adminStartUp, allowlist } from "./allowlist.ts";
import { Refusal } from "./refusal.ts";
import { type Notification, type Notifier, ntfy } from "./sources/ntfy.ts";
import { fakeFetch } from "./testing/fake-fetch.ts";

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

  it("reports an Action over its time limit as timed out, saying the Host may be part-way through", async () => {
    const start = heldAction("start_container");
    const [tool] = allowlist([{ ...start.action, timeLimitSeconds: 0.05 }]);

    await expect(tool?.handler({})).rejects.toThrow(
      new Refusal(
        "start_container didn't finish within 0.05 seconds. It may still be running, so the Host may be " +
          "part-way through: check before trying again.",
      ),
    );
    start.finish("started");
  });

  it("keeps refusing other Actions until a timed-out one has really finished", async () => {
    const start = heldAction("start_container");
    const pull = heldAction("pull_config");
    const [startTool, pullTool] = allowlist([
      { ...start.action, timeLimitSeconds: 0.05 },
      pull.action,
    ]);

    await expect(startTool?.handler({})).rejects.toThrow(/didn't finish within/);
    await expect(pullTool?.handler({})).rejects.toThrow(/start_container is still running/);

    start.finish("started");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = pullTool?.handler({});
    pull.finish("pulled");
    await expect(next).resolves.toBe("pulled");
  });

  it("marks every Action as one that changes the Host, and logs all its arguments", () => {
    const [tool] = allowlist([heldAction("start_container").action]);
    expect(tool?.changesHost).toBe(true);
    expect(tool?.logArguments?.({ name: "vpn-client" })).toBe('{"name":"vpn-client"}');
  });
});

describe("allowlist with Notifications on", () => {
  /** A notifier that records what it was asked to send, or fails as an unreachable ntfy would. */
  function recordingNotifier(fails = false) {
    const sent: Notification[] = [];
    const notifier: Notifier = {
      async send(notification) {
        if (fails) throw new Error("ntfy unreachable");
        sent.push(notification);
      },
    };
    return { notifier, sent };
  }

  it("sends one Notification when an Action works, naming it and what it was asked", async () => {
    const { notifier, sent } = recordingNotifier();
    const start = heldAction("start_container");
    const [tool] = allowlist([start.action], { notifier });
    const call = tool?.handler({ name: "vpn-client" });
    start.finish("Started vpn-client. It was exited.");
    await call;
    expect(sent).toEqual([
      {
        title: "start_container done",
        message: 'Asked: {"name":"vpn-client"}\nStarted vpn-client. It was exited.',
        failed: false,
      },
    ]);
  });

  it("sends one Notification when an Action fails, with its reason, redacted", async () => {
    const { notifier, sent } = recordingNotifier();
    const pull = heldAction("pull_config");
    const [tool] = allowlist([pull.action], { notifier });
    const call = tool?.handler({});
    pull.finish(new Refusal("Git said TOKEN=abc123secret"));
    await expect(call).rejects.toThrow();
    expect(sent).toEqual([
      {
        title: "pull_config failed",
        message: "Asked: {}\nGit said TOKEN=[redacted]",
        failed: true,
      },
    ]);
  });

  it("still answers the Client when the Notification can't be sent, and logs that it wasn't", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { notifier } = recordingNotifier(true);
    const start = heldAction("start_container");
    const [tool] = allowlist([start.action], { notifier });
    const call = tool?.handler({});
    start.finish("Started.");
    await expect(call).resolves.toBe("Started.");
    expect(logged).toHaveBeenCalledWith(
      "start_container's Notification couldn't be sent: ntfy unreachable",
    );
    logged.mockRestore();
  });

  it("never logs the ntfy topic when ntfy refuses a Notification", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const topic = "test-topic-0123456789";
    const { fetch } = fakeFetch({ [`https://push.example/${topic}`]: { status: 500, body: "" } });
    const start = heldAction("start_container");
    const [tool] = allowlist([start.action], {
      notifier: ntfy(fetch, "https://push.example", topic),
    });
    const call = tool?.handler({});
    start.finish("Started.");
    await call;
    expect(logged).toHaveBeenCalledWith(
      "start_container's Notification couldn't be sent: ntfy answered with HTTP 500.",
    );
    expect(logged.mock.calls.flat().join(" ")).not.toContain(topic);
    logged.mockRestore();
  });

  it("sends the Notification when a timed-out Action really finishes", async () => {
    const { notifier, sent } = recordingNotifier();
    const start = heldAction("start_container");
    const [tool] = allowlist([{ ...start.action, timeLimitSeconds: 0.05 }], { notifier });
    await expect(tool?.handler({})).rejects.toThrow(/didn't finish within/);
    expect(sent).toEqual([]);
    start.finish("Started late.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.map((n) => n.title)).toEqual(["start_container done"]);
  });
});

describe("adminStartUp", () => {
  it("names the Allowlist, the config repo and whether Notifications are on", () => {
    const tools = allowlist([
      heldAction("pull_config").action,
      heldAction("start_container").action,
    ]);
    const line = adminStartUp("/host/stacks", tools, false);
    expect(line).toBe(
      "Allowlist: pull_config, start_container. Config repo: /host/stacks. Notifications: off.",
    );
    expect(adminStartUp("/host/stacks", tools, true)).toMatch(/Notifications: on.$/);
  });

  it("says so when the Allowlist is empty", () => {
    expect(adminStartUp("/host/stacks", [], false)).toMatch(/^Allowlist: none\./);
  });
});
