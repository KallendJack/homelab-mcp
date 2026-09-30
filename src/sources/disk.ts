import { statfs } from "node:fs/promises";

/** One path whose disk space is reported, under a label of the owner's choosing, such as data=/host/volume1. */
export type DiskPath = { label: string; path: string };

/** Space in bytes on the disk holding one path, or why it couldn't be read. */
export type DiskUsage =
  | { label: string; used: number; free: number; total: number }
  | { label: string; error: string };

export type Disk = {
  usage(): Promise<DiskUsage[]>;
};

/** Reads the space on the disk holding each path, from the filesystem itself. */
export function disk(paths: DiskPath[]): Disk {
  return {
    usage: () => Promise.all(paths.map(read)),
  };
}

async function read({ label, path }: DiskPath): Promise<DiskUsage> {
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
    // The error's own text names the path, a Host detail, so only its code goes out.
    const code = (error as { code?: unknown }).code;
    const safeCode = typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` (${code})` : "";
    return { label, error: `couldn't be read${safeCode}.` };
  }
}
