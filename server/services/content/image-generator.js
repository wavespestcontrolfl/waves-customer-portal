/**
 * image-generator.js — provider-chained image generation for blog
 * heroes + social squares.
 *
 * Provider chain via env BLOG_IMAGE_PROVIDER (default:
 * "gpt-image-2,gpt-image-1.5,gpt-image-1,gemini-image-best,gemini-image"). Each
 * provider is tried in order; on 404 / model-not-found / 5xx we fall
 * through to the next. On the first 2xx with image bytes we return.
 *
 * Chain rationale (verified 2026-08-27): gpt-image-2 is the top-ranked
 * image model overall; the Gemini fallbacks are the image-NATIVE Nano
 * Banana line from config/models.js (gemini-3.1-flash-image-preview /
 * gemini-2.5-flash-image — env-overridable, e.g. MODEL_GEMINI_IMAGE=
 * gemini-3-pro-image for Nano Banana Pro). gpt-image-1 stays as the LAST
 * OpenAI fallback — an account without the newer models and no
 * GEMINI_API_KEY must not lose its only working provider. The legacy
 * 'gemini' slug (gemini-2.5-flash text model with image modality) is out
 * of the default but stays in MODEL_MAP for env overrides.
 * Google's Imagen line retired 2026-08-17 — never add imagen-* here.
 *
 * Output shape — `data:` URL — matches the legacy generateFeaturedImage
 * + social-media.generateImage shape, so the existing astro-publisher
 * image-commit code and Instagram S3 upload code don't need to change.
 *
 * Modes:
 *   blog-hero    1536x1024 (~1200x630 hero target — crop downstream)
 *   social-square 1024x1024
 *
 * Cost (from OpenAI's published pricing — verify at deploy time):
 *   gpt-image-2 high landscape ≈ $0.165 per image
 *   gpt-image-1 high landscape ≈ $0.25
 *   gemini-2.5-flash image ≈ included w/ Gemini quota
 *
 * NOTE on model availability: gpt-image-2 may not be released in every
 * account. The chain handles this automatically. capabilityCheck()
 * pings /v1/models at startup and logs which providers are reachable.
 */

const logger = require('../logger');
const { GEMINI_IMAGE_BEST, GEMINI_IMAGE_STABLE } = require('../../config/models');

const DEFAULT_CHAIN = 'gpt-image-2,gpt-image-1.5,gpt-image-1,gemini-image-best,gemini-image';

const MODEL_MAP = {
  'gpt-image-2':   { api: 'openai', model: 'gpt-image-2',   quality: 'high' },
  'gpt-image-1.5': { api: 'openai', model: 'gpt-image-1.5', quality: 'high' },
  'gpt-image-1':   { api: 'openai', model: 'gpt-image-1',   quality: 'high' },
  // Image-native Gemini models (Nano Banana line, config/models.js). These
  // accept generationConfig.imageConfig.aspectRatio; the legacy 'gemini' slug
  // below is a text model with image modality and 400s on imageConfig, so
  // aspect stays prompt-only there (imageAspect flag gates the field).
  'gemini-image-best': { api: 'gemini', model: GEMINI_IMAGE_BEST, imageAspect: true },
  'gemini-image':      { api: 'gemini', model: GEMINI_IMAGE_STABLE, imageAspect: true },
  'gemini':        { api: 'gemini', model: 'gemini-2.5-flash' },
};

const MODE_SIZES = {
  'blog-hero':     { openai: '1536x1024', gemini: '1536x1024' },
  // In-article illustration (owner rule 2026-08-27: ≥3 images per post).
  // Same 3:2 frame as the hero — the prose column renders body images at
  // their intrinsic ratio, and 3:2 is what the reference posts already use.
  'blog-body':     { openai: '1536x1024', gemini: '1536x1024' },
  'social-square': { openai: '1024x1024', gemini: '1024x1024' },
};

// aspectRatio for image-native Gemini models, per mode (must match MODE_SIZES).
const MODE_ASPECTS = {
  'blog-hero': '3:2',
  'blog-body': '3:2',
  'social-square': '1:1',
};

