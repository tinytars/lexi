import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash } from "node:crypto";

// scripts/vault-restore.ts's restore() is otherwise untestable without live R2 + a real org
// passphrase: getObject/putObject/listObjects/deleteObject (scripts/vault-sync.ts) hit the
// Cloudflare REST API directly, and loadOrgPrivateKey (scripts/org-key.ts) reads a
// passphrase-wrapped key file. Both are mocked at their module boundary — the same pattern the
// repo already uses for @simplewebauthn/server — so this exercises the REAL HD1 v2 crypto
// (encryptVaultV2/wrapDEKForPublicKey/openV2) and the REAL drill logic in restore() against an
// in-memory R2 substitute, never a live bucket or wrangler.
const r2 = vi.hoisted(() => new Map<string, Uint8Array>());
const orgKeyBox = vi.hoisted(() => ({ pub: undefined as JsonWebKey | undefined, priv: undefined as CryptoKey | undefined }));

vi.mock("../../scripts/vault-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/vault-sync")>();
  return {
    ...actual,
    getObject: async (bucket: string, key: string) => r2.get(`${bucket}::${key}`) ?? null,
    putObject: async (bucket: string, key: string, body: Uint8Array) => {
      r2.set(`${bucket}::${key}`, body);
    },
    listObjects: async (bucket: string, prefix?: string) => {
      const p = `${bucket}::${prefix ?? ""}`;
      return [...r2.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => ({ key: k.slice(bucket.length + 2), size: r2.get(k)!.length, etag: "x" }));
    },
    deleteObject: async (bucket: string, key: string) => {
      r2.delete(`${bucket}::${key}`);
    },
  };
});

vi.mock("../../scripts/org-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/org-key")>();
  return {
    ...actual,
    loadOrgPublicKey: () => orgKeyBox.pub as JsonWebKey,
    loadOrgPrivateKey: async () => orgKeyBox.priv as CryptoKey,
  };
});

import { restore } from "../../scripts/vault-restore";
import { BACKUP_BUCKET, LIVE_BUCKET } from "../../scripts/vault-sync";
import { bodyKeyFor, manifestKey, snapshotPrefix, type SnapshotManifest, type SnapshotObject } from "../../scripts/vault-snapshot";
import { generateAccountKeypair, generateDEK, encryptVaultV2, wrapDEKForPublicKey } from "@tinytars/vault/crypto";

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const setBackup = (key: string, bytes: Uint8Array) => r2.set(`${BACKUP_BUCKET}::${key}`, bytes);
const setBackupJson = (key: string, obj: unknown) => setBackup(key, new TextEncoder().encode(JSON.stringify(obj)));

beforeAll(async () => {
  const orgKp = await generateAccountKeypair();
  orgKeyBox.pub = orgKp.publicKeyJwk;
  orgKeyBox.priv = orgKp.privateKey;
});

