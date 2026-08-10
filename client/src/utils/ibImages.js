/**
 * Intelligence Bar — image attachment helpers.
 * client/src/utils/ibImages.js
 *
 * Turns a user-selected image File into a base64 vision part the Intelligence
 * Bar /query endpoint forwards to Claude. Large photos are downscaled on the
 * client (max 1568px, JPEG) so request payloads stay small and within Claude's
 * recommended image size.
 *
 * The decode/downscale/JPEG mechanics live in utils/imageCompression.js — the
 * one canvas pipeline on the client — so orientation, alpha flattening, and
 * decode fallbacks stay consistent here and in the MMS attachment path.
 *
 * Returns: { mediaType, data, name, previewUrl }
 *   - data:       raw base64 (no data: prefix) — what the API expects
 *   - previewUrl: data: URL for an <img> thumbnail in the bar
 */
import { encodeJpegDataUrl } from "./imageCompression";

export const MAX_ATTACHMENTS = 4;
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 0.85;

export function isImageFile(file) {
  return !!file && /^image\//.test(file.type || "");
}

export async function fileToImagePart(file) {
  if (!isImageFile(file)) {
    throw new Error("Only image files can be attached.");
  }
  const dataUrl = await downscaleToJpeg(file);
  return {
    mediaType: "image/jpeg",
    data: dataUrl.split(",")[1],
    name: file.name || "photo.jpg",
    previewUrl: dataUrl,
  };
}

// Convert several Files, skipping non-images. Caps at MAX_ATTACHMENTS total
// when `existingCount` is supplied. Uses allSettled so one undecodable file
// (e.g. HEIC or a corrupt image) doesn't drop the whole selection — the
// images that decode still attach.
export async function filesToImageParts(files, existingCount = 0) {
  const list = Array.from(files || []).filter(isImageFile);
  const room = Math.max(0, MAX_ATTACHMENTS - existingCount);
  const results = await Promise.allSettled(
    list.slice(0, room).map(fileToImagePart),
  );
  return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

// Thin wrapper over the shared primitive. It resolves null on an undecodable
// image; the throw is preserved because filesToImageParts relies on allSettled
// to drop bad files without losing the rest of the selection.
async function downscaleToJpeg(file) {
  const dataUrl = await encodeJpegDataUrl(file, {
    maxEdge: MAX_DIMENSION,
    quality: JPEG_QUALITY,
  });
  if (!dataUrl) throw new Error("Could not read that image.");
  return dataUrl;
}
