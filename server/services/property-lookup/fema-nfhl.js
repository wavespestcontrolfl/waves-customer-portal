/**
 * FEMA NFHL flood-zone point lookup.
 *
 * Resolves a geocoded point to its FEMA National Flood Hazard Layer flood
 * zone (FLD_ZONE: X, AE, VE, A, AH, AO, ...) plus subtype and the SFHA flag
 * via the public NFHL MapServer (layer 28, Flood Hazard Zones).
 *
 * Evidence-only: the zone rides the cached property record (_floodZone) and
 * surfaces on the enriched profile; nothing prices off it yet. The intended
 * consumer is foundation inference (inferFoundation's documented "properties
 * in flood zones" exception) — a later, deliberately gated step because
 * foundationType feeds the termite/WDO pricing modifiers.
 *
 * Live-probe finding (2026-06-12, curl against the layer): Manatee golden
 * point 27.4536,-82.4221 → FLD_ZONE "X", ZONE_SUBTY "AREA OF MINIMAL FLOOD
 * HAZARD", SFHA_TF "F". Keep in sync if the layer moves.
 *
 * Tunables (mirror parcel-gis):
 *   FEMA_NFHL_URL        — layer query endpoint override
 *   FEMA_NFHL_TIMEOUT_MS — request timeout (default 3500)
 *   FEMA_NFHL_DISABLED=1 — kill switch (lookups return null)
 *
 * All logs prefixed `[fema-nfhl]`; coordinates only ever log coarse (2dp) —
 * AGENTS.md PII rule.
 */

const logger = require('../logger');

const DEFAULT_FEMA_NFHL_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
const DEFAULT_FEMA_NFHL_TIMEOUT_MS = 3500;
const FLOOD_OUT_FIELDS = ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF'];

function femaNfhlUrl() {
  return process.env.FEMA_NFHL_URL || DEFAULT_FEMA_NFHL_URL;
}

function femaNfhlTimeoutMs() {
  const n = Number(process.env.FEMA_NFHL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FEMA_NFHL_TIMEOUT_MS;
}

function isFemaNfhlDisabled() {
  const flag = process.env.FEMA_NFHL_DISABLED;
  return flag === '1' || flag === 'true' || flag === 'on';
}

function coarseCoord(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function cleanAttr(value) {
  const s = String(value ?? '').trim();
  return s.length ? s : null;
}

// SFHA_TF is 'T'/'F' on the layer; anything else is an unknown, not a false.
function parseSfha(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (s === 'T') return true;
  if (s === 'F') return false;
  return null;
}

async function lookupFloodZoneByPoint(lat, lng, options = {}) {
  if (isFemaNfhlDisabled()) {
    logger.info('[fema-nfhl] skipped — FEMA_NFHL_DISABLED');
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : femaNfhlTimeoutMs();

  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: FLOOD_OUT_FIELDS.join(','),
    returnGeometry: 'false',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    const resp = await fetch(`${femaNfhlUrl()}?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`FEMA NFHL ${resp.status}`);
    const data = await resp.json();
    if (data?.error) throw new Error(`FEMA NFHL error: ${data.error.message || data.error.code}`);

    const features = Array.isArray(data?.features) ? data.features : [];
    // Zone polygons tile the map; a point on a panel seam can return more
    // than one feature. The first row with a usable FLD_ZONE wins — the
    // alternative zones at a seam differ by inches of geography, and this
    // is evidence, not an elevation certificate.
    for (const feature of features) {
      const attrs = feature?.attributes || {};
      const floodZone = cleanAttr(attrs.FLD_ZONE);
      if (!floodZone) continue;
      return {
        floodZone,
        floodZoneSubtype: cleanAttr(attrs.ZONE_SUBTY),
        sfha: parseSfha(attrs.SFHA_TF),
      };
    }
    logger.info('[fema-nfhl] no flood zone at point', {
      latApprox: coarseCoord(lat),
      lngApprox: coarseCoord(lng),
      elapsedMs: Date.now() - t0,
    });
    return null;
  } catch (err) {
    // Fail-open: a FEMA outage must never sink a lookup.
    logger.warn('[fema-nfhl] lookup failed', {
      error: err?.message || String(err),
      latApprox: coarseCoord(lat),
      lngApprox: coarseCoord(lng),
      elapsedMs: Date.now() - t0,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  lookupFloodZoneByPoint,
  femaNfhlTimeoutMs,
  _private: { parseSfha, cleanAttr, isFemaNfhlDisabled },
};
