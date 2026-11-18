# testing

Part of the [code layout](../../README.md#code-layout). Fakes shared by the offline tests.

## Files

- [`fake-fetch.ts`](fake-fetch.ts): a `fetch` that answers from recorded fixtures.
- [`fake-compose.ts`](fake-compose.ts): sets up the fake `docker compose` and reads back what it was asked to do.
- [`fake-compose.mjs`](fake-compose.mjs): the fake `docker compose` itself, run as a real process.
- [`local-socket.ts`](local-socket.ts): a fresh local socket path, as Docker listens on.

The tests that use them sit beside the code they cover.

## Boundaries

Production code never imports from here.
