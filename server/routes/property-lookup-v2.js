/**
 * WAVES PEST CONTROL — Property Lookup API
 * Combines AI web search + Google Static Maps + Claude/OpenAI/Gemini Vision into enriched property data.
 *
 * Express route: POST /api/property-lookup
 * Body: { address: string }
 * Returns: { propertyRecord, satellite, aiAnalysis, enriched }
 *
 * ENV VARS REQUIRED:
 *   GOOGLE_MAPS_API_KEY
 *   ANTHROPIC_API_KEY
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const MODELS = require('../config/models');
const { canonicalLookupAddress, lookupStoriesFromAI, lookupPropertyFromAITrio, buildPropertyDataQuality } = require('../services/property-lookup/ai-property-lookup');
const { lookupFloodZoneByPoint } = require('../services/property-lookup/fema-nfhl');
const { lookupPoolPermitsByParcel } = require('../services/property-lookup/county-permits');
const { outerRing, simplifyRing } = require('../services/property-lookup/parcel-gis');
const {
  attachFloodZoneToCachedLookup,
  attachPoolPermitsToCachedLookup,
  applyVerifiedOverrides,
  getCachedLookup,
  getVerifiedOverrides,
  saveLookup,
  saveVerifiedOverride,
} = require('../services/property-lookup/lookup-cache');
const { normalizePropertyType: normalizePricingPropertyType } = require('../services/pricing-engine/commercial-helpers');
const { normalizeRoachType } = require('../services/pricing-engine/service-pricing');

router.use(adminAuthenticate, requireTechOrAdmin);

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const GOOGLE_STATIC_MAP = 'https://maps.googleapis.com/maps/api/staticmap';
const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const DEFAULT_LOOKUP_TOTAL_BUDGET_MS = 60000;
const DEFAULT_LOOKUP_RESPONSE_MARGIN_MS = 2500;
const DEFAULT_STORIES_MIN_REMAINING_MS = 12000;
const DEFAULT_AI_STORIES_TIMEOUT_MS = 30000;
const DEFAULT_MAPS_TIMEOUT_MS = 8000;
const DEFAULT_IMAGE_TIMEOUT_MS = 8000;
const DEFAULT_VISION_PROVIDER_TIMEOUT_MS = 25000;
const DEFAULT_VISION_MIN_REMAINING_MS = 10000;

// SWFL bounding box — reject addresses outside service area
const SWFL_BOUNDS = { latMin: 26.3, latMax: 27.8, lngMin: -82.9, lngMax: -81.5 };
const TURF_REVIEW_THRESHOLD_SQFT = 15000;
const TURF_MANUAL_CONFIRMATION_SQFT = 20000;
const TURF_HIGH_LOT_RATIO = 0.55;
const TURF_PRICED_SERVICES = new Set(['LAWN', 'OT_LAWN', 'TOPDRESS', 'DETHATCH', 'PLUGGING']);

function positiveIntEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function getLookupTimingConfig() {
  return {
    totalBudgetMs: positiveIntEnv('PROPERTY_LOOKUP_TOTAL_BUDGET_MS', DEFAULT_LOOKUP_TOTAL_BUDGET_MS),
    responseMarginMs: positiveIntEnv('PROPERTY_LOOKUP_RESPONSE_MARGIN_MS', DEFAULT_LOOKUP_RESPONSE_MARGIN_MS),
    storiesMinRemainingMs: positiveIntEnv('PROPERTY_LOOKUP_STORIES_MIN_REMAINING_MS', DEFAULT_STORIES_MIN_REMAINING_MS),
    mapsTimeoutMs: positiveIntEnv('PROPERTY_LOOKUP_MAPS_TIMEOUT_MS', DEFAULT_MAPS_TIMEOUT_MS),
    imageTimeoutMs: positiveIntEnv('PROPERTY_LOOKUP_IMAGE_TIMEOUT_MS', DEFAULT_IMAGE_TIMEOUT_MS),
    visionProviderTimeoutMs: positiveIntEnv('PROPERTY_LOOKUP_VISION_TIMEOUT_MS', DEFAULT_VISION_PROVIDER_TIMEOUT_MS),
    visionMinRemainingMs: positiveIntEnv('PROPERTY_LOOKUP_VISION_MIN_REMAINING_MS', DEFAULT_VISION_MIN_REMAINING_MS),
    storiesTimeoutMs: positiveIntEnv('AI_STORIES_TIMEOUT_MS', DEFAULT_AI_STORIES_TIMEOUT_MS),
  };
}

function remainingLookupMs(startMs, timing) {
  return Math.max(0, timing.totalBudgetMs - (Date.now() - startMs));
}

function createFetchTimeout(timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    didTimeout: () => timedOut || controller.signal.aborted,
  };
}

function timeoutError(label, timeoutMs) {
  const err = new Error(`${label} timed out after ${timeoutMs}ms`);
  err.code = 'ETIMEDOUT';
  return err;
}

function isTimeoutFailure(err, timeout) {
  return timeout.didTimeout() || err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT';
}

// ─────────────────────────────────────────────
// CORE LOOKUP — reusable by admin + public routes
// Extracted from the POST /property-lookup handler so server/routes/
// public-property-lookup.js can run the same AI search + satellite + trio
// AI vision pipeline without duplicating the logic.
// ─────────────────────────────────────────────
async function performPropertyLookup(address, options = {}) {
  const t0 = Date.now();

  // ── STEP -1: Cache ──
  // A verified-fresh row answers without re-running geocode/search/vision —
  // faster, free, and day-to-day consistent. options.refresh forces a live
  // lookup (still re-applying verified overrides and re-saving at the end).
  const verifiedOverrides = await getVerifiedOverrides(address);
  if (!options.refresh) {
    const cached = await getCachedLookup(address);
    if (cached) {
      // Flood-zone backfill (#1698 review): rows cached before the FEMA
      // provider shipped carry no _floodZone for up to the 180-day TTL.
      // Query once on hit, attach for this response, and patch the stored
      // record (atomic jsonb merge) so later hits skip the query. Fail-open
      // like the live path; a null result is NOT persisted — an outage must
      // not write "no zone" for the TTL — it simply retries next hit.
      if (
        cached.property_record
        && cached.property_record._floodZone === undefined
        && Number.isFinite(Number(cached.lat))
        && Number.isFinite(Number(cached.lng))
      ) {
        const floodZone = await lookupFloodZoneByPoint(Number(cached.lat), Number(cached.lng))
          .catch(() => null);
        if (floodZone) {
          cached.property_record._floodZone = floodZone;
          await attachFloodZoneToCachedLookup(address, floodZone);
        }
      }
      // Permit-evidence backfill, same pattern: query once on hit, persist
      // even when empty (a checked marker), retry only on provider failure.
      if (
        cached.property_record
        && cached.property_record._poolPermits === undefined
        && cached.property_record._parcel?.paoParcelId
        && cached.property_record._parcel?.county
      ) {
        const permits = await lookupPoolPermitsByParcel({
          county: cached.property_record._parcel.county,
          parcelId: cached.property_record._parcel.paoParcelId,
        }).catch(() => null);
        if (permits) {
          cached.property_record._poolPermits = permits;
          await attachPoolPermitsToCachedLookup(address, permits);
        }
      }
      return buildResultFromCachedLookup(address, cached, verifiedOverrides, t0);
    }
  }

  const result = {
    address: String(address).trim(),
    propertyRecord: null,
    // Deprecated response alias kept so the existing estimator UI and public
    // lead capture continue to work while the provider changes underneath.
    rentcast: null,
    avm: null,
    satellite: null,
    aiAnalysis: null,
    enriched: null,
    errors: [],
    meta: {
      // Anchored to t0 — BEFORE the overrides snapshot above. saveLookup
      // stores this as data_saved_at, so an override verified mid-lookup
      // (after the snapshot, thus not applied to this result) compares as
      // NEWER than the data and invalidates the first subsequent cache hit.
      timestamp: new Date(t0).toISOString(),
      lookupMs: 0,
      cache: options.refresh ? 'refresh' : 'miss',
    }
  };

  const timing = getLookupTimingConfig();
  result.meta.budgetMs = timing.totalBudgetMs;

  // ── STEP 0: Geocode ──
  // The canonical Google address + county steer the county-record gates and
  // AI prompts in Step 1; lat/lng feeds the satellite step. Fail-open: on
  // geocode failure the search falls back to the raw typed address, and the
  // satellite step is skipped exactly as it was when geocoding lived there.
  let geo = null;
  try {
    geo = await geocodeAddress(address, timing.mapsTimeoutMs);
  } catch (err) {
    result.errors.push({ source: 'satellite', message: err.message });
  }

  // ── STEP 1: AI property search ──
  // Pull pricing-relevant public facts (sqft, lot, year built, beds, baths,
  // stories, construction) from listing sites, county appraisers, builder
  // floorplans, and permit data through Claude/OpenAI/Gemini search. The shaped object
  // intentionally matches the old normalized property-record shape so the
  // pricing engine and field-verify logic do not need a provider branch.
  const aiProperty = await lookupPropertyFromAITrio(address, geo).catch((err) => {
    result.errors.push({ source: 'ai-property', message: err?.message || String(err) });
    return null;
  });
  if (aiProperty) {
    result.propertyRecord = aiProperty;
    result.rentcast = aiProperty;

    // FEMA NFHL flood-zone evidence (point query, fail-open, evidence-only).
    // Rides the merged property record so cache hits keep it. Skipped on
    // partial-match geocodes (low-trust point) and when no record exists to
    // carry it. Zone polygons are large, so ROOFTOP precision isn't required
    // the way it is for parcel matching.
    if (geo && !geo.partialMatch && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
      const floodZone = await lookupFloodZoneByPoint(geo.lat, geo.lng).catch(() => null);
      if (floodZone) result.propertyRecord._floodZone = floodZone;
    }

    // County pool/enclosure permit evidence (positive-only, fail-open) —
    // keyed on the GIS parcel identity; rides the cached record like
    // _floodZone. A successful empty check is stored too, so permit-less
    // parcels aren't re-queried on cache hits.
    const parcelMeta = result.propertyRecord._parcel;
    if (parcelMeta?.paoParcelId && parcelMeta?.county) {
      const permits = await lookupPoolPermitsByParcel({
        county: parcelMeta.county,
        parcelId: parcelMeta.paoParcelId,
      }).catch(() => null);
      if (permits) result.propertyRecord._poolPermits = permits;
    }
  }

  // Tech-verified corrections beat every remote source — applied before the
  // satellite/vision steps so prompts see the corrected facts, and the
  // stories fallback skips entirely when a tech verified the story count.
  if (verifiedOverrides && result.propertyRecord) {
    applyVerifiedOverrides(result.propertyRecord, verifiedOverrides);
  }

  // ── STEP 2: Satellite Images ──
  let lat, lng;
  if (geo) try {
    lat = geo.lat;
    lng = geo.lng;

    // Validate within SWFL service area
    if (lat < SWFL_BOUNDS.latMin || lat > SWFL_BOUNDS.latMax ||
        lng < SWFL_BOUNDS.lngMin || lng > SWFL_BOUNDS.lngMax) {
      result.errors.push({ source: 'geo', message: 'Outside SWFL service area' });
    }

    // Generate satellite image URLs (not fetched — frontend displays them,
    // but we also fetch as base64 for Claude analysis)
    // URLs generated below with validated key

    // Fetch satellite images as base64 for Claude
    const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
    if (!mapsKey) {
      result.errors.push({ source: 'satellite', message: 'No GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY configured' });
    } else {
      const microCloseUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=22&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const ultraCloseUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=21&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const superCloseUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const closeUrlWithKey = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=19&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const wideUrlWithKey = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=18&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;

      // Vision-only parcel overlay: the base64 images the models analyze get
      // the parcel boundary drawn on them; the client-facing URLs above stay
      // clean so the estimator shows the property 1:1. Oversized paths drop
      // the overlay rather than break the image fetch.
      const overlayParam = parcelOverlayEnabled()
        ? buildParcelOverlayParam(result.propertyRecord?._parcel?.polygon)
        : null;
      const withOverlay = (url) => {
        if (!overlayParam) return url;
        const overlaid = `${url}&${overlayParam}`;
        return overlaid.length <= STATIC_MAP_MAX_URL_LENGTH ? overlaid : url;
      };
      const overlayApplied = Boolean(overlayParam)
        && `${microCloseUrl}&${overlayParam}`.length <= STATIC_MAP_MAX_URL_LENGTH;

      const [microCloseB64, ultraCloseB64, superCloseB64, closeB64, wideB64] = await Promise.all([
        fetchImageAsBase64(withOverlay(microCloseUrl), timing.imageTimeoutMs).catch(() => null),
        fetchImageAsBase64(withOverlay(ultraCloseUrl), timing.imageTimeoutMs).catch(() => null),
        fetchImageAsBase64(withOverlay(superCloseUrl), timing.imageTimeoutMs).catch(() => null),
        fetchImageAsBase64(withOverlay(closeUrlWithKey), timing.imageTimeoutMs).catch(() => null),
        fetchImageAsBase64(withOverlay(wideUrlWithKey), timing.imageTimeoutMs).catch(() => null),
      ]);
      console.log(`[property-lookup] Satellite images: micro=${!!microCloseB64}, ultra=${!!ultraCloseB64}, super=${!!superCloseB64}, close=${!!closeB64}, wide=${!!wideB64}, parcelOverlay=${overlayApplied}`);

      result.satellite = {
        lat, lng,
        microCloseUrl,
        ultraCloseUrl,
        superCloseUrl,
        closeUrl: closeUrlWithKey,
        wideUrl: wideUrlWithKey,
        inServiceArea: !(lat < SWFL_BOUNDS.latMin || lat > SWFL_BOUNDS.latMax ||
                         lng < SWFL_BOUNDS.lngMin || lng > SWFL_BOUNDS.lngMax),
        _microCloseB64: microCloseB64,
        _ultraCloseB64: ultraCloseB64,
        _superCloseB64: superCloseB64,
        _closeB64: closeB64,
        _wideB64: wideB64,
        _parcelOverlayApplied: overlayApplied
      };
    }
  } catch (err) {
    result.errors.push({ source: 'satellite', message: err.message });
  }

  // ── STEP 3: Trio AI Vision Analysis (Claude + OpenAI + Gemini) ──
  const visionBudgetMs = Math.max(0, remainingLookupMs(t0, timing) - timing.responseMarginMs);
  const visionTimeoutMs = Math.min(timing.visionProviderTimeoutMs, visionBudgetMs);
  if (result.satellite?._closeB64 && result.satellite?._wideB64 && visionBudgetMs >= timing.visionMinRemainingMs) {
    const visionContext = buildVisionContext(result.satellite, result.propertyRecord?._parcel);
    const [claudeResult, openaiResult, geminiResult] = await Promise.allSettled([
      // Claude Vision
      (async () => {
        if (!process.env.ANTHROPIC_API_KEY) {
          console.log('[CLAUDE DEBUG] ANTHROPIC_API_KEY not set — skipping');
          return null;
        }
        if (!result.satellite?._closeB64) {
          console.log('[CLAUDE DEBUG] No close satellite image — skipping');
          return null;
        }
        try {
          console.log('[CLAUDE DEBUG] Starting Claude vision analysis...');
          const claudeAnalysis = await analyzeWithClaude(
            result.satellite._closeB64,
            result.satellite._wideB64 || result.satellite._closeB64,
            result.propertyRecord,
            address,
            result.satellite._superCloseB64,
            result.satellite._ultraCloseB64,
            result.satellite._microCloseB64,
            visionTimeoutMs,
            visionContext
          );
          console.log(`[CLAUDE DEBUG] Success! Confidence: ${claudeAnalysis?.confidenceScore || 'N/A'}%`);
          return claudeAnalysis;
        } catch (err) {
          const timeoutLike = /timed out|timeout|abort/i.test(`${err.name || ''} ${err.message || ''}`);
          const log = timeoutLike ? console.warn : console.error;
          log.call(console, `[CLAUDE DEBUG] FAILED: ${err.message}`);
          throw err;
        }
      })(),
      // OpenAI Vision
      (async () => {
        if (!process.env.OPENAI_API_KEY) {
          console.log('[OPENAI DEBUG] OPENAI_API_KEY not set — skipping');
          return null;
        }
        try {
          console.log('[OPENAI DEBUG] Starting OpenAI vision analysis...');
          const openaiAnalysis = await analyzeWithOpenAI(
            [
              result.satellite?._microCloseB64,
              result.satellite?._ultraCloseB64,
              result.satellite?._superCloseB64,
              result.satellite?._closeB64,
              result.satellite?._wideB64,
            ].filter(Boolean),
            result.propertyRecord,
            address,
            visionTimeoutMs,
            visionContext
          );
          console.log(`[OPENAI DEBUG] Success! Confidence: ${openaiAnalysis?.confidenceScore || 'N/A'}%`);
          return openaiAnalysis;
        } catch (openaiErr) {
          const timeoutLike = /timed out|timeout|abort/i.test(`${openaiErr.name || ''} ${openaiErr.message || ''}`);
          const log = timeoutLike ? console.warn : console.error;
          log.call(console, `[OPENAI DEBUG] FAILED: ${openaiErr.message}`);
          throw openaiErr;
        }
      })(),
      // Gemini Vision
      (async () => {
        const geminiKey = process.env.GEMINI_API_KEY;
        console.log(`[GEMINI DEBUG] Key exists: ${!!geminiKey}`);
        if (!geminiKey) {
          console.log('[GEMINI DEBUG] GEMINI_API_KEY not set — skipping');
          return null;
        }
        try {
          console.log('[GEMINI DEBUG] Starting Gemini vision analysis...');
          const geminiAnalysis = await analyzeWithGemini(
            [
              result.satellite?._microCloseB64,
              result.satellite?._ultraCloseB64,
              result.satellite?._superCloseB64,
              result.satellite?._closeB64,
              result.satellite?._wideB64,
            ].filter(Boolean),
            result.propertyRecord,
            address,
            geminiKey,
            visionTimeoutMs,
            visionContext
          );
          console.log(`[GEMINI DEBUG] Success! Confidence: ${geminiAnalysis?.confidenceScore || 'N/A'}%`);
          return geminiAnalysis;
        } catch (gemErr) {
          const timeoutLike = /timed out|timeout|abort/i.test(`${gemErr.name || ''} ${gemErr.message || ''}`);
          const log = timeoutLike ? console.warn : console.error;
          log.call(console, `[GEMINI DEBUG] FAILED: ${gemErr.message}`);
          throw gemErr;
        }
      })(),
    ]);

    const claude = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
    const openai = openaiResult.status === 'fulfilled' ? openaiResult.value : null;
    const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

    if (claudeResult.status === 'rejected') {
      result.errors.push({ source: 'claude', message: claudeResult.reason?.message || 'Claude analysis failed' });
    }
    if (openaiResult.status === 'rejected') {
      result.errors.push({ source: 'openai', message: openaiResult.reason?.message || 'OpenAI analysis failed' });
    }
    if (geminiResult.status === 'rejected') {
      result.errors.push({ source: 'gemini', message: geminiResult.reason?.message || 'Gemini analysis failed' });
    }

    const analyses = [
      claude ? { provider: 'claude', analysis: claude } : null,
      openai ? { provider: 'openai', analysis: openai } : null,
      gemini ? { provider: 'gemini', analysis: gemini } : null,
    ].filter(Boolean);

    if (analyses.length) {
      result.aiAnalysis = mergeAiAnalyses(analyses);
      // Reclassify a weak record from the satellite attachment read BEFORE the
      // turf cap: applyParcelTurfBound skips townhome/condo, so doing this first
      // keeps an attached unit's turf from being clamped to its small parcel and
      // underpriced (the cached aiAnalysis is then saved already-correct).
      applySatelliteAttachmentType(result.propertyRecord, result.aiAnalysis);
      applyParcelTurfBound(result.aiAnalysis, result.propertyRecord);
      logger.info('[property-lookup] Trio AI analysis complete', {
        sources: result.aiAnalysis._sources,
        confidence: result.aiAnalysis.confidenceScore,
      });
    } else {
      result.errors.push({ source: 'ai', message: 'All AI vision models failed — check API keys' });
    }
  } else if (result.satellite?._closeB64 && result.satellite?._wideB64) {
    logger.info('[property-lookup] skipped satellite vision to keep lookup responsive', {
      elapsedMs: Date.now() - t0,
      remainingMs: remainingLookupMs(t0, timing),
      minRemainingMs: timing.visionMinRemainingMs,
    });
    result.errors.push({
      source: 'ai',
      message: 'Skipped satellite vision to keep property lookup responsive',
    });
  } else if (!result.satellite?._closeB64) {
    result.errors.push({ source: 'ai', message: 'Satellite images not available — cannot run AI analysis' });
  }

  // ── STEP 3.5: Stories fallback — Claude w/ web_search when the full
  // property search did not find stories. Pass the public facts we DO have as hints so Claude can match
  // by subdivision + sqft against builder floorplan catalogs (the pattern
  // that catches new-construction homes the public listings haven't indexed
  // yet). Stamp `_storiesSource` on the normalized property record so
  // buildEnrichedProfile can surface provenance to the client without a
  // signature change.
  if (result.propertyRecord) {
    if (result.propertyRecord.stories) {
      result.propertyRecord._storiesSource = 'ai';
    } else {
      const hints = {
        subdivision: result.propertyRecord._raw?.subdivision || null,
        squareFootage: result.propertyRecord.squareFootage || null,
        bedrooms: result.propertyRecord.bedrooms || null,
        bathrooms: result.propertyRecord.bathrooms || null,
        yearBuilt: result.propertyRecord.yearBuilt || null,
        propertyType: result.propertyRecord.propertyType || null,
      };
      const storyBudgetMs = Math.max(0, remainingLookupMs(t0, timing) - timing.responseMarginMs);
      let aiStories = null;
      if (storyBudgetMs >= timing.storiesMinRemainingMs) {
        aiStories = await lookupStoriesFromAI(canonicalLookupAddress(address, geo), hints, {
          timeoutMs: Math.min(storyBudgetMs, timing.storiesTimeoutMs),
        }).catch((err) => {
          result.errors.push({ source: 'ai-stories', message: err?.message || String(err) });
          return null;
        });
      } else {
        logger.info('[property-lookup] skipped stories fallback to keep lookup responsive', {
          elapsedMs: Date.now() - t0,
          remainingMs: remainingLookupMs(t0, timing),
          minRemainingMs: timing.storiesMinRemainingMs,
        });
        result.errors.push({
          source: 'ai-stories',
          message: 'Skipped stories fallback to keep property lookup responsive',
        });
      }
      if (aiStories) {
        result.propertyRecord.stories = aiStories;
        result.propertyRecord._storiesSource = 'ai';
      } else {
        result.propertyRecord._storiesSource = 'default';
      }
    }
    result.rentcast = result.propertyRecord;
  }

  // ── STEP 4: Enrich — merge all data sources ──
  // A verified story count is a field correction, not an AI answer — restamp
  // provenance after the stories fallback so the client nudge stays quiet.
  if (verifiedOverrides?.stories && result.propertyRecord) {
    result.propertyRecord._storiesSource = 'verified';
  }
  result.enriched = buildEnrichedProfile(result.propertyRecord, result.aiAnalysis, lat, lng, result.avm);

  // Clean up internal fields before sending to client
  if (result.satellite) {
    delete result.satellite._microCloseB64;
    delete result.satellite._ultraCloseB64;
    delete result.satellite._superCloseB64;
    delete result.satellite._closeB64;
    delete result.satellite._wideB64;
  }

  result.meta.lookupMs = Date.now() - t0;

  // ── STEP 5: Persist ── (fail-open; never caches a failed lookup)
  await saveLookup(address, result);

  return result;
}

// Rebuilds a full lookup response from a cached row: satellite URLs are
// regenerated from the stored lat/lng with the CURRENT maps key (keyed URLs
// are never stored), enriched is recomputed live (modifier logic evolves —
// enriched_snapshot is lead-history only), and verified overrides re-apply
// on every hit because they never expire.
function buildResultFromCachedLookup(address, row, verifiedOverrides, t0) {
  const record = applyVerifiedOverrides(row.property_record, verifiedOverrides);
  const aiAnalysis = row.ai_analysis || null;
  const lat = row.lat == null ? null : Number(row.lat);
  const lng = row.lng == null ? null : Number(row.lng);
  if (verifiedOverrides?.stories && record) record._storiesSource = 'verified';

  const result = {
    address: String(address).trim(),
    propertyRecord: record,
    rentcast: record,
    avm: null,
    satellite: buildSatelliteUrlSet(lat, lng),
    aiAnalysis,
    enriched: buildEnrichedProfile(record, aiAnalysis, lat, lng, null),
    errors: [],
    meta: {
      timestamp: new Date().toISOString(),
      lookupMs: Date.now() - t0,
      cache: 'hit',
      cachedAt: row.updated_at || null,
    },
  };
  return result;
}

// Client-facing satellite URL set (no vision base64s — cache hits skip the
// vision pipeline entirely; the stored aiAnalysis already covers it).
function buildSatelliteUrlSet(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!mapsKey) return null;
  const urlAtZoom = (zoom) => `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
  return {
    lat,
    lng,
    microCloseUrl: urlAtZoom(22),
    ultraCloseUrl: urlAtZoom(21),
    superCloseUrl: urlAtZoom(20),
    closeUrl: urlAtZoom(19),
    wideUrl: urlAtZoom(18),
    inServiceArea: !(lat < SWFL_BOUNDS.latMin || lat > SWFL_BOUNDS.latMax ||
                     lng < SWFL_BOUNDS.lngMin || lng > SWFL_BOUNDS.lngMax),
  };
}

// ─────────────────────────────────────────────
// MAIN ROUTE — admin/tech-gated thin wrapper over performPropertyLookup
// ─────────────────────────────────────────────
router.post('/property-lookup', async (req, res) => {
  const { address, refresh } = req.body;
  if (!address || address.trim().length < 5) {
    return res.status(400).json({ error: 'Address required' });
  }
  try {
    const result = await performPropertyLookup(address, { refresh: refresh === true });
    result.meta.providerStatus = buildProviderStatus();
    res.json(result);
  } catch (err) {
    logger.error(`[property-lookup] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// FIELD-VERIFIED OVERRIDES — a tech standing on the property beats every
// remote source. Whitelisted fields only; overrides never expire and
// re-apply to cached AND fresh lookups of the same address.
// (Router-level adminAuthenticate + requireTechOrAdmin already cover this.)
// ─────────────────────────────────────────────
// GET /api/.../property-lookup/provider-accuracy — per-provider accuracy
// vs tech-verified facts. Read-only analytics: every verified override is
// scored against each provider's ORIGINAL claim preserved in the cached
// record's _fieldEvidence (the input for any future evidence-weight retune,
// which stays a separate deliberate decision).
router.get('/property-lookup/provider-accuracy', async (req, res, next) => {
  try {
    const { providerAccuracy } = require('../services/property-lookup/provider-accuracy');
    const report = await providerAccuracy();
    res.json({ success: true, ...report });
  } catch (err) {
    next(err);
  }
});

router.post('/property-lookup/verify', async (req, res) => {
  const { address, fields } = req.body || {};
  if (!address || String(address).trim().length < 5) {
    return res.status(400).json({ error: 'Address required' });
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return res.status(400).json({ error: 'fields object required' });
  }
  try {
    const verifiedBy = req.technician?.name || req.technician?.email || `tech:${req.technicianId}`;
    const saved = await saveVerifiedOverride(address, fields, String(verifiedBy));
    if (!saved) {
      return res.status(400).json({ error: 'No verifiable fields in payload' });
    }
    res.json({ success: true, verifiedFields: Object.keys(saved) });
  } catch (err) {
    logger.error(`[property-lookup] verify failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────
// NORMALIZERS
// ─────────────────────────────────────────────
function normalizeConstruction(raw) {
  if (!raw) return 'UNKNOWN';
  const s = raw.toUpperCase();
  if (s.includes('CONCRETE') || s.includes('CBS') || s.includes('BLOCK') ||
      s.includes('MASONRY') || s.includes('STUCCO')) return 'CBS';
  if (s.includes('WOOD') || s.includes('FRAME') || s.includes('TIMBER')) return 'WOOD_FRAME';
  if (s.includes('METAL') || s.includes('STEEL') || s.includes('PREFAB')) return 'METAL';
  if (s.includes('BRICK')) return 'BRICK';
  return 'UNKNOWN';
}

function normalizeFoundation(raw) {
  if (!raw) return 'UNKNOWN';
  const s = raw.toUpperCase();
  if (s.includes('SLAB') || s.includes('CONCRETE')) return 'SLAB';
  if (s.includes('CRAWL')) return 'CRAWLSPACE';
  if (s.includes('RAISED') || s.includes('PIER') || s.includes('PILING') ||
      s.includes('STILT')) return 'RAISED';
  if (s.includes('BASEMENT')) return 'BASEMENT';
  return 'UNKNOWN';
}

function normalizeRoof(raw) {
  if (!raw) return 'UNKNOWN';
  const s = raw.toUpperCase();
  if (s.includes('TILE') || s.includes('CLAY') || s.includes('BARREL')) return 'TILE';
  if (s.includes('SHINGLE') || s.includes('ASPHALT') || s.includes('COMP')) return 'SHINGLE';
  if (s.includes('METAL') || s.includes('STANDING SEAM') || s.includes('TIN')) return 'METAL';
  if (s.includes('FLAT') || s.includes('BUILT-UP') || s.includes('TPO') ||
      s.includes('MEMBRANE')) return 'FLAT';
  return 'UNKNOWN';
}


// ─────────────────────────────────────────────
// PARCEL OVERLAY + IMAGE SCALE (vision grounding)
// ─────────────────────────────────────────────
// Google Static Maps rejects URLs beyond 16384 chars; leave headroom for the
// base URL + key.
const STATIC_MAP_MAX_URL_LENGTH = 16000;
const PARCEL_OVERLAY_MAX_POINTS = 100;

function parcelOverlayEnabled() {
  const flag = process.env.PROPERTY_LOOKUP_PARCEL_OVERLAY;
  return !(flag === '0' || flag === 'false' || flag === 'off');
}

// Static Maps `path` param drawing the parcel's outer boundary in red.
// Returns null when there is no usable polygon — callers fall back to clean
// images and the no-outline prompt wording together.
function buildParcelOverlayParam(polygon) {
  const ring = outerRing(polygon);
  if (!ring || ring.length < 4) return null;
  const simplified = simplifyRing(ring, PARCEL_OVERLAY_MAX_POINTS)
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (simplified.length < 4) return null;

  const points = [...simplified];
  const [firstLng, firstLat] = points[0];
  const [lastLng, lastLat] = points[points.length - 1];
  if (firstLng !== lastLng || firstLat !== lastLat) points.push(points[0]);

  // Static Maps wants lat,lng; GIS rings are [lng, lat].
  const path = ['color:0xff0000ff', 'weight:3',
    ...points.map(([pLng, pLat]) => `${pLat.toFixed(6)},${pLng.toFixed(6)}`),
  ].join('|');
  return `path=${encodeURIComponent(path)}`;
}

// 640px-image ground width in feet at a zoom level: Google's Web Mercator
// scale is 156543.03392 m/px at zoom 0, halving per zoom, scaled by cos(lat).
function imageWidthFt(zoom, lat) {
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom);
  return metersPerPixel * 640 * 3.28084;
}

// Scale + parcel-outline context shared by all three vision prompts. The
// scale lines turn absolute-sqft questions (estimatedTurfSf, bed area) from
// unconstrained guesses into bounded measurement; the outline block only
// appears when the overlay actually made it onto the images.
function buildVisionContext(satellite, parcel) {
  if (!satellite || !Number.isFinite(satellite.lat)) return null;
  const slots = [
    ['MICRO CLOSE (zoom 22)', 22, satellite._microCloseB64],
    ['ULTRA CLOSE (zoom 21)', 21, satellite._ultraCloseB64],
    ['SUPER CLOSE (zoom 20)', 20, satellite._superCloseB64],
    ['CLOSE (zoom 19)', 19, satellite._closeB64],
    ['WIDE (zoom 18)', 18, satellite._wideB64],
  ];
  const scaleLines = slots
    .filter(([, , b64]) => Boolean(b64))
    .map(([label, zoom]) => `- ${label}: ~${Math.round(imageWidthFt(zoom, satellite.lat))} ft across`);
  if (!scaleLines.length) return null;
  return {
    scaleLines,
    hasParcelOutline: satellite._parcelOverlayApplied === true,
    parcelAreaSqft: parcel?.polygonAreaSqft || null,
  };
}

function visionContextPromptBlock(visionContext) {
  if (!visionContext) return '';
  const lines = [
    '',
    'IMAGE SCALE (each image is 640px square):',
    ...visionContext.scaleLines,
  ];
  if (visionContext.hasParcelOutline) {
    lines.push('');
    lines.push('PARCEL BOUNDARY: the subject parcel is outlined in RED on each image. Measure ONLY inside the red outline — neighboring yards, sidewalks, and streets outside it are NOT part of this property.');
    if (visionContext.parcelAreaSqft) {
      lines.push(`The outlined parcel is ~${visionContext.parcelAreaSqft} sq ft total, so estimatedTurfSf MUST be below that.`);
    }
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// GEOCODE
// ─────────────────────────────────────────────
// Shapes one Google geocoder result into the geo context consumed by the
// county-record gates and AI prompts. partialMatch flags low-trust results
// (typo'd / ambiguous input) so gates can ignore the geo signal while the
// satellite step still gets usable coordinates.
function parseGeocodeResult(result) {
  if (!result?.geometry?.location) return null;
  const components = Array.isArray(result.address_components) ? result.address_components : [];
  const findComponent = (type) => components.find((c) => Array.isArray(c.types) && c.types.includes(type)) || null;
  const county = findComponent('administrative_area_level_2');
  const state = findComponent('administrative_area_level_1');
  const city = findComponent('locality') || findComponent('sublocality') || findComponent('postal_town');
  const zip = findComponent('postal_code');
  return {
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    formattedAddress: result.formatted_address || null,
    county: county ? county.long_name.replace(/\s+County$/i, '').trim() : null,
    state: state ? state.short_name : null,
    city: city ? city.long_name : null,
    zip: zip ? zip.long_name : null,
    partialMatch: result.partial_match === true,
    // ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER / APPROXIMATE — the GIS
    // parcel match only trusts rooftop-grade points.
    locationType: result.geometry.location_type || null,
  };
}

async function geocodeAddress(address, timeoutMs = DEFAULT_MAPS_TIMEOUT_MS) {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!mapsKey) throw new Error('No GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY configured');
  const url = `${GOOGLE_GEOCODE}?address=${encodeURIComponent(address)}&key=${mapsKey}`;
  const timeout = createFetchTimeout(timeoutMs);
  try {
    const resp = await fetch(url, { signal: timeout.signal });
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results?.length) {
      throw new Error(`Geocode failed: ${data.status}`);
    }
    const geo = parseGeocodeResult(data.results[0]);
    if (!geo) throw new Error('Geocode failed: result missing geometry');
    return geo;
  } catch (err) {
    if (isTimeoutFailure(err, timeout)) throw timeoutError('Google geocode', timeoutMs);
    throw err;
  } finally {
    timeout.clear();
  }
}


// ─────────────────────────────────────────────
// IMAGE FETCH (base64 for Claude)
// ─────────────────────────────────────────────
async function fetchImageAsBase64(url, timeoutMs = DEFAULT_IMAGE_TIMEOUT_MS) {
  const timeout = createFetchTimeout(timeoutMs);
  try {
    const resp = await fetch(url, { signal: timeout.signal });
    if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (err) {
    if (isTimeoutFailure(err, timeout)) throw timeoutError('Satellite image fetch', timeoutMs);
    throw err;
  } finally {
    timeout.clear();
  }
}


// ─────────────────────────────────────────────
// CLAUDE VISION ANALYSIS
// ─────────────────────────────────────────────
async function analyzeWithClaude(closeB64, wideB64, propertyRecord, address, superCloseB64, ultraCloseB64, microCloseB64, timeoutMs = DEFAULT_VISION_PROVIDER_TIMEOUT_MS, visionContext = null) {
  const rcContext = propertyRecord ? `
Property record for this address:
- Address: ${propertyRecord.formattedAddress}
- Type: ${propertyRecord.propertyType}
- Sq Ft: ${propertyRecord.squareFootage}
- Lot: ${propertyRecord.lotSize} sf
- Year Built: ${propertyRecord.yearBuilt || 'unknown'}
- Stories: ${propertyRecord.stories}
- Pool (per records): ${poolRecordContext(propertyRecord)}
- Construction: ${propertyRecord.constructionMaterial}
- Foundation: ${propertyRecord.foundationType}
- Roof: ${propertyRecord.roofType}
- HOA Fee: ${propertyRecord.hoaFee ? '$' + propertyRecord.hoaFee + '/mo' : 'None/unknown'}
` : `No public property record available for this property.`;

  const systemPrompt = `You are a property analysis AI for Waves Pest Control, a pest control and lawn care company in Southwest Florida. You analyze satellite imagery to extract property features that affect pest control, lawn care, tree/shrub care, mosquito control, and termite treatment pricing.

You will receive up to five satellite images (closer views carry MORE weight for feature detection):
1. MICRO CLOSE VIEW (zoom 22) — HIGHEST PRIORITY when usable — closest property detail.
2. ULTRA CLOSE VIEW (zoom 21) — shows pool cages, screen enclosures, lanai details, driveway width, individual plants.
3. SUPER CLOSE VIEW (zoom 20) — shows fine detail: roof material, driveway surface, landscape beds.
4. CLOSE VIEW (zoom 19) — shows the full property lot boundaries and structure.
5. WIDE VIEW (zoom 18) — shows the neighborhood, water features, surrounding lots.

You also receive public property record data for cross-reference.

IMPORTANT RULES:
- POOL DETECTION (SWFL-specific): Pool cages/screen enclosures are EXTREMELY common in Southwest Florida. They appear as rectangular screened structures attached to the back of the home, often covering both a pool and a lanai/patio. Look for: rectangular screen enclosure (lighter gray mesh visible from above), blue water visible through the screen, or a solid lanai roof extending from the main roof. If you see ANY screen enclosure attached to the home, mark poolCage=YES. Even small ones count. If public records say pool=NO but you clearly see a pool cage or blue water, override records because county/listing data can be outdated.
- POOL CAGE SIZE: classify the visible screen enclosure service burden. SMALL is a compact lanai/cage under roughly 300 sq ft, MEDIUM is typical 300-600 sq ft, LARGE is roughly 600-900 sq ft or clearly longer/wider than a standard cage, OVERSIZED is a very large enclosure or complex cage with multiple sections. If poolCage is not YES, return NONE.
- DRIVEWAY: "largeDriveway" means the driveway is wider than a standard 2-car width (~20ft) OR extends significantly along the side of the home OR has a circular/turnaround area. Standard SWFL driveways are 2-car width going straight to the garage — that is NOT large. Only mark YES if it's notably oversized.
- For construction material: if the property record already identified it, confirm or note disagreement. If unknown, infer from satellite (CBS=stucco appearance, wood frame=siding visible, etc.)
- For foundation: SWFL default is slab-on-grade. Only flag raised/crawlspace if clearly visible (house elevated, visible piers/stilts, lattice skirting).
- STRUCTURE ATTACHMENT (drives townhome/condo vs single-family pricing): look at the roofline and the neighbors. A free-standing home with gaps to both neighbors is DETACHED. A unit at the end of a continuous shared roofline / row of identical units is ATTACHED_END (one party wall). A unit boxed in between two others in that row is ATTACHED_INTERIOR (two party walls, often no side yard). Floors stacked with separate ground-level entries (an apartment/condo building) are STACKED. New master-planned SWFL communities mix detached homes with attached villas/townhomes on the same street — judge THIS structure, not the community. If you genuinely cannot tell, return UNKNOWN rather than guessing DETACHED.
- Estimate impervious surface as a percentage of the total lot, not just what you see — account for areas under the roof line too.
- Be aggressive about detecting features — it's better to flag "POSSIBLE" than to miss something. Pest control pricing depends on accurate property assessment.

Respond ONLY with a JSON object. No markdown, no explanation, no backticks.`;

  const userPrompt = `Analyze these two satellite images of a property at: ${address}

${rcContext}${visionContextPromptBlock(visionContext)}

Return a JSON object with exactly these fields:

{
  "propertyUse": "RESIDENTIAL" | "COMMERCIAL" | "MIXED" | "UNKNOWN",
  "commercialUseType": "OFFICE_RETAIL" | "WAREHOUSE_LIGHT" | "RESTAURANT_FOOD_SERVICE" | "MEDICAL_OFFICE" | "INDUSTRIAL" | "SCHOOL_DAYCARE" | "GOVERNMENT_MUNICIPAL" | "HOA_COMMON_AREA" | "MULTIFAMILY_COMMON_AREA" | "OTHER" | "NONE",

  "structureAttachment": "DETACHED" | "ATTACHED_END" | "ATTACHED_INTERIOR" | "STACKED" | "UNKNOWN",
  "sharedWallCount": number (0 for a free-standing home, 1 for an end unit, 2 for an interior row unit),
  "structureAttachmentNotes": "string — what tells you it's attached/detached: continuous shared roofline, party walls, a row of identical units, stacked floors with separate entries",

  "pool": "YES" | "NO" | "POSSIBLE",
  "poolCage": "YES" | "NO" | "POSSIBLE",
  "poolCageSize": "NONE" | "SMALL" | "MEDIUM" | "LARGE" | "OVERSIZED",
  "poolNotes": "string — any relevant detail about pool/lanai/cage",

  "largeDriveway": "YES" | "NO",
  "drivewaySurfaceType": "CONCRETE" | "PAVER" | "ASPHALT" | "GRAVEL" | "UNKNOWN",

  "fenceType": "NONE" | "PRIVACY_WOOD" | "PRIVACY_VINYL" | "CHAIN_LINK" | "ALUMINUM" | "PARTIAL" | "UNKNOWN",
  "fenceNotes": "string — what sides fenced, condition",

  "roofMaterial": "TILE" | "SHINGLE" | "METAL" | "FLAT" | "UNKNOWN",
  "roofNotes": "string — color, condition visible from above",

  "constructionVisible": "CBS" | "WOOD_FRAME" | "METAL" | "BRICK" | "UNKNOWN",

  "shrubDensity": "LIGHT" | "MODERATE" | "HEAVY",
  "treeDensity": "LIGHT" | "MODERATE" | "HEAVY",
  "landscapeComplexity": "SIMPLE" | "MODERATE" | "COMPLEX",

  "estimatedPalmCount": number,
  "estimatedTreeCount": number,
  "estimatedBedAreaSf": number,

  "turfCondition": "GOOD" | "FAIR" | "POOR" | "UNKNOWN",
  "possibleGrassType": "ST_AUGUSTINE" | "BERMUDA" | "BAHIA" | "ZOYSIA" | "MIXED" | "UNKNOWN",
  "shadeCoveragePercent": number (0-100, percentage of turf under tree canopy),

  "imperviousSurfacePercent": number (0-100, percentage of lot that is hardscape/concrete/roof/paved),
  "estimatedTurfSf": number (estimated treatable turf area in sq ft),

  "mulchBeds": "YES" | "NO" | "UNKNOWN",
  "rockBeds": "YES" | "NO" | "UNKNOWN",
  "bedMaterial": "MULCH" | "ROCK" | "MIXED" | "BARE" | "UNKNOWN",

  "irrigationVisible": "YES" | "NO" | "UNKNOWN",

  "nearWater": "NONE" | "CANAL_ADJACENT" | "POND_ON_PROPERTY" | "RETENTION_NEARBY" | "LAKE_ADJACENT" | "WETLAND_ADJACENT",
  "waterDistance": "ON_PROPERTY" | "ADJACENT" | "WITHIN_200FT" | "WITHIN_500FT" | "NONE",

  "woodedAdjacency": "NONE" | "PARTIAL" | "HEAVY",
  "woodedNotes": "string — which sides back to wooded/undeveloped land",

  "outbuildingCount": number (sheds, detached garages, pool houses — NOT the main structure),
  "outbuildingNotes": "string",

  "maintenanceCondition": "WELL_MAINTAINED" | "AVERAGE" | "DEFERRED" | "UNKNOWN",
  "maintenanceNotes": "string — visible issues: overgrown vegetation, debris, roof staining, etc.",

  "vegetationOnStructure": "NONE" | "MINOR" | "SIGNIFICANT",
  "vegetationNotes": "string — vines, trees touching roof, branches overhanging",

  "overallPestPressureEstimate": "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH",
  "pestPressureFactors": ["string array of factors contributing to pest pressure"],

  "confidenceScore": number (0-100, how confident you are in the overall analysis),
  "analysisNotes": "string — any caveats, things you couldn't determine, or recommendations for field verification"
}`;

  const timeout = createFetchTimeout(timeoutMs);
  let data;
  try {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      signal: timeout.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELS.FLAGSHIP,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            ...(microCloseB64 ? [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: microCloseB64 }
            }] : []),
            ...(ultraCloseB64 ? [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: ultraCloseB64 }
            }] : []),
            ...(superCloseB64 ? [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: superCloseB64 }
            }] : []),
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: closeB64 }
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: wideB64 }
            },
            { type: 'text', text: userPrompt }
          ]
        }],
        system: systemPrompt
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Claude API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    data = await resp.json();
  } catch (err) {
    if (isTimeoutFailure(err, timeout)) throw timeoutError('Claude vision analysis', timeoutMs);
    throw err;
  } finally {
    timeout.clear();
  }
  console.log(`[CLAUDE VISION DEBUG] stop_reason: ${data.stop_reason}, usage: ${JSON.stringify(data.usage || {})}`);
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Parse JSON — strip any markdown fences if present
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error(`[CLAUDE VISION DEBUG] JSON.parse failed: ${e.message}. Response tail: ${clean.slice(-200)}`);
    throw e;
  }
}


// ─────────────────────────────────────────────
// ENRICHED PROFILE — merges all data sources
// ─────────────────────────────────────────────
// SHADOW (estimator backlog: building-footprint turf subtraction):
// deterministic turf ceiling from county-assessed facts alone — lot minus
// the ground-floor building footprint (living area / stories) minus the
// assessed impervious improvements from the county extra-features roll
// (imperviousAreaSf; null = roll not parsed, treated as 0 and flagged via
// parts.imperviousKnown). Attached to the profile for comparison against
// the vision estimate and, downstream, the estimate_actuals measured-turf
// loop; NOT read by pricing — computeTurfArea consumes estimatedTurfSf /
// measuredTurfSf only. Promoting this from shadow to a pricing input is a
// deliberate later flip once the logged deltas have been judged.
function computeFootprintTurf(rc) {
  const lotSqFt = Number(rc?.lotSize);
  const homeSqFt = Number(rc?.squareFootage);
  if (!Number.isFinite(lotSqFt) || lotSqFt <= 0) return null;
  if (!Number.isFinite(homeSqFt) || homeSqFt <= 0) return null;
  const stories = Math.max(1, Number(rc?.stories) || 1);
  const footprintSf = Math.round(homeSqFt / stories);
  const imperviousRaw = Number(rc?.imperviousAreaSf);
  const imperviousKnown = rc?.imperviousAreaSf != null && Number.isFinite(imperviousRaw);
  const imperviousSf = imperviousKnown ? imperviousRaw : 0;
  const turfSf = Math.max(0, Math.round(lotSqFt - footprintSf - imperviousSf));
  return {
    turfSf,
    parts: { lotSqFt: Math.round(lotSqFt), footprintSf, imperviousSf, imperviousKnown },
  };
}

// Maps a satellite-detected structure attachment to an estimator property
// type. DETACHED / UNKNOWN return null — no attached signal, so records and AI
// search keep deciding. The returned strings are what the pricing normalizer
// (commercial-helpers normalizePropertyType) tokenizes: "Townhome" →
// townhome_end, "Interior Townhome" → townhome_interior, "Condo" → condo_*.
function propertyTypeFromAttachment(ai) {
  switch (String(ai?.structureAttachment || '').toUpperCase()) {
    case 'ATTACHED_END': return 'Townhome';
    case 'ATTACHED_INTERIOR': return 'Interior Townhome';
    case 'STACKED': return 'Condo';
    default: return null;
  }
}

// A record's propertyType is "weak" only when the WINNING source is itself
// weak: missing value, no evidence trail, or a non-specific unknown/generic
// source. A fieldVerify flag alone does NOT make it weak — mergePropertyRecords
// sets fieldVerify on mere source disagreement even when authoritative county /
// cadastral / listing / verified data won the field, and satellite must never
// override those for a (discounted) townhome/condo type (codex P1).
function recordPropertyTypeIsWeak(rc) {
  if (!rc || !rc.propertyType) return true;
  const ev = rc._fieldEvidence?.propertyType;
  if (!ev) return true;
  const sourceType = String(ev.sourceType || '').toLowerCase();
  return sourceType === '' || sourceType === 'unknown' || sourceType === 'generic';
}

// Surface a satellite-derived townhome/condo as real evidence: overwrite the
// weak value, record satellite provenance, and KEEP the field-verify nudge so
// the operator (or a tech on site, whose verify persists forever) confirms
// townhome vs single-family before it sticks. Recomputes the aggregate quality
// summary so the "unknown source" flag is replaced by the verify nudge.
function applyVisionPropertyTypeEvidence(rc, propertyType, ai) {
  if (!rc) return;
  rc.propertyType = propertyType;
  const conf = Number(ai?.confidenceScore);
  const confidence = Number.isFinite(conf) && conf >= 70 ? 'medium' : 'low';
  rc._fieldEvidence = rc._fieldEvidence || {};
  rc._fieldEvidence.propertyType = {
    value: propertyType,
    confidence,
    sourceType: 'satellite',
    sourceLabel: 'satellite imagery',
    winningSource: null,
    winningProvider: 'satellite',
    score: 50,
    disagreement: false,
    fieldVerify: true,
    evidence: [{
      field: 'propertyType',
      value: propertyType,
      provider: 'satellite',
      url: null,
      sourceType: 'satellite',
      sourceQuality: 50,
      confidence,
    }],
  };
  rc._propertyTypeSource = 'satellite';
  if (rc._raw) rc._raw._propertyTypeSource = 'satellite';
  try {
    rc._dataQuality = buildPropertyDataQuality(rc._fieldEvidence, rc._aiProviders || []);
    if (rc._raw) rc._raw._dataQuality = rc._dataQuality;
  } catch (_) { /* keep the prior quality summary on any recompute error */ }
}

