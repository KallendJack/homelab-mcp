import type { Dispatcharr, M3uAccount } from "../sources/dispatcharr.ts";
import type { Tool } from "../tools.ts";
import { count, utcMinute } from "../wording.ts";

/** How soon an expiry is worth naming first. */
const SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function expiryOf(account: M3uAccount, now: Date): string {
  if (!account.expires) return "No expiry date.";
  const left = account.expires.getTime() - now.getTime();
  if (left <= 0) return `Expired ${utcMinute(account.expires)}.`;
  const days = Math.floor(left / DAY_MS);
  return `Expires ${utcMinute(account.expires)}, ${days === 0 ? "within a day" : `in ${count(days, "day")}`}.`;
}

function refreshOf(account: M3uAccount): string {
  switch (account.refresh) {
    case "success":
      return "last refresh succeeded";
    case "error":
      return "last refresh failed";
    case "fetching":
      return "refreshing now";
    case "parsing":
      return "refreshing now";
    case "pending_setup":
      return "awaiting setup";
    case "idle":
      return "refresh idle";
    case "disabled":
      return "refresh disabled";
    default:
      return "refresh status unknown";
  }
}

/** m3u_accounts: each provider account, naming any that has expired or soon will. */
export function m3uAccounts(dispatcharr: Dispatcharr, now: () => Date): Tool {
  return {
    name: "m3u_accounts",
    description:
      "Lists the live TV provider accounts (M3U accounts) Dispatcharr imports Streams from: whether each is on, " +
      "whether its last refresh worked, how many connections it allows and has in use, and when it expires. " +
      "Starts by naming any account that has expired or expires within 7 days. Use it when Channels stop " +
      "playing, or to check the provider is still paid up.",
    inputSchema: {},
    async handler() {
      const accounts = await dispatcharr.m3uAccounts();
      if (accounts.length === 0) return "Dispatcharr has no M3U accounts.";
      const at = now();
      const expired = accounts.filter((a) => a.expires && a.expires <= at);
      const soon = accounts.filter(
        (a) =>
          a.expires && a.expires > at && a.expires.getTime() - at.getTime() <= SOON_DAYS * DAY_MS,
      );
      const warnings = [
        ...expired.map((a) => `${a.name} has expired.`),
        ...soon.map((a) => `${a.name} expires within ${SOON_DAYS} days.`),
      ];
      const line = (a: M3uAccount) =>
        `- ${a.name}: ${a.active ? "active" : "turned off"}, ${refreshOf(a)}. ` +
        `${count(a.connections, "connection")}, ${a.inUse} in use. ${expiryOf(a, at)}`;
      return [
        [`${count(accounts.length, "M3U account")}.`, ...warnings].join(" "),
        "",
        ...accounts.map(line),
      ].join("\n");
    },
  };
}
