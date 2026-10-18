// The three guards VAULT.md names — G1, G8, G10 — rebuilt 2026-10-06 for a tree that tracks no
// record of any real person.
//
// WHY IT IS NOT THE ORIGINAL. The version at 21fa571 read the live roster and the live served blobs
// off disk: `records/private/roster.json` for the display names, and every `records/public/*.enc`
// for the sweeps. Neither survives here. `records/public/data-*.enc` was pulled on 2026-09-15
// (.gitignore:62-63) and `records/roster.enc` is untracked as of Phase 4(b) of
// planning/lexi/remediate-published-key-material.md — so a sweep over that directory now finds
// nothing, and "nothing to scan is not a pass" is exactly what each of the original's
// `toBeGreaterThan(0)` lines existed to refuse. Deleting the file was the honest option and the
// wrong one: VAULT.md cites these three guards by name as what holds a published decision in place.
//
// WHAT REPLACES IT. Each guard is re-derived from what the TREE asserts rather than from what a
// machine happens to be holding, which is also what makes the suite run in a clone with no
// credential store — the property Phase 4 exists to deliver:
//
//   G1  a static sweep over every call site that mints an R2 key, plus the original's pure `leaks`
//       with its failure control, which never needed a record to run.
//   G8  the path containment that is the mechanism, plus a roster this file mints and opens, which
//       is the control the original got from the real artifact.
//   G10 the predicate's own discrimination control, unchanged, plus the directory sweep.
//
// The emptiness of records/public/ is itself asserted rather than tolerated. That is a guard the
// original could not have had — it ran in a tree where those files were supposed to be present — and
// it is the one that would catch a real per-account blob being committed back.
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptVault, encryptVault } from "@tinytars/vault/crypto";
import { isV2 } from "../../scripts/vault-v2";
import type { Roster } from "../../src/lib/types";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Vite's publicDir, named here exactly as vite.config.ts:108 names it. */
const PUBLIC_DIR = resolve(APP, "records/public");
/** The roster blob's path, whether or not this machine holds the file — containment is about paths. */
const ROSTER_PATH = resolve(APP, "records/roster.enc");

/** Which identifiers embed one of the display names. Pure, so it can be proven able to fail. */
export function leaks(names: string[], ids: string[]): string[] {
  const needles = names.map((n) => n.toLowerCase()).filter(Boolean);
  return ids.filter((id) => needles.some((n) => id.toLowerCase().includes(n)));
}

/** Every `.enc` under the publicDir. Empty is the correct answer here and the sweeps say so. */
const servedBlobs = async (): Promise<string[]> =>
  (await readdir(PUBLIC_DIR)).filter((f) => f.endsWith(".enc"));