// Minimum overall vision confidence before a satellite attachment read is
// allowed to CHANGE the priced property type. The estimator prices directly
// off profile.propertyType and townhome/condo is a discount, so an obstructed
// or low-confidence guess must NOT silently underprice a detached home — below
// this bar we leave the safe default (Single Family) and the weak-source
// verify flag still nudges the operator. Env-tunable; 70 mirrors the UI's HIGH
// confidence band.
const SATELLITE_TYPE_MIN_CONFIDENCE = (() => {
  const n = Number(process.env.SATELLITE_TYPE_MIN_CONFIDENCE);
  // Must be a real positive percentage. Number('') and Number('  ') are 0, so a
  // blank/whitespace env var would otherwise set the bar to 0 and silently
  // disable the guard (every read "confident") — reject 0/blank/out-of-range
  // and fall back to the 70 default.
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 70;
})();

// A satellite attachment read is trustworthy enough to reprice on only when the
// provider(s) that actually reported the winning structureAttachment value are
// at/above the confidence bar (_structureAttachmentConfidence, stamped by
// mergeAiAnalyses — NOT the blended average, which a lone low-confidence
// gap-fill could ride past) AND the vision models did not diverge on the field
// (aiDivergences). No fallback to the average: the guard is only reached when
// structureAttachment is present, and the merge always stamps the field-level
// confidence in that case, so a missing stamp means "don't reprice".
function satelliteAttachmentIsConfident(ai) {
  const conf = Number(ai?._structureAttachmentConfidence);
  if (!Number.isFinite(conf) || conf < SATELLITE_TYPE_MIN_CONFIDENCE) return false;
  return !(Array.isArray(ai?.aiDivergences)
    && ai.aiDivergences.some((d) => d && d.field === 'structureAttachment'));
}

