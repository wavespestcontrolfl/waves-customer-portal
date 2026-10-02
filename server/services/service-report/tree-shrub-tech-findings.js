/**
 * Tree & Shrub tech findings in customer copy (GATE_TS_TECH_FINDINGS_COPY,
 * owner 2026-10-02: lawn rulings applied to T&S).
 *
 * After Analyze, the technician keeps, confirms, hides or edits each photo-read
 * finding. The decisions ride the /complete body (treeShrubReview.decisions).
 * This module owns three things, all pure and all dark behind the gate:
 *
 *  1. FREEZE — normalize the decisions into structured_notes.treeShrubTechFindings
 *     whether or not the signed preview was accepted (a failed signature makes
 *     the server re-score and drop the decisions; the freeze keeps them).
 *  2. OVERLAY — the customer report reads the frozen decisions: a hidden finding
 *     never appears (no score, no chip, no sentence, no insight, no photo
 *     summary written from the read that included it); a confirmed finding reads
 *     as the technician's finding; an edit uses the technician's own text;
 *     monitor keeps today's signals-only language. The photo read itself stays
 *     stored on the assessment row for the office — only customer copy changes.
 *  3. PALM-CROWN RULE (owner 2026-10-01) — photos are ground level, so no
 *     customer copy may state or imply that a palm's crown, spear leaf or newest
 *     fronds look healthy. stripCrownHealthClaims removes such a sentence.
 */

const KEY_TO_SCORE = {
  foliage_fullness: 'foliageFullness',
  leaf_color_vigor: 'leafColorVigor',
  pest_activity: 'pestActivity',
  disease_leaf_spot: 'diseaseLeafSpot',
  water_heat_mechanical_stress: 'waterHeatStress',
};

// Tech-facing finding labels (the closeout cards). One home so the sheet's
// finding cards and the frozen decisions can never name a finding differently.
const TECH_FINDING_LABELS = {
  pest_activity: 'Pest-pressure signals',
  disease_leaf_spot: 'Leaf-spot / disease signals',
  water_heat_mechanical_stress: 'Water / heat / pruning stress',
  leaf_color_vigor: 'Leaf color & vigor',
  foliage_fullness: 'Foliage fullness',
};

const ACTIONS = ['monitor', 'confirmed', 'hidden', 'edit'];
const MAX_DETAIL_CHARS = 400;

// Insight card category -> the finding keys behind it.
const INSIGHT_FINDING_KEYS = {
  pest_pressure: ['pest_activity'],
  disease_leaf_spot: ['disease_leaf_spot'],
  water_stress: ['water_heat_mechanical_stress'],
  color_vigor: ['leaf_color_vigor', 'foliage_fullness'],
};

// What a confirmed finding says, as the technician's finding. Stays in signals
// language for pest and disease: the technician confirmed what was SEEN, the
// report still never names an infestation or a diagnosis.
const CONFIRMED_SENTENCE = {
  pest_activity: 'Your technician confirmed visible pest activity on some foliage during the visit.',
  disease_leaf_spot: 'Your technician confirmed leaf-spot or disease-like signals on the foliage during the visit.',
  water_heat_mechanical_stress: 'Your technician confirmed water, heat, or pruning stress on some of the plants during the visit.',
  leaf_color_vigor: 'Your technician confirmed off-color foliage in places during the visit.',
  foliage_fullness: 'Your technician confirmed some thin or sparse areas during the visit.',
};

function techFindingsCopyLive() {
  const gates = require('../../config/feature-gates');
  return typeof gates.tsTechFindingsCopyLive === 'function' && gates.tsTechFindingsCopyLive() === true;
}

// ── Palm-crown rule ────────────────────────────────────────────────────────────

