import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { Action } from "./allowlist.ts";
import { changedServices } from "./changed-services.ts";
import { Refusal } from "./refusal.ts";

const execFileAsync = promisify(execFile);

export type PullConfigSettings = {
  /** The config repo, as mounted in the admin container. */
  repoPath: string;
  /** The Compose files inside it, whose Services are reported when they change. */
  composeFiles: string[];
  /** The read-only deploy key's file. Only its path is ever handled; Git's ssh reads the key itself. */
  keyFile: string;
  /** The file holding the Git host's SSH key, so the server knows it's talking to the real host. */
  knownHostsFile: string;
};

/**
 * Fast-forwards the config repo to its remote's default branch, and says which files and Services changed.
 * It never merges, rebases or discards anything: local changes or a history that has moved apart are refused,
 * leaving the repo exactly as it was.
 */
export function pullConfig(settings: PullConfigSettings): Action {
  const git = gitIn(settings);

  return {
    name: "pull_config",
    description:
      "Updates the homelab's config repo from GitHub, but only by fast-forwarding: it refuses if the repo has " +
      "local changes or its history has moved apart from GitHub's. Returns the old and new commit, the files " +
      "that changed and the Services whose Compose file or mounted config changed, which are the ones to " +
      "preview and recreate next.",
    inputSchema: {},
    async handler() {
      await checkReadable(settings.keyFile, "deploy key");
      await checkReadable(settings.knownHostsFile, "known hosts");
      try {
        return await pull(git, settings);
      } catch (error) {
        if (error instanceof Refusal) throw error;
        // Git's own message can name the remote's address, so only a fixed sentence reaches the Client.
        throw new Refusal(
          "Git couldn't finish the pull, and the config repo wasn't changed. Check the remote, the deploy key " +
            "and the known hosts file.",
        );
      }
    },
  };
}

type Git = (...args: string[]) => Promise<string>;

async function pull(git: Git, settings: PullConfigSettings): Promise<string> {
  await refuseLocalChanges(git);
  const old = await git("rev-parse", "HEAD");

  const branch = await defaultBranch(git);
  await git("fetch", "--no-tags", "origin", branch);
  const next = await git("rev-parse", "FETCH_HEAD");
  if (!(await isAncestor(git, old, next))) {
    throw new Refusal(
      "The config repo can't fast-forward: its history has moved apart from GitHub's. Nothing was changed.",
    );
  }

  const files = (await git("diff", "--name-only", old, next, "--")).split("\n").filter(Boolean);
  // Both sides count: a Service removed or renamed by this pull changed too.
  const services = new Set<string>();
  for (const revision of [old, next]) {
    for (const service of await servicesAt(git, revision, settings, files)) {
      services.add(service);
    }
  }

  // Checked again just before moving, in case something changed the repo while the fetch ran.
  await refuseLocalChanges(git);
  if ((await git("rev-parse", "HEAD")) !== old) {
    throw new Refusal(
      "The config repo moved while pulling. Nothing was changed; check it and try again.",
    );
  }
  // --no-overwrite-ignore keeps an ignored local file, such as a .env, from being replaced by a tracked one.
  await git("merge", "--ff-only", "--no-overwrite-ignore", next);

  return [
    `Config repo: ${old} -> ${next}.`,
    "Changed files:",
    ...(files.length > 0 ? files : ["none"]),
    "Changed Services:",
    ...(services.size > 0 ? [...services].sort() : ["none"]),
  ].join("\n");
}

async function refuseLocalChanges(git: Git): Promise<void> {
  // Ignored files, such as each stack's .env, don't count; anything else would be lost or mixed in.
  if (await git("status", "--porcelain", "--untracked-files=all")) {
    throw new Refusal(
      "The config repo has local changes, so it wasn't pulled. Commit or remove them first.",
    );
  }
}

/** The remote's default branch, such as refs/heads/main, asked of the remote rather than assumed. */
async function defaultBranch(git: Git): Promise<string> {
  const answer = await git("ls-remote", "--symref", "origin", "HEAD");
  const branch = /^ref: (refs\/heads\/\S+)\s+HEAD/m.exec(answer)?.[1];
  if (branch === undefined) throw new Error("The remote has no default branch.");
  return branch;
}

async function isAncestor(git: Git, old: string, next: string): Promise<boolean> {
  try {
    await git("merge-base", "--is-ancestor", old, next);
    return true;
  } catch {
    return false;
  }
}

/** The Services in each Compose file at `revision` that the changed `files` affect. */
async function servicesAt(
  git: Git,
  revision: string,
  settings: PullConfigSettings,
  files: string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const file of settings.composeFiles) {
    // A Compose file can be added or removed by the pull, so it may exist on one side only.
    if (!(await git("ls-tree", "--name-only", revision, "--", file))) continue;
    const text = await git("show", `${revision}:${file}`);
    found.push(...changedServices(text, file, settings.repoPath, files));
  }
  return found;
}

/** Runs Git in the repo with the deploy key, no hooks, no prompts, and none of the server's own Git settings. */
function gitIn(settings: PullConfigSettings): Git {
  const ssh = [
    "ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes",
    `-o UserKnownHostsFile=${shellQuote(settings.knownHostsFile)}`,
    `-i ${shellQuote(settings.keyFile)}`,
  ].join(" ");
  const env = {
    ...withoutGitSettings(process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: ssh,
  };
  return async (...args) => {
    const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: settings.repoPath,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  };
}

/** The environment without GIT_* variables or an ssh agent, which could point Git somewhere else. */
function withoutGitSettings(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("GIT_") && name !== "SSH_AUTH_SOCK"),
  );
}

/** Git runs GIT_SSH_COMMAND through a shell, so each path is quoted. */
function shellQuote(path: string): string {
  return `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}

async function checkReadable(path: string, what: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error();
    await access(path, constants.R_OK);
  } catch {
    throw new Refusal(`The ${what} file can't be read, so the config repo wasn't changed.`);
  }
}
