// Byte <-> base64. Pure, no reactive state — they were the first functions in App.svelte's 1677-line
// script block purely because that is where they were first needed.
//
// The vault-id reader that used to live here is `vaultIdFromR2Key` in ./client-id — it is about ids,
// not bytes, and it belongs beside `normalizeClientId` so the two cannot be confused for each other.

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
