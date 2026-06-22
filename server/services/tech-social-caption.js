/**
 * Tech field social caption engine.
 *
 * The seamless field flow: a tech snaps ONE photo + types a couple words,
 * and this turns it into platform-tailored captions in the Waves brand voice.
 *
 *   1. Photo understanding — Gemini 3.5 Flash (the live vision scorer, same as
 *      lawn-assessment / satellite-analyzer) via services/llm/call.js, with an
 *      automatic ladder: Gemini best → Gemini fallback → Claude VISION. Never
 *      throws; returns null only if every rung misses.
 *   2. Captions — Claude VOICE tier (the documented social-copy tier: warm,
 *      natural, less overbuilt). ONE call returns four DISTINCT captions —
 *      Instagram / Facebook / TikTok / Google Business Profile — never the
 *      same text reflowed. The GBP caption is geo-anchored to the resolved
 *      service-area city. Brand voice + content rules are reused from
 *      social-media.js (BRAND_PREAMBLE + validateContent) so there's one
 *      source of truth for "no pricing / no safety overclaims / be specific".
 *
 * No persistence here — the route owns publish + audit logging. Pure helpers
 * are exported under `_test` for unit coverage.
 */

const MODELS = require('../config/models');
const llm = require('./llm/call');
const logger = require('./logger');
const { resolveLocation, nearestLocation, WAVES_LOCATIONS } = require('../config/locations');
const { BRAND_PREAMBLE, validateContent } = require('./social-media');

const CAPTION_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'gbp'];

// Hard character ceilings per platform — mirror social-media.js PLATFORM_LENGTH_LIMITS
// (facebook/instagram/gbp) and add TikTok (2200). We clamp generated copy to these
// so an over-long model reply never trips the publish-side validator.
const PLATFORM_LIMITS = { instagram: 2200, facebook: 500, tiktok: 2200, gbp: 1500 };

// Gemini vision model ladder. Same env convention as lawn-assessment: the
// per-service GEMINI_VISION_MODEL overrides the registry default; on a miss we
// retry the prior Gemini, then fall back to Claude VISION.
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || MODELS.GEMINI_VISION_BEST;
const GEMINI_VISION_FALLBACK_MODEL = process.env.GEMINI_VISION_FALLBACK_MODEL || 'gemini-2.5-flash';

const VISION_SYSTEM = `You are the eyes of Waves Pest Control & Lawn Care, a family-owned company in Southwest Florida. A field technician just took this photo on a job. Describe ONLY what is actually visible — never invent a pest, a brand, or damage you cannot see. This description feeds a social post, so be specific and factual.

Return ONLY a JSON object, no markdown or backticks:
{
  "subject": "<the single main thing in frame, e.g. 'German cockroach', 'chinch bug damage on St. Augustine grass', 'sealed rodent entry point under a sink', 'freshly treated lawn'>",
  "scene": "<1-2 plain sentences of what is visible>",
  "category": "<one of: pest | lawn | rodent | termite | mosquito | treatment | other>",
  "beforeAfter": "<one of: before | after | none>",
  "notable": "<one concrete, postable detail a tech would point out, or empty string>",
  "tags": ["<3-6 short lowercase topical tags>"]
}`;

/**
 * Analyze a single field photo. image = { data: <base64, no data: prefix>, mimeType }.
 * Returns the structured vision object, or null if every provider rung misses.
 */
async function analyzePhoto(image) {
  if (!image || !image.data) return null;
  const payload = { system: VISION_SYSTEM, text: 'Describe this field photo.', images: [image], jsonMode: true, maxTokens: 600 };

  // Rung 1+2: Gemini (best, then prior). Rung 3: Claude VISION.
  const attempts = [
    () => llm.callGemini({ model: GEMINI_VISION_MODEL, ...payload }),
    () => llm.callGemini({ model: GEMINI_VISION_FALLBACK_MODEL, ...payload }),
    () => llm.callAnthropic({ model: MODELS.VISION, ...payload }),
  ];
  for (const attempt of attempts) {
    const res = await attempt();
    if (res && res.ok && res.json) {
      return { ...normalizeVision(res.json), source: res.model };
    }
  }
  logger.warn('[tech-social] vision analysis missed on all providers');
  return null;
}

function normalizeVision(json) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const tags = Array.isArray(json?.tags)
    ? json.tags.map((t) => str(t).toLowerCase()).filter(Boolean).slice(0, 6)
    : [];
  return {
    subject: str(json?.subject),
    scene: str(json?.scene),
    category: str(json?.category) || 'other',
    beforeAfter: ['before', 'after'].includes(str(json?.beforeAfter)) ? str(json.beforeAfter) : 'none',
    notable: str(json?.notable),
    tags,
  };
}

/**
 * Resolve which of the 4 GBP service-area locations a post belongs to.
 * Priority: explicit valid locationId → nearest to device lat/lng → default.
 * resolveLocation() already defaults to lakewood-ranch on an unknown city/id.
 */
