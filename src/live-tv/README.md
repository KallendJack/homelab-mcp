# live-tv

Part of the [code layout](../../README.md#code-layout). The Tools about live TV in Dispatcharr.

## Files

- [`find-channel.ts`](find-channel.ts): `find_channel`: Channels by name, each with its Guide link, Streams in order and
  channel profiles.
- [`search-guide.ts`](search-guide.ts): `search_guide`: programmes on now or coming up, with the Channels showing them.
- [`m3u-accounts.ts`](m3u-accounts.ts): `m3u_accounts`: provider accounts, naming any that expires soon.

Tests sit beside the file they cover.

## Boundaries

Reading and parsing Dispatcharr belongs in [`sources/dispatcharr.ts`](../sources/dispatcharr.ts); this folder turns its
answers into what the Client reads. The Tools are listed in [`tools.ts`](../tools.ts).
