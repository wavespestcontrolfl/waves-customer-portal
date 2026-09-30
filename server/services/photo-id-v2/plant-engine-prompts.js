/**
 * Photo ID v2 plant/condition engine — prompts and JSON schemas for the four
 * model calls (`plant-engine.js` §5 of
 * `~/photo-id-lawn-plant-build-20260927/PLANT-ENGINE-CONTRACT.md`):
 *
 *   A. Identity candidates — Gemini, all photos, compact catalog index(es)
 *      in the prompt. Lawn asks for up to 3 `turf` candidates AND up to 3
 *      `weeds` candidates; tree_shrub/palm ask for up to 3 `host`
 *      candidates. One schema covers every subject (unused slots come back
 *      empty arrays) so validation stays uniform.
 *   B. Identity verify — Gemini, only when >=1 catalog candidate from A:
 *      numbered `plant.id_cues` (falling back to `traits`) + look-alike
 *      differences per candidate.
 *   C. Condition selection — Gemini, the condition/pest-possibility index
 *      for the subject/host, plus chips/context/season as plain facts; asks
 *      for up to 5 selected conditions and up to 3 `observed_terms` from the
 *      fixed headline vocabulary (contract §6.3).
 *   D. Escalation — OpenAI, one combined call repeating A+B+C on the same
 *      photos, only when a trigger fires.
 *
 * Every schema closes `additionalProperties` and requires every key (same
 * strict-mode convention `pest-engine-prompts.js` and `lawn-visit-input.js`
 * use); "off-catalog" is `slug: ''` rather than `slug: null`, and the one
 * nullable field, an identity item's `group_id`, is still required. Nothing
 * in this file is customer-facing text: it is model input only.
 */

'use strict';

const STR = { type: 'string' };
const NUM01 = { type: 'number', minimum: 0, maximum: 1 };
const INT_LIST = { type: 'array', items: { type: 'integer' } };
// Required-but-nullable (strict mode still lists it in `required`).
const NULLABLE_STR = { type: ['string', 'null'] };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const enumOf = (values) => ({ type: 'string', enum: values });

const QUALITY_ISSUES = ['none', 'blurry', 'dark', 'too_far', 'subject_unclear', 'multiple_subjects'];
const SHOWS_VALUES = ['plant', 'damage', 'both', 'nothing'];
// Contract §6.3's fixed headline vocabulary — the ONLY terms Call C may
// return in `observed_terms`.
const OBSERVED_TERMS = [
  'browning', 'thinning', 'yellowing', 'spotting', 'wilting', 'dieback',
  'weed_pressure', 'frond_discoloration', 'trunk_damage', 'mushrooms',
];

const QUALITY_SCHEMA = obj({ usable: { type: 'boolean' }, issue: enumOf(QUALITY_ISSUES) });

// ── A. Identity candidates ──────────────────────────────────────────────

// `group_id`: an off-catalog answer's best-fit group from the index's group
// column (null when none fits, or for a catalog slug). The engine keeps it
// only when it is a real plant-section group of that slot's own index, so two
// providers agreeing on an off-catalog plant can still climb to the group
// generic ("Looks like a palm").
const IDENTITY_ITEM_SCHEMA = obj({
  slug: STR, off_catalog_name: STR, group_id: NULLABLE_STR, confidence: NUM01,
});
const IDENTITY_ARRAY = { type: 'array', maxItems: 3, items: IDENTITY_ITEM_SCHEMA };

const CANDIDATES_A_SCHEMA = obj({
  quality: QUALITY_SCHEMA,
  shows: enumOf(SHOWS_VALUES),
  turf: IDENTITY_ARRAY,
  weeds: IDENTITY_ARRAY,
  host: IDENTITY_ARRAY,
});

function buildCatalogIndexText(entries) {
  return entries
    .map((e) => `${e.slug} | ${e.common_name} | ${e.scientific_name || ''} | ${e.group}`)
    .join('\n');
}

function buildIdentityCandidatesPrompt(subject, { turfIndexText, weedIndexText, hostIndexText }) {
  const asks = subject === 'lawn'
    ? `# TURF (slug | common name | scientific name | group)\n${turfIndexText}\n\n# WEEDS (slug | common name | scientific name | group)\n${weedIndexText}\n\nReturn up to 3 ranked candidates for the LAWN GRASS itself in "turf", and up to 3 ranked candidates for any WEEDS visible in "weeds". Leave "host" empty ([]).`
    : `# ${subject === 'palm' ? 'PALM' : 'TREE / SHRUB'} (slug | common name | scientific name | group)\n${hostIndexText}\n\nReturn up to 3 ranked candidates for the plant itself in "host". Leave "turf" and "weeds" empty ([]).`;
  return `# ROLE
You are identifying a Southwest Florida customer's lawn grass, weed, tree,
shrub or palm from their own photos (same subject, several angles), for
Waves Pest Control's photo ID feature. You OBSERVE what is visible and match
it against the catalog below. You do not invent a species that is not
visually supported.

${asks}

When nothing in the catalog fits but you can still say what it likely is,
return an off-catalog answer instead (empty slug, off_catalog_name filled
in, and group_id set to the best-fit group from the group column above, or
null when no listed group fits). For a catalog slug, group_id is null.
Never guess a specific catalog slug you are not visually confident in.

Also report photo quality (usable / issue) and whether the photos show the
plant itself, damage/a problem, both, or nothing relevant.

Confidence is 0-1, your own calibrated read of how sure you are.`;
}

