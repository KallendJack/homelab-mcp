import { posix } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { Refusal } from "./refusal.ts";

const mount = z.union([
  z.string(),
  z.object({ type: z.string(), source: z.string().optional(), target: z.string() }),
]);
const envFile = z.union([z.string(), z.object({ path: z.string() })]);
const service = z.object({
  volumes: z.array(mount).optional(),
  configs: z.array(z.union([z.string(), z.object({ source: z.string() })])).optional(),
  env_file: z.union([envFile, z.array(envFile)]).optional(),
  extends: z.unknown().optional(),
});
const composeFile = z.object({
  services: z.record(z.string(), service).default({}),
  configs: z.record(z.string(), z.object({ file: z.string().optional() })).optional(),
  include: z.unknown().optional(),
});
type Service = z.infer<typeof service>;
type ComposeFile = z.infer<typeof composeFile>;

/**
 * The Services in one Compose file that the `changed` files affect, as "file: service". A Service is affected
 * when its Compose file changed, or a file it mounts, reads as a config or loads as an env file changed.
 * It reads the Compose text only: it never opens the mounted files, and never expands variables from a .env.
 * Paths are relative to the config repo at `repoPath`, the same path the Host uses.
 */
export function changedServices(
  text: string,
  file: string,
  repoPath: string,
  changed: string[],
): string[] {
  const parsed = composeFile.safeParse(parse(text, { merge: true }));
  if (!parsed.success) {
    throw new Refusal(`The Services in ${file} can't be read, so the config repo wasn't changed.`);
  }
  // These pull in Services from other files, which this can't follow: a person should look first.
  if (parsed.data.include !== undefined) {
    throw new Refusal(`${file} uses include, which needs a person to check before pulling.`);
  }

  const isChanged = changedPath(file, repoPath, changed);
  const wholeFileChanged = changed.includes(file);
  return Object.entries(parsed.data.services)
    .filter(([, svc]) => {
      if (svc.extends !== undefined) {
        throw new Refusal(`${file} uses extends, which needs a person to check before pulling.`);
      }
      return wholeFileChanged || filesUsedBy(svc, parsed.data).some(isChanged);
    })
    .map(([name]) => `${file}: ${name}`);
}

/** The repo files a Service reads: bind mounts, configs and env files. Named volumes aren't files. */
function filesUsedBy(svc: Service, compose: ComposeFile): string[] {
  const mounts = (svc.volumes ?? []).flatMap((v) => {
    if (typeof v !== "string") return v.type === "bind" && v.source ? [v.source] : [];
    const source = v.split(":")[0] ?? "";
    // A short mount is a bind mount only when it's a path; a bare word is a named volume.
    return source.startsWith(".") || source.startsWith("/") || source.includes("$") ? [source] : [];
  });
  const configs = (svc.configs ?? []).flatMap((c) => {
    const config = compose.configs?.[typeof c === "string" ? c : c.source];
    return config?.file ? [config.file] : [];
  });
  const envFiles = [svc.env_file ?? []].flat().map((e) => (typeof e === "string" ? e : e.path));
  return [...mounts, ...configs, ...envFiles];
}

/** Whether a path a Compose file uses is, or contains, one of the changed repo files. */
function changedPath(file: string, repoPath: string, changed: string[]): (path: string) => boolean {
  const folder = posix.dirname(file);
  const root = repoPath.replaceAll("\\", "/");
  return (path) => {
    if (path.includes("$")) {
      throw new Refusal(
        `${file} mounts a path with a variable in it, which can't be checked, so the config repo wasn't changed.`,
      );
    }
    const absolute = posix.isAbsolute(path) || /^[A-Za-z]:\//.test(path);
    const inRepo = absolute
      ? posix.relative(root, path)
      : posix.normalize(posix.join(folder, path));
    return changed.some((f) => f === inRepo || f.startsWith(`${inRepo}/`) || inRepo === ".");
  };
}
