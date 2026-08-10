/**
 * Canvas image compression — the single decode/downscale/JPEG pipeline for the
 * client, plus the MMS attachment budget ladder layered on top of it.
 * client/src/utils/imageCompression.js
 *
 * `ibImages.js` (Intelligence Bar vision parts) imports the primitive from
 * here, so orientation handling, alpha flattening, and decode fallbacks live in
 * ONE place rather than diverging across parallel compressors.
 *
 * Why the budget ladder exists: Twilio caps a single MMS at 5MB across ALL
 * media, not per file, so two or three full-size phone photos overflow the
 * message even though each file is individually legal. The composer used to
 * refuse the batch and tell the operator to "compress images and try again" —
 * advice with no path to act on it.
 *
 * Quality-preserving by design:
 *   - A batch that already fits uploads byte-for-byte untouched. No re-encode,
 *     no generational loss on images that were never the problem.
 *   - When it doesn't fit we walk LADDER from near-original quality downward
 *     and stop at the FIRST rung that fits, so we shed the minimum quality the
 *     budget demands rather than a fixed amount.
 *   - A re-encode that lands BIGGER than its original (common for small or
 *     already-optimized images) is discarded in favor of the original.
 *   - Once a rung fits, any original that fits back into the leftover headroom
 *     is RESTORED byte-for-byte — we never spend quality the budget didn't
 *     actually ask for.
 *
 * Animated images (GIF, APNG, animated WebP) are never re-encoded — a canvas
 * round-trip flattens them to a single frame. They pass through at full size
 * and still count against the budget, so an animation that can't fit reports
 * failure instead of silently shipping a still.
 *
 * Files are encoded SEQUENTIALLY, not with Promise.all: a 4032x3024 RGBA
 * bitmap is ~46 MiB before its similarly sized canvas, so decoding a ten-file
 * selection concurrently approaches a gigabyte of live raster and crashes
 * mobile browsers before anything uploads.
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

// Formats that can carry animation. GIF always can; PNG and WebP only in their
// APNG / animated-WebP variants, which need a byte sniff to tell apart.
const ALWAYS_ANIMATED = new Set(["image/gif"]);
const MAYBE_ANIMATED = new Set(["image/png", "image/webp"]);

// acTL must precede IDAT in an APNG, and ANIM sits in the WebP header block,
// so a small prefix is enough — and bounding the scan avoids matching the
// same bytes occurring by chance inside compressed pixel data.
const SNIFF_BYTES = 64 * 1024;

function mimeOf(file) {
  return String(file?.type || "").toLowerCase();
}

/** Type-level check only. Animation needs `isAnimatedImage` (async). */
export function isCompressibleImage(file) {
  const type = mimeOf(file);
  return /^image\//.test(type) && !ALWAYS_ANIMATED.has(type);
}

