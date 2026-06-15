/**
 * Intelligence Bar — image attachment helpers.
 * client/src/utils/ibImages.js
 *
 * Turns a user-selected image File into a base64 vision part the Intelligence
 * Bar /query endpoint forwards to Claude. Large photos are downscaled on the
 * client (max 1568px, JPEG) so request payloads stay small and within Claude's
 * recommended image size.
 *
 * Returns: { mediaType, data, name, previewUrl }
 *   - data:       raw base64 (no data: prefix) — what the API expects
 *   - previewUrl: data: URL for an <img> thumbnail in the bar
 */

export const MAX_ATTACHMENTS = 4;
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 0.85;

export function isImageFile(file) {
  return !!file && /^image\//.test(file.type || '');
}

export async function fileToImagePart(file) {
  if (!isImageFile(file)) {
    throw new Error('Only image files can be attached.');
  }
  const dataUrl = await downscaleToJpeg(file);
  return {
    mediaType: 'image/jpeg',
    data: dataUrl.split(',')[1],
    name: file.name || 'photo.jpg',
    previewUrl: dataUrl,
  };
}

// Convert several Files, skipping non-images. Caps at MAX_ATTACHMENTS total
// when `existingCount` is supplied.
export async function filesToImageParts(files, existingCount = 0) {
  const list = Array.from(files || []).filter(isImageFile);
  const room = Math.max(0, MAX_ATTACHMENTS - existingCount);
  const parts = await Promise.all(list.slice(0, room).map(fileToImagePart));
  return parts;
}

function downscaleToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}