// Surface a satellite-detected townhome/condo on a weak-typed record. Shared
// by the fresh-lookup route (called BEFORE applyParcelTurfBound so the turf cap
// — which deliberately skips townhome/condo — sees the reclassified type and
// doesn't clamp an attached unit's turf to its small parcel) and by
// buildEnrichedProfile (cache-hit + standalone callers). Idempotent: re-running
// on an already-satellite record is a no-op. Never touches commercial,
// authoritatively-typed, or low-confidence/divergent reads.
function applySatelliteAttachmentType(rc, ai) {
  if (!rc || rc._propertyTypeSource === 'satellite') return null;
  if (detectCategory(rc, ai) === 'COMMERCIAL') return null;
  const candidate = propertyTypeFromAttachment(ai);
  if (!candidate || !recordPropertyTypeIsWeak(rc)) return null;
  if (!satelliteAttachmentIsConfident(ai)) return null;
  applyVisionPropertyTypeEvidence(rc, candidate, ai);
  return candidate;
}

function buildEnrichedProfile(rc, ai, lat, lng, avm = null) {
  const footprintTurf = computeFootprintTurf(rc);
  const waterProximity = ai?.waterProximity || ai?.nearWater || 'NONE';
  const waterDistance = ai?.waterDistance || 'NONE';
  const imperviousSurfacePercent = firstNonNegativeNumber(
    ai?.imperviousSurfacePercent,
    ai?.imperviosSurfacePercent
  );
  const category = detectCategory(rc, ai);
  const commercialProfile = category === 'COMMERCIAL';
  const commercialSubtype = commercialProfile ? resolveCommercialSubtype(rc, ai) : null;

  // New-construction / weak-record fallback: surface a satellite-detected
  // townhome/condo when no authoritative source pinned the type. For fresh
  // lookups the route already applied this before the turf cap; the call here
  // is idempotent and covers cache-hit + standalone callers. The rc-null branch
  // can't carry evidence, so it only seeds the displayed type.
  const appliedVisionType = applySatelliteAttachmentType(rc, ai);
  const visionPropertyType = appliedVisionType
    || (!rc && !commercialProfile && satelliteAttachmentIsConfident(ai)
      ? propertyTypeFromAttachment(ai)
      : null);

  const profile = {
    // ── ADDRESS ──
    address: rc?.formattedAddress || '',
    lat: lat || rc?.latitude || null,
    lng: lng || rc?.longitude || null,
    county: rc?.county || '',
    zipCode: rc?.zipCode || '',

    // ── CATEGORY / TYPE ──
    category,
    propertyType: commercialProfile ? 'Commercial' : (rc?.propertyType || visionPropertyType || 'Single Family'),
    isCommercial: commercialProfile,
    commercialSubtype,
    commercialDetectionSource: commercialProfile ? resolveCommercialDetectionSource(rc, ai) : null,
    unitCount: rc?.unitCount || 1,

    // ── DIMENSIONS ──
    homeSqFt: rc?.squareFootage || 0,
    lotSqFt: rc?.lotSize || 0,
    stories: rc?.stories || 1,
    // Provenance for the `stories` value so the client can decide whether to
    // amber-nudge the estimator to eyeball the photos. 'ai' = verified public
    // record/search source; 'default' = nobody knew, we fell back to 1.
    storiesSource: rc?._storiesSource || (rc?.stories ? 'ai' : 'default'),
    footprint: rc?.squareFootage
      ? Math.round(rc.squareFootage / (rc.stories || 1))
      : 0,

    // ── CONSTRUCTION (merged property record + satellite AI) ──
    yearBuilt: rc?.yearBuilt || null,
    constructionAge: classifyAge(rc?.yearBuilt),
    constructionMaterial: mergeField(
      rc?.constructionMaterial, ai?.constructionVisible, 'UNKNOWN'
    ),
    foundationType: inferFoundation(rc, ai),
    roofType: mergeField(rc?.roofType, ai?.roofMaterial, 'UNKNOWN'),
    garageType: rc?.garageType || '',
    garageSpaces: rc?.garageSpaces || 0,
    hasAttachedGarage: detectAttachedGarage(rc),
    // County-assessed detached/waterfront structures (extra-features roll;
    // tri-state, null = roll not parsed). Evidence-only: pricing modifiers
    // are untouched — pestGarageAdj still keys on the ATTACHED-garage
    // detection; wiring detached garages or dock-confirmed water adjacency
    // into modifiers is a later, gated step.
    hasDetachedGarage: rc?.hasDetachedGarage ?? null,
    detachedGarageSqft: rc?.detachedGarageSqft || null,
    hasDock: rc?.hasDock ?? null,

    // ── POOL / LANAI ──
    // County-assessed cage sqft (extra-features roll) beats the vision guess
    // for cage size — deterministic, not inferred. Positive-only: no cage row
    // never downgrades a vision-detected cage.
    pool: mergePool(rc, ai),
    poolSource: poolSource(rc, ai),
    poolAreaSqft: rc?.poolAreaSqft || null,
    poolCageSqft: rc?.poolCageSqft || null,
    hasSpa: rc?.hasSpa === true,
    poolCage: rc?.poolCageSqft ? 'YES' : (ai?.poolCage || 'UNKNOWN'),
    poolCageSize: classifyPoolCageSize(rc?.poolCageSqft) || normalizePoolCageSize(ai?.poolCageSize, ai?.poolCage),
    poolCageSizeInferred: !rc?.poolCageSqft
      && ai?.poolCage === 'YES' && !['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED'].includes(String(ai?.poolCageSize || '').toUpperCase()),
    // County permit evidence (positive-only; _poolPermits rides the cached
    // record). A permit proves a pool/cage the annual roll hasn't caught up
    // to; absence proves nothing — open-permit layers, new-construction-only
    // coverage, unpermitted pools, and Sarasota has no permit service.
    poolPermit: rc?._poolPermits?.poolPermit || null,
    enclosurePermit: rc?._poolPermits?.enclosurePermit || null,

    // ── LANDSCAPE (from satellite AI, with property-record cross-ref) ──
    shrubDensity: ai?.shrubDensity || 'MODERATE',
    treeDensity: ai?.treeDensity || 'MODERATE',
    landscapeComplexity: ai?.landscapeComplexity || 'MODERATE',
    estimatedPalmCount: ai?.estimatedPalmCount || 0,
    estimatedTreeCount: ai?.estimatedTreeCount || 0,
    estimatedBedAreaSf: ai?.estimatedBedAreaSf,
    shadeCoveragePercent: ai?.shadeCoveragePercent || 0,

    // ── TURF ──
    imperviousSurfacePercent,
    imperviosSurfacePercent: imperviousSurfacePercent,
    estimatedTurfSf: ai?.estimatedTurfSf || 0,
    // Shadow comparison fields — see computeFootprintTurf. Not a pricing
    // input; estimatedTurfSf above remains the engine's turf source.
    footprintTurfSf: footprintTurf ? footprintTurf.turfSf : null,
    footprintTurfParts: footprintTurf ? footprintTurf.parts : null,
    turfCappedToParcel: ai?.turfCappedToParcel === true,
    _turfPreCapSf: ai?._turfPreCapSf,
    turfCondition: ai?.turfCondition || 'UNKNOWN',
    possibleGrassType: ai?.possibleGrassType || 'UNKNOWN',

    // ── PARCEL (GIS match, when available) ──
    parcel: rc?._parcel ? {
      parcelId: rc._parcel.parcelId,
      county: rc._parcel.county,
      areaSqft: rc._parcel.polygonAreaSqft || rc._parcel.lotSqft || null,
      source: 'fdor_cadastral',
    } : null,

    // ── BED MATERIAL ──
    bedMaterial: ai?.bedMaterial || 'UNKNOWN',
    mulchBeds: ai?.mulchBeds === 'YES',
    rockBeds: ai?.rockBeds === 'YES',

    // ── DRIVEWAY ──
    largeDriveway: ai?.largeDriveway === 'YES',
    drivewaySurfaceType: ai?.drivewaySurfaceType || 'UNKNOWN',

    // ── FENCING ──
    fenceType: ai?.fenceType || 'UNKNOWN',

    // ── WATER ──
    nearWater: waterProximity,
    waterProximity,
    waterDistance,
    // FEMA NFHL flood-zone evidence (cached with the record). SFHA now feeds
    // inferFoundation (its documented "properties in flood zones" exception)
    // CONSERVATIVELY: an SFHA zone downgrades an unknown foundation slab->UNKNOWN
    // to raise a field-verify flag, but UNKNOWN leaves every termite/WDO
    // modifier unchanged — no automatic pricing movement until a tech confirms.
    floodZone: rc?._floodZone?.floodZone || null,
    floodZoneSubtype: rc?._floodZone?.floodZoneSubtype || null,
    inSpecialFloodHazardArea: rc?._floodZone?.sfha ?? null,

    // ── ENVIRONMENT ──
    woodedAdjacency: ai?.woodedAdjacency || 'NONE',
    irrigationVisible: ai?.irrigationVisible === 'YES',
    vegetationOnStructure: ai?.vegetationOnStructure || 'NONE',
    outbuildingCount: ai?.outbuildingCount || 0,
    maintenanceCondition: ai?.maintenanceCondition || 'UNKNOWN',

    // ── PEST PRESSURE ──
    overallPestPressure: ai?.overallPestPressureEstimate || 'MODERATE',
    pestPressureFactors: ai?.pestPressureFactors || [],

    // ── OWNER / SALE ──
    ownerType: rc?.ownerType || null,
    isRental: rc?.ownerType === 'Organization',
    lastSaleDate: rc?.lastSaleDate || null,
    lastSalePrice: rc?.lastSalePrice || null,
    isNewHomeowner: isRecentPurchase(rc?.lastSaleDate, 6),
    yearsOwned: yearsFromDate(rc?.lastSaleDate),

    // ── AVM (deprecated; no valuation provider in the AI-search path) ──
    estimatedValue: avm?.price || null,
    estimatedValueLow: avm?.priceRangeLow || null,
    estimatedValueHigh: avm?.priceRangeHigh || null,
    avmComparables: avm?.comparables || 0,

    // ── HOA ──
    hoaFee: rc?.hoaFee || null,
    isHOA: !!(rc?.hoaFee && rc.hoaFee > 0),

    // ── TAX (landscaping investment proxy) ──
    taxImprovementValue: extractLatestTax(rc?.taxAssessments, 'improvement'),
    taxLandValue: extractLatestTax(rc?.taxAssessments, 'land'),
    improvementToLandRatio: calcImprovementRatio(rc?.taxAssessments),

    // ── SERVICE ZONE ──
    serviceZone: detectServiceZone(lat, lng),

    // ── PRICING MODIFIERS (pre-computed) ──
    modifiers: {
      // Pest: yearBuilt modifier
      pestAgeAdj: calcPestAgeModifier(rc?.yearBuilt),
      // Pest: construction material modifier
      pestConstructionAdj: calcConstructionModifier(
        mergeField(rc?.constructionMaterial, ai?.constructionVisible, 'UNKNOWN')
      ),
      // Pest: attached garage modifier
      pestGarageAdj: detectAttachedGarage(rc) ? 8 : 0,
      // Pest: tile roof modifier (rodent risk)
      rodentRoofAdj: calcRoofRodentModifier(
        mergeField(rc?.roofType, ai?.roofMaterial, 'UNKNOWN')
      ),
      // Termite: construction vulnerability
      termiteConstructionMult: calcTermiteConstructionMult(
        mergeField(rc?.constructionMaterial, ai?.constructionVisible, 'UNKNOWN')
      ),
      // Termite: foundation modifier
      termiteFoundationAdj: calcFoundationTermiteAdj(inferFoundation(rc, ai)),
      // WDO: inspection time modifier
      wdoTimeMult: calcWDOTimeMult(
        mergeField(rc?.constructionMaterial, ai?.constructionVisible, 'UNKNOWN'),
        inferFoundation(rc, ai)
      ),
      // Mosquito: water proximity severity
      mosquitoWaterMult: calcMosquitoWaterMult(
        waterProximity,
        waterDistance
      ),
      // Lawn: impervious surface correction
      turfCorrectionFactor: imperviousSurfacePercent !== undefined
        ? (100 - imperviousSurfacePercent) / 100
        : 0.80,
      // Overall pest pressure multiplier
      pestPressureMult: calcPestPressureMult(ai?.overallPestPressureEstimate),
    },

    // ── CONFIDENCE ──
    aiConfidence: ai?.confidenceScore || 0,
    propertyDataQuality: rc?._dataQuality || buildFallbackPropertyDataQuality(rc),
    fieldEvidence: rc?._fieldEvidence || {},
    propertySources: rc?._aiSources || [],
    propertyProviders: rc?._aiProviders || [],
    analysisNotes: ai?.analysisNotes || '',
    fieldVerifyFlags: buildFieldVerifyFlags(rc, ai),

    // ── DATA SOURCE TRACKING ──
    dataSources: {
      propertyRecord: !!rc,
      rentcast: !!rc,
      satellite: !!(ai),
      aiAnalysis: !!(ai?.confidenceScore),
      fieldEvidence: !!(rc?._fieldEvidence && Object.keys(rc._fieldEvidence).length),
    }
  };

  // Shadow signal for the footprint-turf rollout decision: how far the
  // vision estimate sits from the deterministic county-facts ceiling.
  // Coarse fields only (no address/parcel values — PII rule).
  if (footprintTurf && !commercialProfile && profile.estimatedTurfSf > 0) {
    const deltaPct = Math.round(
      ((profile.estimatedTurfSf - footprintTurf.turfSf) / Math.max(footprintTurf.turfSf, 1)) * 1000,
    ) / 10;
    logger.info('[turf-footprint] shadow comparison', {
      footprintTurfSf: footprintTurf.turfSf,
      estimatedTurfSf: profile.estimatedTurfSf,
      deltaPct,
      imperviousKnown: footprintTurf.parts.imperviousKnown,
      county: profile.county || null,
    });
  }

  return profile;
}