const RETRYABLE_OPENAI_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// ── pure helpers (test-friendly) ─────────────────────────────────────

function parseChain(envValue) {
  const raw = String(envValue || DEFAULT_CHAIN);
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => MODEL_MAP[s]);
}

function isFatalOpenAIError(status) {
  // 4xx other than retryable rate-limit / timeout / abort = move on
  // to next provider. 404 / model_not_found / 400 invalid_request /
  // 401 unauthorized — none recoverable for the current provider.
  if (status === 404 || status === 400 || status === 401 || status === 403) return true;
  return false;
}

function sizeFor(mode, api) {
  return (MODE_SIZES[mode] || MODE_SIZES['blog-hero'])[api];
}

// Body images must not read as three of the same picture: each slot gets a
// distinct FRAMING (the hero is the wide establishing shot), and body prompts
// name the hero subject they must differ from.
const BODY_IMAGE_FRAMING = {
  'close-up': 'Framing: a close-up, detail-level view of the subject — the specific thing this section describes filling the frame, shallow depth of field.',
  action: 'Framing: a person (a technician or homeowner) actively doing what this section describes — hands visible, mid-task, candid documentary feel.',
  environment: 'Framing: a wide environmental view of where this happens around the home, with the subject clearly placed in it.',
};

function buildPrompt({ title, topic, keyword, city, mode, shot, avoid }) {
  const kind = mode === 'social-square' ? 'social media tile' : (mode === 'blog-body' ? 'in-article illustration' : 'blog hero image');
  const base = `A high-quality, photorealistic ${kind} for a Southwest Florida pest control & lawn care business named "Waves Pest Control."`;
  // Body images name the SECTION (keyword) and carry its opening prose as
  // context (topic) — a generic heading ("What to expect") alone would
  // illustrate nothing in particular.
  const focus = (mode === 'blog-body' && keyword && topic && topic !== keyword)
    ? `Subject: ${keyword}. Context from the article: ${topic}`
    : `Subject: ${keyword || topic || title || 'pest control / lawn care service'}.`;
  const local = city
    ? `Setting: a ${city}-area home or yard with characteristic SWFL landscaping (palm trees, sandy soil, bright sun).`
    : `Setting: SWFL residential — palm trees, tropical landscaping, sunny afternoon.`;
  // Aspect/dimension lives in the prompt because Gemini's generateContent
  // doesn't accept a size parameter — without this, Gemini-only deploys
  // return arbitrary aspect ratios for both blog heroes and social tiles.
  const composition = mode === 'social-square'
    ? `Composition: square 1:1 aspect ratio, 1024x1024.`
    : `Composition: landscape 3:2 aspect ratio, 1536x1024.`;
  // Brand palette is Waves Blue #009CDE + Gold #FFD700 (theme-brand.js); the
  // brand brief explicitly forbids teal, so steer the grade, don't paint it.
  const style = `Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast). No text, words, watermarks, or logos in the image.`;
  const framing = mode === 'blog-body' ? (BODY_IMAGE_FRAMING[shot] || BODY_IMAGE_FRAMING['close-up']) : '';
  const distinct = (mode === 'blog-body' && avoid)
    ? `This image must look clearly different from the article's hero image (a wide establishing shot of: ${avoid}) — a different scene, distance and angle, not a variation of it.`
    : '';
  return [base, focus, local, framing, composition, style, distinct].filter(Boolean).join(' ');
}

// Alt text describing the image buildPrompt actually asks for — derived from
// the SAME inputs (subject + setting), so the shipped hero_image_alt can
// never describe a different picture than the one generated. Writers author
// alt BEFORE the hero exists; publishers overwrite it with this at
// generation time (astro-publisher stamps it alongside the hero src).
function buildAltText({ title, topic, keyword, city, mode = 'blog-hero' } = {}) {
  const subject = String(keyword || topic || title || 'pest control and lawn care service').trim().replace(/\s+/g, ' ');
  const setting = city
    ? `a sunny ${city}-area Southwest Florida home with palm trees and sandy soil`
    : 'a sunny Southwest Florida home with palm trees and tropical landscaping';
  const kind = mode === 'social-square' ? 'Photorealistic social tile' : 'Photorealistic scene';
  return `${kind} of ${setting}, illustrating ${subject}.`;
}

