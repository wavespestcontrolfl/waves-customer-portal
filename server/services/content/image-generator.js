/**
 * image-generator.js — provider-chained image generation for blog
 * heroes + social squares.
 *
 * Provider chain via env BLOG_IMAGE_PROVIDER (default:
 * "gpt-image-2,gpt-image-1.5,gpt-image-1,gemini"). Each provider is
 * tried in order; on 404 / model-not-found / 5xx we fall through
 * to the next. On the first 2xx with image bytes we return.
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

const DEFAULT_CHAIN = 'gpt-image-2,gpt-image-1.5,gpt-image-1,gemini';

const MODEL_MAP = {
  'gpt-image-2':   { api: 'openai', model: 'gpt-image-2',   quality: 'high' },
  'gpt-image-1.5': { api: 'openai', model: 'gpt-image-1.5', quality: 'high' },
  'gpt-image-1':   { api: 'openai', model: 'gpt-image-1',   quality: 'high' },
  'gemini':        { api: 'gemini', model: 'gemini-2.5-flash' },
};

const MODE_SIZES = {
  'blog-hero':     { openai: '1536x1024', gemini: '1536x1024' },
  'social-square': { openai: '1024x1024', gemini: '1024x1024' },
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

// Topic classifiers — pick a scene that matches the real Waves experience
// instead of generic stock. UI topics get a Waves-style app mockup; pest
// topics get a trust-building technician scene (never a gross bug closeup).
function _isUiTopic(s) { return /\b(estimate|quote|pricing|price|portal|account|dashboard|report|service history|timeline|book|booking|schedule|appointment|invoice|warranty|re-?treat)\b/i.test(s); }
function _isPestIdTopic(s) { return /\b(ant|roach|cockroach|spider|termite|rodent|rat|mouse|mice|mosquito|midge|no-see-um|flea|tick|wasp|bee|silverfish|earwig|bug|pest)\b/i.test(s); }
function _isLawnTopic(s) { return /\b(lawn|grass|turf|st\.?\s*augustine|chinch|mole cricket|grub|fertiliz|weed|fungus|sod|aeration)\b/i.test(s); }

const BRAND_STYLE = 'Visual style: clean, bright, modern coastal Southwest Florida. Waves brand palette — deep ocean blue and aqua/teal (#0ea5e9) as the primary accents, generous clean white and light gray, with small warm yellow/coral accents ONLY for a highlight or warning. Photorealistic, trustworthy, professional, reassuring — never fear-based. Do NOT show dark, gross, or scary macro pest closeups. No text, words, letters, numbers, watermarks, or logos anywhere in the image (brand placement is added by the site, not baked into the image).';

// Relevance rule (per owner feedback): a pest closeup doesn't help a reader
// decide to hire — the hero must show what the homeowner is BUYING. The pest
// name is topical CONTEXT for the scene, never the visual subject.
const RELEVANCE = 'Relevance is critical: the image must show what the homeowner is buying — the Waves service in action (a uniformed technician at work, a protected SWFL home or yard), the Waves app/estimate/report, or a reassuring clean-home outcome. NEVER make a pest the subject or show a pest closeup, even when the post is about that pest — a homeowner deciding whether to hire wants to see the service and the result, not the bug.';

function buildPrompt({ title, topic, keyword, city, mode }) {
  const subject = keyword || topic || title || 'professional pest control service';
  const blob = `${keyword || ''} ${topic || ''} ${title || ''}`;
  // The topic is framed as what the post is ABOUT (context for the scene),
  // not as "render this" — so a pest name never becomes the visual subject.
  const base = `A high-quality, photorealistic ${mode === 'social-square' ? 'social media tile' : 'blog hero image'} for a "Waves Pest Control" blog post about "${subject}" (Waves is a family-owned Southwest Florida pest control & lawn care company).`;
  const home = city
    ? `a clean, modern ${city}-area Florida home with characteristic SWFL landscaping (palm trees, screened lanai, sandy soil, bright sun)`
    : `a clean, modern Southwest Florida home with palm trees, a screened lanai, and bright tropical landscaping`;

  let scene;
  if (_isUiTopic(blob)) {
    // Real-Waves-UI reference: estimate flow / customer portal / digital report / service timeline.
    scene = `Scene: a smartphone or tablet held in front of ${home}, its screen showing a clean Waves-style app interface — rounded cards with deep-blue and teal accents — such as a simple multi-step estimate/quote flow OR a customer dashboard with a service-history list, a small property treatment-map thumbnail, and green check icons. The interface should look like a polished, real pest-control website/customer-portal experience, NOT a generic or unrelated app. The screen shows only simple icons, a map pin, checkmarks, and colored shapes — no readable text or numbers on the screen.`;
  } else if (_isPestIdTopic(blob)) {
    scene = `Scene: a uniformed, professional Waves technician inspecting or treating ${home} — foundation, entry points, eaves/soffits, and yard — i.e. the SERVICE that resolves this post's topic, conveying local expertise and trust. Do not feature the pest itself.`;
  } else {
    scene = `Scene: the Waves service for this topic, shown at ${home} in a clean, trust-building, service-focused way.`;
  }
  const lawn = _isLawnTopic(blob) ? ' This is a lawn-care topic, so include fresh, healthy green accents while keeping the Waves blue/teal identity present.' : '';

  // Aspect/dimension lives in the prompt because Gemini's generateContent
  // doesn't accept a size parameter — without this, Gemini-only deploys
  // return arbitrary aspect ratios for both blog heroes and social tiles.
  const composition = mode === 'social-square'
    ? `Composition: square 1:1 aspect ratio, 1024x1024.`
    : `Composition: landscape 3:2 aspect ratio, 1536x1024, with clean negative space for an optional text overlay.`;
  return [base, scene + lawn, composition, RELEVANCE, BRAND_STYLE].join(' ');
}

// ── providers ────────────────────────────────────────────────────────

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

async function callGemini({ model, prompt }, { fetchFn = fetch } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    return { skipped: true, reason: 'GEMINI_API_KEY not set' };
  }
  try {
    const res = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
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
   * Returns: { dataUrl, mimeType, model, attempts: [...] }
   * Throws if every provider in the chain failed.
   */
  async generate({ title, topic, keyword, city, mode = 'blog-hero', prompt: customPrompt } = {}) {
    const prompt = customPrompt || buildPrompt({ title, topic, keyword, city, mode });
    const attempts = [];

    for (const slug of this.chain) {
      const cfg = MODEL_MAP[slug];
      const size = sizeFor(mode, cfg.api);
      let result;
      if (cfg.api === 'openai') {
        result = await callOpenAI({ model: cfg.model, quality: cfg.quality, prompt, size }, { fetchFn: this._fetchFn });
      } else if (cfg.api === 'gemini') {
        result = await callGemini({ model: cfg.model, prompt }, { fetchFn: this._fetchFn });
      } else {
        result = { fatal: true, status: 'unknown_api' };
      }
      attempts.push({ provider: slug, result });

      if (result.dataUrl) {
        logger.info(`[image-generator] generated via ${slug} (${result.mimeType}, ${result.dataUrl.length} chars)`);
        return { dataUrl: result.dataUrl, mimeType: result.mimeType, model: slug, attempts };
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
  parseChain,
  isFatalOpenAIError,
  sizeFor,
  buildPrompt,
  callOpenAI,
  callGemini,
};
