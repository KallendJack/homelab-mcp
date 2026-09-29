# Phase 1 spec: read-only

What phase 1 does, in behaviour a test can check. Terms are from [`CONTEXT.md`](../CONTEXT.md); modules and config are
in [`architecture.md`](architecture.md).

## Connecting

1. A Client that sends the right Token to `/mcp` can list the Tools and call them.
2. A request with no Token or a wrong one gets a 401 and no other information. Tokens are compared in constant time.
3. `/healthz` answers 200 with no Token, for uptime checks, and reveals nothing about the Host.
4. The Tool list contains only the Tools whose Source is on.
5. Each Tool has a description a model can act on: what it returns, and when to use it rather than another Tool.

## Config

6. The server won't start without a Token of at least 32 characters.
7. A malformed value (a `DISK_PATHS` pair without `=`, a non-numeric `REPORT_MAX_AGE_HOURS`) stops the server at
   start with a message naming the variable, never its value.
8. Setting only one of `JELLYFIN_URL` and `JELLYFIN_API_KEY` stops the server at start.
9. At start, the server logs which Sources are on and which Private containers are set, and no Secret.

## Tools

**`list_containers`**

10. Returns every Container, running or not, with its name, state, status text and image.
11. Stopped, restarting and unhealthy Containers come first, then the rest by name.

**`container_logs`**

12. Returns the last `lines` lines (default 100, at most 500) of a Container's logs, stdout and stderr interleaved in
    order, with timestamps.
13. Refuses a Private container, saying it's private, without contacting Docker.
14. Refuses an unknown Container name and lists the closest names that exist.
15. Handles Docker's framed log format and plain text alike, so no stray header bytes reach the Client.

**`disk_usage`**

16. Returns used, free and total space, and percent used, for each configured path, in human units.

**`list_health_checks`** (Gatus on)

17. Returns each Health check's group, name, whether it's passing, and its latest response time. Failing ones come
    first.

**`recent_media`** (Jellyfin on)

18. Returns Media items added in the last `days` days (default 1, 1 to 30): films with their year, then episodes
    grouped by series with their season and episode numbers.
19. Counts only libraries whose type is films or TV, so placeholder libraries never appear.
20. Removes folder tags such as `{tvdb-438604}` from names.

**`read_report`** (Report on)

21. Returns the Report exactly as written, with the time it was written.
22. For a Stale report, starts with a warning saying how old it is.
23. A missing Report file is an error result saying so, not a crash.

## Everywhere

24. Every Tool's output, and every error message, passes through Redaction before it leaves the server.
25. Redaction replaces bearer tokens, `key=value` and `"key": "value"` pairs whose key suggests a Secret, JWTs, URLs
    with a password, and long random-looking strings, and leaves ordinary log text readable.
26. A Source that can't be reached, takes over 10 seconds or answers unexpectedly gives an error result with a plain
    sentence; the other Tools keep working.
27. Each Tool call is logged with its name, how long it took and whether it succeeded; arguments are logged only for
    `container_logs` (the Container name).

## Out of scope for phase 1

- Actions of any kind (phase 2).
- OAuth, public exposure, and the Claude apps' hosted connectors (ADR 0003).
- Metrics history, charts or alerts: Gatus and the Host's own tools do those.
- Container details beyond the list (inspect, stats), and log search.
- A plugin interface for new Sources (ADR 0001).

## Tickets

Each becomes a GitHub Issue once this spec is merged.

| #   | Ticket                          | Delivers                                                                                                                                                                  | Behaviour  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 01  | Scaffold and CI                 | pnpm, TypeScript, Biome, Vitest, `pnpm verify`, GitHub Actions running it on every PR                                                                                     | -          |
| 02  | Tracer bullet: list Containers  | Config (Token, port, Docker URL), the Docker Source's `containers()`, the Server with the Token check and `/healthz`, `list_containers`, and an end-to-end test with the SDK's client | 1-7, 9-11, 26-27 |
| 03  | Container logs and Redaction    | `logs()` with frame handling, `container_logs`, Private containers, `redact()` in the Server                                                                              | 12-15, 24-25 |
| 04  | Disk usage                      | The Disk Source and `disk_usage`                                                                                                                                          | 16         |
| 05  | Health checks                   | The first optional Source: Gatus on or off by config, `list_health_checks`                                                                                               | 4, 17      |
| 06  | Recent media                    | Jellyfin and `recent_media`                                                                                                                                               | 8, 18-20   |
| 07  | Report                          | The Report Source and `read_report`, with Stale report warnings                                                                                                           | 21-23      |
| 08  | Image and release               | A small non-root Docker image with a read-only filesystem, built and pushed to GHCR on a version tag; the README's setup guide, including `claude mcp add`                | -          |
| 09  | Running on the author's Host    | A PR in the private homelab repo: the service next to the socket proxy, an HTTPS route, a health check, the Token as a Secret; Claude Code connected; fixtures re-recorded from the real Host and scrubbed | -          |
