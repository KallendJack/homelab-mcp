# Phase 3 spec: media and live TV

What phase 3 adds, in behaviour a test can check. Terms are from [`CONTEXT.md`](../CONTEXT.md). Phases 1 and 2 are
unchanged: the read-only container offers read Tools, the admin container offers only the Allowlist, and every
Action is approved by the person in the Client.

## Why, and what for

The author's Host runs the common media stack (Sonarr, Radarr, Jellyseerr) and Dispatcharr with Teamarr for live
TV. Phase 3 covers the jobs the author actually asked for, and nothing else:

- **Downloads:** find stuck or failed downloads and get a replacement; import what Sonarr or Radarr couldn't
  (multi-season packs).
- **Requests:** request a film or series by name.
- **Live TV:** fix a channel that won't play, fix guide problems, add channels, and check a game's channels before it
  starts.

Community MCP servers exist for the *arr apps, but they offer 50-80 Tools each (deleting series included) and would
hold the apps' admin keys in someone else's code; none covers Dispatcharr. These are built-in optional Sources
([ADR 0001](adr/0001-optional-sources-not-plugins.md)), each off until configured.

## Shape

| Source      | Reads (read-only container)                         | Actions (admin container)                         | Secret            |
| ----------- | --------------------------------------------------- | ------------------------------------------------- | ----------------- |
| Sonarr      | `download_queue`, `import_candidates`               | `retry_download`, `manual_import`                 | API key           |
| Radarr      | `download_queue`, `import_candidates`               | `retry_download`, `manual_import`                 | API key           |
| Jellyseerr  | `search_media`                                      | `request_media`                                   | API key           |
| Dispatcharr | `list_channels`, `channel_streams`, `find_streams`  | `check_stream`, `set_channel_streams`, `add_channel`, `set_channel_guide` | API key (`X-API-Key`) |
| Teamarr     | `guide_problems`, `upcoming_events`                 | `correct_guide_match`, `refresh_guide`            | none (it has no login) |

Sonarr and Radarr are one Tool each, not two: `download_queue` reads whichever are configured and says which app each
item came from. qBittorrent isn't a Source: Sonarr's and Radarr's queues already report the download client's state
and error, and the author's downloads all come through them.

## Config

1. Each Source is on when its URL (and API key, where it has one) is set, in either container. A URL without its key,
   or a key without its URL, stops the server at start, naming the variable, never its value.
2. A Source's Tools are offered only while it's on: its reads in the read-only container, its Actions in the admin
   container. The admin container still never offers a read Tool.
3. At start, each container logs which media Sources are on, and no Secret.

## Reads

**`download_queue`**

4. Lists Sonarr's and Radarr's queues together, problems first: failed, import blocked or pending, stalled (no
   connections), then downloading. Each item gives its app, title, state, progress, the app's own warning or error
   message, and the queue item's id for the Actions.
5. An empty queue says so. One app unreachable is reported in a sentence while the other's items are still listed.

**`import_candidates`**

6. For one queue item, returns what a manual import would do: each video file with the series and episodes (or film)
   the app matched, its quality, and the app's rejection reasons, if any. Nothing is imported.

**`search_media`**

7. Searches Jellyseerr by name and returns up to 10 results: title, year, film or series, and whether each is
   available, partly available, requested or not requested, with the id `request_media` needs.

**`list_channels`**

8. Lists Dispatcharr's channels: number, name, group, how many streams, and whether it has guide data. A name filter
   narrows the list.

**`channel_streams`**

9. For one channel, returns its streams in priority order: name, provider (M3U account) and the last stream stats
   Dispatcharr recorded (resolution, bitrate, when), so a dead stream stands out.

**`find_streams`**

10. Searches every provider's streams by name and returns up to 25: name, provider, group and stream id, and whether
    each is already on a channel.

**`guide_problems`**

