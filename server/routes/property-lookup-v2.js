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
    const closeUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=19&size=640x640&maptype=satellite&format=png&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const wideUrl = `${GOOGLE_STATIC_MAP}?center=${lat},${lng}&zoom=18&size=640x640&maptype=satellite&format=png&key=${process.env.GOOGLE_MAPS_API_KEY}`;

    // Fetch satellite images as base64 for Claude
    const [closeB64, wideB64] = await Promise.all([
      fetchImageAsBase64(closeUrl),
      fetchImageAsBase64(wideUrl)
    ]);

    result.satellite = {
      lat, lng,
      closeUrl,
      wideUrl,
      inServiceArea: !(lat < SWFL_BOUNDS.latMin || lat > SWFL_BOUNDS.latMax ||
                       lng < SWFL_BOUNDS.lngMin || lng > SWFL_BOUNDS.lngMax),
      _closeB64: closeB64, // internal — not sent to client
      _wideB64: wideB64    // internal — not sent to client
    };
  } catch (err) {
    result.errors.push({ source: 'satellite', message: err.message });
  }

  // ── STEP 3: Claude Vision Analysis ──
  if (result.satellite?._closeB64 && result.satellite?._wideB64) {
    try {
      result.aiAnalysis = await analyzeWithClaude(
        result.satellite._closeB64,
        result.satellite._wideB64,
        result.rentcast,
        address
      );
    } catch (err) {
      result.errors.push({ source: 'ai', message: err.message });
    }
  }

  // ── STEP 4: Enrich — merge all data sources ──
  result.enriched = buildEnrichedProfile(result.rentcast, result.aiAnalysis, lat, lng);

  // Clean up internal fields before sending to client
  if (result.satellite) {
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
async function analyzeWithClaude(closeB64, wideB64, rentcastData, address) {
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

You will receive two satellite images:
1. CLOSE VIEW (zoom 19) — shows the property in detail
2. WIDE VIEW (zoom 18) — shows the neighborhood context

You also receive RentCast property record data for cross-reference.

IMPORTANT RULES:
- If RentCast says pool=YES, do NOT downgrade to NO. Satellite may not show it (lanai roof covers it).
- If RentCast says pool=NO and you see what looks like a pool, flag it but note "possible neighbor pool" — satellite perspective can be misleading.
- For construction material: if RentCast already identified it, confirm or note disagreement. If unknown, infer from satellite (CBS=stucco appearance, wood frame=siding visible, etc.)
- For foundation: SWFL default is slab-on-grade. Only flag raised/crawlspace if clearly visible (house elevated, visible piers/stilts, lattice skirting).
- Estimate impervious surface as a percentage of the total lot, not just what you see — account for areas under the roof line too.

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
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
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
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Parse JSON — strip any markdown fences if present
  const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(clean);
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

  // Organization-owned (rental)
  if (rc?.ownerType === 'Organization') {
    flags.push({
      field: 'ownerType',
      reason: 'Organization-owned (likely rental) — tenant may not have approval authority',
      priority: 'LOW'
    });
  }

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
    const v2 = calculateEstimate(profile, selectedServices || [], options || {});

    // Map v2 result to v1-compatible structure for the existing frontend
    const mapped = {
      ...v2,
      // v1 compatibility layer
      recurring: {
        ...v2.recurring,
        serviceCount: v2.waveguard?.serviceCount || 0,
        tier: v2.waveguard?.tier || 'Bronze',
        waveGuardTier: v2.waveguard?.tier || 'Bronze',
        grandTotal: v2.totals?.recurringMonthly || 0,
        monthlyTotal: v2.waveguard?.monthlyAfterDiscount || 0,
        annualTotal: v2.waveguard?.annualAfterDiscount || 0,
        savings: v2.waveguard?.savings || 0,
        rodentBaitMo: v2.totals?.rodentBaitMonthly || 0,
      },
      oneTime: {
        ...v2.oneTime,
        total: v2.totals?.oneTimeTotal || 0,
        tmInstall: v2.totals?.oneTimeItems?.find(i => i.name?.includes('Trelona'))?.price || 0,
      },
      results: v2,
    };

    res.json(mapped);
  } catch (err) {
    console.error('[estimate-v2] Calculation error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
