/**
 * Client-side image compression for outbound MMS attachments.
 * client/src/utils/imageCompression.js
 *
 * Twilio caps a single MMS at 5MB across ALL media, not per file, so two or
 * three full-size phone photos overflow the message even though each file is
 * individually legal. Before this module the composer simply refused the batch
 * and told the operator to "compress images and try again" — advice with no
 * path to act on it.
 *
 * Quality-preserving by design:
 *   - A batch that already fits uploads byte-for-byte untouched. No re-encode,
 *     no generational loss on images that were never the problem.
 *   - When it doesn't fit we walk LADDER from near-original quality downward
 *     and stop at the FIRST rung that fits, so we shed the minimum quality the
 *     budget demands rather than a fixed amount.
 *   - A re-encode that lands BIGGER than its original (common for small or
 *     already-optimized images) is discarded in favor of the original.
 *
 * Animated GIFs are never re-encoded — a canvas round-trip flattens them to a
 * single frame. They pass through at full size and still count against the
 * budget, so a GIF that can't fit reports failure instead of silently
 * shipping a still.
 */

// Twilio's hard per-message ceiling across all media.
export const TWILIO_MMS_TOTAL_BYTES = 5 * 1024 * 1024;

// What we actually target. The margin absorbs the difference between the size
// we measure here and what Twilio bills against the message, so a batch that
// passes the composer never bounces at send time.
export const MMS_TOTAL_BUDGET_BYTES = Math.floor(4.5 * 1024 * 1024);

// Ordered best-quality-first. Rung 0 leaves a 4032px iPhone photo at native
// resolution and only re-encodes it; later rungs give up dimensions and
// quality together. We stop at the first rung whose total fits.
const LADDER = [
  { maxEdge: 4096, quality: 0.95 },
  { maxEdge: 4096, quality: 0.9 },
  { maxEdge: 3072, quality: 0.88 },
  { maxEdge: 2560, quality: 0.85 },
  { maxEdge: 2048, quality: 0.82 },
  { maxEdge: 1600, quality: 0.78 },
  { maxEdge: 1280, quality: 0.72 },
  { maxEdge: 1024, quality: 0.65 },
];

// Canvas flattens animation to frame one, so GIFs are passed through as-is.
const NEVER_RECOMPRESS = new Set(["image/gif"]);

export function isCompressibleImage(file) {
  const type = String(file?.type || "").toLowerCase();
  return /^image\//.test(type) && !NEVER_RECOMPRESS.has(type);
}

export function totalBytes(files = []) {
  return files.reduce((sum, f) => sum + Number(f?.size || 0), 0);
}

export function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function jpegName(name = "photo") {
  return `${String(name).replace(/\.[^.]+$/, "")}.jpg`;
}

/**
 * Decode + re-encode one File as JPEG at the given rung.
 * Resolves to null when the image can't be decoded (HEIC outside Safari, a
 * corrupt file), which the caller treats as "pass through untouched".
 */
async function defaultEncodeImage(file, { maxEdge, quality }) {
  let bitmap = null;
  try {
    bitmap = await decode(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    // JPEG has no alpha: without this, transparent PNG regions composite onto
    // the canvas's default transparent-black and arrive as solid black.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
    if (!blob) return null;
    return new File([blob], jpegName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

// createImageBitmap is faster and applies EXIF orientation explicitly. Safari
// only grew imageOrientation support recently, so fall back to <img>, which
// auto-applies orientation in every browser we support.
function decode(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" }).catch(
      () => decodeViaImg(file),
    );
  }
  return decodeViaImg(file);
}

function decodeViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image"));
    };
    img.src = url;
  });
}

/**
 * Fit a batch of images into `availableBytes`, shedding as little quality as
 * possible.
 *
 * Returns either
 *   { ok: true, files, compressed, originalBytes, finalBytes }
 * or
 *   { ok: false, reason, originalBytes, bestBytes, availableBytes }
 *
 * `files` is upload-ready and index-aligned with the input, so callers can zip
 * it against their own per-file state (previews, captions).
 */
export async function fitImagesToBudget(
  inputFiles,
  { availableBytes, encodeImage = defaultEncodeImage } = {},
) {
  const files = Array.from(inputFiles || []);
  const originalBytes = totalBytes(files);
  const budget = Number(availableBytes);

  if (!files.length) {
    return {
      ok: true,
      files,
      compressed: false,
      originalBytes: 0,
      finalBytes: 0,
    };
  }
  if (!Number.isFinite(budget) || budget <= 0) {
    return {
      ok: false,
      reason: "no-budget",
      originalBytes,
      bestBytes: originalBytes,
      availableBytes: budget,
    };
  }
  // Already fits — ship the originals untouched.
  if (originalBytes <= budget) {
    return {
      ok: true,
      files,
      compressed: false,
      originalBytes,
      finalBytes: originalBytes,
    };
  }

  // Tracked only to report how close we got when nothing fits.
  let bestBytes = originalBytes;

  for (const rung of LADDER) {
    const attempt = await Promise.all(
      files.map(async (file) => {
        if (!isCompressibleImage(file)) return file;
        const encoded = await encodeImage(file, rung);
        // Keep whichever is smaller: re-encoding an already-small or
        // already-optimized image routinely inflates it.
        if (!encoded || encoded.size >= file.size) return file;
        return encoded;
      }),
    );
    const attemptBytes = totalBytes(attempt);
    if (attemptBytes < bestBytes) bestBytes = attemptBytes;
    if (attemptBytes <= budget) {
      return {
        ok: true,
        files: attempt,
        compressed: true,
        originalBytes,
        finalBytes: attemptBytes,
      };
    }
  }

  return {
    ok: false,
    reason: "over-budget",
    originalBytes,
    bestBytes,
    availableBytes: budget,
  };
}
