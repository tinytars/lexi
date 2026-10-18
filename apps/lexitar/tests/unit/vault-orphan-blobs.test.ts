// The decisions scripts/vault-orphan-blobs.ts makes before it deletes anything. The command itself
// needs a live R2 listing and a live D1; what can be wrong without a store in front of you is which
// keys it is willing to call abandoned, so that is what is tested here.
import { describe, it, expect } from "vitest";
import {
  isVaultBlobKey,
  orphanBlobs,
  minAgeHours,
  referencedStoreKeys,
  keepSetMatchFailure,
  ageGuardBlindFailure,
} from "../../scripts/vault-orphan-blobs";
import { r2KeyFor, r2ListEntry } from "../../scripts/vault-sync";
import type { R2ObjectInfo } from "../../scripts/vault-sync";

const NOW = new Date("2026-10-07T16:00:00Z");
const ID = "34e0a776-65af-4c98-96d0-761485e569b8";
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const obj = (key: string, uploaded?: string): R2ObjectInfo => ({ key, size: 1, etag: "e", uploaded });

describe("which keys the sweep is willing to call a vault blob", () => {
  it("accepts exactly the shape the app writes, taken from r2KeyFor rather than retyped", () => {
    expect(isVaultBlobKey("prod", r2KeyFor("prod", ID))).toBe(true);
  });

  it("rejects a wrapped-DEK sidecar, which carries the same stem and is not the blob", () => {
    expect(isVaultBlobKey("prod", `prod/data-${ID}.dek.enc`)).toBe(false);
  });

  it("rejects a raw or processed object, which orphan-sweep.ts owns and this must not touch", () => {
    expect(isVaultBlobKey("prod", `prod/raw/${ID}/report.pdf`)).toBe(false);
    expect(isVaultBlobKey("prod", `prod/processed/${ID}/a1b2c3d4.json`)).toBe(false);
  });

  it("rejects another store's blob, so a dev run cannot name a prod object", () => {
    expect(isVaultBlobKey("dev", r2KeyFor("prod", ID))).toBe(false);
  });

  it("rejects a stem that is not a uuid, so nothing hand-named is sweepable", () => {
    expect(isVaultBlobKey("prod", "prod/data-backup.enc")).toBe(false);
  });
});

describe("which listed blobs are abandoned", () => {
  it("drops one a vaults row still points at", () => {
    const live = obj(r2KeyFor("prod", ID), hoursAgo(500));
    expect(orphanBlobs([live], [live.key], 24, NOW)).toEqual([]);
  });

  it("keeps an unclaimed blob older than the guard", () => {
    const old = obj(r2KeyFor("prod", ID), hoursAgo(25));
    expect(orphanBlobs([old], [], 24, NOW)).toEqual([old]);
  });

  // The failure this guard exists for: vault-rekey writes the new object and repoints D1 afterwards,
  // so between those two writes the NEW blob is unclaimed. Sweeping it destroys the vault.
  it("refuses an unclaimed blob younger than the guard, which may be a rotation in flight", () => {
    const young = obj(r2KeyFor("prod", ID), hoursAgo(1));
    expect(orphanBlobs([young], [], 24, NOW)).toEqual([]);
  });

  it("refuses one whose upload time the listing did not report, rather than guessing it is old", () => {
    expect(orphanBlobs([obj(r2KeyFor("prod", ID))], [], 24, NOW)).toEqual([]);
  });

  it("takes an unclaimed blob of any age once the guard is turned off", () => {
    const young = obj(r2KeyFor("prod", ID), hoursAgo(1));
    expect(orphanBlobs([young], [], 0, NOW)).toEqual([young]);
  });
});

describe("the age guard's argument", () => {
  it("defaults to 24 hours when the flag is absent", () => {
    expect(minAgeHours(["node", "x"])).toBe(24);
  });

  it("takes the value given, including zero", () => {
    expect(minAgeHours(["node", "x", "--min-age-hours", "0"])).toBe(0);
  });

  it("refuses a negative or unparseable value rather than defaulting past it", () => {
    expect(() => minAgeHours(["node", "x", "--min-age-hours", "-1"])).toThrow(/non-negative/);
    expect(() => minAgeHours(["node", "x", "--min-age-hours", "soon"])).toThrow(/non-negative/);
  });
});

