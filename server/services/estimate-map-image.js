/**
 * Customer-facing satellite images for public estimates, WITHOUT the server's
 * Google Maps key.
 *
 * The server key (GOOGLE_MAPS_API_KEY || GOOGLE_API_KEY) is the same one used
 * for Geocoding / Routes, so it cannot be referrer-restricted. It used to ride
 * inside Static Maps URLs shipped to anyone holding a public estimate link
 * (SSR <img src>, GET /:token/data JSON, the PDF render pass). Now:
 *
 *   - public payloads carry a token-scoped proxy PATH
 *     (/api/estimates/:token/map/satellite | overlay), never a Google URL;
 *   - the proxy route rebuilds the Static Maps URL server-side from the
 *     estimate's OWN stored parameters (allow-listed and range-checked; it
 *     never reads a caller-supplied param, so it cannot become an open proxy),
 *     appends the key, fetches the bytes and streams them;
 *   - rows that already hold a keyed URL are redacted on output — no migration.
 *
 * Nothing here logs a URL (it carries the key when built for the fetch).
 */

const STATIC_MAP_ORIGIN = 'https://maps.googleapis.com';
const STATIC_MAP_PATH = '/maps/api/staticmap';
const STATIC_MAP_BASE = `${STATIC_MAP_ORIGIN}${STATIC_MAP_PATH}`;
const PROXY_KINDS = new Set(['satellite', 'overlay']);

const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;

function serverMapsKey() {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';
}

// The Static Maps provider (services/maps/providers/google-maps-provider.js)
// prefers a dedicated GOOGLE_STATIC_MAPS_API_KEY when one is configured.
function staticMapsKey() {
  return process.env.GOOGLE_STATIC_MAPS_API_KEY || serverMapsKey();
}

function parseUrl(raw) {
  try {
    return new URL(String(raw));
  } catch {
    return null;
  }
}

function isGoogleMapsHost(hostname) {
  return /^maps\.googleapis\.com$/i.test(String(hostname || ''));
}

function isGoogleStaticMapUrl(raw) {
  const u = parseUrl(raw);
  return !!u && u.protocol === 'https:' && isGoogleMapsHost(u.hostname) && u.pathname === STATIC_MAP_PATH;
}

