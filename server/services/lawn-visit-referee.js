/**
 * Lawn visit assessment name referee (owner ruling 2026-09-29, dark behind
 * GATE_LAWN_ASSESSMENT_REFEREE — see feature-gates.js#lawnAssessmentRefereeLive).
 * Mirrors the plant engine's narrowed referee (photo-id-v2/plant-engine.js#runReferee).
 *
 * Flow, all inside lawn-visit-assessment.js#analyzeVisit and only when the gate
 * is on AND Gemini itself answered (not the OpenAI fallback):
 *   1. SECOND OPINION — when Gemini's read is "unsure or serious" (see
 *      `secondOpinionReasons`), GPT-6 Sol re-reads the same visit: same system
 *      prompt, images and schema, the policy's OpenAI leg called alone.
 *   2. DISPUTES — `findDisputes` compares Gemini's and Sol's NAMES only.
 *   3. REFEREE — only when the two disagreed on a name does Claude Fable get
 *      one more look, answering a small a / b / neither schema per disputed item.
 *   4. MERGE — tie-break only (`mergeReferee`). Fable's pick matching Sol's side
 *      replaces that name and caps the finding's confidence at moderate;
 *      matching Gemini's side keeps Gemini's name and caps at moderate too. A
 *      third answer, no usable answer, timeout or error leaves that item, and a
 *      failed call the whole result, EXACTLY as Gemini read it. Scores,
 *      severities{}, severity/urgency and every other field are never touched.
 * Nothing here throws: every failure returns Gemini's read unchanged.
 * Diagnostics live on the returned `referee` object only — internal, never
 * persisted as its own column, never customer copy.
 */
const MODELS = require('../config/models');
const logger = require('./logger');
const { dispatch } = require('./llm/call');
const { PROMPT_VERSION, GRASS_TYPES, buildUserText } = require('./lawn-visit-input');
const { validateAssessmentJson } = require('./lawn-visit-result');
const { safeConditionLabel } = require('./lawn-diagnostic-report');
const { CURATED_REFERENCE } = require('./lawn-diagnostic-prompt');

// Fable thinks before answering; llm/call.js#dispatch raises this to the
// always-thinking floor for a model that needs it and reads the answer past
// thinking blocks, so this is a generous starting cap, not the wire size.
const REFEREE_MAX_TOKENS = 8192;
// A tie-break never holds the technician's upload for long: about a minute,
// like the plant referee. The second opinion is a full visit read, so it gets
// longer. A timeout leaves Gemini's read exactly as it was.
const REFEREE_MAX_MS = 60 * 1000;
const SECOND_OPINION_MAX_MS = 120 * 1000;
// Belt and braces: the adapters abort their own transport at timeoutMs; this
// race guarantees analyzeVisit returns even if an adapter ignores it.
const HARD_DEADLINE_GRACE_MS = 5 * 1000;

const CONFIDENCE_RANK = { unknown: 0, low: 1, moderate: 2, high: 3 };

// ── Trigger: is Gemini's read "unsure or serious"? ───────────────────────
/** Reasons Gemini's raw answer earns a Sol second opinion (empty = no call):
 * any finding with confidence low/unknown, any finding with severity
 * moderate/severe, or grass_type the enum's uncertain value ('unknown').
 * ('mixed' is a definite answer, not an uncertain one.) */
function secondOpinionReasons(json) {
  const reasons = [];
  const findings = Array.isArray(json?.findings) ? json.findings : [];
  if (findings.some((f) => ['low', 'unknown'].includes(f?.confidence))) reasons.push('low_confidence_finding');
  if (findings.some((f) => ['moderate', 'severe'].includes(f?.severity))) reasons.push('serious_finding');
  if (json?.grass_type === 'unknown') reasons.push('grass_type_unknown');
  return reasons;
}

