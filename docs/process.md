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
  fail the command, so `check` runs with `--error-on-warnings`. Review pinned `engines` to `24.x` and has CI read the Node
  version from it, so the version lives in one place.
- **2026-09-29**: Ticket 02 (#3), the tracer bullet. Config, the Docker Source, `list_containers` and the Server,
  test-first through three interfaces: `loadConfig`, the Tool's handler on the fake `fetch` seam, and
  the Server end to end with the MCP SDK's own client. Node 24 runs the TypeScript directly (`pnpm start`), so there
  is no build step yet. Two things the SDK taught: its transport types clash with `exactOptionalPropertyTypes`, handled
  with a commented cast at the two places it touches rather than weakening the setting; and a server with open client
  connections won't close until they're closed too. Tried by hand against a stand-in proxy serving the fixture.
  Review caught: adding the SDK as an exact, hours-old version had made pnpm write an exemption from its
  release-age check, quietly switching off a supply-chain safeguard (now 1.30.1, no exemption); a network error's own
  text could reach the Client and name the Host (now a fixed sentence plus the error code); a timeout while reading
  the body was misreported as an unexpected answer; and nothing proved the other Tools keep working after one fails.
  The Docker fixture is hand-written in Docker's shape until ticket 09 records real ones. `now` moves to the tickets
  that need it (06, 07).
- **2026-09-30**: PR descriptions changed to plain English first. The walkthroughs had become too dense to learn
  from (PR #12 opened with Streamable HTTP, SHA-256 digests and `timingSafeEqual`), so `AGENTS.md` now sets the
  order: what it does, how it works, at most four new terms, how it was checked, then the precise technical version
  folded away. PR #12's description was rewritten to match.
- **2026-09-30**: Ticket 03 (#4), Container logs and Redaction. `container_logs` reads Docker's framed and plain log
  streams into clean lines with timestamps shortened to the second; Private containers are refused before Docker is
  asked; an unknown name gets up to three close suggestions. Two safety decisions came out of building it: logs are
  only ever fetched by a name taken from the Container list, because Docker also accepts part of an ID, which would
  get round the Private check; and `PRIVATE_CONTAINERS` refuses names Docker couldn't have, since a typo such as a
  leading slash would silently protect nothing. Redaction runs once, in the Server's single `reply()`, on every
  answer and error. Log fixtures are hand-built (a framed stream with a chunk over 127 bytes and a line split across
  chunks; a plain stream with Windows line endings) and kept byte for byte by `.gitattributes`. Review caught a
  serious one: a secret-name pattern with no start anchor took cubic time, so a 20,000-character Container name
  sent by a Client would freeze the server for minutes. Every pattern is now anchored and capped, with speed tests,
  and names must match Docker's naming rule. Review also caught a dropped connection mid-answer reaching the crash
  path, and several secrets Redaction missed (base64 with a slash, header-style pairs, Basic auth).
- **2026-09-30**: Ticket 04 (#5), Disk usage. `disk_usage` reads each `DISK_PATHS` entry with `statfs`, tested
  against real temporary folders, and counts percent used as df does. A path that fails gets its own line with only
  its error code, since the path is a Host detail; the other paths are still reported. Review caught a hang: a stale
  network mount would stop the Tool, and every other path, for good. Reading a disk can't be cancelled, so each
  path now races a 10-second limit, a small `withinTimeLimit` helper tested with fake timers. Also caught: `NaN%`
  for a filesystem with no size (now 0%, tested on Linux against `/proc`), sizes like `1000 kB` from rounding after
  choosing the unit (now its own tested module), and labels that could hold any text.
- **2026-09-30**: Ticket 05 (#6), Health checks, the first optional Source. `GATUS_URL` turns Gatus on; while it's off,
  `list_health_checks` isn't offered at all (ADR 0001), checked end to end in both states. The HTTP request code moved
  out of Docker into a shared `httpRequests` helper first, with no change in behaviour, so Gatus gets the same time
  limit and plain-sentence failures. Only the latest result per Health check is asked for (`pageSize=1`), and only
  group, name, pass or fail and response time reach the Client, never Gatus's error text, which names hosts. Review
  caught: an empty `GATUS_URL`, which compose files often pass, stopped the server instead of meaning off; a refused
  connection read "failing (0 ms)", like a fast reply, now "no response"; and Gatus's real shape omits an empty group
  and can send `null` results, so the fixture now does too.
