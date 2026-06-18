/**
 * Trio-Vision Satellite Property Analyzer
 *
 * Runs Claude (Anthropic), OpenAI, and Gemini (Google) vision in parallel
 * on Google Static Maps satellite images. Merges results with
 * confidence weighting — where both agree, confidence is high.
 * Where they disagree, flags for field verification.
 */

const logger = require('./logger');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
// Live default is the registry's best Gemini vision model (gemini-3.5-flash);
// override via GEMINI_VISION_MODEL / MODEL_GEMINI_VISION. On any miss
// analyzeWithGemini retries the prior model (gemini-2.5-flash) so a live-model
// entitlement/availability issue never costs us the Gemini analyzer.
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || MODELS.GEMINI_VISION_BEST;
const GEMINI_VISION_FALLBACK_MODEL = process.env.GEMINI_VISION_FALLBACK_MODEL || 'gemini-2.5-flash';

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

class SatelliteAnalyzer {

  /**
   * Analyze a property using Claude, OpenAI, and Gemini vision in parallel.
   * Returns merged results with confidence scores.
   */
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

    const [claudeResult, openaiResult, geminiResult] = await Promise.allSettled([
      this.analyzeWithClaude(imageBase64s),
      this.analyzeWithOpenAI(imageBase64s),
      this.analyzeWithGemini(imageBase64s),
    ]);

    const claude = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
    const openai = openaiResult.status === 'fulfilled' ? openaiResult.value : null;
    const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

    if (!claude && !openai && !gemini) {
      return { error: 'All vision models failed', imageUrl, microCloseUrl };
    }

    const merged = this.mergeResults([
      claude ? { provider: 'claude', analysis: claude } : null,
      openai ? { provider: 'openai', analysis: openai } : null,
      gemini ? { provider: 'gemini', analysis: gemini } : null,
    ].filter(Boolean));