function buildProviderStatus() {
  return {
    propertySearch: {
      claude: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
    },
    satelliteVision: {
      claude: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
    },
    maps: !!(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY),
  };
}

const FALLBACK_CRITICAL_FIELDS = ['squareFootage', 'lotSize', 'stories', 'propertyType'];

function buildFallbackPropertyDataQuality(rc) {
  if (!rc) {
    return {
      level: 'low',
      score: 0,
      providerCount: 0,
      providers: [],
      sourceTypes: [],
      verifiedCriticalFields: 0,
      totalCriticalFields: 4,
      fieldVerifyCount: 4,
      // Mirror buildPropertyDataQuality so consumers (the property panel's
      // "Missing" badges, the provisional-estimate guard) get the same shape on
      // the fallback path — without it a fallback lookup looks like nothing is
      // missing and a thin quote skips the provisional warning.
      missingCriticalFields: [...FALLBACK_CRITICAL_FIELDS],
    };
  }
  const missingCriticalFields = FALLBACK_CRITICAL_FIELDS.filter((f) => !rc[f]);
  const critical = FALLBACK_CRITICAL_FIELDS.length - missingCriticalFields.length;
  return {
    level: critical >= 3 ? 'medium' : 'low',
    score: critical >= 3 ? 60 : 35,
    providerCount: rc._aiProviders?.length || 1,
    providers: rc._aiProviders || [rc._provider || rc._source || 'property'],
    sourceTypes: rc._aiSourceTypes || [],
    verifiedCriticalFields: critical,
    totalCriticalFields: 4,
    fieldVerifyCount: missingCriticalFields.length,
    missingCriticalFields,
  };
}


// ─────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────

function firstNonNegativeNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function normalizeCommercialFlag(value) {
  if (value === true) return true;
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'true' || raw === 'yes' || raw === 'commercial';
}

function hasExplicitCommercialFalse(value) {
  if (value === false) return true;
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'false' || raw === 'no' || raw === 'residential';
}

const RESIDENTIAL_PROFILE_PROPERTY_TYPES = new Set([
  'single_family',
  'townhome_end',
  'townhome_interior',
  'duplex',
  'condo_ground',
  'condo_upper',
]);

function isCommercialProfile(profile = {}, options = {}) {
  const profilePropertyType = normalizePricingPropertyType(profile.propertyType);
  const optionPropertyType = normalizePricingPropertyType(options.propertyType);
  const hasCommercialSubtype = !!profile.commercialSubtype || !!options.commercialSubtype;
  const hasExplicitCommercialTrueWithoutSubtype =
    normalizeCommercialFlag(profile.isCommercial) ||
    normalizeCommercialFlag(options.isCommercial) ||
    profilePropertyType === 'commercial' ||
    optionPropertyType === 'commercial';
  const hasConcreteResidentialType =
    RESIDENTIAL_PROFILE_PROPERTY_TYPES.has(profilePropertyType) ||
    RESIDENTIAL_PROFILE_PROPERTY_TYPES.has(optionPropertyType);
  if (!hasExplicitCommercialTrueWithoutSubtype && hasConcreteResidentialType) return false;

  const hasResidentialOverride = (
    hasExplicitCommercialFalse(options.isCommercial) ||
    hasExplicitCommercialFalse(profile.isCommercial)
  ) && !hasExplicitCommercialTrueWithoutSubtype;

  if (hasResidentialOverride) return false;

  return hasExplicitCommercialTrueWithoutSubtype ||
    hasCommercialSubtype ||
    normalizePricingPropertyType(profile.category) === 'commercial' ||
    normalizePricingPropertyType(options.category) === 'commercial';
}

function selectedTurfPricedServices(selectedServices = []) {
  return (selectedServices || [])
    .map((service) => String(service || '').toUpperCase())
    .filter((service) => TURF_PRICED_SERVICES.has(service));
}

// The parcel-derived hard ceiling for treatable turf: GIS polygon area when
// the parcel matched, else the merged lot size when it came from
// county-grade evidence (a listing's lot guess is not a bound).
function parcelTurfBoundSqft(propertyRecord) {
  if (!propertyRecord) return null;
  const polygonArea = firstNonNegativeNumber(propertyRecord._parcel?.polygonAreaSqft, propertyRecord._parcel?.lotSqft);
  if (polygonArea) return { areaSqft: polygonArea, source: 'parcel_polygon' };
  const lotEvidence = propertyRecord._fieldEvidence?.lotSize;
  const lotSize = firstNonNegativeNumber(propertyRecord.lotSize);
  if (lotSize && ['county', 'cadastral'].includes(lotEvidence?.sourceType)) {
    return { areaSqft: lotSize, source: lotEvidence.sourceType };
  }
  return null;
}

// Deterministic turf bound: treatable turf can never exceed the parcel.
// Residential non-condo only — condo/HOA service legitimately treats shared
// turf beyond the unit's own parcel. Mutates the merged aiAnalysis in place
// (pre-cap value kept for provenance; turfRiskReasons surfaces the clamp so
// the field-verify flag still fires even though the value is now bounded).
function applyParcelTurfBound(aiAnalysis, propertyRecord) {
  if (!aiAnalysis || !propertyRecord) return aiAnalysis;

  const propertyUse = String(aiAnalysis.propertyUse || '').toUpperCase();
  if (propertyUse && !['RESIDENTIAL', 'UNKNOWN'].includes(propertyUse)) return aiAnalysis;
  // A structured commercial subtype (HOA_COMMON_AREA etc.) marks the profile
  // commercial downstream even when propertyUse stayed RESIDENTIAL/UNKNOWN —
  // mirror that signal here so shared turf is never pre-clamped to one
  // parcel before the commercial path takes over.
  const commercialUseType = String(aiAnalysis.commercialUseType || '').toUpperCase();
  if (commercialUseType
      && !['NONE', 'UNKNOWN', 'RESIDENTIAL', 'NO', 'FALSE', 'N/A', 'NA', 'NOT_COMMERCIAL', 'NON_COMMERCIAL'].includes(commercialUseType)) {
    return aiAnalysis;
  }
  const propertyType = String(propertyRecord.propertyType || '').toUpperCase();
  if (/CONDO|HOA|APARTMENT|MULTIFAMILY|TOWNHOME|TOWNHOUSE/.test(propertyType)) return aiAnalysis;

  const bound = parcelTurfBoundSqft(propertyRecord);
  if (!bound) return aiAnalysis;

  const estimatedTurfSf = firstNonNegativeNumber(aiAnalysis.estimatedTurfSf);
  if (estimatedTurfSf === undefined || estimatedTurfSf <= bound.areaSqft) return aiAnalysis;

  aiAnalysis._turfPreCapSf = estimatedTurfSf;
  aiAnalysis.estimatedTurfSf = Math.round(bound.areaSqft);
  aiAnalysis.turfCappedToParcel = true;
  aiAnalysis.turfCapSource = bound.source;
  const note = `AI turf estimate ${Math.round(estimatedTurfSf).toLocaleString()} sq ft exceeded the ${Math.round(bound.areaSqft).toLocaleString()} sq ft parcel area — clamped to the parcel.`;
  aiAnalysis.analysisNotes = [aiAnalysis.analysisNotes, note].filter(Boolean).join(' ');
  logger.info('[property-lookup] turf estimate clamped to parcel area', {
    preCapSf: estimatedTurfSf,
    parcelAreaSqft: Math.round(bound.areaSqft),
    source: bound.source,
  });
  return aiAnalysis;
}