describe("vault-restore drill — the three DrillStatus outcomes", () => {
  it("opens a vault with an org envelope, byte-verifies one with none, and fails one with no HD1 magic", async () => {
    const snapshotId = "snap-outcomes";
    const store = "unit-store";
    const scratch = "unit-scratch-outcomes";
    const orgAccountId = "org-account-1";

    // vault-opened: a real HD1 v2 blob, org-recovery envelope present.
    const dek = await generateDEK();
    const openedBlob = await encryptVaultV2({ clients: {} }, dek);
    const env = await wrapDEKForPublicKey(dek, orgKeyBox.pub!);

    // vault-bytesonly: a real HD1 v2 blob, but no org envelope row at all.
    const bytesOnlyDek = await generateDEK();
    const bytesOnlyBlob = await encryptVaultV2({ clients: {} }, bytesOnlyDek);

    // vault-failed: bytes that are NOT an HD1 blob at all (e.g. a corrupted/truncated write).
    const failedBlob = new TextEncoder().encode("not a vault blob");

    const objects = [
      { key: `${store}/data-opened.enc`, bytes: openedBlob },
      { key: `${store}/data-bytesonly.enc`, bytes: bytesOnlyBlob },
      { key: `${store}/data-failed.enc`, bytes: failedBlob },
    ];
    for (const o of objects) setBackup(bodyKeyFor(store, snapshotId, o.key), o.bytes);

    const manifest: SnapshotManifest = {
      snapshotId,
      createdAt: new Date().toISOString(),
      store,
      sourceBucket: LIVE_BUCKET,
      backupBucket: BACKUP_BUCKET,
      counts: { vault: 3, chat: 0, raw: 0, processed: 0, text: 0, logs: 0 },
      bytes: objects.reduce((n, o) => n + o.bytes.length, 0),
      objects: objects.map((o) => ({ key: o.key, size: o.bytes.length, sha256: sha256Hex(o.bytes), class: "vault" as const })),
      logBundleKey: `${snapshotPrefix(store, snapshotId)}logs.ndjson`,
      d1: { database: "health-identity-dev", sqlKey: "", jsonKey: `${snapshotPrefix(store, snapshotId)}d1.json`, sqlBytes: 0, rows: {} },
    };
    setBackupJson(manifestKey(store, snapshotId), manifest);

    setBackupJson(manifest.d1.jsonKey, {
      database: "health-identity-dev",
      tables: {
        accounts: [{ id: orgAccountId, display_name: "Org", email: null }],
        public_keys: [{ account_id: orgAccountId, public_key_jwk: JSON.stringify(orgKeyBox.pub) }],
        vaults: [
          { vault_id: "vault-opened", owner_account_id: "owner-1", r2_key: "data-opened.enc", hd1_version: 2 },
          { vault_id: "vault-bytesonly", owner_account_id: "owner-2", r2_key: "data-bytesonly.enc", hd1_version: 2 },
          { vault_id: "vault-failed", owner_account_id: "owner-3", r2_key: "data-failed.enc", hd1_version: 2 },
        ],
        vault_envelopes: [
          {
            vault_id: "vault-opened",
            principal_account_id: orgAccountId,
            wrapped_dek: Buffer.from(env.wrappedDEK).toString("hex"),
            ephemeral_public_key_jwk: JSON.stringify(env.ephemeralPublicKeyJwk),
          },
        ],
      },
    });

    const report = await restore({ store, snapshotId, scratch, keepScratch: false });

    expect(report.ok).toBe(false); // any "failed" entry flips ok to false
    const byId = new Map(report.vaults.map((v) => [v.vaultId, v]));
    expect(byId.get("vault-opened")?.status).toBe("opened");
    expect(byId.get("vault-bytesonly")?.status).toBe("bytes-only");
    expect(byId.get("vault-bytesonly")?.detail).toMatch(/no org envelope/);
    expect(byId.get("vault-failed")?.status).toBe("failed");
    expect(byId.get("vault-failed")?.detail).toMatch(/not an HD1 blob/);
  });
});

describe("vault-restore drill — backup integrity", () => {
  it("aborts the whole restore (not a per-vault failed status) when a backed-up object's bytes don't match the manifest digest", async () => {
    const snapshotId = "snap-digest-mismatch";
    const store = "unit-store-digest";
    const scratch = "unit-scratch-digest";
    const bytes = new TextEncoder().encode("some vault bytes");
    const key = `${store}/data-tampered.enc`;
    setBackup(bodyKeyFor(store, snapshotId, key), bytes);

    const manifest: SnapshotManifest = {
      snapshotId,
      createdAt: new Date().toISOString(),
      store,
      sourceBucket: LIVE_BUCKET,
      backupBucket: BACKUP_BUCKET,
      counts: { vault: 1, chat: 0, raw: 0, processed: 0, text: 0, logs: 0 },
      bytes: bytes.length,
      // Wrong digest on purpose — simulates the backup bytes having changed since the manifest
      // was written (bit rot / a partial re-upload), which fetchBody() must catch before it ever
      // reaches the per-vault drill loop.
      objects: [{ key, size: bytes.length, sha256: "0".repeat(64), class: "vault" as const }],
      logBundleKey: `${snapshotPrefix(store, snapshotId)}logs.ndjson`,
      d1: { database: "health-identity-dev", sqlKey: "", jsonKey: `${snapshotPrefix(store, snapshotId)}d1.json`, sqlBytes: 0, rows: {} },
    };
    setBackupJson(manifestKey(store, snapshotId), manifest);
    setBackupJson(manifest.d1.jsonKey, { database: "health-identity-dev", tables: {} });

    await expect(restore({ store, snapshotId, scratch, keepScratch: false })).rejects.toThrow(/differ from the manifest digest/);
  });
});

// W75 — everything above this line is the happy path plus one digest mismatch: two `it` blocks for a
// 105-line routine whose entire job is to be right on the day the live store is gone. What follows is
// the failure half — the destructive-restore guard, a missing body, the wrong org key, a blob D1
// registers and the backup does not have, a payload that decrypts to something that is not a vault,
// an orphan blob, the log bundle, and the scratch cleanup. Every one of these either loses PHI or
// reports a green drill over a backup that cannot actually be restored.

interface SeedObject {
  key: string;
  bytes: Uint8Array;
  class?: SnapshotObject["class"];
}