// The defect these exist for, and it is worth stating plainly because the report did not reveal it:
// `vaults.r2_key` is `data-{uuid}.enc` and an R2 key is `{store}/data-{uuid}.enc`, so feeding the
// column straight into orphanBlobs produced a keep-set that matched NOTHING. Every live blob was
// classified abandoned, and only the 24h age guard stood between --apply and deleting the store —
// which hid it for exactly as long as the last rotation was under a day old.
describe("the keep-set is in the same namespace as the listing", () => {
  const STAGED = "9f1c2e3d-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

  it("converts the bare column value into the store key the listing returns", () => {
    expect(referencedStoreKeys("dev", [{ r2_key: `data-${ID}.enc` }])).toEqual([r2KeyFor("dev", ID)]);
  });

  // The whole bug, end to end, through the real builders. This is what used to come back non-empty.
  it("no longer calls a live, claimed blob abandoned", () => {
    const live = obj(r2KeyFor("dev", ID), hoursAgo(500));
    const referenced = referencedStoreKeys("dev", [{ r2_key: `data-${ID}.enc` }]);
    expect(orphanBlobs([live], referenced, 24, NOW)).toEqual([]);
  });

  it("counts a staged rotation as a claim, because /api/vault/{id} serves a blob found by it", () => {
    const staged = obj(r2KeyFor("dev", STAGED), hoursAgo(500));
    const referenced = referencedStoreKeys("dev", [
      { r2_key: `data-${ID}.enc`, rotation_staging_r2_key: `data-${STAGED}.enc` },
    ]);
    expect(referenced).toContain(r2KeyFor("dev", STAGED));
    expect(orphanBlobs([staged], referenced, 24, NOW)).toEqual([]);
  });

  it("lowercases through r2KeyFor, so a differently-cased row still claims its object", () => {
    expect(referencedStoreKeys("dev", [{ r2_key: `data-${ID.toUpperCase()}.enc` }])).toEqual([r2KeyFor("dev", ID)]);
  });

  it("takes an already-prefixed value as given rather than prefixing it twice", () => {
    expect(referencedStoreKeys("dev", [{ r2_key: r2KeyFor("dev", ID) }])).toEqual([r2KeyFor("dev", ID)]);
  });

  it("ignores a null, absent or blank column instead of claiming a key named for it", () => {
    expect(referencedStoreKeys("dev", [{ r2_key: null, rotation_staging_r2_key: "  " }, {}])).toEqual([]);
  });

  it("deduplicates, so the report's arithmetic is over objects and not over rows", () => {
    const rows = [{ r2_key: `data-${ID}.enc` }, { r2_key: `data-${ID}.enc`, rotation_staging_r2_key: `data-${ID}.enc` }];
    expect(referencedStoreKeys("dev", rows)).toEqual([r2KeyFor("dev", ID)]);
  });

  it("keeps one store's rows out of another store's namespace", () => {
    expect(referencedStoreKeys("prod", [{ r2_key: `data-${ID}.enc` }])).toEqual([r2KeyFor("prod", ID)]);
    expect(referencedStoreKeys("dev", [{ r2_key: `data-${ID}.enc` }])).not.toContain(r2KeyFor("prod", ID));
  });
});

// Refusal 5. "Every blob is abandoned" and "the two sides speak different namespaces" print
// identically, so the only safe reading of a total non-match is that the command is broken.
describe("a keep-set that matches nothing refuses rather than deletes", () => {
  const listed = [obj(r2KeyFor("dev", ID), hoursAgo(500))];

  it("refuses when rows claim keys and blobs are listed but nothing matches", () => {
    const msg = keepSetMatchFailure(listed, [`data-${ID}.enc`], 1);
    expect(msg).toMatch(/NOT ONE matches/);
    expect(msg).toContain(r2KeyFor("dev", ID));
  });

  it("allows the run as soon as a single pair matches", () => {
    expect(keepSetMatchFailure(listed, referencedStoreKeys("dev", [{ r2_key: `data-${ID}.enc` }]), 1)).toBeNull();
  });

  it("does not fire on a store with no vault blobs, which is not a mismatch", () => {
    expect(keepSetMatchFailure([], [], 3)).toBeNull();
  });

  it("does not fire when no vault claims anything, which is a genuinely empty database", () => {
    expect(keepSetMatchFailure(listed, [], 0)).toBeNull();
  });
});

