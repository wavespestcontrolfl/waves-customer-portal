/**
 * Ladder-Vision Satellite Property Analyzer
 *
 * Analyzes Google Static Maps satellite images with Gemini first and OpenAI
 * Sol as the only fallback, stopping at the first schema-valid result.
 * mergeResults keeps its multi-provider agreement math (used when 2+ results
 * are handed to it directly, e.g. by tests), but the live ladder only ever
 * produces ONE result, so confidence always reads 'single_model' — a single
 * source can no longer read "high", which used to require multi-provider
 * agreement.
 */

const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';

const VISION_PROMPT = `Analyze this satellite/aerial image of a residential property in Southwest Florida. Estimate the following measurements and features as accurately as possible from the image.

Return ONLY a JSON object with these fields:
{
  "lot_sqft": estimated total lot size in square feet,
  "lawn_sqft": estimated treatable lawn/turf area in square feet (exclude driveway, house footprint, pool, hardscape),
  "house_footprint_sqft": estimated building footprint,
  "bed_area_sqft": estimated ornamental bed / landscape bed area,
  "driveway_sqft": estimated driveway and hardscape area,
  "palm_count": number of palm trees visible,
  "tree_count": number of non-palm trees visible,
  "shrub_density": "SPARSE" or "MODERATE" or "HEAVY",
  "tree_density": "SPARSE" or "MODERATE" or "HEAVY",
  "landscape_complexity": "SIMPLE" or "MODERATE" or "COMPLEX",
  "has_pool": true or false,
  "has_pool_cage": true or false (screened enclosure around pool),
  "has_large_driveway": true or false (driveway > 400 sqft),
  "near_water": true or false (adjacent to pond, lake, canal, or retention pond),
  "property_type": "Single Family" or "Townhome" or "Condo" or "Duplex" or "Commercial",
  "roof_condition": "good" or "fair" or "poor" (estimate from visible wear, algae, debris),
  "perimeter_linear_ft": estimated perimeter of the house foundation in linear feet,
  "notes": "any notable observations about pest risk factors (standing water, dense vegetation against foundation, wood-to-ground contact, etc.)"
}

Be specific with numbers. For SWFL properties, typical lot sizes range 5,000-15,000 sqft for single family, lawn areas are usually 40-65% of lot size.`;

// ── Schema validation (mirrors lawn-assessment.js's isValidVisionScores) ────────
// A syntactically valid but empty/malformed response (e.g. `{}`) is still a
// truthy object — without this check it would read as a real single-source
// result (all fields "missing" but the ladder stops anyway) instead of a miss
// that falls through to the next rung. Validates the VISION_PROMPT contract.
const SATELLITE_DENSITY_VALUES = new Set(['SPARSE', 'MODERATE', 'HEAVY']);
const SATELLITE_COMPLEXITY_VALUES = new Set(['SIMPLE', 'MODERATE', 'COMPLEX']);
const SATELLITE_PROPERTY_TYPES = new Set(['Single Family', 'Townhome', 'Condo', 'Duplex', 'Commercial']);
const SATELLITE_ROOF_CONDITIONS = new Set(['good', 'fair', 'poor']);
const SATELLITE_NUMERIC_FIELDS = ['lot_sqft', 'lawn_sqft', 'house_footprint_sqft', 'bed_area_sqft', 'driveway_sqft', 'palm_count', 'tree_count', 'perimeter_linear_ft'];
const SATELLITE_BOOL_FIELDS = ['has_pool', 'has_pool_cage', 'has_large_driveway', 'near_water'];
const SATELLITE_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lot_sqft: { type: 'number', minimum: 0 },
    lawn_sqft: { type: 'number', minimum: 0 },
    house_footprint_sqft: { type: 'number', minimum: 0 },
    bed_area_sqft: { type: 'number', minimum: 0 },
    driveway_sqft: { type: 'number', minimum: 0 },
    palm_count: { type: 'integer', minimum: 0 },
    tree_count: { type: 'integer', minimum: 0 },
    shrub_density: { type: 'string', enum: [...SATELLITE_DENSITY_VALUES] },
    tree_density: { type: 'string', enum: [...SATELLITE_DENSITY_VALUES] },
    landscape_complexity: { type: 'string', enum: [...SATELLITE_COMPLEXITY_VALUES] },
    has_pool: { type: 'boolean' },
    has_pool_cage: { type: 'boolean' },
    has_large_driveway: { type: 'boolean' },
    near_water: { type: 'boolean' },
    property_type: { type: 'string', enum: [...SATELLITE_PROPERTY_TYPES] },
    roof_condition: { type: 'string', enum: [...SATELLITE_ROOF_CONDITIONS] },
    perimeter_linear_ft: { type: 'number', minimum: 0 },
    notes: { type: 'string' },
  },
  required: [
    ...SATELLITE_NUMERIC_FIELDS,
    ...SATELLITE_BOOL_FIELDS,
    'shrub_density', 'tree_density', 'landscape_complexity',
    'property_type', 'roof_condition', 'notes',
  ],
};