function seedSnapshot(args: {
  store: string;
  snapshotId: string;
  objects: SeedObject[];
  /** Log entries: written into the NDJSON bundle AND claimed in the manifest. */
  logs?: { key: string; text: string; bundleText?: string; inBundle?: boolean }[];
  d1?: D1Tables;
  /** Manifest digest override, for corrupting one entry. */
  omitBodies?: Set<string>;
}): SnapshotManifest {
  const { store, snapshotId, objects, logs = [], d1 = {} } = args;
  for (const o of objects) {
    if (!args.omitBodies?.has(o.key)) setBackup(bodyKeyFor(store, snapshotId, o.key), o.bytes);
  }

  const logEntries = logs.map((l) => {
    const bytes = new TextEncoder().encode(l.text);
    return { key: l.key, size: bytes.length, sha256: sha256Hex(bytes), class: "logs" as const };
  });
  setBackup(
    `${snapshotPrefix(store, snapshotId)}logs.ndjson`,
    new TextEncoder().encode(
      logs
        .filter((l) => l.inBundle !== false)
        .map((l) => JSON.stringify({ key: l.key, sha256: "unused", text: l.bundleText ?? l.text }))
        .join("\n"),
    ),
  );

  const manifest: SnapshotManifest = {
    snapshotId,
    createdAt: new Date().toISOString(),
    store,
    sourceBucket: LIVE_BUCKET,
    backupBucket: BACKUP_BUCKET,
    counts: { vault: objects.length, chat: 0, raw: 0, processed: 0, text: 0, logs: logEntries.length },
    bytes: objects.reduce((n, o) => n + o.bytes.length, 0),
    objects: [
      ...objects.map((o) => ({ key: o.key, size: o.bytes.length, sha256: sha256Hex(o.bytes), class: o.class ?? ("vault" as const) })),
      ...logEntries,
    ],
    logBundleKey: `${snapshotPrefix(store, snapshotId)}logs.ndjson`,
    d1: {
      database: "health-identity-dev",
      sqlKey: "",
      jsonKey: `${snapshotPrefix(store, snapshotId)}d1.json`,
      sqlBytes: 0,
      rows: {},
    },
  };
  setBackupJson(manifestKey(store, snapshotId), manifest);
  setBackupJson(manifest.d1.jsonKey, { database: "health-identity-dev", tables: d1 });
  return manifest;
}

interface D1Tables {
  accounts?: unknown[];
  public_keys?: { account_id: string; public_key_jwk: string }[];
  vaults?: { vault_id: string; owner_account_id: string; r2_key: string; hd1_version: number }[];
  vault_envelopes?: unknown[];
}

const ORG_ACCOUNT = "org-account-1";
const orgPublicKeys = () => [{ account_id: ORG_ACCOUNT, public_key_jwk: JSON.stringify(orgKeyBox.pub) }];

/** A real HD1 v2 blob plus the org-recovery envelope row that opens it. */
async function openableVault(vaultId: string, payload: unknown = { clients: {} }) {
  const dek = await generateDEK();
  const blob = await encryptVaultV2(payload, dek);
  const env = await wrapDEKForPublicKey(dek, orgKeyBox.pub!);
  return {
    blob,
    envelopeRow: {
      vault_id: vaultId,
      principal_account_id: ORG_ACCOUNT,
      wrapped_dek: Buffer.from(env.wrappedDEK).toString("hex"),
      ephemeral_public_key_jwk: JSON.stringify(env.ephemeralPublicKeyJwk),
    },
  };
}

describe("vault-restore drill — the guard on the most destructive thing this tool can do", () => {
  // Restoring onto a live prefix overwrites current PHI with older bytes. There is no flag for it and
  // there should not be; this asserts the refusal happens BEFORE any object is written.
  it.each(["dev", "prod", "preview"])("refuses to restore onto the deploy prefix %s", async (scratch) => {
    const store = "unit-store-guard";
    const snapshotId = `snap-guard-${scratch}`;
    seedSnapshot({ store, snapshotId, objects: [{ key: `${store}/data-a.enc`, bytes: new TextEncoder().encode("x") }] });

    await expect(restore({ store, snapshotId, scratch })).rejects.toThrow(/refusing to restore onto the live store prefix/);
    expect([...r2.keys()].some((k) => k.startsWith(`${LIVE_BUCKET}::${scratch}/`))).toBe(false);
  });

  it("refuses to restore a store's snapshot back over that same store", async () => {
    const store = "unit-store-self";
    const snapshotId = "snap-self";
    seedSnapshot({ store, snapshotId, objects: [{ key: `${store}/data-a.enc`, bytes: new TextEncoder().encode("x") }] });

    await expect(restore({ store, snapshotId, scratch: store })).rejects.toThrow(/refusing to restore onto the live store prefix/);
  });
});

