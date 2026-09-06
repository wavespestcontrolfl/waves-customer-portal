/**
 * hero-alt-vision.js — vision-derived alt text for freshly generated
 * autonomous blog heroes.
 *
 * WHY: the writer agent authors hero_image.alt BEFORE any image exists
 * (alt and image both derive from the title/keyword, independently), so
 * when the image generator renders a different subject the published alt
 * misdescribes the photo. That mismatch is a recurring Codex P2 on astro
 * blog PRs (#330–335, #362, #372) and — because codex-remediation is
 * body-only (frontmatter is immutable during remediation) — every
 * occurrence PARKS the PR until a human pushes a manual fix. Describing
 * the image AFTER generation removes the failure class at the source.
 *
 * Fail-open by contract: describeHeroForAlt never throws and returns null
 * on any miss (SDK/key unavailable, API error, unusable output). The
 * caller falls back to the writer's pre-image alt — alt quality must
 * never block, park, or fail a publish.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');

// Alt-text conventions: concrete subject first, no "image of"/"photo of"
// preamble, one plain sentence sized for screen readers and image search.
const MIN_ALT_LENGTH = 20;
const MAX_ALT_LENGTH = 160;

function buildAltPrompt({ title, keyword }) {
  const topic = [title, keyword].filter(Boolean).join(' — ');
  return `This image is the hero for a pest control / lawn care blog post${topic ? ` titled "${topic}"` : ''}.

Write the image's alt text. Rules:
- Describe ONLY what is actually visible in the image. Never assert a species or detail you cannot see; if unsure of an exact species, use an accurate general description (e.g. "black-and-yellow orb weaver spider" rather than a specific species name).
- One plain sentence, roughly 60–125 characters.
- No "image of", "photo of", or "picture of" preamble.
- Mention the Southwest Florida / home setting only if the image visibly shows it (palms, lanai, house exterior, lawn).
- No marketing language, no brand names, no quotes or markdown.

Reply with the alt text only.`;
}

// Normalize model output into a usable alt string, or null if it is not
// trustworthy enough to override the writer's alt.
function sanitizeAlt(text) {
  if (typeof text !== 'string') return null;
  let alt = text.replace(/```[a-z]*|```/gi, '').replace(/\s+/g, ' ').trim();
  alt = alt.replace(/^alt(?:\s*text)?\s*:\s*/i, '').replace(/^["'“]|["'”]$/g, '').trim();
  if (alt.length < MIN_ALT_LENGTH || alt.length > MAX_ALT_LENGTH) return null;
  return alt;
}

/**
 * Describe a freshly generated hero image for use as hero_image.alt.
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer   image bytes (the compressed WebP we commit)
 * @param {string} [opts.mimeType='image/webp']
 * @param {string} [opts.title]  post title, for terminology anchoring only
 * @param {string} [opts.keyword] primary keyword
 * @returns {Promise<string|null>} alt text, or null (caller keeps its fallback)
 */
async function describeHeroForAlt({ buffer, mimeType = 'image/webp', title, keyword, timeoutMs = null } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  // Same contract as the screen: timeoutMs is what is left of the caller's
  // image-slot deadline; nothing left → keep the writer alt (fail-open)
  // rather than a vision pass that outlives the slot (Codex r9 P2 on #3964).
  if (timeoutMs !== null && !(timeoutMs > 0)) {
    logger.warn('[hero-alt-vision] vision alt skipped — slot deadline already spent (keeping writer alt)');
    return null;
  }

  try {
    // VISION first, OpenAI Terra on a miss; a two-leg miss (no key, provider
    // error) keeps the writer alt below.
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text: buildAltPrompt({ title, keyword }),
      images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: false,
      maxTokens: 300,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    });
    if (!res.ok) {
      logger.warn(`[hero-alt-vision] vision call failed (${res.reason}) — keeping writer alt (fail-open)`);
      return null;
    }

    const alt = sanitizeAlt(res.text);
    if (!alt) {
      logger.warn('[hero-alt-vision] unusable vision output — keeping writer alt (fail-open)');
      return null;
    }
    logger.info(`[hero-alt-vision] vision alt for "${title || 'untitled'}": ${alt}`);
    return alt;
  } catch (err) {
    logger.warn(`[hero-alt-vision] vision call failed — keeping writer alt (fail-open): ${err.message}`);
    return null;
  }
}

