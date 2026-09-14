import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { decryptVault } from "@tinytars/vault/crypto";
import { DATA_PATH, PUBLIC_DIR } from "../../scripts/vault-io";
import { isV2 } from "../../scripts/vault-v2";
import { rosterPass } from "../../scripts/vault-verify";
import type { Roster } from "../../src/lib/types";

// G1 — a patient's name must not be the system's identifier. The ciphertext was always sound; the
// FILENAME was the leak, because `records/public/data-{id}.enc` is served unauthenticated at a
// guessable URL and `{id}` is also the R2 key, the `/api/vault/{id}` route and the address bar.
//
// So this asserts the one property that closes it: no name that appears as a `displayName` may
// appear in any identifier derived from it. The names are read from the roster at runtime rather
// than listed here — a literal list would go stale the moment a client is added, and would itself
// put the names back into the repo in plaintext.

/** Every identifier-bearing string that leaves the ciphertext: served filenames, dirs, vault keys. */
async function identifiers(): Promise<string[]> {
  const roster = JSON.parse(await readFile(resolve("records/private/roster.json"), "utf8")) as Roster;
  const out = [...Object.keys(roster.clients)];
  out.push(...(await readdir(resolve("records/public"))).filter((f) => f.endsWith(".enc")));
  out.push(
    ...(await readdir(resolve("records/private"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  return out;
}

/** Which identifiers embed one of the display names. Pure, so it can be proven able to fail. */
export function leaks(names: string[], ids: string[]): string[] {
  const needles = names.map((n) => n.toLowerCase()).filter(Boolean);
  return ids.filter((id) => needles.some((n) => id.toLowerCase().includes(n)));
}

describe("vault identifier opacity (G1)", () => {
  it("flags an identifier that embeds a display name", () => {
    // The check has to be able to go red, so prove it on the exact shape G1 removed rather than
    // trusting a green run over records that no longer contain the defect.
    expect(leaks(["Pablo"], ["data-pablo.enc", "data-0b8c.enc"])).toEqual(["data-pablo.enc"]);
    expect(leaks(["Pablo"], ["data-0b8c.enc"])).toEqual([]);
  });

  it("no served filename, private directory or vault key embeds a display name", async () => {
    const roster = JSON.parse(await readFile(resolve("records/private/roster.json"), "utf8")) as Roster;
    const names = Object.values(roster.clients).map((c) => c.displayName ?? "");
    expect(names.filter(Boolean).length).toBeGreaterThan(0); // vacuous with no names to look for
    const found = leaks(names, await identifiers());
    expect(found, `these identifiers embed a patient's display name: ${found.join(", ")}`).toEqual([]);
  });
});

// G8 — the roster was served too, and it is the one artifact that maps an opaque client id back to a
// patient's name. G1 made the ids opaque; a served roster hands the mapping back. It also carries the
// weakest crypto here (v1/PBKDF2, outside the W44 envelope model) and has had no browser consumer
// since /api/providers/patients replaced it at the W44 cutover.
//
// Being outside Vite's publicDir is the mechanism — a served file cannot be un-served by remembering
// not to ship it. These two assert the mechanism holds and that no copy slipped past it.

async function opensAsRoster(path: string, pass: string): Promise<boolean> {
  try {
    return (await decryptVault<Roster>(new Uint8Array(await readFile(path)), pass)).kind === "roster";
  } catch {
    return false; // wrong key, wrong format, or not HD1 at all
  }
}

// G10 — the served blobs stay world-readable by decision (VAULT.md §"The served blobs stay
// world-readable"). What makes that safe is the ciphertext, and a v1 blob's passphrase IS its own
// id — the same string the URL already hands out. World-readable would then mean world-openable,
// which is a different decision than the one that was taken. So the decision holds exactly while
// every served vault is v2, and this is what holds it rather than anyone remembering to.
describe("every served vault blob is v2 (G10)", () => {
  it("discriminates: a v1 header is not v2", () => {
    // The control. Without it a predicate that always returned true would pass the check below.
    expect(isV2(Uint8Array.from([0x48, 0x44, 0x31, 0x01]))).toBe(false);
    expect(isV2(Uint8Array.from([0x48, 0x44, 0x31, 0x02]))).toBe(true);
  });

  it("no served vault has reverted to v1, whose passphrase is its own filename", async () => {
    const served = (await readdir(PUBLIC_DIR)).filter((f) => f.endsWith(".enc") && !f.endsWith(".dek.enc"));
    expect(served.length).toBeGreaterThan(0); // nothing to scan is not a pass
    for (const f of served) {
      const blob = new Uint8Array(await readFile(resolve(PUBLIC_DIR, f)));
      expect(isV2(blob), `${f} is not HD1 v2`).toBe(true);
    }
  });
});

describe("the roster is not a served artifact (G8)", () => {
  it("keeps the roster blob outside Vite's publicDir", () => {
    expect(relative(PUBLIC_DIR, DATA_PATH).startsWith("..")).toBe(true);
  });

  it("no served blob opens as the roster", async () => {
    const pass = rosterPass();
    // Control first: the roster itself MUST open under this passphrase. Without it a broken
    // decrypt path would make every blob below "not the roster" and the check would pass vacuously.
    expect(await opensAsRoster(DATA_PATH, pass)).toBe(true);

    const served = (await readdir(PUBLIC_DIR)).filter((f) => f.endsWith(".enc"));
    expect(served.length).toBeGreaterThan(0); // nothing to scan is not a pass
    for (const f of served) {
      expect(await opensAsRoster(resolve(PUBLIC_DIR, f), pass), `${f} opens as the roster`).toBe(false);
    }
  });
});
