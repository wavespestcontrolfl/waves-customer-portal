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
const { lookupStoriesFromAI, lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');

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

// SWFL bounding box — reject addresses outside service area
const SWFL_BOUNDS = { latMin: 26.3, latMax: 27.8, lngMin: -82.9, lngMax: -81.5 };
const TURF_REVIEW_THRESHOLD_SQFT = 15000;
const TURF_MANUAL_CONFIRMATION_SQFT = 20000;
const TURF_HIGH_LOT_RATIO = 0.55;
const TURF_PRICED_SERVICES = new Set(['LAWN', 'OT_LAWN', 'TOPDRESS', 'DETHATCH', 'PLUGGING']);

// ─────────────────────────────────────────────
// CORE LOOKUP — reusable by admin + public routes
// Extracted from the POST /property-lookup handler so server/routes/
// public-property-lookup.js can run the same AI search + satellite + trio
// AI vision pipeline without duplicating the logic.
// ─────────────────────────────────────────────
async function performPropertyLookup(address) {
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
      timestamp: new Date().toISOString(),
      lookupMs: 0,
    }
  };

  const t0 = Date.now();

  // ── STEP 1: AI property search ──
  // Pull pricing-relevant public facts (sqft, lot, year built, beds, baths,
  // stories, construction) from listing sites, county appraisers, builder
  // floorplans, and permit data through Claude/OpenAI/Gemini search. The shaped object
  // intentionally matches the old normalized property-record shape so the
  // pricing engine and field-verify logic do not need a provider branch.
  const aiProperty = await lookupPropertyFromAITrio(address).catch((err) => {
    result.errors.push({ source: 'ai-property', message: err?.message || String(err) });
    return null;
  });
  if (aiProperty) {
    result.propertyRecord = aiProperty;
    result.rentcast = aiProperty;
  }

  // ── STEP 2: Geocode + Satellite Images ──
  let lat, lng;
  try {
    const geo = await geocodeAddress(address);
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

      const [microCloseB64, ultraCloseB64, superCloseB64, closeB64, wideB64] = await Promise.all([
        fetchImageAsBase64(microCloseUrl).catch(() => null),
        fetchImageAsBase64(ultraCloseUrl).catch(() => null),
        fetchImageAsBase64(superCloseUrl).catch(() => null),
        fetchImageAsBase64(closeUrlWithKey).catch(() => null),
        fetchImageAsBase64(wideUrlWithKey).catch(() => null),
      ]);
      console.log(`[property-lookup] Satellite images: micro=${!!microCloseB64}, ultra=${!!ultraCloseB64}, super=${!!superCloseB64}, close=${!!closeB64}, wide=${!!wideB64}`);

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
        _wideB64: wideB64
      };
    }
  } catch (err) {
    result.errors.push({ source: 'satellite', message: err.message });
  }

  // ── STEP 3: Trio AI Vision Analysis (Claude + OpenAI + Gemini) ──
  if (result.satellite?._closeB64 && result.satellite?._wideB64) {
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
            result.satellite._microCloseB64
          );
          console.log(`[CLAUDE DEBUG] Success! Confidence: ${claudeAnalysis?.confidenceScore || 'N/A'}%`);
          return claudeAnalysis;
        } catch (err) {
          console.error(`[CLAUDE DEBUG] FAILED: ${err.message}`);
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
            address
          );
          console.log(`[OPENAI DEBUG] Success! Confidence: ${openaiAnalysis?.confidenceScore || 'N/A'}%`);
          return openaiAnalysis;
        } catch (openaiErr) {
          console.error(`[OPENAI DEBUG] FAILED: ${openaiErr.message}`);
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
            geminiKey
          );
          console.log(`[GEMINI DEBUG] Success! Confidence: ${geminiAnalysis?.confidenceScore || 'N/A'}%`);
          return geminiAnalysis;
        } catch (gemErr) {
          console.error(`[GEMINI DEBUG] FAILED: ${gemErr.message}`);
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
      logger.info('[property-lookup] Trio AI analysis complete', {
        sources: result.aiAnalysis._sources,
        confidence: result.aiAnalysis.confidenceScore,
      });
    } else {
      result.errors.push({ source: 'ai', message: 'All AI vision models failed — check API keys' });
    }
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
      const aiStories = await lookupStoriesFromAI(address, hints).catch((err) => {
        result.errors.push({ source: 'ai-stories', message: err?.message || String(err) });
        return null;
      });
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
  return result;
}