// The third defect in this one command, and the one that would have made the fixed version a no-op.
// `listObjects` read `o.uploaded`; the REST list returns `last_modified`. So every object arrived
// undated, `orphanBlobs` refused each one on principle, and the run printed "Nothing to sweep" —
// a clean bill of health for a store it had declined to look at. The mapping is pinned here, beside
// the guard that depends on it, rather than with the listing code that merely performs it.
describe("the listing's timestamp survives the mapping", () => {
  // Recorded from the live R2 list API against bucket health-vault on 2026-10-07. The field set is
  // the whole point of the fixture: there is no `uploaded` key in it at all.
  const RECORDED = {
    key: "dev/data-29789d3b-51bd-4d03-b0f1-a670e98a6c9d.enc",
    etag: "06813b397d1c1601334cb072c96c59cc",
    last_modified: "2026-07-09T15:33:36.576Z",
    size: 192,
    http_metadata: {},
    custom_metadata: {},
    storage_class: "Standard",
  };

  it("reads last_modified, which is the only timestamp the REST list sends", () => {
    expect(r2ListEntry(RECORDED).uploaded).toBe("2026-07-09T15:33:36.576Z");
  });

  it("still reads uploaded, which is what the Workers binding calls it", () => {
    expect(r2ListEntry({ key: "k", etag: "e", size: 1, uploaded: "2026-01-01T00:00:00Z" }).uploaded).toBe(
      "2026-01-01T00:00:00Z",
    );
  });

  it("coerces the size, which the API may send as a string", () => {
    expect(r2ListEntry({ key: "k", etag: "e", size: "192" }).size).toBe(192);
  });

  it("leaves uploaded undefined when neither name is present, rather than inventing a date", () => {
    expect(r2ListEntry({ key: "k", etag: "e", size: 1 }).uploaded).toBeUndefined();
  });

  // End to end: the mapped entry is one the age guard can actually act on.
  it("makes a July object sweepable, where the unmapped entry was refused as undated", () => {
    const mapped = r2ListEntry(RECORDED);
    expect(orphanBlobs([mapped], [], 24, NOW)).toEqual([mapped]);
    const unmapped: R2ObjectInfo = { key: RECORDED.key, size: 192, etag: "e" };
    expect(orphanBlobs([unmapped], [], 24, NOW)).toEqual([]);
  });
});

// Refusal 6. An undated object is refused one at a time, which is right; a listing that dates
// NOTHING turns that per-object caution into a command that cannot do its job and says so in the
// words of a clean store.
describe("a listing with no timestamps at all refuses rather than reporting nothing to sweep", () => {
  const undated = (id: string): R2ObjectInfo => ({ key: r2KeyFor("dev", id), size: 1, etag: "e" });

  it("refuses when every unclaimed candidate is undated and the guard is armed", () => {
    const msg = ageGuardBlindFailure([undated(ID)], [], 24);
    expect(msg).toMatch(/REFUSING to sweep/);
    expect(msg).toContain("last_modified");
  });

  it("allows the run as soon as one candidate carries a date", () => {
    const dated = obj(r2KeyFor("dev", ID), hoursAgo(500));
    expect(ageGuardBlindFailure([dated, undated("9f1c2e3d-4a5b-6c7d-8e9f-0a1b2c3d4e5f")], [], 24)).toBeNull();
  });

  it("does not fire when every blob is claimed, which is a genuinely clean store", () => {
    const live = undated(ID);
    expect(ageGuardBlindFailure([live], [live.key], 24)).toBeNull();
  });

  it("does not fire on an empty listing", () => {
    expect(ageGuardBlindFailure([], [], 24)).toBeNull();
  });

  it("does not fire with the guard turned off, where no timestamp is consulted", () => {
    expect(ageGuardBlindFailure([undated(ID)], [], 0)).toBeNull();
  });
});
