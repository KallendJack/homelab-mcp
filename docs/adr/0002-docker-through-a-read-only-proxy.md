# Docker is read through a read-only socket proxy, never the socket

The server reads Docker through a socket proxy that allows only listing, inspecting and logs (on the author's Host,
LinuxServer's `socket-proxy` with `CONTAINERS=1`, `INFO=1`, `ALLOW_LOGS=1`, `POST=0`), never by mounting
`/var/run/docker.sock`. Mounting the socket with `:ro` looks read-only but isn't: `:ro` stops the file being replaced,
not the API calls made through it, so any process holding the socket can create a privileged container and take over
the Host. The proxy makes read-only a property of the setup rather than of this code, so even a bug or a prompt
injection through a Tool can't change a Container.

## Consequences

Phase 2's Actions need write access, so they get a separate container with the real socket and a fixed Allowlist,
instead of widening this server's access.