// ── providers ────────────────────────────────────────────────────────

const IMAGE_REQUEST_TIMEOUT_MS = 60_000;
const imageRequestSignal = () => (
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS)
    : undefined
);

async function callOpenAI({ model, quality, prompt, size }, { fetchFn = fetch } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return { skipped: true, reason: 'OPENAI_API_KEY not set' };
  }
  try {
    const res = await fetchFn('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
      signal: imageRequestSignal(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (isFatalOpenAIError(res.status)) {
        return { fatal: true, status: res.status, body: body.slice(0, 240) };
      }
      if (RETRYABLE_OPENAI_STATUSES.has(res.status)) {
        return { retryable: true, status: res.status, body: body.slice(0, 240) };
      }
      return { fatal: true, status: res.status, body: body.slice(0, 240) };
    }
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return { fatal: true, status: 'no_b64_in_response' };
    return { dataUrl: `data:image/png;base64,${b64}`, mimeType: 'image/png', model };
  } catch (err) {
    return { retryable: true, error: err.message };
  }
}

async function callGemini({ model, prompt, aspectRatio }, { fetchFn = fetch } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    return { skipped: true, reason: 'GEMINI_API_KEY not set' };
  }
  try {
    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    // Only image-native models accept imageConfig (callers gate on cfg.imageAspect);
    // sending it to the legacy text-model slug would 400 the whole attempt.
    if (aspectRatio) generationConfig.imageConfig = { aspectRatio };
    const res = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
        signal: imageRequestSignal(),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { fatal: true, status: res.status, body: body.slice(0, 240) };
    }
    const data = await res.json();
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) {
      const text = data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || '';
      return { fatal: true, status: 'no_image_in_response', body: text.slice(0, 200) };
    }
    return {
      dataUrl: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
      mimeType: part.inlineData.mimeType || 'image/png',
      model,
    };
  } catch (err) {
    return { retryable: true, error: err.message };
  }
}

// ── public API ───────────────────────────────────────────────────────

class ImageGenerator {
  constructor({ envChain = process.env.BLOG_IMAGE_PROVIDER, fetchFn = fetch } = {}) {
    this.chain = parseChain(envChain);
    if (!this.chain.length) {
      logger.warn('[image-generator] no valid providers in BLOG_IMAGE_PROVIDER; falling back to defaults');
      this.chain = parseChain(DEFAULT_CHAIN);
    }
    this._fetchFn = fetchFn;
    this._capabilityChecked = false;
    this._capabilityCache = null;
  }

