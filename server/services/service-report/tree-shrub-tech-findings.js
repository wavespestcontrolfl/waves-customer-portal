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
 *     fronds look healthy. PALM_CROWN_PROMPT_RULE instructs the photo read and
 *     the report writer; owner 2026-10-02: the instruction is the guard, no word
 *     filter on customer copy (one never converged in review).
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
  // Whitespace collapses FIRST so a code split across a line break ("Gate:\n4521")
  // reads as one phrase to the redactor.
  const t = redactCodes(value.replace(/\s+/g, ' ').trim()).slice(0, MAX_DETAIL_CHARS);
  return t || null;
}

// Decisions from the wire -> the durable shape. Unknown keys/actions drop; the
// first decision for a key wins.
// An edit whose printable text is empty (no text, or wording the
// customer-copy screen rejects) still withdrew the photo read: it reads as a
// hide, so no path falls back to the read the technician replaced. Completion
// refuses such an edit first (rejectedTechFindingEdits); this is the backstop
// for every reader, which all come through here.
function normalizeTechFindings(decisions) {
  return normalizeRawTechFindings(decisions)
    .map((f) => (f.action === 'edit' && !editText(f) ? { ...f, action: 'hidden' } : f));
}

function normalizeRawTechFindings(decisions) {
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

// The repo's customer-copy compliance screen (the same one a tech's own tip
// line passes). Lazy for the same reason as redactCodes.
function copyViolations(text) {
  return require('./technician-report-copy').customerCopyViolations(text);
}

// The text a customer may read for an edit: the technician's words. Wording
// the compliance screen rejects never prints (completion refuses it first; this is
// the render-side backstop for anything frozen another way).
function editText(finding) {
  if (!finding || finding.action !== 'edit') return null;
  // Redact before the char cap could split a code, and again nowhere else: every
  // customer path reads the technician's text through here.
  const text = redactCodes(cleanDetail(finding.detail) || '');
  if (!text || !text.trim() || copyViolations(text).length) return null;
  return text.trim();
}

// Edits whose wording fails the customer-copy screen, for the completion route
// to refuse with an actionable message (like a tech's own tip line). Empty with
// the gate off.
function rejectedTechFindingEdits(review) {
  if (!techFindingsCopyLive()) return [];
  return normalizeRawTechFindings(review && review.decisions)
    .filter((f) => f.action === 'edit')
    .map((f) => {
      const violations = f.detail ? copyViolations(f.detail) : [];
      if (!f.detail) violations.push('empty_edit');
      return { key: f.key, label: f.label, violations };
    })
    .filter((r) => r.violations.length);
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

// Every score of a visit whose decisions could not be loaded: withheld, because
// a hide we cannot see must not be republished as a healthy read.
function withholdScores(scores) {
  if (!scores) return scores;
  const next = { ...scores };
  for (const field of ['overallScore', ...Object.values(KEY_TO_SCORE)]) next[field] = null;
  return next;
}

// Frozen decisions for a set of assessment rows, keyed by service_record_id.
// One read. Returns null when the read FAILED (decisions unavailable — callers
// withhold the affected scores and refuse to cache); an empty Map means the
// decisions were read and there are none.
async function loadFrozenTechFindingsByRecord(rows, knex) {
  const ids = [...new Set((Array.isArray(rows) ? rows : []).map((r) => r && r.service_record_id).filter(Boolean))];
  const byRecord = new Map();
  if (!ids.length) return byRecord;
  const records = await Promise.resolve(knex('service_records').whereIn('id', ids).select('id', 'structured_notes'))
    .catch(() => null);
  if (!Array.isArray(records)) return null;
  for (const rec of records) {
    let notes = rec.structured_notes;
    if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
    const findings = normalizeTechFindings(notes && notes.treeShrubTechFindings);
    if (findings.length) byRecord.set(String(rec.id), findings);
  }
  return byRecord;
}

// True when the technician replaced any part of the photo read (a hide, or an
// edit in their own words).
function replacedAnyFinding(findings) {
  return (Array.isArray(findings) ? findings : [])
    .some((f) => f && (f.action === 'hidden' || (f.action === 'edit' && editText(f))));
}

// Customer-facing photo captions under the technician's decisions. Captions
// are photo-read prose with no reliable link to one finding, so ANY hide or
// edit withholds them all (the photos stay). Strings in, strings out (empties
// removed).
function filterCaptionsForCustomer(captions, findings) {
  if (replacedAnyFinding(findings)) return [];
  return (Array.isArray(captions) ? captions : [])
    .filter((c) => typeof c === 'string' && c.trim());
}

// A photo summary written about the photos as a whole: a hidden or edited
// finding withdraws it (it could repeat what the technician replaced). Returns
// null when there is none.
function summaryForCustomer(summary, findings) {
  if (typeof summary !== 'string' || !summary.trim()) return null;
  if (replacedAnyFinding(findings)) return null;
  return summary;
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
    // Every photo-read caption goes too (see filterCaptionsForCustomer); the
    // photos themselves stay.
    if (Array.isArray(assessment.photos)) {
      next.photos = assessment.photos.map((p) => (p ? { ...p, caption: null } : p));
    }
    next.observations = '';
    next.aiSummary = null;
    next.customerSummary = '';
    // Plant-group findings are photo-read prose too, with no reliable link to
    // one finding: withheld whole, like the captions.
    if (Array.isArray(assessment.plantGroups)) next.plantGroups = [];
  }
  const confirmed = (key) => !!list.find((f) => f.key === key && f.action === 'confirmed');
  next.techConfirmedPest = !!assessment.techConfirmedPest || confirmed('pest_activity');
  next.techConfirmedDisease = !!assessment.techConfirmedDisease || confirmed('disease_leaf_spot');
  return next;
}

// The line a diagnosis row (one of the five categories) shows for a decision, or
// null to keep the system-written explanation.
// A confirmation on a clean photo read ("No visible … today") would contradict
// itself, so only a flagged (watch / needs-attention) row keeps its photo sentence.
function diagnosisOverride(finding, current, status = 'watch') {
  if (!finding) return null;
  const edit = editText(finding);
  if (edit) return edit;
  if (finding.action === 'confirmed') {
    const flagged = status === 'watch' || status === 'needs_attention';
    return current && flagged ? `Confirmed by your technician during the visit. ${current}` : CONFIRMED_SENTENCE[finding.key];
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

// True when the card is built on a finding the technician hid AND the
// technician said nothing of their own on the card's other finding (a shared
// color / fullness card survives on the other finding's confirmation or edit).
function insightHidden(cardCategory, findings) {
  const hiddenAny = (INSIGHT_FINDING_KEYS[cardCategory] || []).some((key) => {
    const f = findingFor(findings, key);
    return !!f && f.action === 'hidden';
  });
  return hiddenAny && !insightOverride(cardCategory, findings);
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
  rejectedTechFindingEdits,
  withholdScores,
  summaryForCustomer,
  filterCaptionsForCustomer,
  hasTechFindingLines,
  hideFrozenFindingsInScores,
  loadFrozenTechFindingsByRecord,
  KEY_TO_SCORE,
  TECH_FINDING_LABELS,
  INSIGHT_FINDING_KEYS,
  PALM_CROWN_PROMPT_RULE,
  techFindingsCopyLive,
  normalizeTechFindings,
  freezeTechFindings,
  applyTechFindingsToAssessment,
  diagnosisOverride,
  insightOverride,
  insightHidden,
  editText,
  techFindingsPromptLines,
};
