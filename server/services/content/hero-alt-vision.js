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
async function describeHeroForAlt({ buffer, mimeType = 'image/webp', title, keyword } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  try {
    // VISION first, OpenAI Terra on a miss; a two-leg miss (no key, provider
    // error) keeps the writer alt below.
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text: buildAltPrompt({ title, keyword }),
      images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: false,
      maxTokens: 300,
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
function buildScreenPrompt({ allowedText = [] } = {}) {
  const allowed = allowedText.map((t) => String(t || '').trim()).filter(Boolean);
  return `Inspect this generated blog image and answer as strict JSON only, shape {"readable_text": string[], "logos_or_brand_marks": string[], "notes": string}.
- readable_text: every string of readable text, letters or numbers in the image (labels on devices, signs, captions, watermarks). Empty array if none.
- logos_or_brand_marks: every recognizable company logo, brand name, or brand mark (on vehicles, uniforms, equipment, packaging). Empty array if none.
- notes: one short sentence.
${allowed.length ? `The following captions are ALLOWED and should still be listed under readable_text: ${allowed.map((t) => `"${t}"`).join(', ')}.` : ''}`;
}
function parseScreen(text) {
  try {
    const raw = String(text || '').replace(/```[a-z]*|```/gi, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const obj = JSON.parse(raw.slice(start, end + 1));
    // Both lists must be arrays: a scalar or missing field is an unusable
    // answer (→ fail-open as unchecked), never a clean verdict (Codex r1 P2
    // on #3964).
    if (!obj || !Array.isArray(obj.readable_text) || !Array.isArray(obj.logos_or_brand_marks)) return null;
    return {
      readableText: obj.readable_text.map((t) => String(t || '').trim()).filter(Boolean),
      logos: obj.logos_or_brand_marks.map((t) => String(t || '').trim()).filter(Boolean),
      notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}
const normalizeText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * screenGeneratedImage({ buffer, mimeType, allowedText })
 * → { ok, checked, readableText, logos, reasons }
 *   ok=false when the image carries a logo / brand mark, or readable text
 *   beyond the captions the caller allowed (an infographic's own labels).
 */
async function screenGeneratedImage({ buffer, mimeType = 'image/webp', allowedText = [] } = {}) {
  const open = { ok: true, checked: false, readableText: [], logos: [], reasons: [] };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return open;
  try {
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text: buildScreenPrompt({ allowedText }),
      images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: true,
      maxTokens: 400,
    });
    if (!res.ok) {
      logger.warn(`[hero-alt-vision] image screen failed (${res.reason}) — accepting image (fail-open)`);
      return open;
    }
    const parsed = parseScreen(res.text);
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
    const runAt = (tokens, seq) => {
      for (let i = 0; i + tokens.length <= seq.length; i += 1) {
        if (tokens.every((tok, j) => seq[i + j] === tok)) return i;
      }
      return -1;
    };
    const strayText = parsed.readableText.filter((t) => {
      const tokens = normalizeText(t).split(' ').filter(Boolean);
      if (!tokens.length) return false;
      let matched = false;
      allowedSeqs.forEach((seq, c) => {
        const at = runAt(tokens, seq);
        if (at < 0) return;
        matched = true;
        for (let j = 0; j < tokens.length; j += 1) covered[c].add(at + j);
      });
      return !matched;
    });
    // Every allowed caption must be read back in full: a partial read is an
    // incomplete caption and no read at all is a missing one — the provider
    // dropped the lettering the prompt required (Codex r3 P2 on #3964).
    const incomplete = allowedSeqs.map((seq, c) => (covered[c].size && covered[c].size < seq.length ? allowedText[c] : null)).filter(Boolean);
    const missing = allowedSeqs.map((seq, c) => (covered[c].size === 0 ? allowedText[c] : null)).filter(Boolean);
    const reasons = [];
    if (parsed.logos.length) reasons.push(`logo or brand mark: ${parsed.logos.slice(0, 3).join(', ')}`);
    if (strayText.length) reasons.push(`readable text: ${strayText.slice(0, 3).join(', ')}`);
    if (incomplete.length) reasons.push(`incomplete caption: ${incomplete.slice(0, 3).map((c) => `"${c}"`).join(', ')}`);
    if (missing.length) reasons.push(`missing caption: ${missing.slice(0, 3).map((c) => `"${c}"`).join(', ')}`);
    return { ok: reasons.length === 0, checked: true, readableText: parsed.readableText, logos: parsed.logos, reasons };
  } catch (err) {
    logger.warn(`[hero-alt-vision] image screen threw — accepting image (fail-open): ${err.message}`);
    return open;
  }
}

module.exports = { describeHeroForAlt, sanitizeAlt, buildAltPrompt, screenGeneratedImage, buildScreenPrompt, parseScreen };
