// Turns an uncaught browser error into a report that is safe to file as a GitHub issue.
//
// HARD RULE: never PHI. An error message can interpolate anything the app was holding — a file name,
// a marker value, a patient's words — so nothing from the client is echoed verbatim. Quoted text,
// long digit runs, emails and non-Svelte URLs are masked, and the stack keeps only frame shapes
// (function name + bundle position), which are code, not data.

export interface ClientErrorInput {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  build?: unknown;
}

export interface ClientErrorReport {
  name: string;
  message: string;
  frames: string[];
  build: string | null;
  fingerprint: string;
}

const MAX_MESSAGE = 160;
const MAX_FRAMES = 12;
const SHA = /^[0-9a-f]{7,40}$/;
const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const IDENT = /^[A-Za-z_$][\w$.<>]{0,80}$/;
// Chrome: "at fn (https://host/assets/index-X.js:2:3283)" or "at https://host/...". Firefox/Safari: "fn@https://host/...".
// The leading slash is optional and .ts/.mjs count, so the same scrubber reads a server stack
// (workerd reports a bare `index.js:1:2`, the Node host a real source path) as well as a browser one.
const FRAME = /(?:at\s+(?:async\s+)?(?:(\S+)\s+\()?|^(\S*)@)(?:https?:\/\/[^/\s]+)?(\/?[\w./-]+\.[cm]?[jt]s):(\d+):(\d+)\)?\s*$/;

export function scrubMessage(raw: string): string {
  return raw
    .split("\n")[0]
    .replace(/https:\/\/svelte\.dev\/e\/([a-z_]+)/g, "svelte:$1")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/(["'`])(?:(?!\1).)*\1/g, "$1…$1")
    .replace(/\d{4,}/g, "#")
    .replace(/svelte:([a-z_]+)/g, "https://svelte.dev/e/$1")
    .slice(0, MAX_MESSAGE);
}

export function scrubFrames(stack: string): string[] {
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line.trim());
    if (!m) continue;
    const fn = m[1] ?? m[2];
    const where = `${m[3]}:${m[4]}:${m[5]}`;
    frames.push(fn && IDENT.test(fn) ? `${fn} (${where})` : where);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

// A server error message can carry things a browser's never does: an R2 key (which embeds the client
// slug and a document name), a D1 bound value, or a token read from env. Masked BEFORE scrubMessage,
// so its own rules see already-neutral text.
const CREDENTIAL = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT-shaped
  /\b[A-Za-z0-9_-]{32,}\b/g, // any remaining long opaque run: session values, KEKs, challenges
];

// Every slash-joined token is a path until proven otherwise, and a path segment is only kept when it
// is a STATIC segment of a real route — i.e. code. `prod/raw/alex/labs.pdf` → `:x/raw/:x/:x`.
function maskPaths(raw: string, allowed: ReadonlySet<string>): string {
  return raw.replace(/(?:[\w.+-]+\/)+[\w.+-]*/g, (token) =>
    token
      .split("/")
      .map((seg) => (seg === "" || allowed.has(seg) ? seg : ":x"))
      .join("/"),
  );
}

export function scrubServerMessage(raw: string, allowed: ReadonlySet<string>): string {
  return scrubMessage(CREDENTIAL.reduce((s, re) => s.replace(re, "<token>"), maskPaths(raw, allowed)));
}

// Stable across deploys: the bundle hash and positions change every build, the message does not.
// `salt` distinguishes otherwise-identical failures that are different bugs — a server report salts
// with its route pattern. It is omitted from the hash when empty, so client fingerprints, and the
// issues already filed under them, are unchanged.
export async function fingerprintOf(name: string, message: string, salt = ""): Promise<string> {
  const input = salt ? `${name}\n${message}\n${salt}` : `${name}\n${message}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function toReport(input: ClientErrorInput): Promise<ClientErrorReport> {
  const name = typeof input.name === "string" && NAME.test(input.name) ? input.name : "Error";
  const message = scrubMessage(typeof input.message === "string" ? input.message : "");
  const frames = scrubFrames(typeof input.stack === "string" ? input.stack : "");
  const build = typeof input.build === "string" && SHA.test(input.build) ? input.build : null;
  return { name, message, frames, build, fingerprint: await fingerprintOf(name, message) };
}
