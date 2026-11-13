import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ComposeAnswer = { stdout?: string; stderr?: string; exitCode?: number };

/**
 * A fake `docker compose` for tests: a real process that answers each argument list from `answers` (arguments
 * joined by spaces) and records every call. `command` goes where the real one would; `calls()` reads the record.
 */
export function fakeCompose(answers: Record<string, ComposeAnswer>) {
  const folder = mkdtempSync(join(tmpdir(), "fake-compose-"));
  const log = join(folder, "calls.jsonl");
  const scenario = join(folder, "scenario.json");
  writeFileSync(log, "");
  writeFileSync(scenario, JSON.stringify({ log, answers }));
  const script = fileURLToPath(new URL("./fake-compose.mjs", import.meta.url));
  return {
    command: [process.execPath, script, scenario],
    calls(): { args: string[]; dockerHost: string | null }[] {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    cleanUp: () => rmSync(folder, { recursive: true, force: true }),
  };
}
