// Chunked base64 for the browser — String.fromCharCode(...bytes) overflows the call stack on a
// multi-MB PDF, so encode in 32 KB windows. Its own module because three unrelated clients
// (report extract, document extract, treatment photos) and the page renderer all need it, and
// hanging it off whichever one happened to be written first made every later importer reach
// through a module it has no other business with.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
