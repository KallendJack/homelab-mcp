import { statfs } from "node:fs/promises";
import { safeErrorCode } from "./source-error.ts";
import { TIME_LIMIT_SECONDS, withinTimeLimit } from "./time-limit.ts";

/** One path whose disk space is reported, under a label of the owner's choosing, such as data=/host/volume1. */
export type DiskPath = { label: string; path: string };

/** Why a path's space couldn't be read. Never the path itself, which is a Host detail. */
export type DiskFailure =
  | { kind: "timed out"; seconds: number }
  | { kind: "unreadable"; code: string | undefined };

/** Space in bytes on the disk holding one path, or why it couldn't be read. */
export type DiskUsage =
  | { label: string; used: number; free: number; total: number }
  | { label: string; failure: DiskFailure };

export type Disk = {
  usage(): Promise<DiskUsage[]>;
};

/** Reads the space on the disk holding each path, from the filesystem itself, each within the time limit. */
export function disk(paths: DiskPath[]): Disk {
  return {
    usage: () =>
      Promise.all(
        paths.map(({ label, path }) =>
          withinTimeLimit(
            read(label, path),
            TIME_LIMIT_SECONDS,
            (): DiskUsage => ({
              label,
              failure: { kind: "timed out", seconds: TIME_LIMIT_SECONDS },
            }),
          ),
        ),
      ),
  };
}

async function read(label: string, path: string): Promise<DiskUsage> {
  try {
    const stats = await statfs(path);
    return {
      label,
      used: (stats.blocks - stats.bfree) * stats.bsize,
      // What an ordinary user can still write: some space is kept back for the system, as df counts it.
      free: stats.bavail * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
  } catch (error) {
    return { label, failure: { kind: "unreadable", code: safeErrorCode(error) } };
  }
}
