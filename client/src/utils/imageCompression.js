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
 * Scope is deliberately narrow: only JPEG and PNG are re-encoded, because
 * iPhone camera photos are JPEG and iOS screenshots are PNG. Everything else
 * passes through untouched at full size, still counting against the budget, so
 * an oversized file in another format reports failure rather than being
 * flattened. The alternative — a container parser per format to detect
 * animation — is a large, bug-prone surface for traffic this composer does not
 * see. PNG keeps an APNG check because it IS re-encoded and a canvas
 * round-trip would silently reduce it to a single frame.
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

/**
 * The only formats we re-encode. iPhone camera photos are JPEG and iOS
 * screenshots are PNG — between them they cover essentially all real traffic
 * through this composer.
 *
 * Everything else (GIF, WebP, HEIC, anything unrecognized) passes through
 * untouched. That is a deliberate trade: carrying a container parser per
 * format to avoid silently flattening an animation is a large, bug-prone
 * surface for cases that don't occur here. An oversized file in one of those
 * formats simply fails the budget with a clear message instead of being
 * compressed.
 */
const COMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png"]);

// APNG declares acTL before the first IDAT, so a bounded prefix is enough.
const SNIFF_BYTES = 64 * 1024;

function mimeOf(file) {
  const type = String(file?.type || "").toLowerCase();
  // Some pickers report the non-standard image/jpg alias. The upload endpoint
  // accepts it (admin-communications-attach.js ALLOWED_MIMES), so treating it
  // as a distinct type here would silently exclude a plain JPEG from
  // compression and refuse a batch we could have shrunk.
  return type === "image/jpg" ? "image/jpeg" : type;
}

/** Type-level check only. PNG additionally needs `isAnimatedImage` (async). */
export function isCompressibleImage(file) {
  return COMPRESSIBLE_TYPES.has(mimeOf(file));
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Walk PNG's length/type chunk table rather than scanning raw bytes: the four
 * characters "IDAT" or "acTL" can occur inside an ancillary chunk's payload (a
 * tEXt comment is enough) or inside compressed pixel data, and a byte scan
 * would take either for a real chunk.
 *
 * APNG declares acTL before the first IDAT; ancillary chunks (iCCP, eXIf) may
 * precede acTL, hence the bounded-prefix caveat.
 */
function pngAnimationState(bytes) {
  if (bytes.length < 8) return UNKNOWN;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return STILL;
  }
  let off = 8;
  while (off + 8 <= bytes.length) {
    const length =
      ((bytes[off] << 24) |
        (bytes[off + 1] << 16) |
        (bytes[off + 2] << 8) |
        bytes[off + 3]) >>>
      0;
    const type = fourCC(bytes, off + 4);
    if (type === "acTL") return ANIMATED;
    if (type === "IDAT") return STILL;
    off += 12 + length; // length(4) + type(4) + payload + CRC(4)
  }
  return UNKNOWN;
}

/**
 * True when re-encoding would silently drop animation frames.
 * Fails SAFE: an unreadable or inconclusive header is treated as animated, so
 * we pass the file through untouched rather than flattening something we
 * couldn't fully inspect.
 */
export async function isAnimatedImage(file) {
  // PNG is the only compressible format that can animate — JPEG cannot, and
  // every other format is passed through untouched regardless.
  if (mimeOf(file) !== "image/png") return false;
  if (typeof file?.slice !== "function") return false;
  try {
    const bytes = new Uint8Array(
      await file.slice(0, SNIFF_BYTES).arrayBuffer(),
    );
    return pngAnimationState(bytes) !== STILL;
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
      bestBytesIsFloor: false,
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

  // Files we must ship as-is (animations, undecodables). If those alone break
  // the budget no rung can rescue the batch, so fail now rather than burning
  // eight rungs of full-resolution decodes — on the mobile composer that's a
  // long frozen-looking wait for an outcome already known.
  const preservedBytes = files.reduce(
    (sum, file, i) => sum + (recompressible[i] ? 0 : Number(file.size || 0)),
    0,
  );
  if (preservedBytes >= budget) {
    return {
      ok: false,
      reason: "over-budget",
      originalBytes,
      bestBytes: preservedBytes,
      // The compressible files necessarily add to this, so it is a LOWER
      // BOUND, not an achievable total. Callers must present it as "at least",
      // or they understate how much the operator has to remove.
      bestBytesIsFloor: true,
      availableBytes: budget,
    };
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
    // Exact: the smallest total any rung actually produced.
    bestBytes,
    bestBytesIsFloor: false,
    availableBytes: budget,
  };
}
