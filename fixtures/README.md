# Fixtures

Responses the tests' fake `fetch` answers with, one folder per Source.

AGENTS.md asks for responses recorded from a real Host and scrubbed. Until ticket 09 (#10) does that, these are
**hand-written** in the shape of Docker Engine API responses, with placeholder names, IDs and images, so they can't
reveal anything about a real Host but haven't been checked against one either.

The two log fixtures show both formats Docker uses for `/containers/{name}/logs`:

- `docker/logs-framed.bin`: a Container without a terminal. Docker splits the stream into chunks, each with an
  8-byte header (stream, three zero bytes, size). It holds seven lines from `media-server`, including one line split
  across two chunks and one chunk longer than 127 bytes, whose size byte would be corrupted if read as text.
- `docker/logs-plain.txt`: a Container with a terminal, which sends plain text with Windows-style line endings.

`.gitattributes` keeps both byte for byte, since the headers and line endings are what the tests check.

`gatus/statuses.json` is the answer to Gatus's `/api/v1/endpoints/statuses?page=1&pageSize=1`, also hand-written
until ticket 09: two passing checks, two failing (one timed out, one refused), and one not checked yet.

`jellyfin/` holds Jellyfin's `/Library/VirtualFolders` (film, TV, music and a placeholder library with no type) and
the recent items of the film and TV libraries, hand-written until ticket 09. Folder tags such as `{tvdb-438604}` are
left in two names on purpose, and some items are older than a day.

`gatus/statuses-recorded.json` is the first answer **recorded from a real Host** (2026-10-01), scrubbed: the Host's
address became `192.0.2.10`, an address reserved for documentation. It holds 23 Health checks, all passing, named
after the apps they check. The hand-written `statuses.json` stays for the cases a healthy Host doesn't show: a
timeout, a refused connection and a check not yet run.

`docker/start-no-such-container.json` is Docker's answer to `POST /containers/{name}/start` for a Container that doesn't
exist, hand-written from the Docker Engine API docs: nothing has the real socket to record it until ticket 16. The
other answers to a start (204 started, 304 already running) have no body.

`sonarr/` and `radarr/` hold each app's `/api/v3/queue`. `queue-empty-recorded.json` is **recorded from a real Host**
(2026-11-17, Sonarr 4.0.17 and Radarr 6.2.1), whose queues were empty; only the page size was changed to the one the
server asks for. `queue.json` is hand-written in the same shape for what an empty queue can't show: downloading,
stalled, import blocked, failed and import pending, and a season pack listed once per episode (records 103 and 106
share a download).

`jellyseerr/` holds Jellyseerr 2.7.3's answers. `search-empty-recorded.json` is **recorded from a real Host** (2026-11-18). The
others are hand-written in the shape of answers recorded the same day (search, a film and a series' details), trimmed to
the fields the server reads plus a few neighbours, with placeholder titles and ids and the Host's addresses and users
left out: a search with every availability and a person, a film not in Jellyseerr, a requested film, a partly available
series (seasons 1-2 available, 3 requested, 4 not, plus specials), a series not in Jellyseerr, a created request and
the answer to a duplicate. No real request was sent to record them, so `request-created.json` follows Jellyseerr's
source for `POST /api/v1/request`.
