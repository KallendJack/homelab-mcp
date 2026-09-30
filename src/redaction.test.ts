import { describe, expect, it } from "vitest";
import { redact } from "./redaction.ts";

describe("redact", () => {
  it("replaces a bearer token, keeping the word Bearer", () => {
    expect(redact("401 for Authorization: Bearer abcDEF123456789xyz.more-token")).toBe(
      "401 for Authorization: Bearer [redacted]",
    );
  });

  it.each([
    [
      "connecting with DB_PASSWORD=hunter2 user=admin",
      "connecting with DB_PASSWORD=[redacted] user=admin",
    ],
    ["GET /items?api_key=abc123&page=2", "GET /items?api_key=[redacted]&page=2"],
    ['login secret="two words" ok', "login secret=[redacted] ok"],
    [
      "MCP_TOKEN=abc session_id=77 access-key=Q1",
      "MCP_TOKEN=[redacted] session_id=[redacted] access-key=[redacted]",
    ],
  ])(
    "replaces the value of a key=value pair whose name suggests a Secret: %s",
    (line, expected) => {
      expect(redact(line)).toBe(expected);
    },
  );

  it("replaces the value of a JSON pair whose key suggests a Secret, even with escaped quotes inside", () => {
    expect(redact('{"user":"jack","password":"hun\\"ter2","apiKey": "abc", "count": 3}')).toBe(
      '{"user":"jack","password":"[redacted]","apiKey": "[redacted]", "count": 3}',
    );
  });

  it("replaces a JWT wherever it appears", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redact(`session started with ${jwt} ok`)).toBe("session started with [redacted] ok");
  });

  it("replaces the password in a URL, keeping the rest of the address", () => {
    expect(redact("db at postgres://nextcloud:s3cr3t-pass@db:5432/nextcloud is up")).toBe(
      "db at postgres://nextcloud:[redacted]@db:5432/nextcloud is up",
    );
  });

  it.each([
    [
      "an API key in hex",
      "using key 8f14e45fceea167a5a36dedd4bea2543 now",
      "using key [redacted] now",
    ],
    [
      "mixed-case letters and digits",
      "got X9aB7cD2eF4gH6iJ8kL0mN1oP3qR5sT7uV back",
      "got [redacted] back",
    ],
    [
      "base64 with padding",
      "sig dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSBmb3IgdGVzdHM= ok",
      "sig [redacted] ok",
    ],
  ])("replaces a long random-looking string: %s", (_, line, expected) => {
    expect(redact(line)).toBe(expected);
  });

  it.each([
    "2026-09-30 08:00:07 Scheduled task 'Scan media library' completed after 00:00:04.21",
    "Pulled sha256:7be1c0a9d3e2f4b5a6978877665544332211ffeeddccbbaa0099887766554433",
    "request 3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b handled in 12 ms",
    "Serving /volume1/media/tv/Some.Show.S01E02.1080p.WEB-DL.mkv",
    "model=deepseek-v4.1-flash max_tokens=1024 tokens_used=812",
    "Client connected: device=living-room-tv app=Jellyfin Android TV 0.18.2",
    "author=Jack updated_at=2026-09-30",
    "calling handle_media_library_scan_completed_event_v2",
    "Up 2 days (unhealthy) (jellyfin/jellyfin:10.11.0)",
  ])("leaves an ordinary line readable: %s", (line) => {
    expect(redact(line)).toBe(line);
  });

  // A slow pattern would freeze the whole server, and a Client can send long text on purpose.
  it.each([
    ["a name made of secret words", "tokenx".repeat(4000)],
    ["repeated secret", "secret".repeat(4000)],
    ["a quoted secret name with no value", `"${"password".repeat(3000)}`],
    ["repeated JWT starts", "eyJ".repeat(8000)],
    ["a URL scheme with no end", `a://${"b".repeat(24000)}`],
    ["one long random-looking run", "aB3".repeat(8000)],
  ])("redacts 24,000 characters of %s in well under a second", (_, text) => {
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