// ── B. Identity verify ───────────────────────────────────────────────────

const VERIFY_A_ITEM_SCHEMA = obj({ slug: STR, confidence: NUM01, cues_visible: INT_LIST, cues_not_visible: INT_LIST });
const VERIFY_A_SCHEMA = obj({ candidates: { type: 'array', maxItems: 6, items: VERIFY_A_ITEM_SCHEMA } });

/** `candidateContext`: `[{ slug, common_name, cues: [string,...],
 * lookAlikeDifferences: [string,...] }]` — `cues` is `plant.id_cues`,
 * falling back to `traits` (contract §5, Call B). */
function buildCuesBlock({ slug, common_name: commonName, cues, lookAlikeDifferences }) {
  const numbered = (cues || []).map((t, i) => `  ${i + 1}. ${t}`).join('\n') || '  (no cues recorded)';
  const differences = (lookAlikeDifferences || []).map((d) => `  - ${d}`).join('\n');
  return `## ${slug} (${commonName})\nNumbered id cues:\n${numbered}${differences ? `\nLook-alike differences to check:\n${differences}` : ''}`;
}

function buildIdentityVerifyPrompt(candidateContext) {
  const blocks = candidateContext.map(buildCuesBlock).join('\n\n');
  return `# ROLE
You are checking a specific set of candidate plant identifications against
the same photos you (or another pass) already looked at. For EACH candidate
below, read its numbered id cues and report which cue numbers are clearly
visible in the photos, and which are not visible (not "absent" — just not
shown by these photos). Do not add cues that are not numbered below. Then
give your own confidence (0-1) that this candidate, specifically, is
correct.

${blocks}

Return one entry per candidate above, in the same order, referencing cue
numbers exactly as numbered.`;
}

// ── C. Condition selection ──────────────────────────────────────────────

const CONDITION_ITEM_SCHEMA = obj({
  slug: STR,
  confidence: NUM01,
  elements_visible: INT_LIST,
  signs_visible: INT_LIST,
  symptoms_visible: INT_LIST,
});
const CONDITIONS_SCHEMA = obj({
  quality: QUALITY_SCHEMA,
  observed_terms: { type: 'array', maxItems: 3, items: enumOf(OBSERVED_TERMS) },
  candidates: { type: 'array', maxItems: 5, items: CONDITION_ITEM_SCHEMA },
});

/** Compact condition-index line: "slug | name | kind | hosts | elements:
 * 1..n | signs: 1..n | symptoms: 1..n" (contract §5 Call C). `sig` is the
 * result of `plant-engine.js`'s `signatureFor(entry)`. */
function buildConditionIndexLine(entry, sig) {
  const numbered = (list) => (list || []).map((t, i) => `${i + 1}. ${t}`).join(' / ') || '(none)';
  return `${entry.slug} | ${entry.common_name} | ${entry.kind} | ${(sig.hosts || []).join(',')} | elements: ${numbered(sig.elements)} | signs: ${numbered(sig.signs)} | symptoms: ${numbered(sig.symptoms)}`;
}

function buildConditionSelectionPrompt({
  indexLines, chips, context, etMonth, subject,
}) {
  return `# ROLE
You are assessing what may be wrong with a Southwest Florida customer's
${subject === 'lawn' ? 'lawn' : subject === 'palm' ? 'palm' : 'tree or shrub'}
from their own photos, for Waves Pest Control's photo ID feature. Select
ONLY from the list below — never invent a condition that is not listed. A
numbered element/sign/symptom counts as visible only if the photo actually
shows it.

# CONDITIONS (slug | name | kind | hosts | elements | signs | symptoms)
${indexLines.join('\n')}

# CUSTOMER-PROVIDED FACTS
Chips: ${JSON.stringify(chips || {})}
Account/context: ${JSON.stringify(context || {})}
Current month (ET): ${etMonth}

# TASK
Return up to 5 selected conditions, each with your confidence (0-1) and
which numbered elements/signs/symptoms are visible in the photos. Also
return up to 3 \`observed_terms\` describing what the photos show, chosen
ONLY from: ${OBSERVED_TERMS.join(', ')}. Also report photo quality.`;
}

// ── D. Escalation (OpenAI, combined) ─────────────────────────────────────

const ESCALATION_IDENTITY_ITEM_SCHEMA = obj({
  slug: STR, off_catalog_name: STR, group_id: NULLABLE_STR, confidence: NUM01, cues_visible: INT_LIST, cues_not_visible: INT_LIST,
});
const ESCALATION_IDENTITY_ARRAY = { type: 'array', maxItems: 3, items: ESCALATION_IDENTITY_ITEM_SCHEMA };
const ESCALATION_CONDITION_ITEM_SCHEMA = obj({
  slug: STR, confidence: NUM01, elements_visible: INT_LIST, signs_visible: INT_LIST, symptoms_visible: INT_LIST,
});

