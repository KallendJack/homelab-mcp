import type { Report } from "./sources/report.ts";
import { count } from "./wording.ts";

/** The Report as written, after when it was written, and a warning first if it's a Stale report. */
export function formatReport(report: Report): string {
  const when = utcMinute(report.writtenAt);
  const written =
    report.ageHours < 0
      ? `Report written ${when}, ahead of this server's clock, so its age isn't known.`
      : `Report written ${when}, ${age(report.ageHours)} ago.`;
  const warning = report.stale
    ? [
        `Warning: this Report is ${age(report.ageHours)} old, more than the ` +
          `${count(report.maxAgeHours, "hour")} it should be, so it may no longer describe the Host.`,
      ]
    : [];
  return [...warning, written, "", report.text].join("\n");
}

/** "2026-09-30 06:00 UTC": the Host's own time zone isn't known here. */
function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * "15 minutes", "6 hours", "26 hours 30 minutes", "2 days". Minutes are kept under two days, so a Report just over
 * its limit never reads as the same age as the limit.
 */
function age(hours: number): string {
  const minutes = Math.floor(hours * 60);
  if (minutes < 60) return minutes < 1 ? "less than a minute" : count(minutes, "minute");
  if (hours < 48) {
    const whole = count(Math.floor(minutes / 60), "hour");
    return minutes % 60 === 0 ? whole : `${whole} ${count(minutes % 60, "minute")}`;
  }
  return count(Math.floor(hours / 24), "day");
}
