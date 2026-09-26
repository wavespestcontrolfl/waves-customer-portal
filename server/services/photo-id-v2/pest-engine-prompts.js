/**
 * Photo ID v2 pest engine — prompts and JSON schemas for the three model
 * calls (`pest-engine.js` §1–3 of `~/photo-id-v2-build-20260926/V2-CONTRACT.md`):
 *
 *   1. Candidates call  — Gemini, all photos, compact catalog index in the
 *      prompt, up to 3 candidates + a photo-quality read.
 *   2. Verify call      — Gemini, only when ≥1 catalog candidate, numbered
 *      traits + look-alike differences per candidate.
 *   3. Escalation call  — OpenAI, one combined call over the same photos:
 *      its own candidates AND a trait check, in one schema.
 *
 * Every schema closes `additionalProperties` and requires every key (same
 * strict-mode convention `lawn-visit-input.js` uses), and uses no nullable
 * types — "off-catalog" is `slug: ''` rather than `slug: null`, since Gemini
 * and OpenAI's structured-output modes reject `null` in an enum/string slot.
 * Nothing in this file is customer-facing text: it is model input only.
 */

'use strict';

// ── shared JSON-schema helpers (matches lawn-visit-input.js's convention) ──

const STR = { type: 'string' };
const NUM01 = { type: 'number', minimum: 0, maximum: 1 };
const INT_LIST = { type: 'array', items: { type: 'integer' } };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const enumOf = (values) => ({ type: 'string', enum: values });

const QUALITY_ISSUES = ['none', 'blurry', 'dark', 'too_far', 'subject_unclear', 'multiple_subjects'];
const SHOWS_VALUES = ['organism', 'sign', 'both', 'nothing'];

const QUALITY_SCHEMA = obj({ usable: { type: 'boolean' }, issue: enumOf(QUALITY_ISSUES) });

// ── 1. Candidates call ──────────────────────────────────────────────────

const CANDIDATE_ITEM_SCHEMA = obj({
  slug: STR, // '' when off-catalog
  off_catalog_name: STR, // '' when a catalog slug was named
  rank: STR, // e.g. 'species' | 'genus' | 'family' — free text, catalog ranks are not a closed set
  group_id: STR, // best-fit catalog group id, even for an off-catalog answer
  confidence: NUM01,
});

const CANDIDATES_SCHEMA = obj({
  quality: QUALITY_SCHEMA,
  shows: enumOf(SHOWS_VALUES),
  candidates: { type: 'array', maxItems: 3, items: CANDIDATE_ITEM_SCHEMA },
});

/** Compact catalog index for the prompt: "slug | common name | scientific name | group". */
function buildCatalogIndexText(entries) {
  return entries
    .map((e) => `${e.slug} | ${e.common_name} | ${e.scientific_name || ''} | ${e.group}`)
    .join('\n');
}

function buildCandidatesSystemPrompt(catalogIndexText) {
  return `# ROLE
You are identifying a pest, sign of a pest, or other backyard organism from a
Southwest Florida customer's own photos (same individual, several angles),
for Waves Pest Control's photo ID feature. You OBSERVE what is visible in the
photos and match it against the catalog below. You do not invent a species
that is not visually supported.

# CATALOG (slug | common name | scientific name | group)
${catalogIndexText}

# TASK
Return up to 3 ranked candidates. Prefer an exact catalog match (by slug).
When nothing in the catalog fits but you can still say what family or genus
it belongs to, return an off-catalog answer instead (empty slug,
off_catalog_name filled in, rank at genus or family, and your best-fit
group_id from the catalog above). Never guess a specific catalog slug you are
not visually confident in just to avoid an off-catalog answer.

Also report photo quality (usable / issue) and whether the photos show the
organism itself, a sign of it (droppings, damage, a nest, mud tubes…), both,
or nothing pest-related.

Confidence is 0–1, your own calibrated read of how sure you are, not a
count of matching traits.`;
}

// ── 2. Verify call ──────────────────────────────────────────────────────

