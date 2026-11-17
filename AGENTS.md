# homelab-mcp

An MCP server that lets an AI assistant read how a self-hosted Docker homelab is doing, with an optional admin mode for
approved deploys. Read `GLOSSARY.md` before
naming anything, and use its terms (and avoid its _Avoid_ lists) in code, tests, Tool descriptions and commits.

## House rules

From `KallendJack/house`, `rules/base.md`. House version: 0.8.0, reviewed against Matt's skills 1.3.2.
Change shared rules in House; keep project-specific rules below this section.

- **Workflow:** use Matt Pocock's skills directly; `ask-matt` routes when unsure. His rules take precedence over
  House. The owner chooses the work.
- **Work tracking:** planned work and bugs live where `docs/agents/issue-tracker.md` says. Small incidental fixes
  can go straight into a PR. Milestones group deliverable outcomes; blocking links express dependencies.
- **Checks:** run the repo's checks before pushing. Fix failing CI before calling a PR ready; merge requires
  green checks and review against the requested change.
- **Docs:** `README.md` explains the project; `AGENTS.md` holds agent instructions; `CLAUDE.md` points to it.
  Matt's setup owns the tracker and domain-document pointers in `docs/agents/`. Update docs with the change.
- **Secrets:** values come from the environment, names from `.env.example`. Public examples and fixtures use
  made-up data.
- **Communication:** plain words, concise explanations, and evidence appropriate to the change.
- **App code:** before writing or changing code, read `docs/agents/code.md`.
- **Project rules** below add to these conventions and override House where explicitly stated.

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

Use Matt's skills and the tracker conventions in `docs/agents/issue-tracker.md`.
Keep explanations accessible to a reader learning the codebase. Record meaningful implementation lessons in
`docs/process.md` when they add context beyond the issue and PR.

## Agent skills

### Issue tracker

GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Matt's five default labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
