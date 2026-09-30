/**
 * Short-lived, HMAC-signed satellite image URLs, so customer-facing surfaces
 * never carry a Google Maps key.
 *
 * The server's Maps key (staticMapsKey(): GOOGLE_STATIC_MAPS_API_KEY, else
 * GOOGLE_MAPS_API_KEY || GOOGLE_API_KEY) is also used for Geocoding / Routes,
 * so it cannot be referrer-restricted. A keyed Static Maps URL handed to a
 * customer or anonymous lead therefore hands them a reusable server key.
 *
 * Instead the server mints /api/public/map-image/<token> where the token is
 *
 *     v1.<base64url(lat|lng|zoom|WxH|scale|maptype|exp)>.<base64url(hmac)>
 *
 * The proxy route (routes/public-map-image.js) verifies the signature, then
 * rebuilds the Static Maps URL ONLY from those signed, range-checked values
 * (it reads nothing from the caller's query), appends the key and streams the
 * bytes. A caller can replay a token until it expires; they cannot change the
 * location, zoom, size or map type, and cannot reach any other Google URL, so
 * the route cannot become an open proxy.
 *
 * Secret: REPORT_PIN_SECRET || JWT_SECRET (the same server secrets the report
 * assessment pins use), derived with its own purpose label so this signature
 * can never be confused with another construction's. No secret -> no signed
 * URL (callers fail closed: the map is simply omitted).
 *
 * Nothing here logs a URL or a token.
 */

const crypto = require('crypto');
const { STATIC_MAP_BASE, sanitizedStaticMapUrlFromStored } = require('./estimate-map-image');

const ROUTE_PREFIX = '/api/public/map-image';
const KEY_INFO = 'waves:signed-map-image:v1';
const DEFAULT_TTL_SECONDS = 2 * 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
// Pods' clocks differ by a second or two: a token minted at exactly the 24 h cap
// on one pod must still verify on a pod that is slightly behind.
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 200;
const MAP_TYPES = new Set(['satellite', 'hybrid']);

function signingKey() {
  const base = process.env.REPORT_PIN_SECRET || process.env.JWT_SECRET;
  if (!base || !String(base).trim()) return null;
  return crypto.createHmac('sha256', String(base)).update(KEY_INFO).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(key, text) {
  return b64url(crypto.createHmac('sha256', key).update(text).digest());
}

// Validate + canonicalize. Returns null for anything out of range, so both the
// signer and the verifier apply the exact same rules.
function normalizeParams(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const zoom = Number(raw.zoom);
  if (!Number.isInteger(zoom) || zoom < 1 || zoom > 22) return null;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 640 || height > 640) return null;
  const scale = raw.scale == null ? 1 : Number(raw.scale);
  if (![1, 2].includes(scale)) return null;
  const maptype = raw.maptype == null ? 'satellite' : String(raw.maptype);
  if (!MAP_TYPES.has(maptype)) return null;
  return { lat: lat.toFixed(7), lng: lng.toFixed(7), zoom, width, height, scale, maptype };
}

function payloadText(p, exp) {
  return [p.lat, p.lng, p.zoom, `${p.width}x${p.height}`, p.scale, p.maptype, exp].join('|');
}

const PAYLOAD_RE = /^(-?\d{1,3}\.\d{7})\|(-?\d{1,3}\.\d{7})\|(\d{1,2})\|(\d{1,3})x(\d{1,3})\|([12])\|(satellite|hybrid)\|(\d{1,12})$/;

function signMapImageToken(params, { nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const key = signingKey();
  const p = normalizeParams(params);
  if (!key || !p) return null;
  const ttl = Math.min(Math.max(Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS), 1), MAX_TTL_SECONDS);
  const body = b64url(payloadText(p, nowSeconds + ttl));
  return `v1.${body}.${hmac(key, `v1.${body}`)}`;
}

// Returns the signed, validated params or null (bad shape, bad signature,
// expired, or an expiry further out than this server ever mints).
function verifyMapImageToken(token, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const key = signingKey();
  if (!key || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  const expected = Buffer.from(hmac(key, `v1.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const match = PAYLOAD_RE.exec(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!match) return null;
  const exp = Number(match[8]);
  if (!Number.isFinite(exp) || exp <= nowSeconds || exp > nowSeconds + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) return null;
  return normalizeParams({
    lat: match[1], lng: match[2], zoom: match[3], width: match[4], height: match[5], scale: match[6], maptype: match[7],
  });
}

// The keyless Static Maps URL for already-validated params. The key is added
// by fetchStaticMapImage at fetch time only.
function keylessStaticMapUrl(params) {
  const p = normalizeParams(params);
  if (!p) return null;
  const pairs = [
    ['center', `${p.lat},${p.lng}`],
    ['zoom', String(p.zoom)],
    ['size', `${p.width}x${p.height}`],
    ['scale', String(p.scale)],
    ['maptype', p.maptype],
  ];
  return `${STATIC_MAP_BASE}?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

function withOrigin(path, absolute) {
  if (!absolute) return path;
  const { publicPortalUrl } = require('../utils/portal-url');
  return `${publicPortalUrl()}${path}`;
}

function signedMapImagePath(params, { absolute = false, ...tokenOpts } = {}) {
  const token = signMapImageToken(params, tokenOpts);
  return token ? withOrigin(`${ROUTE_PREFIX}/${token}`, absolute) : null;
}

// From a basemap provider's getLiveMapConfig() result (center / zoom / size /
// mapType). Ignores imageUrl entirely — that one embeds the key.
function signedMapImagePathFromLiveConfig(liveConfig, opts = {}) {
  if (!liveConfig?.center) return null;
  return signedMapImagePath({
    lat: liveConfig.center.lat,
    lng: liveConfig.center.lng,
    zoom: liveConfig.zoom,
    width: liveConfig.width,
    height: liveConfig.height,
    scale: 2,
    maptype: liveConfig.mapType,
  }, opts);
}

// From a stored / built Google Static Maps URL (which may carry the key): keep
// only the center / zoom / size / maptype, drop everything else, sign those.
// null when the URL is not a Static Maps URL centred on a plain "lat,lng".
function signedMapImagePathFromStaticUrl(raw, opts = {}) {
  const keyless = sanitizedStaticMapUrlFromStored(raw);
  if (!keyless) return null;
  const u = new URL(keyless);
  const center = /^(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(u.searchParams.get('center') || '');
  const size = /^(\d+)x(\d+)$/.exec(u.searchParams.get('size') || '');
  if (!center || !size) return null;
  return signedMapImagePath({
    lat: center[1],
    lng: center[2],
    zoom: u.searchParams.get('zoom'),
    width: size[1],
    height: size[2],
    scale: u.searchParams.get('scale') || 1,
    maptype: u.searchParams.get('maptype'),
  }, opts);
}

module.exports = {
  ROUTE_PREFIX,
  DEFAULT_TTL_SECONDS,
  signMapImageToken,
  verifyMapImageToken,
  keylessStaticMapUrl,
  signedMapImagePath,
  signedMapImagePathFromLiveConfig,
  signedMapImagePathFromStaticUrl,
};
