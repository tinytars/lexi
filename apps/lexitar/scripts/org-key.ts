// W44 cutover — the org OPERATIONAL key. A single ECDH keypair whose private key is
// wrapped under an org passphrase and committed (records/org-key.json) per this repo's
// private-secret policy. The public key wraps every vault's DEK into an org-recovery
// envelope at migration/signup; the private key lets the CLI/ops pipeline
// (vault-build/reconcile/vault-verify/migrate) unwrap any vault's DEK and keep the
// plaintext-truth + key-loss-proof model working under v2 (see 44-w44 §H / Open decision #1).
//
// The passphrase is read from ORG_KEY_PASSPHRASE (never hardcoded).

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveKekFromPassword, unwrapPrivateKey } from "@tinytars/vault/crypto";

const here = dirname(fileURLToPath(import.meta.url));
export const ORG_KEY_PATH = resolve(here, "../records/org-key.json");

export interface OrgKeyFile {
  publicKeyJwk: JsonWebKey;
  wrappedPrivateKey: string; // base64 of iv(12)+AES-GCM(PKCS8)
  kdfParams: { salt: string; iterations: number };
  createdAt: string;
}

export const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(Buffer.from(b64, "base64"));
export const bytesToB64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
export const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
export const bytesToHex = (u: Uint8Array): string => Buffer.from(u).toString("hex");

export function orgKeyExists(): boolean {
  return existsSync(ORG_KEY_PATH);
}

export function loadOrgKeyFile(): OrgKeyFile {
  return JSON.parse(readFileSync(ORG_KEY_PATH, "utf8")) as OrgKeyFile;
}

export function loadOrgPublicKey(): JsonWebKey {
  return loadOrgKeyFile().publicKeyJwk;
}

export function orgPassphrase(): string {
  const p = process.env.ORG_KEY_PASSPHRASE;
  if (!p) throw new Error("ORG_KEY_PASSPHRASE is not set");
  return p;
}

export async function loadOrgPrivateKey(passphrase = orgPassphrase()): Promise<CryptoKey> {
  const f = loadOrgKeyFile();
  const kek = await deriveKekFromPassword(passphrase, hexToBytes(f.kdfParams.salt));
  return unwrapPrivateKey(b64ToBytes(f.wrappedPrivateKey), kek);
}
