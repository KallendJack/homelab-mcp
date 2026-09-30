const PLACEHOLDER = "[redacted]";

/**
 * A name that suggests its value is a Secret, such as DB_PASSWORD, api_key or MCP_TOKEN. "token" isn't
 * matched as "tokens", so counts like max_tokens=1024 stay readable.
 */
const SECRET_NAME =
  /[\w.-]*(?:password|passwd|secret|token(?!s)|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session[_-]?id)[\w.-]*/
    .source;

const RULES: [RegExp, string][] = [
  // scheme://user:password@host keeps everything but the password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${PLACEHOLDER}@`],
  // A JWT: three base64url parts, the first always starting eyJ ('{"' encoded).
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, PLACEHOLDER],
  // Authorization: Bearer <token>
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${PLACEHOLDER}`],
  // "name": "value" in JSON. The value may contain escaped quotes.
  [new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"), `$1"${PLACEHOLDER}"`],
  // name=value, with the value quoted or running to the next space or separator.
  [
    new RegExp(`(${SECRET_NAME}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&"']+)`, "gi"),
    `$1${PLACEHOLDER}`,
  ],
];

/** Replaces anything in `text` that looks like a Secret with a placeholder. Ordinary text is left as it was. */
export function redact(text: string): string {
  const named = RULES.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
  return redactRandomLooking(named);
}

/**
 * Runs of 32 or more letters, digits, _, + or - (with base64's = padding) that look random: all hex, or a mix
 * of lower case, upper case and digits. Long names like handle_scan_event_v2 and UUIDs don't mix all three,
 * so they stay readable. Image digests after "sha256:" are public, not Secrets.
 */
function redactRandomLooking(text: string): string {
  return text.replace(/(?<![\w+-])[\w+-]{32,}={0,2}/g, (run, offset: number) => {
    if (text.slice(0, offset).endsWith("sha256:")) return run;
    const core = run.replace(/=+$/, "");
    const allHex = /^[0-9a-f]+$/i.test(core);
    const mixed = /[a-z]/.test(core) && /[A-Z]/.test(core) && /[0-9]/.test(core);
    return allHex || mixed ? PLACEHOLDER : run;
  });
}
