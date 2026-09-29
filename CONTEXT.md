# homelab-mcp

An MCP server that lets an AI assistant see how a self-hosted Docker homelab is doing: its containers, logs and disk,
plus optional sources such as Gatus and Jellyfin. It only reads for now; a fixed set of deploy actions comes later.

## Language

### The server and its clients

**Host**:
The machine running the Docker containers the server reports on, such as a NAS.
_Avoid_: server (that's this program), box, node

**Client**:
The AI app connected to the server, such as Claude Code.
_Avoid_: agent, user, consumer

**Tool**:
One named capability the server offers a Client, such as listing Containers or reading a Container's logs.
_Avoid_: command, function, endpoint

**Token**:
The Secret a Client sends with every request. Requests without it are refused.
_Avoid_: API key, password

### What it reads

**Source**:
A system on the Host that the server reads from: Docker and the disk always, and Gatus, Jellyfin and a Report when
configured. An optional Source is off until configured, and its Tools aren't offered while it's off.
_Avoid_: integration, provider, backend, plugin

**Container**:
One Docker container on the Host, running or not, identified by its name.
_Avoid_: service (that's a compose definition), app

**Private container**:
A Container whose logs the server never returns, named in config. Its status is still shown.
_Avoid_: hidden, excluded, blocked

**Health check**:
One Gatus check of a URL or port, currently passing or failing.
_Avoid_: endpoint, monitor, probe

**Media item**:
A film or TV episode in the Host's Jellyfin library.
_Avoid_: title, content, video

**Report**:
A text file the Host writes on a schedule, such as a daily status message, returned exactly as written.
_Avoid_: briefing, digest, summary

**Stale report**:
A Report older than its schedule allows, so it may no longer describe the Host. It is still returned, with a warning
saying how old it is.
_Avoid_: old, outdated, expired

### Safety

**Secret**:
A value that grants access, such as a token or password.
_Avoid_: credential

**Redaction**:
Replacing anything in a Tool's output that looks like a Secret with a placeholder, before it leaves the server.
_Avoid_: masking, scrubbing, sanitising

### Later: changing the Host

**Action**:
A Tool that changes the Host, such as pulling config or recreating a Service. Every Action is on the Allowlist.
_Avoid_: command, mutation, write tool

**Allowlist**:
The fixed set of Actions the server will perform. Anything else is refused, whatever the Client asks.
_Avoid_: whitelist, permissions

**Service**:
One entry in a Compose file, which runs as one Container. Actions work on Services.
_Avoid_: app, container (for the definition)