function resolveCaptionLocation({ locationId, lat, lng } = {}) {
  if (locationId) {
    const byId = WAVES_LOCATIONS.find((l) => l.id === locationId);
    if (byId) return byId;
  }
  const latN = Number(lat);
  const lngN = Number(lng);
  if (Number.isFinite(latN) && Number.isFinite(lngN)) {
    const near = nearestLocation(latN, lngN);
    if (near) return near;
  }
  return resolveLocation('');
}

const CAPTION_TASK = `Write social media captions for ONE field photo. Produce FOUR genuinely different captions — never the same text reflowed for each platform. Each platform has a different job, audience, and format.

Return ONLY a JSON object, no markdown or backticks:
{
  "instagram": "<caption>",
  "facebook": "<caption>",
  "tiktok": "<caption>",
  "gbp": "<caption>"
}

INSTAGRAM — strong standalone first line (shows before "…more"), 2-3 sentences of genuinely useful content, end with a conversation-starter. Then a blank line and 3-5 hashtags: always #wavespestcontrol, 1-2 local (#swfl #sarasotafl #bradentonfl #lakewoodranch #venicefl), 1-2 topical to the photo. ≤2200 chars.

FACEBOOK — hook line, 2-3 sentences of real value (reader learns something without leaving), soft close. 1-2 emojis max, only where natural. NO hashtags. 200-450 characters.

TIKTOK — punchy and scroll-stopping, written for video-first eyes. 1-2 short lines + 3-5 hashtags on one line. Casual, a little fun, never corporate.

GOOGLE BUSINESS PROFILE — this shows on Google Search & Maps for "{LOCATION}". Name {LOCATION} naturally in the first sentence, give a local-expert seasonal/practical tip tied to the photo, end with a clear next step ("Schedule an inspection"). 150-280 characters. NO hashtags, NO URL, NO phone number.`;

/**
 * Generate the four captions from the photo understanding + the tech's words.
 * Returns { captions, validation, model }. captions is always all 4 keys
 * (empty string if a model omitted one). validation maps platform → issues[].
 */
async function generateCaptions({ vision, techNote, location, photoType } = {}) {
  const loc = location || resolveLocation('');
  const facts = [
    vision?.subject ? `Photo subject: ${vision.subject}` : null,
    vision?.scene ? `What's visible: ${vision.scene}` : null,
    vision?.category ? `Category: ${vision.category}` : null,
    vision?.beforeAfter && vision.beforeAfter !== 'none' ? `This is a ${vision.beforeAfter} photo` : null,
    vision?.notable ? `Notable: ${vision.notable}` : null,
    vision?.tags?.length ? `Topical tags: ${vision.tags.join(', ')}` : null,
    photoType ? `Photo type: ${photoType}` : null,
    techNote ? `Technician's note (lead with their angle): ${techNote}` : null,
    `Service-area city for the Google Business Profile caption: ${loc.name} (${loc.area}).`,
    !vision && !techNote ? 'No photo description available — write calm, generic-but-specific SWFL pest/lawn captions.' : null,
  ].filter(Boolean).join('\n');

  const text = `${CAPTION_TASK.replace(/\{LOCATION\}/g, loc.name)}\n\n--- INPUTS ---\n${facts}`;
  const payload = { system: BRAND_PREAMBLE, text, jsonMode: true, maxTokens: 1200 };

  let res = await llm.callAnthropic({ model: MODELS.VOICE, ...payload });
  if (!res || !res.ok || !res.json) {
    // Fall back to the flagship reasoner if the voice tier misses.
    res = await llm.callAnthropic({ model: MODELS.FLAGSHIP, ...payload });
  }
  if (!res || !res.ok || !res.json) {
    const err = new Error('Caption generation failed');
    err.statusCode = 502;
    throw err;
  }

  const captions = normalizeCaptions(res.json);
  return { captions, validation: validateCaptions(captions), model: res.model };
}

/** Ensure all 4 keys exist, trimmed and clamped to each platform's char ceiling. */
function normalizeCaptions(json) {
  const out = {};
  for (const platform of CAPTION_PLATFORMS) {
    const raw = typeof json?.[platform] === 'string' ? json[platform].trim() : '';
    out[platform] = raw.slice(0, PLATFORM_LIMITS[platform]);
  }
  return out;
}

/** Per-platform content validation (reuses social-media.js rules). */
function validateCaptions(captions) {
  const out = {};
  for (const platform of CAPTION_PLATFORMS) {
    // Each platform validates under its own rules — tiktok has its own 2200 limit
    // in social-media.js PLATFORM_LENGTH_LIMITS, so it no longer borrows facebook's.
    const result = validateContent(captions[platform] || '', platform);
    out[platform] = result.valid ? [] : result.issues;
  }
  return out;
}

module.exports = {
  analyzePhoto,
  generateCaptions,
  resolveCaptionLocation,
  CAPTION_PLATFORMS,
  PLATFORM_LIMITS,
  _test: {
    normalizeVision,
    normalizeCaptions,
    validateCaptions,
    resolveCaptionLocation,
  },
};
