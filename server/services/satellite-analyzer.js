/**
 * Dual-Vision Satellite Property Analyzer
 *
 * Runs both Claude (Anthropic) and Gemini (Google) vision in parallel
 * on a Google Static Maps satellite image. Merges results with
 * confidence weighting — where both agree, confidence is high.
 * Where they disagree, flags for field verification.
 */

const logger = require('./logger');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

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
   * Analyze a property using both Claude and Gemini vision in parallel.
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

    // Generate satellite image URL
    const imageUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&format=png&key=${GOOGLE_KEY}`;

    // Fetch the image as base64
    let imageBase64;
    try {
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
      const buffer = await imgResp.arrayBuffer();
      imageBase64 = Buffer.from(buffer).toString('base64');
    } catch (err) {
      logger.error(`Satellite image fetch failed: ${err.message}`);
      return { error: 'Could not fetch satellite image', imageUrl };
    }

    // Run both models in parallel
    const [claudeResult, geminiResult] = await Promise.allSettled([
      this.analyzeWithClaude(imageBase64),
      this.analyzeWithGemini(imageBase64),
    ]);

    const claude = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
    const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

    if (!claude && !gemini) {
      return { error: 'Both vision models failed', imageUrl };
    }

    // Merge results
    const merged = this.mergeResults(claude, gemini);

    return {
      ...merged,
      imageUrl,
      lat, lng,
      models: {
        claude: claude ? { available: true, raw: claude } : { available: false },
        gemini: gemini ? { available: true, raw: gemini } : { available: false },
      },
    };
  }

  async analyzeWithClaude(imageBase64) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
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

  async analyzeWithGemini(imageBase64) {
    if (!GEMINI_KEY) return null;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/png', data: imageBase64 } },
              { text: VISION_PROMPT },
            ],
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
        }),
      });

      if (!response.ok) {
        logger.error(`Gemini API ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;

      return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (err) {
      logger.error(`Gemini vision failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Merge Claude + Gemini results with confidence weighting.
   * Where both agree (within 15%), confidence is HIGH.
   * Where they disagree, use average and flag for field verify.
   */
  mergeResults(claude, gemini) {
    // If only one model returned results, use it directly
    if (!claude && !gemini) return { error: 'No results' };
    if (!claude) return { ...gemini, confidence: 'single_model', source: 'gemini', fieldVerify: Object.keys(gemini) };
    if (!gemini) return { ...claude, confidence: 'single_model', source: 'claude', fieldVerify: Object.keys(claude) };

    const merged = {};
    const fieldVerify = [];
    const confidenceDetails = {};

    // Numeric fields — average if within 15%, flag if > 15% apart
    const numericFields = ['lot_sqft', 'lawn_sqft', 'house_footprint_sqft', 'bed_area_sqft', 'driveway_sqft', 'palm_count', 'tree_count', 'perimeter_linear_ft'];
    for (const field of numericFields) {
      const c = Number(claude[field]) || 0;
      const g = Number(gemini[field]) || 0;

      if (c === 0 && g === 0) { merged[field] = 0; continue; }
      if (c === 0) { merged[field] = g; fieldVerify.push(field); continue; }
      if (g === 0) { merged[field] = c; fieldVerify.push(field); continue; }

      const avg = Math.round((c + g) / 2);
      const diff = Math.abs(c - g);
      const pctDiff = diff / Math.max(c, g);

      merged[field] = avg;
      if (pctDiff > 0.15) {
        fieldVerify.push(field);
        confidenceDetails[field] = { claude: c, gemini: g, diff: Math.round(pctDiff * 100) + '%', status: 'disagree' };
      } else {
        confidenceDetails[field] = { claude: c, gemini: g, diff: Math.round(pctDiff * 100) + '%', status: 'agree' };
      }
    }

    // Boolean fields — agree if same, flag if different
    const boolFields = ['has_pool', 'has_pool_cage', 'has_large_driveway', 'near_water'];
    for (const field of boolFields) {
      const c = claude[field];
      const g = gemini[field];
      if (c === g) {
        merged[field] = c;
        confidenceDetails[field] = { status: 'agree' };
      } else {
        merged[field] = c || g; // err on the side of true
        fieldVerify.push(field);
        confidenceDetails[field] = { claude: c, gemini: g, status: 'disagree' };
      }
    }

    // String fields — prefer Claude if they disagree
    const stringFields = ['shrub_density', 'tree_density', 'landscape_complexity', 'property_type', 'roof_condition'];
    for (const field of stringFields) {
      const c = claude[field];
      const g = gemini[field];
      if (c === g) {
        merged[field] = c;
      } else {
        merged[field] = c || g; // prefer Claude
        if (c && g && c !== g) fieldVerify.push(field);
      }
    }

    // Notes — combine both
    const notes = [claude.notes, gemini.notes].filter(Boolean);
    merged.notes = notes.join(' | ');

    // Overall confidence
    const agreeCount = Object.values(confidenceDetails).filter(d => d.status === 'agree').length;
    const totalChecked = Object.keys(confidenceDetails).length;
    const agreePct = totalChecked > 0 ? Math.round(agreeCount / totalChecked * 100) : 0;

    merged.confidence = agreePct >= 80 ? 'high' : agreePct >= 60 ? 'medium' : 'low';
    merged.agreementPct = agreePct;
    merged.fieldVerify = fieldVerify;
    merged.confidenceDetails = confidenceDetails;
    merged.source = 'dual_model';

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

module.exports = new SatelliteAnalyzer();
