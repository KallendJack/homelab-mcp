import { describe, expect, it } from "vitest";
import { dispatcharr } from "../sources/dispatcharr.ts";
import { type FakeAnswer, fakeFetch, fixture } from "../testing/fake-fetch.ts";
import { m3uAccounts } from "./m3u-accounts.ts";

const url = "http://dispatcharr.example:9191";
const accountsUrl = `${url}/api/m3u/accounts/`;
/** When the fixtures were recorded. */
const recordedAt = new Date("2026-11-20T14:11:38Z");

function setUp(answer: FakeAnswer, now = recordedAt) {
  const { fetch, requests } = fakeFetch({ [accountsUrl]: answer });
  return {
    tool: m3uAccounts(dispatcharr(fetch, url, "test-dispatcharr-key"), () => now),
    requests,
  };
}

/** The recorded accounts as JSON, to change them for a case they don't show. */
function edited(change: (accounts: Record<string, unknown>[]) => void): FakeAnswer {
  const accounts = JSON.parse(
    new TextDecoder().decode(fixture("dispatcharr/m3u-accounts-recorded.json").body),
  );
  change(accounts);
  return { body: JSON.stringify(accounts) };
}

describe("m3u_accounts", () => {
  it("names an account that expires within 7 days, leaving out Dispatcharr's own locked account", async () => {
    const { tool, requests } = setUp(fixture("dispatcharr/m3u-accounts-recorded.json"));

    expect(await tool.handler({})).toBe(
      [
        "1 M3U account. IPTV expires within 7 days.",
        "",
        "- IPTV: active, last refresh succeeded. 1 connection, 0 in use. Expires 2026-11-23 05:36 UTC, in 2 days.",
      ].join("\n"),
    );
    expect(requests.map((r) => r.url)).toEqual([accountsUrl]);
    expect(requests[0]?.init?.headers).toEqual({ "X-API-Key": "test-dispatcharr-key" });
  });

  it("says nothing about expiry far off, and keeps the provider error private", async () => {
    const { tool } = setUp(
      edited((accounts) => {
        const iptv = accounts[0] as Record<string, unknown>;
        iptv.earliest_expiration = "2027-03-01T00:00:00Z";
        iptv.status = "error";
        iptv.last_message = "Authentication failed";
      }),
    );

    expect(await tool.handler({})).toBe(
      [
        "1 M3U account.",
        "",
        "- IPTV: active, last refresh failed. 1 connection, 0 in use. Expires 2027-03-01 00:00 UTC, in 100 days.",
      ].join("\n"),
    );
  });

  it("says when an account has expired, or has no expiry date", async () => {
    const { tool } = setUp(
      edited((accounts) => {
        accounts.push({
          ...accounts[0],
          id: 8,
          name: "Spare",
          earliest_expiration: null,
          is_active: false,
          status: "pending_setup",
        });
      }),
      new Date("2026-11-24T00:00:00Z"),
    );

    expect(await tool.handler({})).toBe(
      [
        "2 M3U accounts. IPTV has expired.",
        "",
        "- IPTV: active, last refresh succeeded. 1 connection, 0 in use. Expired 2026-11-23 05:36 UTC.",
        "- Spare: turned off, awaiting setup. 1 connection, 0 in use. No expiry date.",
      ].join("\n"),
    );
  });
});