// ── Canonical names ──────────────────────────────────────────────────────
// Finding names are free text, so they are mapped through the production cause
// catalog (`safeConditionLabel`, lawn-diagnostic-report.js's CONDITION_LABELS —
// negation-aware, the same mapping normalizeAssessment applies) to a label.
// Only a label that NAMES a cause can start a dispute. Symptom labels
// ("thinning turf", "color and nutrient stress"), the clean label, and the
// unmapped label commit to no cause, so they never conflict with anything.
const CAUSE_LABELS = Object.freeze(new Set([
  'chinch bug activity', 'caterpillar activity', 'grub activity',
  'large patch (fungal) activity', 'gray leaf spot', 'dollar spot', 'fungal activity',
  'weed pressure', 'overwatering signal', 'drought stress',
]));
// A generic "fungal activity" is compatible with a specific fungal name (a
// refinement, not a disagreement); brown patch and large patch already share
// one catalog label.
const SPECIFIC_FUNGAL = Object.freeze(new Set(['large patch (fungal) activity', 'gray leaf spot', 'dollar spot']));
const NAME_PARTS = /\s*(?:\band\b|&|\/|,|;|\bwith\b|\bplus\b|\bor\b|\bvs\.?\b)\s*/i;
// A name may START a dispute only when it is one plain phrase. Any joining
// word or mark ("+", "versus", "along with", a comma, parentheses …) makes it
// compound or hedged, so it counts as ambiguous and never draws the referee —
// splitting on a separator list alone missed "+" and "versus" (pre-push P1).
const COMPOUND = /[&+\/,;:()|]|\s-\s|->|\b(?:and|or|with|plus|vs\.?|versus|also|along|as well as|then|either|possibly|maybe|likely|suspected|probable|mixed|combined|multiple|both)\b/i;
const singlePhrase = (name) => !!String(name || '').trim() && !COMPOUND.test(String(name));

/** The set of cause labels a finding name commits to. A name that lists several
 * causes ("chinch bugs and drought") yields several, and is then never a
 * dispute on its own (the pairing treats size > 1 as ambiguous). */
// Any negation in the name makes it commit to nothing: splitting "No chinch
// bugs or grubs observed" would strip the shared "No" from "grubs", so a
// negated name is never split into a cause (pre-push audit P1).
const NEGATION = /\b(?:no|not|none|without|absent|absence|negative|ruled out|free of|lack of)\b|n't\b/i;

function causeLabelsOf(name) {
  const labels = new Set();
  const text = String(name || '');
  if (NEGATION.test(text)) return labels;
  for (const part of text.split(NAME_PARTS)) {
    if (!part.trim()) continue;
    const label = safeConditionLabel(part);
    if (label && CAUSE_LABELS.has(label)) labels.add(label);
  }
  return labels;
}

function labelsCompatible(a, b) {
  if (a === b) return true;
  return (a === 'fungal activity' && SPECIFIC_FUNGAL.has(b)) || (b === 'fungal activity' && SPECIFIC_FUNGAL.has(a));
}
const setsCompatible = (as, bs) => [...as].some((a) => [...bs].some((b) => labelsCompatible(a, b)));

// ── Disputes ─────────────────────────────────────────────────────────────
const photoRefsOf = (finding) => (Array.isArray(finding?.photo_refs) ? finding.photo_refs.filter((n) => Number.isInteger(n)) : []);

/** Two findings look at the same thing when they cite an overlapping photo; a
 * finding that cites none pairs only by the same known technician zone. */
function findingsOverlap(a, b) {
  const aRefs = photoRefsOf(a);
  const bRefs = photoRefsOf(b);
  if (aRefs.length && bRefs.length) return aRefs.some((n) => bRefs.includes(n));
  return !!a?.zone && a.zone !== 'unknown' && a.zone === b?.zone;
}

// A finding only "names" something when it says it can determine it and is not
// at unknown confidence; an undeterminable symptom is not a naming vote.
const committed = (finding) => finding?.can_determine === true && finding?.confidence !== 'unknown';