function turfRiskReasons(source = {}) {
  const reasons = [];
  const lotSqFt = firstNonNegativeNumber(source.lotSqFt, source.lotSize);
  const estimatedTurfSf = firstNonNegativeNumber(source.estimatedTurfSf, source.estimatedTurfSqFt);
  if (source.turfCappedToParcel === true) {
    const preCap = firstNonNegativeNumber(source._turfPreCapSf);
    reasons.push(`AI turf exceeded parcel area — clamped to ${estimatedTurfSf !== undefined ? Math.round(estimatedTurfSf).toLocaleString() : 'parcel'} sq ft${preCap !== undefined ? ` (AI estimated ${Math.round(preCap).toLocaleString()})` : ''}`);
  }
  const aiConfidence = firstNonNegativeNumber(source.aiConfidence, source.confidenceScore);
  const treeDensity = String(source.treeDensity || '').toUpperCase();
  const nearWater = String(source.nearWater || source.waterProximity || '').toUpperCase();
  const shadeCoveragePercent = firstNonNegativeNumber(source.shadeCoveragePercent);

  if (lotSqFt && estimatedTurfSf && estimatedTurfSf / lotSqFt >= TURF_HIGH_LOT_RATIO) {
    reasons.push(`estimated turf is ${Math.round((estimatedTurfSf / lotSqFt) * 100)}% of lot`);
  }
  if (aiConfidence !== undefined && aiConfidence < 60) reasons.push(`AI confidence ${aiConfidence}%`);
  if (treeDensity === 'HEAVY') reasons.push('heavy tree canopy');
  if (shadeCoveragePercent !== undefined && shadeCoveragePercent >= 35) reasons.push(`${shadeCoveragePercent}% shade coverage`);
  if (nearWater && nearWater !== 'NONE' && nearWater !== 'NO') reasons.push('water adjacency');
  return reasons;
}

function needsTurfManualConfirmation(profile = {}, selectedServices = [], options = {}) {
  let turfServices = selectedTurfPricedServices(selectedServices);
  if (isCommercialProfile(profile, options)) {
    // Commercial turf services are manual quote in PR 1; do not block them
    // with residential lawn pricing measurement confirmation.
    turfServices = turfServices.filter((service) => ![
      'LAWN',
      'OT_LAWN',
      'TOPDRESS',
      'DETHATCH',
      'PLUGGING',
    ].includes(service));
  }
  if (turfServices.length === 0) return null;
  const manualTurfSf = firstNonNegativeNumber(profile.measuredTurfSf, profile.lawnSqFt);
  if (manualTurfSf !== undefined) return null;
  // Services whose treated area is entered directly (front/back-yard scope)
  // don't need whole-lawn turf confirmation when an explicit area is given.
  // Exempt only when EVERY selected turf service is such a bounded add-on, so a
  // Top Dressing + Plugging combo (each with its own area) clears together,
  // while any whole-lawn service (LAWN/OT_LAWN/DETHATCH) still requires it.
  const plugArea = firstNonNegativeNumber(options.plugArea);
  const topDressArea = firstNonNegativeNumber(options.topDressArea);
  const areaBoundedExempt = {
    PLUGGING: plugArea > 0,
    TOPDRESS: topDressArea > 0,
  };
  if (turfServices.every((service) => areaBoundedExempt[service])) return null;

  const estimatedTurfSf = firstNonNegativeNumber(profile.estimatedTurfSf, profile.estimatedTurfSqFt);
  if (estimatedTurfSf === undefined || estimatedTurfSf <= TURF_MANUAL_CONFIRMATION_SQFT) return null;

  return {
    field: 'measuredTurfSf',
    threshold: TURF_MANUAL_CONFIRMATION_SQFT,
    estimatedTurfSf,
    reasons: turfRiskReasons(profile),
    message: `AI estimated ${Math.round(estimatedTurfSf).toLocaleString()} sq ft of treatable turf. Confirm treatable lawn area before generating lawn pricing above ${TURF_MANUAL_CONFIRMATION_SQFT.toLocaleString()} sq ft.`,
  };
}

function commercialSignalText(rc = {}, ai = {}) {
  const structuredAiSignals = [];
  const propertyUse = String(ai?.propertyUse || '').trim().toUpperCase();
  const commercialUseType = String(ai?.commercialUseType || '').trim().toUpperCase();
  const nonCommercialUseTypes = ['NONE', 'UNKNOWN', 'RESIDENTIAL', 'NO', 'FALSE', 'N/A', 'NA', 'NOT_COMMERCIAL', 'NON_COMMERCIAL'];
  if (['COMMERCIAL', 'MIXED'].includes(propertyUse)) {
    structuredAiSignals.push(ai.propertyUse);
  }
  if (
    commercialUseType &&
    !nonCommercialUseTypes.includes(commercialUseType)
  ) {
    structuredAiSignals.push(ai.commercialUseType);
  }

  return [
    rc?.propertyType,
    rc?.zoning,
    rc?._raw?.zoning,
    rc?._raw?.landUse,
    rc?._raw?.propertyUse,
    rc?._raw?.propertyType,
    ...structuredAiSignals,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function hasStructuredCommercialAiSignal(ai = {}) {
  const propertyUse = String(ai?.propertyUse || '').trim().toUpperCase();
  const commercialUseType = String(ai?.commercialUseType || '').trim().toUpperCase();
  const nonCommercialUseTypes = ['NONE', 'UNKNOWN', 'RESIDENTIAL', 'NO', 'FALSE', 'N/A', 'NA', 'NOT_COMMERCIAL', 'NON_COMMERCIAL'];
  if (['COMMERCIAL', 'MIXED'].includes(propertyUse)) return true;
  if (!commercialUseType || nonCommercialUseTypes.includes(commercialUseType)) {
    return false;
  }
  return commercialUseType === 'OTHER' || normalizePricingPropertyType(commercialUseType) === 'commercial';
}

function detectCategory(rc, ai = {}) {
  if (!rc && !ai) return 'RESIDENTIAL';
  const text = commercialSignalText(rc, ai);
  if (/(commercial|office|retail|industrial|warehouse|restaurant|food\s*service|medical|clinic|school|daycare|business|plaza|storefront|shop|government|municipal)/.test(text)) return 'COMMERCIAL';
  if (/(apartment|apartments|multi\s*family|multifamily|hoa\s*common|common\s*area)/.test(text)) return 'COMMERCIAL';
  if (hasStructuredCommercialAiSignal(ai)) return 'COMMERCIAL';
  if (rc?.unitCount && rc.unitCount > 4)
    return 'COMMERCIAL';
  return 'RESIDENTIAL';
}

function hasCommercialSignalText(rc = {}, ai = {}) {
  return detectCategory(
    { propertyType: '', unitCount: 1, ...rc },
    { ...ai, propertyUse: ai?.propertyUse || 'UNKNOWN' }
  ) === 'COMMERCIAL';
}

function resolveCommercialSubtype(rc = {}, ai = {}) {
  const text = commercialSignalText(rc, ai);
  if (/warehouse|light\s*industrial/.test(text)) return 'warehouse_light';
  if (/restaurant|food\s*service|commercial\s*kitchen/.test(text)) return 'restaurant_food_service';
  if (/medical|clinic/.test(text)) return 'medical_office';
  if (/school|daycare/.test(text)) return 'school_daycare';
  if (/government|municipal/.test(text)) return 'government_municipal';
  if (/industrial/.test(text)) return 'industrial';
  if (/apartment|apartments|multi\s*family|multifamily/.test(text)) return 'multifamily_common_area_residential';
  if (/business\s*park|commercial\s*hoa/.test(text)) return 'hoa_common_area_commercial';
  if (/hoa|condo\s*association|common\s*area/.test(text)) return 'hoa_common_area_residential';
  if (/office|retail|storefront|shop|plaza|business|commercial/.test(text)) return 'office_retail';
  return 'other';
}

function resolveCommercialDetectionSource(rc = {}, ai = {}) {
  if (rc?.propertyType && normalizePricingPropertyType(rc.propertyType) === 'commercial') return 'property_record_property_type';
  if (rc?.unitCount && rc.unitCount > 4) return 'property_record_unit_count';
  if (hasCommercialSignalText(rc, {})) return 'property_record_commercial_signal';
  if (hasStructuredCommercialAiSignal(ai)) return 'satellite_ai_property_use';
  return 'commercial_signal';
}

function classifyAge(yearBuilt) {
  if (!yearBuilt) return 'UNKNOWN';
  if (yearBuilt < 1970) return 'PRE_1970';
  if (yearBuilt < 1985) return 'PRE_1985';
  if (yearBuilt < 1995) return 'PRE_1995';
  if (yearBuilt < 2005) return 'PRE_2005';
  if (yearBuilt < 2015) return 'PRE_2015';
  return 'MODERN';
}

function mergeField(rcValue, aiValue, fallback) {
  // Property records take priority if they have data; satellite AI fills gaps.
  if (rcValue && rcValue !== 'UNKNOWN') return rcValue;
  if (aiValue && aiValue !== 'UNKNOWN') return aiValue;
  return fallback;
}

function mergePool(rc, ai) {
  // A tech-verified pool answer beats records AND vision — a verified NO
  // means the pool the satellite sees is the neighbor's.
  if (rc?._fieldEvidence?.hasPool?.sourceType === 'verified') return rc.hasPool ? 'YES' : 'NO';
  // Property-record YES is authoritative. Satellite AI can upgrade but not downgrade.
  if (rc?.hasPool) return 'YES';
  if (ai?.pool === 'YES') return 'POSSIBLE'; // AI sees pool but RC doesn't — could be neighbor
  if (ai?.pool === 'POSSIBLE') return 'POSSIBLE';
  return 'NO';
}

// Provenance of the merged pool answer, for the estimator UI.
function poolSource(rc, ai) {
  if (rc?._fieldEvidence?.hasPool?.sourceType === 'verified') return 'verified';
  if (rc?.hasPool === true) return 'county';
  if (ai?.pool === 'YES' || ai?.pool === 'POSSIBLE') return 'vision';
  return rc?.hasPool === false ? 'county' : null;
}

// Pool line for the vision prompts. hasPool is tri-state: county parsers set
// true/false from the assessed extra-features roll; null means no county
// signal — telling the models "NO" there (the old behavior, when hasPool was
// hard-coded false) actively biased them against detecting real pools.
function poolRecordContext(propertyRecord) {
  if (propertyRecord?.hasPool === true) {
    const details = [
      propertyRecord.poolAreaSqft ? `${propertyRecord.poolAreaSqft} sq ft pool` : 'pool',
      propertyRecord.poolCageSqft ? `${propertyRecord.poolCageSqft} sq ft screen cage` : null,
      propertyRecord.hasSpa ? 'spa' : null,
    ].filter(Boolean).join(', ');
    return `YES (county-assessed: ${details})`;
  }
  if (propertyRecord?.hasPool === false) return 'NO (county roll shows no pool)';
  return 'UNKNOWN';
}

// County-assessed screen cage beats the vision guess for cage size — the
// sqft is on the tax roll, so the classification becomes deterministic.
// Positive-only: no cage row never downgrades a vision-detected cage
// (attached lanais are sometimes rolled into the building areas).
function classifyPoolCageSize(sqft) {
  if (!Number.isFinite(sqft) || sqft <= 0) return null;
  if (sqft < 300) return 'SMALL';
  if (sqft <= 600) return 'MEDIUM';
  if (sqft <= 900) return 'LARGE';
  return 'OVERSIZED';
}


function normalizePoolCageSize(value, poolCage) {
  const raw = String(value || '').toUpperCase();
  if (['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED'].includes(raw)) return raw;
  return poolCage === 'YES' ? 'MEDIUM' : 'NONE';
}

function inferFoundation(rc, ai) {
  // Direct from property-record features.
  if (rc?.foundationType && rc.foundationType !== 'UNKNOWN') return rc.foundationType;

  // SWFL heuristics: almost everything is slab-on-grade
  // Exceptions: coastal properties pre-1985, properties in flood zones
  if (rc?.yearBuilt) {
    // Very old homes near coast sometimes have raised foundations
    if (rc.yearBuilt < 1960) return 'UNKNOWN'; // could be raised — field verify
  }

  // FEMA special-flood-hazard-area homes (A/AE/V/VE) are built to base flood
  // elevation and are frequently elevated (stem-wall/pilings) rather than
  // slab. Don't auto-assume slab — downgrade to UNKNOWN so the field-verify
  // flag fires. Conservative by design: UNKNOWN keeps calcFoundationTermiteAdj
  // at $0 and calcWDOTimeMult at 1.0 (same as SLAB), so NO pricing modifier
  // moves until a tech confirms the foundation on site.
  if (rc?._floodZone?.sfha === true) return 'UNKNOWN';

  // Default SWFL assumption
  return 'SLAB';
}

function detectAttachedGarage(rc) {
  if (!rc?.garageType) return false;
  const g = rc.garageType.toUpperCase();
  return g.includes('ATTACHED') || g.includes('BUILT-IN') || g.includes('INTEGRAL');
}

function isRecentPurchase(dateStr, monthsThreshold) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  return months <= monthsThreshold;
}

function yearsFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Math.round((Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000) * 10) / 10;
}

function extractLatestTax(assessments, field) {
  if (!assessments || typeof assessments !== 'object') return null;
  // Tax assessments are keyed by year: { "2024": { land: X, improvement: Y, total: Z } }
  const years = Object.keys(assessments).sort().reverse();
  if (years.length === 0) return null;
  const latest = assessments[years[0]];
  if (field === 'improvement') return latest?.improvement || latest?.improvementValue || null;
  if (field === 'land') return latest?.land || latest?.landValue || null;
  return latest?.total || latest?.totalValue || null;
}

function calcImprovementRatio(assessments) {
  const imp = extractLatestTax(assessments, 'improvement');
  const land = extractLatestTax(assessments, 'land');
  if (!imp || !land || land === 0) return null;
  return Math.round((imp / land) * 100) / 100;
}

function detectServiceZone(lat, lng) {
  if (!lat || !lng) return 'UNKNOWN';
  // Zone A: Bradenton / Sarasota core (lowest drive time)
  // Zone B: Lakewood Ranch, Parrish, Venice (moderate drive)
  // Zone C: North Port, Port Charlotte, outer Parrish (long drive)

  // Rough bounding boxes based on SWFL geography
  // Bradenton core: ~27.45-27.55, -82.55 to -82.50
  // Sarasota core: ~27.30-27.40, -82.55 to -82.50
  // Lakewood Ranch: ~27.35-27.45, -82.40 to -82.30
  // Venice: ~27.05-27.15, -82.45 to -82.35
  // North Port: ~27.00-27.10, -82.25 to -82.10
  // Port Charlotte: ~26.95-27.05, -82.15 to -82.00

  if (lat >= 27.25 && lat <= 27.60 && lng >= -82.65 && lng <= -82.35) return 'A'; // Core
  if (lat >= 27.05 && lat <= 27.60 && lng >= -82.65 && lng <= -82.15) return 'B'; // Extended
  return 'C'; // Outer
}


// ─────────────────────────────────────────────
// PRICING MODIFIER CALCULATIONS
// ─────────────────────────────────────────────

/**
 * Pest control: year built modifier
 * Older homes = more entry points, more pest harborage
 * Returns dollar adjustment to per-application price
 */
function calcPestAgeModifier(yearBuilt) {
  if (!yearBuilt) return 0;
  if (yearBuilt < 1970) return 20;   // Pre-1970: significant gaps, old construction
  if (yearBuilt < 1985) return 15;   // Pre-1985: aging seals, original windows
  if (yearBuilt < 1995) return 10;   // Pre-1995: decent but aging
  if (yearBuilt < 2005) return 5;    // Pre-2005: starting to show wear
  return 0;                           // 2005+: modern construction, tight seals
}

/**
 * Pest control: construction material modifier
 * Wood frame = more entry points, more harborage
 * Returns dollar adjustment to per-application price
 */
function calcConstructionModifier(material) {
  switch (material) {
    case 'WOOD_FRAME': return 12;  // More pest entry, more treatment time
    case 'CBS': return 0;          // Standard SWFL, baseline
    case 'BRICK': return -3;       // Slightly better sealed
    case 'METAL': return -5;       // Commercial, fewer entry points
    default: return 0;
  }
}

/**
 * Rodent: roof type modifier
 * Tile roofs = major roof rat harborage
 * Returns dollar adjustment to rodent service pricing
 */
function calcRoofRodentModifier(roofType) {
  switch (roofType) {
    case 'TILE': return 15;     // Barrel tile = rat highway
    case 'SHINGLE': return 0;   // Standard
    case 'METAL': return -5;    // Hard to nest in
    case 'FLAT': return -3;     // Commercial, less harborage
    default: return 0;
  }
}

/**
 * Termite: construction vulnerability multiplier
 * Wood frame is dramatically more termite-susceptible
 * Returns multiplier on termite service pricing (1.0 = baseline)
 */