// G1 — a patient's name must not be the system's identifier. The ciphertext was always sound; the
// FILENAME was the leak, because `data-{id}.enc` is also the R2 key, the `/api/vault/{id}` route and
// the address bar. The original asserted it over the files on disk. There are none, so it is
// asserted over the code that would produce one: an R2 key is minted from a server-generated vault
// id at every call site, and a call site interpolating anything name-shaped is what G1 removed.
describe("vault identifier opacity (G1)", () => {
  it("flags an identifier that embeds a display name", () => {
    // The check has to be able to go red, so prove it on the exact shape G1 removed rather than
    // trusting a green run over records that no longer contain the defect.
    expect(leaks(["Alex"], ["data-alex.enc", "data-0b8c.enc"])).toEqual(["data-alex.enc"]);
    expect(leaks(["Alex"], ["data-0b8c.enc"])).toEqual([]);
  });

  it("mints every R2 key from an id, and the whole list of what that can be is here", async () => {
    // An allow-list rather than a name-shaped denylist, which is the same choice
    // tests/unit/org-key-chokepoint.test.ts makes and for the same reason: a denylist passes a
    // `slug` that happens to hold a first name, which is precisely the defect G1 removed, while a
    // list of five expressions makes a sixth call site say out loud what it is interpolating.
    //
    //   id, id.toLowerCase()  the `{id}` the route and the R2 key already carry (client-id.ts)
    //   vaultId               the server-minted uuid of a new signup (auth/password/signup.ts:94)
    //   newVaultBlobId        the rotation's new id, minted server-side (vault-rekey.ts:222)
    //   slug                  e2e-<SEED>, synthetic and destroyed each boot
    //                         (provision-e2e-patient.ts:115-118) — never a person's name
    const sources = await sweepTs(["functions", "scripts", "src"]);
    const interpolated = new Set<string>();
    for (const [, src] of sources) {
      for (const m of blankComments(src).matchAll(/[`"']data-\$\{([^}]+)\}\.enc/g)) {
        interpolated.add(m[1].trim());
      }
    }
    expect([...interpolated].sort()).toEqual(["id", "id.toLowerCase()", "newVaultBlobId", "slug", "vaultId"]);
  });
});

// G8 — the roster is the one artifact that maps an opaque client id back to a patient's name. G1
// made the ids opaque; a served roster hands the mapping back. Being outside Vite's publicDir is the
// mechanism, because a served file cannot be un-served by remembering not to ship it.
describe("the roster is not a served artifact (G8)", () => {
  it("keeps the roster blob outside Vite's publicDir", () => {
    expect(relative(PUBLIC_DIR, ROSTER_PATH).startsWith("..")).toBe(true);
  });

  it("tells a roster from a vault, so the sweep below is not vacuous on its predicate", async () => {
    // The original got this control from the real roster, which had to open under the real
    // ROSTER_PASS or every blob would read as "not the roster" and the sweep would pass for the
    // wrong reason. A synthetic roster under a throwaway passphrase buys the same control and asks
    // a clone for no credential at all.
    const dir = await mkdtemp(join(tmpdir(), "lexitar-opacity-"));
    const pass = "throwaway-roster-passphrase";
    const roster: Roster = { kind: "roster", clients: { "0b8c": { displayName: "Synthetic One" } } };
    const rosterBlob = join(dir, "roster.enc");
    await writeFile(rosterBlob, await encryptVault(roster, pass));
    const vaultBlob = join(dir, "data-0b8c.enc");
    await writeFile(vaultBlob, await encryptVault({ kind: "vault", clients: {} }, pass));

    expect(await opensAsRoster(rosterBlob, pass)).toBe(true);
    expect(await opensAsRoster(vaultBlob, pass)).toBe(false);
  });

  it("serves no per-account ciphertext at all, which is the 2026-09-15 decision", async () => {
    // Stronger than the original's "no served blob opens as the roster", and it is the assertion
    // this tree can actually make: the two real accounts' blobs were pulled from the repository on
    // 2026-09-15 and a new account's reaches R2 directly, so a `data-*.enc` appearing back under the
    // publicDir is a regression whatever it decrypts to. .gitignore:62-63 refuses it at commit time;
    // this refuses it on disk, where an atomic write or a stale checkout could still put one.
    expect(await servedBlobs()).toEqual([]);
  });
});

// G10 — the served blobs stay world-readable by decision (VAULT.md §"The served blobs stay
// world-readable"). What makes that safe is the ciphertext, and a v1 blob's passphrase IS its own id
// — the same string the URL already hands out. World-readable would then mean world-openable, which
// is a different decision than the one that was taken. So the decision holds exactly while every
// served vault is v2, and this is what holds it rather than anyone remembering to.
describe("every served vault blob is v2 (G10)", () => {
  it("discriminates: a v1 header is not v2", () => {
    // The control. Without it a predicate that always returned true would pass the check below —
    // and since the sweep's set is empty in a clone by design, this control is now the whole of
    // G10's ability to fail, which is the reason it is kept verbatim.
    expect(isV2(Uint8Array.from([0x48, 0x44, 0x31, 0x01]))).toBe(false);
    expect(isV2(Uint8Array.from([0x48, 0x44, 0x31, 0x02]))).toBe(true);
  });

  it("no served vault has reverted to v1, whose passphrase is its own filename", async () => {
    for (const f of await servedBlobs()) {
      const blob = new Uint8Array(await readFile(resolve(PUBLIC_DIR, f)));
      expect(isV2(blob), `${f} is not HD1 v2`).toBe(true);
    }
  });
});

async function opensAsRoster(path: string, pass: string): Promise<boolean> {
  try {
    return (await decryptVault<Roster>(new Uint8Array(await readFile(path)), pass)).kind === "roster";
  } catch {
    return false; // wrong key, wrong format, or not HD1 at all
  }
}

/**
 * Comments blanked to spaces rather than deleted, so a mention in prose cannot satisfy a sweep while
 * the surviving offsets still line up. The shape tests/unit/org-key-chokepoint.test.ts:73 uses, and
 * for the reason recorded there: the first version of that test passed against a commented-out call.
 */
const blankComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

/** Every `.ts` under the named app-relative directories, with its contents. */
async function sweepTs(dirs: string[]): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".ts")) out.push([relative(APP, full), await readFile(full, "utf8")]);
    }
  };
  for (const d of dirs) await walk(resolve(APP, d));
  return out;
}
