// The one file the two halves of a cross-store copy agree on, and the reason there are two halves.
//
// WHY A FILE ON DISK AT ALL, rather than one process reading one store and writing the other.
// scripts/target.ts resolves the bucket and the database ONCE, at module load, and caches it
// (`wranglerTarget()`); scripts/d1-remote.ts then binds `D1` at module scope from that. So one
// process is one store, structurally, and a cross-store copy is two runs with something between
// them. What it cannot be is a byte copy: a per-file content key lives inside the OWNING vault
// (src/lib/vault-raw-keys.ts), so the source's ciphertext decrypts under nothing the target holds
// and a straight object copy yields `no content key for "<file>"`. The copy unseals on one side and
// re-seals on the other, which means plaintext exists on this workstation in between.
//
// WHAT THAT COSTS, stated so nobody has to infer it: `raw-copy-export` writes readable patient
// images under $XDG_STATE_HOME at 0700/0600, outside any git work tree (scripts/export-dir.ts
// refuses one outright, with no --force). They are deleted with `npm run raw:copy-purge`, and the
// export prints that command on its way out. Nothing here uploads, mails or commits them.
//
// `file` IS A PATIENT'S FILENAME, so this manifest is itself PHI and is written 0600. A probe that
// reports on a copy reports counts and extensions; never the contents of this file.

/** One staged original: `local` is an opaque name in the staging directory, `file` is the real key. */
export interface StagedEntry {
  /** The namespace (vault client id) the file belongs to, identical in both stores. */
  slug: string;
  /** The attachment key, i.e. the filename under `{store}/raw/{slug}/`. A patient's own filename. */
  file: string;
  /** This file's opaque name inside the staging directory — `f0001.bin`, naming nobody. */
  local: string;
  bytes: number;
  /** SHA-256 of the PLAINTEXT, hex. The import checks it against `file`'s own prefix. */
  sha256: string;
  /** The extraction sidecar's local name, when the source held one for this document. */
  sidecar?: string;
}

export const MANIFEST = "manifest.json";

/** Every extension this lane carries. Deliberately images only — see raw-copy-import.ts's header. */
export const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "avif", "bmp", "tif", "tiff",
]);

export const extensionOf = (key: string): string =>
  (/\.([A-Za-z0-9]+)$/.exec(key.slice(key.lastIndexOf("/") + 1))?.[1] ?? "").toLowerCase();

export const isImageKey = (key: string): boolean => IMAGE_EXTENSIONS.has(extensionOf(key));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export function groupBySlug(entries: StagedEntry[]): Map<string, StagedEntry[]> {
  const by = new Map<string, StagedEntry[]>();
  for (const e of entries) by.set(e.slug, [...(by.get(e.slug) ?? []), e]);
  return new Map([...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
