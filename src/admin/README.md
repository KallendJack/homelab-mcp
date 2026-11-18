# admin

Part of the [code layout](../../README.md#code-layout). The Actions that change the Host's Services and Config repo, and the Allowlist every Action goes through.

## Files

- [`allowlist.ts`](allowlist.ts): the Allowlist: marks each Action, logs it, sends its Notification, applies the time limit and runs one at a time.
- [`pull-config.ts`](pull-config.ts): the `pull_config` Action: fast-forwards the Config repo with the deploy key.
- [`changed-services.ts`](changed-services.ts): which Services a set of changed files affects, read from the Compose text.
- [`service-plan.ts`](service-plan.ts): which Compose file a Service is in, what a recreate would change and whom it would disturb.
- [`recreate-service.ts`](recreate-service.ts): the `preview_service` and `recreate_service` Actions.
- [`reload-proxy.ts`](reload-proxy.ts): the `reload_proxy` Action, through Docker's exec with the command from Config.
- [`start-container.ts`](start-container.ts): the `start_container` Action.

Tests sit beside the file they cover.

## Boundaries

Admin mode offers every Action, not only these: the media Actions live in [`media/`](../media/README.md) and go through
the same Allowlist. Talking to Docker, Compose and ntfy belongs in [`sources/`](../sources/README.md).
