const PLACEHOLDER = "[redacted]";

// Every pattern starts only where a word starts and caps how far each part may reach, so redacting a line takes
// time in proportion to its length. Unbounded patterns can take minutes on a long line, freezing the server.

/** A name that suggests its value is a Secret, such as DB_PASSWORD, api_key, X-Api-Key or MCP_TOKEN. */
const SECRET_NAME =
  /(?<![\w.-])[\w.-]{0,40}?(?:password|passwd|secret|tokens?|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?id)[\w.-]{0,40}/
    .source;

type Rule = [pattern: RegExp, replace: (match: string, ...groups: string[]) => string];

const RULES: Rule[] = [
  // scheme://user:password@host keeps everything but the password.
  [
    /(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]{1,100}:)[^\s@/]{1,200}@/gi,
    (_, start) => `${start}${PLACEHOLDER}@`,
  ],
  // A JWT: three base64url parts, the first always starting eyJ ('{"' encoded).
  [/(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]+/g, () => PLACEHOLDER],
  // Authorization: Bearer <token> or Basic <token>, but not "the bearer of bad news".
  [
    /(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/-]{2,500}=*)/gi,
    (match, start, token) => (looksLikeCredential(token) ? `${start}${PLACEHOLDER}` : match),
  ],
  // "name": "value" in JSON. The value may contain escaped quotes.
  [
    new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"),
    (_, start) => `${start}"${PLACEHOLDER}"`,
  ],
  // name=value, with the value quoted or running to the next space or separator.
  [
    new RegExp(`(${SECRET_NAME})(\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s,;&"']+)`, "gi"),
    (match, name, equals, value) =>
      isCount(name, value) ? match : `${name}${equals}${PLACEHOLDER}`,
  ],
  // "Name: value", as in headers and YAML. Bearer and Basic values were handled above.
  [
    new RegExp(
      `(${SECRET_NAME})(:[ \\t]+)(?!\\[redacted\\]|(?:Bearer|Basic)\\b)([^\\s,;&"']+)`,
      "gi",
    ),
    (match, name, colon, value) => (isCount(name, value) ? match : `${name}${colon}${PLACEHOLDER}`),
  ],
];

/** Replaces anything in `text` that looks like a Secret with a placeholder. Ordinary text is left as it was. */
export function redact(text: string): string {
  const named = RULES.reduce(
    (result, [pattern, replace]) => result.replace(pattern, replace),
    text,
  );
  return redactRandomLooking(named);
}

/** "tokens: 512" is a count, as model logs print, not a Secret. */
function isCount(name: string, value: string): boolean {
  return /tokens/i.test(name) && /^\d+$/.test(value);
}

/** After Bearer or Basic: long enough, and not a plain lower-case word like "understanding". */
function looksLikeCredential(token: string): boolean {
  const mixedCase = /[a-z]/.test(token) && /[A-Z]/.test(token);
  return token.length >= 8 && (/\d/.test(token) || mixedCase || /[+/=._~-]/.test(token));
}

/**
 * Runs of 32 or more letters, digits, _, +, / or - (with base64's = padding) that look random. A run starting
 * with / is a path, so each part is judged on its own; any other run, such as base64, is judged whole. Image
 * digests after "sha256:" are public, not Secrets.
 */
function redactRandomLooking(text: string): string {
  return text.replace(/(?<![\w+/-])[\w+/-]{32,}={0,2}/g, (run, offset: number) => {
    if (text.slice(offset - 7, offset) === "sha256:") return run;
    if (run.startsWith("/")) {
      return run
        .split("/")
        .map((part) => (looksRandom(part) ? PLACEHOLDER : part))
        .join("/");
    }
    return looksRandom(run) ? PLACEHOLDER : run;
  });
}

/**
 * 32 or more characters that are all hex, mix lower case, upper case and digits, or are lower case and digits
 * with plenty of digits. Long names like handle_scan_event_v2 and UUIDs match none of these.
 */
function looksRandom(run: string): boolean {
  const core = run.replace(/=+$/, "");
  if (core.length < 32) return false;
  const allHex = /^[0-9a-f]+$/i.test(core);
  const mixed = /[a-z]/.test(core) && /[A-Z]/.test(core) && /[0-9]/.test(core);
  const digits = core.replace(/\D/g, "").length;
  const lowerAndDigits = /^[a-z0-9]+$/.test(core) && digits / core.length >= 0.2;
  return allHex || mixed || lowerAndDigits;
}