function indexOfAscii(bytes, marker, end = bytes.length) {
  const codes = Array.from(marker, (c) => c.charCodeAt(0));
  const limit = Math.min(end, bytes.length) - codes.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (bytes[i + j] !== codes[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function fourCC(bytes, off) {
  return String.fromCharCode(
    bytes[off],
    bytes[off + 1],
    bytes[off + 2],
    bytes[off + 3],
  );
}

// Tri-state on purpose: "unknown" (we ran out of prefix before reaching a
// decisive chunk) must not be reported as "still", or we'd flatten an
// animation we simply failed to read far enough to see.
const ANIMATED = "animated";
const STILL = "still";
const UNKNOWN = "unknown";

/**
 * Walk the RIFF chunk table rather than scanning for a marker: in an extended
 * WebP an ICCP/EXIF chunk legally precedes ANIM and can push it arbitrarily
 * far into the file, so any fixed byte window is guessable-wrong.
 */
function webpAnimationState(bytes) {
  if (bytes.length < 12) return UNKNOWN;
  if (fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WEBP") return STILL;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const cc = fourCC(bytes, off);
    if (cc === "ANIM" || cc === "ANMF") return ANIMATED;
    // Image data reached with no animation chunk — decisively a still.
    if (cc === "VP8 " || cc === "VP8L") return STILL;
    const size =
      (bytes[off + 4] |
        (bytes[off + 5] << 8) |
        (bytes[off + 6] << 16) |
        (bytes[off + 7] << 24)) >>>
      0;
    // Chunk payloads are padded to an even length.
    off += 8 + size + (size % 2);
  }
  return UNKNOWN;
}

/**
 * APNG declares acTL before the first IDAT. Ancillary chunks (iCCP, eXIf) may
 * precede acTL, so the same "ran out of prefix" caveat applies here.
 */
function pngAnimationState(bytes) {
  const idat = indexOfAscii(bytes, "IDAT");
  // Bound the acTL search by IDAT — past that we'd be scanning compressed
  // pixel data where "acTL" can occur by coincidence.
  const acTL = indexOfAscii(bytes, "acTL", idat === -1 ? bytes.length : idat);
  if (acTL !== -1) return ANIMATED;
  return idat === -1 ? UNKNOWN : STILL;
}

/**
 * True when re-encoding would silently drop animation frames.
 * Fails SAFE: an unreadable or inconclusive header is treated as animated, so
 * we pass the file through untouched rather than flattening something we
 * couldn't fully inspect.
 */
export async function isAnimatedImage(file) {
  const type = mimeOf(file);
  if (ALWAYS_ANIMATED.has(type)) return true;
  if (!MAYBE_ANIMATED.has(type)) return false;
  if (typeof file?.slice !== "function") return false;
  try {
    const bytes = new Uint8Array(
      await file.slice(0, SNIFF_BYTES).arrayBuffer(),
    );
    const state =
      type === "image/png"
        ? pngAnimationState(bytes)
        : webpAnimationState(bytes);
    return state !== STILL;
  } catch {
    return true;
  }
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
 * THE shared canvas primitive: decode a File, downscale to fit `maxEdge`, and
 * hand the drawn canvas to `serialize`. Every client-side JPEG re-encode goes
 * through here — see the module header.
 *
 * Resolves to null when the image can't be decoded (HEIC outside Safari, a
 * corrupt file), which callers treat as "pass through untouched".
 */
async function withDownscaledCanvas(file, { maxEdge }, serialize) {
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

    return await serialize(canvas);
  } catch {
    return null;
  } finally {
    // Release the raster before the next decode — the whole reason encoding
    // runs sequentially.
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

/** Shared primitive → data URL. Used by ibImages.js for vision parts. */
export function encodeJpegDataUrl(file, { maxEdge, quality }) {
  return withDownscaledCanvas(file, { maxEdge }, (canvas) =>
    canvas.toDataURL("image/jpeg", quality),
  );
}

/** Shared primitive → File. Used by the MMS budget ladder below. */
export function encodeJpegFile(file, { maxEdge, quality }) {
  return withDownscaledCanvas(file, { maxEdge }, async (canvas) => {
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
    if (!blob) return null;
    return new File([blob], jpegName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
  });
}

/**
 * Put back any original whose extra bytes still fit in the leftover headroom.
 * Cheapest restores first, which maximizes how many originals come back.
 */
function restoreWithinHeadroom(originals, attempt, budget) {
  const result = [...attempt];
  let used = totalBytes(result);
  const candidates = [];
  for (let i = 0; i < originals.length; i++) {
    if (result[i] !== originals[i]) {
      candidates.push({
        i,
        delta: Number(originals[i].size || 0) - Number(result[i].size || 0),
      });
    }
  }
  candidates.sort((a, b) => a.delta - b.delta);
  for (const { i, delta } of candidates) {
    if (used + delta <= budget) {
      result[i] = originals[i];
      used += delta;
    }
  }
  return result;
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
  {
    availableBytes,
    encodeImage = encodeJpegFile,
    detectAnimated = isAnimatedImage,
  } = {},
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

  // Resolved once, not per rung: the sniff reads bytes off disk.
  const recompressible = [];
  for (const file of files) {
    recompressible.push(
      isCompressibleImage(file) && !(await detectAnimated(file)),
    );
  }

  // Tracked only to report how close we got when nothing fits.
  let bestBytes = originalBytes;

  for (const rung of LADDER) {
    const attempt = [];
    // Sequential on purpose — see the module header's memory note.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!recompressible[i]) {
        attempt.push(file);
        continue;
      }
      const encoded = await encodeImage(file, rung);
      // Keep whichever is smaller: re-encoding an already-small or
      // already-optimized image routinely inflates it.
      attempt.push(!encoded || encoded.size >= file.size ? file : encoded);
    }
    const attemptBytes = totalBytes(attempt);
    if (attemptBytes < bestBytes) bestBytes = attemptBytes;
    if (attemptBytes <= budget) {
      const finalFiles = restoreWithinHeadroom(files, attempt, budget);
      return {
        ok: true,
        files: finalFiles,
        compressed: finalFiles.some((f, i) => f !== files[i]),
        originalBytes,
        finalBytes: totalBytes(finalFiles),
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
