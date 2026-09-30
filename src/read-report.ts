import type { Report } from "./sources/report.ts";
import { count } from "./wording.ts";

/** The Report as written, after when it was written, and a warning first if it's a Stale report. */
export function formatReport(report: Report): string {
  const written = `Report written ${utcMinute(report.writtenAt)}, ${age(report.ageHours)} ago.`;
  const warning = report.stale
    ? [
        `Warning: this Report is ${age(report.ageHours)} old, more than the ${report.maxAgeHours} hours it should be, ` +
          "so it may no longer describe the Host.",
      ]
    : [];
  return [...warning, written, "", report.text].join("\n");
}

/** "2026-09-30 06:00 UTC": the Host's own time zone isn't known here. */
function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "less than an hour", "6 hours", "2 days". Hours up to two days, whole days after. */
function age(hours: number): string {
  if (hours < 1) return "less than an hour";
  if (hours < 48) return count(Math.floor(hours), "hour");
  return count(Math.floor(hours / 24), "day");
}