function calcTermiteConstructionMult(material) {
  switch (material) {
    case 'WOOD_FRAME': return 1.25;  // 25% more — higher risk, more treatment area
    case 'CBS': return 1.0;          // Standard SWFL baseline
    case 'BRICK': return 0.95;       // Slightly less susceptible
    case 'METAL': return 0.85;       // Minimal wood components
    default: return 1.0;
  }
}

/**
 * Termite: foundation modifier
 * Crawlspace/raised = different treatment approach, more labor
 * Returns dollar adjustment to trenching and bait station pricing
 */
function calcFoundationTermiteAdj(foundation) {
  switch (foundation) {
    case 'CRAWLSPACE': return 150;   // Can't standard trench, need crawlspace treatment
    case 'RAISED': return 200;       // Pier/piling, need different approach entirely
    case 'SLAB': return 0;           // Standard SWFL
    case 'BASEMENT': return 100;     // Uncommon in SWFL but possible
    default: return 0;
  }
}

/**
 * WDO inspection: time multiplier
 * Wood frame + crawlspace = significantly longer inspection
 * Returns multiplier on base WDO price (1.0 = baseline)
 */
function calcWDOTimeMult(material, foundation) {
  let mult = 1.0;
  if (material === 'WOOD_FRAME') mult += 0.20;     // More areas to inspect
  if (foundation === 'CRAWLSPACE') mult += 0.30;   // Crawlspace adds 30% time
  if (foundation === 'RAISED') mult += 0.25;        // Under-building inspection
  return Math.round(mult * 100) / 100;
}

/**
 * Mosquito: water proximity multiplier
 * Replaces the binary near-water flag with graduated severity
 * Returns multiplier on mosquito base pricing (1.0 = baseline)
 */
function calcMosquitoWaterMult(waterType, waterDistance) {
  let mult = 1.0;
  // Water type severity
  switch (waterType) {
    case 'POND_ON_PROPERTY': mult = 1.75; break;     // Standing water on property
    case 'WETLAND_ADJACENT': mult = 1.60; break;      // Marshy/wetland next door
    case 'CANAL_ADJACENT': mult = 1.40; break;         // Canal running along property
    case 'LAKE_ADJACENT': mult = 1.30; break;          // Lake nearby (less breeding)
    case 'RETENTION_NEARBY': mult = 1.25; break;       // Retention pond in neighborhood
    default: mult = 1.0;
  }
  // Distance attenuation (if water type is set but farther away)
  if (waterDistance === 'WITHIN_500FT' && mult > 1.0) mult = 1.0 + (mult - 1.0) * 0.5;
  if (waterDistance === 'WITHIN_200FT' && mult > 1.0) mult = 1.0 + (mult - 1.0) * 0.75;
  // ON_PROPERTY and ADJACENT use full multiplier

  return Math.round(mult * 100) / 100;
}

/**
 * Overall pest pressure multiplier
 * Applied as a secondary adjustment after individual modifiers
 */
function calcPestPressureMult(pressure) {
  switch (pressure) {
    case 'LOW': return 0.90;
    case 'MODERATE': return 1.0;
    case 'HIGH': return 1.10;
    case 'VERY_HIGH': return 1.20;
    default: return 1.0;
  }
}


// ─────────────────────────────────────────────
// FIELD VERIFY FLAGS
// ─────────────────────────────────────────────
function buildFieldVerifyFlags(rc, ai) {
  const flags = [];

  // Foundation unknown on older homes, or in a FEMA flood zone where slab is
  // an unsafe default. else-if keeps this to a SINGLE foundationType flag
  // (two would double-count in the win/loss byFlagField slice); the pre-1970
  // reason wins when both apply. The CRAWLSPACE/RAISED check further down only
  // fires when county data is authoritative, so it never overlaps these.
  const foundationUnverified = !rc?.foundationType || rc.foundationType === 'UNKNOWN';
  if (rc?.yearBuilt && rc.yearBuilt < 1970 && foundationUnverified) {
    flags.push({
      field: 'foundationType',
      reason: 'Pre-1970 home — foundation type not in records, could be raised/crawlspace',
      priority: 'HIGH'
    });
  } else if (rc?._floodZone?.sfha === true && foundationUnverified) {
    flags.push({
      field: 'foundationType',
      reason: `FEMA flood zone ${rc._floodZone.floodZone || 'SFHA'} — homes in special flood hazard areas are often elevated (stem-wall/pilings), not slab; verify foundation before termite/WDO`,
      priority: 'HIGH'
    });
  }

  // Construction material unknown
  if (!rc?.constructionMaterial || rc.constructionMaterial === 'UNKNOWN') {
    if (!ai?.constructionVisible || ai.constructionVisible === 'UNKNOWN') {
      flags.push({
        field: 'constructionMaterial',
        reason: 'Construction material not identified by property search or satellite',
        priority: 'MEDIUM'
      });
    }
  }

  if (rc && !rc.lotSize && !/condo|apartment|multifamily|hoa common/i.test(String(rc.propertyType || ''))) {
    flags.push({
      field: 'lotSize',
      reason: 'Lot size missing from property sources — verify parcel/lot square footage before lawn, mosquito, or rodent pricing',
      priority: 'HIGH',
    });
  }

  // Satellite AI pool signal without record confirmation — fires both when
  // the county roll says no pool (new pool vs neighbor's) and when there is
  // no county signal at all (hasPool null). Suppressed when a tech already
  // verified the answer on site (the AI's pool is the neighbor's).
  if (rc && rc.hasPool !== true && ai?.pool === 'YES'
      && rc?._fieldEvidence?.hasPool?.sourceType !== 'verified') {
    flags.push({
      field: 'pool',
      reason: 'AI detected possible pool not in property records — verify (may be neighbor)',
      priority: 'MEDIUM'
    });
  }

  // No property-record data at all. If AI search found facts, use a
  // lower-priority "verify on site" nudge rather than a "we know nothing"
  // alarm. Genuine "nothing at all" — no rc object — still HIGH.
  if (!rc) {
    flags.push({
      field: 'all',
      reason: 'No property record data — all property dimensions are estimated',
      priority: 'HIGH'
    });
  } else if (rc._source === 'ai') {
    flags.push({
      field: 'all',
      reason: `Property data sourced from AI web search${rc._aiSourceUrl ? ` — primary source: ${rc._aiSourceUrl}` : ''} — verify key dimensions on site`,
      priority: 'MEDIUM',
    });
  }

  if (rc?._dataQuality?.level === 'low') {
    flags.push({
      field: 'propertyDataQuality',
      reason: `Property data quality is low (${rc._dataQuality.score || 0}/100) — verify square footage, lot size, and stories before final pricing`,
      priority: 'HIGH',
    });
  } else if (rc?._dataQuality?.fieldVerifyCount > 0) {
    flags.push({
      field: 'propertyDataQuality',
      reason: `${rc._dataQuality.fieldVerifyCount} property field(s) have weak or conflicting source evidence`,
      priority: 'MEDIUM',
    });
  }

  for (const [field, evidence] of Object.entries(rc?._fieldEvidence || {})) {
    if (!evidence?.fieldVerify) continue;
    let reason;
    if (field === 'propertyType' && evidence.sourceType === 'satellite') {
      const attach = String(ai?.structureAttachment || '').toUpperCase();
      const detail = attach === 'ATTACHED_INTERIOR' ? 'interior row unit, two shared walls'
        : attach === 'ATTACHED_END' ? 'end unit, one shared wall'
        : attach === 'STACKED' ? 'stacked/condo building'
        : 'an attached structure';
      reason = `Satellite imagery suggests ${rc.propertyType} (${detail}) — confirm townhome vs single-family before pricing`;
    } else if (evidence.disagreement) {
      reason = `${field} has conflicting AI/source evidence — verify before pricing`;
    } else {
      reason = `${field} came from ${evidence.sourceLabel || 'a weak source'} with ${evidence.confidence || 'low'} confidence`;
    }
    flags.push({
      field,
      reason,
      priority: ['squareFootage', 'lotSize', 'stories'].includes(field) ? 'HIGH' : 'MEDIUM',
    });
  }

  // Footprint estimated from lot
  if (rc && !rc.squareFootage && rc.lotSize) {
    flags.push({
      field: 'homeSqFt',
      reason: 'Home sq ft missing from records — estimated from lot size',
      priority: 'HIGH'
    });
  }

  // Year built missing (affects pest/termite modifiers)
  if (!rc?.yearBuilt) {
    flags.push({
      field: 'yearBuilt',
      reason: 'Year built not in records — age-based pricing modifiers not applied',
      priority: 'MEDIUM'
    });
  }

  // HOA detected — may have service restrictions
  if (rc?.hoaFee && rc.hoaFee > 0) {
    flags.push({
      field: 'hoa',
      reason: `HOA community ($${rc.hoaFee}/mo) — check for lawn chemical restrictions and insurance requirements`,
      priority: 'LOW'
    });
  }

  // Organization-owned — note for context (common in SWFL for LLCs/trusts)
  // Don't flag as a warning — many homeowners use LLCs

  // Wood frame construction
  if (rc?.constructionMaterial === 'WOOD_FRAME' ||
      ai?.constructionVisible === 'WOOD_FRAME') {
    flags.push({
      field: 'constructionMaterial',
      reason: 'Wood frame construction — higher termite risk, verify exterior condition',
      priority: 'MEDIUM'
    });
  }

  // Crawlspace or raised foundation
  const foundation = inferFoundation(rc, ai);
  if (foundation === 'CRAWLSPACE' || foundation === 'RAISED') {
    flags.push({
      field: 'foundationType',
      reason: `${foundation} foundation — termite treatment approach differs from standard slab`,
      priority: 'HIGH'
    });
  }

  // Low AI confidence
  if (ai?.confidenceScore && ai.confidenceScore < 60) {
    flags.push({
      field: 'aiAnalysis',
      reason: `AI confidence ${ai.confidenceScore}% — satellite imagery may be obstructed or outdated`,
      priority: 'MEDIUM'
    });
  }

  const estimatedTurfSf = firstNonNegativeNumber(ai?.estimatedTurfSf);
  const turfReviewReasons = turfRiskReasons({
    ...ai,
    lotSqFt: rc?.lotSize,
    aiConfidence: ai?.confidenceScore,
  });
  if (estimatedTurfSf > 0 && turfReviewReasons.length > 0) {
    flags.push({
      field: 'estimatedTurfSf',
      reason: `AI turf estimate ${Math.round(estimatedTurfSf).toLocaleString()} sq ft needs review — ${turfReviewReasons.join(', ')}`,
      priority: estimatedTurfSf >= TURF_REVIEW_THRESHOLD_SQFT || turfReviewReasons.some(reason => /% of lot/.test(reason)) ? 'HIGH' : 'MEDIUM',
    });
  }

  // Vegetation on structure
  if (ai?.vegetationOnStructure === 'SIGNIFICANT') {
    flags.push({
      field: 'vegetation',
      reason: 'Significant vegetation touching structure — pest bridge, recommend cutting back',
      priority: 'MEDIUM'
    });
  }

  // Pool permit on record but no assessed pool: brand-new construction the
  // annual roll hasn't caught up to — verify on site (changes mosquito/lawn
  // quoting context). Positive-only: no permit never flags. Skipped when a
  // pool flag already exists so one field isn't double-prompted.
  if (
    rc?._poolPermits?.poolPermit
    && rc?.hasPool !== true
    && !flags.some((f) => f.field === 'pool')
  ) {
    const issued = rc._poolPermits.poolPermit.issuedAt;
    flags.push({
      field: 'pool',
      reason: `County pool permit on record${issued ? ` (issued ${issued})` : ''} but no assessed pool — likely new construction`,
      priority: 'HIGH'
    });
  }

  return flags;
}


