# Architecture

How homelab-mcp is put together today. The terms are in [GLOSSARY.md](../GLOSSARY.md), the decisions in
[adr/](adr/), and the config variables in the [README](../README.md#config).

## Stack

TypeScript run directly by Node 24 (no build step), the official MCP TypeScript SDK, Zod, Vitest and Biome, with
`yaml` for reading Compose files. One pnpm package, shipped as one Docker image. Node's own `http` server serves the
one MCP route.

## Two containers, one image

- **The read-only server** offers the read Tools. It reaches Docker only through a socket proxy that allows listing,
  inspecting and logs ([ADR 0002](adr/0002-docker-through-a-read-only-proxy.md)), so even a bug in it can't change a
  Container.
- **Admin mode** starts when `ADMIN_TOKEN` is set. It holds Docker's real socket and offers only the Allowlist, never
  a read Tool. It needs its own Token; config refuses the read-only Token as the admin one, since one Token would let
  any read-only Client perform Actions.

Deleting data, pruning, running arbitrary commands, editing files and stopping Services are never Actions: they stay
with a person at the Host.

`main.ts` loads Config, builds the Sources that are on, builds the Tools (or the Allowlist), and starts the Server.
Each optional Source is on when its settings are set, and its Tools exist only while it's on
([ADR 0001](adr/0001-optional-sources-not-plugins.md)).

## Modules

| Module | What it does | Interface |
| --- | --- | --- |
| **Config** | Reads the environment once and checks it with Zod. Empty counts as unset. A bad or half-set value stops the server at start, naming the variable, never its value. | `loadConfig(env) → Config` |
| **Server** | Checks the Token on every request (constant time; a bare 401 otherwise), serves MCP over stateless Streamable HTTP ([ADR 0003](adr/0003-streamable-http-with-a-bearer-token.md)), runs every answer and error through Redaction, and logs each call (see [Logs](#logs)). `/healthz` answers without a Token. | `startServer(config, tools) → { url, close() }` |
| **Tools** | The read Tools of the Sources that are on: name, description, input schema, and a handler that formats plain text for the Client. | `buildTools(sources, { privateContainers }) → Tool[]` |
| **Allowlist** | Turns Actions into admin mode's Tools: marks each as changing the Host, so the Server logs its arguments and answer, runs one at a time, applies its time limit, and sends its Notification. Also the admin start-up line. | `allowlist(actions, { notifier }) → Tool[]` |
| **Redaction** | Replaces anything that looks like a Secret with `[redacted]`. Pure code. | `redact(text) → text` |
| **Docker** | Containers and their logs through the proxy, hiding the 8-byte frame headers on log streams. In admin mode, also start and exec. | `docker(fetch, url)`, `dockerAdmin(fetch, url)` |
| **Compose** | Runs `docker compose` against one Compose file: config hashes, the dry run, and the recreate. | `compose(settings)` |
| **Disk** | Space used and free for each configured path. | `disk(paths) → { usage() }` |
| **Gatus** | Each Health check's latest result. | `gatus(fetch, url) → { healthChecks() }` |
| **Jellyfin** | Media items added in the last N days, from film and TV libraries only. | `jellyfin(fetch, url, apiKey, now)` |
| **Sonarr / Radarr** | One module for both (the same v3 API): the queue as Queue items, removing a download, and manual import. | `arr(fetch, url, apiKey, app)` |
| **Jellyseerr** | Searching Listings, reading one with each season's availability, and sending a Request. | `jellyseerr(fetch, url, apiKey)` |
| **Report** | The Report file and whether it's a Stale report. | `report(path, maxAgeHours, now) → { read() }` |
| **ntfy** | Sends a Notification. | `ntfy(fetch, url, topic)` |

What each file holds is in the [code layout](../README.md#code-layout) and its folder READMEs.

## A call, end to end

1. The Client sends an MCP request to `/mcp` with `Authorization: Bearer <Token>`. A missing or wrong Token gets a
   401 and nothing else.
2. The Server hands it to a fresh, stateless Streamable HTTP transport, which calls the Tool.
3. The Tool asks its Source, which calls the system over HTTP or reads a file.
4. The Tool formats the answer; the Server runs it through Redaction and returns it.

## Seams

Only two, both passed in:

- **`fetch`**, for every Source that speaks HTTP. Admin mode reaches Docker's own socket through `socketFetch`, a
  `fetch` over a local socket, so the Docker Source keeps the same seam.
- **`now`**, for the Stale report check and the media window.

Everything else has one implementation, used directly. Disk and Report read real files; tests use temporary ones.
Compose is a real process; tests run a fake `docker compose` script chosen by the command in its settings.

## Read Tools

| Tool | Source | What it does |
| --- | --- | --- |
| `list_containers` | Docker | Every Container with its state, status and image. Stopped, restarting and unhealthy ones come first, then by name. |
| `container_logs` | Docker | The last `lines` lines (default 100, at most 500), stdout and stderr in order, with timestamps. Refuses a Private container before Docker is asked. Logs are only fetched by a name taken from the Container list, since Docker also accepts part of an ID; an unknown name gets the closest names. |
| `disk_usage` | Disk | Percent used, and space used, free and total, per configured path. Percent is counted as df counts it. |
| `list_health_checks` | Gatus | Each Health check's group, name, pass or fail, and latest response time; failing first. Gatus's own error text is never returned, since it names hosts. |
| `recent_media` | Jellyfin | Media items added in the last `days` days (1 to 30, default 1): films with their year, then episodes grouped by series. Folder tags such as `{tvdb-438604}` are removed. |
| `download_queue` | Sonarr, Radarr | Both queues together, problems first (failed, import blocked or pending, stalled), then downloading with progress. Each line starts with the app and the queue id the Actions take; an empty queue says so. A season pack is grouped into one download showing its worst episode's state. One app that can't be read becomes a sentence above the other's list. |
| `import_candidates` | Sonarr, Radarr | For one download, each video file with what the app matched, its quality and any rejection reasons. Imports nothing. |
| `search_media` | Jellyseerr | Up to 10 films and series for a name, with availability (available, partly available, requested, not requested) and the id `request_media` needs. Every reserved character in the query is encoded, since Jellyseerr refuses them otherwise. |
| `read_report` | Report | The Report exactly as written, with when it was written, and a warning first if it's stale. Capped at 200 kB; a missing file is a plain error. |

## Actions

Each is offered in admin mode only, and only when its settings are on.

| Action | What it does |
| --- | --- |
| `pull_config` | Fast-forwards the Config repo to its remote's default branch with the read-only deploy key, and returns the old and new commit, the changed files and the Services they affect. Refuses, changing nothing, with local changes or a history that has moved apart. |
| `preview_service` | A Dry run: what recreating one Service would create, recreate or leave alone. What changes comes from Compose's config hash against each Container's label; Compose's own dry-run text is shown, not parsed. An unknown Service gets the closest names. |
| `recreate_service` | Pulls the Service's image and recreates only that Service (`--no-deps`), then waits up to two minutes for it to be running, and healthy if it has a healthcheck. Refuses if other Services would be disturbed (sharing its network, or restarting with it), and refuses admin mode's own Service. |
| `start_container` | Starts a stopped Container. Refuses one already running, or unknown (with the closest names). |
| `reload_proxy` | Runs the reverse proxy's reload command, fixed in config, in its Container through Docker's exec, and says whether the new config was accepted. A rejected config leaves the old one running, and the answer says why. |
| `retry_download` | Removes one download from Sonarr's or Radarr's queue and the download client, blocklists the release, naming it, and asks the app to search again (saying whether the app's Redownload Failed setting is on). Refuses a download whose files have already arrived, pointing to `manual_import`, unless `discard_downloaded` is set. |
| `manual_import` | Imports a download's matched files with no rejections, lists the skipped files with their reasons, and follows the import to its end. Refuses when no file can be imported. |
| `request_media` | Requests a film, or a series' seasons (every season unless named), in Jellyseerr. Refuses what's already available or requested; for a series, leaves out the seasons already there and says which. Specials are never requested. |

Every Action:

- **Is approved by the person in the Client.** It's marked with `destructiveHint`, so the Client asks before each
  call. The server narrows, previews, logs and notifies; the README says never to pre-approve these Tools.
- **Runs one at a time.** A second call while one runs is refused, naming it. The lock lives in the Allowlist,
  since the Server builds a fresh MCP server per request.
- **Has a time limit:** one minute, five for `recreate_service`. Past it the Client is told the Host may be part-way
  through, and the lock is held until the work really ends.
- **Sends one Notification** when it really ends, with Notifications on. One that can't be sent is logged and
  doesn't fail the Action.

## Logs

- **At start**, the read-only server logs which Sources are on and the Private containers; admin mode logs the
  Allowlist, the Config repo path, whether Notifications are on and which media Sources are on. Never a Secret.
- **Each call** is logged with its name, how long it took and whether it succeeded. A read Tool's arguments are logged
  only for `container_logs` (the Container name), and its answer never; an Action's arguments and whole answer are
  logged on one line. A Refusal can carry a detail for the log only, such as Git's own error.

## Safety

- **Nothing about a real Host in the repo.** Addresses, names, paths and keys come from config. Code, tests,
  fixtures and docs use placeholders such as `nas.example`, `media-server` and `test-token`, and a response recorded
  from a real Host has its hostnames, IPs, identifying names, titles and Secrets replaced before it's committed.
- **Redaction at the one exit.** The Server redacts every Tool's output and error, and what it logs about each
  call, so a new Tool relies on it; the Allowlist redacts each Notification. It catches bearer tokens, `key=value` and `"key": "value"` pairs whose name suggests a
  Secret, JWTs, URLs with a password, and long random-looking strings. Every pattern is anchored and capped, so a
  long input can't make it slow; a new kind of Secret is a new pattern with a test.
- **Private containers for what isn't a Secret.** Redaction can't recognise personal text. A Private container's
  logs are never returned, checked by exact name before Docker is asked; its status still is.
- **Secrets kept out of answers.** API keys go only in headers. Git's and ntfy's failures become fixed sentences,
  since their text can name the remote or the topic; a Refusal can carry a detail for the server's log only.

## Failures

A Source that can't be reached, takes over 10 seconds, or answers with something unexpected makes its Tool return an
MCP error with a plain sentence, such as "Gatus didn't answer within 10 seconds". The Server stays up and the other
Tools keep working. Docker writes and some media writes wait for the Action's time limit instead of 10 seconds.
Config problems are the only thing that stops the server, and only at start.

`disk_usage` reads several paths, so a path that fails or doesn't answer within 10 seconds (a hung network mount)
gets its own line, and the others are still reported.

## Tests

Tests are offline: the fake `fetch` answers from the [fixtures](../fixtures/README.md), `now` is a fixed date, and
files are real temporary files. Tools are tested through their handlers, with real Sources on the fake `fetch`. The
Server is tested end to end: a real server on a random port and the SDK's own MCP client.
