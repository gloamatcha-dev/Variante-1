import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PRODUCT_IMAGE_BUCKET, PRODUCT_IMAGE_STAGING_BUCKET, PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_BUCKET_MAX_BYTES, PRODUCT_IMAGE_MIMES, productImageFileError } from './productImageRules.ts';

/** Check raster signatures and complete containers; reject truncated/appended payloads. No conversion. */
export function productImageExtension(bytes: Uint8Array, mime: string): string {
  const b = Buffer.from(bytes);
  let extension = '';
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let p = 8, image = false, ended = false;
    while (p + 12 <= b.length) {
      const length = b.readUInt32BE(p), kind = b.toString('ascii', p + 4, p + 8);
      if (p + length + 12 > b.length || (p === 8 && (kind !== 'IHDR' || length !== 13))) break;
      if (kind === 'IDAT') image = true;
      p += length + 12;
      if (kind === 'IEND') { ended = length === 0 && p === b.length; break; }
    }
    if (image && ended && b.readUInt32BE(16) > 0 && b.readUInt32BE(20) > 0) extension = 'png';
  } else if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length) {
    let p = 12, image = false;
    while (p + 8 <= b.length) {
      const kind = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
      if (p + 8 + size + (size % 2) > b.length) break;
      if (kind === 'VP8 ' && size >= 10 && b.subarray(p + 11, p + 14).equals(Buffer.from([157,1,42]))) image = true;
      if (kind === 'VP8L' && size >= 5 && b[p + 8] === 47) image = true;
      p += 8 + size + (size % 2);
    }
    if (image && p === b.length) extension = 'webp';
  } else if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
    let p = 2, frame = false, scan = false;
    while (p + 1 < b.length) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 217) { if (frame && scan && p === b.length) extension = 'jpg'; break; }
      if (marker === 0 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > b.length) break;
      const length = b.readUInt16BE(p);
      if (length < 2 || p + length > b.length) break;
      if ([192,193,194].includes(marker) && length >= 8) frame = true;
      p += length;
      if (marker === 218) {
        scan = true;
        while (p + 1 < b.length) {
          if (b[p] === 255 && b[p + 1] !== 0 && !(b[p + 1] >= 208 && b[p + 1] <= 215)) break;
          p++;
        }
      }
    }
  }
  if (!extension || ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as Record<string,string>)[extension] !== mime) {
    throw new Error('Die Datei ist kein gültiges JPG-, PNG- oder WebP-Bild. Bitte eine andere Bilddatei auswählen.');
  }
  return extension;
}

export async function uploadProductImage(request: Request, admin: SupabaseClient, actor: string): Promise<Response> {
  const respond = (error: string, status: number) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return respond('Nicht autorisiert.', 403);
  // Only small control messages cross the Function's 4.5 MB request boundary.
  if (!request.headers.get('content-type')?.startsWith('application/json')) return respond('Ungültige Upload-Anfrage.', 415);
  const reader = request.body?.getReader();
  if (!reader) return respond('Ungültige Upload-Anfrage.', 400);
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>4096){await reader.cancel();return respond('Ungültige Upload-Anfrage.',413);} chunks.push(value); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!PRODUCT_IMAGE_MIMES.some(t => t === body.mime)) return respond('Bitte ein JPG-, PNG- oder WebP-Bild auswählen.', 415);
    if (!['prepare','complete'].includes(body.phase)) return respond('Ungültige Upload-Anfrage.',400);
    if (body.phase === 'prepare') {
      const invalid = productImageFileError(body.mime, body.size);
      if (!Number.isSafeInteger(body.size) || invalid) return respond(invalid || 'Ungültige Dateigröße.',body.size>PRODUCT_IMAGE_MAX_BYTES?413:400);
    }
    for (const [name,publicBucket] of [[PRODUCT_IMAGE_BUCKET,true],[PRODUCT_IMAGE_STAGING_BUCKET,false]] as const) {
      const {data:bucket,error} = await admin.storage.getBucket(name);
      if (error || !bucket || bucket.public!==publicBucket || bucket.file_size_limit!==PRODUCT_IMAGE_BUCKET_MAX_BYTES || !bucket.allowed_mime_types || bucket.allowed_mime_types.length!==3 || !PRODUCT_IMAGE_MIMES.every(t=>bucket.allowed_mime_types?.includes(t))) {
        return respond('Der Bild-Upload ist noch nicht eingerichtet. Bitte die Administration kontaktieren.',503);
      }
    }
    const extension = ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp'} as Record<string,string>)[body.mime];
    const staging = admin.storage.from(PRODUCT_IMAGE_STAGING_BUCKET);
    if(body.phase==='prepare') {
      const path = actor+'/'+randomUUID()+'.'+extension;
      const {data,error}=await staging.createSignedUploadUrl(path,{upsert:false});
      if(error || !data)return respond('Der Bild-Upload konnte nicht vorbereitet werden.',502);
      return Response.json({ok:true,path,uploadUrl:data.signedUrl},{headers:{'Cache-Control':'no-store'}});
    }
    // Only this actor's server-generated, immutable object name can be finalized.
    const path = body.path;
    if(typeof path!=='string' || !path.startsWith(actor+'/') || !/^[0-9a-f-]{36}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(path) || !path.endsWith('.'+extension)) return respond('Ungültige Bildreferenz.',400);
    const {data:file,error:downloadError}=await staging.download(path);
    if(downloadError || !file)return respond('Das hochgeladene Bild wurde nicht gefunden. Bitte erneut auswählen.',400);
    const invalid=productImageFileError(file.type,file.size);
    if(invalid)return respond(invalid,file.size>PRODUCT_IMAGE_MAX_BYTES?413:400);
    const bytes=new Uint8Array(await file.arrayBuffer());
    productImageExtension(bytes,body.mime);
    const storage=admin.storage.from(PRODUCT_IMAGE_BUCKET);
    const {error}=await storage.upload(path,bytes,{contentType:body.mime,upsert:false,cacheControl:'31536000'});
    if(error)return respond('Das Bild konnte nicht übernommen werden. Bitte erneut auswählen.',502);
    // No cleanup of old public images. Private staging cleanup is not publication-critical.
    await staging.remove([path]).catch(()=>{});
    return Response.json({ok:true,url:storage.getPublicUrl(path).data.publicUrl},{headers:{'Cache-Control':'no-store'}});
  } catch { return respond('Das Bild konnte nicht gelesen werden oder ist keine gültige JPG-, PNG- oder WebP-Datei.',400); }
  finally { reader.releaseLock(); }
}
