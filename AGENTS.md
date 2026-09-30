# homelab-mcp

An MCP server that lets an AI assistant read how a self-hosted Docker homelab is doing. Read `CONTEXT.md` before
naming anything, and use its terms (and avoid its _Avoid_ lists) in code, tests, Tool descriptions and commits.

## Commands

- `pnpm verify` must pass before every commit; CI runs the same command.

## Where code goes

The modules, their interfaces, the Tools and the config are in `docs/architecture.md`. Read it before adding a file;
the decisions behind it are in `docs/adr/`.

- **Two seams only:** `fetch` and `now`, passed in. Everything else has one implementation, used directly.
- **Sources return glossary types,** never raw API JSON. A Tool formats those types into plain text for the Client.
- **Zod at every edge:** config, and every response from Docker, Gatus and Jellyfin, is parsed before use.

## Safety

This repo is public, and the server exists to read a real Host, so these hold for every change:

- **Config holds every Host detail.** Addresses, names, paths and keys come from the environment. Code, tests,
  fixtures and docs use placeholders such as `nas.example`, `media-server` and `test-token`.
- **Fixtures are scrubbed.** A response recorded from a real Host has its hostnames, IPs, Container names that identify
  a person, titles and every Secret replaced before it's committed.
- **Read-only.** Docker is reached only through the read-only socket proxy (ADR 0002); Tools only read. Actions belong
  to phase 2 and its separate container.
- **Redaction happens once, in the Server,** on every Tool's output, error messages included. A new Tool relies on it
  rather than redacting for itself; a new kind of Secret is a new pattern in `redact()` with a test.
- **Private containers are enforced in the logs Tool,** by exact Container name, before any request to Docker.

## Conventions

- **Tests are offline:** the fake `fetch` answers from recorded fixtures, `now` is a fixed date, and files are real
  temporary files. Tests are named for behaviour in plain English and go through a module's interface.
- **Write for a reader:** Jack reads every file to understand it fully. Small files, plain names, and a one-line
  comment where the why isn't obvious.

## Workflow

Tickets are GitHub Issues (`docs/agents/issue-tracker.md`).

- **One PR per ticket,** branched from `main`, never from another PR's branch.
- **Test-first,** in small commits.
- **Each PR description is written for Jack to learn from,** plain English first, in this order:
  1. **What this does:** two to four sentences with no jargon. What can the server do now that it couldn't before?
  2. **How it works:** one short paragraph per file, in reading order, in plain words.
  3. **New terms in this PR:** at most four, one line each: what it means and why it's needed here. Any other
     technical word either gets explained where it's used or moves to the technical section.
  4. **How it was checked:** tests, trying it by hand, and what review caught, each in plain words.
  5. **Technical detail:** inside a collapsed `<details>` block, the precise version for reference.
  6. **Explain it back:** one question about the main idea, answerable from the plain sections above. A harder
     question can go in the technical section as a stretch.
- **Commit and PR attribution:** commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR
  descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **After each ticket,** add a dated entry to `docs/process.md`: what was built and anything review caught.
