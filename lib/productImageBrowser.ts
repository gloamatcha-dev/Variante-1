import { PRODUCT_IMAGE_MAX_BYTES, productImageSourceError } from './productImageRules';

/** Originals stay on the computer. Only newly encoded pixels may leave the browser. */
export async function optimizeProductImage(source: File): Promise<File> {
  const invalid = productImageSourceError(source.type, source.size);
  if (invalid) throw new Error(invalid);
  const head = new Uint8Array(await source.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...head.slice(start, end));
  const matches = source.type === 'image/jpeg' ? head[0] === 255 && head[1] === 216 && head[2] === 255
    : source.type === 'image/png' ? [137,80,78,71,13,10,26,10].every((n,i) => head[i] === n)
    : ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP';
  if (!matches) throw new Error('Die Datei enthält kein gültiges JPG-, PNG- oder WebP-Bild.');
  let bitmap: ImageBitmap | undefined;
  const canvas = document.createElement('canvas');
  try {
    // Explicit EXIF orientation; the bitmap dimensions are already oriented.
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 100_000_000) throw new Error('dimensions');
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    for (let attempt = 0; attempt < 7; attempt++) {
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('canvas');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      // PNG/WebP never pass through JPEG, so transparent pixels stay transparent.
      const mime = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
      for (const quality of [0.92, 0.88, 0.84]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, quality));
        // Browsers without WebP encoding return PNG; accept that lossless fallback.
        if (!blob || !['image/jpeg','image/png','image/webp'].includes(blob.type)) throw new Error('encode');
        if (source.type !== 'image/jpeg' && blob.type === 'image/jpeg') throw new Error('alpha');
        if (blob.size > 0 && blob.size <= PRODUCT_IMAGE_MAX_BYTES) {
          const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/png' ? 'png' : 'webp';
          return new File([blob], 'product-image.' + ext, { type: blob.type });
        }
      }
      width = Math.max(1, Math.round(width * 0.8)); height = Math.max(1, Math.round(height * 0.8));
    }
    throw new Error('size');
  } catch {
    throw new Error('Das Bild konnte nicht sicher auf höchstens 5 MiB optimiert werden. Bitte ein anderes oder kleineres Bild auswählen. Es wurde nichts hochgeladen.');
  } finally {
    bitmap?.close(); canvas.width = 0; canvas.height = 0;
  }
}

/** Direct-to-private-Storage transfer; no image bytes cross the application API. */
export async function transferProductImage(url: string, file: File, progress: (percent: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url); xhr.withCredentials = false; xhr.timeout = 120000;
    xhr.setRequestHeader('Content-Type', file.type); xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.min(100, Math.round(e.loaded / e.total * 100))); };
    const fail = () => reject(new Error('Das Bild konnte nicht übertragen werden. Bitte erneut auswählen.'));
    xhr.onerror = fail; xhr.ontimeout = fail; xhr.onabort = fail;
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else fail(); };
    xhr.send(file);
  });
}
