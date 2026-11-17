// The size check, one of the house configs every app repo copies from here: it fails a
// source file over 400 lines or a folder of more than 15 source files. Tests, fixtures, generated
// and vendored files are left out. Files and folders already over sit in a list at their size; the
// list is a ratchet, so an entry may shrink and never grow. Run from the repo's root:
//
//   node check-size.ts [<list>]   checks; the list is scripts/check-size.json unless given
//   … --update                    lowers each entry to its size today, dropping those now within
//   … --baseline                  records everything over today, for a repo taking the check on

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MOST_LINES = 400;
const MOST_FILES = 15;

const SOURCE = /\.(c|m)?[jt]sx?$|\.(astro|vue|svelte|css)$/;
const LEFT_OUT_NAMES = /\.(test|spec)\.[^.]+$|\.gen\.[^.]+$|\.d\.ts$|\.min\.[^.]+$/;
const LEFT_OUT_FOLDERS = new Set([
  "test",
  "tests",
  "__tests__",
  "e2e",
  "fixtures",
  "test-fixtures",
  "vendor",
  "generated",
  "dist",
  "node_modules",
]);

type Sizes = { files: Record<string, number>; folders: Record<string, number> };

const args = process.argv.slice(2);
const listPath = args.find((arg) => !arg.startsWith("--")) ?? "scripts/check-size.json";
const update = args.includes("--update");
const baseline = args.includes("--baseline");

const isSizes = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((size) => Number.isInteger(size) && size > 0);

/** The list as the repo keeps it, or an empty one when it has none. */
const readList = (): Sizes => {
  if (!existsSync(listPath)) return { files: {}, folders: {} };
  const read: unknown = JSON.parse(readFileSync(listPath, "utf8"));
  const files = typeof read === "object" && read !== null && "files" in read ? read.files : {};
  const folders =
    typeof read === "object" && read !== null && "folders" in read ? read.folders : {};
  if (!isSizes(files) || !isSizes(folders)) {
    console.error(
      `${listPath} isn't a list of sizes: { "files": { path: lines }, "folders": { path: files } }.`,
    );
    process.exit(1);
  }
  return { files, folders };
};

const writeList = (list: Sizes) => {
  const sorted = (sizes: Record<string, number>) =>
    Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(listPath), { recursive: true });
  writeFileSync(
    listPath,
    `${JSON.stringify({ files: sorted(list.files), folders: sorted(list.folders) }, null, 2)}\n`,
  );
};

/** Every source file git knows of or would add, tracked or not, that the check counts. */
const sourceFiles = () =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => SOURCE.test(path) && !LEFT_OUT_NAMES.test(path))
    .filter((path) => !path.split("/").some((part) => LEFT_OUT_FOLDERS.has(part)))
    .filter((path) => existsSync(path) && statSync(path).isFile());

const countLines = (path: string) => {
  const text = readFileSync(path, "utf8");
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};

/** Today's sizes: every file's lines and every folder's source files. */
const measure = (): Sizes => {
  const files: Record<string, number> = {};
  const folders: Record<string, number> = {};
  for (const path of [...new Set(sourceFiles())]) {
    files[path] = countLines(path);
    const folder = dirname(path) === "." ? "." : dirname(path);
    folders[folder] = (folders[folder] ?? 0) + 1;
  }
  return { files, folders };
};

const today = measure();
const list = readList();

const over = (sizes: Record<string, number>, most: number) =>
  Object.fromEntries(Object.entries(sizes).filter(([, size]) => size > most));

if (baseline) {
  writeList({ files: over(today.files, MOST_LINES), folders: over(today.folders, MOST_FILES) });
  process.exit(0);
}

/** An entry lowered to today's size, or dropped once it's within the limit or gone. */
const lowered = (entries: Record<string, number>, sizes: Record<string, number>, most: number) =>
  Object.fromEntries(
    Object.entries(entries).flatMap(([path, size]) => {
      const now = sizes[path] ?? 0;
      return now > most ? [[path, Math.min(size, now)]] : [];
    }),
  );

if (update) {
  writeList({
    files: lowered(list.files, today.files, MOST_LINES),
    folders: lowered(list.folders, today.folders, MOST_FILES),
  });
}
const kept = update ? readList() : list;

const problems: string[] = [];
let shrank = false;

const judge = (kind: "file" | "folder") => {
  const sizes = kind === "file" ? today.files : today.folders;
  const entries = kind === "file" ? kept.files : kept.folders;
  const most = kind === "file" ? MOST_LINES : MOST_FILES;
  const unit = kind === "file" ? "lines" : "source files";
  const shown = (path: string) => (kind === "file" ? path : `${path}/`);
  for (const [path, size] of Object.entries(sizes)) {
    const allowed = entries[path];
    if (allowed === undefined && size > most) {
      problems.push(`${shown(path)} has ${size} ${unit}: split it (at most ${most}).`);
    } else if (allowed !== undefined && size > allowed) {
      problems.push(
        `${shown(path)} has grown to ${size} ${unit} (listed at ${allowed}): split it rather than grow it.`,
      );
    }
  }
  for (const [path, allowed] of Object.entries(entries)) {
    const size = sizes[path] ?? 0;
    if (size < allowed) {
      shrank = true;
      problems.push(`${shown(path)} is down to ${size} ${unit} (listed at ${allowed}).`);
    }
  }
};
judge("file");
judge("folder");

if (problems.length > 0) {
  if (shrank) {
    problems.push(
      `Lower the entries with: node ${join(dirname(process.argv[1] ?? ""), "check-size.ts")} ${listPath} --update`,
    );
  }
  console.error(problems.join("\n"));
  process.exit(1);
}