const CROWN_TERM = /\b(?:crown(?:shaft)?s?|spear(?:\s+(?:leaf|leaves|fronds?))?|newest\s+(?:fronds?|growth|leaves)|new\s+fronds?|emerging\s+(?:fronds?|growth|leaves))\b/i;
// "new growth" alone is fine on a hedge; it is a palm-crown claim only in a palm sentence.
const NEW_GROWTH_TERM = /\bnew(?:est)?\s+(?:growth|leaves|foliage|shoots)\b/i;
const PALM_CONTEXT = /\b(?:palms?|fronds?|spear|crown)/i;
const HEALTH_TERM = /\b(?:healthy|fine|normal|good|great|strong|vigorous|vigor|thriving|green|lush|intact|unaffected|undamaged|clean|okay|ok|looking good|free (?:of|from)|no (?:visible )?(?:signs?|issues?|problems?|concerns?|damage|decline|stress|pests?))\b/gi;
// A health word is NOT a positive claim when a negator, an adverse word or a
// can't-assess marker sits in the few words before it ("not healthy", "poor
// health", "couldn't check ... health") or a not-shown marker right after it.
const NEGATED_BEFORE = /(?:\b(?:not|no longer|never|hardly|barely|far from|without|poor|poorly|declining|decline|declined|reduced|lack|lacking|loss|compromised|weak|weakened|failing|worsening|unable|cannot|unclear|unknown|uncertain|unsure|out of (?:view|sight|reach)|too (?:high|tall))\b|n['’]t\b|\bcould not\b)/i;
const NOT_SHOWN_AFTER = /^\W*(?:\w+\W+){0,3}?(?:not\s+(?:shown|visible|possible|clear\w*|assess\w*|check\w*|inspect\w*|in view|able)|out of (?:view|sight)|unknown|unclear)\b/i;

// True when the sentence makes a POSITIVE health / normal claim. A ground-level
// phrase does not excuse it ("From the ground, the crown looks healthy" is the
// prohibited reassurance); negated or adverse statements and pure can't-assess
// disclaimers are not positive claims.
function makesPositiveHealthClaim(sentence) {
  const s = String(sentence || '');
  for (const m of s.matchAll(HEALTH_TERM)) {
    const before = s.slice(0, m.index).split(/\s+/).slice(-5).join(' ');
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (!NEGATED_BEFORE.test(before) && !NOT_SHOWN_AFTER.test(after)) return true;
  }
  return false;
}

function isCrownHealthClaim(sentence) {
  const s = String(sentence || '');
  if (!(CROWN_TERM.test(s) || (NEW_GROWTH_TERM.test(s) && PALM_CONTEXT.test(s)))) return false;
  return makesPositiveHealthClaim(s);
}

// Remove every sentence that vouches for a palm's crown, spear leaf or newest
// fronds. Unchanged text (including non-strings) comes back as the same value.
function stripCrownHealthClaims(text) {
  if (typeof text !== 'string' || !text) return text;
  let changed = false;
  const original = text.split('\n');
  const lines = original.map((line) => {
    const sentences = line.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)\s*/g);
    if (!sentences) return line;
    const kept = sentences.filter((sentence) => {
      if (isCrownHealthClaim(sentence)) { changed = true; return false; }
      return true;
    });
    return kept.length === sentences.length ? line : kept.join('').trimEnd();
  });
  if (!changed) return text;
  // A line that lost every sentence goes with them; blank lines the writer
  // already had stay (they separate sections).
  return lines.filter((line, i) => line.trim() !== '' || original[i].trim() === '').join('\n');
}

// ── Freeze ─────────────────────────────────────────────────────────────────────

// The repo's canonical access-code redactor (report/track egress rule): gate,
// garage, lockbox and alarm codes never reach customer copy. Lazy so this pure
// module does not load the aggregator's dependencies until text needs it.
function redactCodes(text) {
  return require('../context-aggregator').redactAccessCodes(text);
}

function cleanDetail(value) {
  if (typeof value !== 'string') return null;
  // Redacted at the freeze too, so a code typed into an edit is never stored.
  const t = redactCodes(value).replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  return t || null;
}

// Decisions from the wire -> the durable shape. Unknown keys/actions drop; the
// first decision for a key wins.
function normalizeTechFindings(decisions) {
  if (!Array.isArray(decisions)) return [];
  const seen = new Set();
  const out = [];
  for (const d of decisions) {
    if (!d || typeof d !== 'object' || !Object.hasOwn(KEY_TO_SCORE, d.key) || !ACTIONS.includes(d.action)) continue;
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push({
      key: d.key,
      action: d.action,
      detail: cleanDetail(d.detail),
      label: TECH_FINDING_LABELS[d.key],
    });
  }
  return out;
}

// The structured_notes fields for a completion, or null when there is nothing to
// freeze (gate off, no decisions). Independent of the signed preview.
function freezeTechFindings(review, { now = new Date() } = {}) {
  if (!techFindingsCopyLive()) return null;
  const findings = normalizeTechFindings(review && review.decisions);
  if (!findings.length) return null;
  return {
    treeShrubTechFindings: findings,
    treeShrubTechFindingsDecidedAt: now.toISOString(),
  };
}

