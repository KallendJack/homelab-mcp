# Fixtures

The answers the tests' fake `fetch` gives, one folder per Source. Part of the [code layout](../README.md#code-layout).

A file whose name ends in `-recorded` was recorded from a real Host and scrubbed: hostnames, IPs, names that identify
a person, titles and every Secret replaced. The rest are hand-written in the shape of the real API, with placeholder
names, ids and images, for cases a healthy Host doesn't show.

## Docker

- `containers.json`: the Container list, hand-written.
- `logs-framed.bin`: a Container without a terminal. Docker splits the stream into chunks, each with an 8-byte header
  (stream, three zero bytes, size). It includes one line split across two chunks and one chunk longer than 127 bytes,
  whose size byte would be corrupted if read as text.
- `logs-plain.txt`: a Container with a terminal, which sends plain text with Windows-style line endings.
- `start-no-such-container.json`: Docker's answer to starting a Container that doesn't exist, from the Docker Engine
  API docs. The other answers to a start (204 started, 304 already running) have no body.

[`.gitattributes`](../.gitattributes) keeps the log files byte for byte, since the headers and line endings are what
the tests check.

## Gatus

- `statuses-recorded.json`: every Health check passing, recorded 2026-10-01; the Host's address became `192.0.2.10`,
  an address reserved for documentation.
- `statuses.json`: two passing checks, one timed out, one refused, and one not checked yet.

## Jellyfin

- `virtual-folders.json`: film, TV, music and a placeholder library with no type, so the tests prove only film and TV
  libraries are read.
- `items-films.json`, `items-tv.json`: recent items, some older than a day, with folder tags such as `{tvdb-438604}`
  left in two names on purpose.

## Sonarr and Radarr

- `queue-empty-recorded.json`: an empty queue, recorded 2026-11-17 (Sonarr 4.0.17, Radarr 6.2.1); only the page
  size was changed to the one the server asks for.
- `queue.json`: downloading, stalled, import blocked, failed and import pending, and a season pack listed once per
  episode (records 103 and 106 share a download).
- `manualimport.json`: the files a manual import would take, matched and rejected.

## Jellyseerr

Jellyseerr 2.7.3's answers. No real Request was sent, so `request-created.json` follows Jellyseerr's source.

- `search-empty-recorded.json`: a search with no results, recorded 2026-11-18.
- `search.json`: a search with every availability and a person.
- `movie-new.json`, `movie-requested.json`: a film not in Jellyseerr, and a requested one.
- `tv-new.json`, `tv-partly-available.json`: a series not in Jellyseerr, and one with seasons 1-2 available, 3
  requested, 4 not, plus specials.
- `request-created.json`, `request-duplicate.json`: a created Request, and the answer to a duplicate.
