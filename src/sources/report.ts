import { open } from "node:fs/promises";
import { SourceError, safeErrorCode } from "./source-error.ts";
import { TIME_LIMIT_SECONDS, withinTimeLimit } from "./time-limit.ts";

/** A text file the Host writes on a schedule, returned exactly as written. */
export type Report = {
  text: string;
  writtenAt: Date;
  /** Hours between when it was written and now; below 0 when it's dated ahead of this server's clock. */
  ageHours: number;
  /** Older than its schedule allows, so it may no longer describe the Host. */
  stale: boolean;
  maxAgeHours: number;
};

export type ReportSource = {
  read(): Promise<Report>;
};

type ReportFile = { text: string; writtenAt: Date };

/** Bigger than any status message: a larger file is more likely the wrong path, such as a whole log. */
export const MAX_REPORT_BYTES = 200_000;

/** Reads the Report at `path`. `now` decides whether it's a Stale report, older than `maxAgeHours`. */
export function report(path: string, maxAgeHours: number, now: () => Date): ReportSource {
  return {
    async read() {
      // Reading a file can't be cancelled, so a hung mount is cut off by the time limit instead.
      const file = await withinTimeLimit<ReportFile | "timed out">(
        readReportFile(path),
        TIME_LIMIT_SECONDS,
        () => "timed out" as const,
      );
      if (file === "timed out") {
        throw new SourceError(
          `The Report file didn't answer within ${TIME_LIMIT_SECONDS} seconds.`,
        );
      }
      const ageHours = (now().getTime() - file.writtenAt.getTime()) / (60 * 60 * 1000);
      return { ...file, ageHours, stale: ageHours > maxAgeHours, maxAgeHours };
    },
  };
}

/**
 * The file's text and when it was last written, both from one open file, so a rewrite in between can't pair new
 * text with an old time. Errors never include the path, a Host detail.
 */
async function readReportFile(path: string): Promise<ReportFile> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const stats = await file.stat();
    if (stats.size > MAX_REPORT_BYTES) {
      throw new SourceError(
        `The Report file is over ${MAX_REPORT_BYTES / 1000} kB, too big to return.`,
      );
    }
    return { text: await file.readFile("utf8"), writtenAt: stats.mtime };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const code = safeErrorCode(error);
    if (code === "ENOENT") throw new SourceError("There's no Report file yet.");
    throw new SourceError(`The Report file couldn't be read${code ? ` (${code})` : ""}.`);
  } finally {
    await file?.close();
  }
}
