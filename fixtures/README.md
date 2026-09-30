# Fixtures

Responses the tests' fake `fetch` answers with, one folder per Source.

AGENTS.md asks for responses recorded from a real Host and scrubbed. Until ticket 09 (#10) does that, these are
**hand-written** in the shape of Docker Engine API responses, with placeholder names, IDs and images, so they can't
reveal anything about a real Host but haven't been checked against one either.

The two log fixtures show both formats Docker uses for `/containers/{name}/logs`:

- `docker/logs-framed.bin`: a Container without a terminal. Docker splits the stream into chunks, each with an
  8-byte header (stream, three zero bytes, size). It holds seven lines from `media-server`, including one line split
  across two chunks and one chunk longer than 127 bytes, whose size byte would be corrupted if read as text.
- `docker/logs-plain.txt`: a Container with a terminal, which sends plain text with Windows-style line endings.

`.gitattributes` keeps both byte for byte, since the headers and line endings are what the tests check.
