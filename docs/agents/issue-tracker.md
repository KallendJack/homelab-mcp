# Issue tracker: GitHub Issues

Tickets live as GitHub Issues on `KallendJack/homelab-mcp`, read and written with the `gh` CLI. The phase spec lives in
the repo (`docs/spec.md`); each Issue is one ticket from it.

## Conventions

- **Title:** `NN: <what it delivers>`, numbered from `01` in build order.
- **Body:** what to build, `Blocked by: #N` when it depends on another ticket, and a checklist of acceptance criteria.
- **Labels:** `phase-1` or `phase-2`.
- **Status** is GitHub's own: open, then closed by the PR that finishes it (`Closes #N` in the PR description).
- **Conversation** happens in Issue and PR comments. Read them with `gh issue view N --comments` and
  `gh pr view N --comments`, and review comments on code with `gh api repos/KallendJack/homelab-mcp/pulls/N/comments`.

## When a skill says "publish to the issue tracker"

`gh issue create --title "NN: ..." --label phase-1 --body-file <file>`.

## When a skill says "fetch the relevant ticket"

`gh issue view N --comments`.