// ── Report overlay ─────────────────────────────────────────────────────────────

function findingFor(findings, key) {
  return (Array.isArray(findings) ? findings : []).find((f) => f && f.key === key) || null;
}

// The text a customer may read for an edit: the technician's words, minus any
// crown-health sentence (the palm rule outranks an edit).
function editText(finding) {
  if (!finding || finding.action !== 'edit') return null;
  // Redact before the char cap could split a code, and again nowhere else: every
  // customer path reads the technician's text through here.
  const text = stripCrownHealthClaims(redactCodes(cleanDetail(finding.detail) || ''));
  return text && text.trim() ? text.trim() : null;
}

/**
 * Apply the frozen decisions to the assessment payload the report builder
 * consumes. Hidden: the score and the overall it influenced are nulled (the
 * category reads "tracking", never healthy), and the photo-read prose written
 * from signals that included it is dropped. Edit: the prose is dropped too (it
 * would contradict the technician's text). The input is not mutated.
 */
// Hidden decisions applied to one visit's formatted scores (the history path).
// formatAssessmentScores() only knows decisions stored in composite_scores
// (the accepted-preview path); a visit whose preview was rejected and re-scored
// keeps its hides only in structured_notes.treeShrubTechFindings.
function hideFrozenFindingsInScores(scores, findings) {
  const hidden = (Array.isArray(findings) ? findings : []).filter((f) => f && f.action === 'hidden');
  if (!hidden.length || !scores) return scores;
  const next = { ...scores, overallScore: null };
  for (const f of hidden) next[KEY_TO_SCORE[f.key]] = null;
  return next;
}

// Frozen decisions for a set of assessment rows, keyed by service_record_id.
// One read; a failed read means no extra hiding (never a throw into the report).
async function loadFrozenTechFindingsByRecord(rows, knex) {
  const ids = [...new Set((Array.isArray(rows) ? rows : []).map((r) => r && r.service_record_id).filter(Boolean))];
  const byRecord = new Map();
  if (!ids.length) return byRecord;
  const records = await knex('service_records').whereIn('id', ids).select('id', 'structured_notes').catch(() => []);
  for (const rec of Array.isArray(records) ? records : []) {
    let notes = rec.structured_notes;
    if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
    const findings = normalizeTechFindings(notes && notes.treeShrubTechFindings);
    if (findings.length) byRecord.set(String(rec.id), findings);
  }
  return byRecord;
}

// Caption vocabulary per finding. A caption is tied to a finding when it uses
// that finding's words; one with generic assessment wording ("visible signals")
// cannot be placed reliably and is treated as tied to every replaced finding.
const CAPTION_WORDS = {
  pest_activity: /\b(?:pests?|insects?|scale|mites?|aphids?|whiteflies|whitefly|mealybugs?|thrips|caterpillars?|stippl\w*|webbing|sooty|chew\w*|honeydew|infest\w*)\b/i,
  disease_leaf_spot: /\b(?:leaf[-\s]?spot\w*|fung\w*|disease\w*|mildew|blight|anthracnose|mold|rot|lesions?|spotting)\b/i,
  water_heat_mechanical_stress: /\b(?:dry|wilt\w*|scorch\w*|stress\w*|water\w*|crispy|prun\w*|drought|heat|sunburn|mechanical|damage\w*)\b/i,
  leaf_color_vigor: /\b(?:yellow\w*|chlorosis|pale|bronz\w*|colou?r\w*|discolou?r\w*|deficien\w*|vigor|off-color)\b/i,
  foliage_fullness: /\b(?:thin\w*|sparse|bare|dieback|gaps?|dense|fullness|canopy|foliage)\b/i,
};
const GENERIC_ASSESSMENT_WORDS = /\b(?:signals?|visible|possible|appears?|apparent|issues?|concerns?|problems?|activity|symptoms?|conditions?|health\w*|signs?|observed|noted|detected)\b/i;

// True when a photo caption speaks for a finding the technician replaced
// (hidden, or edited with their own text) and must not reach customer copy.
function captionTiedToReplacedFinding(caption, replacedKeys) {
  if (typeof caption !== 'string' || !caption.trim() || !replacedKeys.length) return false;
  if (GENERIC_ASSESSMENT_WORDS.test(caption)) return true;
  return replacedKeys.some((key) => CAPTION_WORDS[key] && CAPTION_WORDS[key].test(caption));
}

