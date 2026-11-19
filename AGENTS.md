# homelab-mcp

An MCP server that lets an AI assistant read how a self-hosted Docker homelab is doing. A separate admin-mode
container offers a fixed Allowlist of deploy and media Actions, each approved by the person.

`pnpm verify` runs lint, typecheck and tests; CI runs the same.

Read before changing code:

- [`README.md`](README.md): the Tools, setup, config and code layout.
- [`docs/architecture.md`](docs/architecture.md): the modules, seams, safety rules and failure handling.
- [`GLOSSARY.md`](GLOSSARY.md): the domain terms.
- [`docs/adr/`](docs/adr/): the decisions behind the design.

## Agent skills

### Issue tracker

GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Matt's five default labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