// ─────────────────────────────────────────────
// CALCULATE ESTIMATE (uses v1 modular pricing engine via adapter)
//
// Session 11a: v2's calculateEstimate has been retired. This handler now
// translates the (profile, selectedServices, options) call shape into v1's
// single-input shape, calls generateEstimate, and remaps the v1 output into
// the legacy envelope EstimatePage consumes (via v1-legacy-mapper).
//
// Sub-steps land incrementally: urgency/afterHours fan-out → 2b-2,
// roachModifier auto-fire → 2b-3, manualDiscount → 2b-4.
// ─────────────────────────────────────────────
function translateV2CallToV1Input(profile, selectedServices, options) {
  const p = profile || {};
  const o = options || {};
  const sel = new Set(selectedServices || []);
  const homeSqFt = Number(p.homeSqFt || p.squareFootage) || 0;
  const lotSqFt = Number(p.lotSqFt) || 0;
  const stories = Number(p.stories) || 1;
  const normalizePropertyType = (value) => {
    const normalized = normalizePricingPropertyType(value);
    return [
      'commercial',
      'single_family',
      'townhome_end',
      'townhome_interior',
      'duplex',
      'condo_ground',
      'condo_upper',
    ].includes(normalized) ? normalized : 'single_family';
  };
  const v1PropertyType = normalizePropertyType(p.propertyType);
  const commercialProfile = isCommercialProfile(p, o);
  const commercialSubtype = commercialProfile ? (o.commercialSubtype || p.commercialSubtype || null) : null;
  // Grass track — v2 accepts old A/B/C1/C2/D letters AND new keys.
  const TRACK_MAP = { A: 'st_augustine', B: 'st_augustine', C1: 'bermuda', C2: 'zoysia', D: 'bahia' };
  const rawGrass = o.grassType || 'st_augustine';
  const rawGrassKey = String(rawGrass).trim().toUpperCase();
  const rawGrassCompact = rawGrassKey.replace(/[^A-Z0-9]/g, '');
  const ALIAS_TRACK = {
    A: 'st_augustine',
    B: 'st_augustine',
    STAUGUSTINE: 'st_augustine',
    STAUG: 'st_augustine',
    C1: 'bermuda',
    BERMUDA: 'bermuda',
    C2: 'zoysia',
    ZOYSIA: 'zoysia',
    D: 'bahia',
    BAHIA: 'bahia',
  };
  const track = TRACK_MAP[rawGrass] || ALIAS_TRACK[rawGrassCompact] || rawGrass;

  // Frequency integer → v1 key
  const PEST_FREQ = { 4: 'quarterly', 6: 'bimonthly', 12: 'monthly' };
  const LAWN_TIER_FROM_FREQ = { 4: 'basic', 6: 'standard', 9: 'enhanced', 12: 'premium' };

  const pestFreq = PEST_FREQ[o.pestFreq] || 'quarterly';
  const lawnTier = LAWN_TIER_FROM_FREQ[o.lawnFreq] || 'enhanced';

  // Urgency / afterHours / recurringCustomer (Step 2b-2). v2 uses 'ROUTINE'
  // as the no-urgency sentinel; v1 uses 'NONE' for OT pest/lawn (and falls
  // back to NONE for any unknown value in specialty services). Remap here.
  const rawUrg = o.urgency || 'ROUTINE';
  const urgency = rawUrg === 'ROUTINE' ? 'NONE' : rawUrg;
  const afterHours = !!o.afterHours;
  const recurringCustomer = !!o.recurringCustomer;
  const measurementValue = (...values) => {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };
  const positiveIntegerValue = (...values) => {
    const raw = measurementValue(...values);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : raw;
  };
  const palmRequest = o.palmInjection && typeof o.palmInjection === 'object'
    ? o.palmInjection
    : {};

  const services = {};
  const pricingMetadata = {
    warnings: [],
    manualReviewReasons: [],
    skippedServices: [],
  };
  const addSkippedService = (skipped) => {
    pricingMetadata.skippedServices.push(skipped);
    if (skipped.skippedDuplicateRoachLine) {
      pricingMetadata.skippedDuplicateRoachLine = true;
      pricingMetadata.skippedService = skipped.skippedService;
      pricingMetadata.skippedReason = skipped.skippedReason;
    }
  };
  const termiteBaitMeasurements = {
    footprintSqFt: measurementValue(o.termiteFootprintSqFt, o.termiteFootprint, o.footprintSqFt),
    perimeterLF: measurementValue(o.termitePerimeterLF, o.termitePerimeterLf, o.termitePerimeter),
  };
  const trenchingMeasurements = {
    perimeterLF: measurementValue(o.trenchingPerimeterLF, o.trenchingPerimeterLf, o.perimeterLF),
    concreteLF: measurementValue(o.trenchingConcreteLF, o.trenchingConcreteLf, o.concreteLF),
    dirtLF: measurementValue(o.trenchingDirtLF, o.trenchingDirtLf, o.dirtLF),
    concretePct: measurementValue(o.trenchingConcretePct, o.concretePct),
  };
  const boraCareSurfaceLinearFt = measurementValue(o.boracareSurfaceLinearFt, o.boraCareSurfaceLinearFt, o.surfaceLinearFt, o.boracareWallLinearFt, o.boraCareWallLinearFt, o.wallLinearFt);
  const boraCareSurfaceHeightFt = measurementValue(o.boracareSurfaceHeightFt, o.boraCareSurfaceHeightFt, o.surfaceHeightFt, o.boracareWallHeightFt, o.boraCareWallHeightFt, o.wallHeightFt);
  const boraCareMeasurements = {
    atticSqFt: measurementValue(o.boracareSqft, o.boraCareSqFt, o.atticSqFt, o.rawWoodSqFt),
    surfaceLinearFt: boraCareSurfaceLinearFt,
    surfaceHeightFt: boraCareSurfaceHeightFt,
  };
  const preSlabMeasurements = {
    slabSqFt: measurementValue(o.preslabSqft, o.preSlabSqFt, o.slabSqFt),
  };

  // Roach activity on recurring pest initial visit. Keep accepting the legacy
  // roachModifier field while allowing clearer client aliases.
  const recurringRoachMeta = normalizeRoachType(o.recurringRoachType ?? o.roachModifier ?? 'NONE');
  const roachType = recurringRoachMeta.roachType;
  if (recurringRoachMeta.roachWarnings.length) {
    pricingMetadata.warnings.push(...recurringRoachMeta.roachWarnings);
  }

  // Recurring
  if (sel.has('PEST')) {
    services.pest = {
      frequency: pestFreq,
      roachType,
      ...(o.recurringRoachSeverity || o.roachSeverity
        ? { roachSeverity: o.recurringRoachSeverity || o.roachSeverity, severitySource: 'admin' }
        : {}),
      ...(commercialProfile && o.commercialPricingMode
        ? { commercialPricingMode: o.commercialPricingMode }
        : {}),
      ...(commercialProfile && commercialSubtype ? { commercialSubtype } : {}),
    };
  }
  if (sel.has('LAWN')) {
    services.lawn = {
      track,
      tier: lawnTier,
      lawnFreq: Number(o.lawnFreq) || 9,
      useLawnCostFloor: o.useLawnCostFloor != null ? !!o.useLawnCostFloor : undefined,
      targetLawnGrossMargin: o.targetLawnGrossMargin,
      routeDriveMinutes: o.routeDriveMinutes,
      lawnMaterialCostPerK: o.lawnMaterialCostPerK,
      lawnLaborMinutesBase: o.lawnLaborMinutesBase,
      lawnLaborMinutesPerK: o.lawnLaborMinutesPerK,
      ...(commercialProfile && o.commercialPricingMode
        ? { commercialPricingMode: o.commercialPricingMode }
        : {}),
      ...(commercialProfile && commercialSubtype ? { commercialSubtype } : {}),
    };
  }
  if (sel.has('TREE_SHRUB')) services.treeShrub = { tier: 'standard' };
  if (sel.has('PALM_INJECTION')) {
    const requestedPalmSize = String(palmRequest.palmSize || o.palmSize || p.palmSize || 'medium').toLowerCase();
    const palmSize = ['small', 'medium', 'large'].includes(requestedPalmSize)
      ? requestedPalmSize
      : 'medium';
    const servicePalmCount = positiveIntegerValue(
      palmRequest.palmCount,
      palmRequest.measurements?.palmCount,
      o.palmTreatmentCount,
      o.palmsToTreat,
      o.palmInjectionPalmCount,
      // Backward-compatibility only: older admin forms wrote the manually
      // entered treatment count as injectablePalms. Do not invent a count when
      // this is missing; the engine returns a palm-count validation error.
      p.injectablePalms,
    );
    services.palm = {
      ...(servicePalmCount !== undefined ? { palmCount: servicePalmCount, measurements: { palmCount: servicePalmCount } } : {}),
      treatmentType: palmRequest.treatmentType || o.palmTreatmentType || 'combo',
      palmSize,
      appsPerYear: positiveIntegerValue(palmRequest.appsPerYear, o.palmAppsPerYear),
      intervalMonths: positiveIntegerValue(palmRequest.intervalMonths, o.palmIntervalMonths),
      customPricePerPalm: measurementValue(palmRequest.customPricePerPalm, o.palmCustomPricePerPalm),
      highDose: !!(palmRequest.highDose ?? o.palmHighDose),
      largeDiameter: !!(palmRequest.largeDiameter ?? o.palmLargeDiameter),
      nonstandardProduct: !!(palmRequest.nonstandardProduct ?? o.palmNonstandardProduct),
      diagnosisConfirmed: !!(palmRequest.diagnosisConfirmed ?? o.palmDiagnosisConfirmed),
      selectedProduct: palmRequest.selectedProduct || o.palmSelectedProduct,
      palmStatus: palmRequest.palmStatus || o.palmStatus,
      dbhInches: measurementValue(palmRequest.dbhInches, o.palmDbhInches),
      product: palmRequest.product || o.palmProduct,
      licensedApplicator: !!(palmRequest.licensedApplicator ?? o.palmLicensedApplicator),
    };
  }
  if (sel.has('MOSQUITO')) {
    services.mosquito = {
      tier: o.mosquitoProgram || 'monthly12',
      stationCount: o.mosquitoStationCount,
      dunkCount: o.mosquitoDunkCount,
    };
  }
  if (sel.has('TERMITE_BAIT')) {
    services.termite = {
      system: o.termiteBaitSystem || 'advance',
      monitoringTier: o.termiteMonitoringTier || 'basic',
      ...(o.termiteBaitComplexity ? { complexity: o.termiteBaitComplexity } : {}),
      measurements: termiteBaitMeasurements,
    };
  }
  if (sel.has('RODENT_BAIT')) services.rodentBait = {};

  // One-time — urgency/afterHours threaded through; recurringCustomer perk
  // applied inside priceOneTimePest/priceOneTimeLawn via top-level override.
  if (sel.has('OT_PEST')) services.oneTimePest = { urgency, afterHours };
  if (sel.has('OT_LAWN')) {
    const otLawnType = String(o.onetimeLawnType || 'WEED').toUpperCase();
    const OT_LAWN_TYPE = { FERT: 'fert', WEED: 'weed', PEST: 'pest', FUNGICIDE: 'fungicide' };
    services.oneTimeLawn = {
      treatmentType: OT_LAWN_TYPE[otLawnType] || 'weed',
      urgency, afterHours,
      track,
      tier: lawnTier,
      lawnFreq: Number(o.lawnFreq) || 9,
    };
  }
  if (sel.has('OT_MOSQUITO')) {
    services.oneTimeMosquito = {
      stationCount: o.mosquitoStationCount,
      dunkCount: o.mosquitoDunkCount,
    };
  }

  // Specialty
  if (sel.has('TRENCHING')) {
    services.trenching = {
      productKey: o.trenchingProductKey || o.trenchingTermiticideProductKey || o.productKey || 'taurus_sc',
      applicationRate: o.trenchingApplicationRate || o.applicationRate || 'standard',
      trenchDepthFt: o.trenchingDepthFt || o.trenchDepthFt || 1.0,
      concreteVolumePadPct: o.trenchingConcreteVolumePadPct || o.concreteVolumePadPct,
      warrantyTier: o.trenchingWarrantyTier || o.warrantyTier || 'one_year_retreat',
      labelConfirmed: o.trenchingLabelConfirmed === true || o.labelConfirmed === true ||
        o.trenchingLabelConfirmed === 'true' || o.labelConfirmed === 'true',
      measurements: trenchingMeasurements,
      allowComputedPerimeterFromFootprint: !!o.trenchingEstimateFromFootprint,
    };
  }
  if (sel.has('BORACARE')) {
    services.boraCare = {
      atticSqFt: o.boracareSqft,
      surfaceLinearFt: boraCareSurfaceLinearFt,
      surfaceHeightFt: boraCareSurfaceHeightFt,
      measurements: boraCareMeasurements,
    };
  }
  if (sel.has('PRESLAB')) {
    services.preSlabTermiticide = {
      productKey: o.preslabProductKey || o.preSlabProductKey || o.productKey || 'termidor_sc',
      slabSqFt: o.preslabSqft,
      measurements: preSlabMeasurements,
      volumeDiscount: o.preslabVolume && o.preslabVolume !== 'NONE' ? o.preslabVolume.toLowerCase() : 'none',
      jobContext: o.preslabJobContext || o.preSlabJobContext,
      warranty: o.preslabWarranty || 'BASIC',
      includeWarrantyExtended: !!o.includePreSlabWarrantyExtended || o.preslabWarranty === 'EXTENDED',
      labelConfirmed: o.preslabLabelConfirmed === true || o.preSlabLabelConfirmed === true ||
        o.preslabLabelConfirmed === 'true' || o.preSlabLabelConfirmed === 'true',
    };
  }
  if (sel.has('FOAM')) {
    services.foam = { urgency, afterHours };
    if (Object.prototype.hasOwnProperty.call(o, 'foamPoints')) {
      services.foam.points = o.foamPoints;
    }
  }
  if (sel.has('RODENT_TRAP')) {
    services.rodentTrapping = {
      plan: o.rodentTrappingPlan || 'standard',
      emergency: !!o.rodentTrappingEmergency,
      callbacksUsed: o.callbacksUsed,
      extraCallbackCount: o.extraCallbackCount,
      upgradeToUnlimited: !!o.upgradeToUnlimited,
    };
  }
  if (sel.has('RODENT_WIRE_MESH')) {
    services.rodentWireMesh = {
      meshLinearFeet: o.meshLinearFeet,
      meshSubstrate: o.meshSubstrate,
      measuredOrEstimated: o.meshMeasuredOrEstimated,
    };
  }
  if (sel.has('RODENT_BIRD_BOX')) {
    services.rodentBirdBoxes = {
      birdBoxType: o.birdBoxType,
      birdBoxQuantity: o.birdBoxQuantity,
    };
  }
  if (sel.has('TRAP_ONLY_RETAINER')) {
    services.trapOnlyRetainer = {
      plan: o.trapOnlyRetainerPlan || 'standard',
      billing: o.trapOnlyRetainerBilling || 'annual',
      responseCallbacksUsed: o.trapOnlyResponseCallbacksUsed,
      extraCallbackCount: o.trapOnlyExtraCallbackCount,
      attachedToCompletedTrappingJob: !!o.trapOnlyAttachedToCompletedTrappingJob,
      activeTrappingClosedAt: o.activeTrappingClosedAt,
      activationDate: o.trapOnlyActivationDate,
      renewalDate: o.trapOnlyRenewalDate,
    };
  }
  if (sel.has('WDO')) services.wdo = {};
  if (sel.has('FLEA')) {
    services.flea = {
      offerKey: o.fleaOfferKey || o.fleaOffer || o.offerKey || 'flea_elimination_two_visit',
      urgency,
      afterHours,
      fleaExterior: !!o.fleaExterior,
      fleaExteriorAreaSqFt: o.fleaExteriorAreaSqFt,
      fleaExteriorAreaSource: o.fleaExteriorAreaSource,
      fleaExteriorZones: Array.isArray(o.fleaExteriorZones) ? o.fleaExteriorZones : [],
      fleaComplexity: o.fleaComplexity || 'light',
      exteriorSourceSuspected: !!o.fleaExteriorSourceSuspected,
    };
  }
  // ROACH: manual specialty (full $450+ program) vs recurring auto-fire.
  // The modular estimate engine auto-adds pest_initial_roach when recurring
  // pest carries any non-none roachType. Do not also inject the older
  // germanRoachInitial service here, or German jobs get billed twice.
  //
  // Standalone Cockroach Treatment routes by the form's roachType selector:
  //   GERMAN  → priceGermanRoach (3-visit specialty, $450+)
  //   REGULAR → pricePestInitialRoach('regular', standalone=true) —
  //             single-visit native knockdown using the standalone scale
  //             ($202.50/$239/$289 by footprint).
  // Skip the standalone REGULAR fire when recurring pest already auto-fires
  // the same knockdown via roachModifier='REGULAR' so the same service isn't
  // billed twice.
  const roachServiceSelected = sel.has('ROACH') || !!o.standaloneRoachTreatment || !!o.germanRoachCleanoutSelected;
  const standaloneRoachMeta = normalizeRoachType(
    o.germanRoachCleanoutSelected
      ? 'german'
      : o.standaloneRoachTreatment ? 'regular' : o.roachType || 'REGULAR'
  );
  if (standaloneRoachMeta.roachWarnings.length) {
    pricingMetadata.warnings.push(...standaloneRoachMeta.roachWarnings);
  }
  if (roachServiceSelected) {
    if (standaloneRoachMeta.roachType === 'german') {
      services.germanRoach = {
        ...(o.germanRoachSeverity || o.roachSeverity
          ? { severity: o.germanRoachSeverity || o.roachSeverity, severitySource: 'admin' }
          : {}),
      };
    } else if (sel.has('PEST') && roachType === 'regular') {
      addSkippedService({
        skippedDuplicateRoachLine: true,
        skippedService: 'standalone_native_cockroach_treatment',
        skippedReason: 'recurring_pest_initial_roach_already_covers_regular_roach',
      });
    } else {
      services.pestInitialRoach = {
        roachType: 'regular',
        source: 'standalone_native_cockroach_treatment',
        ...(o.standaloneRoachSeverity || o.roachSeverity
          ? { severity: o.standaloneRoachSeverity || o.roachSeverity, severitySource: 'admin' }
          : {}),
      };
    }
  }
  if (sel.has('BEDBUG')) {
    const bedbugRooms = Number(o.bedbugRooms);
    const subcontractCost = Number(o.bedbugSubcontractCost);
    const bedbugMethod = o.bedbugMethod;
    const isChemicalBedBug = bedbugMethod === 'CHEMICAL';
    const bedbugEquipment = isChemicalBedBug ? undefined : o.bedbugEquipment;
    services.bedBug = {
      rooms: Number.isFinite(bedbugRooms) ? bedbugRooms : o.bedbugRooms,
      method: bedbugMethod,
      severity: o.bedbugSeverity,
      prepStatus: o.bedbugPrepStatus,
      occupancyType: o.bedbugOccupancyType,
      equipment: bedbugEquipment,
      heatScope: isChemicalBedBug ? undefined : o.bedbugHeatScope,
      subcontractCost: bedbugEquipment === 'SUBCONTRACT' && Number.isFinite(subcontractCost) && o.bedbugSubcontractCost !== ''
        ? subcontractCost
        : undefined,
      urgency,
      afterHours,
    };
  }
  if (sel.has('STING')) {
    services.stinging = {
      species: o.stingSpecies || 'PAPER_WASP',
      tier: o.stingTier || 2,
      removal: o.stingRemoval || 'NONE',
      aggressive: o.stingAggressive || 'NO',
      height: o.stingHeight || 'GROUND',
      confined: o.stingConfined || 'NO',
      urgency, afterHours,
    };
  }
  if (sel.has('EXCLUSION')) {
    const hasV2Fields = (o.exclStandardWireMesh || o.exclAdvancedWireMesh ||
      o.exclStandardBirdBox || o.exclTileHighBirdBox || o.exclCustomBirdBox ||
      o.exclMeshSoftLF || o.exclMeshConcreteLF);
    if (hasV2Fields) {
      services.exclusion = {
        pricingVersion: 'v2',
        standardWireMeshPoints: o.exclStandardWireMesh || 0,
        advancedWireMeshPoints: o.exclAdvancedWireMesh || 0,
        standardBirdBoxes: o.exclStandardBirdBox || 0,
        tileHighBirdBoxes: o.exclTileHighBirdBox || 0,
        customBirdBoxes: o.exclCustomBirdBox || 0,
        meshSoftLF: o.exclMeshSoftLF || 0,
        meshConcreteLF: o.exclMeshConcreteLF || 0,
        waiveInspection: !!o.exclWaiveInspection,
        urgency, afterHours,
      };
    } else {
      services.exclusion = {
        simple: o.exclSimple || 0,
        moderate: o.exclModerate || 0,
        advanced: o.exclAdvanced || 0,
        waiveInspection: !!o.exclWaiveInspection,
        urgency, afterHours,
      };
    }
  }
  if (sel.has('TOPDRESS')) {
    const topDressArea = Math.max(0, Number(o.topDressArea) || 0);
    services.topDressing = topDressArea > 0
      ? { depth: 'eighth', lawnSqFt: topDressArea }
      : { depth: 'eighth' };
  }
  if (sel.has('DETHATCH')) {
    services.dethatching = {
      cleanupLevel: o.dethatchingCleanupLevel || o.cleanupLevel || 'none',
      access: o.dethatchingAccess || o.dethatchingAccessDifficulty || o.access || 'easy',
      grassType: track,
      track,
      debrisRemovalIncluded: o.dethatchingDebrisRemovalIncluded ?? o.debrisRemovalIncluded,
      managerApproved: o.dethatchingManagerApproved ?? o.managerApproved,
      managerApprovalReason: o.dethatchingManagerApprovalReason || o.managerApprovalReason || null,
      thatchProbe1Inches: measurementValue(o.thatchProbe1Inches, o.dethatchingThatchProbe1Inches),
      thatchProbe2Inches: measurementValue(o.thatchProbe2Inches, o.dethatchingThatchProbe2Inches),
      thatchProbe3Inches: measurementValue(o.thatchProbe3Inches, o.dethatchingThatchProbe3Inches),
      thatchDepthInches: measurementValue(o.thatchDepthInches, o.dethatchingThatchDepthInches),
      thatchMeasurementSource: o.thatchMeasurementSource || o.dethatchingThatchMeasurementSource || 'manual',
      manuallyEnteredLawnSqFt: measurementValue(p.measuredTurfSf, p.lawnSqFt),
    };
  }
  if (sel.has('PLUGGING')) {
    services.plugging = { area: o.plugArea, spacing: o.plugSpacing || 12, urgency, afterHours };
  }
  if (sel.has('RODENT_SANITATION')) {
    services.sanitation = {
      tier: o.sanitationTier || 'standard',
      affectedSqFt: o.sanitationArea || 0,
      insulationRemovalCuFt: o.sanitationDebris || 0,
      accessType: o.sanitationAccess || 'normal',
    };
  }

  // Features — normalize v2's UPPERCASE enum shape to v1's lowercase boolean/string shape
  const features = {
    pool: p.pool === 'YES',
    poolCage: p.poolCage === 'YES',
    poolCageSize: p.poolCageSizeInferred ? undefined
      : String(p.poolCageSize || '').toUpperCase() === 'OVERSIZED' ? 'oversized'
      : String(p.poolCageSize || '').toUpperCase() === 'LARGE' ? 'large'
      : String(p.poolCageSize || '').toUpperCase() === 'SMALL' ? 'small'
      : String(p.poolCageSize || '').toUpperCase() === 'MEDIUM' ? 'medium'
      : p.poolCage === 'YES' ? undefined : 'none',
    trees: (p.treeDensity || 'LIGHT').toLowerCase(),
    shrubs: (p.shrubDensity || 'LIGHT').toLowerCase(),
    complexity: (p.landscapeComplexity || 'SIMPLE').toLowerCase(),
    nearWater: p.nearWater === 'YES',
    irrigation: !!p.irrigation,
    largeDriveway: !!p.hasLargeDriveway,
    treeCount: Number(p.treeCount || p.estimatedTreeCount) || 0,
  };

  const perimeterLF = p.perimeterLF ?? p.perimeterLf;
  const perimeter = p.perimeterSource === 'computed_from_footprint'
    ? undefined
    : p.perimeter;

  return {
    homeSqFt,
    stories,
    storiesSource: p.storiesSource || null,
    lotSqFt,
    footprintSqFt: p.footprintSqFt ?? p.footprint,
    perimeterLF: perimeterLF ?? perimeter,
    perimeterSource: p.perimeterSource || null,
    propertyType: commercialProfile ? 'commercial' : v1PropertyType,
    category: p.category || o.category || null,
    grassType: track,
    isCommercial: commercialProfile,
    commercialSubtype,
    measuredTurfSf: p.measuredTurfSf,
    estimatedTurfSf: p.estimatedTurfSf,
    imperviousSurfacePercent: p.imperviousSurfacePercent,
    imperviosSurfacePercent: p.imperviosSurfacePercent,
    estimatedBedAreaSf: p.estimatedBedAreaSf,
    estimatedBedAreaPercent: p.estimatedBedAreaPercent,
    bedArea: p.estimatedBedAreaSf,
    bedAreaSource: p.estimatedBedAreaSf !== undefined && p.estimatedBedAreaSf !== null && p.estimatedBedAreaSf !== ''
      ? 'estimated'
      : undefined,
    palmCount: positiveIntegerValue(p.palmCount),
    palmInventory: {
      ...(p.palmInventory || {}),
      ...(positiveIntegerValue(p.palmInventory?.palmCount, p.estimatedPalmCount) !== undefined
        ? { palmCount: positiveIntegerValue(p.palmInventory?.palmCount, p.estimatedPalmCount) }
        : {}),
    },
    features,
    yearBuilt: p.yearBuilt,
    constructionMaterial: p.constructionMaterial,
    foundationType: p.foundationType,
    roofType: p.roofType,
    nearWater: p.nearWater,
    waterDistance: p.waterDistance,
    isHOA: p.isHOA,
    hoaFee: p.hoaFee,
    isRental: p.isRental,
    isNewHomeowner: p.isNewHomeowner,
    fenceType: p.fenceType,
    outbuildingCount: p.outbuildingCount,
    attachedGarage: p.attachedGarage,
    maintenanceCondition: p.maintenanceCondition,
    overallPestPressure: p.overallPestPressure,
    atticSqFt: p.atticSqFt,
    atticAreaSqFt: p.atticAreaSqFt,
    rawWoodSqFt: p.rawWoodSqFt,
    woodTreatmentSqFt: p.woodTreatmentSqFt,
    slabSqFt: p.slabSqFt,
    foundationSqFt: p.foundationSqFt,
    buildingSlabSqFt: p.buildingSlabSqFt,
    newConstructionSlabSqFt: p.newConstructionSlabSqFt,
    recurringCustomer,
    fleaExterior: !!o.fleaExterior,
    fleaExteriorAreaSqFt: o.fleaExteriorAreaSqFt,
    fleaExteriorAreaSource: o.fleaExteriorAreaSource,
    fleaExteriorZones: Array.isArray(o.fleaExteriorZones) ? o.fleaExteriorZones : [],
    pricingMetadata: {
      ...pricingMetadata,
      warnings: [...new Set(pricingMetadata.warnings)],
      manualReviewReasons: [...new Set(pricingMetadata.manualReviewReasons)],
    },
    // Step 2b-4: pass-through. v1 engine applies it to recurring annual
    // after WaveGuard, capped at base — exact mirror of v2 calcTotals.
    manualDiscount: o.manualDiscount || null,
    serviceSpecificDiscounts: Array.isArray(o.serviceSpecificDiscounts) ? o.serviceSpecificDiscounts : [],
    services,
  };
}

