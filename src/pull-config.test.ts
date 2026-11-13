import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pullConfig } from "./pull-config.ts";

const folders: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pull-config-"));
  folders.push(root);
  const remote = join(root, "remote"),
    repo = join(root, "checkout");
  mkdirSync(remote);
  git(remote, "init", "-b", "trunk");
  writeFileSync(join(remote, "README.md"), "before\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Initial");
  git(root, "clone", "-c", "core.autocrlf=false", remote, repo);
  const keyFile = join(root, "deploy-key");
  writeFileSync(keyFile, "test-only-placeholder");
  const knownHostsFile = join(root, "known-hosts");
  writeFileSync(knownHostsFile, "git.example ssh-ed25519 test-only-placeholder\n");
  const settings = { repoPath: repo, composeFiles: [] as string[], keyFile, knownHostsFile };
  return { root, remote, repo, keyFile, knownHostsFile, settings, tool: pullConfig(settings) };
}
afterEach(() => {
  for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("fast-forwards to the remote default branch and reports commits and files", async () => {
  const { remote, repo, tool } = setup();
  const old = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(remote, "README.md"), "after\n");
  git(remote, "commit", "-am", "Update");
  const next = git(remote, "rev-parse", "HEAD");
  const answer = await tool.handler({});
  expect(git(repo, "rev-parse", "HEAD")).toBe(next);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("after\n");
  expect(answer).toContain(old);
  expect(answer).toContain(next);
  expect(answer).toContain("README.md");
});
it.each(["tracked", "untracked", "staged"])(
  "refuses %s local changes without moving HEAD",
  async (kind) => {
    const { repo, remote, tool } = setup();
    const old = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(remote, "new.txt"), "remote");
    git(remote, "add", ".");
    git(remote, "commit", "-m", "Remote");
    writeFileSync(join(repo, kind === "tracked" ? "README.md" : "local.txt"), "local");
    if (kind === "staged") git(repo, "add", ".");
    await expect(tool.handler({})).rejects.toThrow(/local changes/i);
    expect(git(repo, "rev-parse", "HEAD")).toBe(old);
  },
);
it("refuses diverged history without changing files or HEAD", async () => {
  const { repo, remote, tool } = setup();
  writeFileSync(join(repo, "local.txt"), "local");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Local");
  const old = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(remote, "remote.txt"), "remote");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Remote");
  await expect(tool.handler({})).rejects.toThrow(/fast-forward/);
  expect(git(repo, "rev-parse", "HEAD")).toBe(old);
});
it("reports Services for changed bind-mounted config in either revision", async () => {
  const { repo, remote, settings } = setup();
  mkdirSync(join(remote, "proxy"));
  mkdirSync(join(remote, "proxy", "config"));
  writeFileSync(
    join(remote, "proxy", "compose.yaml"),
    "services:\n  proxy:\n    volumes:\n      - ./config:/etc/proxy:ro\n  untouched:\n    image: example\n",
  );
  writeFileSync(join(remote, "proxy", "config", "site.conf"), "before");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Config");
  git(repo, "pull", "--ff-only");
  writeFileSync(join(remote, "proxy", "config", "site.conf"), "after");
  git(remote, "commit", "-am", "Config change");
  const result = await pullConfig({
    ...settings,
    composeFiles: ["proxy/compose.yaml"],
  }).handler({});
  expect(result).toContain("Changed Services:\nproxy/compose.yaml: proxy");
  expect(result).not.toContain("untouched");
});
it("refuses an unavailable deploy-key file before moving HEAD", async () => {
  const { repo, remote, keyFile, tool } = setup();
  rmSync(keyFile);
  const old = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(remote, "new.txt"), "new");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "New");
  await expect(tool.handler({})).rejects.toThrow(/deploy key/i);
  expect(git(repo, "rev-parse", "HEAD")).toBe(old);
});
it("refuses an unreadable known hosts file before moving HEAD", async () => {
  const { repo, remote, knownHostsFile, tool } = setup();
  rmSync(knownHostsFile);
  const old = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(remote, "new.txt"), "new");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "New");
  await expect(tool.handler({})).rejects.toThrow(/known hosts/i);
  expect(git(repo, "rev-parse", "HEAD")).toBe(old);
});
it("reports a Service whose config is mounted by its absolute path inside the repo", async () => {
  const { repo, remote, settings } = setup();
  mkdirSync(join(remote, "ops", "gatus"), { recursive: true });
  // The long mount syntax, so a Windows test path's drive letter can't be read as a mount separator.
  const mounted = `${repo.replaceAll("\\", "/")}/ops/gatus`;
  const compose = [
    "services:",
    "  gatus:",
    "    volumes:",
    "      - type: bind",
    `        source: ${mounted}`,
    "        target: /config",
    "  glance:",
    "    image: example",
    "",
  ].join("\n");
  writeFileSync(join(remote, "ops", "compose.yaml"), compose);
  writeFileSync(join(remote, "ops", "gatus", "config.yaml"), "before");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Gatus");
  git(repo, "pull", "--ff-only");
  writeFileSync(join(remote, "ops", "gatus", "config.yaml"), "after");
  git(remote, "commit", "-am", "Gatus change");
  const result = await pullConfig({ ...settings, composeFiles: ["ops/compose.yaml"] }).handler({});
  expect(result).toContain("Changed Services:\nops/compose.yaml: gatus");
  expect(result).not.toContain("glance");
});
it("does not overwrite an ignored local Secret when the remote adds that path", async () => {
  const { repo, remote, tool } = setup();
  writeFileSync(join(remote, ".gitignore"), ".env\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Ignore");
  git(repo, "pull", "--ff-only");
  writeFileSync(join(repo, ".env"), "local-secret-placeholder");
  const old = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(remote, ".env"), "remote-placeholder");
  git(remote, "add", "-f", ".env");
  git(remote, "commit", "-m", "Track path");
  await expect(tool.handler({})).rejects.toThrow();
  expect(git(repo, "rev-parse", "HEAD")).toBe(old);
  expect(readFileSync(join(repo, ".env"), "utf8")).toBe("local-secret-placeholder");
});
it("includes removed Services when their Compose file is deleted", async () => {
  const { repo, remote, settings } = setup();
  writeFileSync(join(remote, "compose.yaml"), "services:\n  old-service:\n    image: example\n");
  git(remote, "add", ".");
  git(remote, "commit", "-m", "Compose");
  git(repo, "pull", "--ff-only");
  git(remote, "rm", "compose.yaml");
  git(remote, "commit", "-m", "Retire");
  expect(await pullConfig({ ...settings, composeFiles: ["compose.yaml"] }).handler({})).toContain(
    "compose.yaml: old-service",
  );
});
