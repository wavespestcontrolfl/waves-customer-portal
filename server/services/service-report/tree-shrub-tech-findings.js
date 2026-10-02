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
const HEALTH_TERM = /\b(?:healthy|health|fine|normal|good|great|strong|vigorous|vigor|thriving|green|lush|intact|unaffected|undamaged|clean|clear|okay|ok|looking good|free (?:of|from)|no (?:visible )?(?:signs?|issues?|problems?|concerns?|damage|decline|stress|pests?))\b/i;
// A disclaimer ("we couldn't see the crown from the ground") is exactly the
// honest sentence; never strip it.
const DISCLAIMER = /\b(?:can['’]t|cannot|could(?:\s+not|n['’]t)|unable to|not (?:visible|possible|able to)|out of (?:view|sight|reach)|too (?:high|tall)|ground[-\s]level|from the ground)\b/i;

function isCrownHealthClaim(sentence) {
  const s = String(sentence || '');
  if (!(CROWN_TERM.test(s) || (NEW_GROWTH_TERM.test(s) && PALM_CONTEXT.test(s)))) return false;
  return HEALTH_TERM.test(s) && !DISCLAIMER.test(s);
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

function cleanDetail(value) {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
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
  const text = stripCrownHealthClaims(cleanDetail(finding.detail) || '');
  return text && text.trim() ? text.trim() : null;
}

/**
 * Apply the frozen decisions to the assessment payload the report builder
 * consumes. Hidden: the score and the overall it influenced are nulled (the
 * category reads "tracking", never healthy), and the photo-read prose written
 * from signals that included it is dropped. Edit: the prose is dropped too (it
 * would contradict the technician's text). The input is not mutated.
 */
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

module.exports = {
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
