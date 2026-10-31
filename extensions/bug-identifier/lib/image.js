// Image helpers shared by the service worker and the side panel. Everything
// uses OffscreenCanvas + createImageBitmap, which both contexts have.
import { JPEG_QUALITY, MIN_CROP_PX, RESIZE_MAX_PX } from './config.js';

export class ImageError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Decode `blob`, optionally crop it, shrink it to RESIZE_MAX_PX on the long
 * side and re-encode it as JPEG. `crop` is in CSS pixels of a viewport
 * `crop.viewportW` wide; the scale to screenshot pixels comes from the
 * decoded width, so device pixel ratio and page zoom both cancel out.
 * Resolves `{ data, mimeType, width, height }` with plain base64 `data`.
 */
export async function toJpegPhoto(blob, crop = null) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ImageError('unreadable');
  }
  try {
    const src = crop ? cropToPixels(crop, bitmap) : { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    if (src.w < MIN_CROP_PX || src.h < MIN_CROP_PX) throw new ImageError('too_small');
    const scale = Math.min(1, RESIZE_MAX_PX / Math.max(src.w, src.h));
    const width = Math.max(1, Math.round(src.w * scale));
    const height = Math.max(1, Math.round(src.h * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha: flatten transparent PNG/WebP onto white.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, src.x, src.y, src.w, src.h, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return { data: await blobToBase64(jpeg), mimeType: 'image/jpeg', width, height };
  } finally {
    bitmap.close();
  }
}

function cropToPixels(crop, bitmap) {
  const scale = bitmap.width / crop.viewportW;
  const x = clamp(Math.round(crop.x * scale), 0, bitmap.width);
  const y = clamp(Math.round(crop.y * scale), 0, bitmap.height);
  const w = clamp(Math.round(crop.width * scale), 0, bitmap.width - x);
  const h = clamp(Math.round(crop.height * scale), 0, bitmap.height - y);
  return { x, y, w, h };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = (header.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';
  const binary = header.includes(';base64') ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** A crop rectangle from page code is plain data; check it before using it. */
export function isValidCrop(rect) {
  return !!rect && ['x', 'y', 'width', 'height', 'viewportW'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && rect[key] >= 0,
  ) && rect.viewportW > 0;
}
