# Architecture

How homelab-mcp is put together. The vocabulary is in [CONTEXT.md](../CONTEXT.md); the big decisions are in
[adr/](adr/).

## Stack

TypeScript on Node 24, the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), Zod, Vitest, Biome, GitHub
Actions. One pnpm package, shipped as a Docker image. No web framework: Node's own `http` server is enough for one
route.

## Modules

| Module       | What it does                                                                                                                                                                                                                                | Interface                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Config**   | Reads the environment once, checks it with Zod, and decides which optional Sources are on. A bad or half-set value stops the server at start, naming the variable.                                                                          | `loadConfig(env) → Config`                                           |
| **Docker**   | Lists Containers and reads a Container's logs through the read-only socket proxy ([ADR 0002](adr/0002-docker-through-a-read-only-proxy.md)). Hides the Docker API's shapes, including the 8-byte frame headers on log streams.               | `docker(fetch, url) → { containers(), logs(name, lines) }`           |
| **Gatus**    | Reads the Health checks and whether each is passing.                                                                                                                                                                                        | `gatus(fetch, url) → { healthChecks() }`                             |
| **Jellyfin** | Finds Media items added in the last N days, counting only film and TV libraries, and tidies names.                                                                                                                                          | `jellyfin(fetch, url, apiKey, now) → { recentMedia(days) }`          |
| **Report**   | Reads the Report file and says whether it's a Stale report.                                                                                                                                                                                 | `report(path, maxAgeHours, now) → { read() }`                        |
| **Disk**     | Space used and free for each configured path.                                                                                                                                                                                               | `disk(paths) → { usage() }`                                          |
| **Tools**    | Builds the Tool list from the Sources that are on: each Tool's name, description, input schema and handler, which formats the answer as plain text for the Client. Refuses logs for a Private container and names it as the reason.     | `buildTools(sources) → Tool[]` (plus config from ticket 03)          |
| **Redaction**| Replaces anything that looks like a Secret with `[redacted]`. Pure code.                                                                                                                                                                    | `redact(text) → text`                                                |
| **Server**   | The HTTP side: checks the Token on every request, serves MCP over Streamable HTTP, runs every Tool's output through Redaction, and logs each call. Also a `/healthz` route with no Token, for uptime checks.                                | `startServer(config, tools) → { url, close() }`                      |

`main.ts` wires them: load Config, build the Sources that are on, build the Tools, start the Server.

## Tools (phase 1)

| Tool                 | Source   | Input                         | Answer                                                             |
| -------------------- | -------- | ----------------------------- | ------------------------------------------------------------------ |
| `list_containers`    | Docker   | none                          | Each Container's name, state, status and image; stopped ones first |
| `container_logs`     | Docker   | `name`, `lines` (≤ 500)       | The last lines, redacted; refused for a Private container          |
| `disk_usage`         | Disk     | none                          | Used and free per configured path                                  |
| `list_health_checks` | Gatus    | none                          | Each Health check, failing first                                   |
| `recent_media`       | Jellyfin | `days` (1 to 30, default 1)   | Films, then episodes grouped by series                             |
| `read_report`        | Report   | none                          | The Report as written, with a warning first if it's stale          |

The last three exist only when their Source is configured ([ADR 0001](adr/0001-optional-sources-not-plugins.md)).

## Flow

1. The Client sends an MCP request to `/mcp` with `Authorization: Bearer <Token>`. A missing or wrong Token gets a
   401 and nothing else.
2. The Server hands the request to a fresh, stateless Streamable HTTP transport
   ([ADR 0003](adr/0003-streamable-http-with-a-bearer-token.md)), which calls the Tool.
3. The Tool asks its Source, which calls the system over HTTP or reads a file.
4. The Tool formats the answer; the Server runs it through Redaction and returns it.

## Safety

- **Read-only by construction.** Docker is reached through a proxy that allows only listing, inspecting and logs.
  Even a bug in this server can't change a Container.
- **Redaction at the one exit.** Every Tool's output, including error messages, passes through `redact()` in the
  Server, so a new Tool can't forget it. It catches bearer tokens, `key=value` pairs whose name suggests a Secret,
  JWTs, URLs with a password in them, and long random-looking strings.
- **Private containers for what isn't a Secret.** Redaction can't recognise personal text, such as chat logs or bank
  transactions. A Private container's logs are never returned; its status still is.
- **Nothing about the Host in the code.** Addresses, keys and names all come from config, so the public repo holds no
  detail of any real Host.

## Failures

A Source that can't be reached, times out (10 seconds) or answers with something unexpected makes its Tool return an
MCP error result with a plain sentence, such as "Gatus didn't answer within 10 seconds". The Server stays up and the
other Tools keep working. Config problems are the only thing that stops the server, and only at start.

## Config

| Variable                        | Needed                    | Meaning                                                                  |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `MCP_TOKEN`                     | Yes, 32+ characters       | The Token Clients must send                                              |
| `PORT`                          | No, default `8765`        | Where the Server listens                                                 |
| `DOCKER_URL`                    | No, default `http://socket-proxy:2375` | The read-only socket proxy                                   |
| `PRIVATE_CONTAINERS`            | No                        | Comma-separated Container names whose logs are never returned            |
| `DISK_PATHS`                    | No, default `/`           | Comma-separated `label=path` pairs, such as `data=/host/volume1`         |
| `GATUS_URL`                     | No, turns on Gatus        | Gatus's base URL                                                         |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | No, both or neither    | Turn on Jellyfin                                                         |
| `REPORT_PATH`                   | No, turns on Report       | The Report file, mounted read-only                                       |
| `REPORT_MAX_AGE_HOURS`          | No, default `26`          | Older than this is a Stale report                                        |

## Test seams

- **`fetch`**, for every Source that speaks HTTP: the real `fetch` in use, and in tests a fake that answers from
  responses recorded from a real Host (with names and Secrets replaced). One seam covers Docker, Gatus and Jellyfin.
- **`now`**, for the Stale report check and the media window: the real clock in use, a fixed date in tests.
- **No seam for files.** Disk and Report tests use real temporary files.
- **The Server** is tested end to end: a real server on a random port and the SDK's own MCP client, checking the Token,
  the Tool list and a call.

Tools are tested through their handlers, with real Sources on the fake `fetch`, so a test covers the path a real call
takes except the network.

## Phase 2: Actions (later)

Actions will run in a **second, separate container** that holds the real Docker socket and knows only the Allowlist:
pull the config repo, dry-run a Service, create and start it, reload the reverse proxy. The read-only server stays as
it is, so the everyday Tools never run with the power to change anything. Designed properly once phase 1 has been in
use for a while.
