/**
 * image-generator.js — provider-chained image generation for blog
 * heroes + social squares.
 *
 * Provider chain via env BLOG_IMAGE_PROVIDER (default:
 * "gpt-image-2,gemini-image-pro,gpt-image-1.5,gemini-image-best,gemini-image,gpt-image-1").
 * Each provider is tried in order; on 404 / model-not-found / 5xx we fall
 * through to the next. On the first 2xx with image bytes we return.
 *
 * Chain rationale (bake-off 2026-09-05): gpt-image-2 is the top-ranked
 * image model overall; Nano Banana Pro (gemini-3-pro-image, its OWN
 * selector MODEL_GEMINI_IMAGE_PRO) is a close second and cheaper; the
 * remaining Gemini legs are the flash Nano Banana line from
 * config/models.js (MODEL_GEMINI_IMAGE / MODEL_GEMINI_IMAGE_STABLE — do not
 * point those at the Pro model, that only duplicates the Pro leg).
 * gpt-image-1 stays as the LAST
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
const { GEMINI_IMAGE_PRO, GEMINI_IMAGE_BEST, GEMINI_IMAGE_STABLE } = require('../../config/models');

// Chain order (bake-off 2026-09-05, the same three prompts on every provider):
// gpt-image-2 best on photo, cartoon and infographic (it honored an exact
// caption list; ~75–90 s, ~$0.17); Nano Banana Pro (gemini-3-pro-image)
// second — photo and cartoon close behind, ~16 s, ~$0.13, but it added
// unrequested labels to the infographic; gpt-image-1.5 third (~35–40 s);
// the flash Nano Banana fourth (~8 s, cheapest, weakest); gpt-image-1 last.
const DEFAULT_CHAIN = 'gpt-image-2,gemini-image-pro,gpt-image-1.5,gemini-image-best,gemini-image,gpt-image-1';

const MODEL_MAP = {
  'gpt-image-2':   { api: 'openai', model: 'gpt-image-2',   quality: 'high' },
  'gpt-image-1.5': { api: 'openai', model: 'gpt-image-1.5', quality: 'high' },
  'gpt-image-1':   { api: 'openai', model: 'gpt-image-1',   quality: 'high' },
  // Image-native Gemini models (Nano Banana line, config/models.js). These
  // accept generationConfig.imageConfig.aspectRatio; the legacy 'gemini' slug
  // below is a text model with image modality and 400s on imageConfig, so
  // aspect stays prompt-only there (imageAspect flag gates the field).
  'gemini-image-pro':  { api: 'gemini', model: GEMINI_IMAGE_PRO, imageAspect: true },
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

// ── variation plan ───────────────────────────────────────────────────
//
// Owner direction 2026-09-05: the autopublished pictures all read as the same
// postcard (palms, tile roof, cobalt sky, subject in front) because the prompt
// pinned one setting and one style. Each image now gets a PLAN — a style, a
// setting, a time of day and a vantage — chosen deterministically from the
// post slug and the image's slot, so a post's hero and body images differ from
// each other AND from the last post's, and a re-run reproduces the same plan.
//
// Styles: photo (documentary), illustration (flat vector), cartoon (friendly,
// character-led), infographic (the one style that may carry text — ONLY the
// exact captions the caller supplies; every other style forbids readable text
// and all styles forbid logos and brand marks).
const IMAGE_STYLES = Object.freeze({
  photo: {
    label: 'Photorealistic scene',
    line: 'Style: candid documentary photograph, natural color and light, real-world detail; no illustration look.',
    allowsText: false,
  },
  illustration: {
    label: 'Flat illustration',
    line: 'Style: clean flat-vector illustration with simple shapes, limited palette (Waves blue #009CDE, gold #FFD700, warm neutrals), soft shadows, no photorealism.',
    allowsText: false,
  },
  cartoon: {
    label: 'Cartoon illustration',
    line: 'Style: friendly cartoon illustration with bold outlines, expressive characters, bright limited palette (Waves blue #009CDE and gold #FFD700 accents), playful but clear.',
    allowsText: false,
  },
  infographic: {
    label: 'Infographic',
    // No numbers or labels beyond the caption: the text rule allows only the
    // caption and the screen rejects every other string (Codex r12 P2).
    line: 'Style: clean modern infographic on a plain light background — simple flat icons, generous white space, Waves blue #009CDE and gold #FFD700 accents; no numbers, labels, or lettering other than the caption named below.',
    allowsText: true,
  },
});
// One style permutation per post: the hero takes the first entry and body
// slot k takes the k-th, so the hero and up to three body images never share
// a style (Codex r1 P2 on #3964). The hero still leans photo (search
// thumbnails): two posts in three put photo first.
const STYLE_KEYS = Object.freeze(Object.keys(IMAGE_STYLES));
function stylePermutation(slug) {
  const seed = hashString(`${slug || 'post'}:styles`);
  const pool = [...STYLE_KEYS];
  const out = [];
  let h = seed;
  while (pool.length) {
    h = Math.imul(h ^ (h >>> 13), 16777619) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]);
  }
  if (seed % 3 !== 0) {
    out.splice(out.indexOf('photo'), 1);
    out.unshift('photo');
  }
  return out;
}
// Settings carry NO time-of-day wording (time is chosen separately below), and
// the pool is chosen by what the article is ABOUT: a yard/turf/plant post
// stays outdoors, an equipment post sits where the equipment lives, an
// indoor-pest post stays indoors. Augmenting the yard pool was not enough — a
// kitchen-ant post still planned a lanai (Codex r3 P2 on #3964), so an indoor
// or equipment subject SELECTS its pool instead.
const SETTINGS = Object.freeze({
  yard: [
    'on a screened lanai looking out at the yard',
    'along a front walk beside a stucco wall and mulched bed',
    'at the curb of a quiet residential street',
    'at the edge of a pool cage with turf and shrubs beyond',
    'in a side yard between two homes, utility boxes and a hose bib',
    'in a backyard, dew on the grass',
    'under an overcast sky with soft, even light',
    'in a front yard, a sidewalk and mailbox at the edge of the frame',
  ],
  equipment: [
    'inside a residential garage, controller and tools on the wall, light through the open door',
    'at a workbench with parts laid out on a towel',
    'beside an outdoor utility wall with a control box and a hose bib',
    'on the driveway apron with gear laid out beside an open garage',
    'in a shaded side yard by the irrigation valve box',
  ],
  indoor: [
    'in a kitchen looking out through a window at the lawn',
    'in a laundry room doorway, baseboards and a threshold in view',
    'in a garage looking out toward the driveway',
    'along a hallway baseboard with a doorway to the yard',
    'at a pantry shelf with a window to the yard behind',
  ],
});
const EQUIPMENT_SUBJECT = /\b(controller|timer|clock|irrigation|sprinkler|spreader|mower|trimmer|sprayer|blower|hose|nozzle|equipment|tools?)\b/i;
// Indoor = an actual indoor cue (a room, "indoors", a baseboard) or a pest
// that only lives indoors. Ants, spiders, rodents, fleas and termites are NOT
// indoor cues on their own — a fire-ant-mound post is a lawn post — and an
// explicit lawn / yard / exterior cue wins over any pest noun (Codex r4 P2 on
// #3964).
const INDOOR_SUBJECT = /\b(kitchen|pantry|bathroom|bedroom|attic|closet|cabinets?|indoors?|inside|baseboards?|roach(es)?|cockroach(es)?|bed bugs?|silverfish|drain flies)\b/i;
const OUTDOOR_SUBJECT = /\b(lawn|turf|grass|sod|yard|mounds?|garden|hedges?|shrubs?|trees?|palms?|mulch|patio|lanai|pool|driveway|exterior|outdoors?|outside|perimeter|foundation)\b/i;
function settingsFor(subject) {
  const text = String(subject || '');
  if (EQUIPMENT_SUBJECT.test(text)) return [...SETTINGS.equipment];
  if (INDOOR_SUBJECT.test(text) && !OUTDOOR_SUBJECT.test(text)) return [...SETTINGS.indoor];
  return [...SETTINGS.yard];
}
const TIMES_OF_DAY = ['early morning', 'mid-morning', 'noon', 'late afternoon', 'golden hour', 'dusk'];
const VANTAGES = ['eye level', 'low angle from the ground', 'high angle looking down', 'over the shoulder', 'straight-on, centered', 'three-quarter view'];
// An infographic is a composition, not a scene: its plan names a LAYOUT in
// place of a yard/room setting, no time of day, and a fixed straight-on
// vantage — a photographic setting line contradicted the style's plain
// background and let providers draw the scene instead (Codex r10 P2 on #3964).
const INFOGRAPHIC_LAYOUTS = [
  'a left-to-right row of simple icons joined by arrows',
  'a parts diagram with plain callout lines and no labels',
  'a side-by-side comparison of two or three panels',
  'a checklist of icons with check and cross marks',
  'a circular process diagram of a few icon stages',
];
function hashString(input) {
  let h = 2166136261;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
// planFor({ slug, mode, index, captions, subject, style }) — deterministic per
// post + slot. index 0 is the hero; body slots are 1..n. `subject` picks the
// setting pool and must be what the image is ABOUT — the title plus the
// keyword or section heading, never the lead or meta copy: a coastal-lawn post
// whose thesis mentions irrigation is not an equipment post (Codex r2 P2 on
// #3964). A style the slot cannot support (an infographic with no captions)
// degrades to the post's UNUSED fourth style, so it still differs from the
// other slots.
function planFor({ slug, mode = 'blog-hero', index = 0, captions = [], subject = '', style: forced } = {}) {
  const seed = hashString(`${slug || 'post'}:${mode}:${index}`);
  const pick = (list, salt) => list[(seed + salt * 7919) % list.length];
  const perm = stylePermutation(slug);
  const slot = mode === 'blog-body' ? index : 0;
  let style = forced && IMAGE_STYLES[forced] ? forced : perm[slot % perm.length];
  if (style === 'infographic' && !(Array.isArray(captions) && captions.length)) {
    style = slot < 3 ? perm[3] : 'illustration';
  }
  if (style === 'infographic') {
    return { style, setting: pick(INFOGRAPHIC_LAYOUTS, 1), timeOfDay: '', vantage: 'straight-on, centered' };
  }
  return {
    style,
    setting: pick(settingsFor(subject), 1),
    timeOfDay: pick(TIMES_OF_DAY, 2),
    vantage: pick(VANTAGES, 3),
  };
}
// The style a slot regenerates in after a failed text/logo screen: one no
// sibling slot of the post uses (the permutation's unused fourth style, when
// the slot can carry it), else the slot's own style under a fresh seed — a
// fixed swap map put a retried hero into body-1's style (Codex r2 P2 on
// #3964).
function retryStyleFor({ slug, mode = 'blog-hero', index = 0, captions = [] } = {}) {
  const perm = stylePermutation(slug);
  const taken = new Set(perm.slice(0, 3));
  if (taken.has('infographic')) taken.add(perm[3]); // a caption-less infographic slot degrades to perm[3]
  const own = planFor({ slug, mode, index, captions }).style;
  const hasCaptions = Array.isArray(captions) && captions.length > 0;
  const free = STYLE_KEYS.filter((style) => !taken.has(style) && style !== own && (style !== 'infographic' || hasCaptions));
  return free[0] || own;
}
// Relevance guards every image carries, plus caller-supplied "must not
// depict" lines (a brief's rules — e.g. no repair scenes on a post that says
// Waves does not repair irrigation; no competitor vehicles on a comparison).
const STANDARD_GUARDS = [
  'no company logos, brand names, or brand marks of any kind — equipment, vehicles and uniforms are generic and unbranded',
  'no invented control-panel labels, dials with fake words, or gibberish lettering',
];
function buildPrompt({ title, topic, keyword, city, mode, shot, avoid, plan = null, captions = [], avoidDepicting = [] }) {
  const kind = mode === 'social-square' ? 'social media tile' : (mode === 'blog-body' ? 'in-article illustration' : 'blog hero image');
  const style = plan && IMAGE_STYLES[plan.style] ? IMAGE_STYLES[plan.style] : null;
  const base = style
    ? `A high-quality ${kind} (${style.label.toLowerCase()}) for a Southwest Florida pest control & lawn care business named "Waves Pest Control."`
    : `A high-quality, photorealistic ${kind} for a Southwest Florida pest control & lawn care business named "Waves Pest Control."`;
  // Body images name the SECTION (keyword) and carry its opening prose as
  // context (topic) — a generic heading ("What to expect") alone would
  // illustrate nothing in particular.
  const focus = (mode === 'blog-body' && keyword && topic && topic !== keyword)
    ? `Subject: ${keyword}. Context from the article: ${topic}`
    : `Subject: ${keyword || topic || title || 'pest control / lawn care service'}.`;
  // A planned image names ITS setting, time and vantage; the legacy line
  // (one fixed postcard) only remains for callers that pass no plan.
  // An infographic's plan is a layout on a plain background — no scene, time
  // of day, or camera framing, which would contradict the style line.
  const isInfographic = Boolean(plan) && plan.style === 'infographic';
  const local = isInfographic
    ? `Layout: ${plan.setting}, ${plan.vantage}, on a plain light background — no photographic scene, no time of day; at most one small Southwest Florida cue (a palm or wave icon).`
    : plan
    ? `Setting: ${plan.setting}, ${plan.timeOfDay}, ${city ? `a ${city}-area Southwest Florida home` : 'a Southwest Florida home'}; Southwest Florida cues stay subtle (one palm or a stucco wall is plenty — do not fill the frame with palms and a tile roof). Vantage: ${plan.vantage}.`
    : (city
      ? `Setting: a ${city}-area home or yard with characteristic SWFL landscaping (palm trees, sandy soil, bright sun).`
      : `Setting: SWFL residential — palm trees, tropical landscaping, sunny afternoon.`);
  // Aspect/dimension lives in the prompt because Gemini's generateContent
  // doesn't accept a size parameter — without this, Gemini-only deploys
  // return arbitrary aspect ratios for both blog heroes and social tiles.
  const composition = mode === 'social-square'
    ? `Composition: square 1:1 aspect ratio, 1024x1024.`
    : `Composition: landscape 3:2 aspect ratio, 1536x1024.`;
  // Brand palette is Waves Blue #009CDE + Gold #FFD700 (theme-brand.js); the
  // brand brief explicitly forbids teal, so steer the grade, don't paint it.
  const styleLine = style
    ? `${style.line} Brand palette: blue #009CDE, gold #FFD700 — no teal color cast.`
    : `Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast).`;
  const captionList = (style && style.allowsText ? captions : []).map((c) => String(c || '').trim()).filter(Boolean);
  const textRule = captionList.length
    ? `The ONLY text in the image is exactly: ${captionList.map((c) => `"${c}"`).join(', ')} — spelled exactly, nothing else written anywhere.`
    : 'No text, words, letters, numbers, watermarks, or logos anywhere in the image.';
  const guards = `Must not depict: ${[...STANDARD_GUARDS, ...(Array.isArray(avoidDepicting) ? avoidDepicting : [])].map((g) => String(g || '').trim()).filter(Boolean).join('; ')}.`;
  const framing = mode === 'blog-body' && !isInfographic ? (BODY_IMAGE_FRAMING[shot] || BODY_IMAGE_FRAMING['close-up']) : '';
  const distinct = (mode === 'blog-body' && avoid)
    ? `This image must look clearly different from the article's hero image (a wide establishing shot of: ${avoid}) — a different scene, distance and angle, not a variation of it.`
    : '';
  return [base, focus, local, framing, composition, styleLine, textRule, guards, distinct].filter(Boolean).join(' ');
}

// Alt text describing the image buildPrompt actually asks for — derived from
// the SAME inputs (subject + setting), so the shipped hero_image_alt can
// never describe a different picture than the one generated. Writers author
// alt BEFORE the hero exists; publishers overwrite it with this at
// generation time (astro-publisher stamps it alongside the hero src).
function buildAltText({ title, topic, keyword, city, mode = 'blog-hero', plan = null } = {}) {
  let subject = String(keyword || topic || title || 'pest control and lawn care service').trim().replace(/\s+/g, ' ');
  // Body images are generated from heading + section lead; the alt describes
  // the same context (a generic heading alone tells a screen reader nothing).
  if (mode === 'blog-body' && keyword && topic && topic !== keyword) {
    const lead = String(topic).trim().replace(/\s+/g, ' ');
    const clipped = lead.length > 140 ? `${lead.slice(0, 140).replace(/\s+\S*$/, '')}…` : lead;
    subject = `${String(keyword).trim()} — ${clipped}`.replace(/[.!?]+$/, '');
  }
  // A planned image is described by ITS setting (the prompt's), not the
  // legacy postcard — the alt must match the picture that was asked for
  // (pre-push Codex P1 on a3920f4fb).
  const plannedSetting = plan && plan.setting
    ? `${String(plan.setting).split(',')[0].trim()}${plan.timeOfDay ? `, ${plan.timeOfDay}` : ''}, at a ${city ? `${city}-area ` : ''}Southwest Florida home`
    : null;
  const setting = plannedSetting || (city
    ? `a sunny ${city}-area Southwest Florida home with palm trees and sandy soil`
    : 'a sunny Southwest Florida home with palm trees and tropical landscaping');
  const styled = plan && IMAGE_STYLES[plan.style] ? IMAGE_STYLES[plan.style].label : null;
  const kind = styled
    ? (mode === 'social-square' ? `${styled} social tile` : styled)
    : (mode === 'social-square' ? 'Photorealistic social tile' : 'Photorealistic scene');
  // An infographic has a layout, not a setting (Codex r10 P2 on #3964).
  if (plan && plan.style === 'infographic') return `${kind} illustrating ${subject}: ${plan.setting}.`;
  return `${kind} of ${setting}, illustrating ${subject}.`;
}

// ── providers ────────────────────────────────────────────────────────

// gpt-image-2 at high quality routinely needs more than 60 s; at 60 s every
// autonomous hero and body image fell through to gpt-image-1.5 (Rain Bird run
// 2026-09-05: three timeouts, three fallbacks). Env-tunable for ops.
const IMAGE_REQUEST_TIMEOUT_MS = (() => {
  const n = Number(process.env.BLOG_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 10_000 ? n : 180_000;
})();
// The whole chain shares one deadline: the slow primary keeps its full
// allowance, later legs get what is left, and a leg with less than the floor
// remaining is skipped — six hung providers must not hold an admin request or
// the exclusive scheduled-content tick for 18 minutes (Codex r5 P2 on #3964).
const IMAGE_CHAIN_BUDGET_MS = (() => {
  const n = Number(process.env.BLOG_IMAGE_CHAIN_BUDGET_MS);
  return Number.isFinite(n) && n >= IMAGE_REQUEST_TIMEOUT_MS ? n : Math.max(IMAGE_REQUEST_TIMEOUT_MS * 2, 360_000);
})();
const IMAGE_LEG_FLOOR_MS = 15_000;
const legTimeoutMs = (deadline, now = Date.now()) => {
  const remaining = deadline - now;
  if (remaining < IMAGE_LEG_FLOOR_MS) return null;
  return Math.min(IMAGE_REQUEST_TIMEOUT_MS, remaining);
};
const imageRequestSignal = (timeoutMs = IMAGE_REQUEST_TIMEOUT_MS) => (
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
);

async function callOpenAI({ model, quality, prompt, size }, { fetchFn = fetch, timeoutMs } = {}) {
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
      signal: imageRequestSignal(timeoutMs),
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

async function callGemini({ model, prompt, aspectRatio }, { fetchFn = fetch, timeoutMs } = {}) {
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
        signal: imageRequestSignal(timeoutMs),
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
  constructor({ envChain = process.env.BLOG_IMAGE_PROVIDER, fetchFn = fetch, chainBudgetMs = IMAGE_CHAIN_BUDGET_MS, now = Date.now } = {}) {
    this.chain = parseChain(envChain);
    this._chainBudgetMs = chainBudgetMs;
    this._now = now;
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
  // deadlineAt — an absolute ms timestamp the whole call must respect; a
  // caller that generates more than once for one slot (screen retry) passes
  // the same deadline to both calls so the slot never gets a second budget.
  async generate({ title, topic, keyword, city, mode = 'blog-hero', shot, avoid, plan = null, captions = [], avoidDepicting = [], prompt: customPrompt, deadlineAt = null } = {}) {
    const prompt = customPrompt || buildPrompt({ title, topic, keyword, city, mode, shot, avoid, plan, captions, avoidDepicting });
    const alt = customPrompt ? null : buildAltText({ title, topic, keyword, city, mode, plan });
    const attempts = [];
    const deadline = Number.isFinite(deadlineAt) ? deadlineAt : this._now() + this._chainBudgetMs;

    for (const slug of this.chain) {
      const cfg = MODEL_MAP[slug];
      const size = sizeFor(mode, cfg.api);
      const timeoutMs = legTimeoutMs(deadline, this._now());
      let result;
      if (timeoutMs === null) {
        // A spent budget is a timing condition, not a verdict on the provider:
        // retryable so the runner retries the post instead of parking it
        // (Codex r10 P2 on #3964).
        result = { skipped: true, retryable: true, reason: `chain budget exhausted (${this._chainBudgetMs} ms)` };
      } else if (cfg.api === 'openai') {
        result = await callOpenAI({ model: cfg.model, quality: cfg.quality, prompt, size }, { fetchFn: this._fetchFn, timeoutMs });
      } else if (cfg.api === 'gemini') {
        const aspectRatio = cfg.imageAspect ? (MODE_ASPECTS[mode] || MODE_ASPECTS['blog-hero']) : null;
        result = await callGemini({ model: cfg.model, prompt, aspectRatio }, { fetchFn: this._fetchFn, timeoutMs });
      } else {
        result = { fatal: true, status: 'unknown_api' };
      }
      attempts.push({ provider: slug, result });

      if (result.dataUrl) {
        logger.info(`[image-generator] generated via ${slug} (${result.mimeType}, ${result.dataUrl.length} chars)`);
        return { dataUrl: result.dataUrl, mimeType: result.mimeType, model: slug, attempts, prompt, alt, plan: plan || null };
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
// Public: the publisher plans each image before generating it (pre-push
// Codex P1 on e8b864170 — an _internals-only export would have thrown on
// every autonomous publish).
module.exports.planFor = planFor;
module.exports.retryStyleFor = retryStyleFor;
module.exports.IMAGE_CHAIN_BUDGET_MS = IMAGE_CHAIN_BUDGET_MS;
module.exports.IMAGE_STYLES = IMAGE_STYLES;
module.exports._internals = {
  stylePermutation,
  retryStyleFor,
  settingsFor,
  SETTINGS,
  INFOGRAPHIC_LAYOUTS,
  DEFAULT_CHAIN,
  MODEL_MAP,
  MODE_SIZES,
  MODE_ASPECTS,
  BODY_IMAGE_FRAMING,
  IMAGE_STYLES,
  planFor,
  hashString,
  IMAGE_REQUEST_TIMEOUT_MS,
  IMAGE_CHAIN_BUDGET_MS,
  IMAGE_LEG_FLOOR_MS,
  legTimeoutMs,
  parseChain,
  isFatalOpenAIError,
  sizeFor,
  buildPrompt,
  buildAltText,
  callOpenAI,
  callGemini,
};
