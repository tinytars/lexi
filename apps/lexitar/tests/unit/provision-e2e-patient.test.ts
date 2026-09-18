import { describe, it, expect } from "vitest";
import { provisionWorld, E2E_PROVIDER } from "../../scripts/provision-e2e-patient";
import { unwrapDEKWithPrivateKey, decryptVaultV2 } from "@tinytars/vault/crypto";
import { syntheticVault } from "../fixtures/synthetic-patient";
import type { Vault } from "../../src/lib/types";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// W69 — prove the provisioned vault actually OPENS.
//
// A wrapped DEK that does not open is indistinguishable from one that does, right up until a browser
// tries to log in — where it surfaces as "cannot unwrap DEK (wrong key or corrupt envelope)" with no
// hint whether the fault is the wrap, the blob, or the SQL. Round-tripping it here turns a class of
// e2e mystery into a unit failure with a name.
//
// This is also the load-bearing claim of the whole phase: that a synthetic patient needs NO secret.
// If this passes with no credentials in the environment, e2e can eventually run somewhere that has
// none — which is the entire reason for building it.

describe("a provisioned e2e patient", () => {
  // Importing must not PROVISION. The first version of this script called main() at module scope, so
  // merely importing it wrote a blob into dist/ and dumped SQL to stdout from inside a unit run —
  // a test that quietly mutates the build output is a trap for whatever runs next.
  it("importing the module does not write anything", async () => {
    const distBlob = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "data-e2e-w9.enc");
    await import("../../scripts/provision-e2e-patient");
    expect(existsSync(distBlob)).toBe(false);
  });

  it("produces a vault the account's own key can open, containing exactly its synthetic content", async () => {
    const [p] = (await provisionWorld(1)).patients;
    const dek = await unwrapDEKWithPrivateKey(p.ownerEnvelope.wrappedDEK, p.ownerEnvelope.ephemeralPublicKeyJwk, p.privateKey);
    const vault = await decryptVaultV2<Vault>(p.blob, dek);
    expect(vault).toEqual(syntheticVault("e2e-w0"));
  });

  it("writes an HD1 v2 blob — the magic the Function checks before self-seeding R2", async () => {
    // functions/api/vault/[id].ts:132 refuses to seed anything that is not HD1, precisely so an SPA
    // index.html served for an unknown path cannot be stored as a "vault".
    const { blob } = (await provisionWorld(1)).patients[0];
    expect(Array.from(blob.slice(0, 4))).toEqual([0x48, 0x44, 0x31, 0x02]); // "HD1" + version 2
  });

  it("names the blob what the Function will look for", async () => {
    const p = (await provisionWorld(3)).patients[2];
    expect(p.r2Key).toBe("data-e2e-w2.enc");
    expect(p.sql.join("\n")).toContain("'data-e2e-w2.enc'");
  });

  it("logs in with a public password — no secret anywhere in the provisioning path", async () => {
    const p = (await provisionWorld(4)).patients[3];
    expect(p.email).toBe("e2e-w3@local.invalid");
    expect(p.password).toBe("e2e-w3"); // the slug itself, exactly like the alex/blair pilots
  });

  // Two patients sharing an id would defeat the entire point: their writes would land on one vault and
  // the race this phase exists to remove would still be there, now silently. Every world also carries
  // the dedicated FRESH patient (see below), so 4 workers means 5 distinct patients, not 4.
  it("gives every patient distinct account, vault and blob identities", async () => {
    const { patients: ps } = await provisionWorld(4);
    expect(ps).toHaveLength(5);
    const accountIds = ps.map((p) => p.sql.find((l) => l.startsWith("INSERT INTO accounts"))!.match(/'(e2e0a[^']+)'/)![1]);
    expect(new Set(accountIds).size).toBe(5);
    expect(new Set(ps.map((p) => p.r2Key)).size).toBe(5);
  });

  // The whole point of FRESH: staleNodes() (src/lib/staleness.ts) short-circuits to "nothing stale"
  // whenever nodeHashes is absent, which is what every OTHER synthetic patient relies on to keep the
  // background leaf-regen sweep quiet. This is the one patient where that gate must stay open.
  it("provisions a dedicated FRESH patient whose Finding reads as stale on every node", async () => {
    const fresh = (await provisionWorld(1)).patients.find((p) => p.slug === "e2e-fresh")!;
    const dek = await unwrapDEKWithPrivateKey(fresh.ownerEnvelope.wrappedDEK, fresh.ownerEnvelope.ephemeralPublicKeyJwk, fresh.privateKey);
    const vault = await decryptVaultV2<Vault>(fresh.blob, dek);
    expect(vault.clients["e2e-fresh"]!.finding!.nodeHashes).toEqual({});
  });

  it("grants an E2E-ONLY clinician, never the pilots' fam4", async () => {
    const { sql, patients } = await provisionWorld(1);
    const joined = patients[0].sql.join("\n");
    expect(joined).toContain(E2E_PROVIDER.accountId);
    expect(joined).toMatch(/INSERT INTO provider_links[^;]*'primary', 'active'/);
    // The regression this replaced: linking to fam4 put synthetic patients on the REAL provider's
    // roster and broke cover-render.spec.ts, which asserts that roster exactly.
    expect(sql.join("\n")).not.toContain("12275343-91b7-431d-ae4a-15c6e092b4a6");
    // And no secret anywhere — fam4's password is the family PASSPHRASE, this one is a literal.
    expect(E2E_PROVIDER.password).toBe("e2e-clinician");
    // Two envelopes: the owner's and the clinician's. A third would mean an org envelope crept in,
    // which would reintroduce the ORG_KEY_PASSPHRASE dependency this design exists to avoid.
    expect(joined.match(/INSERT INTO vault_envelopes/g)).toHaveLength(2);
  });

  it("deletes before it inserts, so re-provisioning replaces rather than accumulates", async () => {
    const { sql } = (await provisionWorld(1)).patients[0];
    const firstInsert = sql.findIndex((l) => l.startsWith("INSERT"));
    expect(sql.slice(0, firstInsert).every((l) => l.startsWith("DELETE"))).toBe(true);
    // Child rows before the account row, or the foreign keys block the delete.
    expect(sql.findIndex((l) => l.includes("DELETE FROM vault_envelopes"))).toBeLessThan(
      sql.findIndex((l) => l.includes("DELETE FROM accounts")),
    );
  });
});
