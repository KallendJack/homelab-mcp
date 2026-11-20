# sources

Part of the [code layout](../../README.md#code-layout). Each Source talks to one system and returns glossary types, never raw API JSON.

## Files

- [`docker.ts`](docker.ts): Containers and their logs: read through the socket proxy, or started through Docker's own socket in admin mode.
- [`compose.ts`](compose.ts): runs `docker compose` against one file, keeping only the plan's fields of the resolved model, since the rest holds Secrets.
- [`disk.ts`](disk.ts): free and used space for each configured path.
- [`gatus.ts`](gatus.ts): Health checks from Gatus.
- [`jellyfin.ts`](jellyfin.ts): recently added Media items.
- [`arr.ts`](arr.ts): Sonarr and Radarr (the same v3 API): queues, removing a download, manual import.
- [`jellyseerr.ts`](jellyseerr.ts): searching Listings, reading one, and sending a Request.
- [`dispatcharr.ts`](dispatcharr.ts): live TV Channels with their Streams, Guide links and channel profiles, the Guide's
  programmes, and M3U accounts. Reads only, for now.
- [`report.ts`](report.ts): the Report file, exactly as written.
- [`ntfy.ts`](ntfy.ts): sends a Notification.
- [`http.ts`](http.ts): `httpRequests`: every HTTP Source's requests, with the time limit and plain-sentence failures.
- [`socket-fetch.ts`](socket-fetch.ts): `socketFetch`: a `fetch` over a local socket, so admin mode reaches Docker's own socket.
- [`source-error.ts`](source-error.ts): `SourceError` and `safeErrorCode`.
- [`time-limit.ts`](time-limit.ts): `withinTimeLimit`, for work that can't be cancelled.

Tests sit beside the file they cover.

## Boundaries

Wording for the Client and decisions about Actions belong to the callers in [`media/`](../media/README.md),
[`admin/`](../admin/README.md) and the top of `src/`. Some Sources write (Docker, Compose, Sonarr, Radarr,
Jellyseerr, ntfy), but only when an Action calls them.
