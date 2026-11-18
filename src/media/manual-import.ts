import { z } from "zod";
import type { Action } from "../admin/allowlist.ts";
import { Refusal } from "../refusal.ts";
import type { Arr, ImportCandidate, QueueItem } from "../sources/arr.ts";
import type { Tool } from "../tools.ts";
import { count, section } from "../wording.ts";
import { downloadInput, findDownload } from "./queue-lookup.ts";

const input = z.object(downloadInput);

/** Bounded polling; the Allowlist also limits how long the Client waits. */
const POLL_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 3000;

/** The download's id in the download client, which the app's manual import is asked by. */
function downloadIdOf(item: QueueItem): string {
  if (!item.downloadId) {
    throw new Refusal(
      `${item.title} hasn't reached the download client yet, so it has no files to import.`,
    );
  }
  return item.downloadId;
}

/** "Season 01/x.mkv: Pack Show S01E01, Bluray-1080p" or "Sample/x.mkv: Sample". */
function importLine(c: ImportCandidate): string {
  return `${c.file}: ${[c.match, c.quality].filter(Boolean).join(", ")}`;
}
function skipLine(c: ImportCandidate): string {
  const reasons = c.rejections.join("; ");
  if (c.match) return `${importLine(c)}; ${reasons}`;
  return `${c.file}: not matched${c.quality ? `, ${c.quality}` : ""}${reasons ? ` (${reasons})` : ""}`;
}

/** import_candidates: a read Tool, so it only asks the app what an import would do. */
export function importCandidates(apps: Arr[]): Tool {
  return {
    name: "import_candidates",
    description:
      "Shows what a manual import would do with one download that Sonarr or Radarr couldn't import by itself, " +
      "such as a multi-season pack: each video file with the series and episodes (or film) the app matched and " +
      "its quality, and the app's reasons for skipping any. Imports nothing. Takes the app and queue id that " +
      "download_queue shows.",
    inputSchema: input.shape,
    async handler(args) {
      const { app: name, id } = input.parse(args);
      const { app, item } = await findDownload(apps, name, id);
      const candidates = await app.importCandidates(downloadIdOf(item));
      const heading = `${item.title} (${name} ${item.id})`;
      if (candidates.length === 0) return `${heading}: ${name} found no video files to import.`;
      const take = candidates.filter((c) => c.importable);
      const skip = candidates.filter((c) => !c.importable);
      return [
        `${heading}: ${take.length} of ${count(candidates.length, "file")} can be imported.`,
        ...section("Would import:", take, importLine),
        ...section("Would skip:", skip, skipLine),
      ].join("\n");
    },
  };
}

/**
 * manual_import: has the app import a download's matched files and leave the rest, then follows the import until
 * it finishes or the checks run out.
 */
export function manualImport(apps: Arr[]): Action {
  return {
    name: "manual_import",
    description:
      "Imports one download that Sonarr or Radarr couldn't import by itself, such as a multi-season pack, using " +
      "the matches import_candidates shows: the matched files are imported and the rest (samples, extras, " +
      "files the app rejects) are skipped and listed. Refuses when no file can be imported. Takes the app and " +
      "queue id that download_queue shows.",
    inputSchema: input.shape,
    async handler(args) {
      const { app: name, id } = input.parse(args);
      const { app, item } = await findDownload(apps, name, id);
      const { importId, candidates } = await app.manualImport(downloadIdOf(item));
      const take = candidates.filter((c) => c.importable);
      const skip = candidates.filter((c) => !c.importable);
      if (importId === undefined) {
        const reasons = skip.map((c) => `${skipLine(c)}.`).join(" ");
        throw new Refusal(
          `None of the ${count(candidates.length, "file")} in ${item.title} can be imported, so nothing was imported. ` +
            `${reasons} Fix the matches in ${name}'s own Manual Import.`,
        );
      }

      const skipped = section("Skipped:", skip, skipLine);
      for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
        const progress = await app.importProgress(importId);
        if (progress.status === "failed") {
          throw new Refusal(
            [
              `${name}'s import failed: ${progress.message ?? "it gave no reason"}`,
              ...skipped,
            ].join("\n"),
          );
        }
        if (progress.status === "done") {
          const matches = take.map((c) => c.match).join(", ");
          return [
            `${name} finished the import command for ${count(take.length, "file")} from ${item.title}: ${matches}. Check download_queue and the library to confirm they arrived.`,
            ...skipped,
          ].join("\n");
        }
        if (attempt < POLL_ATTEMPTS) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      return [
        `${name} is still importing ${count(take.length, "file")} from ${item.title}. download_queue shows when it's done.`,
        ...skipped,
      ].join("\n");
    },
  };
}