// ── generated-image screen (text / logos) ────────────────────────────
//
// The generators ignore "no text / no logos" often enough that an invented
// control-panel with gibberish labels and a competitor's logo on a truck both
// shipped (2026-09-05 audit). Ask the vision model one narrow question and
// let the caller regenerate once. Fail-open by contract, like the alt pass:
// a vision miss returns { ok: true, checked: false } — a screen must never
// park a publish on its own outage.
function buildScreenPrompt({ allowedText = [], avoidDepicting = [] } = {}) {
  const allowed = allowedText.map((t) => String(t || '').trim()).filter(Boolean);
  const forbidden = avoidDepicting.map((t) => String(t || '').trim()).filter(Boolean);
  return `Inspect this generated blog image and answer as strict JSON only, shape {"readable_text": string[], "logos_or_brand_marks": string[], "forbidden_scenes": string[], "notes": string}.
- readable_text: every string of readable text, letters or numbers in the image (labels on devices, signs, captions, watermarks). Empty array if none.
- logos_or_brand_marks: every recognizable company logo, brand name, or brand mark (on vehicles, uniforms, equipment, packaging). Empty array if none.
- forbidden_scenes: which of the FORBIDDEN items below the image clearly depicts, quoted verbatim. Empty array if none${forbidden.length ? '' : ' (there are none to check)'}.
- notes: one short sentence.
${allowed.length ? `The following captions are ALLOWED and should still be listed under readable_text: ${allowed.map((t) => `"${t}"`).join(', ')}.` : ''}
${forbidden.length ? `FORBIDDEN (the brief's own exclusions): ${forbidden.map((t) => `"${t}"`).join('; ')}.` : ''}`;
}
function parseScreen(text, { requireForbidden = false } = {}) {
  try {
    const raw = String(text || '').replace(/```[a-z]*|```/gi, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const obj = JSON.parse(raw.slice(start, end + 1));
    // Both lists must be arrays: a scalar or missing field is an unusable
    // answer (→ fail-open as unchecked), never a clean verdict (Codex r1 P2
    // on #3964).
    if (!obj || !Array.isArray(obj.readable_text) || !Array.isArray(obj.logos_or_brand_marks)) return null;
    // forbidden_scenes is only asked for when the caller supplied exclusions
    // — and then it is held to the same bar: a scalar or missing field is an
    // unusable answer, never a clean verdict (Codex r9 P2 on #3964).
    if (requireForbidden && !Array.isArray(obj.forbidden_scenes)) return null;
    return {
      readableText: obj.readable_text.map((t) => String(t || '').trim()).filter(Boolean),
      logos: obj.logos_or_brand_marks.map((t) => String(t || '').trim()).filter(Boolean),
      forbidden: Array.isArray(obj.forbidden_scenes) ? obj.forbidden_scenes.map((t) => String(t || '').trim()).filter(Boolean) : [],
      notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}
const normalizeText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * screenGeneratedImage({ buffer, mimeType, allowedText, avoidDepicting, timeoutMs })
 * → { ok, checked, readableText, logos, forbidden, reasons, violations }
 *   ok=false when the image carries a logo / brand mark, or readable text
 *   beyond the captions the caller allowed (an infographic's own labels).
 */
async function screenGeneratedImage({ buffer, mimeType = 'image/webp', allowedText = [], avoidDepicting = [], timeoutMs = null } = {}) {
  const open = { ok: true, checked: false, readableText: [], logos: [], forbidden: [], reasons: [], violations: 0 };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return open;
  // timeoutMs bounds the whole vision chain (both legs) — the caller passes
  // what is left of its image-slot deadline; nothing left → unchecked
  // (fail-open) rather than a screen that outlives the slot (Codex r7 P2).
  if (timeoutMs !== null && !(timeoutMs > 0)) {
    logger.warn('[hero-alt-vision] image screen skipped — slot deadline already spent (fail-open)');
    return open;
  }
  try {
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text: buildScreenPrompt({ allowedText, avoidDepicting }),
      images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: true,
      maxTokens: 400,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    });
    if (!res.ok) {
      logger.warn(`[hero-alt-vision] image screen failed (${res.reason}) — accepting image (fail-open)`);
      return open;
    }
    const parsed = parseScreen(res.text, { requireForbidden: avoidDepicting.some((t) => String(t || '').trim()) });
    if (!parsed) {
      logger.warn('[hero-alt-vision] image screen returned unusable output — accepting image (fail-open)');
      return open;
    }
    // An allowed caption may come back split ("1", "OFF") or joined. A
    // detected string is the caption's only when it is a contiguous, in-order
    // run of ONE allowed caption — never a superset ("1 OFF SALE"), never a
    // reordering ("Ants Stop How To") — and the fragments read for a caption
    // must together cover all of it: "Ants" alone for "How to Stop Ants" is an
    // incomplete caption, which the prompt promised exactly (Codex r1 P2 on
    // #3964, after the pre-push P1 on e8b864170).
    const allowedSeqs = allowedText.map((c) => normalizeText(c).split(' ').filter(Boolean)).filter((seq) => seq.length);
    const covered = allowedSeqs.map(() => new Set());
    // Fragments must reconstruct a caption in reading order: each run is
    // searched from where the previous run for that caption ended, so
    // ["Ants", "How to Stop"] never covers "How to Stop Ants" (Codex r4 P2).
    const cursor = allowedSeqs.map(() => 0);
    const runAt = (tokens, seq, from) => {
      for (let i = from; i + tokens.length <= seq.length; i += 1) {
        if (tokens.every((tok, j) => seq[i + j] === tok)) return i;
      }
      return -1;
    };
    const strayText = parsed.readableText.filter((t) => {
      const tokens = normalizeText(t).split(' ').filter(Boolean);
      if (!tokens.length) return false;
      let matched = false;
      allowedSeqs.forEach((seq, c) => {
        const at = runAt(tokens, seq, cursor[c]);
        if (at < 0) return;
        matched = true;
        for (let j = 0; j < tokens.length; j += 1) covered[c].add(at + j);
        cursor[c] = at + tokens.length;
      });
      return !matched;
    });
    const incomplete = allowedSeqs.map((seq, c) => (covered[c].size && covered[c].size < seq.length ? allowedText[c] : null)).filter(Boolean);
    const missing = allowedSeqs.map((seq, c) => (covered[c].size === 0 ? allowedText[c] : null)).filter(Boolean);
    const reasons = [];
    if (parsed.logos.length) reasons.push(`logo or brand mark: ${parsed.logos.slice(0, 3).join(', ')}`);
    if (strayText.length) reasons.push(`readable text: ${strayText.slice(0, 3).join(', ')}`);
    if (incomplete.length) reasons.push(`incomplete caption: ${incomplete.slice(0, 3).map((c) => `"${c}"`).join(', ')}`);
    if (missing.length) reasons.push(`missing caption: ${missing.slice(0, 3).map((c) => `"${c}"`).join(', ')}`);
    // A brief's exclusion the provider ignored (an irrigation repair scene on
    // a post that says Waves does not repair irrigation) fails the screen
    // like a logo would (Codex r8 P2 on #3964). Only exclusions the caller
    // actually named count — the model cannot invent a forbidden item.
    const named = new Set(avoidDepicting.map((t) => normalizeText(t)).filter(Boolean));
    const forbidden = parsed.forbidden.filter((t) => named.has(normalizeText(t)));
    if (forbidden.length) reasons.push(`forbidden scene: ${forbidden.slice(0, 3).join('; ')}`);
    // violations counts what actually failed — stray strings, missing or
    // incomplete captions, logos, forbidden scenes — never an allowed
    // caption the image rendered correctly; the caller ranks two failed
    // candidates on it (Codex r11 P2 on #3964).
    const violations = parsed.logos.length + strayText.length + incomplete.length + missing.length + forbidden.length;
    return { ok: reasons.length === 0, checked: true, readableText: parsed.readableText, logos: parsed.logos, forbidden, reasons, violations };
  } catch (err) {
    logger.warn(`[hero-alt-vision] image screen threw — accepting image (fail-open): ${err.message}`);
    return open;
  }
}

module.exports = { describeHeroForAlt, sanitizeAlt, buildAltPrompt, screenGeneratedImage, buildScreenPrompt, parseScreen };
