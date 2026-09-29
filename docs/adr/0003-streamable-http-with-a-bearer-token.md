# Streamable HTTP with a bearer Token, not stdio or OAuth

The server speaks MCP over Streamable HTTP, statelessly (a fresh transport per request), and every request must carry
a shared bearer Token. Most MCP servers use stdio, where the Client starts the server as a local process; that would
mean running it on the Client's machine with remote access to Docker, or piping stdio over SSH. Running it on the
Host, next to the proxy, keeps Docker access off the network. Hosted connectors (such as claude.ai's)
accept only OAuth or no authentication, and need a public address; Claude Code accepts a header, and a Token checked
in constant time is enough for a server reachable only on a home network or tailnet. Stateless because the Tools hold
no state between calls, so there are no sessions to store or expire.

## Consequences

The Claude apps' remote connectors can't use it without a public address and OAuth, which is left out on purpose.
Anyone who has the Token can read the Host's status and logs, so it's stored like any other Secret.