// ─────────────────────────────────────────────
// MAIN ROUTE — admin/tech-gated thin wrapper over performPropertyLookup
// ─────────────────────────────────────────────
router.post('/property-lookup', async (req, res) => {
  const { address } = req.body;
  if (!address || address.trim().length < 5) {
    return res.status(400).json({ error: 'Address required' });
  }
  try {
    const result = await performPropertyLookup(address);
    result.meta.providerStatus = buildProviderStatus();
    res.json(result);
  } catch (err) {
    logger.error(`[property-lookup] ${err.message}`);
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
// GEOCODE
// ─────────────────────────────────────────────
async function geocodeAddress(address) {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!mapsKey) throw new Error('No GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY configured');
  const url = `${GOOGLE_GEOCODE}?address=${encodeURIComponent(address)}&key=${mapsKey}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocode failed: ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}


// ─────────────────────────────────────────────
// IMAGE FETCH (base64 for Claude)
// ─────────────────────────────────────────────
async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}


// ─────────────────────────────────────────────
// CLAUDE VISION ANALYSIS
// ─────────────────────────────────────────────
async function analyzeWithClaude(closeB64, wideB64, propertyRecord, address, superCloseB64, ultraCloseB64, microCloseB64) {
  const rcContext = propertyRecord ? `
Property record for this address:
- Address: ${propertyRecord.formattedAddress}
- Type: ${propertyRecord.propertyType}
- Sq Ft: ${propertyRecord.squareFootage}
- Lot: ${propertyRecord.lotSize} sf
- Year Built: ${propertyRecord.yearBuilt || 'unknown'}
- Stories: ${propertyRecord.stories}
- Pool (per records): ${propertyRecord.hasPool ? 'YES' : 'NO'}
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
- Estimate impervious surface as a percentage of the total lot, not just what you see — account for areas under the roof line too.
- Be aggressive about detecting features — it's better to flag "POSSIBLE" than to miss something. Pest control pricing depends on accurate property assessment.

Respond ONLY with a JSON object. No markdown, no explanation, no backticks.`;

  const userPrompt = `Analyze these two satellite images of a property at: ${address}

${rcContext}

Return a JSON object with exactly these fields:

{
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

  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
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

  const data = await resp.json();
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
function buildEnrichedProfile(rc, ai, lat, lng, avm = null) {
  const waterProximity = ai?.waterProximity || ai?.nearWater || 'NONE';
  const waterDistance = ai?.waterDistance || 'NONE';
  const imperviousSurfacePercent = firstNonNegativeNumber(
    ai?.imperviousSurfacePercent,
    ai?.imperviosSurfacePercent
  );
  const profile = {
    // ── ADDRESS ──
    address: rc?.formattedAddress || '',
    lat: lat || rc?.latitude || null,
    lng: lng || rc?.longitude || null,
    county: rc?.county || '',
    zipCode: rc?.zipCode || '',

    // ── CATEGORY / TYPE ──
    category: detectCategory(rc),
    propertyType: rc?.propertyType || 'Single Family',
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

    // ── POOL / LANAI ──
    pool: mergePool(rc, ai),
    poolCage: ai?.poolCage || 'UNKNOWN',
    poolCageSize: normalizePoolCageSize(ai?.poolCageSize, ai?.poolCage),
    poolCageSizeInferred: ai?.poolCage === 'YES' && !['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED'].includes(String(ai?.poolCageSize || '').toUpperCase()),

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
    turfCondition: ai?.turfCondition || 'UNKNOWN',
    possibleGrassType: ai?.possibleGrassType || 'UNKNOWN',

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
    };
  }
  const critical = [rc.squareFootage, rc.lotSize, rc.stories, rc.propertyType].filter(Boolean).length;
  return {
    level: critical >= 3 ? 'medium' : 'low',
    score: critical >= 3 ? 60 : 35,
    providerCount: rc._aiProviders?.length || 1,
    providers: rc._aiProviders || [rc._provider || rc._source || 'property'],
    sourceTypes: rc._aiSourceTypes || [],
    verifiedCriticalFields: critical,
    totalCriticalFields: 4,
    fieldVerifyCount: 4 - critical,
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

function selectedTurfPricedServices(selectedServices = []) {
  return (selectedServices || [])
    .map((service) => String(service || '').toUpperCase())
    .filter((service) => TURF_PRICED_SERVICES.has(service));
}

function turfRiskReasons(source = {}) {
  const reasons = [];
  const lotSqFt = firstNonNegativeNumber(source.lotSqFt, source.lotSize);
  const estimatedTurfSf = firstNonNegativeNumber(source.estimatedTurfSf, source.estimatedTurfSqFt);
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
  const turfServices = selectedTurfPricedServices(selectedServices);
  if (turfServices.length === 0) return null;
  const manualTurfSf = firstNonNegativeNumber(profile.measuredTurfSf, profile.lawnSqFt);
  if (manualTurfSf !== undefined) return null;
  const plugArea = firstNonNegativeNumber(options.plugArea);
  if (turfServices.length === 1 && turfServices[0] === 'PLUGGING' && plugArea > 0) return null;

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

function detectCategory(rc) {
  if (!rc) return 'RESIDENTIAL';
  const pt = (rc.propertyType || '').toLowerCase();
  if (pt.includes('commercial') || pt.includes('office') || pt.includes('retail') ||
      pt.includes('industrial') || pt.includes('warehouse')) return 'COMMERCIAL';
  if (pt.includes('apartment') || pt.includes('multi') || (rc.unitCount && rc.unitCount > 4))
    return 'COMMERCIAL';
  return 'RESIDENTIAL';
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
  // Property-record YES is authoritative. Satellite AI can upgrade but not downgrade.
  if (rc?.hasPool) return 'YES';
  if (ai?.pool === 'YES') return 'POSSIBLE'; // AI sees pool but RC doesn't — could be neighbor
  if (ai?.pool === 'POSSIBLE') return 'POSSIBLE';
  return 'NO';
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

  // Foundation unknown on older homes
  if (rc?.yearBuilt && rc.yearBuilt < 1970 &&
      (!rc?.foundationType || rc.foundationType === 'UNKNOWN')) {
    flags.push({
      field: 'foundationType',
      reason: 'Pre-1970 home — foundation type not in records, could be raised/crawlspace',
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

  // Satellite AI pool signal disagrees with property records.
  if (rc?.hasPool === false && ai?.pool === 'YES') {
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
    flags.push({
      field,
      reason: evidence.disagreement
        ? `${field} has conflicting AI/source evidence — verify before pricing`
        : `${field} came from ${evidence.sourceLabel || 'a weak source'} with ${evidence.confidence || 'low'} confidence`,
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
  if (estimatedTurfSf >= TURF_REVIEW_THRESHOLD_SQFT && turfReviewReasons.length > 0) {
    flags.push({
      field: 'estimatedTurfSf',
      reason: `AI turf estimate ${Math.round(estimatedTurfSf).toLocaleString()} sq ft needs review — ${turfReviewReasons.join(', ')}`,
      priority: estimatedTurfSf > TURF_MANUAL_CONFIRMATION_SQFT ? 'HIGH' : 'MEDIUM',
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
    const raw = String(value || '').toLowerCase();
    if (raw.includes('commercial')) return 'commercial';
    if (raw.includes('duplex')) return 'duplex';
    if (raw.includes('town')) {
      return raw.includes('interior') || raw.includes('inner') ? 'townhome_interior' : 'townhome_end';
    }
    if (raw.includes('condo')) {
      return raw.includes('upper') || raw.includes('2nd') || raw.includes('3rd')
        ? 'condo_upper'
        : 'condo_ground';
    }
    return 'single_family';
  };

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

  const services = {};

  // Roach modifier (Step 2b-3). v2 options.roachModifier is uppercase
  // (GERMAN/REGULAR/NONE); v1 service-pricing expects lowercase roachType.
  const rawRoach = String(o.roachModifier || 'NONE').toUpperCase();
  const roachType = rawRoach === 'GERMAN' ? 'german'
                  : rawRoach === 'REGULAR' ? 'regular'
                  : 'none';

  // Recurring
  if (sel.has('PEST')) services.pest = { frequency: pestFreq, roachType };
  if (sel.has('LAWN')) {
    services.lawn = {
      track,
      tier: lawnTier,
      lawnFreq: Number(o.lawnFreq) || 9,
      useLawnCostFloor: !!o.useLawnCostFloor,
      targetLawnGrossMargin: o.targetLawnGrossMargin,
      routeDriveMinutes: o.routeDriveMinutes,
      lawnMaterialCostPerK: o.lawnMaterialCostPerK,
      lawnLaborMinutesBase: o.lawnLaborMinutesBase,
      lawnLaborMinutesPerK: o.lawnLaborMinutesPerK,
    };
  }
  if (sel.has('TREE_SHRUB')) services.treeShrub = { tier: 'standard' };
  if (sel.has('PALM_INJECTION')) {
    const totalPalmCount = Math.max(1, Number(p.estimatedPalmCount || p.palmCount) || 3);
    const injectablePalmCount = Number(p.injectablePalms) > 0
      ? Number(p.injectablePalms)
      : Math.max(1, Math.round(totalPalmCount * 0.30));
    services.palm = {
      palmCount: injectablePalmCount,
      treatmentType: 'combo',
    };
  }
  if (sel.has('MOSQUITO')) {
    services.mosquito = {
      tier: o.mosquitoProgram || 'monthly',
      stationCount: o.mosquitoStationCount,
      dunkCount: o.mosquitoDunkCount,
    };
  }
  if (sel.has('TERMITE_BAIT')) services.termite = { system: 'advance', monitoringTier: 'basic' };
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
  if (sel.has('TRENCHING')) services.trenching = {};
  if (sel.has('BORACARE')) services.boraCare = { atticSqFt: o.boracareSqft };
  if (sel.has('PRESLAB')) {
    services.preSlab = {
      slabSqFt: o.preslabSqft,
      volumeDiscount: o.preslabVolume && o.preslabVolume !== 'NONE' ? o.preslabVolume.toLowerCase() : 'none',
      warranty: o.preslabWarranty || 'BASIC',
    };
  }
  if (sel.has('FOAM')) services.foam = { points: o.foamPoints || 5, urgency, afterHours };
  if (sel.has('RODENT_TRAP')) services.rodentTrapping = {};
  if (sel.has('WDO')) services.wdo = {};
  if (sel.has('FLEA')) services.flea = {};
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
  const standaloneRoach = String(o.roachType || 'REGULAR').toUpperCase();
  if (sel.has('ROACH')) {
    if (standaloneRoach === 'GERMAN') {
      services.germanRoach = {};
    } else if (!(sel.has('PEST') && rawRoach === 'REGULAR')) {
      services.pestInitialRoach = { roachType: 'regular' };
    }
  }
  if (sel.has('BEDBUG')) {
    services.bedBug = {
      rooms: o.bedbugRooms || 1,
      method: (o.bedbugMethod || 'BOTH').toLowerCase(),
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
    services.exclusion = {
      simple: o.exclSimple || 0,
      moderate: o.exclModerate || 0,
      advanced: o.exclAdvanced || 0,
      waiveInspection: !!o.exclWaiveInspection,
      urgency, afterHours,
    };
  }
  if (sel.has('TOPDRESS')) services.topDressing = { depth: 'eighth' };
  if (sel.has('DETHATCH')) services.dethatching = {};
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

  return {
    homeSqFt,
    stories,
    storiesSource: p.storiesSource || null,
    lotSqFt,
    propertyType: normalizePropertyType(p.propertyType),
    serviceZone: p.serviceZone,
    measuredTurfSf: p.measuredTurfSf,
    estimatedTurfSf: p.estimatedTurfSf,
    imperviousSurfacePercent: p.imperviousSurfacePercent,
    imperviosSurfacePercent: p.imperviosSurfacePercent,
    estimatedBedAreaSf: p.estimatedBedAreaSf,
    estimatedBedAreaPercent: p.estimatedBedAreaPercent,
    bedArea: p.estimatedBedAreaSf,
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
    recurringCustomer,
    // Step 2b-4: pass-through. v1 engine applies it to recurring annual
    // after WaveGuard, capped at base — exact mirror of v2 calcTotals.
    manualDiscount: o.manualDiscount || null,
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
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// OPENAI VISION ANALYSIS
// ─────────────────────────────────────────────
async function analyzeWithOpenAI(imageB64s, propertyRecord, address) {
  const content = [
    { type: 'input_text', text: buildSatelliteVisionPrompt(address, propertyRecord) },
    ...imageB64s.map((imageB64) => ({
      type: 'input_image',
      image_url: `data:image/png;base64,${imageB64}`,
      detail: 'high',
    })),
  ];

  const resp = await fetch(OPENAI_RESPONSES_API, {
    method: 'POST',
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

  const data = await resp.json();
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
async function analyzeWithGemini(imageB64s, propertyRecord, address, apiKey) {
  const prompt = buildSatelliteVisionPrompt(address, propertyRecord);

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
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

  const data = await resp.json();
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
  const fieldsToValidate = ['pool', 'poolCage', 'poolCageSize', 'fenceType', 'shrubDensity', 'treeDensity', 'landscapeComplexity', 'nearWater', 'waterDistance', 'overallPestPressureEstimate'];

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
  for (const { provider, analysis } of sorted) {
    merged[`_${provider}Confidence`] = analysis?.confidenceScore || null;
  }

  // Track divergences for field verification
  if (divergences.length) {
    merged.aiDivergences = divergences;
    merged.analysisNotes = (merged.analysisNotes || '') + ` AI models diverged on: ${divergences.map(d => d.field).join(', ')}.`;
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
  return normalized;
}

function buildSatelliteVisionPrompt(address, propertyRecord) {
  const rcContext = propertyRecord ? `Property record: ${propertyRecord.formattedAddress || address}, ${propertyRecord.squareFootage || 'unknown'} sf, ${propertyRecord.lotSize || 'unknown'} sf lot, built ${propertyRecord.yearBuilt || 'unknown'}, ${propertyRecord.stories || 'unknown'} story, pool record: ${propertyRecord.hasPool ? 'YES' : 'NO'}, construction: ${propertyRecord.constructionMaterial || 'UNKNOWN'}, foundation: ${propertyRecord.foundationType || 'UNKNOWN'}` : 'No public property record available.';
  return `Analyze these satellite images of a Southwest Florida property at ${address}. Closest images come first and should carry the most weight. ${rcContext}

For pool cages, classify the visible screen enclosure service burden. SMALL is a compact lanai/cage under roughly 300 sq ft, MEDIUM is a typical 300-600 sq ft enclosure, LARGE is roughly 600-900 sq ft or clearly larger than a standard cage, and OVERSIZED is a very large or multi-section enclosure. If poolCage is not YES, return poolCageSize as NONE.

Return ONLY valid JSON with these fields:
{
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
