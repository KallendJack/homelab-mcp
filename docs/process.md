# How this project was built

A short record of the process: the order of steps, the tools used at each one, and why. The decisions themselves live
in [`docs/adr/`](adr/); this file is the story that links them.

## Why it exists

I run a NAS at home with about thirty Docker containers, looked after with the help of AI agents. I wanted Claude Code
to answer "what's broken?" or "what did we add this week?" by reading the Host directly, on my own subscription,
instead of through a separate agent paying per message. It's also the first half of a pair: this server defines the
Tools, and a companion project, runbook-eval (not started yet), will measure which models can be trusted to drive them.

## The workflow

Each step uses a skill from [Matt Pocock's skills](https://github.com/mattpocock/skills) for Claude Code, in the same
order as my earlier projects: vocabulary before design, design before tickets, tickets before code. Claude Code writes
the code; I review every PR on GitHub and answer an explain-it-back question on each.

| #   | Step                           | Skill                | What it produced                                                                                                                                                                                        |
| --- | ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Agree the vocabulary           | `domain-modeling`    | [`CONTEXT.md`](../CONTEXT.md): Host, Client, Tool, Token, Source, Private container, Health check, Media item, Report, Stale report, Redaction, and the phase 2 terms                                |
| 2   | Design modules and seams       | `codebase-design`    | [`architecture.md`](architecture.md): nine small modules, two seams (`fetch`, `now`). ADRs [0001](adr/0001-optional-sources-not-plugins.md), [0002](adr/0002-docker-through-a-read-only-proxy.md), [0003](adr/0003-streamable-http-with-a-bearer-token.md) |
| 3   | Configure the agent workflow   | `writing-for-agents` | [`AGENTS.md`](../AGENTS.md) and [`docs/agents/`](agents/): the safety rules for a public repo that reads a real Host, and GitHub Issues as the tracker                                               |
| 4   | Write the spec and tickets     | `to-tickets`         | [`spec.md`](spec.md): phase 1's behaviour and what's out of scope, written by hand; `to-tickets` turned its ticket list into GitHub Issues #2-#10 with their blocking edges |
| 5   | Build ticket by ticket         | `implement` + `tdd`  | One branch and PR per Issue, test-first, CI on every PR                                                                                                                                                 |
| 6   | Review each ticket             | `code-review`        | Standards and spec review before each PR                                                                                                                                                                |

## Log

- **2026-09-29**: Vocabulary and design. Three questions settled the shape: a middle ground between "my homelab" and a
  general tool (optional Sources built in, [ADR 0001](adr/0001-optional-sources-not-plugins.md)); a Private
  containers list, because Redaction can't recognise personal text; and a Stale report is returned with a warning
  rather than silently. Planning reviewed as one PR on GitHub before any code.
- **2026-09-29**: Ticket 01 (#2), the scaffold. TypeScript 7, Biome, Vitest 5 and `pnpm verify`, run by GitHub
  Actions on every PR. Node 24 rather than the planned 22: it's the current long-term-support release. Proving
  `verify` fails on each kind of problem caught one gap: Biome reports an unused variable as a warning, which doesn't
  fail the command, so `check` runs with `--error-on-warnings`.