/**
 * Deterministic name-disagreement rule (Gemini = read A, Sol = read B):
 *  - GRASS: both grass_type values are definite (in the enum, not 'unknown',
 *    not 'mixed') and differ.
 *  - FINDING: for each committed Gemini finding whose name maps to exactly one
 *    cause label AND is one plain phrase (no joining words — `singlePhrase`),
 *    look at the Sol findings citing an overlapping photo (or the
 *    same known zone when a side cites no photo). No dispute when ANY of them
 *    carries a compatible cause (agreement, however Sol scored it), or none
 *    carries a cause. Otherwise, only when exactly ONE committed, single-cause
 *    Sol finding conflicts AND that Sol finding overlaps no other Gemini cause
 *    finding (a unique pair both ways) is it a dispute. Anything else is
 *    ambiguous: counted in `ambiguous`, never sent to the referee.
 * Confidence never matters to whether names agree.
 * Returns { disputes: [{ id, kind, ... }], ambiguous }.
 */
function findDisputes(geminiJson, solJson) {
  const disputes = [];
  let ambiguous = 0;
  const definiteGrass = (value) => (GRASS_TYPES.includes(value) && !['unknown', 'mixed'].includes(value) ? value : null);
  const gGrass = definiteGrass(geminiJson?.grass_type);
  const sGrass = definiteGrass(solJson?.grass_type);
  if (gGrass && sGrass && gGrass !== sGrass) {
    disputes.push({ id: `d${disputes.length + 1}`, kind: 'grass_type', geminiName: gGrass, solName: sGrass });
  }

  const gFindings = Array.isArray(geminiJson?.findings) ? geminiJson.findings : [];
  const sFindings = Array.isArray(solJson?.findings) ? solJson.findings : [];
  const gLabels = gFindings.map((f) => causeLabelsOf(f?.name));
  const sLabels = sFindings.map((f) => causeLabelsOf(f?.name));
  gFindings.forEach((gFinding, i) => {
    if (!gLabels[i].size || !committed(gFinding)) return;
    const overlapping = sFindings.map((f, j) => j).filter((j) => sLabels[j].size && findingsOverlap(gFinding, sFindings[j]));
    if (!overlapping.length) return;
    if (overlapping.some((j) => setsCompatible(gLabels[i], sLabels[j]))) return;
    const conflicting = overlapping.filter((j) => committed(sFindings[j]));
    if (!conflicting.length) return;
    const [j] = conflicting;
    const mutual = gFindings.map((f, k) => k).filter((k) => gLabels[k].size && findingsOverlap(gFindings[k], sFindings[j]));
    if (gLabels[i].size !== 1 || sLabels[j].size !== 1 || !singlePhrase(gFinding.name) || !singlePhrase(sFindings[j].name)
      || overlapping.length !== 1 || conflicting.length !== 1 || mutual.length !== 1) {
      ambiguous += 1;
      return;
    }
    disputes.push({
      id: `d${disputes.length + 1}`, kind: 'finding', geminiIndex: i, solIndex: j,
      geminiName: gFinding.name, solName: sFindings[j].name,
      photoRefs: photoRefsOf(gFinding), zone: gFinding.zone || 'unknown',
    });
  });
  return { disputes, ambiguous };
}

// ── Fable call ───────────────────────────────────────────────────────────
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const REFEREE_PICKS = ['a', 'b', 'neither'];
const REFEREE_SCHEMA = obj({
  answers: { type: 'array', items: obj({ id: { type: 'string' }, pick: { type: 'string', enum: REFEREE_PICKS } }) },
});

const oneLine = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 80);

function describeDispute(dispute) {
  if (dispute.kind === 'grass_type') return `- ${dispute.id}: the grass type — A: "${oneLine(dispute.geminiName)}"; B: "${oneLine(dispute.solName)}"`;
  const where = dispute.photoRefs.length ? `photo${dispute.photoRefs.length === 1 ? '' : 's'} ${dispute.photoRefs.join(', ')}` : 'the photos';
  return `- ${dispute.id}: what the finding in ${where} is — A: "${oneLine(dispute.geminiName)}"; B: "${oneLine(dispute.solName)}"`;
}

/** The referee's system prompt: a short role + the shared agronomy reference,
 * then the "two earlier reads disagreed on" block. Read A is Gemini, read B is
 * Sol; merging is `mergeReferee`'s job. */