const VERIFY_ITEM_SCHEMA = obj({
  slug: STR,
  confidence: NUM01,
  traits_visible: INT_LIST,
  traits_not_visible: INT_LIST,
});

const VERIFY_SCHEMA = obj({ candidates: { type: 'array', maxItems: 3, items: VERIFY_ITEM_SCHEMA } });

/**
 * Numbered traits + look-alike differences for each catalog candidate
 * (already resolved via species-catalog.js). `candidateContext`:
 * `[{ slug, common_name, traits: [string,...], lookAlikeDifferences: [string,...] }]`.
 */
function buildTraitBlock({ slug, common_name: commonName, traits, lookAlikeDifferences }) {
  const numbered = (traits || []).map((t, i) => `  ${i + 1}. ${t}`).join('\n') || '  (no traits recorded)';
  const differences = (lookAlikeDifferences || []).map((d) => `  - ${d}`).join('\n');
  return `## ${slug} (${commonName})\nNumbered traits:\n${numbered}${differences ? `\nLook-alike differences to check:\n${differences}` : ''}`;
}

function buildVerifySystemPrompt(candidateContext) {
  const blocks = candidateContext.map(buildTraitBlock).join('\n\n');
  return `# ROLE
You are checking a specific set of candidate identifications against the same
photos you (or another pass) already looked at. For EACH candidate below,
read its numbered traits and report which trait numbers are clearly visible
in the photos, and which are not visible (not "absent" — just not shown by
these photos). Do not add traits that are not numbered below. Then give your
own confidence (0-1) that this candidate, specifically, is correct.

${blocks}

Return one entry per candidate above, in the same order, referencing trait
numbers exactly as numbered.`;
}

// ── 3. Escalation call (OpenAI) ──────────────────────────────────────────

const ESCALATION_ITEM_SCHEMA = obj({
  slug: STR,
  off_catalog_name: STR,
  rank: STR,
  group_id: STR,
  confidence: NUM01,
  traits_visible: INT_LIST,
  traits_not_visible: INT_LIST,
});

const ESCALATION_SCHEMA = obj({
  quality: QUALITY_SCHEMA,
  shows: enumOf(SHOWS_VALUES),
  candidates: { type: 'array', maxItems: 3, items: ESCALATION_ITEM_SCHEMA },
});

/**
 * One combined OpenAI call: its own candidates over the same photos, AND (for
 * any catalog candidate it or the earlier Gemini pass named) a trait check —
 * same numbered-traits contract as the verify call, folded into one schema
 * per the V2 contract ("its own candidates + trait checks on the same
 * photos... one combined call").
 */
function buildEscalationSystemPrompt(catalogIndexText, candidateContext) {
  const blocks = candidateContext.length
    ? `\n\n# CANDIDATES ALREADY RAISED\nIf your own read agrees with one of these, use its numbered traits below to\nreport traits_visible/traits_not_visible. You may still name a DIFFERENT\ncandidate instead if that's what the photos show.\n\n${candidateContext.map(buildTraitBlock).join('\n\n')}`
    : '';
  return `# ROLE
You are a second, independent read on a pest/organism photo identification
for Waves Pest Control (Southwest Florida) — a first pass was inconclusive or
close, and you're being asked to look at the same photos fresh.

# CATALOG (slug | common name | scientific name | group)
${catalogIndexText}

# TASK
Return up to 3 ranked candidates of your own (empty slug + off_catalog_name
for an off-catalog answer, same as any candidates call). For every candidate
you return that has a catalog slug, also report which numbered traits are
visible vs not visible — use the numbered list below when your candidate
matches one of the ones already raised; otherwise report an empty list for
both (you don't have a numbered list for a candidate no one has raised yet).
Also report photo quality and organism/sign.${blocks}`;
}

module.exports = {
  QUALITY_ISSUES,
  SHOWS_VALUES,
  CANDIDATES_SCHEMA,
  VERIFY_SCHEMA,
  ESCALATION_SCHEMA,
  buildCatalogIndexText,
  buildCandidatesSystemPrompt,
  buildVerifySystemPrompt,
  buildEscalationSystemPrompt,
  buildTraitBlock,
};
