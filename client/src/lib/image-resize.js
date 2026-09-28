// Shared low-level image helpers for a customer/tech photo picker that
// downscales before upload. Four callers already keep a private copy of
// this same fileToDataUrl/resizeImage pair (PhotoId.jsx,
// LawnAssessmentPanel.jsx, TechLawnDiagnosticPage.jsx,
// TechSocialPostPage.jsx) — this module does NOT migrate them (out of
// scope for the change that added it; a follow-up can fold them in).
// VisitPrepPhotoForm.jsx is its first caller.

// Mirrors PhotoId.jsx's EXT_MIME/mimeFromName: some browsers report an
// empty (or generic application/octet-stream) `file.type` for HEIC/HEIF,
// so a picker that trusts `file.type` alone silently drops a real iPhone
// photo. The extension fallback recovers it.
export const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function mimeFromName(name) {
  return EXT_MIME[String(name || '').split('.').pop().toLowerCase()] || null;
}

const BLANK_PREFIX_RE = /^data:(?:|application\/octet-stream);base64,/;

// File -> data URL, with the same blank-prefix rebuild PhotoId.jsx's
// fileToDataUrl uses: a `data:;base64,...` (or generic octet-stream)
// result gets its mime rebuilt from `file.type || mimeFromName(file.name)`
// so a corrected type survives everywhere downstream (including a resize
// short-circuit that returns this data URL unchanged).
export function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      let dataUrl = String(ev.target?.result || '');
      if (BLANK_PREFIX_RE.test(dataUrl)) {
        const mime = file.type || mimeFromName(file.name);
        if (!mime) { resolve(null); return; }
        const base64 = dataUrl.slice(dataUrl.indexOf('base64,') + 'base64,'.length);
        dataUrl = `data:${mime};base64,${base64}`;
      }
      resolve(dataUrl || null);
    };
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Downscale a data URL image to <=maxEdge, re-encoded as JPEG. Same
// convention as the four existing private copies: an image already inside
// maxEdge is returned UNCHANGED (never forced through a JPEG re-encode),
// and a decode failure (a browser that can't paint the format to a
// canvas — e.g. HEIC outside Safari) resolves null rather than throwing,
// so the caller decides the fallback.
export function resizeDataUrl(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longEdge = Math.max(img.width, img.height);
      if (longEdge <= maxEdge) { resolve(dataUrl); return; }
      const scale = maxEdge / longEdge;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// data URL -> File.
export function dataUrlToFile(dataUrl, name, fallbackMime) {
  const match = /^data:([^;]*);base64,([\s\S]*)$/.exec(dataUrl || '');
  if (!match) return null;
  const mime = match[1] || fallbackMime || 'application/octet-stream';
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/**
 * Read + downscale a picked File to a <=maxEdge JPEG File (quality 0.85 by
 * default — the same figures every private copy uses), correcting an
 * empty/generic declared type from the filename extension along the way.
 * An image already inside maxEdge comes back unchanged apart from that
 * type correction (never forced through a JPEG re-encode).
 *
 * Resolves null when the browser cannot decode the image at all (e.g.
 * HEIC outside Safari) — a caller whose server converts HEIC itself can
 * fall back to the original file in that case.
 */
export async function resizeImageFile(file, { maxEdge = 1600, quality = 0.85 } = {}) {
  const original = await fileToDataUrl(file);
  if (!original) return null;
  const resized = await resizeDataUrl(original, maxEdge, quality);
  if (!resized) return null;
  const fallbackMime = file.type || mimeFromName(file.name) || 'image/jpeg';
  return dataUrlToFile(resized, file.name, fallbackMime);
}