describe("vault-restore drill — a backup that is not all there", () => {
  it("aborts when the manifest claims an object the backup bucket does not hold", async () => {
    const store = "unit-store-gone";
    const snapshotId = "snap-gone";
    const key = `${store}/data-gone.enc`;
    seedSnapshot({
      store,
      snapshotId,
      objects: [{ key, bytes: new TextEncoder().encode("bytes that were never uploaded") }],
      omitBodies: new Set([key]),
    });

    await expect(restore({ store, snapshotId, scratch: "unit-scratch-gone" })).rejects.toThrow(
      /snapshot object missing from the backup bucket/,
    );
  });

  it("fails the vault D1 registers but the snapshot has no blob for, instead of skipping it", async () => {
    const store = "unit-store-noblob";
    const snapshotId = "snap-noblob";
    seedSnapshot({
      store,
      snapshotId,
      objects: [],
      d1: {
        public_keys: orgPublicKeys(),
        vaults: [{ vault_id: "vault-ghost", owner_account_id: "owner-1", r2_key: "data-ghost.enc", hd1_version: 2 }],
      },
    });

    const report = await restore({ store, snapshotId, scratch: "unit-scratch-noblob" });
    expect(report.ok).toBe(false);
    expect(report.vaults[0].status).toBe("failed");
    expect(report.vaults[0].detail).toMatch(/no restored object at/);
  });

  it("reports a vault blob with no D1 row as an orphan — nothing knows which DEK opens it", async () => {
    const store = "unit-store-orphan";
    const snapshotId = "snap-orphan";
    const { blob, envelopeRow } = await openableVault("vault-known");
    seedSnapshot({
      store,
      snapshotId,
      objects: [
        { key: `${store}/data-known.enc`, bytes: blob },
        { key: `${store}/data-orphan.enc`, bytes: blob },
      ],
      d1: {
        public_keys: orgPublicKeys(),
        vaults: [{ vault_id: "vault-known", owner_account_id: "owner-1", r2_key: "data-known.enc", hd1_version: 2 }],
        vault_envelopes: [envelopeRow],
      },
    });

    const report = await restore({ store, snapshotId, scratch: "unit-scratch-orphan" });
    expect(report.orphanBlobs).toEqual([`${store}/data-orphan.enc`]);
    // Still `ok` — an orphan is reported, not a failure, but it must never be invisible.
    expect(report.ok).toBe(true);
  });
});

describe("vault-restore drill — restored material that is not what it claims to be", () => {
  // Without this the drill would report every vault `bytes-only` and read as a benign key-custody
  // result, when in fact the operator is holding the wrong org key and can open nothing.
  it("aborts when no restored public key matches the org key, rather than reporting bytes-only", async () => {
    const store = "unit-store-wrongkey";
    const snapshotId = "snap-wrongkey";
    const stranger = await generateAccountKeypair();
    const { blob } = await openableVault("vault-x");
    seedSnapshot({
      store,
      snapshotId,
      objects: [{ key: `${store}/data-x.enc`, bytes: blob }],
      d1: {
        public_keys: [{ account_id: "someone-else", public_key_jwk: JSON.stringify(stranger.publicKeyJwk) }],
        vaults: [{ vault_id: "vault-x", owner_account_id: "owner-1", r2_key: "data-x.enc", hd1_version: 2 }],
      },
    });

    await expect(restore({ store, snapshotId, scratch: "unit-scratch-wrongkey" })).rejects.toThrow(
      /cannot be opened by the org key/,
    );
  });

  it("fails a blob that decrypts cleanly but is not a vault", async () => {
    const store = "unit-store-notvault";
    const snapshotId = "snap-notvault";
    const { blob, envelopeRow } = await openableVault("vault-notvault", { somethingElse: true });
    seedSnapshot({
      store,
      snapshotId,
      objects: [{ key: `${store}/data-notvault.enc`, bytes: blob }],
      d1: {
        public_keys: orgPublicKeys(),
        vaults: [{ vault_id: "vault-notvault", owner_account_id: "owner-1", r2_key: "data-notvault.enc", hd1_version: 2 }],
        vault_envelopes: [envelopeRow],
      },
    });

    const report = await restore({ store, snapshotId, scratch: "unit-scratch-notvault" });
    expect(report.ok).toBe(false);
    expect(report.vaults[0].status).toBe("failed");
    expect(report.vaults[0].detail).toMatch(/not a vault/);
  });

  it("fails a blob whose envelope belongs to a different vault — a mis-keyed row is not an open", async () => {
    const store = "unit-store-mixed";
    const snapshotId = "snap-mixed";
    const a = await openableVault("vault-a");
    const b = await openableVault("vault-b");
    seedSnapshot({
      store,
      snapshotId,
      objects: [{ key: `${store}/data-a.enc`, bytes: a.blob }],
      d1: {
        public_keys: orgPublicKeys(),
        vaults: [{ vault_id: "vault-a", owner_account_id: "owner-1", r2_key: "data-a.enc", hd1_version: 2 }],
        // b's wrapped DEK, filed under a's vault_id.
        vault_envelopes: [{ ...b.envelopeRow, vault_id: "vault-a" }],
      },
    });

    const report = await restore({ store, snapshotId, scratch: "unit-scratch-mixed" });
    expect(report.vaults[0].status).toBe("failed");
  });
});

