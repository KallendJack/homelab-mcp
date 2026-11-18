# media

Part of the [code layout](../../README.md#code-layout). The Tools and Actions about films, series and downloads.

## Files

- [`recent-media.ts`](recent-media.ts): `recent_media`'s input and wording.
- [`download-queue.ts`](download-queue.ts): `download_queue`: every app's queue, problems first; one app that can't be read becomes a note.
- [`queue-lookup.ts`](queue-lookup.ts): finds the download that `download_queue` showed, by app and queue id, for the Tools below.
- [`retry-download.ts`](retry-download.ts): the `retry_download` Action.
- [`manual-import.ts`](manual-import.ts): the `import_candidates` Tool and the `manual_import` Action.
- [`requests.ts`](requests.ts): the `search_media` Tool and the `request_media` Action.

Tests sit beside the file they cover.

## Boundaries

Reading and parsing Sonarr, Radarr, Jellyfin and Jellyseerr belongs in [`sources/`](../sources/README.md); this folder
turns their answers into what the Client reads. Read Tools are listed in [`tools.ts`](../tools.ts); Actions are wired
in [`main.ts`](../main.ts) and go through the [Allowlist](../admin/README.md).