function buildRefereeSystem(disputes) {
  return `# ROLE
You are a Southwest Florida lawn diagnostician acting as a NAME referee for one
technician lawn visit. You see the same numbered photos two earlier reads saw.
You only settle what something IS called; you do not score, rate, or describe anything else.

# TWO EARLIER READS DISAGREED ON
${disputes.map(describeDispute).join('\n')}

# HOW TO ANSWER
Look at the photos yourself first: both earlier reads may be wrong. For each item
answer "a" when read A's name is what the photos best support, "b" for read B's,
or "neither" when neither is supported or the photos cannot settle it. Apply the
same naming discipline as the visit rubric below: name a specific cause only when
its Required signature is visible; otherwise prefer "neither" to a confident wrong
name. Scores, severities and confidence are not part of this question.
Return ONLY the JSON object the schema describes — one answer per item id above.

${CURATED_REFERENCE}`;
}

/** The picks Fable gave, keyed by dispute id; ids/picks outside the schema
 * contract are dropped (first answer per id wins). Null when nothing usable. */
function usablePicks(json, disputes) {
  if (!json || !Array.isArray(json.answers)) return null;
  const known = new Set(disputes.map((d) => d.id));
  const picks = {};
  for (const answer of json.answers) {
    if (answer && known.has(answer.id) && REFEREE_PICKS.includes(answer.pick) && !(answer.id in picks)) picks[answer.id] = answer.pick;
  }
  return Object.keys(picks).length ? picks : null;
}

