import { describe, it, expect } from "vitest";
import { verifyVaults } from "../../scripts/vault-verify";

// W13b drift guard: the committed served ciphertext (records/public/*.enc) must decrypt to
// exactly its plaintext source of truth (records/private/{id}/vault.json, roster.enc↔roster.json).
// Reads the real committed files — so a hand-edit of a plaintext vault without `npm run
// vault:build` fails this test, and the pre-push `test:all` gate blocks the drift from shipping.
describe("vault integrity (records/public ↔ records/private)", () => {
  it("every committed .enc decrypts to its plaintext vault.json / roster.json", async () => {
    const results = await verifyVaults();
    expect(results.length).toBeGreaterThan(0); // at least the roster + one client
    const failed = results.filter((r) => !r.ok);
    expect(failed, `drift (run \`npm run vault:build\`): ${JSON.stringify(failed)}`).toEqual([]);
  });

  // W13h: verifyVaults also runs the provenance invariant per client (no dangling
  // sourceId, no tombstone/live collision, every source has its raw + processed files).
  it("runs the provenance check and the committed vaults pass it", async () => {
    const results = await verifyVaults();
    const provenance = results.filter((r) => r.id.endsWith("(provenance)"));
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance.filter((r) => !r.ok)).toEqual([]);
  });
});