// Models sometimes quote numbers ("1200"), stringify booleans ("true"), or
// vary enum casing ("moderate" vs "MODERATE", "single family" vs "Single
// Family"). Coerce those in place first so the validator rejects only
// genuinely missing or out-of-range fields, not formatting noise.
function normalizeSatelliteAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  for (const field of SATELLITE_NUMERIC_FIELDS) {
    const v = parsed[field];
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) parsed[field] = Number(v);
  }
  for (const field of SATELLITE_BOOL_FIELDS) {
    const v = parsed[field];
    if (typeof v === 'string') {
      const lower = v.trim().toLowerCase();
      if (lower === 'true') parsed[field] = true;
      else if (lower === 'false') parsed[field] = false;
    }
  }
  for (const field of ['shrub_density', 'tree_density']) {
    if (typeof parsed[field] === 'string') parsed[field] = parsed[field].trim().toUpperCase();
  }
  if (typeof parsed.landscape_complexity === 'string') parsed.landscape_complexity = parsed.landscape_complexity.trim().toUpperCase();
  if (typeof parsed.roof_condition === 'string') parsed.roof_condition = parsed.roof_condition.trim().toLowerCase();
  if (typeof parsed.property_type === 'string') {
    const match = [...SATELLITE_PROPERTY_TYPES].find((t) => t.toLowerCase() === parsed.property_type.trim().toLowerCase());
    if (match) parsed.property_type = match;
  }
  return parsed;
}

function isValidSatelliteAnalysis(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const nonNegNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const field of SATELLITE_NUMERIC_FIELDS) {
    if (!nonNegNumber(parsed[field])) return false;
  }
  for (const field of SATELLITE_BOOL_FIELDS) {
    if (typeof parsed[field] !== 'boolean') return false;
  }
  if (!SATELLITE_DENSITY_VALUES.has(parsed.shrub_density)) return false;
  if (!SATELLITE_DENSITY_VALUES.has(parsed.tree_density)) return false;
  if (!SATELLITE_COMPLEXITY_VALUES.has(parsed.landscape_complexity)) return false;
  if (!SATELLITE_PROPERTY_TYPES.has(parsed.property_type)) return false;
  if (!SATELLITE_ROOF_CONDITIONS.has(parsed.roof_condition)) return false;
  if (typeof parsed.notes !== 'string') return false;
  return true;
}

class SatelliteAnalyzer {

  /** Analyze a property with Gemini, falling back to OpenAI Sol on a miss. */
  async analyze(address, lat, lng) {
    if (!lat || !lng) {
      // Geocode first
      const geo = await this.geocode(address);
      if (!geo) return { error: 'Could not geocode address' };
      lat = geo.lat;
      lng = geo.lng;
    }

    const microCloseUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=22&size=640x640&maptype=satellite&format=png&key=${GOOGLE_KEY}`;
    const imageUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&format=png&key=${GOOGLE_KEY}`;

    let imageBase64s;
    try {
      imageBase64s = (await Promise.all([
        this.fetchImageAsBase64(microCloseUrl).catch(() => null),
        this.fetchImageAsBase64(imageUrl).catch(() => null),
      ])).filter(Boolean);
      if (!imageBase64s.length) throw new Error('No satellite images fetched');
    } catch (err) {
      logger.error(`Satellite image fetch failed: ${err.message}`);
      return { error: 'Could not fetch satellite image', imageUrl, microCloseUrl };
    }

    const outcome = await dispatchWithFallback(MODELS.TEXT_POLICIES.estimateVision, {
      text: VISION_PROMPT,
      images: imageBase64s.map((data) => ({ data, mimeType: 'image/png' })),
      jsonMode: true,
      jsonSchema: SATELLITE_ANALYSIS_SCHEMA,
      maxTokens: 2048,
      temperature: 0.2,
      reasoningEffort: 'low',
      laneId: 'satellite',
    }, {
      validate: (candidate) => {
        normalizeSatelliteAnalysis(candidate.json);
        return isValidSatelliteAnalysis(candidate.json) ? null : 'invalid_satellite_analysis';
      },
    });

    const providerStatus = {};
    const configured = {
      gemini: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      openai: !!process.env.OPENAI_API_KEY,
    };
    for (const failure of outcome.failures || []) {
      if (failure.provider !== 'gemini' && failure.provider !== 'openai') continue;
      if (failure.reason === 'timeout_budget_exhausted') continue;
      providerStatus[failure.provider] = {
        configured: configured[failure.provider],
        available: false,
      };
    }
    if (outcome.ok) {
      providerStatus[outcome.provider] = {
        configured: configured[outcome.provider],
        available: true,
      };
    }

    if (!outcome.ok) {
      return { error: 'All vision models failed', imageUrl, microCloseUrl, providerStatus };
    }

    const analysis = outcome.json;
    const merged = this.mergeResults([{ provider: outcome.provider, analysis }]);

    // A rung the ladder never reached gets no providerStatus entry at all:
    // the estimate pages warn on `configured === false` OR `available === false`
    // (buildAiProviderWarnings), and "not needed" is neither a missing key nor
    // a real miss.
    return {
      ...merged,
      imageUrl,
      microCloseUrl,
      lat, lng,
      aiSources: merged.aiSources || merged._sources || merged.source?.split('+') || [],
      providerStatus,
      models: {
        openai: outcome.provider === 'openai' ? { available: true, raw: analysis } : { available: false },
        gemini: outcome.provider === 'gemini' ? { available: true, raw: analysis } : { available: false },
      },
    };
  }

