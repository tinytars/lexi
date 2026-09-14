export function normalizeClientId(clientId: string): string {
  return clientId.toLowerCase();
}

/**
 * `data-{id}.enc` -> `{id}`: the vault id an R2 key encodes, which is what `/api/vault/{id}` takes.
 *
 * A key->key derivation, NOT an identity. A rotation moves `vaults.r2_key` to a fresh uuid while the
 * vault's own `clients` map keeps the old one, so this id and a client id are equal only by today's
 * coincidence — select a client from the decrypted vault's keys, never from a filename. Null when the
 * key is not a vault blob; three copies of this regex had already drifted on exactly that case.
 */
export function vaultIdFromR2Key(r2Key: string): string | null {
  return /^data-(.+)\.enc$/.exec(r2Key)?.[1] ?? null;
}
