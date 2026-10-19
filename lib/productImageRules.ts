export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
export const PRODUCT_IMAGE_BUCKET_MAX_BYTES = PRODUCT_IMAGE_SOURCE_MAX_BYTES;
export const PRODUCT_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PRODUCT_IMAGE_BUCKET = 'product-images';
export const PRODUCT_IMAGE_STAGING_BUCKET = 'product-image-uploads';
export function productImageSourceError(type: string, size: number): string | null {
  if (!PRODUCT_IMAGE_MIMES.some(m => m === type)) return 'Bitte ein JPG-, PNG- oder WebP-Bild auswählen.';
  if (!Number.isSafeInteger(size) || size <= 0) return 'Die Bilddatei ist leer oder ungültig.';
  if (size > PRODUCT_IMAGE_SOURCE_MAX_BYTES) return 'Das Originalbild darf maximal 50 MiB groß sein.';
  return null;
}
export function productImageFileError(type: string, size: number): string | null {
  if (!PRODUCT_IMAGE_MIMES.some(m => m === type)) return 'Bitte ein JPG-, PNG- oder WebP-Bild auswählen.';
  if (size <= 0) return 'Die Bilddatei ist leer.';
  if (size > PRODUCT_IMAGE_MAX_BYTES) return 'Das Bild darf maximal 5 MB groß sein.';
  return null;
}
