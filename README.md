# homelab-mcp

An MCP server that lets an AI assistant, such as Claude Code, see how a self-hosted Docker homelab is doing:
containers, logs and disk, plus Gatus health checks, recently added Jellyfin media and a daily Report when those are
set up. It only reads, through a Docker socket proxy, so nothing it does can change a container.

The design is in [`docs/architecture.md`](docs/architecture.md), the vocabulary in [`CONTEXT.md`](CONTEXT.md), and how
it was built in [`docs/process.md`](docs/process.md).

## Tools

| Tool                 | What the AI gets                                                              | Needs                                 |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `list_containers`    | Every container's state, status and image, the ones needing attention first  | Always on                             |
| `container_logs`     | A container's latest log lines (up to 500), with secrets blanked              | Always on                             |
| `disk_usage`         | Percent used, and space used, free and total, for each configured path       | Always on                             |
| `list_health_checks` | Each Gatus check, failing first, with its latest response time               | `GATUS_URL`                           |
| `recent_media`       | Films and episodes added to Jellyfin in the last 1 to 30 days                 | `JELLYFIN_URL` and `JELLYFIN_API_KEY` |
| `read_report`        | Your scheduled status file as written, with a warning if it's out of date    | `REPORT_PATH`                         |

## Safety

- **Read-only by setup, not just by code.** Docker is reached only through a socket proxy that allows listing,
  inspecting and logs. Mounting `/var/run/docker.sock` with `:ro` is **not** read-only: it stops the file being
  replaced, not the API calls made through it ([ADR 0002](docs/adr/0002-docker-through-a-read-only-proxy.md)).
- **A Token on every request.** Requests without it get a bare 401 ([ADR 0003](docs/adr/0003-streamable-http-with-a-bearer-token.md)).
  Keep the server on your home network or tailnet; it isn't built to face the internet.
- **Redaction.** Everything the server returns, error messages included, has anything that looks like a password,
  token or key replaced with `[redacted]` first.
- **Private containers.** Name containers whose logs hold personal text (a chat bridge, a finance app) in
  `PRIVATE_CONTAINERS`, and their logs are never returned. Redaction can't recognise personal text; this can.

## Setup

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

A Token is any random string of at least 32 characters, such as the output of `openssl rand -hex 32`. Store it like
any other secret.

```yaml
services:
  homelab-mcp:
    image: ghcr.io/kallendjack/homelab-mcp:0.1.0
    environment:
      MCP_TOKEN: ${MCP_TOKEN:?}
      DOCKER_URL: http://socket-proxy:2375
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

## Config

Everything comes from environment variables. A bad or half-set value stops the server at start, with a message naming
the variable but never its value.

| Variable                           | Needed                                 | Meaning                                                                                         |
| ---------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `MCP_TOKEN`                        | Yes, 32+ characters                    | The Token clients must send as `Authorization: Bearer <token>`                                  |
| `PORT`                             | No, default `8765`                     | Where the server listens                                                                        |
| `DOCKER_URL`                       | No, default `http://socket-proxy:2375` | The read-only socket proxy                                                                      |
| `PRIVATE_CONTAINERS`               | No                                     | Comma-separated container names whose logs are never returned                                   |
| `DISK_PATHS`                       | No, default `root=/`                   | Comma-separated `label=path` pairs. Labels are one word each; paths are absolute, as mounted    |
| `GATUS_URL`                        | No, turns on Gatus                     | Gatus's base URL                                                                                |
| `JELLYFIN_URL`, `JELLYFIN_API_KEY` | No, both or neither                    | Turn on Jellyfin. The key is only ever sent in a header                                         |
| `REPORT_PATH`                      | No, turns on the Report                | The Report file, mounted read-only                                                              |
| `REPORT_MAX_AGE_HOURS`             | No, default `26`; only with `REPORT_PATH` | Whole hours; an older Report gets a warning                                                  |

An empty value counts as unset, so `NAME: ${NAME:-}` in a Compose file is fine.

## Development

Needs Node 24 and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm verify   # lint and format check, types, tests: what CI runs on every PR
pnpm start    # runs the server; set MCP_TOKEN first
```

Releases: bump `version` in `package.json`, merge, then push a matching tag (`git tag v0.1.0 && git push --tags`).
CI smoke-tests the image and publishes it to `ghcr.io/kallendjack/homelab-mcp:<version>`.