    return {
      ...merged,
      imageUrl,
      microCloseUrl,
      lat, lng,
      aiSources: merged.aiSources || merged._sources || merged.source?.split('+') || [],
      providerStatus: {
        claude: { configured: !!process.env.ANTHROPIC_API_KEY, available: !!claude },
        openai: { configured: !!process.env.OPENAI_API_KEY, available: !!openai },
        gemini: { configured: !!GEMINI_KEY, available: !!gemini },
      },
      models: {
        claude: claude ? { available: true, raw: claude } : { available: false },
        openai: openai ? { available: true, raw: openai } : { available: false },
        gemini: gemini ? { available: true, raw: gemini } : { available: false },
      },
    };
  }

  async fetchImageAsBase64(url) {
    const imgResp = await fetch(url);
    if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
    const buffer = await imgResp.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }

  async analyzeWithClaude(imageBase64s) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            ...imageBase64s.map((imageBase64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } })),
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      });

      const text = response.content[0].text;
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (err) {
      logger.error(`Claude vision failed: ${err.message}`);
      return null;
    }
  }

  async analyzeWithOpenAI(imageBase64s) {
    if (!process.env.OPENAI_API_KEY) {
      logger.info('OpenAI vision skipped: OPENAI_API_KEY not set');
      return null;
    }

    try {
      const response = await fetch(OPENAI_RESPONSES_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_VISION_MODEL,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: VISION_PROMPT },
              ...imageBase64s.map((imageBase64) => ({
                type: 'input_image',
                image_url: `data:image/png;base64,${imageBase64}`,
                detail: 'high',
              })),
            ],
          }],
        }),
      });

      if (!response.ok) {
        logger.error(`OpenAI API ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      const text = this.extractOpenAIText(data);
      if (!text) return null;
      const cleaned = text.replace(/```json|```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch (err) {
      logger.error(`OpenAI vision failed: ${err.message}`);
      return null;
    }
  }

  // Single attempt against one Gemini model. Returns parsed analysis, or null on
  // any miss (HTTP error / empty output / unparseable JSON) so the caller can retry.
  async geminiAttempt(model, imageBase64s) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            ...imageBase64s.map((imageBase64) => ({ inlineData: { mimeType: 'image/png', data: imageBase64 } })),
            { text: VISION_PROMPT },
          ],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
      }),
    });

    if (!response.ok) {
      logger.error(`Gemini API ${response.status} (${model}): ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    return JSON.parse(text.replace(/```json|```/g, '').trim());
  }

  async analyzeWithGemini(imageBase64s) {
    if (!GEMINI_KEY) return null;

    // Live model first, then the prior model on any miss (skip the retry if an
    // override has pinned both to the same id).
    const models = GEMINI_VISION_FALLBACK_MODEL && GEMINI_VISION_FALLBACK_MODEL !== GEMINI_VISION_MODEL
      ? [GEMINI_VISION_MODEL, GEMINI_VISION_FALLBACK_MODEL]
      : [GEMINI_VISION_MODEL];

    for (const model of models) {
      try {
        const parsed = await this.geminiAttempt(model, imageBase64s);
        if (parsed) return parsed;
      } catch (err) {
        logger.error(`Gemini vision failed (${model}): ${err.message}`);
      }
    }
    return null;
  }

  /**
   * Merge model results with confidence weighting.
   * Where both agree (within 15%), confidence is HIGH.
   * Where they disagree, use average and flag for field verify.
   */
  mergeResults(providerResults) {
    if (!providerResults.length) return { error: 'No results' };
    if (providerResults.length === 1) {
      const only = providerResults[0];
      return { ...only.analysis, confidence: 'single_model', source: only.provider, fieldVerify: Object.keys(only.analysis) };
    }

    const merged = {};
    const fieldVerify = [];
    const confidenceDetails = {};

    // Numeric fields — average if within 15%, flag if > 15% apart
    const numericFields = ['lot_sqft', 'lawn_sqft', 'house_footprint_sqft', 'bed_area_sqft', 'driveway_sqft', 'palm_count', 'tree_count', 'perimeter_linear_ft'];
    for (const field of numericFields) {
      const values = providerResults.map(({ provider, analysis }) => ({ provider, value: Number(analysis[field]) || 0 })).filter((v) => v.value > 0);

      if (!values.length) { merged[field] = 0; continue; }
      if (values.length === 1) { merged[field] = values[0].value; fieldVerify.push(field); continue; }

      const avg = Math.round(values.reduce((sum, v) => sum + v.value, 0) / values.length);
      const min = Math.min(...values.map((v) => v.value));
      const max = Math.max(...values.map((v) => v.value));
      const pctDiff = (max - min) / max;

      merged[field] = avg;
      if (pctDiff > 0.15) {
        fieldVerify.push(field);
        confidenceDetails[field] = { values, diff: Math.round(pctDiff * 100) + '%', status: 'disagree' };
      } else {
        confidenceDetails[field] = { values, diff: Math.round(pctDiff * 100) + '%', status: 'agree' };
      }
    }

    // Boolean fields — agree if same, flag if different
    const boolFields = ['has_pool', 'has_pool_cage', 'has_large_driveway', 'near_water'];
    for (const field of boolFields) {
      const values = providerResults.map(({ analysis }) => analysis[field]).filter((v) => typeof v === 'boolean');
      const trueCount = values.filter(Boolean).length;
      const falseCount = values.length - trueCount;
      if (!values.length) {
        merged[field] = false;
      } else if (trueCount === 0 || falseCount === 0) {
        merged[field] = trueCount > 0;
        confidenceDetails[field] = { status: 'agree' };
      } else {
        merged[field] = true; // err on the side of true
        fieldVerify.push(field);
        confidenceDetails[field] = { values, status: 'disagree' };
      }
    }

    // String fields — prefer the first available provider result if they disagree
    const stringFields = ['shrub_density', 'tree_density', 'landscape_complexity', 'property_type', 'roof_condition'];
    for (const field of stringFields) {
      const values = providerResults.map(({ analysis }) => analysis[field]).filter(Boolean);
      merged[field] = values[0] || null;
      if (new Set(values).size > 1) fieldVerify.push(field);
    }

    // Notes — combine both
    const notes = providerResults.map(({ provider, analysis }) => analysis.notes ? `${provider}: ${analysis.notes}` : null).filter(Boolean);
    merged.notes = notes.join(' | ');

    // Overall confidence
    const agreeCount = Object.values(confidenceDetails).filter(d => d.status === 'agree').length;
    const totalChecked = Object.keys(confidenceDetails).length;
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

  extractOpenAIText(data) {
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

module.exports = new SatelliteAnalyzer();
