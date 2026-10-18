// An HD1-prefixed ciphertext stand-in; >= 32 bytes passes the routes' shape check.
export function hd1Blob(length = 40): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(length);
  b[0] = 0x48; b[1] = 0x44; b[2] = 0x31;
  for (let i = 3; i < length; i++) b[i] = (i * 7) & 0xff;
  return b;
}