router.post('/calculate-estimate', async (req, res) => {
  try {
    const { profile, selectedServices, options } = req.body;
    if (!profile) return res.status(400).json({ error: 'Profile required' });
    const turfConfirmation = needsTurfManualConfirmation(profile, selectedServices || [], options || {});
    if (turfConfirmation) {
      return res.status(400).json({
        error: turfConfirmation.message,
        code: 'TURF_CONFIRMATION_REQUIRED',
        turfConfirmation,
      });
    }

    const pricingEngine = require('../services/pricing-engine');
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    if (pricingEngine.needsSync && pricingEngine.needsSync()) {
      await pricingEngine.syncConstantsFromDB();
    }
    const v1Input = translateV2CallToV1Input(profile, selectedServices || [], options || {});
    const v1 = pricingEngine.generateEstimate(v1Input);
    const mapped = mapV1ToLegacyShape(v1);
    res.json(mapped);
  } catch (err) {
    console.error('[estimate-v1-adapter] Calculation error:', err.message, err.stack);
    res.status(err.statusCode || err.status || 500).json({
      error: err.message,
      code: err.code,
      metadata: err.metadata,
    });
  }
});

// ─────────────────────────────────────────────
// OPENAI VISION ANALYSIS
// ─────────────────────────────────────────────
async function analyzeWithOpenAI(imageB64s, propertyRecord, address, timeoutMs = DEFAULT_VISION_PROVIDER_TIMEOUT_MS, visionContext = null) {
  const content = [
    { type: 'input_text', text: buildSatelliteVisionPrompt(address, propertyRecord, visionContext) },
    ...imageB64s.map((imageB64) => ({
      type: 'input_image',
      image_url: `data:image/png;base64,${imageB64}`,
      detail: 'high',
    })),
  ];

  const timeout = createFetchTimeout(timeoutMs);
  let data;
  try {
    const resp = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      signal: timeout.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        input: [{ role: 'user', content }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    data = await resp.json();
  } catch (err) {
    if (isTimeoutFailure(err, timeout)) throw timeoutError('OpenAI vision analysis', timeoutMs);
    throw err;
  } finally {
    timeout.clear();
  }
  const text = extractOpenAIText(data);
  if (!text) throw new Error('OpenAI returned empty response');
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('OpenAI returned no valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─────────────────────────────────────────────
// GEMINI VISION ANALYSIS
// ─────────────────────────────────────────────
async function analyzeWithGemini(imageB64s, propertyRecord, address, apiKey, timeoutMs = DEFAULT_VISION_PROVIDER_TIMEOUT_MS, visionContext = null) {
  const prompt = buildSatelliteVisionPrompt(address, propertyRecord, visionContext);

  const timeout = createFetchTimeout(timeoutMs);
  let data;
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      signal: timeout.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            ...imageB64s.map((imageB64) => ({ inlineData: { mimeType: 'image/png', data: imageB64 } })),
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    data = await resp.json();
  } catch (err) {
    if (isTimeoutFailure(err, timeout)) throw timeoutError('Gemini vision analysis', timeoutMs);
    throw err;
  } finally {
    timeout.clear();
  }
  console.log(`[GEMINI DEBUG] finishReason: ${data.candidates?.[0]?.finishReason}, usage: ${JSON.stringify(data.usageMetadata || {})}`);
  // Gemini 2.5+ may return multiple parts (thinking + response)
  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = '';
  for (const part of parts) {
    // Skip thought parts, only use text output parts
    if (part.thought) continue;
    if (part.text) text += part.text;
  }
  // If no non-thought text, try all parts
  if (!text) {
    for (const part of parts) {
      if (part.text) text += part.text;
    }
  }
  console.log(`[GEMINI DEBUG] Response text (first 200): ${(text || '').substring(0, 200)}`);
  if (!text) throw new Error('Gemini returned empty response');
  // Try direct parse first (responseMimeType: application/json)
  try { return JSON.parse(text); } catch (e) {
    console.log(`[GEMINI DEBUG] Direct JSON.parse failed: ${e.message}`);
  }
  // Fallback: extract JSON from text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini returned no valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─────────────────────────────────────────────
// MERGE AI ANALYSES
// ─────────────────────────────────────────────
function mergeAiAnalyses(providerResults) {
  const sorted = providerResults
    .map(({ provider, analysis }) => ({ provider, analysis: normalizeSatelliteAnalysis(analysis) }))
    .sort((a, b) => (b.analysis?.confidenceScore || 0) - (a.analysis?.confidenceScore || 0));
  const primary = sorted[0];
  const merged = { ...primary.analysis };

  // Use higher confidence for key fields when models disagree
  const fieldsToValidate = ['propertyUse', 'commercialUseType', 'structureAttachment', 'pool', 'poolCage', 'poolCageSize', 'fenceType', 'shrubDensity', 'treeDensity', 'landscapeComplexity', 'nearWater', 'waterDistance', 'overallPestPressureEstimate'];

  const divergences = [];
  for (const { provider, analysis } of sorted.slice(1)) {
    for (const field of fieldsToValidate) {
      if (analysis[field] && merged[field] && String(analysis[field]).toUpperCase() !== String(merged[field]).toUpperCase()) {
        divergences.push({ field, primary: primary.provider, [primary.provider]: merged[field], [provider]: analysis[field] });
        if ((analysis.confidenceScore || 0) > (merged.confidenceScore || 0) + 10) {
          merged[field] = analysis[field];
        }
      }
    }

    // Fill gaps from every secondary provider.
    for (const [key, val] of Object.entries(analysis)) {
      if ((merged[key] === null || merged[key] === undefined || merged[key] === '') && val) {
        merged[key] = val;
      }
    }
  }

  const confidences = sorted.map((r) => Number(r.analysis?.confidenceScore)).filter(Number.isFinite);
  if (confidences.length) {
    merged.confidenceScore = Math.round(confidences.reduce((sum, n) => sum + n, 0) / confidences.length);
  }
  merged._sources = sorted.map((r) => r.provider);
  merged.aiSources = merged._sources;
  for (const { provider, analysis } of sorted) {
    merged[`_${provider}Confidence`] = analysis?.confidenceScore || null;
  }

  // Track divergences for field verification
  if (divergences.length) {
    merged.aiDivergences = divergences;
    merged.analysisNotes = (merged.analysisNotes || '') + ` AI models diverged on: ${divergences.map(d => d.field).join(', ')}.`;
  }

  // Confidence behind the FINAL structureAttachment value — the max confidence
  // among the providers that actually reported THAT value, not the blended
  // average. structureAttachment can be gap-filled from a single low-confidence
  // provider while two high-confidence providers omitted it; the pricing guard
  // (satelliteAttachmentIsConfident) keys off this so a lone low-confidence read
  // can't average its way past the bar and reprice a home (codex P1).
  if (merged.structureAttachment) {
    const want = String(merged.structureAttachment).toUpperCase();
    const supporters = sorted.filter(
      (r) => String(r.analysis?.structureAttachment || '').toUpperCase() === want
    );
    merged._structureAttachmentConfidence = supporters.reduce(
      (mx, r) => Math.max(mx, Number(r.analysis?.confidenceScore) || 0), 0
    );
    merged._structureAttachmentSupport = supporters.length;
  }

  return merged;
}

function normalizeSatelliteAnalysis(analysis = {}) {
  const normalized = { ...analysis };
  if (normalized.imperviousSurfacePercent == null && normalized.imperviosSurfacePercent != null) {
    normalized.imperviousSurfacePercent = normalized.imperviosSurfacePercent;
  }
  if (normalized.imperviosSurfacePercent == null && normalized.imperviousSurfacePercent != null) {
    normalized.imperviosSurfacePercent = normalized.imperviousSurfacePercent;
  }
  if (!normalized.waterProximity && normalized.nearWater) normalized.waterProximity = normalized.nearWater;
  if (!normalized.nearWater && normalized.waterProximity) normalized.nearWater = normalized.waterProximity;
  if (!normalized.waterDistance) normalized.waterDistance = 'NONE';
  if (normalized.propertyUse) normalized.propertyUse = String(normalized.propertyUse).toUpperCase();
  if (normalized.commercialUseType) normalized.commercialUseType = String(normalized.commercialUseType).toUpperCase();
  if (normalized.structureAttachment) normalized.structureAttachment = String(normalized.structureAttachment).toUpperCase();
  return normalized;
}

function buildSatelliteVisionPrompt(address, propertyRecord, visionContext = null) {
  const rcContext = propertyRecord ? `Property record: ${propertyRecord.formattedAddress || address}, ${propertyRecord.squareFootage || 'unknown'} sf, ${propertyRecord.lotSize || 'unknown'} sf lot, built ${propertyRecord.yearBuilt || 'unknown'}, ${propertyRecord.stories || 'unknown'} story, pool record: ${poolRecordContext(propertyRecord)}, construction:${propertyRecord.constructionMaterial || 'UNKNOWN'}, foundation: ${propertyRecord.foundationType || 'UNKNOWN'}` : 'No public property record available.';
  return `Analyze these satellite images of a Southwest Florida property at ${address}. Closest images come first and should carry the most weight. ${rcContext}${visionContextPromptBlock(visionContext)}

For pool cages, classify the visible screen enclosure service burden. SMALL is a compact lanai/cage under roughly 300 sq ft, MEDIUM is a typical 300-600 sq ft enclosure, LARGE is roughly 600-900 sq ft or clearly larger than a standard cage, and OVERSIZED is a very large or multi-section enclosure. If poolCage is not YES, return poolCageSize as NONE.

For structureAttachment, judge whether THIS home shares walls with neighbors: a free-standing home with gaps on both sides is DETACHED; an end unit on a continuous shared roofline is ATTACHED_END; a unit boxed between two others in that row is ATTACHED_INTERIOR; an apartment/condo building with stacked floors is STACKED. New SWFL communities mix detached homes and attached townhomes/villas on one street — judge the structure, not the community. Return UNKNOWN if you truly cannot tell.

Return ONLY valid JSON with these fields:
{
  "propertyUse": "RESIDENTIAL" | "COMMERCIAL" | "MIXED" | "UNKNOWN",
  "commercialUseType": "OFFICE_RETAIL" | "WAREHOUSE_LIGHT" | "RESTAURANT_FOOD_SERVICE" | "MEDICAL_OFFICE" | "INDUSTRIAL" | "SCHOOL_DAYCARE" | "GOVERNMENT_MUNICIPAL" | "HOA_COMMON_AREA" | "MULTIFAMILY_COMMON_AREA" | "OTHER" | "NONE",
  "structureAttachment": "DETACHED" | "ATTACHED_END" | "ATTACHED_INTERIOR" | "STACKED" | "UNKNOWN",
  "sharedWallCount": number (0 free-standing, 1 end unit, 2 interior row unit),
  "structureAttachmentNotes": "string — continuous shared roofline / party walls / row of identical units / stacked floors with separate entries",
  "pool": "YES" | "NO" | "POSSIBLE",
  "poolCage": "YES" | "NO" | "POSSIBLE",
  "poolCageSize": "NONE" | "SMALL" | "MEDIUM" | "LARGE" | "OVERSIZED",
  "poolNotes": "string",
  "largeDriveway": "YES" | "NO",
  "drivewaySurfaceType": "CONCRETE" | "PAVER" | "ASPHALT" | "GRAVEL" | "UNKNOWN",
  "fenceType": "NONE" | "PRIVACY_WOOD" | "PRIVACY_VINYL" | "CHAIN_LINK" | "ALUMINUM" | "PARTIAL" | "UNKNOWN",
  "fenceNotes": "string",
  "roofMaterial": "TILE" | "SHINGLE" | "METAL" | "FLAT" | "UNKNOWN",
  "roofNotes": "string",
  "constructionVisible": "CBS" | "WOOD_FRAME" | "METAL" | "BRICK" | "UNKNOWN",
  "shrubDensity": "LIGHT" | "MODERATE" | "HEAVY",
  "treeDensity": "LIGHT" | "MODERATE" | "HEAVY",
  "landscapeComplexity": "SIMPLE" | "MODERATE" | "COMPLEX",
  "estimatedPalmCount": number,
  "estimatedTreeCount": number,
  "estimatedBedAreaSf": number,
  "turfCondition": "GOOD" | "FAIR" | "POOR" | "UNKNOWN",
  "possibleGrassType": "ST_AUGUSTINE" | "BERMUDA" | "BAHIA" | "ZOYSIA" | "MIXED" | "UNKNOWN",
  "shadeCoveragePercent": number,
  "imperviousSurfacePercent": number,
  "estimatedTurfSf": number,
  "mulchBeds": "YES" | "NO" | "UNKNOWN",
  "rockBeds": "YES" | "NO" | "UNKNOWN",
  "bedMaterial": "MULCH" | "ROCK" | "MIXED" | "BARE" | "UNKNOWN",
  "irrigationVisible": "YES" | "NO" | "UNKNOWN",
  "nearWater": "NONE" | "CANAL_ADJACENT" | "POND_ON_PROPERTY" | "RETENTION_NEARBY" | "LAKE_ADJACENT" | "WETLAND_ADJACENT",
  "waterDistance": "ON_PROPERTY" | "ADJACENT" | "WITHIN_200FT" | "WITHIN_500FT" | "NONE",
  "woodedAdjacency": "NONE" | "PARTIAL" | "HEAVY",
  "woodedNotes": "string",
  "outbuildingCount": number,
  "outbuildingNotes": "string",
  "maintenanceCondition": "WELL_MAINTAINED" | "AVERAGE" | "DEFERRED" | "UNKNOWN",
  "maintenanceNotes": "string",
  "vegetationOnStructure": "NONE" | "MINOR" | "SIGNIFICANT",
  "vegetationNotes": "string",
  "overallPestPressureEstimate": "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH",
  "pestPressureFactors": ["string"],
  "confidenceScore": number,
  "analysisNotes": "string"
}`;
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
      if (content?.type === 'text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

module.exports = router;
module.exports.performPropertyLookup = performPropertyLookup;
module.exports.buildEnrichedProfile = buildEnrichedProfile;
module.exports.translateV2CallToV1Input = translateV2CallToV1Input;
module.exports.needsTurfManualConfirmation = needsTurfManualConfirmation;
module.exports.parcelOverlayEnabled = parcelOverlayEnabled;
module.exports.buildParcelOverlayParam = buildParcelOverlayParam;
module.exports._private = {
  applyParcelTurfBound,
  applySatelliteAttachmentType,
  applyVisionPropertyTypeEvidence,
  buildFallbackPropertyDataQuality,
  computeFootprintTurf,
  buildFieldVerifyFlags,
  buildParcelOverlayParam,
  buildSatelliteVisionPrompt,
  buildVisionContext,
  classifyPoolCageSize,
  imageWidthFt,
  mergeAiAnalyses,
  mergePool,
  parcelTurfBoundSqft,
  parseGeocodeResult,
  poolRecordContext,
  poolSource,
  propertyTypeFromAttachment,
  recordPropertyTypeIsWeak,
  turfRiskReasons,
  visionContextPromptBlock,
};