  async fetchImageAsBase64(url) {
    const imgResp = await fetch(url);
    if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
    const buffer = await imgResp.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }

  /**
   * Merge model results with confidence weighting.
   * Where both agree (within 15%), confidence is HIGH.
   * Where they disagree, use average and flag for field verify.
   */
  mergeResults(providerResults) {
    if (!providerResults.length) return { error: 'No results' };
    const numericFields = ['lot_sqft', 'lawn_sqft', 'house_footprint_sqft', 'bed_area_sqft', 'driveway_sqft', 'palm_count', 'tree_count', 'perimeter_linear_ft'];
    const boolFields = ['has_pool', 'has_pool_cage', 'has_large_driveway', 'near_water'];
    const stringFields = ['shrub_density', 'tree_density', 'landscape_complexity', 'property_type', 'roof_condition'];
    const explicitNonNegative = (analysis, field) => {
      if (!analysis || !Object.prototype.hasOwnProperty.call(analysis, field)) return null;
      if (analysis[field] === null || analysis[field] === '') return null;
      const value = Number(analysis[field]);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    if (providerResults.length === 1) {
      const only = providerResults[0];
      const cleanedAnalysis = { ...only.analysis };
      const confidenceDetails = {};
      const fieldVerify = [];
      for (const field of numericFields) {
        const fieldWasProvided = Object.prototype.hasOwnProperty.call(only.analysis || {}, field);
        const value = explicitNonNegative(only.analysis, field);
        if (value === null) {
          cleanedAnalysis[field] = null;
          confidenceDetails[field] = { values: [], status: 'missing' };
          // An invalid value must remain visible to the operator even though
          // it is removed from the merged measurements. Truly omitted fields
          // stay absent from Field Verify.
          if (fieldWasProvided) fieldVerify.push(field);
          continue;
        }
        confidenceDetails[field] = {
          values: [{ provider: only.provider, value }],
          status: 'single_source',
        };
        fieldVerify.push(field);
      }
      // Boolean and string facts (has_pool, near_water, property_type, …) are
      // just as single-source as the numbers — leaving them out of fieldVerify
      // hides them from the admin Field Verify list even though nothing
      // corroborated them.
      for (const field of boolFields) {
        const value = only.analysis?.[field];
        if (typeof value !== 'boolean') continue;
        confidenceDetails[field] = { values: [{ provider: only.provider, value }], status: 'single_source' };
        fieldVerify.push(field);
      }
      for (const field of stringFields) {
        const value = only.analysis?.[field];
        if (!value) continue;
        confidenceDetails[field] = { values: [{ provider: only.provider, value }], status: 'single_source' };
        fieldVerify.push(field);
      }
      return {
        ...cleanedAnalysis,
        confidence: 'single_model',
        agreementPct: null,
        confidenceDetails,
        source: only.provider,
        aiSources: [only.provider],
        _sources: [only.provider],
        fieldVerify,
      };
    }

    const merged = {};
    const fieldVerify = [];
    const confidenceDetails = {};

    // Numeric fields — average if within 15%, flag if > 15% apart
    for (const field of numericFields) {
      // Zero is a real observation for count/area fields (no palms, no lawn,
      // vacant parcel). The previous `value > 0` filter erased it, turning a
      // two-model 0/0 agreement into "missing" and a 0/4 disagreement into a
      // falsely confident single-source 4.
      const values = providerResults
        .map(({ provider, analysis }) => ({ provider, value: explicitNonNegative(analysis, field) }))
        .filter((v) => v.value !== null);

      if (!values.length) {
        merged[field] = 0;
        confidenceDetails[field] = { values: [], status: 'missing' };
        continue;
      }
      if (values.length === 1) {
        merged[field] = values[0].value;
        fieldVerify.push(field);
        confidenceDetails[field] = { values, status: 'single_source' };
        continue;
      }

      const avg = Math.round(values.reduce((sum, v) => sum + v.value, 0) / values.length);
      const min = Math.min(...values.map((v) => v.value));
      const max = Math.max(...values.map((v) => v.value));
      const pctDiff = max === 0 ? 0 : (max - min) / max;

      merged[field] = avg;
      if (pctDiff > 0.15) {
        fieldVerify.push(field);
        confidenceDetails[field] = { values, diff: Math.round(pctDiff * 100) + '%', status: 'disagree' };
      } else {
        confidenceDetails[field] = { values, diff: Math.round(pctDiff * 100) + '%', status: 'agree' };
      }
    }

    // Boolean fields — agree if same, flag if different
    for (const field of boolFields) {
      const values = providerResults
        .map(({ provider, analysis }) => ({ provider, value: analysis[field] }))
        .filter((entry) => typeof entry.value === 'boolean');
      const trueCount = values.filter((entry) => entry.value).length;
      const falseCount = values.length - trueCount;
      if (!values.length) {
        merged[field] = null;
        confidenceDetails[field] = { values: [], status: 'missing' };
      } else if (values.length < providerResults.length) {
        merged[field] = trueCount > 0;
        fieldVerify.push(field);
        confidenceDetails[field] = { values, status: 'single_source' };
      } else if (trueCount === 0 || falseCount === 0) {
        merged[field] = trueCount > 0;
        confidenceDetails[field] = { values, status: 'agree' };
      } else {
        merged[field] = true; // err on the side of true
        fieldVerify.push(field);
        confidenceDetails[field] = { values, status: 'disagree' };
      }
    }

    // String fields — prefer the first available provider result if they
    // disagree. Same single-source rule as the numeric/boolean paths: a
    // categorical fact only one provider returned is uncorroborated, not
    // settled — it must carry the verify flag and its provenance.
    for (const field of stringFields) {
      const values = providerResults
        .map(({ provider, analysis }) => ({ provider, value: analysis[field] }))
        .filter((entry) => Boolean(entry.value));
      merged[field] = values[0]?.value || null;
      if (!values.length) {
        confidenceDetails[field] = { values: [], status: 'missing' };
      } else if (values.length < providerResults.length) {
        fieldVerify.push(field);
        confidenceDetails[field] = { values, status: 'single_source' };
      } else if (new Set(values.map((entry) => entry.value)).size > 1) {
        fieldVerify.push(field);
        confidenceDetails[field] = { values, status: 'disagree' };
      } else {
        confidenceDetails[field] = { values, status: 'agree' };
      }
    }

    // Notes — combine both
    const notes = providerResults.map(({ provider, analysis }) => analysis.notes ? `${provider}: ${analysis.notes}` : null).filter(Boolean);
    merged.notes = notes.join(' | ');

    // Overall confidence
    const checkedDetails = Object.values(confidenceDetails)
      .filter((detail) => detail.status === 'agree' || detail.status === 'disagree');
    const agreeCount = checkedDetails.filter(d => d.status === 'agree').length;
    const totalChecked = checkedDetails.length;
    const agreePct = totalChecked > 0 ? Math.round(agreeCount / totalChecked * 100) : 0;

    merged.confidence = agreePct >= 80 ? 'high' : agreePct >= 60 ? 'medium' : 'low';
    merged.agreementPct = agreePct;
    merged.fieldVerify = fieldVerify;
    merged.confidenceDetails = confidenceDetails;
    merged.aiSources = providerResults.map((r) => r.provider);
    merged._sources = merged.aiSources;
    merged.source = merged.aiSources.join('+');

    return merged;
  }

  async geocode(address) {
    try {
      const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`);
      const data = await resp.json();
      if (data.status === 'OK' && data.results?.length) {
        return data.results[0].geometry.location;
      }
    } catch { /* geocode failed */ }
    return null;
  }
}

module.exports = Object.assign(new SatelliteAnalyzer(), {
  isValidSatelliteAnalysis,
  normalizeSatelliteAnalysis,
});
