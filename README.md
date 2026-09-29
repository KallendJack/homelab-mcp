# homelab-mcp

An MCP server that lets an AI assistant, such as Claude Code, see how a self-hosted Docker homelab is doing:
containers, logs and disk, plus Gatus health checks, recently added Jellyfin media and a daily report when those are
set up. Read-only, through a Docker socket proxy.

Work in progress: the design is in [`docs/architecture.md`](docs/architecture.md) and the vocabulary in
[`CONTEXT.md`](CONTEXT.md).

## Development

Needs Node 24 and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm verify   # lint and format check, types, tests: what CI runs on every PR
```
