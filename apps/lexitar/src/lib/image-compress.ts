// M54/5 — client-side downscale/recompress for treatment photo intake, so a phone-camera
// original (often several MB) doesn't ride the /api/treatment-image-infer relay uncompressed.
//
// `Blob` and not `File`, because the second caller does not have one: attachment-blob.ts resizes
// bytes it has just decrypted out of the store, and there is no name or modified time to invent for
// them. `createImageBitmap` takes any ImageBitmapSource and `File extends Blob`, so every existing
// call site type-checks unchanged — including the one that reaches this through a dependency slot
// declared as `(file: File) => …`, parameters being contravariant. No second resize function: the
// thumbnail is this one called with a smaller `maxDim`, and the `Math.min(1, …)` below means a
// picture already under that edge is re-encoded rather than stretched.
export async function compressImage(
  file: Blob,
  maxDim = 1024,
  quality = 0.7,
): Promise<{ bytes: Uint8Array; mediaType: "image/jpeg" }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, mediaType: "image/jpeg" };
}
