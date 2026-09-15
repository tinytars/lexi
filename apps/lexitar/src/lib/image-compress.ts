// M54/5 — client-side downscale/recompress for treatment photo intake, so a phone-camera
// original (often several MB) doesn't ride the /api/treatment-image-infer relay uncompressed.
export async function compressImage(
  file: File,
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