// Strip the `key` query param from a maps.googleapis.com URL (any path).
// Non-Google strings pass through untouched.
function redactMapsKeyFromUrl(raw) {
  const text = String(raw || '');
  if (!/maps\.googleapis\.com/i.test(text)) return text;
  const u = parseUrl(text);
  if (u && isGoogleMapsHost(u.hostname)) {
    for (const name of [...u.searchParams.keys()]) {
      if (name.toLowerCase() === 'key') u.searchParams.delete(name);
    }
    return u.toString();
  }
  return text.replace(/([?&])key=[^&#\s"'<>]*&?/gi, '$1').replace(/[?&]$/, '');
}

// Last-resort scrub over an outgoing payload (object/array/string): any
// maps.googleapis.com URL loses its key param, any `key=AIza...` token and any
// bare Google API key shape is removed regardless of separator, and any literal
// occurrence of the configured server key is blanked. Defense in depth behind
// the purpose-built proxy paths — catches a keyed URL sitting in an unrelated
// blob (estimate_data, authored text, enriched profile) that no builder knew
// about, INCLUDING a key that differs from the currently configured one (a
// rotated or staff-pasted key).
//
// Entity/escape aware: after HTML escaping a param separator is `&amp;`
// (`&#38;`, `&#x26;`), which a URL parser reads as a param named `amp;key`, so
// each escaped separator form is handled explicitly, as are JSON `&` /
// `\x26`. Callers should ALSO scrub source values BEFORE escaping (sendEstimatePage
// does), so this string pass is the backstop, not the only line.
const KEY_SEPARATOR = String.raw`(?:&amp;|&#0*38;|&#x0*26;|\\u0026|\\x26|&)`;
const KEY_VALUE = String.raw`[^&#\s"'<>\\]*`;
const GOOGLE_KEY_SHAPE = /AIza[0-9A-Za-z_-]{20,}/g;

function stripKeyParamsFromMapsUrlText(url) {
  return url
    // `?key=X` (first param): keep the `?`, drop a following separator.
    .replace(new RegExp(String.raw`\?key=${KEY_VALUE}(?:${KEY_SEPARATOR})?`, 'gi'), '?')
    // `<sep>key=X` (any later param, any escape form of the separator).
    .replace(new RegExp(`${KEY_SEPARATOR}key=${KEY_VALUE}`, 'gi'), '')
    .replace(/[?]$/, '');
}

// Our OWN keyless proxy paths are safe by construction (a signed map-image token
// or an estimate token path) but can contain, by chance, a run that looks like a
// bare Google key ("AIza" + 20 base64url characters — the 43-char signature of a
// signed link, or an odd estimate token). The bare-key pass must not truncate
// them, so they are set aside while the string is scrubbed and put back after.
// The strict shapes cannot smuggle a key past the scrub: the configured
// literal key is blanked again after the restore.
const PROXY_PATH_RE = /\/api\/(?:public\/map-image\/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}|estimates\/[^/?#\s"'<>\\]+\/map\/(?:satellite|overlay))(?![A-Za-z0-9_%/-])/g;

function blankConfiguredKeys(text) {
  let out = text;
  for (const key of [serverMapsKey(), process.env.GOOGLE_STATIC_MAPS_API_KEY || '']) {
    if (key && key.length >= 8 && out.includes(key)) out = out.split(key).join('');
  }
  return out;
}

function scrubMapsKeysFromString(text) {
  const kept = [];
  const protectedText = String(text).replace(PROXY_PATH_RE, (m) => {
    kept.push(m);
    return `\u0000proxy${kept.length - 1}\u0000`;
  });
  const scrubbed = scrubMapsKeysFromUnprotectedString(protectedText);
  if (!kept.length) return scrubbed;
  return blankConfiguredKeys(scrubbed.replace(/\u0000proxy(\d+)\u0000/g, (_m, i) => kept[Number(i)] ?? ''));
}

function scrubMapsKeysFromUnprotectedString(text) {
  let out = String(text);
  if (/maps\.googleapis\.com/i.test(out)) {
    out = out.replace(/https?:\/\/maps\.googleapis\.com\/[^\s"'<>]*/gi, (m) => stripKeyParamsFromMapsUrlText(m));
  }
  // Any `key=AIza...` token (any separator, any host) and any bare key shape.
  out = out.replace(/key=AIza[0-9A-Za-z_-]{20,}/gi, '').replace(GOOGLE_KEY_SHAPE, '');
  return blankConfiguredKeys(out);
}

function scrubMapsKeysDeep(value, depth = 0) {
  if (depth > 40 || value == null) return value;
  if (typeof value === 'string') return scrubMapsKeysFromString(value);
  if (Array.isArray(value)) return value.map((v) => scrubMapsKeysDeep(v, depth + 1));
  if (typeof value === 'object') {
    // Only plain JSON-ish objects are rebuilt; Dates, Buffers, Maps and other
    // class instances pass through untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubMapsKeysDeep(v, depth + 1);
    return out;
  }
  return value;
}

function publicMapProxyPath(token, kind) {
  if (!token || !PROXY_KINDS.has(kind)) return null;
  return `/api/estimates/${encodeURIComponent(String(token))}/map/${kind}`;
}

function isPublicMapProxyPath(value) {
  return /^\/api\/estimates\/[^/?#]+\/map\/(satellite|overlay)$/.test(String(value || ''));
}

// What a customer-facing payload may carry for a stored satellite URL.
//   Google Static Maps URL  -> the token-scoped proxy path (needs a token)
//   other maps.googleapis   -> null (nothing safe to serve)
//   already a proxy path    -> unchanged
//   anything else           -> unchanged (staff-typed non-Google imagery)
function publicSatelliteUrl(raw, token) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (isPublicMapProxyPath(text)) return text;
  if (/maps\.googleapis\.com/i.test(text)) {
    if (!isGoogleStaticMapUrl(text)) return null;
    return publicMapProxyPath(token, 'satellite');
  }
  return text;
}

// Rebuild a keyless Static Maps URL from a stored one, keeping ONLY the
// parameters the estimator itself ever writes, each range-checked. Returns
// null when the stored value is not a usable Google Static Maps URL.
function sanitizedStaticMapUrlFromStored(raw) {
  if (!isGoogleStaticMapUrl(raw)) return null;
  const u = parseUrl(raw);
  const get = (name) => u.searchParams.get(name);
  const center = get('center');
  if (!center || center.length > 120 || /[\u0000-\u001f]/.test(center)) return null;
  const zoomRaw = get('zoom');
  const zoom = zoomRaw == null ? 19 : Number(zoomRaw);
  if (!Number.isInteger(zoom) || zoom < 1 || zoom > 22) return null;
  const sizeRaw = get('size') || '640x640';
  const sizeMatch = /^(\d{2,3})x(\d{2,3})$/.exec(sizeRaw);
  if (!sizeMatch || Number(sizeMatch[1]) > 640 || Number(sizeMatch[2]) > 640) return null;
  const maptype = get('maptype') || 'satellite';
  if (!['satellite', 'hybrid'].includes(maptype)) return null;
  const format = get('format') || 'png';
  if (!['png', 'png8', 'jpg', 'jpg-baseline'].includes(format)) return null;
  const scaleRaw = get('scale');
  const scale = scaleRaw == null ? null : Number(scaleRaw);
  if (scale != null && ![1, 2].includes(scale)) return null;
  const pairs = [
    ['center', center],
    ['zoom', String(zoom)],
    ['size', sizeRaw],
    ['maptype', maptype],
    ['format', format],
  ];
  if (scale != null) pairs.push(['scale', String(scale)]);
  return `${STATIC_MAP_BASE}?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// Bounded in-memory cache keyed by estimate+kind so one token cannot fan out
// into unlimited Google fetches. Holds bytes only — never a URL.
const imageCache = new Map();

function cacheGet(cacheKey) {
  const hit = imageCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    imageCache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

function cacheSet(cacheKey, value) {
  if (imageCache.size >= CACHE_MAX_ENTRIES) {
    imageCache.delete(imageCache.keys().next().value);
  }
  imageCache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
}

function clearImageCache() {
  imageCache.clear();
}

// Fetch the image for a KEYLESS Static Maps URL that the server itself built.
// The key is appended here and never leaves this function. Returns
// { buffer, contentType } or null on any failure (caller answers 404/502).
async function fetchStaticMapImage(keylessUrl, { cacheKey = null, fetchImpl = fetch, key: keyOverride = null } = {}) {
  if (typeof keylessUrl !== 'string' || !keylessUrl.startsWith(`${STATIC_MAP_BASE}?`)) return null;
  if (/[?&]key=/i.test(keylessUrl)) return null;
  const key = keyOverride || serverMapsKey();
  if (!key) return null;
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${keylessUrl}&key=${encodeURIComponent(key)}`, { signal: controller.signal });
    if (!resp || !resp.ok) return null;
    const contentType = String(resp.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(contentType)) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
    const value = { buffer, contentType };
    if (cacheKey) cacheSet(cacheKey, value);
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  STATIC_MAP_BASE,
  serverMapsKey,
  staticMapsKey,
  isGoogleStaticMapUrl,
  redactMapsKeyFromUrl,
  scrubMapsKeysFromString,
  scrubMapsKeysDeep,
  publicMapProxyPath,
  isPublicMapProxyPath,
  publicSatelliteUrl,
  sanitizedStaticMapUrlFromStored,
  fetchStaticMapImage,
  clearImageCache,
};
