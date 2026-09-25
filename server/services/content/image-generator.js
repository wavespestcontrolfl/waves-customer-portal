/**
 * image-generator.js — provider-chained image generation for blog
 * heroes + social squares.
 *
 * Provider chain via env BLOG_IMAGE_PROVIDER (default:
 * "gpt-image-2,gpt-image-1.5,gpt-image-1"). Each provider is tried in
 * order; on 404 / model-not-found / 5xx we fall through to the next. On the
 * first 2xx with image bytes we return.
 *
 * ⛔ NO PIXEL-WATERMARKED PROVIDERS (owner directive 2026-09-24): every
 * Gemini image model (the Nano Banana line and the legacy text-model slug)
 * embeds Google's SynthID watermark in the PIXELS. Unlike the C2PA manifest
 * (metadata, stripped by the webp re-encode), SynthID survives re-encoding
 * and is not removable — so those providers are never used, not even as a
 * fallback. MODEL_MAP tags them `pixelWatermark`; parseChain drops them from
 * ANY chain (default or env) unless ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS=true
 * is set on purpose. OpenAI's gpt-image line attaches C2PA metadata only.
 * When the OpenAI ladder is exhausted the call throws and the slot parks /
 * retries — it never quietly falls through to a watermarking model. With the
 * override set and no env chain, the pre-09-24 chain (Gemini legs interleaved)
 * is the default again, so the kill switch alone restores the old fallbacks.
 *
 * Chain rationale: gpt-image-2 is the top-ranked image model overall
 * (bake-off 2026-09-05); gpt-image-1.5 and gpt-image-1 are the OpenAI
 * fallbacks — an account without the newer models must not lose its only
 * working provider. The Gemini legs (Nano Banana Pro = MODEL_GEMINI_IMAGE_PRO,
 * the flash line = MODEL_GEMINI_IMAGE / MODEL_GEMINI_IMAGE_STABLE, and the
 * legacy 'gemini' text-model slug) stay in MODEL_MAP only for the explicit
 * override above — they are SynthID-watermarked.
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

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { GEMINI_IMAGE_PRO, GEMINI_IMAGE_BEST, GEMINI_IMAGE_STABLE } = require('../../config/models');

// ── Waves uniform logo reference ─────────────────────────────────────
// Owner directive 2026-09-24 (Adam): the Waves logo ON the technician's cap
// and right chest. A prompt-only logo came back as gibberish lettering (the
// 09-23 trade-off), so the real mark rides along as a REFERENCE IMAGE on the
// OpenAI legs (/v1/images/edits — gpt-image reproduces an attached mark
// faithfully). Gemini legs take no reference and keep the logo-free line.
// A leg that REJECTS the request outright with the reference (a non-retryable
// 4xx from /v1/images/edits) is retried once logo-free before the chain moves
// on — a rejected reference must not cost the image. Retryable failures
// (408/429/5xx, timeouts) fall through to the next provider exactly as before.
// OPT-IN per call (generate({ uniformLogo: true })): only a caller whose
// text/logo screen knows to allow the uniform logo (the astro publisher) may
// attach it — a social tile or newsletter image has no screen to catch the
// mark pasted elsewhere (pre-push fallback P1 on 440cc8b947).
// Kill switch: BLOG_IMAGE_UNIFORM_LOGO=false (prompt falls back to logo-free).
const UNIFORM_LOGO_ENV = 'BLOG_IMAGE_UNIFORM_LOGO';
const UNIFORM_LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'brand', 'waves-logo.png');
function uniformLogoEnabled() { return !/^(false|0|off|no)$/i.test(String(process.env[UNIFORM_LOGO_ENV] || '').trim()); }
let uniformLogoCache;
function loadUniformLogo() {
  if (!uniformLogoEnabled()) return null;
  if (uniformLogoCache !== undefined) return uniformLogoCache;
  try {
    uniformLogoCache = fs.readFileSync(UNIFORM_LOGO_PATH);
  } catch (err) {
    logger.warn(`[image-generator] uniform logo reference unavailable (${err.message}) — generating without the logo`);
    uniformLogoCache = null;
  }
  return uniformLogoCache;
}

// ── Waves van wrap reference ─────────────────────────────────────────
// Owner ruling 2026-09-24 (Adam): a generated scene that shows the Waves van
// shows the REAL van — a Ford Transit 250 medium-roof cargo van wearing the
// CURRENT wrap — instead of a plain unmarked stand-in. The owner explicitly
// chose the current wrap (it reads "WAVES" / "Lawn & Pest") over waiting for
// a re-wrap. Two reference photos (side three-quarter + rear doors) ride on
// the OpenAI legs the same way the uniform logo does — /v1/images/edits,
// attached only when the caller opts in (generate({ vanWrap: true })) AND
// the image's plan actually places a van in the scene (plan.van). A leg that
// REJECTS the request with the references attached (a non-retryable 4xx from
// /v1/images/edits) is retried once with no references at all (logo-free AND
// van-plain), exactly like the logo path. Gemini legs never take a
// reference and keep the plain VAN_LINE.
// OPT-IN per call, independent of the logo opt-in, so either can be revoked
// on its own: only a caller whose screen knows to allow the van wrap (the
// astro publisher) may attach it.
// Kill switch: BLOG_IMAGE_VAN_WRAP=false (prompt falls back to the plain van).
const VAN_WRAP_ENV = 'BLOG_IMAGE_VAN_WRAP';
const VAN_WRAP_SIDE_PATH = path.join(__dirname, '..', '..', 'assets', 'brand', 'waves-van-side.png');
const VAN_WRAP_REAR_PATH = path.join(__dirname, '..', '..', 'assets', 'brand', 'waves-van-rear.png');
function vanWrapEnabled() { return !/^(false|0|off|no)$/i.test(String(process.env[VAN_WRAP_ENV] || '').trim()); }
let vanWrapCache;
function loadVanWrapReferences() {
  if (!vanWrapEnabled()) return null;
  if (vanWrapCache !== undefined) return vanWrapCache;
  try {
    vanWrapCache = [fs.readFileSync(VAN_WRAP_SIDE_PATH), fs.readFileSync(VAN_WRAP_REAR_PATH)];
  } catch (err) {
    logger.warn(`[image-generator] van wrap reference unavailable (${err.message}) — generating without the van wrap`);
    vanWrapCache = null;
  }
  return vanWrapCache;
}

// Chain order (bake-off 2026-09-05, the same three prompts on every provider):
// gpt-image-2 best on photo, cartoon and infographic (it honored an exact
// caption list; ~75–90 s, ~$0.17); gpt-image-1.5 next (~35–40 s); gpt-image-1
// last. The Gemini legs that used to sit between them were removed 2026-09-24
// (SynthID pixel watermark — see the header); OpenAI-only by design.
// gpt-image-2.5-sunburst leads since 2026-09-25 (owner: render on Images
// 2.5): with the reference prompts below it put the uniform badge on the
// correct chest 8 of 8 times where gpt-image-2 managed 1 of 12, and drew one
// correct van every time (~45 s per image). gpt-image-2 stays the first
// fallback.
const DEFAULT_CHAIN = 'gpt-image-2.5-sunburst,gpt-image-2,gpt-image-1.5,gpt-image-1';
// The pre-2026-09-24 chain (bake-off order, Gemini legs interleaved). Used as
// the default ONLY while ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS=true, so the
// documented kill switch restores the old fallback legs during an OpenAI
// outage without also requiring a BLOG_/SOCIAL_IMAGE_PROVIDER change.
const WATERMARK_ALLOWED_DEFAULT_CHAIN = 'gpt-image-2.5-sunburst,gpt-image-2,gemini-image-pro,gpt-image-1.5,gemini-image-best,gemini-image,gpt-image-1';

const MODEL_MAP = {
  'gpt-image-2.5-sunburst': { api: 'openai', model: 'gpt-image-2.5-sunburst', quality: 'high' },
  'gpt-image-2':   { api: 'openai', model: 'gpt-image-2',   quality: 'high' },
  'gpt-image-1.5': { api: 'openai', model: 'gpt-image-1.5', quality: 'high' },
  'gpt-image-1':   { api: 'openai', model: 'gpt-image-1',   quality: 'high' },
  // Image-native Gemini models (Nano Banana line, config/models.js). These
  // accept generationConfig.imageConfig.aspectRatio; the legacy 'gemini' slug
  // below is a text model with image modality and 400s on imageConfig, so
  // aspect stays prompt-only there (imageAspect flag gates the field).
  // ALL Gemini image output carries Google's SynthID pixel watermark —
  // `pixelWatermark` keeps them out of every chain unless explicitly allowed.
  'gemini-image-pro':  { api: 'gemini', model: GEMINI_IMAGE_PRO, imageAspect: true, pixelWatermark: 'synthid' },
  'gemini-image-best': { api: 'gemini', model: GEMINI_IMAGE_BEST, imageAspect: true, pixelWatermark: 'synthid' },
  'gemini-image':      { api: 'gemini', model: GEMINI_IMAGE_STABLE, imageAspect: true, pixelWatermark: 'synthid' },
  'gemini':        { api: 'gemini', model: 'gemini-2.5-flash', pixelWatermark: 'synthid' },
};

// Owner directive 2026-09-24: no invisible watermarks on any published image.
// The override exists only so a deliberate operator run (never prod defaults)
// can reach a watermarking model; it must be the literal string 'true'.
const PIXEL_WATERMARK_OVERRIDE_ENV = 'ALLOW_PIXEL_WATERMARKED_IMAGE_PROVIDERS';
function pixelWatermarkAllowed() { return process.env[PIXEL_WATERMARK_OVERRIDE_ENV] === 'true'; }

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
// Statuses under which an /v1/images/edits request may have been refused
// BECAUSE of the attached reference (bad request / payload / media type /
// unprocessable). A 401/403/404 or an empty 200 is the model or account, not
// the reference — removing the logo cannot fix it (Codex r1 P2 on #4761).
const REFERENCE_REJECT_STATUSES = new Set([400, 413, 415, 422]);

// ── pure helpers (test-friendly) ─────────────────────────────────────

// { allowPixelWatermark } defaults to the env override; every chain — the
// default AND an env/constructor override — is filtered, so a stale
// BLOG_IMAGE_PROVIDER / SOCIAL_IMAGE_PROVIDER naming a Gemini slug cannot
// reintroduce a watermarking provider. Dropped slugs are logged once per
// distinct chain string so the operator sees why a leg vanished.
const warnedChains = new Set();
function parseChain(envValue, { allowPixelWatermark = pixelWatermarkAllowed() } = {}) {
  const raw = String(envValue || (allowPixelWatermark ? WATERMARK_ALLOWED_DEFAULT_CHAIN : DEFAULT_CHAIN));
  const known = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => MODEL_MAP[s]);
  if (allowPixelWatermark) return known;
  const dropped = known.filter((s) => MODEL_MAP[s].pixelWatermark);
  if (dropped.length && !warnedChains.has(raw)) {
    warnedChains.add(raw);
    logger.warn(`[image-generator] dropped pixel-watermarked provider(s) from the chain: ${dropped.join(', ')} (owner directive 2026-09-24 — set ${PIXEL_WATERMARK_OVERRIDE_ENV}=true only for a deliberate run)`);
  }
  return known.filter((s) => !MODEL_MAP[s].pixelWatermark);
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
function settingCategoryFor(subject) {
  const text = String(subject || '');
  if (EQUIPMENT_SUBJECT.test(text)) return 'equipment';
  if (INDOOR_SUBJECT.test(text) && !OUTDOOR_SUBJECT.test(text)) return 'indoor';
  return 'yard';
}
function settingsFor(subject) {
  return [...SETTINGS[settingCategoryFor(subject)]];
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
  const category = settingCategoryFor(subject);
  return {
    style,
    setting: pick(SETTINGS[category], 1),
    timeOfDay: pick(TIMES_OF_DAY, 2),
    vantage: pick(VANTAGES, 3),
    // Owner ask 2026-09-23: the Waves van in the background of SOME exterior
    // scenes. Yard settings only (a van in a kitchen is a contradiction), and
    // about one in three so the variation directive (2026-09-05) still holds.
    // Whether that van is UNMARKED or wears the real wrap is a
    // GENERATION-TIME decision, not a planning one — see the van wrap
    // reference block above and VAN_WRAP_LINE (owner ruling 2026-09-24).
    van: category === 'yard' && (seed + 4 * 7919) % 3 === 0,
  };
}
const VAN_LINE = 'In the background, a solid Waves-blue (#009CDE) Ford Transit 250 medium-roof cargo van parked at the curb or in the driveway — plain and unmarked, no lettering, no logo, not the focus of the shot.';
// Owner ruling 2026-09-24 (Adam): the van in the background wears the REAL
// current wrap, reproduced faithfully from the two attached reference
// photos (waves-van-side.png, waves-van-rear.png) — the owner chose the
// current wrap (it reads the retired "WAVES" / "Lawn & Pest" name) over
// waiting for a re-wrap. Used only when the caller opts in
// (generate({ vanWrap: true })) and the references actually attach.
const VAN_WRAP_LINE = [
  'VAN: Park exactly ONE physical Waves van several metres behind the main action, at the curb or in the driveway. Show it once at a single side or slight rear-three-quarter angle, fully inside the frame, separated from the subject, and occupying approximately 20–30% of the image width; it stays clearly secondary. Include no second, partial, mirrored, or reflected van.',
  'Faithfully reproduce, in the image\'s own style, the Ford Transit 250 medium-roof body and bright-blue halftone wrap from the van photos. Keep WAVES, Lawn & Pest, Wave Goodbye to Pests!, 941-241-2459, and GoWavesFL.com as separate wrap elements. The phone number and web address must be exact; leave tiny text unresolved rather than inventing other digits or merging the web address with the slogan.',
].join(' ');
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
  'no company logos, brand names, or brand marks of any kind — equipment and vehicles are generic and unbranded, and uniforms carry no logo or lettering (only the uniform COLORS follow the Waves uniform line)',
  'no invented control-panel labels, dials with fake words, or gibberish lettering',
];
// Owner directive 2026-09-23 (Adam, after the Bradenton WDO hero showed a tech in
// a blue long-sleeve and khakis): any Waves technician in a generated image wears
// the REAL uniform. Every scene mode carries the line — a hero, body slot or social
// tile can all put a person in frame. Infographics draw no people at all
// (INFOGRAPHIC_NO_PEOPLE_LINE). Without a reference image (Gemini legs, kill
// switch, missing asset) the logo stays OFF the shirt/cap: generators render
// a prompt-only mark as gibberish and the text/logo screen would reject it.
const WAVES_UNIFORM_LINE = 'If a Waves technician appears, they wear the real Waves uniform: a solid red long-sleeve polo (a small blank badge on the left chest is fine), a baseball cap that is either light blue or red, and plain black or dark navy work pants — never a blue shirt, never khaki or tan pants; shirt and cap carry no readable logo or lettering.';

// Owner directive 2026-09-24 (Adam): with the real logo attached as the
// reference image, the technician carries it on the cap and the RIGHT chest —
// and nowhere else in the picture.
const WAVES_UNIFORM_LOGO_LINE = [
  'TECHNICIAN: If the scene includes a technician, include exactly one. Use a solid bright-red long-sleeve polo with both sleeves fully extended to the wrists, a solid light-blue or red baseball cap, plain black or dark-navy work pants, dark boots, and optional plain gloves.',
  'Keep the upper torso in a near-front pose with the cap front, button placket, and both chest panels visible, and arms, straps, hoses, handles, and tools below or beside the chest; the anatomical right hand and arm appear on the viewer-left side.',
  'Include exactly two compact embroidered badges reproducing the COMPLETE Waves logo image: a roughly 2-inch badge centered on the cap front and a roughly 3-inch badge on the wearer\'s anatomical RIGHT chest. The shirt badge is clearly LEFT of the button placket as the viewer sees it, directly below the viewer-left collarbone and above the wearer\'s right arm. The viewer-right chest is uninterrupted red fabric.',
  'Use the complete mascot-and-wording logo rather than an isolated W or mascot fragment. Place no logo on sleeves, back, pants, gloves, or equipment. If the scene has no technician, do not use the logo image at all.',
].join(' ');

// An infographic draws no people: it can carry neither the logo reference
// nor a judgeable uniform, and the audit would flag any logo-free technician
// icon it produced — so the style excludes figures outright (Codex r3 P2 on
// #4761, superseding the "infographic carries the uniform line" P2 on #4696).
const INFOGRAPHIC_NO_PEOPLE_LINE = 'Do not draw people, technician figures, faces, hands or mascots — flat icons of tools, pests, plants, homes and yards only.';

// What each combination of attached references changes in a scene prompt,
// keyed `${withLogo}/${withVanWrap}`: the uniform line, the van line, the
// no-text rule and the brand guard. With the logo reference the ONLY marks
// allowed are the Waves logo on the technician's cap and chest; with the van
// wrap reference, the wrap on the one van in VAN_WRAP_LINE; everything else
// stays unbranded. One lookup instead of a branch per combination (Codex r12
// P2 on #4785).
const NO_TEXT = 'No text, words, letters, numbers, watermarks, or logos anywhere in the image';
const LOGO_TEXT_EXCEPTION = "the Waves logo on the technician's cap and right chest";
const VAN_TEXT_EXCEPTION = 'the Waves wrap text and graphics on the one van described above';
const REFERENCE_CLAUSES = {
  'false/false': { uniform: WAVES_UNIFORM_LINE, van: VAN_LINE, noText: `${NO_TEXT}.`, guard: STANDARD_GUARDS[0] },
  'true/false': {
    uniform: WAVES_UNIFORM_LOGO_LINE,
    van: VAN_LINE,
    noText: `${NO_TEXT}, other than ${LOGO_TEXT_EXCEPTION}.`,
    guard: 'no company logos, brand names, or brand marks other than the Waves logo on the technician\'s cap and chest — equipment and vehicles are generic and unbranded',
  },
  'false/true': {
    uniform: WAVES_UNIFORM_LINE,
    van: VAN_WRAP_LINE,
    noText: `${NO_TEXT}, other than ${VAN_TEXT_EXCEPTION}.`,
    guard: 'no company logos, brand names, or brand marks other than the Waves wrap on the one van described above — every other vehicle, and all equipment, is generic and unbranded',
  },
  'true/true': {
    uniform: WAVES_UNIFORM_LOGO_LINE,
    van: VAN_WRAP_LINE,
    noText: `${NO_TEXT}, other than ${LOGO_TEXT_EXCEPTION} and ${VAN_TEXT_EXCEPTION}.`,
    guard: 'no company logos, brand names, or brand marks other than the Waves logo on the technician\'s cap and chest and the Waves wrap on the one van described above — every other vehicle, and all equipment, is generic and unbranded',
  },
};

function buildPrompt({ title, topic, keyword, city, mode, shot, avoid, plan = null, captions = [], avoidDepicting = [], uniformLogo = false, vanWrap = false, referenceRoles }) {
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
  // An infographic never carries a reference (no scene, and its text rule
  // is caption-only); the van wrap only where the plan places a van.
  const hasVan = Boolean(plan && plan.van) && !isInfographic;
  const clauses = REFERENCE_CLAUSES[`${Boolean(uniformLogo) && !isInfographic}/${Boolean(vanWrap) && hasVan}`];
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
  // The limited illustration palettes (blue / gold / neutrals) must not
  // steer a technician's shirt back to blue: uniform red is always allowed.
  const styleLine = style
    ? `${style.line} Brand palette: blue #009CDE, gold #FFD700 — no teal color cast; a technician's red shirt or red cap is part of the palette.`
    : `Style: bright, clean, professional. Sunny coastal light with a deep-blue sky and warm golden accents (brand palette: blue #009CDE, gold #FFD700 — no teal color cast).`;
  const captionList = (style && style.allowsText ? captions : []).map((c) => String(c || '').trim()).filter(Boolean);
  const textRule = captionList.length
    ? `The ONLY text in the image is exactly: ${captionList.map((c) => `"${c}"`).join(', ')} — spelled exactly, nothing else written anywhere.`
    : clauses.noText;
  const guards = `Must not depict: ${[clauses.guard, STANDARD_GUARDS[1], ...(Array.isArray(avoidDepicting) ? avoidDepicting : [])].map((g) => String(g || '').trim()).filter(Boolean).join('; ')}.`;
  const framing = mode === 'blog-body' && !isInfographic ? (BODY_IMAGE_FRAMING[shot] || BODY_IMAGE_FRAMING['close-up']) : '';
  const distinct = (mode === 'blog-body' && avoid)
    ? `This image must look clearly different from the article's hero image (a wide establishing shot of: ${avoid}) — a different scene, distance and angle, not a variation of it.`
    : '';
  const editorial = mode === 'blog-hero' || mode === 'blog-body'
    ? 'Editorial image content: depict the specific observation or step in the supplied article context. Do not invent measured results, charts, percentages, before-and-after outcomes, or diagnostic features. Source organizations mentioned in the context are attribution, not image subjects: never reproduce their logos, seals, badges, or imply endorsement. Keep anatomy and relative scale plausible; do not exaggerate pests or damage for drama. Prefer an explanatory view of the relevant condition or task over a generic technician pose.'
    : '';
  const uniform = isInfographic ? INFOGRAPHIC_NO_PEOPLE_LINE : clauses.uniform;
  const van = hasVan ? clauses.van : '';
  return [base, focus, local, framing, referenceRoles, uniform, van, composition, styleLine, textRule, guards, distinct, editorial].filter(Boolean).join(' ');
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

// referenceImages: [{ buffer, mimeType, filename }] — with any, the call goes
// to /v1/images/edits as multipart (image[] + prompt), which is how gpt-image
// takes a mark to reproduce; without, the plain JSON generations call.
async function callOpenAI({ model, quality, prompt, size, referenceImages = [] }, { fetchFn = fetch, timeoutMs } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return { skipped: true, reason: 'OPENAI_API_KEY not set' };
  }
  const refs = (Array.isArray(referenceImages) ? referenceImages : []).filter((r) => r && Buffer.isBuffer(r.buffer) && r.buffer.length);
  try {
    let url = 'https://api.openai.com/v1/images/generations';
    const headers = { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` };
    let body;
    if (refs.length) {
      url = 'https://api.openai.com/v1/images/edits';
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('quality', quality);
      form.append('n', '1');
      for (const r of refs) form.append('image[]', new Blob([r.buffer], { type: r.mimeType || 'image/png' }), r.filename || 'reference.png');
      body = form; // fetch sets the multipart boundary header itself
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ model, prompt, size, quality, n: 1 });
    }
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body,
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

function logLegFailure(slug, result) {
  if (result.skipped) {
    logger.info(`[image-generator] ${slug} skipped: ${result.reason}`);
  } else if (result.fatal) {
    logger.warn(`[image-generator] ${slug} fatal: ${result.status} ${result.body || ''}`);
  } else if (result.retryable) {
    logger.warn(`[image-generator] ${slug} retryable: ${result.status || result.error} — trying next provider`);
  }
}

// ── public API ───────────────────────────────────────────────────────

// "HARD REFERENCE ROLES": which attached image is which, numbered in the
// order they are posted. Without it the model can treat the side and rear
// van photos as two vehicles and draw two vans (2026-09-25 lab, per GPT-5.6
// Sol's review of the renders).
function referenceRolesFor(references) {
  const at = (kind) => references.map((r, i) => (r.kind === kind ? i + 1 : null)).filter(Boolean);
  const parts = [];
  if (at('logo').length) parts.push(`Attached Image ${at('logo')[0]} is the complete Waves logo lockup for the uniform badges.`);
  if (at('van').length) parts.push(`Attached Images ${at('van').join(' and ')} are two photographs of the SAME single company van — side and rear views of one object, never two vehicles.`);
  return parts.length ? `HARD REFERENCE ROLES: ${parts.join(' ')}` : '';
}
// Which references a call carried, as the provenance flags callers read —
// the publisher's screen allows the uniform logo / van wrap only then.
function referenceProvenance(references) {
  return { logoReference: references.some((r) => r.kind === 'logo'), vanWrapReference: references.some((r) => r.kind === 'van') };
}

class ImageGenerator {
  // uniformLogo: Buffer (the reference) | null (never attach) | undefined
  // (load the bundled asset lazily, honoring BLOG_IMAGE_UNIFORM_LOGO).
  // vanWrap: [sideBuffer, rearBuffer] (the two references) | null (never
  // attach) | undefined (load the bundled assets lazily, honoring
  // BLOG_IMAGE_VAN_WRAP).
  // defaultChain: the caller's own no-env chain (social keeps an older one);
  // an envChain with no valid slug falls back to it, never to the blog default.
  constructor({ envChain = process.env.BLOG_IMAGE_PROVIDER, defaultChain, fetchFn = fetch, chainBudgetMs = IMAGE_CHAIN_BUDGET_MS, now = Date.now, allowPixelWatermark = pixelWatermarkAllowed(), uniformLogo, vanWrap } = {}) {
    this.chain = parseChain(envChain, { allowPixelWatermark });
    this._uniformLogo = uniformLogo;
    this._vanWrapRefs = vanWrap;
    this._chainBudgetMs = chainBudgetMs;
    this._now = now;
    if (!this.chain.length) {
      logger.warn('[image-generator] no valid providers in the configured image chain; falling back to defaults');
      this.chain = parseChain(defaultChain, { allowPixelWatermark });
    }
    this._fetchFn = fetchFn;
    this._capabilityChecked = false;
    this._capabilityCache = null;
  }

  /**
   * generate({ title, topic, keyword, city, mode })
   *
   * mode: 'blog-hero' (default) or 'social-square'.
   * Returns: { dataUrl, mimeType, model, attempts: [...], prompt, alt, logoReference, vanWrapReference }
   *   prompt — the exact generation prompt used;
   *   logoReference — true when the winning leg carried the Waves logo
   *   reference image (the publisher's screen allows the uniform logo then);
   *   vanWrapReference — true when the winning leg carried the two van wrap
   *   reference photos (the publisher's screen allows the van wrap then);
   *   alt — accessibility text derived from the same subject/setting inputs
   *   as the prompt, so callers can stamp an alt that describes the ACTUAL
   *   generated image (null when a customPrompt made the fields unreliable).
   * Throws if every provider in the chain failed.
   */
  // deadlineAt — an absolute ms timestamp the whole call must respect; a
  // caller that generates more than once for one slot (screen retry) passes
  // the same deadline to both calls so the slot never gets a second budget.
  async generate({ title, topic, keyword, city, mode = 'blog-hero', shot, avoid, plan = null, captions = [], avoidDepicting = [], prompt: customPrompt, deadlineAt = null, uniformLogo = false, vanWrap = false } = {}) {
    const prompt = customPrompt || buildPrompt({ title, topic, keyword, city, mode, shot, avoid, plan, captions, avoidDepicting });
    const alt = customPrompt ? null : buildAltText({ title, topic, keyword, city, mode, plan });
    const attempts = [];
    const deadline = Number.isFinite(deadlineAt) ? deadlineAt : this._now() + this._chainBudgetMs;
    const references = [...this._logoReference({ customPrompt, plan, uniformLogo }), ...this._vanWrapReference({ customPrompt, plan, vanWrap })];
    const attached = referenceProvenance(references);
    const referencePrompt = references.length
      ? buildPrompt({ title, topic, keyword, city, mode, shot, avoid, plan, captions, avoidDepicting, uniformLogo: attached.logoReference, vanWrap: attached.vanWrapReference, referenceRoles: referenceRolesFor(references) })
      : null;

    for (const slug of this.chain) {
      const { result, legReferences } = await this._runLeg({ slug, mode, prompt, referencePrompt, references, deadline, attempts });
      const provenance = referenceProvenance(legReferences);
      attempts.push({ provider: slug, ...provenance, result });
      if (result.dataUrl) {
        const note = legReferences.length ? ` with ${legReferences.map((r) => r.filename).join(', ')}` : '';
        logger.info(`[image-generator] generated via ${slug}${note} (${result.mimeType}, ${result.dataUrl.length} chars)`);
        return { dataUrl: result.dataUrl, mimeType: result.mimeType, model: slug, attempts, prompt: legReferences.length ? referencePrompt : prompt, alt, plan: plan || null, ...provenance };
      }
      // Skipped / fatal / retryable → next provider. The whole point
      // of the chain is resilience: a 408/429/5xx on OpenAI should fall
      // through to Gemini, not abort the chain. Admin and social
      // callers do not retry, so bailing here used to defeat the
      // fallback entirely.
      logLegFailure(slug, result);
    }

    const err = new Error(`image-generator: all providers failed (chain: ${this.chain.join(', ')})`);
    err.attempts = attempts;
    throw err;
  }

  // The logo reference rides only on a prompt this module built (a caller's
  // custom prompt says nothing about a reference), only when the caller opted
  // in, and never on an infographic (which draws no people at all).
  // → the reference images to attach ([] for none).
  _logoReference({ customPrompt, plan, uniformLogo }) {
    if (uniformLogo !== true || customPrompt || (plan && plan.style === 'infographic')) return [];
    const logo = this._uniformLogo === undefined ? loadUniformLogo() : this._uniformLogo;
    return Buffer.isBuffer(logo) && logo.length ? [{ kind: 'logo', buffer: logo, mimeType: 'image/png', filename: 'waves-logo.png' }] : [];
  }

  // The van wrap references ride only on a prompt this module built, only
  // when the caller opted in, and only when the plan actually places a van
  // in the scene (plan.van; never an infographic, which has no scene) —
  // attaching a van reference to a scene with no van would have nothing to
  // anchor it to.
  _vanWrapReference({ customPrompt, plan, vanWrap }) {
    if (vanWrap !== true || customPrompt || !(plan && plan.van) || plan.style === 'infographic') return [];
    const refs = this._vanWrapRefs === undefined ? loadVanWrapReferences() : this._vanWrapRefs;
    if (!(Array.isArray(refs) && refs.length === 2 && refs.every((b) => Buffer.isBuffer(b) && b.length))) return [];
    return [
      { kind: 'van', buffer: refs[0], mimeType: 'image/png', filename: 'waves-van-side.png' },
      { kind: 'van', buffer: refs[1], mimeType: 'image/png', filename: 'waves-van-rear.png' },
    ];
  }

  _budgetSpent() {
    // A spent budget is a timing condition, not a verdict on the provider:
    // retryable so the runner retries the post instead of parking it
    // (Codex r10 P2 on #3964).
    return { skipped: true, retryable: true, reason: `chain budget exhausted (${this._chainBudgetMs} ms)` };
  }

  // One provider leg → { result, legReferences } (the reference images the
  // winning call actually carried). Only OpenAI legs take references;
  // Gemini's prompt is the fully plain one. An OpenAI leg that REJECTS the
  // request with references attached (400/413/415/422) runs once more with NO
  // references at all (logo-free AND van-plain) inside the same deadline — a
  // retryable failure, an auth/model failure or an empty response falls
  // through to the next provider, never a second call on the same leg
  // (pre-push fallback P1 on ae29283fcc; Codex r1 P2 on #4761).
  async _runLeg({ slug, mode, prompt, referencePrompt, references, deadline, attempts }) {
    const cfg = MODEL_MAP[slug];
    const size = sizeFor(mode, cfg.api);
    const timeoutMs = legTimeoutMs(deadline, this._now());
    const legReferences = cfg.api === 'openai' ? references : [];
    if (timeoutMs === null) return { result: this._budgetSpent(), legReferences };
    if (cfg.api === 'gemini') {
      const aspectRatio = cfg.imageAspect ? (MODE_ASPECTS[mode] || MODE_ASPECTS['blog-hero']) : null;
      return { result: await callGemini({ model: cfg.model, prompt, aspectRatio }, { fetchFn: this._fetchFn, timeoutMs }), legReferences };
    }
    if (cfg.api !== 'openai') return { result: { fatal: true, status: 'unknown_api' }, legReferences };
    const referenceImages = legReferences.map(({ buffer, mimeType, filename }) => ({ buffer, mimeType, filename }));
    const result = await callOpenAI({ model: cfg.model, quality: cfg.quality, prompt: legReferences.length ? referencePrompt : prompt, size, referenceImages }, { fetchFn: this._fetchFn, timeoutMs });
    if (!(legReferences.length && result.fatal && REFERENCE_REJECT_STATUSES.has(result.status))) return { result, legReferences };
    attempts.push({ provider: slug, ...referenceProvenance(legReferences), result });
    logger.warn(`[image-generator] ${slug} rejected the request with ${legReferences.length} reference image(s) (${result.status} ${result.body || ''}) — retrying this leg without them`);
    const retryMs = legTimeoutMs(deadline, this._now());
    return {
      result: retryMs === null ? this._budgetSpent() : await callOpenAI({ model: cfg.model, quality: cfg.quality, prompt, size }, { fetchFn: this._fetchFn, timeoutMs: retryMs }),
      legReferences: [],
    };
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
module.exports.pixelWatermarkAllowed = pixelWatermarkAllowed;
module.exports.uniformLogoEnabled = uniformLogoEnabled;
module.exports.vanWrapEnabled = vanWrapEnabled;
module.exports._internals = {
  UNIFORM_LOGO_ENV,
  UNIFORM_LOGO_PATH,
  uniformLogoEnabled,
  loadUniformLogo,
  VAN_WRAP_ENV,
  VAN_WRAP_SIDE_PATH,
  VAN_WRAP_REAR_PATH,
  vanWrapEnabled,
  loadVanWrapReferences,
  VAN_LINE,
  VAN_WRAP_LINE,
  WAVES_UNIFORM_LINE,
  WAVES_UNIFORM_LOGO_LINE,
  INFOGRAPHIC_NO_PEOPLE_LINE,
  STANDARD_GUARDS,
  REFERENCE_CLAUSES,
  referenceRolesFor,
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
  pixelWatermarkAllowed,
  PIXEL_WATERMARK_OVERRIDE_ENV,
  WATERMARK_ALLOWED_DEFAULT_CHAIN,
  isFatalOpenAIError,
  REFERENCE_REJECT_STATUSES,
  sizeFor,
  buildPrompt,
  buildAltText,
  callOpenAI,
  callGemini,
};
