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
// photos (owner ruling 2026-09-24). The one wrapped van is judged by its OWN
// narrow question (buildVanScreenPrompt, a second vision call in parallel):
// its body must not be a different van than the Ford Transit medium roof,
// the wrap must be applied with its mascot, and its lettering must be the
// wrap's own exact strings. The main screen is told to leave that one van out
// of every field, so its marks are never reported there at all. Deciding
// after the fact which free-text detections belonged to the van (a keyword
// allowlist over "Waves logo on the van door") produced a new edge case every
// Codex round (r2–r12 on #4785); the model's own split between the two
// questions replaces it. The same marks anywhere off that van are still
// ordinary readable text and brand marks to the main screen.
const SCREEN_MAX_TOKENS = 400;
const SCREEN_MAX_TOKENS_WITH_LOGO = 1200;
const VAN_SCREEN_MAX_TOKENS = 600;
const UNIFORM_LOGO_DESCRIPTION = 'the Waves company logo (a smiling blue wave mascot in a red-and-blue shield, lettered "WAVES" and "LAWN & PEST")';
const VAN_WRAP_DESCRIPTION = 'the Waves van wrap (a light-colored cargo van with a sky-blue gradient, halftone dots, a cartoon wave-character mascot, "WAVES" / "Lawn & Pest" lettering, a phone number and a web address)';
// The wrap's own exact strings (owner ruling 2026-09-24): wrap text on the
// van that is not one of these, whole, is gibberish lettering.
const VAN_WRAP_ALLOWED_TEXT = ['WAVES', 'Lawn & Pest', 'Wave Goodbye to Pests!', '941-241-2459', 'GoWavesFL.com'];
// The only acceptable `van.body` verdicts (Codex r2 P2 on #4785).
const VAN_BODY_VALUES = new Set(['ford_transit_medium_roof', 'other', 'unsure']);
function buildScreenPrompt({ allowedText = [], avoidDepicting = [], allowUniformLogo = false, allowVanWrap = false } = {}) {
  const allowed = allowedText.map((t) => String(t || '').trim()).filter(Boolean);
  const forbidden = avoidDepicting.map((t) => String(t || '').trim()).filter(Boolean);
  const shape = allowUniformLogo
    ? '{"readable_text": string[], "logos_or_brand_marks": string[], "technicians": [{"cap_front_visible": boolean, "chest_visible": boolean, "logo_on": string[]}], "waves_logo_elsewhere": string[], "uniform_logo_lettering": string[], "forbidden_scenes": number[], "notes": string}'
    : '{"readable_text": string[], "logos_or_brand_marks": string[], "forbidden_scenes": number[], "notes": string}';
  const uniformLogoRule = allowUniformLogo
    ? `
- technicians: one entry PER uniformed technician in frame (empty array if none). For that person: cap_front_visible is true only if their cap FRONT is in frame and legible enough to judge for a logo (false when the head is cropped, from behind, or too small); chest_visible is true only if their shirt chest is in frame and legible enough to judge (false when turned away, cropped, or covered); logo_on lists where ${UNIFORM_LOGO_DESCRIPTION} appears on THAT person, each as exactly "cap", "right chest" (the wearer's right side, i.e. the side of their right arm) or "left chest".
- waves_logo_elsewhere: every place that Waves logo appears that is NOT a technician's cap or chest (a vehicle, wall, sign, equipment, packaging, floating on its own), each named. Empty array if none.
- uniform_logo_lettering: the lettering you can read INSIDE that Waves logo on a technician's cap or chest ("WAVES", "LAWN & PEST"), listed here and NOT under readable_text. Empty array if none is legible.
EXCEPTION: that Waves logo on a technician's cap or shirt chest is expected — do not list it under logos_or_brand_marks. Any OTHER lettering (including "WAVES" on a sign, vehicle or wall), and the Waves logo anywhere other than a cap or chest, must still be listed.`
    : '';
  const vanWrapRule = allowVanWrap
    ? `
VAN EXCEPTION (overrides every field above): when exactly ONE van in the frame carries ${VAN_WRAP_DESCRIPTION}, that one van is checked separately — leave everything painted or mounted on it, including its maker's badge, out of every field. The same marks anywhere else (a second van, another vehicle, a sign, a wall, equipment, floating on its own) must still be listed; if two or more vans carry the wrap, list them all.`
    : '';
  return `Inspect this generated blog image and answer as strict JSON only, shape ${shape}.
- readable_text: every string of readable text, letters or numbers in the image (labels on devices, signs, captions, watermarks). Empty array if none.
- logos_or_brand_marks: every recognizable company logo, brand name, or brand mark (on vehicles, uniforms, equipment, packaging). Empty array if none.${uniformLogoRule}${vanWrapRule}
- forbidden_scenes: the NUMBERS of the FORBIDDEN items below the image clearly depicts (e.g. [1]). Empty array if none${forbidden.length ? '' : ' (there are none to check)'}.
- notes: one short sentence.
${allowed.length ? `The following captions are ALLOWED and should still be listed under readable_text: ${allowed.map((t) => `"${t}"`).join(', ')}.` : ''}
${forbidden.length ? `FORBIDDEN (the brief's own exclusions): ${forbidden.map((t, i) => `${i + 1}. "${t}"`).join('; ')}.` : ''}`;
}
// The van's own question — asked only when the van wrap reference was
// attached. The model reports ANY van in frame separately from whether the
// wrap applied (a van left plain fails — Codex r1 P2 on #4784), judges the
// BODY against the Ford Transit medium roof specifically (a wrap reproduced
// onto a Sprinter still fails — Codex r2 P2 on #4785; "unsure" passes for a
// distant van), and reads the wrap's lettering on its own, apart from the
// maker's badge.
function buildVanScreenPrompt() {
  return `Inspect ONLY the van in this generated blog image and answer as strict JSON only, shape {"van": {"body": "ford_transit_medium_roof" | "other" | "unsure", "wrapped": boolean, "wrap_text": string[], "wrap_mascot": boolean} | null}.
- van: null if there is NO van of any kind in the frame; otherwise an object describing the van that carries ${VAN_WRAP_DESCRIPTION} (or, if none does, the largest van):
- body: judges the van's make/roof against a Ford Transit medium-roof cargo van specifically — Transit cues: a short hood, a black hexagon-mesh grille with a Ford oval badge, and a MEDIUM roof (taller than a car, shorter than a walk-in van). "ford_transit_medium_roof" only when those cues are clearly visible; "other" when the van is clearly a DIFFERENT body (e.g. a Mercedes Sprinter's long sloped nose and no Ford grille, a noticeably taller high-roof, or a different make entirely); "unsure" when the van is too small, distant, angled, or obscured to judge either way.
- wrapped: true only if the van visibly carries that graphic wrap rather than a plain, unmarked body — false if the van is there but plain.
- wrap_text: every distinct string of readable text on the wrap graphics, each as its own array entry, spelled and punctuated exactly as painted — not the maker's badge. Empty if wrapped is false or none is legible.
- wrap_mascot: true only if the wave mascot character (a blue wave shape wearing a red cap and overalls) is painted on the van.`;
}
function parseJsonObject(text) {
  const raw = String(text || '').replace(/```[a-z]*|```/gi, '').trim();
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}
// → { van } (van null = no van in frame) or null for an unusable answer. The
// `van` key must be PRESENT: JSON mode does not guarantee every requested key
// comes back, so an omitted key is an incomplete answer, never "no van"
// (Codex r1 P2 on #4785). A malformed van object is unusable too — fail-open
// as unchecked, never clean.
function parseVanScreen(text) {
  try {
    const obj = parseJsonObject(text);
    if (!obj || !Object.prototype.hasOwnProperty.call(obj, 'van')) return null;
    const v = obj.van;
    if (v === null) return { van: null };
    if (!(v && typeof v === 'object' && VAN_BODY_VALUES.has(v.body) && typeof v.wrapped === 'boolean' && Array.isArray(v.wrap_text) && typeof v.wrap_mascot === 'boolean')) return null;
    return { van: { body: v.body, wrapped: v.wrapped, wrapText: v.wrap_text.map((t) => String(t || '').trim()).filter(Boolean), wrapMascot: v.wrap_mascot } };
  } catch {
    return null;
  }
}
function parseScreen(text, { requireForbidden = false, requirePlacements = false } = {}) {
  try {
    const obj = parseJsonObject(text);
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
    const strings = (v) => (Array.isArray(v) ? v.map((t) => String(t || '').trim()).filter(Boolean) : []);
    return {
      technicians: Array.isArray(obj.technicians) ? obj.technicians.map((p) => ({ capVisible: p.cap_front_visible === true, chestVisible: p.chest_visible === true, logoOn: strings(p.logo_on) })) : [],
      elsewhere: strings(obj.waves_logo_elsewhere),
      // Lettering the model attributes to the uniform logo itself — only the
      // logo's own words count (a model cannot launder arbitrary text here).
      uniformLettering: Array.isArray(obj.uniform_logo_lettering) ? obj.uniform_logo_lettering.map((t) => String(t || '').trim()).filter(Boolean) : [],

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
// `van` is the van question's answer (null: none asked, or no van in frame).
function screenVerdict(parsed, { allowedText = [], avoidDepicting = [], allowUniformLogo = false, van = null } = {}) {
  const { reasons: logoReasons, misplaced } = allowUniformLogo ? uniformLogoReasons(parsed) : { reasons: [], misplaced: [] };
  const { reasons: vanReasons, flagged: vanFlagged } = vanWrapReasons(van);
  const logos = allowUniformLogo ? [...misplaced, ...parsed.logos.filter((t) => !isAllowedUniformLogo(t))] : parsed.logos;
  const attributed = new Set(allowUniformLogo ? parsed.uniformLettering.filter(isLogoWord).map(normalizeText) : []);
  const { strayText, incomplete, missing } = matchCaptions(parsed.readableText, allowedText, attributed);
  const reasons = [...logoReasons, ...vanReasons];
  // misplaced marks are already in logoReasons; the rest are true brand marks
  const brandMarks = logos.slice(misplaced.length);
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
  // incomplete captions, logos, van wrap faults, forbidden scenes — never an
  // allowed caption the image rendered correctly; the caller ranks two failed
  // candidates on it (Codex r11 P2 on #3964).
  const violations = logoReasons.length + vanReasons.length + brandMarks.length + strayText.length + incomplete.length + missing.length + forbidden.length;
  const placements = allowUniformLogo ? [...parsed.technicians.flatMap((p) => p.logoOn), ...parsed.elsewhere.map((t) => `elsewhere: ${t}`)] : [];
  return { ok: reasons.length === 0, checked: true, readableText: parsed.readableText, logos: [...logos, ...vanFlagged], forbidden, reasons, violations, placements };
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
// The van wrap's lettering is matched PUNCTUATION-SENSITIVELY — case- and
// whitespace-insensitive, but &, -, . and ! must sit exactly where the real
// wrap has them ("Lawn Pest" and "GoWavesFL-com" are not the wrap; Codex r2
// P2 on #4785). A string splits into chunks on whitespace ONLY, so a
// reported fragment boundary is legitimate only where the wrap itself has a
// space: "Lawn &" + "Pest" is fine, "941-241" + "2459" and "GoWavesFL" +
// "com" never are (Codex r3 P2 on #4785). The side panel's "Lawn & Pest!"
// is the same lettering as the rear's "Lawn & Pest" wherever it appears in
// an entry (Codex r8, r12 P2s on #4785) — never "Pests!", the tagline's own.
function canonicalChunks(str) {
  return String(str || '').replace(/\bpest!/gi, 'pest').trim().split(/\s+/).filter(Boolean).map((c) => c.toLowerCase());
}
// Indices of whole allowed phrases whose chunks, concatenated in order,
// equal `chunks` exactly — or null. One OCR entry may group ADJACENT wrap
// strings ("WAVES Lawn & Pest" off the stacked logo — Codex r9 P2 on #4785).
function splitIntoWholePhrases(chunks, seqs, from = 0) {
  if (from === chunks.length) return [];
  for (let c = 0; c < seqs.length; c += 1) {
    const seq = seqs[c];
    if (from + seq.length <= chunks.length && seq.every((x, j) => chunks[from + j] === x)) {
      const rest = splitIntoWholePhrases(chunks, seqs, from + seq.length);
      if (rest) return [c, ...rest];
    }
  }
  return null;
}
// matchWrapText(fragments) → { strayText, incomplete, complete }
//   strayText — fragments that are no in-order chunk run of any wrap string
//   (wrong or dropped punctuation included);
//   incomplete — wrap strings some fragment(s) partially covered but never
//   completed ("Lawn" + "Pest" with the "&" dropped at their boundary);
//   complete — wrap strings fully covered.
function matchWrapText(fragments) {
  const allowedSeqs = VAN_WRAP_ALLOWED_TEXT.map(canonicalChunks);
  const covered = allowedSeqs.map(() => new Set());
  const cursor = allowedSeqs.map(() => 0);
  const runAt = (chunks, seq, from) => {
    for (let i = from; i + chunks.length <= seq.length; i += 1) {
      if (chunks.every((c, j) => seq[i + j] === c)) return i;
    }
    return -1;
  };
  const strayText = fragments.filter((raw) => {
    const chunks = canonicalChunks(raw);
    let ok = false;
    allowedSeqs.forEach((seq, c) => {
      const at = runAt(chunks, seq, cursor[c]);
      if (!chunks.length || at < 0) return;
      ok = true;
      for (let j = 0; j < chunks.length; j += 1) covered[c].add(at + j);
      cursor[c] = at + chunks.length;
    });
    const whole = ok ? null : splitIntoWholePhrases(chunks, allowedSeqs);
    for (const c of whole || []) { allowedSeqs[c].forEach((_, j) => covered[c].add(j)); cursor[c] = allowedSeqs[c].length; }
    return !ok && !(whole && whole.length);
  });
  const incomplete = VAN_WRAP_ALLOWED_TEXT.filter((_, c) => covered[c].size && covered[c].size < allowedSeqs[c].length);
  const complete = VAN_WRAP_ALLOWED_TEXT.filter((_, c) => covered[c].size === allowedSeqs[c].length);
  return { strayText, incomplete, complete };
}
// The van question's verdict → { reasons, flagged } (flagged rides into the
// screen's `logos` so the caller's "fewest marks" ranking sees each fault).
//   - the wrap on the WRONG body (a Sprinter, a high-roof, any generic cargo
//     van) fails; "unsure" passes (Codex r2 P2 on #4785);
//   - a van left plain fails — the reference exists so the van carries the
//     wrap (Codex r1 P2 on #4784);
//   - a wrap without its mascot fails, whatever text rendered (Codex r1 P2
//     on #4785);
//   - wrap lettering that is not the wrap's own strings, whole — garbled or
//     truncated — fails (owner ruling 2026-09-24; Codex r1 P2 on #4784);
//   - a van close enough to confirm as the Transit is close enough to read,
//     so it must carry at least "WAVES" (Codex r10 P2 on #4785).
function vanWrapReasons(van) {
  const flagged = [];
  const reasons = [];
  const fail = (reason, items = [reason]) => { reasons.push(reason); flagged.push(...items); };
  if (!van) return { reasons, flagged };
  if (van.body === 'other') fail('van body is not a Ford Transit medium-roof cargo van');
  if (!van.wrapped) {
    fail('van present without the wrap');
    return { reasons, flagged };
  }
  if (!van.wrapMascot) fail('van wrap missing the mascot');
  const { strayText, incomplete, complete } = matchWrapText(van.wrapText);
  const garbled = [...strayText, ...incomplete];
  if (garbled.length) fail(`garbled van wrap text: ${garbled.slice(0, 3).join(', ')}`, garbled.map((t) => `garbled van wrap text: ${t}`));
  if (van.body === 'ford_transit_medium_roof' && !complete.includes('WAVES')) fail('van wrap missing the WAVES lettering');
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
    const ask = (text, maxTokens) => dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
      text,
      images: [{ data: buffer.toString('base64'), mimeType }],
      jsonMode: true,
      maxTokens,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
    });
    // The van question runs beside the main one, inside the same deadline.
    // Either answer failing or unusable fails the whole screen open.
    const [res, vanRes] = await Promise.all([
      // The per-technician answer (technicians[], placements, lettering) is
      // several times the plain one; a truncated JSON would fail OPEN as
      // unusable, so give it room (pre-push fallback P1 on 8860b77737).
      ask(buildScreenPrompt({ allowedText, avoidDepicting, allowUniformLogo, allowVanWrap }), allowUniformLogo ? SCREEN_MAX_TOKENS_WITH_LOGO : SCREEN_MAX_TOKENS),
      allowVanWrap ? ask(buildVanScreenPrompt(), VAN_SCREEN_MAX_TOKENS) : null,
    ]);
    const failed = [res, vanRes].find((r) => r && !r.ok);
    if (failed) {
      logger.warn(`[hero-alt-vision] image screen failed (${failed.reason}) — accepting image (fail-open)`);
      return open;
    }
    const parsed = parseScreen(res.text, { requireForbidden: avoidDepicting.some((t) => String(t || '').trim()), requirePlacements: allowUniformLogo });
    const vanAnswer = vanRes ? parseVanScreen(vanRes.text) : { van: null };
    if (!parsed || !vanAnswer) {
      logger.warn('[hero-alt-vision] image screen returned unusable output — accepting image (fail-open)');
      return open;
    }
    return screenVerdict(parsed, { allowedText, avoidDepicting, allowUniformLogo, van: vanAnswer.van });
  } catch (err) {
    logger.warn(`[hero-alt-vision] image screen threw — accepting image (fail-open): ${err.message}`);
    return open;
  }
}

module.exports = { describeHeroForAlt, sanitizeAlt, buildAltPrompt, screenGeneratedImage, buildScreenPrompt, parseScreen };
module.exports._internals = { SCREEN_MAX_TOKENS, SCREEN_MAX_TOKENS_WITH_LOGO, VAN_SCREEN_MAX_TOKENS, VAN_WRAP_ALLOWED_TEXT, isAllowedUniformLogo, classifyPlacement, uniformLogoReasons, vanWrapReasons, buildVanScreenPrompt, parseVanScreen, matchWrapText, matchCaptions, isLogoWord, UNIFORM_LOGO_DESCRIPTION };
