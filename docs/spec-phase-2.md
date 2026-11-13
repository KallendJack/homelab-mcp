# Phase 2 spec: Actions

What phase 2 adds, in behaviour a test can check. Terms are from [`CONTEXT.md`](../CONTEXT.md). Phase 1 is
unchanged: the read-only server keeps its proxy, its Token and its Tools ([ADR 0002](adr/0002-docker-through-a-read-only-proxy.md)).

## Shape

Actions run in a **second container from the same image**, started in admin mode. It holds the real Docker socket and
offers only the Allowlist. The read-only container never offers an Action, and the admin container never offers a
read Tool, so the everyday Tools never run with the power to change anything.

The Allowlist is the work an agent actually needed to deploy a reviewed change on the author's Host:

| Action             | What it does                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `pull_config`      | Fast-forwards the config repo from its remote and says which Services' files changed             |
| `preview_service`  | A dry run: what recreating one Service would create, recreate or leave alone, without doing it   |
| `recreate_service` | Pulls the Service's image and recreates that one Service, nothing it depends on                  |
| `start_container`  | Starts a stopped Container, such as a VPN client Docker gave up on after a reboot                |
| `reload_proxy`     | Asks the reverse proxy to reload its config, which it doesn't do by itself                       |

Deleting data, pruning, running arbitrary commands, editing files and stopping Services are not Actions. They stay
with a person at the Host.

## Approval

The server doesn't ask for approval; the Client does. Every Action is marked as one that changes the Host, so a Client
such as Claude Code asks the person before each call unless told otherwise, and the setup guide says never to
pre-approve Actions. The server's part is to make each Action narrow, explain it before it runs (`preview_service`),
record it, and tell the person it happened.

## Connecting and config

1. Admin mode is chosen by config. Without it the server is the phase 1 server, with no new Tool and no access to the
   socket.
2. Admin mode needs its own Token, different from the read-only one, of at least 32 characters. The same value in
   both stops the server at start.
3. Admin mode needs the config repo's path, the Compose files' locations within it, and the name of its own Service.
   A missing or malformed value stops the server at start, naming the variable, never its value.
4. At start, admin mode logs the Allowlist, the config repo path and whether Notifications are on, and no Secret.

## Actions

**`pull_config`**

5. Fast-forwards the config repo to its remote's default branch and returns the old and new commit, the files that
   changed, and the Services whose Compose file or mounted config changed.
6. Refuses, changing nothing, when the repo has local changes or can't fast-forward, and says which.
7. Pulls with a read-only deploy key given as a Secret file, never a key in the environment.

**`preview_service`**

8. For a named Service, returns what a recreate would do to each Container: create, recreate or leave alone.
9. Refuses a Service that isn't in the Compose files and lists the closest names that exist.

**`recreate_service`**

10. Runs the dry run first and refuses if it would touch any Container other than the named Service's own. In
    practice (ticket 13): a recreate with `--no-deps` only ever touches the Service's own Containers, so the guard is
    the other Services that would be disturbed anyway: ones sharing its network (`network_mode: service:<name>`)
    or restarting with it (`depends_on` with `restart: true`), read from Compose's resolved model. What changes is
    decided by Compose's config hash against the one on each Container, and Compose's own dry run is shown to the
    person, not parsed: its wording isn't a stable interface.
11. Pulls that Service's image, recreates and starts only that Service (never its dependencies), then waits up to
    two minutes for it to be running, and healthy if it has a healthcheck, and returns the result.
12. Refuses the server's own Service, saying it must be recreated from the Host, since recreating yourself kills
    the request doing it.

**`start_container`**

13. Starts a Container that exists and is stopped. Refuses one that is already running, or unknown (with the
    closest names).

**`reload_proxy`**

14. Runs the reverse proxy's own reload command in its Container and returns whether the new config was accepted.
    A rejected config leaves the old one running, and the error says why.

## Everywhere in admin mode

15. Only one Action runs at a time; a second call while one is running is refused, saying which is running.
16. Every Action is logged with its name, arguments, how long it took and its result.
17. With Notifications on, every Action sends one Notification, success or failure, naming the Action and Service.
    A Notification that can't be sent is logged and doesn't fail the Action.
18. Every Action's output, and every error, passes through Redaction, as in phase 1.
19. An Action that takes longer than its limit (five minutes for `recreate_service`, one minute for the rest) is
    reported as timed out, saying the Host may be part-way through.

## Out of scope for phase 2

- Stopping or removing Services, deleting data, pruning, editing files or running arbitrary commands.
- Recreating the server's own Service (done from the Host).
- Approval inside the server: the Client asks the person (see Approval).
- Rolling back a bad deploy automatically: revert in Git, pull and recreate.
- Scheduled jobs: those belong to the Host's scheduler, not to a Client-driven server.

## Tickets

Each becomes a GitHub Issue once this spec is merged.

| #   | Ticket                          | Delivers                                                                                                                                   | Behaviour |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 10  | Admin mode and the Allowlist    | Config for admin mode (own Token, repo path, own Service), the mode switch in `main.ts`, the one-at-a-time lock, logging; no Actions yet  | 1-4, 15-16, 18 |
| 11  | Tracer bullet: `start_container` | The Docker write side (start a Container) through the real socket, end to end with the SDK's client                                       | 13, 19    |
| 12  | `pull_config`                    | Git through a deploy key, changed files and changed Services                                                                              | 5-7       |
| 13  | Preview and recreate             | `preview_service` and `recreate_service` through the Compose CLI, the dry-run guard and the self-refusal                                  | 8-12      |
| 14  | `reload_proxy` and Notifications | The proxy reload, and Notifications as an optional Source-like setting (ntfy URL and topic from config)                                   | 14, 17    |
| 15  | Image and setup guide            | The Docker CLI and Compose plugin in the image; the README's admin setup, including "never pre-approve Actions"                           | -         |
| 16  | Running on the author's Host     | A PR in the private homelab repo: the admin container with the socket and deploy key, its own Token, Claude Code connected, one real deploy | -         |
