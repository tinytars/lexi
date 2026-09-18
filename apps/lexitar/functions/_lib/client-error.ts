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
}

export interface ClientErrorReport {
  name: string;
  message: string;
  frames: string[];
  fingerprint: string;
}

const MAX_MESSAGE = 160;
const MAX_FRAMES = 12;
const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const IDENT = /^[A-Za-z_$][\w$.<>]{0,80}$/;
// Chrome: "at fn (https://host/assets/index-X.js:2:3283)" or "at https://host/...". Firefox/Safari: "fn@https://host/...".
const FRAME = /(?:at\s+(?:(\S+)\s+\()?|^(\S*)@)(?:https?:\/\/[^/\s]+)?(\/[\w./-]+\.js):(\d+):(\d+)\)?\s*$/;

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

// Stable across deploys: the bundle hash and positions change every build, the message does not.
async function fingerprintOf(name: string, message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${name}\n${message}`));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function toReport(input: ClientErrorInput): Promise<ClientErrorReport> {
  const name = typeof input.name === "string" && NAME.test(input.name) ? input.name : "Error";
  const message = scrubMessage(typeof input.message === "string" ? input.message : "");
  const frames = scrubFrames(typeof input.stack === "string" ? input.stack : "");
  return { name, message, frames, fingerprint: await fingerprintOf(name, message) };
}