  /**
   * generate({ title, topic, keyword, city, mode })
   *
   * mode: 'blog-hero' (default) or 'social-square'.
   * Returns: { dataUrl, mimeType, model, attempts: [...], prompt, alt }
   *   prompt — the exact generation prompt used;
   *   alt — accessibility text derived from the same subject/setting inputs
   *   as the prompt, so callers can stamp an alt that describes the ACTUAL
   *   generated image (null when a customPrompt made the fields unreliable).
   * Throws if every provider in the chain failed.
   */
  async generate({ title, topic, keyword, city, mode = 'blog-hero', shot, avoid, prompt: customPrompt } = {}) {
    const prompt = customPrompt || buildPrompt({ title, topic, keyword, city, mode, shot, avoid });
    const alt = customPrompt ? null : buildAltText({ title, topic, keyword, city, mode });
    const attempts = [];

    for (const slug of this.chain) {
      const cfg = MODEL_MAP[slug];
      const size = sizeFor(mode, cfg.api);
      let result;
      if (cfg.api === 'openai') {
        result = await callOpenAI({ model: cfg.model, quality: cfg.quality, prompt, size }, { fetchFn: this._fetchFn });
      } else if (cfg.api === 'gemini') {
        const aspectRatio = cfg.imageAspect ? (MODE_ASPECTS[mode] || MODE_ASPECTS['blog-hero']) : null;
        result = await callGemini({ model: cfg.model, prompt, aspectRatio }, { fetchFn: this._fetchFn });
      } else {
        result = { fatal: true, status: 'unknown_api' };
      }
      attempts.push({ provider: slug, result });

      if (result.dataUrl) {
        logger.info(`[image-generator] generated via ${slug} (${result.mimeType}, ${result.dataUrl.length} chars)`);
        return { dataUrl: result.dataUrl, mimeType: result.mimeType, model: slug, attempts, prompt, alt };
      }
      // Skipped / fatal / retryable → next provider. The whole point
      // of the chain is resilience: a 408/429/5xx on OpenAI should fall
      // through to Gemini, not abort the chain. Admin and social
      // callers do not retry, so bailing here used to defeat the
      // fallback entirely.
      if (result.skipped) {
        logger.info(`[image-generator] ${slug} skipped: ${result.reason}`);
      } else if (result.fatal) {
        logger.warn(`[image-generator] ${slug} fatal: ${result.status} ${result.body || ''}`);
      } else if (result.retryable) {
        logger.warn(`[image-generator] ${slug} retryable: ${result.status || result.error} — trying next provider`);
      }
    }

    const err = new Error(`image-generator: all providers failed (chain: ${this.chain.join(', ')})`);
    err.attempts = attempts;
    throw err;
  }

  /**
   * One-time provider capability check via OpenAI /v1/models. Logs
   * which providers in the chain are actually reachable. Safe to call
   * at startup; cached after the first hit.
   */
  async capabilityCheck() {
    if (this._capabilityChecked) return this._capabilityCache;
    const out = { checked_at: new Date(), providers: {} };
    if (process.env.OPENAI_API_KEY) {
      try {
        const res = await this._fetchFn('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        });
        if (res.ok) {
          const data = await res.json();
          const available = new Set((data?.data || []).map((m) => m.id));
          for (const slug of this.chain) {
            const cfg = MODEL_MAP[slug];
            if (cfg.api !== 'openai') continue;
            out.providers[slug] = available.has(cfg.model) ? 'available' : 'model_not_listed';
          }
        } else {
          for (const slug of this.chain) {
            if (MODEL_MAP[slug].api === 'openai') out.providers[slug] = `models_endpoint_${res.status}`;
          }
        }
      } catch (err) {
        for (const slug of this.chain) {
          if (MODEL_MAP[slug].api === 'openai') out.providers[slug] = `models_endpoint_error:${err.message}`;
        }
      }
    } else {
      for (const slug of this.chain) {
        if (MODEL_MAP[slug].api === 'openai') out.providers[slug] = 'OPENAI_API_KEY_missing';
      }
    }
    for (const slug of this.chain) {
      if (MODEL_MAP[slug].api === 'gemini') {
        out.providers[slug] = process.env.GEMINI_API_KEY ? 'key_present' : 'GEMINI_API_KEY_missing';
      }
    }
    this._capabilityChecked = true;
    this._capabilityCache = out;
    logger.info(`[image-generator] capability check: ${JSON.stringify(out.providers)}`);
    return out;
  }
}

// Default singleton — call sites can instantiate their own with
// a custom fetch in tests.
const defaultInstance = new ImageGenerator();

module.exports = defaultInstance;
module.exports.ImageGenerator = ImageGenerator;
module.exports._internals = {
  DEFAULT_CHAIN,
  MODEL_MAP,
  MODE_SIZES,
  MODE_ASPECTS,
  BODY_IMAGE_FRAMING,
  parseChain,
  isFatalOpenAIError,
  sizeFor,
  buildPrompt,
  buildAltText,
  callOpenAI,
  callGemini,
};