function applyTechFindingsToAssessment(assessment, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const hidden = list.filter((f) => f.action === 'hidden');
  const edited = list.filter((f) => editText(f));
  const next = { ...assessment, scores: { ...(assessment.scores || {}) } };
  if (hidden.length) {
    for (const f of hidden) next.scores[KEY_TO_SCORE[f.key]] = null;
    next.scores.overallScore = null;
    if (Array.isArray(assessment.trend) && assessment.trend.length) {
      // The last trend point IS this visit; earlier visits keep their own reads.
      const last = { ...assessment.trend[assessment.trend.length - 1], overallScore: null };
      for (const f of hidden) {
        const field = KEY_TO_SCORE[f.key];
        if (Object.hasOwn(last, field)) last[field] = null;
      }
      next.trend = [...assessment.trend.slice(0, -1), last];
    }
  }
  if (hidden.length || edited.length) {
    // A caption on a replaced finding's subject goes too; the photo itself stays.
    const replaced = [...hidden, ...edited].map((f) => f.key);
    if (Array.isArray(assessment.photos)) {
      next.photos = assessment.photos.map((p) => (
        p && captionTiedToReplacedFinding(p.caption, replaced) ? { ...p, caption: null } : p
      ));
    }
    next.observations = '';
    next.aiSummary = null;
    next.customerSummary = '';
  }
  const confirmed = (key) => !!list.find((f) => f.key === key && f.action === 'confirmed');
  next.techConfirmedPest = !!assessment.techConfirmedPest || confirmed('pest_activity');
  next.techConfirmedDisease = !!assessment.techConfirmedDisease || confirmed('disease_leaf_spot');
  return next;
}

// The line a diagnosis row (one of the five categories) shows for a decision, or
// null to keep the system-written explanation.
function diagnosisOverride(finding, current) {
  if (!finding) return null;
  const edit = editText(finding);
  if (edit) return edit;
  if (finding.action === 'confirmed') {
    return current ? `Confirmed by your technician during the visit. ${current}` : CONFIRMED_SENTENCE[finding.key];
  }
  return null;
}

// The whatWeSaw line an insight card shows for its findings, or null.
function insightOverride(cardCategory, findings) {
  const keys = INSIGHT_FINDING_KEYS[cardCategory] || [];
  for (const key of keys) {
    const edit = editText(findingFor(findings, key));
    if (edit) return edit;
  }
  for (const key of keys) {
    const f = findingFor(findings, key);
    if (f && f.action === 'confirmed') return CONFIRMED_SENTENCE[key];
  }
  return null;
}

// True when the card is built on a finding the technician hid.
function insightHidden(cardCategory, findings) {
  return (INSIGHT_FINDING_KEYS[cardCategory] || []).some((key) => {
    const f = findingFor(findings, key);
    return !!f && f.action === 'hidden';
  });
}

// ── Report-writer prompt ───────────────────────────────────────────────────────

const PALM_CROWN_PROMPT_RULE = 'PHOTO REACH: photos are taken from the ground, so never state or imply that a palm\'s crown, spear leaf or newest fronds look healthy, fine or normal. Describe only what a whole-palm or oldest-fronds photo shows.';

// Prompt lines for the decisions the writer must honour, or '' when none apply.
function techFindingsPromptLines(findings) {
  const lines = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    const label = TECH_FINDING_LABELS[f.key];
    if (!label) continue;
    const edit = editText(f);
    if (edit) lines.push(`- ${label}: the technician wrote: ${edit} (use the technician's words; they replace the photo read)`);
    else if (f.action === 'confirmed') lines.push(`- ${label}: the technician confirmed it during the visit (it may be stated as the technician's finding)`);
  }
  return lines.join('\n');
}

// True when the technician's decisions give the writer something to say (a
// confirmed finding or their own text), even with no photo scores left.
function hasTechFindingLines(findings) {
  return techFindingsPromptLines(findings) !== '';
}

module.exports = {
  hasTechFindingLines,
  hideFrozenFindingsInScores,
  loadFrozenTechFindingsByRecord,
  KEY_TO_SCORE,
  TECH_FINDING_LABELS,
  INSIGHT_FINDING_KEYS,
  PALM_CROWN_PROMPT_RULE,
  techFindingsCopyLive,
  isCrownHealthClaim,
  stripCrownHealthClaims,
  normalizeTechFindings,
  freezeTechFindings,
  applyTechFindingsToAssessment,
  diagnosisOverride,
  insightOverride,
  insightHidden,
  editText,
  techFindingsPromptLines,
};
