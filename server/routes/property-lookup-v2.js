/**
 * WAVES PEST CONTROL — Property Lookup API
 * Combines RentCast + Google Static Maps + Claude Vision into enriched property data.
 *
 * Express route: POST /api/property-lookup
 * Body: { address: string }
 * Returns: { rentcast, satellite, aiAnalysis, enriched }
 *
 * ENV VARS REQUIRED:
 *   RENTCAST_API_KEY
 *   GOOGLE_MAPS_API_KEY
 *   ANTHROPIC_API_KEY
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const GOOGLE_STATIC_MAP = 'https://maps.googleapis.com/maps/api/staticmap';
const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// SWFL bounding box — reject addresses outside service area
const SWFL_BOUNDS = { latMin: 26.3, latMax: 27.8, lngMin: -82.9, lngMax: -81.5 };

// ─────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────
router.post('/property-lookup', async (req, res) => {
  const { address } = req.body;
  if (!address || address.trim().length < 5) {
    return res.status(400).json({ error: 'Address required' });
  }

  const result = {
    address: address.trim(),
    rentcast: null,
    satellite: null,
    aiAnalysis: null,
    enriched: null,
    errors: [],
    meta: { timestamp: new Date().toISOString(), lookupMs: 0 }
  };

  const t0 = Date.now();

  // ── STEP 1: RentCast Lookup ──
  try {
    result.rentcast = await fetchRentCast(address);
  } catch (err) {
    result.errors.push({ source: 'rentcast', message: err.message });
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
      const ultraCloseUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=21&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const superCloseUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const closeUrlWithKey = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=19&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;
      const wideUrlWithKey = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=18&size=640x640&maptype=satellite&format=png&key=${mapsKey}`;

      const [ultraCloseB64, superCloseB64, closeB64, wideB64] = await Promise.all([
        fetchImageAsBase64(ultraCloseUrl).catch(() => null),
        fetchImageAsBase64(superCloseUrl).catch(() => null),
        fetchImageAsBase64(closeUrlWithKey).catch(() => null),
        fetchImageAsBase64(wideUrlWithKey).catch(() => null),
      ]);
      console.log(`[property-lookup] Satellite images: ultra=${!!ultraCloseB64}, super=${!!superCloseB64}, close=${!!closeB64}, wide=${!!wideB64}`);

      result.satellite = {
        lat, lng,
        ultraCloseUrl,
        superCloseUrl,
        closeUrl: closeUrlWithKey,
        wideUrl: wideUrlWithKey,
        inServiceArea: !(lat < SWFL_BOUNDS.latMin || lat > SWFL_BOUNDS.latMax ||
                         lng < SWFL_BOUNDS.lngMin || lng > SWFL_BOUNDS.lngMax),
        _ultraCloseB64: ultraCloseB64,
        _superCloseB64: superCloseB64,
        _closeB64: closeB64,
        _wideB64: wideB64
      };
    }
  } catch (err) {
    result.errors.push({ source: 'satellite', message: err.message });
  }

  // ── STEP 3: Dual AI Vision Analysis (Claude + Gemini) ──
  if (result.satellite?._closeB64 && result.satellite?._wideB64) {
    // Run Claude and Gemini in parallel for collaborative analysis
    const [claudeResult, geminiResult] = await Promise.allSettled([
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
            result.rentcast,
            address,
            result.satellite._superCloseB64,
            result.satellite._ultraCloseB64
          );
          console.log(`[CLAUDE DEBUG] Success! Confidence: ${claudeAnalysis?.confidenceScore || 'N/A'}%`);
          return claudeAnalysis;
        } catch (err) {
          console.error(`[CLAUDE DEBUG] FAILED: ${err.message}`);
          throw err;
        }
      })(),
      // Gemini Vision
      (async () => {
        const geminiKey = process.env.GEMINI_API_KEY;
        console.log(`[GEMINI DEBUG] Key exists: ${!!geminiKey}, Key starts with: ${geminiKey ? geminiKey.substring(0, 10) : 'N/A'}`);
        if (!geminiKey) {
          console.log('[GEMINI DEBUG] GEMINI_API_KEY not set — skipping');
          return null;
        }
        try {
          console.log('[GEMINI DEBUG] Starting Gemini vision analysis...');
          const geminiAnalysis = await analyzeWithGemini(
            result.satellite?._superCloseB64 || result.satellite?._closeB64,
            result.satellite?._wideB64,
            result.rentcast,
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
    const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

    if (claudeResult.status === 'rejected') {
      result.errors.push({ source: 'claude', message: claudeResult.reason?.message || 'Claude analysis failed' });
    }
    if (geminiResult.status === 'rejected') {
      result.errors.push({ source: 'gemini', message: geminiResult.reason?.message || 'Gemini analysis failed' });
    }

    // Merge results — Claude is primary, Gemini fills gaps and validates
    if (claude && gemini) {
      result.aiAnalysis = mergeAiAnalyses(claude, gemini);
      result.aiAnalysis._sources = ['claude', 'gemini'];
      result.aiAnalysis._claudeConfidence = claude.confidenceScore;
      result.aiAnalysis._geminiConfidence = gemini.confidenceScore;
      logger.info(`[property-lookup] Dual AI analysis complete. Claude: ${claude.confidenceScore}%, Gemini: ${gemini.confidenceScore}%`);
    } else if (claude) {
      result.aiAnalysis = claude;
      result.aiAnalysis._sources = ['claude'];
    } else if (gemini) {
      result.aiAnalysis = gemini;
      result.aiAnalysis._sources = ['gemini'];
    } else {
      result.errors.push({ source: 'ai', message: 'Both AI models failed — check API keys' });
    }
  } else if (!result.satellite?._closeB64) {
    result.errors.push({ source: 'ai', message: 'Satellite images not available — cannot run AI analysis' });
  }

  // ── STEP 4: Enrich — merge all data sources ──
  result.enriched = buildEnrichedProfile(result.rentcast, result.aiAnalysis, lat, lng);

  // Clean up internal fields before sending to client
  if (result.satellite) {
    delete result.satellite._ultraCloseB64;
    delete result.satellite._superCloseB64;
    delete result.satellite._closeB64;
    delete result.satellite._wideB64;
  }

  result.meta.lookupMs = Date.now() - t0;
  res.json(result);
});


// ─────────────────────────────────────────────
// RENTCAST
// ─────────────────────────────────────────────
async function fetchRentCast(address) {
  const url = `${RENTCAST_BASE}/properties?address=${encodeURIComponent(address)}`;
  const resp = await fetch(url, {
    headers: {
      'X-Api-Key': process.env.RENTCAST_API_KEY,
      'Accept': 'application/json'
    }
  });

  if (!resp.ok) {
    throw new Error(`RentCast ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json();
  const p = Array.isArray(data) ? data[0] : data;
  if (!p) throw new Error('No property found');

  // Extract and normalize all useful fields
  const features = p.features || {};

  return {
    // Address
    formattedAddress: p.formattedAddress || '',
    addressLine1: p.addressLine1 || '',
    city: p.city || '',
    state: p.state || '',
    zipCode: p.zipCode || '',
    county: p.county || '',
    latitude: p.latitude,
    longitude: p.longitude,

    // Core property attributes
    propertyType: p.propertyType || '',
    squareFootage: p.squareFootage || 0,
    lotSize: p.lotSize || 0,
    yearBuilt: p.yearBuilt || null,
    bedrooms: p.bedrooms || 0,
    bathrooms: p.bathrooms || 0,
    stories: features.floorCount || features.floor_count || features.floors ||
             features.stories || p.stories || 1,

    // Construction & structure
    constructionMaterial: normalizeConstruction(
      features.exteriorType || features.exterior_type ||
      features.wallType || features.wall_type ||
      features.constructionType || features.construction_type || ''
    ),
    foundationType: normalizeFoundation(
      features.foundationType || features.foundation_type ||
      features.foundation || ''
    ),
    roofType: normalizeRoof(
      features.roofType || features.roof_type || features.roofing || ''
    ),
    garageType: features.garageType || features.garage_type ||
                features.parkingType || features.parking_type || '',
    garageSpaces: features.garageSpaces || features.garage_spaces ||
                  features.parkingSpaces || features.parking_spaces || 0,
    coolingType: features.coolingType || features.cooling_type ||
                 features.cooling || '',
    heatingType: features.heatingType || features.heating_type ||
                 features.heating || '',

    // Pool
    hasPool: !!(features.pool || p.pool || p.hasPool),

    // Multi-unit
    unitCount: features.unitCount || features.unit_count || p.units ||
               p.numberOfUnits || 1,

    // Owner
    ownerType: p.owner?.type || null,        // "Individual" or "Organization"
    ownerNames: p.owner?.names || [],

    // Sale history
    lastSaleDate: p.lastSaleDate || null,
    lastSalePrice: p.lastSalePrice || null,
    saleHistory: p.history || [],

    // Tax & HOA
    taxAssessments: p.taxAssessments || {},
    propertyTaxes: p.propertyTaxes || {},
    hoaFee: p.hoa?.fee || null,

    // Zoning
    zoning: p.zoning || '',

    // Raw features object for debugging
    _rawFeatures: features,

    // All other fields
    _raw: p
  };
}

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
  const url = `${GOOGLE_GEOCODE}?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
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
async function analyzeWithClaude(closeB64, wideB64, rentcastData, address, superCloseB64, ultraCloseB64) {
  const rcContext = rentcastData ? `
RentCast data for this property:
- Address: ${rentcastData.formattedAddress}
- Type: ${rentcastData.propertyType}
- Sq Ft: ${rentcastData.squareFootage}
- Lot: ${rentcastData.lotSize} sf
- Year Built: ${rentcastData.yearBuilt || 'unknown'}
- Stories: ${rentcastData.stories}
- Pool (per records): ${rentcastData.hasPool ? 'YES' : 'NO'}
- Construction: ${rentcastData.constructionMaterial}
- Foundation: ${rentcastData.foundationType}
- Roof: ${rentcastData.roofType}
- HOA Fee: ${rentcastData.hoaFee ? '$' + rentcastData.hoaFee + '/mo' : 'None/unknown'}
` : `No RentCast data available for this property.`;

  const systemPrompt = `You are a property analysis AI for Waves Pest Control, a pest control and lawn care company in Southwest Florida. You analyze satellite imagery to extract property features that affect pest control, lawn care, tree/shrub care, mosquito control, and termite treatment pricing.

You will receive up to four satellite images (closer views carry MORE weight for feature detection):
1. ULTRA CLOSE VIEW (zoom 21) — HIGHEST PRIORITY — shows pool cages, screen enclosures, lanai details, driveway width, individual plants. Use this for pool/cage/driveway detection.
2. SUPER CLOSE VIEW (zoom 20) — shows fine detail: roof material, driveway surface, landscape beds
3. CLOSE VIEW (zoom 19) — shows the full property lot boundaries and structure
4. WIDE VIEW (zoom 18) — shows the neighborhood, water features, surrounding lots

You also receive RentCast property record data for cross-reference.

IMPORTANT RULES:
- POOL DETECTION (SWFL-specific): Pool cages/screen enclosures are EXTREMELY common in Southwest Florida. They appear as rectangular screened structures attached to the back of the home, often covering both a pool and a lanai/patio. Look for: rectangular screen enclosure (lighter gray mesh visible from above), blue water visible through the screen, or a solid lanai roof extending from the main roof. If you see ANY screen enclosure attached to the home, mark poolCage=YES. Even small ones count — pool cages in SWFL range from 200-800+ sq ft. If RentCast says pool=NO but you clearly see a pool cage or blue water, override RentCast — county records are often outdated for pools added after construction.
- DRIVEWAY: "largeDriveway" means the driveway is wider than a standard 2-car width (~20ft) OR extends significantly along the side of the home OR has a circular/turnaround area. Standard SWFL driveways are 2-car width going straight to the garage — that is NOT large. Only mark YES if it's notably oversized.
- For construction material: if RentCast already identified it, confirm or note disagreement. If unknown, infer from satellite (CBS=stucco appearance, wood frame=siding visible, etc.)
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

  "imperviosSurfacePercent": number (0-100, percentage of lot that is hardscape/concrete/roof/paved),
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
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
function buildEnrichedProfile(rc, ai, lat, lng) {
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
    footprint: rc?.squareFootage
      ? Math.round(rc.squareFootage / (rc.stories || 1))
      : 0,

    // ── CONSTRUCTION (merged RC + AI) ──
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

    // ── LANDSCAPE (from AI, with RC cross-ref) ──
    shrubDensity: ai?.shrubDensity || 'MODERATE',
    treeDensity: ai?.treeDensity || 'MODERATE',
    landscapeComplexity: ai?.landscapeComplexity || 'MODERATE',
    estimatedPalmCount: ai?.estimatedPalmCount || 0,
    estimatedTreeCount: ai?.estimatedTreeCount || 0,
    estimatedBedAreaSf: ai?.estimatedBedAreaSf || 0,
    shadeCoveragePercent: ai?.shadeCoveragePercent || 0,

    // ── TURF ──
    imperviosSurfacePercent: ai?.imperviosSurfacePercent || 20,
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
    nearWater: ai?.nearWater || 'NONE',
    waterDistance: ai?.waterDistance || 'NONE',

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
        ai?.nearWater || 'NONE',
        ai?.waterDistance || 'NONE'
      ),
      // Lawn: impervious surface correction
      turfCorrectionFactor: ai?.imperviosSurfacePercent
        ? (100 - ai.imperviosSurfacePercent) / 100
        : 0.80,
      // Overall pest pressure multiplier
      pestPressureMult: calcPestPressureMult(ai?.overallPestPressureEstimate),
    },

    // ── CONFIDENCE ──
    aiConfidence: ai?.confidenceScore || 0,
    analysisNotes: ai?.analysisNotes || '',
    fieldVerifyFlags: buildFieldVerifyFlags(rc, ai),

    // ── DATA SOURCE TRACKING ──
    dataSources: {
      rentcast: !!rc,
      satellite: !!(ai),
      aiAnalysis: !!(ai?.confidenceScore),
    }
  };

  return profile;
}


// ─────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────

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
  // RentCast takes priority if it has data; AI fills gaps
  if (rcValue && rcValue !== 'UNKNOWN') return rcValue;
  if (aiValue && aiValue !== 'UNKNOWN') return aiValue;
  return fallback;
}

function mergePool(rc, ai) {
  // RentCast YES is authoritative. AI can upgrade but not downgrade.
  if (rc?.hasPool) return 'YES';
  if (ai?.pool === 'YES') return 'POSSIBLE'; // AI sees pool but RC doesn't — could be neighbor
  if (ai?.pool === 'POSSIBLE') return 'POSSIBLE';
  return 'NO';
}

function inferFoundation(rc, ai) {
  // Direct from RentCast features
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
        reason: 'Construction material not identified by RentCast or satellite',
        priority: 'MEDIUM'
      });
    }
  }

  // AI pool disagrees with RentCast
  if (rc?.hasPool === false && ai?.pool === 'YES') {
    flags.push({
      field: 'pool',
      reason: 'AI detected possible pool not in property records — verify (may be neighbor)',
      priority: 'MEDIUM'
    });
  }

  // No RentCast data at all
  if (!rc) {
    flags.push({
      field: 'all',
      reason: 'No RentCast data — all property dimensions are estimated',
      priority: 'HIGH'
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
// CALCULATE ESTIMATE (uses v2 pricing engine)
// ─────────────────────────────────────────────
router.post('/calculate-estimate', async (req, res) => {
  try {
    const { profile, selectedServices, options } = req.body;
    if (!profile) return res.status(400).json({ error: 'Profile required' });

    const { calculateEstimate } = require('../services/pricing-engine-v2');
    const v2 = await calculateEstimate(profile, selectedServices || [], options || {});

    // ── Build v1-compatible "results" (R) object from v2 ──
    const R = {};
    const rec = v2.recurring || {};
    const wg = v2.waveguard || {};
    const totals = v2.totals || {};

    // Lawn → R.lawn[], R.lawnMeta
    if (rec.lawn) {
      const l = rec.lawn;
      R.lawn = (l.tiers || []).map((t, i) => ({
        pa: t.perApp, v: t.visits, ann: t.annual, mo: t.monthly,
        name: t.label?.replace('/yr', '') || ['Basic','Standard','Enhanced','Premium'][i] || `${t.visits}x`,
        recommended: !!t.recommended, dimmed: !t.recommended,
        hasLandscape: t.visits >= 12,
      }));
      R.lawnMeta = { lsf: l.turfSf || 0, sc: 0, tf: 0, oa: 0 };
    }

    // Pest → R.pestTiers[], R.pest, R.pestRoachMod
    if (rec.pest) {
      const p = rec.pest;
      R.pestTiers = (p.tiers || []).map(t => ({
        pa: t.perApp, apps: t.freq, ann: t.annual, mo: t.monthly,
        init: p.initialFee || 0, rOG: p.roachAdj || 0,
        label: t.label, recommended: !!t.recommended, dimmed: !t.recommended,
      }));
      const sel = p.selected || p.tiers?.find(t => t.recommended) || p.tiers?.[0] || {};
      R.pest = {
        pa: sel.perApp || 0, apps: sel.freq || 4, ann: sel.annual || 0, mo: sel.monthly || 0,
        init: p.initialFee || 0, rOG: p.roachAdj || 0, label: sel.label || 'Quarterly',
      };
      R.pestRoachMod = p.roachModifier || 'NONE';
    }

    // Tree & Shrub → R.ts[], R.tsMeta, R.injection
    if (rec.treeShrub) {
      const ts = rec.treeShrub;
      R.ts = (ts.tiers || []).map((t, i) => ({
        pa: t.perApp, v: t.visits, ann: t.annual, mo: t.monthly,
        name: t.label?.replace('/yr', '') || ['Standard','Enhanced'][i] || `${t.visits}x`,
        recommended: !!t.recommended, dimmed: !t.recommended,
      }));
      R.tsMeta = { eb: ts.bedArea || 0, et: ts.treeCount || 0, bedAreaIsEstimated: false };
      if (ts.injection && ts.palmCount > 0) {
        R.injection = { palms: ts.injection.palms, ann: ts.injection.annual, mo: ts.injection.monthly };
      }
    }

    // Mosquito → R.mq[], R.mqMeta
    if (rec.mosquito) {
      const mq = rec.mosquito;
      let ri = 1;
      R.mq = (mq.tiers || []).map((t, i) => {
        if (t.recommended) ri = i;
        return { pv: t.perVisit, v: t.visits, ann: t.annual, mo: t.monthly, n: t.name, recommended: !!t.recommended, dimmed: !t.recommended };
      });
      R.mqMeta = { pr: mq.pressure || 1, sz: mq.lotSize || 'SMALL', ri };
    }

    // Termite Bait → R.tmBait
    if (rec.termiteBait) {
      const tb = rec.termiteBait;
      R.tmBait = {
        ai: tb.advance?.install || 0, ti: tb.trelona?.install || 0,
        bmo: tb.advance?.basicMo || 35, pmo: tb.trelona?.premierMo || 65,
        perim: tb.perimeter || 0, sta: tb.stations || 0,
      };
    }

    // Rodent Bait → R.rodBaitMo, R.rodBaitSize
    if (rec.rodentBait) {
      const rb = rec.rodentBait;
      const recTier = rb.recommended || (rb.tiers || []).find(t => t.recommended) || rb.tiers?.[0];
      R.rodBaitMo = recTier?.moLow || 0;
      R.rodBaitSize = rb.stations >= 6 ? 'Large' : rb.stations <= 4 ? 'Small' : 'Medium';
    }

    // One-time items from v2
    const otItems = (totals.oneTimeItems || []).map(i => ({ name: i.name, price: i.price, detail: '' }));
    const specItems = (totals.specialtyItems || []).map(i => ({ name: i.name, price: i.price, det: '', onProg: false }));

    // One-time service details from v2.oneTime
    const ot = v2.oneTime || {};
    const v1OtItems = [];
    Object.values(ot).forEach(item => {
      if (!item || typeof item !== 'object') return;
      if (item.tiers) {
        // Top dressing, etc. with tiers
        const rec = item.tiers.find(t => t.recommended) || item.tiers[0];
        if (rec) v1OtItems.push({ name: item.name || item.service || 'Service', price: rec.price || 0, detail: rec.detail || '', tierName: rec.name });
        if (item.name === 'Top Dressing' || item.service === 'Top Dressing') {
          R.tdTiers = item.tiers.map(t => ({ name: t.name, detail: t.detail || '', price: t.price }));
        }
      } else if (item.price) {
        v1OtItems.push({
          name: item.name || item.service || 'Service', price: item.price,
          detail: item.detail || '',
          spacing: item.spacing, warn6: item.warn6,
          lawnType: item.lawnType, tierName: item.tierName,
          atticIsEstimated: item.atticIsEstimated,
          basePrice: item.basePrice, warrAdd: item.warrAdd,
        });
        if (item.name === 'Trenching') R.trench = true;
      }
    });

    // Specialty items from v2.specialty
    const v1SpecItems = [];
    const spec = v2.specialty || {};
    Object.values(spec).forEach(item => {
      if (!item || typeof item !== 'object') return;
      if (item.methods) {
        item.methods.forEach(m => v1SpecItems.push({ name: `${item.name} (${m.method})`, price: m.price, det: m.detail || '', onProg: false }));
      } else if (item.includedOnProgram) {
        v1SpecItems.push({ name: item.name, price: 0, det: `Included on ${R.pest?.label || 'pest'} program`, onProg: true });
      } else if (item.price > 0) {
        v1SpecItems.push({ name: item.name, price: item.price, det: item.detail || '', onProg: false });
      }
    });

    const serviceCount = wg.serviceCount || 0;
    const tmInstall = totals.oneTimeItems?.find(i => i.name?.includes('Trelona'))?.price || 0;
    const oneTimeTotal = totals.oneTimeTotal || 0;

    const mapped = {
      property: v2.property,
      fieldVerify: v2.fieldVerify || [],
      notes: v2.notes || [],
      urgency: v2.urgency,
      recurringCustomer: v2.recurringCustomer,
      isRecurringCustomer: v2.recurringCustomer,
      hasRecurring: serviceCount > 0,
      hasOneTime: v1OtItems.length > 0,
      recurring: {
        serviceCount,
        tier: wg.tier || 'Bronze',
        waveGuardTier: wg.tier || 'Bronze',
        discount: wg.discountPct || 0,
        annualBeforeDiscount: wg.annualBeforeDiscount || 0,
        grandTotal: totals.recurringMonthly || 0,
        monthlyTotal: wg.monthlyAfterDiscount || 0,
        annualAfterDiscount: wg.annualAfterDiscount || 0,
        savings: wg.savings || 0,
        rodentBaitMo: totals.rodentBaitMonthly || 0,
        services: (wg.services || []).map(s => ({ name: s.name, mo: s.monthly || s.mo || 0, monthly: s.monthly || s.mo || 0 })),
      },
      oneTime: {
        items: v1OtItems,
        specItems: v1SpecItems.filter(s => !s.onProg && s.price > 0).map(s => ({ name: s.name, price: s.price })),
        total: oneTimeTotal,
        tmInstall,
        otSubtotal: oneTimeTotal - tmInstall,
      },
      totals: {
        year1: totals.year1 || 0,
        year2: totals.year2 || 0,
        year2mo: totals.year2Monthly || 0,
        manualDiscount: totals.manualDiscount || null,
      },
      manualDiscount: totals.manualDiscount || null,
      results: R,
      specItems: v1SpecItems,
    };

    res.json(mapped);
  } catch (err) {
    console.error('[estimate-v2] Calculation error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GEMINI VISION ANALYSIS
// ─────────────────────────────────────────────
async function analyzeWithGemini(closeB64, wideB64, rentcastData, address, apiKey) {
  const rcContext = rentcastData ? `Property: ${rentcastData.formattedAddress}, ${rentcastData.squareFootage} sf, ${rentcastData.lotSize} sf lot, built ${rentcastData.yearBuilt || 'unknown'}, ${rentcastData.stories} story, pool: ${rentcastData.hasPool ? 'YES' : 'NO'}, ${rentcastData.constructionMaterial}, ${rentcastData.foundationType} foundation` : '';

  const prompt = `Analyze these satellite images of a property at ${address}. ${rcContext}

Return a JSON object with these fields (same format as a property analysis):
pool, poolCage, largeDriveway, drivewaySurfaceType, fenceType, fenceNotes, roofMaterial, roofCondition, shrubDensity (LIGHT/MODERATE/HEAVY), treeDensity, landscapeComplexity (SIMPLE/MODERATE/COMPLEX), estimatedTurfSqFt, estimatedBedSqFt, estimatedImpervious, waterProximity (NONE/CANAL/POND/LAKE/RETENTION/WETLAND), vegetationOnStructure, outbuildingCount, maintenanceCondition, overallPestPressureEstimate (LOW/MODERATE/HIGH/VERY_HIGH), confidenceScore (0-100), analysisNotes.

Respond ONLY with valid JSON. No markdown, no explanation.`;

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/png', data: closeB64 } },
          { inlineData: { mimeType: 'image/png', data: wideB64 } },
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
// MERGE AI ANALYSES (Claude primary, Gemini validates)
// ─────────────────────────────────────────────
function mergeAiAnalyses(claude, gemini) {
  const merged = { ...claude };

  // Use higher confidence for key fields when models disagree
  const fieldsToValidate = ['pool', 'poolCage', 'fenceType', 'shrubDensity', 'treeDensity', 'landscapeComplexity', 'waterProximity', 'overallPestPressureEstimate'];

  const divergences = [];
  for (const field of fieldsToValidate) {
    if (gemini[field] && claude[field] && String(gemini[field]).toUpperCase() !== String(claude[field]).toUpperCase()) {
      divergences.push({ field, claude: claude[field], gemini: gemini[field] });
      // If Gemini has higher confidence on this analysis, use its value
      if ((gemini.confidenceScore || 0) > (claude.confidenceScore || 0) + 10) {
        merged[field] = gemini[field];
      }
    }
  }

  // Fill gaps — if Claude returned null/undefined, use Gemini's value
  for (const [key, val] of Object.entries(gemini)) {
    if ((merged[key] === null || merged[key] === undefined || merged[key] === '') && val) {
      merged[key] = val;
    }
  }

  // Average confidence scores
  merged.confidenceScore = Math.round(((claude.confidenceScore || 70) + (gemini.confidenceScore || 70)) / 2);

  // Track divergences for field verification
  if (divergences.length) {
    merged.aiDivergences = divergences;
    merged.analysisNotes = (merged.analysisNotes || '') + ` AI models diverged on: ${divergences.map(d => `${d.field} (Claude: ${d.claude}, Gemini: ${d.gemini})`).join(', ')}.`;
  }

  return merged;
}

module.exports = router;