const ESCALATION_SCHEMA = obj({
  quality: QUALITY_SCHEMA,
  shows: enumOf(SHOWS_VALUES),
  turf: ESCALATION_IDENTITY_ARRAY,
  weeds: ESCALATION_IDENTITY_ARRAY,
  host: ESCALATION_IDENTITY_ARRAY,
  observed_terms: { type: 'array', maxItems: 3, items: enumOf(OBSERVED_TERMS) },
  conditions: { type: 'array', maxItems: 5, items: ESCALATION_CONDITION_ITEM_SCHEMA },
});

function buildEscalationPrompt({
  subject, turfIndexText, weedIndexText, hostIndexText, indexLines, identityContext, conditionContext, chips, context, etMonth,
}) {
  const identityAsk = subject === 'lawn'
    ? `# TURF\n${turfIndexText}\n\n# WEEDS\n${weedIndexText}`
    : `# ${subject === 'palm' ? 'PALM' : 'TREE / SHRUB'}\n${hostIndexText}`;
  const identityBlocks = identityContext.length
    ? `\n\n# IDENTITY CANDIDATES ALREADY RAISED\n${identityContext.map(buildCuesBlock).join('\n\n')}`
    : '';
  const conditionBlocks = conditionContext.length
    ? `\n\n# CONDITIONS ALREADY RAISED\n${conditionContext.join('\n')}`
    : '';
  return `# ROLE
You are a second, independent read on a lawn/plant photo workup for Waves
Pest Control (Southwest Florida) — a first pass was inconclusive or close,
and you're being asked to look at the same photos fresh.

${identityAsk}

# CONDITIONS (slug | name | kind | hosts | elements | signs | symptoms)
${indexLines.join('\n')}

# CUSTOMER-PROVIDED FACTS
Chips: ${JSON.stringify(chips || {})}
Account/context: ${JSON.stringify(context || {})}
Current month (ET): ${etMonth}

# TASK
Return your own identity candidates (turf/weeds/host; an off-catalog answer
has an empty slug, off_catalog_name, and group_id from the group column or
null) AND your own selected conditions, in one response. For any candidate with a
catalog slug, report numbered cues/elements visible vs not visible — use the
numbered lists below when your answer matches one already raised; otherwise
report empty lists (you don't have a numbered list for something no one has
raised yet). Also report photo quality, shows, and up to 3 observed_terms
from: ${OBSERVED_TERMS.join(', ')}.${identityBlocks}${conditionBlocks}`;
}

// ── Referee (Claude Fable, GATE_PLANT_ID_REFEREE) ─────────────────────────
// Owner ruling 2026-09-28: when a scope is still unsure after the Gemini ->
// OpenAI Sol escalation, Claude Fable gets one more look at the SAME photos
// as a deciding vote. The referee reuses `buildEscalationPrompt`'s system
// prompt verbatim (same identity/condition ask, same photos) with this block
// appended — plant-engine.js's own merge decides what a match/third-answer
// means; this file only describes the earlier reads.

/** One earlier-reads line: "unknown (72%)" or "no second opinion". */
function formatRefereeRead(read) {
  if (!read) return 'no second opinion';
  const name = read.slug || 'unknown';
  const pct = Math.round((Number(read.confidence) || 0) * 100);
  return `${name} (${pct}%)`;
}

/** `earlierReads`: `[{ scope, first: {slug,confidence}|null, second:
 * {slug,confidence}|null }]` — one entry per scope still unsure after the
 * escalation (an identity slot or 'conditions'), built by plant-engine.js's
 * runReferee. */
function buildRefereePrompt(earlierReads) {
  const lines = earlierReads
    .map((r) => `- ${r.scope}: first read ${formatRefereeRead(r.first)}; second opinion ${formatRefereeRead(r.second)}`)
    .join('\n');
  return `# EARLIER READS (still unsure)
Two earlier passes over these SAME photos landed here, and neither settled
it cleanly:
${lines}

You are a third, independent look — not a tiebreaker vote for its own sake.
Look at the photos yourself first: both earlier reads may be wrong. Answer
with what the photos actually show, even if that means a third answer that
matches neither earlier read, or the same answer either of them gave.
Prefer an honest lower confidence to a confident wrong answer.`;
}

module.exports = {
  QUALITY_ISSUES,
  SHOWS_VALUES,
  OBSERVED_TERMS,
  CANDIDATES_A_SCHEMA,
  VERIFY_A_SCHEMA,
  CONDITIONS_SCHEMA,
  ESCALATION_SCHEMA,
  buildCatalogIndexText,
  buildIdentityCandidatesPrompt,
  buildCuesBlock,
  buildIdentityVerifyPrompt,
  buildConditionIndexLine,
  buildConditionSelectionPrompt,
  buildEscalationPrompt,
  buildRefereePrompt,
};
