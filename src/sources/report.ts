import { readFile, stat } from "node:fs/promises";
import { SourceError, safeErrorCode } from "./source-error.ts";
import { TIME_LIMIT_SECONDS, withinTimeLimit } from "./time-limit.ts";

/** A text file the Host writes on a schedule, returned exactly as written. */
export type Report = {
  text: string;
  writtenAt: Date;
  /** Hours between when it was written and now. */
  ageHours: number;
  /** Older than its schedule allows, so it may no longer describe the Host. */
  stale: boolean;
  maxAgeHours: number;
};

export type ReportSource = {
  read(): Promise<Report>;
};

/** Reads the Report at `path`. `now` decides whether it's a Stale report, older than `maxAgeHours`. */
export function report(path: string, maxAgeHours: number, now: () => Date): ReportSource {
  return {
    async read() {
      // Reading a file can't be cancelled, so a hung mount is cut off by the time limit instead.
      const file = await withinTimeLimit(readReportFile(path), TIME_LIMIT_SECONDS, () => undefined);
      if (!file)
        throw new SourceError(
          `The Report file didn't answer within ${TIME_LIMIT_SECONDS} seconds.`,
        );
      const ageHours = (now().getTime() - file.writtenAt.getTime()) / (60 * 60 * 1000);
      return { ...file, ageHours, stale: ageHours > maxAgeHours, maxAgeHours };
    },
  };
}

/** The file's text and when it was last written. Errors never include the path, a Host detail. */
async function readReportFile(path: string): Promise<{ text: string; writtenAt: Date }> {
  try {
    const [text, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text, writtenAt: stats.mtime };
  } catch (error) {
    const code = safeErrorCode(error);
    if (code === "ENOENT") throw new SourceError("There's no Report file yet.");
    throw new SourceError(`The Report file couldn't be read${code ? ` (${code})` : ""}.`);
  }
}
