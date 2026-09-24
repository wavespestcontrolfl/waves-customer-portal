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
// allowUniformLogo: the image was generated WITH the Waves logo reference
// (owner directive 2026-09-24). The mark is then REQUIRED on the technician's
// cap and right chest (a technician in frame with it missing, on one garment
// only, or on the left chest fails — Codex r1 P1 on #4761) and still
// forbidden anywhere else. The model reports where it sees the mark under
// waves_logo_placements; its own lettering is never readable_text there.
// allowVanWrap: the image was generated WITH the two van wrap reference
// photos (owner ruling 2026-09-24). The wrap's marks and text are then
// allowed ON THE ONE VAN the plan placed in the scene — reported under `van`
// — and still forbidden anywhere else (`van_wrap_elsewhere`); wrap text
// reported on the van that does not match one of the wrap's own strings
// (a garbled phone number or URL) still fails as gibberish lettering.
const SCREEN_MAX_TOKENS = 400;
const SCREEN_MAX_TOKENS_WITH_LOGO = 1200;
const SCREEN_MAX_TOKENS_WITH_VAN_WRAP = 1200;
const SCREEN_MAX_TOKENS_WITH_LOGO_AND_VAN_WRAP = 1800;
function screenMaxTokens({ allowUniformLogo = false, allowVanWrap = false } = {}) {
  if (allowUniformLogo && allowVanWrap) return SCREEN_MAX_TOKENS_WITH_LOGO_AND_VAN_WRAP;
  if (allowUniformLogo) return SCREEN_MAX_TOKENS_WITH_LOGO;
  if (allowVanWrap) return SCREEN_MAX_TOKENS_WITH_VAN_WRAP;
  return SCREEN_MAX_TOKENS;
}
const UNIFORM_LOGO_DESCRIPTION = 'the Waves company logo (a smiling blue wave mascot in a red-and-blue shield, lettered "WAVES" and "LAWN & PEST")';
// The wrap's own exact strings (owner ruling 2026-09-24) — wrap text on the
// van is checked against these the same way an infographic's caption is
// checked (matchCaptions), so a garbled phone number or URL still fails.
const VAN_WRAP_ALLOWED_TEXT = ['WAVES', 'Lawn & Pest', 'Wave Goodbye to Pests!', '941-241-2459', 'GoWavesFL.com'];
function buildScreenPrompt({ allowedText = [], avoidDepicting = [], allowUniformLogo = false, allowVanWrap = false } = {}) {
  const allowed = allowedText.map((t) => String(t || '').trim()).filter(Boolean);
  const forbidden = avoidDepicting.map((t) => String(t || '').trim()).filter(Boolean);
  const parts = ['"readable_text": string[]', '"logos_or_brand_marks": string[]'];
  if (allowUniformLogo) {
    parts.push(
      '"technicians": [{"cap_front_visible": boolean, "chest_visible": boolean, "logo_on": string[]}]',
      '"waves_logo_elsewhere": string[]',
      '"uniform_logo_lettering": string[]',
    );
  }
  if (allowVanWrap) {
    parts.push(
      '"van": {"present": boolean, "wrap_text": string[], "wrap_mascot": boolean} | null',
      '"van_wrap_elsewhere": string[]',
    );
  }
  parts.push('"forbidden_scenes": number[]', '"notes": string');
  const shape = `{${parts.join(', ')}}`;
  const uniformLogoRule = allowUniformLogo
    ? `
- technicians: one entry PER uniformed technician in frame (empty array if none). For that person: cap_front_visible is true only if their cap FRONT is in frame and legible enough to judge for a logo (false when the head is cropped, from behind, or too small); chest_visible is true only if their shirt chest is in frame and legible enough to judge (false when turned away, cropped, or covered); logo_on lists where ${UNIFORM_LOGO_DESCRIPTION} appears on THAT person, each as exactly "cap", "right chest" (the wearer's right side, i.e. the side of their right arm) or "left chest".
- waves_logo_elsewhere: every place that Waves logo appears that is NOT a technician's cap or chest (a vehicle, wall, sign, equipment, packaging, floating on its own), each named. Empty array if none.
- uniform_logo_lettering: the lettering you can read INSIDE that Waves logo on a technician's cap or chest ("WAVES", "LAWN & PEST"), listed here and NOT under readable_text. Empty array if none is legible.
EXCEPTION: that Waves logo on a technician's cap or shirt chest is expected — do not list it under logos_or_brand_marks. Any OTHER lettering (including "WAVES" on a sign, vehicle or wall), and the Waves logo anywhere other than a cap or chest, must still be listed.`
    : '';
  const vanWrapRule = allowVanWrap
    ? `
- van: null if no van wearing a graphic wrap (a light-colored cargo van with a sky-blue gradient, halftone dots, and a cartoon wave-character mascot) is in frame; otherwise an object describing THAT ONE van: present is true; wrap_text lists every distinct string of readable text painted on it (each as its own array entry, listed here and NOT under readable_text); wrap_mascot is true only if the wave mascot character (a blue wave shape wearing a red cap and overalls) is painted on it.
- van_wrap_elsewhere: any of these Waves van-wrap elements — the wave mascot character, "WAVES", "Lawn & Pest", "Wave Goodbye to Pests!", a phone number, or "GoWavesFL.com" — appearing anywhere OTHER than on that one van (a second vehicle, a sign, a building, equipment, floating on its own), each named. Empty array if none.
EXCEPTION: that one van's own wrap graphics and its own wrap text are expected — do not list them under logos_or_brand_marks.`
    : '';
  return `Inspect this generated blog image and answer as strict JSON only, shape ${shape}.
- readable_text: every string of readable text, letters or numbers in the image (labels on devices, signs, captions, watermarks). Empty array if none.
- logos_or_brand_marks: every recognizable company logo, brand name, or brand mark (on vehicles, uniforms, equipment, packaging). Empty array if none.${uniformLogoRule}${vanWrapRule}
- forbidden_scenes: the NUMBERS of the FORBIDDEN items below the image clearly depicts (e.g. [1]). Empty array if none${forbidden.length ? '' : ' (there are none to check)'}.
- notes: one short sentence.
${allowed.length ? `The following captions are ALLOWED and should still be listed under readable_text: ${allowed.map((t) => `"${t}"`).join(', ')}.` : ''}
${forbidden.length ? `FORBIDDEN (the brief's own exclusions): ${forbidden.map((t, i) => `${i + 1}. "${t}"`).join('; ')}.` : ''}`;
}
function parseScreen(text, { requireForbidden = false, requirePlacements = false, requireVanWrap = false } = {}) {
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
    // With the logo reference the per-technician list is the verdict:
    // missing or malformed → unusable answer (fail-open as unchecked),
    // never clean.
    if (requirePlacements && !placementsWellFormed(obj)) return null;
    // With the van wrap reference the van/elsewhere fields are the verdict:
    // missing or malformed → unusable answer (fail-open as unchecked), never
    // clean.
    if (requireVanWrap && !vanWrapWellFormed(obj)) return null;
    const strings = (v) => (Array.isArray(v) ? v.map((t) => String(t || '').trim()).filter(Boolean) : []);
    return {
      technicians: Array.isArray(obj.technicians) ? obj.technicians.map((p) => ({ capVisible: p.cap_front_visible === true, chestVisible: p.chest_visible === true, logoOn: strings(p.logo_on) })) : [],
      elsewhere: strings(obj.waves_logo_elsewhere),
      // Lettering the model attributes to the uniform logo itself — only the
      // logo's own words count (a model cannot launder arbitrary text here).
      uniformLettering: Array.isArray(obj.uniform_logo_lettering) ? obj.uniform_logo_lettering.map((t) => String(t || '').trim()).filter(Boolean) : [],
      // The one van the plan placed in the scene, and its wrap text — null
      // when the model saw no wrapped van.
      van: (requireVanWrap && obj.van && obj.van.present === true) ? { wrapText: strings(obj.van.wrap_text), wrapMascot: obj.van.wrap_mascot === true } : null,
      vanWrapElsewhere: strings(obj.van_wrap_elsewhere),

      readableText: obj.readable_text.map((t) => String(t || '').trim()).filter(Boolean),
      logos: obj.logos_or_brand_marks.map((t) => String(t || '').trim()).filter(Boolean),
      // Numbers (the ids the prompt asks for) or strings (a model that quotes
      // instead) — the caller matches either against the exclusions it named.
      forbidden: Array.isArray(obj.forbidden_scenes) ? obj.forbidden_scenes.map((t) => (typeof t === 'number' ? t : String(t || '').trim())).filter((t) => t !== '') : [],
      notes: typeof obj.notes === 'string' ? obj.notes.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}
const normalizeText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Per-garment, per-technician: each placement is demanded only when ITS
// garment on THAT person can be judged (a profile shot with the chest turned
// away is not a missing chest logo; one branded tech beside an unbranded one
// is a failure — pre-push P1 on f3efa39462, Codex r3 P2 on #4761).
function placementsWellFormed(obj) {
  if (!Array.isArray(obj.technicians) || !Array.isArray(obj.waves_logo_elsewhere)) return false;
  return obj.technicians.every((p) => p && typeof p === 'object' && typeof p.cap_front_visible === 'boolean' && typeof p.chest_visible === 'boolean' && Array.isArray(p.logo_on));
}
// `van` is null (no wrapped van in frame) or an object naming that one van's
// wrap text/mascot; a scalar or missing `van_wrap_elsewhere` is unusable
// (fail-open as unchecked), same bar as the uniform logo's placement list.
function vanWrapWellFormed(obj) {
  if (!Array.isArray(obj.van_wrap_elsewhere)) return false;
  if (obj.van === null || obj.van === undefined) return true;
  return typeof obj.van === 'object' && typeof obj.van.present === 'boolean' && Array.isArray(obj.van.wrap_text) && typeof obj.van.wrap_mascot === 'boolean';
}
// A detection names an exclusion when it is its 1-based id, the same text,
// or a paraphrase carrying every content word of it ("an irrigation repair
// scene" for "irrigation repair scenes") — an exact-only match let a
// well-formed detection through as clean (Codex r12 P2 on #3964).
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'or', 'and', 'any', 'scene', 'scenes']);
const contentWords = (t) => normalizeText(t).split(' ').filter((w) => w && !STOP_WORDS.has(w)).map((w) => w.replace(/s$/, ''));
function matchExclusion(detection, exclusions) {
  // A quoted id ("1") is the id (Codex r13 P2 on #3964).
  if (typeof detection === 'string' && /^\d+$/.test(detection.trim())) detection = Number(detection.trim());
  if (typeof detection === 'number') return Number.isInteger(detection) && detection >= 1 && detection <= exclusions.length ? exclusions[detection - 1] : null;
  const norm = normalizeText(detection);
  const words = new Set(contentWords(detection));
  return exclusions.find((x) => normalizeText(x) === norm || (contentWords(x).length && contentWords(x).every((w) => words.has(w)))) || null;
}
// The verdict from a parsed answer — pure, so the screen itself stays the
// guard + dispatch + parse (Codex r3 P2 on #4761: complexity).
function screenVerdict(parsed, { allowedText = [], avoidDepicting = [], allowUniformLogo = false, allowVanWrap = false } = {}) {
  const { reasons: logoReasons, misplaced } = allowUniformLogo ? uniformLogoReasons(parsed) : { reasons: [], misplaced: [] };
  const { reasons: vanReasons, flagged: vanFlagged } = allowVanWrap ? vanWrapReasons(parsed) : { reasons: [], flagged: [] };
  const rawLogos = allowUniformLogo ? [...misplaced, ...parsed.logos.filter((t) => !isAllowedUniformLogo(t))] : parsed.logos;
  const attributed = new Set(allowUniformLogo ? parsed.uniformLettering.filter(isLogoWord).map(normalizeText) : []);
  const { strayText, incomplete, missing } = matchCaptions(parsed.readableText, allowedText, attributed);
  const reasons = [...logoReasons, ...vanReasons];
  // misplaced marks are already in logoReasons; the rest are true brand marks
  const brandMarks = rawLogos.slice(misplaced.length);
  if (brandMarks.length) reasons.push(`logo or brand mark: ${brandMarks.slice(0, 3).join(', ')}`);
  if (strayText.length) reasons.push(`readable text: ${strayText.slice(0, 3).join(', ')}`);
  if (incomplete.length) reasons.push(`incomplete caption: ${incomplete.slice(0, 3).map((c) => `"${c}"`).join(', ')}`);
  if (missing.length) reasons.push(`missing caption: ${missing.slice(0, 3).map((c) => `"${c}"`).join(', ')}`);
  // A brief's exclusion the provider ignored (an irrigation repair scene on
  // a post that says Waves does not repair irrigation) fails the screen
  // like a logo would (Codex r8 P2 on #3964). Only exclusions the caller
  // actually named count — the model cannot invent a forbidden item — and
  // each detection is reported as the exclusion it names.
  const named = avoidDepicting.map((t) => String(t || '').trim()).filter(Boolean);
  const forbidden = [...new Set(parsed.forbidden.map((t) => matchExclusion(t, named)).filter(Boolean))];
  if (forbidden.length) reasons.push(`forbidden scene: ${forbidden.slice(0, 3).join('; ')}`);
  // violations counts what actually failed — stray strings, missing or
  // incomplete captions, logos, van wrap marks, forbidden scenes — never an
  // allowed caption the image rendered correctly; the caller ranks two
  // failed candidates on it (Codex r11 P2 on #3964).
  const violations = logoReasons.length + vanReasons.length + brandMarks.length + strayText.length + incomplete.length + missing.length + forbidden.length;
  const placements = allowUniformLogo ? [...parsed.technicians.flatMap((p) => p.logoOn), ...parsed.elsewhere.map((t) => `elsewhere: ${t}`)] : [];
  const logos = [...rawLogos, ...vanFlagged];
  return { ok: reasons.length === 0, checked: true, readableText: parsed.readableText, logos, forbidden, reasons, violations, placements };
}