// Every dispatch is bounded from this side too, and can never reject.
async function boundedDispatch(route, payload, capMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), capMs + HARD_DEADLINE_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => dispatch(route, { ...payload, timeoutMs: capMs })),
      deadline,
    ]);
    return result || { ok: false, reason: 'no_response' };
  } catch (err) {
    logger.warn(`[lawn-visit-referee] dispatch threw: ${err.message}`);
    return { ok: false, reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// ── Merge ────────────────────────────────────────────────────────────────
const capAtModerate = (confidence) => ((CONFIDENCE_RANK[confidence] ?? 0) > CONFIDENCE_RANK.moderate ? 'moderate' : confidence);

/** Apply Fable's picks to a COPY of Gemini's raw answer. Only two things can
 * ever change, and only for a disputed item Fable matched to a side:
 *  - grass_type -> Sol's value (pick b);
 *  - a finding: pick b takes Sol's name, and with it Sol's customer_wording and
 *    confirmation_step (both were written for that name — leaving Gemini's would
 *    describe the wrong cause); pick a keeps Gemini's finding as is. Either
 *    way confidence is capped at moderate, never raised.
 * 'neither' (a third answer) or no pick leaves the item exactly as Gemini's. */
function mergeReferee(geminiJson, solJson, disputes, picks) {
  const merged = JSON.parse(JSON.stringify(geminiJson));
  const settled = [];
  for (const dispute of disputes) {
    const pick = picks[dispute.id];
    if (pick !== 'a' && pick !== 'b') continue;
    if (dispute.kind === 'grass_type') {
      if (pick === 'b') merged.grass_type = solJson.grass_type;
    } else {
      const target = merged.findings[dispute.geminiIndex];
      if (pick === 'b') {
        const sol = solJson.findings[dispute.solIndex];
        target.name = sol.name;
        target.customer_wording = sol.customer_wording;
        target.confirmation_step = sol.confirmation_step;
      }
      target.confidence = capAtModerate(target.confidence);
    }
    settled.push(dispute.id);
  }
  return { merged, settled };
}

const legInfo = (result, route) => ({
  model: result?.model || route?.model || null,
  ok: !!result?.ok,
  reason: result?.ok ? null : (result?.reason || 'error'),
  usage: result?.usage || null,
});

// The gate-on diagnostic for a visit the referee did not act on.
const skipped = (reason, extra = {}) => ({
  triggered: false, outcome: 'skipped', reason,
  secondOpinion: { called: false, reasons: [], model: null, ok: false },
  disputes: [], ambiguous: 0, usage: null, ...extra,
});

/**
 * The whole gated pass over a successful Gemini answer. `payload` is the exact
 * payload Gemini was sent (so Sol sees the same prompt, images and schema);
 * `visit` = { photoCount, images, context }. Returns { json, referee } where
 * `json` is Gemini's own object untouched unless a dispute settled. Never throws.
 */
async function refereeVisit({ policy, payload, geminiJson, visit }) {
  try {
    const reasons = secondOpinionReasons(geminiJson);
    if (!reasons.length) return { json: geminiJson, referee: skipped('not_unsure_or_serious') };
    const solRoute = policy?.fallback;
    if (!solRoute || !solRoute.provider || !solRoute.model) return { json: geminiJson, referee: skipped('no_second_opinion_route', { secondOpinion: { called: false, reasons, model: null, ok: false } }) };

    // Same system prompt, images, schema; Gemini-only knobs dropped.
    const solPayload = { ...payload };
    delete solPayload.thinkingLevel;
    const solResult = await boundedDispatch(solRoute, { ...solPayload, promptVersion: `${PROMPT_VERSION}:second-opinion` }, SECOND_OPINION_MAX_MS);
    const solInfo = { called: true, reasons, ...legInfo(solResult, solRoute) };
    const solValid = solResult.ok && validateAssessmentJson(solResult, visit.photoCount) === null;
    if (solResult.ok && !solValid) { solInfo.ok = false; solInfo.reason = 'malformed_assessment'; }
    if (!solValid) {
      return { json: geminiJson, referee: { ...skipped('second_opinion_failed'), secondOpinion: solInfo, usage: null } };
    }

    const { disputes, ambiguous } = findDisputes(geminiJson, solResult.json);
    const base = { secondOpinion: solInfo, disputes: disputes.map(publicDispute), ambiguous };
    if (!disputes.length) return { json: geminiJson, referee: { ...skipped(ambiguous ? 'ambiguous_pairing' : 'no_dispute'), ...base } };

    const route = MODELS.ROUTES.lawnAssessmentReferee;
    const result = await boundedDispatch(route, {
      system: buildRefereeSystem(disputes),
      text: `${buildUserText(visit.photoCount, visit.context)}\n\nSettle only the disputed names listed in the system prompt.`,
      images: visit.images,
      jsonMode: true,
      jsonSchema: REFEREE_SCHEMA,
      maxTokens: REFEREE_MAX_TOKENS,
      laneId: 'lawn_assessment_referee',
      promptVersion: `${PROMPT_VERSION}:referee`,
    }, REFEREE_MAX_MS);
    const picks = result.ok ? usablePicks(result.json, disputes) : null;
    const refereeInfo = { triggered: true, ...base, referee: legInfo(result, route), usage: result.usage || null };
    if (!picks) {
      return { json: geminiJson, referee: { ...refereeInfo, outcome: 'unavailable', reason: result.ok ? 'schema_invalid' : (result.reason || 'error') } };
    }
    const { merged, settled } = mergeReferee(geminiJson, solResult.json, disputes, picks);
    refereeInfo.disputes = disputes.map((d) => ({ ...publicDispute(d), pick: picks[d.id] || null, settled: settled.includes(d.id) }));
    if (!settled.length) return { json: geminiJson, referee: { ...refereeInfo, outcome: 'no_majority', reason: null } };
    return { json: merged, referee: { ...refereeInfo, outcome: 'settled', reason: null } };
  } catch (err) {
    logger.warn(`[lawn-visit-referee] failed, keeping the first read: ${err.message}`);
    return { json: geminiJson, referee: skipped('error') };
  }
}

// Diagnostic view of a dispute: names and where, never the indexes' raw findings.
function publicDispute(d) {
  return {
    id: d.id, kind: d.kind, geminiName: oneLine(d.geminiName), solName: oneLine(d.solName),
    ...(d.kind === 'finding' ? { photoRefs: d.photoRefs, zone: d.zone } : {}),
  };
}

module.exports = {
  refereeVisit,
  skippedReferee: skipped,
  secondOpinionReasons,
  findDisputes,
  causeLabelsOf,
  mergeReferee,
  usablePicks,
  buildRefereeSystem,
  REFEREE_SCHEMA,
  REFEREE_MAX_MS,
  SECOND_OPINION_MAX_MS,
};