describe("vault-restore drill — the audit bundle", () => {
  const logKey = (store: string) => `${store}/logs/refresh-finding/2026-08-01/a1-1.json`;

  it("digest-verifies every claimed log entry in the bundle without expanding them", async () => {
    const store = "unit-store-logs";
    const snapshotId = "snap-logs";
    seedSnapshot({ store, snapshotId, objects: [], logs: [{ key: logKey(store), text: '{"event":"one"}' }] });

    const report = await restore({ store, snapshotId, scratch: "unit-scratch-logs" });
    expect(report.logsVerified).toBe(1);
    expect(report.logsExpanded).toBe(false);
    expect(r2.has(`${LIVE_BUCKET}::unit-scratch-logs/logs/refresh-finding/2026-08-01/a1-1.json`)).toBe(false);
  });

  it("aborts when a bundled log entry's text no longer hashes to the manifest digest", async () => {
    const store = "unit-store-logrot";
    const snapshotId = "snap-logrot";
    seedSnapshot({
      store,
      snapshotId,
      objects: [],
      logs: [{ key: logKey(store), text: '{"event":"one"}', bundleText: '{"event":"tampered"}' }],
    });

    await expect(restore({ store, snapshotId, scratch: "unit-scratch-logrot" })).rejects.toThrow(
      /log entry digest mismatch in the bundle/,
    );
  });

  it("aborts when the manifest claims a log entry the bundle does not contain", async () => {
    const store = "unit-store-loggone";
    const snapshotId = "snap-loggone";
    seedSnapshot({
      store,
      snapshotId,
      objects: [],
      logs: [{ key: logKey(store), text: '{"event":"one"}', inBundle: false }],
    });

    await expect(restore({ store, snapshotId, scratch: "unit-scratch-loggone" })).rejects.toThrow(
      /log entry absent from the bundle/,
    );
  });

  it("expands log entries into the scratch prefix when asked", async () => {
    const store = "unit-store-logexp";
    const snapshotId = "snap-logexp";
    seedSnapshot({ store, snapshotId, objects: [], logs: [{ key: logKey(store), text: '{"event":"one"}' }] });

    const report = await restore({ store, snapshotId, scratch: "unit-scratch-logexp", expandLogs: true, keepScratch: true });
    expect(report.logsExpanded).toBe(true);
    expect(r2.has(`${LIVE_BUCKET}::unit-scratch-logexp/logs/refresh-finding/2026-08-01/a1-1.json`)).toBe(true);
  });
});

describe("vault-restore drill — the scratch prefix", () => {
  // The drill is meant to run routinely, which it cannot do if each run leaves a full copy of the
  // vault behind in the live bucket.
  it("removes everything it wrote by default, and leaves it when asked to keep it", async () => {
    const store = "unit-store-scratch";
    const bytes = new TextEncoder().encode("some bytes");
    const written = (scratch: string) => [...r2.keys()].filter((k) => k.startsWith(`${LIVE_BUCKET}::${scratch}/`));

    seedSnapshot({ store, snapshotId: "snap-clean", objects: [{ key: `${store}/data-a.enc`, bytes }] });
    await restore({ store, snapshotId: "snap-clean", scratch: "unit-scratch-clean" });
    expect(written("unit-scratch-clean")).toEqual([]);

    seedSnapshot({ store, snapshotId: "snap-keep", objects: [{ key: `${store}/data-a.enc`, bytes }] });
    const kept = await restore({ store, snapshotId: "snap-keep", scratch: "unit-scratch-keep", keepScratch: true });
    expect(kept.restored).toBe(1);
    expect(written("unit-scratch-keep")).toEqual([`${LIVE_BUCKET}::unit-scratch-keep/data-a.enc`]);
  });
});