/**
 * screenGeneratedImage({ buffer, mimeType, allowedText, avoidDepicting, timeoutMs })
 * → { ok, checked, readableText, logos, forbidden, reasons, violations }
 *   ok=false when the image carries a logo / brand mark, or readable text
 *   beyond the captions the caller allowed (an infographic's own labels).
 */
// Belt to the prompt's braces: a model that lists the uniform logo under
// logos_or_brand_marks anyway. Dropped only when the detection names "Waves"
// (never the generic "wave") AND a positive garment surface (cap / hat /
// chest / polo / shirt — not "technician" or "uniform" alone, which would
// pass a clipboard or a glove) AND no other surface — "Waves logo on the van
// door" stays a violation (pre-push fallback P1 on 440cc8b947). Readable
// text is NOT filtered: the prompt keeps the uniform logo's own lettering
// out of readable_text, so any "WAVES" string that does come back is
// standalone lettering somewhere else (Codex r1 P2 on #4761).
const UNIFORM_LOGO_WORDS = /\bwaves\b/i;
// Explicit cap or chest only — 'shirt'/'polo' alone would pass a sleeve, back
// or collar mark (Codex r5 P2 on #4761).
const UNIFORM_LOCATION = /\b(cap|hat|chest)\b/i;
const OTHER_SURFACE = /\b(van|truck|vehicle|car|door|wall|sign|banner|equipment|sprayer|tank|packaging|bottle|box|background|floating|standalone|sky|ground|clipboard|tablet|backpack|bag|glove|gloves|tool|tools|mailbox|fence|sleeve|sleeves|back|collar|pocket|hem|shoulder)\b/i;
// A LEFT-chest detection is never allowed: it is a misplaced mark, kept for
// the reasons and the ranking (Codex r4 P2 on #4761).
const isAllowedUniformLogo = (t) => UNIFORM_LOGO_WORDS.test(t) && UNIFORM_LOCATION.test(t) && !OTHER_SURFACE.test(t) && !/\bleft\b/i.test(t);
// The words inside the Waves logo. A readable_text entry is dropped only
// when the model ALSO attributed that same string to the uniform logo under
// uniform_logo_lettering — the model's own placement, not a blanket filter
// (Codex r1 P2 on #4761). Vision models OCR the badge's "WAVES" into
// readable_text often enough that, without this, a correct image burns its
// screen retry (regen batch 2026-09-24).
const LOGO_WORDS = new Set(['waves', 'lawn', 'pest', 'lawn pest', 'lawn and pest', 'waves lawn pest', 'waves lawn and pest']);
const isLogoWord = (t) => LOGO_WORDS.has(normalizeText(t));
// A reported placement on a technician → cap | right chest | left chest | other.
function classifyPlacement(t) {
  const n = normalizeText(t);
  if (/\b(cap|hat)\b/.test(n)) return 'cap';
  if (/\bchest\b/.test(n) && /\bleft\b/.test(n)) return 'left chest';
  if (/\bchest\b/.test(n)) return 'right chest';
  return 'other';
}
// The placement verdict for a uniform-logo image → { reasons, misplaced }.
// Per technician: the logo must be on the cap when the cap front can be
// judged and on the RIGHT chest when the chest can be judged; a left-chest
// logo is wrong even beside a correct right-chest one; the logo anywhere
// else is a brand mark. `misplaced` lists every wrongly placed mark so the
// caller's "no logo beats a logo" ranking still sees it (Codex r3 P2 on #4761).
function uniformLogoReasons({ technicians, elsewhere }) {
  const reasons = [];
  const misplaced = [];
  if (elsewhere.length) {
    reasons.push(`logo or brand mark: Waves logo elsewhere: ${elsewhere.slice(0, 3).join(', ')}`);
    misplaced.push(...elsewhere.map((t) => `Waves logo elsewhere: ${t}`));
  }
  technicians.forEach((p, i) => {
    const who = technicians.length > 1 ? `technician ${i + 1}: ` : '';
    const where = new Set(p.logoOn.map(classifyPlacement));
    const stray = p.logoOn.filter((t) => classifyPlacement(t) === 'other');
    if (stray.length) { reasons.push(`${who}logo or brand mark: Waves logo on ${stray.slice(0, 3).join(', ')}`); misplaced.push(...stray.map((t) => `${who}Waves logo on ${t}`)); }
    if (p.capVisible && !where.has('cap')) reasons.push(`${who}uniform logo missing on the cap`);
    if (where.has('left chest')) { reasons.push(`${who}uniform logo on the left chest${where.has('right chest') ? ' as well as the right' : ', not the right'}`); misplaced.push(`${who}Waves logo on the left chest`); }
    else if (p.chestVisible && !where.has('right chest')) reasons.push(`${who}uniform logo missing on the chest`);
  });
  return { reasons, misplaced };
}
// The van wrap verdict for a van-wrap image → { reasons, flagged }. Any wrap
// element (mascot, "WAVES", "Lawn & Pest", the tagline, the phone number, the
// URL) found anywhere other than the one van is a brand-mark violation; wrap
// text reported ON the van that does not match one of the wrap's own exact
// strings is gibberish lettering and fails too (owner ruling 2026-09-24) —
// the same in-order-run matching an infographic's caption gets, via the
// shared matchCaptions helper.
function vanWrapReasons({ van, vanWrapElsewhere }) {
  const reasons = [];
  const flagged = [];
  if (vanWrapElsewhere.length) {
    reasons.push(`van wrap off the van: ${vanWrapElsewhere.slice(0, 3).join(', ')}`);
    flagged.push(...vanWrapElsewhere.map((t) => `van wrap off the van: ${t}`));
  }
  if (van && Array.isArray(van.wrapText) && van.wrapText.length) {
    const { strayText } = matchCaptions(van.wrapText, VAN_WRAP_ALLOWED_TEXT);
    if (strayText.length) {
      reasons.push(`garbled van wrap text: ${strayText.slice(0, 3).join(', ')}`);
      flagged.push(...strayText.map((t) => `garbled van wrap text: ${t}`));
    }
  }
  return { reasons, flagged };
}
// The caption match (Codex r1/r4 P2s on #3964): an allowed caption may come
// back split ("1", "OFF") or joined. A detected string is the caption's only
// when it is a contiguous, in-order run of ONE allowed caption — never a
// superset ("1 OFF SALE"), never a reordering ("Ants Stop How To") — and the
// fragments read for a caption must together cover all of it, in reading
// order: "Ants" alone for "How to Stop Ants" is an incomplete caption, and
// ["Ants", "How to Stop"] never covers it. `attributed` holds the uniform
// logo's own lettering (by the model's attribution), never stray.
function matchCaptions(readableText, allowedText, attributed = new Set()) {
  const allowedSeqs = allowedText.map((c) => normalizeText(c).split(' ').filter(Boolean)).filter((seq) => seq.length);
  const covered = allowedSeqs.map(() => new Set());
  const cursor = allowedSeqs.map(() => 0);
  const runAt = (tokens, seq, from) => {
    for (let i = from; i + tokens.length <= seq.length; i += 1) {
      if (tokens.every((tok, j) => seq[i + j] === tok)) return i;
    }
    return -1;
  };
  const strayText = readableText.filter((t) => {
    const tokens = normalizeText(t).split(' ').filter(Boolean);
    if (!tokens.length || attributed.has(tokens.join(' '))) return false;
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
  return { strayText, incomplete, missing };
}

async function screenGeneratedImage({ buffer, mimeType = 'image/webp', allowedText = [], avoidDepicting = [], allowUniformLogo = false, allowVanWrap = false, timeoutMs = null } = {}) {
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
      text: buildScreenPrompt({ allowedText, avoidDepicting, allowUniformLogo, allowVanWrap }),
      images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: true,
      // The per-technician / per-van answer is several times the plain one;
      // a truncated JSON would fail OPEN as unusable, so give it room
      // (pre-push fallback P1 on 8860b77737).
      maxTokens: screenMaxTokens({ allowUniformLogo, allowVanWrap }),
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    });
    if (!res.ok) {
      logger.warn(`[hero-alt-vision] image screen failed (${res.reason}) — accepting image (fail-open)`);
      return open;
    }
    const parsed = parseScreen(res.text, { requireForbidden: avoidDepicting.some((t) => String(t || '').trim()), requirePlacements: allowUniformLogo, requireVanWrap: allowVanWrap });
    if (!parsed) {
      logger.warn('[hero-alt-vision] image screen returned unusable output — accepting image (fail-open)');
      return open;
    }
    return screenVerdict(parsed, { allowedText, avoidDepicting, allowUniformLogo, allowVanWrap });
  } catch (err) {
    logger.warn(`[hero-alt-vision] image screen threw — accepting image (fail-open): ${err.message}`);
    return open;
  }
}

module.exports = { describeHeroForAlt, sanitizeAlt, buildAltPrompt, screenGeneratedImage, buildScreenPrompt, parseScreen };
module.exports._internals = {
  SCREEN_MAX_TOKENS,
  SCREEN_MAX_TOKENS_WITH_LOGO,
  SCREEN_MAX_TOKENS_WITH_VAN_WRAP,
  SCREEN_MAX_TOKENS_WITH_LOGO_AND_VAN_WRAP,
  screenMaxTokens,
  isAllowedUniformLogo,
  classifyPlacement,
  uniformLogoReasons,
  vanWrapReasons,
  VAN_WRAP_ALLOWED_TEXT,
  matchCaptions,
  isLogoWord,
  UNIFORM_LOGO_DESCRIPTION,
};
