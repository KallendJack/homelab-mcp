# homelab-mcp

An MCP server that lets an AI assistant, such as Claude Code, see how a self-hosted Docker homelab is doing:
containers, logs and disk, plus Gatus health checks, Jellyfin's new media, the Sonarr and Radarr download queues,
Jellyseerr search, Dispatcharr's live TV Channels and Guide, and a daily Report when those are set up. It only
reads, through a Docker socket proxy, so nothing it does can change a container.

An optional second container runs the same image in [admin mode](#4-admin-mode-optional), for changes the person
approves one by one: deploys from the config repo, starting a stopped container, reloading the reverse proxy, and
fixing or requesting media.

How it's built is in [`docs/architecture.md`](docs/architecture.md), the vocabulary in [`GLOSSARY.md`](GLOSSARY.md),
and the decisions in [`docs/adr/`](docs/adr/).

## Tools

| Tool                 | What the Client gets                                                                 | Needs                                       |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `list_containers`    | Every container's state, status and image, the ones needing attention first          | Always on                                   |
| `container_logs`     | A container's latest log lines (up to 500), after Redaction                          | Always on                                   |
| `disk_usage`         | Percent used, and space used, free and total, for each configured path               | Always on                                   |
| `list_health_checks` | Each Gatus check, failing first, with its latest response time                       | `GATUS_URL`                                 |
| `recent_media`       | Films and episodes added to Jellyfin in the last 1 to 30 days                        | `JELLYFIN_URL` and `JELLYFIN_API_KEY`       |
| `download_queue`     | Sonarr and Radarr downloads, problems first, with each app's own message             | `SONARR_*` or `RADARR_*` pair               |
| `import_candidates`  | What a manual import would do with one download: each file's match and quality       | `SONARR_*` or `RADARR_*` pair               |
| `search_media`       | Up to 10 Jellyseerr matches for a name, with whether each is available or requested  | `JELLYSEERR_URL` and `JELLYSEERR_API_KEY`   |
| `find_channel`       | Up to 10 live TV Channels for a name: Guide link, Streams in order, channel profiles | `DISPATCHARR_URL` and `DISPATCHARR_API_KEY` |
| `search_guide`       | Programmes on now or coming up whose title matches, with the Channels showing them   | `DISPATCHARR_URL` and `DISPATCHARR_API_KEY` |
| `m3u_accounts`       | Each live TV provider account: status, connections and expiry, naming any due soon   | `DISPATCHARR_URL` and `DISPATCHARR_API_KEY` |
| `read_report`        | Your scheduled status file as written, with a warning if it's out of date            | `REPORT_PATH`                               |

Admin mode's Actions:

| Action             | What it does                                                                | Needs                                                 |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `pull_config`      | Fast-forwards the config repo and says which Services' files changed        | Admin mode                                            |
| `preview_service`  | A dry run of recreating one Service                                         | Admin mode                                            |
| `recreate_service` | Pulls one Service's image and recreates only that Service                   | Admin mode                                            |
| `start_container`  | Starts a stopped Container                                                  | Admin mode                                            |
| `reload_proxy`     | Runs the reverse proxy's reload command                                     | `ADMIN_PROXY_CONTAINER`, `ADMIN_PROXY_RELOAD_COMMAND` |
| `retry_download`   | Blocklists a stuck or failed download and has Sonarr or Radarr search again | `SONARR_*` or `RADARR_*` pair                         |
| `manual_import`    | Imports a download's matched files and lists the skipped ones               | `SONARR_*` or `RADARR_*` pair                         |
| `request_media`    | Requests a film, or a series' seasons, in Jellyseerr                        | `JELLYSEERR_URL` and `JELLYSEERR_API_KEY`             |

What each Tool and Action does, and refuses, is in [the architecture](docs/architecture.md#read-tools).

## Safety

- **Read-only by setup, not just by code.** Docker is reached only through a socket proxy that allows listing,
  inspecting and logs. Mounting `/var/run/docker.sock` with `:ro` is **not** read-only: it stops the file being
  replaced, not the API calls made through it ([ADR 0002](docs/adr/0002-docker-through-a-read-only-proxy.md)).
- **A Token on every request.** Requests without it get a bare 401 ([ADR 0003](docs/adr/0003-streamable-http-with-a-bearer-token.md)).
  Store the Token like any other Secret, and keep the server on your home network or tailnet; it isn't built to face
  the internet.
- **Redaction.** Everything the server returns, error messages included, has anything that looks like a Secret (a
  password, token or key) replaced with `[redacted]` first.
- **Private containers.** Name containers whose logs hold personal text (a chat bridge, a finance tracker) in
  `PRIVATE_CONTAINERS`, and their logs are never returned. Redaction can't recognise personal text; this can.

## Setup

Every path, container name and address below is an example: swap in your own.

### 1. A read-only Docker socket proxy

If you don't already run one, add [LinuxServer's socket-proxy](https://docs.linuxserver.io/images/docker-socket-proxy/)
with only these permissions:

```yaml
services:
  socket-proxy:
    image: lscr.io/linuxserver/socket-proxy:latest
    environment:
      CONTAINERS: 1 # list and inspect containers
      INFO: 1
      ALLOW_LOGS: 1 # read logs
      POST: 0 # nothing that changes anything
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    read_only: true
    tmpfs:
      - /run
```

Don't publish its port to your network: homelab-mcp reaches it by name on a shared Docker network.

### 2. The server

A Token is any random string of at least 32 characters, such as the output of `openssl rand -hex 32`.

```yaml
services:
  homelab-mcp:
    image: ghcr.io/kallendjack/homelab-mcp:0.3.0
    environment:
      MCP_TOKEN: ${MCP_TOKEN:?}
      DOCKER_URL: http://socket-proxy:2375
      # Each label=path is a folder mounted below. root=/ is the container's own disk.
      DISK_PATHS: data=/host/data,root=/
      PRIVATE_CONTAINERS: chat-bridge,finance
      # Optional Sources: leave out any you don't run.
      GATUS_URL: http://gatus:8080
      JELLYFIN_URL: http://jellyfin:8096
      JELLYFIN_API_KEY: ${JELLYFIN_API_KEY:?}
      REPORT_PATH: /reports/daily.txt
    volumes:
      # Only what the server reads, and read-only.
      - /srv/data:/host/data:ro
      - /srv/reports:/reports:ro
    ports:
      - 8765:8765
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
```

Put it on the same Docker network as the socket proxy and any optional Sources. The image already has a healthcheck
(`/healthz`), runs as a non-root user and needs no writable filesystem.

### 3. Connect Claude Code

```sh
claude mcp add --transport http homelab http://nas.example:8765/mcp --header "Authorization: Bearer <your-token>"
```

Then ask things like "is anything unhealthy on the homelab?" or "why did the media server restart last night?".

### 4. Admin mode (optional)

Admin mode is a **second container from the same image** that offers only the Actions above. It holds Docker's real
socket, which is as powerful as root on the Host, so keep the read-only server for everyday questions and give this
one only to a Client that asks before each Action.

```yaml
services:
  homelab-mcp-admin:
    image: ghcr.io/kallendjack/homelab-mcp:0.3.0
    environment:
      MCP_TOKEN: ${MCP_TOKEN:?}
      ADMIN_TOKEN: ${ADMIN_TOKEN:?}
      # The config repo, mounted at the same path it has on the Host: Compose resolves bind mounts there.
      ADMIN_REPO_PATH: /srv/stacks
      ADMIN_COMPOSE_FILES: proxy/compose.yaml,media/compose.yaml
      ADMIN_SERVICE: homelab-mcp-admin
      ADMIN_DEPLOY_KEY_FILE: /run/secrets/deploy-key
      ADMIN_KNOWN_HOSTS_FILE: /run/secrets/known-hosts
      # Optional: reload_proxy, and a Notification for every Action.
      ADMIN_PROXY_CONTAINER: caddy
      ADMIN_PROXY_RELOAD_COMMAND: caddy reload --config /etc/caddy/Caddyfile
      NTFY_URL: https://ntfy.sh
      NTFY_TOPIC: ${NTFY_TOPIC:?}
      # Optional: the media Actions, with the same settings as the read-only server.
      SONARR_URL: http://sonarr:8989
      SONARR_API_KEY: ${SONARR_API_KEY:?}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /srv/stacks:/srv/stacks
      - /srv/secrets/homelab-mcp-admin:/run/secrets:ro
    # The socket's group, so the unprivileged user can use it: `stat -c %g /var/run/docker.sock` on the Host.
    group_add: ["<socket gid>"]
    ports:
      - 8766:8765
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
```

- **The deploy key:** a GitHub deploy key with read access only, for the config repo. Its file must be owned by uid
  1000 and mode 600, or ssh refuses it. Generate it with `ssh-keygen -t ed25519 -f deploy-key -N ""` and add the
  `.pub` half under the repo's Settings → Deploy keys.
- **Known hosts:** GitHub's published SSH keys, from
  [GitHub's docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints),
  written as `github.com <type> <key>` lines. Checked in advance, so a pull can't be redirected.
- **The config repo** must be cloned over SSH (`git@github.com:...`) and owned by uid 1000, the image's user. A NAS
  share's ACL can still refuse that uid on its own: if `docker exec homelab-mcp-admin ls <repo path>` says
  "Permission denied", add the group the share grants (often the owner's own group) to `group_add`.
- **Its own Service:** `recreate_service` refuses it, since recreating yourself kills the request doing it. Update
  this container from the Host.

Connect it under a different name from the read-only server, with its own Token:

```sh
claude mcp add --transport http homelab-admin http://nas.example:8766/mcp --header "Authorization: Bearer <admin-token>"
```

**Never pre-approve its Tools** (for example, don't add `mcp__homelab-admin__*` to Claude Code's allowed tools).
Each Action is marked as changing the Host, so the Client asks the person before every call. That question is the
approval: the server only narrows, previews, logs and notifies.

## Config

Everything comes from environment variables. A bad or half-set value stops the server at start, with a message naming
the variable but never its value. An empty value counts as unset, so `NAME: ${NAME:-}` in a Compose file is fine.

| Variable                                              | Needed                                                   | Meaning                                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_TOKEN`                                           | Yes, 32+ characters                                      | The Token clients must send as `Authorization: Bearer <token>`                                                                                                  |
| `PORT`                                                | No, default `8765`                                       | Where the server listens                                                                                                                                        |
| `DOCKER_URL`                                          | No, default `http://socket-proxy:2375`                   | The read-only socket proxy                                                                                                                                      |
| `PRIVATE_CONTAINERS`                                  | No                                                       | Comma-separated container names whose logs are never returned                                                                                                   |
| `DISK_PATHS`                                          | No, default `root=/`                                     | Comma-separated `label=path` pairs: different one-word labels, absolute paths without `=` or `,`                                                                |
| `GATUS_URL`                                           | No, turns on Gatus                                       | Gatus's base URL                                                                                                                                                |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY`                    | No, both or neither                                      | Turn on Jellyfin. The key is only ever sent in a header                                                                                                         |
| `SONARR_URL`, `SONARR_API_KEY`                        | No, both or neither                                      | Turn on Sonarr. The key is only ever sent in a header                                                                                                           |
| `RADARR_URL`, `RADARR_API_KEY`                        | No, both or neither                                      | Turn on Radarr. The key is only ever sent in a header                                                                                                           |
| `JELLYSEERR_URL`, `JELLYSEERR_API_KEY`                | No, both or neither                                      | Turn on Jellyseerr: `search_media`, and `request_media` in admin mode. The key is only ever sent in a header                                                    |
| `DISPATCHARR_URL`, `DISPATCHARR_API_KEY`              | No, both or neither                                      | Turn on Dispatcharr: `find_channel`, `search_guide` and `m3u_accounts`. The key is only ever sent in a header, and these Tools only read                        |
| `REPORT_PATH`                                         | No, turns on the Report                                  | The Report file's absolute path, mounted read-only                                                                                                              |
| `REPORT_MAX_AGE_HOURS`                                | No, default `26`; only with `REPORT_PATH`                | Whole hours; an older Report gets a warning                                                                                                                     |
| `ADMIN_TOKEN`                                         | No, turns on admin mode; 32+ characters, not `MCP_TOKEN` | The Token for admin mode. The server then offers only the Allowlist, and no read Tool                                                                           |
| `ADMIN_REPO_PATH`                                     | In admin mode                                            | The config repo's absolute path, the same inside the container as on the Host                                                                                   |
| `ADMIN_COMPOSE_FILES`                                 | In admin mode                                            | Comma-separated `.yaml` or `.yml` paths inside the config repo, such as `proxy/compose.yaml`                                                                    |
| `ADMIN_SERVICE`                                       | In admin mode                                            | The admin server's own Service, which it never recreates                                                                                                        |
| `ADMIN_DEPLOY_KEY_FILE`                               | In admin mode                                            | Absolute path to a read-only deploy key for the config repo, mounted as a Secret file. Only the path is read; Git's ssh reads the key                           |
| `ADMIN_KNOWN_HOSTS_FILE`                              | In admin mode                                            | Absolute path to a known_hosts file holding the Git host's SSH key (for GitHub, from its published keys), so a pull only talks to the real host                 |
| `ADMIN_PROXY_CONTAINER`, `ADMIN_PROXY_RELOAD_COMMAND` | No, both or neither; turn on `reload_proxy`              | The reverse proxy's Container and its own reload command as words, such as `caddy reload --config /etc/caddy/Caddyfile`. Fixed here, never chosen by the Client |
| `NTFY_URL`, `NTFY_TOPIC`                              | No, both or neither, admin mode only                     | Where every Action's Notification goes. On a public ntfy server the topic is the only Secret: anyone with it can read the messages or send fakes                |
| `ADMIN_DOCKER_SOCKET`                                 | No, default `/var/run/docker.sock`                       | Docker's own socket, mounted into the admin container only. Never give it to the read-only one (ADR 0002)                                                       |

## Development

Needs Node 24 and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm verify   # lint and format check, types, tests: what CI runs on every PR
pnpm start    # runs the server; set MCP_TOKEN first
```

Releases: bump `version` in `package.json`, merge, then push a matching tag (`git tag v0.1.0 && git push origin v0.1.0`).
CI smoke-tests the image and publishes it to `ghcr.io/kallendjack/homelab-mcp:<version>`.

## Code layout

| Folder                                  | What's in it                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| [`src/`](src/)                          | The server. Its top level ties the folders below together.                      |
| [`src/admin/`](src/admin/README.md)     | The Actions that change the Host's Services and Config repo, and the Allowlist. |
| [`src/media/`](src/media/README.md)     | The Tools and Actions about films, series and downloads.                        |
| [`src/live-tv/`](src/live-tv/README.md) | The Tools about live TV Channels, the Guide and provider accounts.              |
| [`src/sources/`](src/sources/README.md) | One module per system the server talks to.                                      |
| [`src/testing/`](src/testing/README.md) | Fakes shared by the offline tests.                                              |
| [`fixtures/`](fixtures/README.md)       | The recorded and hand-written answers the tests' fake `fetch` gives.            |
| [`docs/`](docs/)                        | The architecture, the ADRs, and the config Matt Pocock's skills read.           |

The top of `src/` holds `main.ts` (start-up), `config.ts`, `server.ts`, `tools.ts` (the read Tools), `redaction.ts`,
`read-report.ts` (`read_report`'s wording), and the small shared helpers `refusal.ts`, `bytes.ts`, `wording.ts` and
`closest-names.ts`.

### Where a new Tool goes

Keep related Tools and Actions together by subject. For example, [manual-import.ts](src/media/manual-import.ts)
holds both the Tool that previews an import and the Action that performs it. The code that talks to Sonarr
and Radarr and parses their responses lives in [arr.ts](src/sources/arr.ts). Put behaviour tests beside the
module they cover and sample responses under `fixtures/` in the folder for the system that returned them.

Register a read Tool in [tools.ts](src/tools.ts). Wire an Action into the [Allowlist](src/admin/allowlist.ts)
in [main.ts](src/main.ts), including when the Action lives in a subject folder such as `src/media/`.

Start a subject folder when a feature introduces related Tools with their own vocabulary. For example, when
live TV Tools for Channels and the Guide land, their handlers can live in `src/live-tv/` and the code that
talks to Dispatcharr in `src/sources/`. Add the folder with the first implementation.