11. Lists what's wrong with the guide: Dispatcharr channels with no guide data, and Teamarr's failed matches
    (streams it couldn't match to a game), each with its reason.

**`upcoming_events`**

12. For a team or league and a day (default today), lists Teamarr's events: start time, the channel each is on, and
    whether that channel has guide data and streams, so a game can be checked before kick-off.

## Actions

**`retry_download`**

13. Removes one queue item, adds its release to the app's blocklist and asks the app to search for a replacement.
    The result names the release that was blocklisted. The downloaded files are removed from the download client.

**`manual_import`**

14. Imports one queue item's files using the matches `import_candidates` shows. Refuses, importing nothing, when
    any file has a rejection or no match, and lists them: those need fixing in the app.

**`request_media`**

15. Requests one Jellyseerr result by its id: a film, or a series with all seasons unless seasons are named.
    Refuses something already available or requested, saying which.

**`check_stream`**

16. Plays one channel through Dispatcharr's own proxy for up to 10 seconds and reports whether video data arrived
    (bytes received and whether it's a valid MPEG-TS stream). It's an Action because it uses one of the provider's
    connections, which can cut off someone watching another channel on a single-connection account. Refuses a
    channel Dispatcharr's proxy says is already being watched: that one is evidently playing.

**`set_channel_streams`**

17. Sets a channel's streams to a given list of stream ids, in priority order: to promote a working stream, drop a
    dead one or add a replacement from `find_streams`. Refuses an unknown stream id. The result shows the old and
    new order.

**`add_channel`**

18. Creates a channel from one stream (`find_streams`), with a name and an optional number. Refuses a number
    already in use, naming the channel on it.

**`set_channel_guide`**

19. Links one channel to guide data, either by an EPG entry id or by asking Dispatcharr to auto-match that channel,
    and returns which entry it now has.

**`correct_guide_match`**

20. Tells Teamarr which game one of its failed-match streams is for, the fix `guide_problems` points to.

**`refresh_guide`**

21. Asks Teamarr to regenerate its guide and Dispatcharr to re-import it, then returns when both have finished or
    the Action's time limit has passed.

## Everywhere

22. Every phase 1 rule holds for the reads (Redaction, 10-second Source limit, plain-sentence errors, logging), and
    every phase 2 rule for the Actions (one at a time, logged, a Notification each, Redaction, a time limit).
23. Media Actions have a one-minute limit, except `refresh_guide` (five minutes).
24. No Tool returns a stream's playback URL, a provider's username or password, or an M3U URL: they hold the
    provider's credentials.

## Out of scope for phase 3

- Deleting series, films, files or channels; editing quality profiles, indexers or download clients.
- qBittorrent directly, Prowlarr, Bazarr, Profilarr and Capacitarr.
- Anything scheduled or automatic (alerts on stuck downloads, a morning summary): the Host's scheduler, later.
- Recordings and DVR in Dispatcharr.

## Tickets

Each becomes a GitHub Issue once this spec is merged.

| #   | Ticket                              | Delivers                                                                                                  | Behaviour |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- |
| 19  | Tracer bullet: `download_queue`     | Sonarr and Radarr Sources (config, API key), `download_queue` end to end with the SDK's client            | 1-5, 22   |
| 20  | `retry_download`                    | The first media Action, in the admin container                                                            | 13, 22-23 |
| 21  | Manual import                       | `import_candidates` and `manual_import`                                                                   | 6, 14     |
| 22  | Requests                            | Jellyseerr Source, `search_media` and `request_media`                                                     | 7, 15     |
| 23  | Live TV reads                       | Dispatcharr Source, `list_channels`, `channel_streams`, `find_streams`, the credential rule               | 8-10, 24  |
| 24  | Fix a channel                       | `check_stream` and `set_channel_streams`                                                                  | 16-17     |
| 25  | Add a channel and its guide         | `add_channel` and `set_channel_guide`                                                                     | 18-19     |
| 26  | Teamarr                             | Teamarr Source, `guide_problems`, `upcoming_events`, `correct_guide_match`, `refresh_guide`               | 11-12, 20-21 |
| 27  | Running on the author's Host        | A PR in the private homelab repo: the keys, both containers, then the plan's four tasks done for real     | -         |
