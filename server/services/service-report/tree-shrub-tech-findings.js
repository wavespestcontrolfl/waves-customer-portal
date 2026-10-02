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
//
// PRIMARY guard: PALM_CROWN_PROMPT_RULE reaches the vision prompt and the report
// writer on every tree_shrub generation with the gate on. The strip below is a
// narrow BACKSTOP for copy that slips past the instruction: it works one CLAUSE
// at a time and removes only a clause that makes a positive health / normal
// claim about a palm's crown, spear leaf, upper or newest fronds. It is run on
// tree_shrub copy only (callers decide), never on lawn or pest copy.

const CROWN_TERM = /\b(?:crown(?:shaft)?s?|spear(?:\s+(?:leaf|leaves|fronds?))?|newest\s+(?:fronds?|growth|leaves)|new\s+fronds?|emerging\s+(?:fronds?|growth|leaves)|upper\s+(?:fronds?|canopy)|(?:top|head)\s+of\s+(?:the|a|this|that|each)\s+palms?)\b/i;
// Only a palm-crown claim when the sentence is about a palm: "new growth" or a
// "canopy" on a hedge is not.
const PALM_ONLY_TERM = /\b(?:new(?:est)?\s+(?:growth|leaves|foliage|shoots)|canopy)\b/i;
// A clause that names a non-palm plant is about that plant, even when a palm is
// named elsewhere in the sentence ("..., but the hedge canopy looks healthy").
const NON_PALM_SUBJECT = /\b(?:hedges?|shrubs?|bush(?:es)?|trees?|oaks?|maples?|magnolias?|citrus|crotons?|ixoras?|viburnums?|hibiscus|gardenias?|azaleas?|podocarpus|cocoplums?|clusias?|jasmine|bougainvilleas?|roses?|ferns?|beds?|groundcovers?|perennials?|annuals?|plantings?)\b/i;
const PALM_WORD = /\b(?:palms?|fronds?|spear|crown|cabbage|sabal|royal|queen|date|coconut|areca|foxtail|sylvester|washingtonia|pindo|bismarck|livistona)\b/i;
const HEALTH_TERM = /\b(?:healthy|fine|normal|good|great|excellent|vibrant|full|robust|firm|upright|strong|vigorous|vigor|thriving|green|lush|intact|unaffected|undamaged|clean|okay|ok|looking good|free (?:of|from)|no (?:visible )?(?:signs?|issues?|problems?|concerns?|damage|decline|stress|pests?))\b/gi;
// A health word is NOT a positive claim when a negator, an adverse word or a
// can't-assess marker sits in the few words before it ("not healthy", "poor
// health", "couldn't check ... health") or a not-shown marker right after it.
const NEGATED_BEFORE = /(?:\b(?:not|no longer|never|hardly|barely|far from|without|poor|poorly|declining|decline|declined|reduced|lack|lacking|loss|compromised|weak|weakened|failing|worsening|unable|cannot|unclear|unknown|uncertain|unsure|out of (?:view|sight|reach)|too (?:high|tall))\b|n['’]t\b|\bcould not\b)/i;
// "no healthy fronds" / "No healthy spear leaf was visible" are adverse: a bare
// "no" right before the health word negates it. Only directly before — "No
// problems, the crown looks healthy" and "no visible damage" stay claims.
const NO_DIRECTLY_BEFORE = /\bno\s+$/i;
const NOT_SHOWN_AFTER = /^\W*(?:\w+\W+){0,3}?(?:not\s+(?:shown|visible|possible|clear\w*|assess\w*|check\w*|inspect\w*|in view|able)|out of (?:view|sight)|unknown|unclear)\b/i;

// True when the clause makes a POSITIVE health / normal claim. A ground-level
// phrase does not excuse it ("From the ground, the crown looks healthy" is the
// prohibited reassurance); negated or adverse statements and pure can't-assess
// disclaimers are not positive claims.
function makesPositiveHealthClaim(clause) {
  const c = String(clause || '');
  for (const m of c.matchAll(HEALTH_TERM)) {
    const before = c.slice(0, m.index).split(/\s+/).slice(-5).join(' ');
    const after = c.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (NO_DIRECTLY_BEFORE.test(c.slice(0, m.index))) continue;
    if (!NEGATED_BEFORE.test(before) && !NOT_SHOWN_AFTER.test(after)) return true;
  }
  return false;
}

// `sentenceHasPalm` lets a bare "canopy" / "new growth" clause count when the
// palm is named elsewhere in the same sentence.
function isCrownHealthClaim(clause, sentenceHasPalm = false) {
  const c = String(clause || '');
  const crownish = CROWN_TERM.test(c)
    || (PALM_ONLY_TERM.test(c) && (PALM_WORD.test(c) || (sentenceHasPalm && !NON_PALM_SUBJECT.test(c))));
  return crownish && makesPositiveHealthClaim(c);
}

// Sentence splitting that never loses text: pieces always concatenate back to
// the input. A terminator is . ! ? (with any closing quote/bracket) followed by
// whitespace and then a capital, digit or quote, or by the end; decimals
// ("3.5 m"), abbreviations ("e.g.", "a.m.", "vs.") and lowercase continuations
// are not boundaries.
const ABBREVIATION_BEFORE_DOT = /(?:^|[\s(])(?:e\.g|i\.e|a\.m|p\.m|vs|etc|approx|ca|dr|mr|mrs|ms|st|no|ft|in|oz|sq)$/i;
function splitSentences(line) {
  const out = [];
  let start = 0;
  const re = /[.!?]+["')\]”’*_~]*(?=\s+["'(“‘]?[A-Z0-9]|\s*$)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const end = m.index + m[0].length;
    if (m[0][0] === '.' && ABBREVIATION_BEFORE_DOT.test(line.slice(0, m.index)) && end < line.length) continue;
    const ws = /^\s*/.exec(line.slice(end))[0].length;
    out.push(line.slice(start, end + ws));
    start = end + ws;
  }
  if (start < line.length) out.push(line.slice(start));
  return out;
}

// Clause joins inside a sentence. " and " only splits when what follows opens a
// new clause (a determiner/pronoun) AND what precedes is already a predicate, so
// a joined subject ("The crown and the spear leaf look healthy") stays whole.
const CLAUSE_JOIN = /(;\s*|,?\s+(?:but|while|whereas|although|though|yet)\s+|,?\s+and\s+(?=(?:the|a|an|its|their|his|her|these|those|it|they)\b)\s*|,\s+(?=(?:the|its|their|these|those|it|they)\b))/i;
const HAS_PREDICATE = /\b(?:is|are|was|were|looks?|looked|appears?|appeared|seems?|seemed|shows?|showed|has|have|had|remains?|stays?|collapsed|declin\w*|\w+ed)\b|n['’]t\b/i;
const PRONOUN_START = /^\s*(?:it|they|this|that|these|those)\b/i;
const ORPHAN_START = /^\s*(?:(?:it|this|that)\s+(?:is|was|isn['’]t|remains|cannot|can['’]t|couldn['’]t|could\s+not)\b|is|are|was|were|not|isn['’]t|aren['’]t|cannot|can['’]t|couldn['’]t|remains?|has|have|looks?|appears?|seems?)\b/i;

function splitClauses(body) {
  const parts = body.split(CLAUSE_JOIN);
  const clauses = [{ text: parts[0], joinBefore: '' }];
  for (let i = 1; i < parts.length; i += 2) {
    const sep = parts[i];
    const text = parts[i + 1] || '';
    // Soft joins (", the ..." / "and the ...") only split after a full predicate.
    const isSoft = !/^\s*;|\b(?:but|while|whereas|although|though|yet)\b/i.test(sep);
    const last = clauses[clauses.length - 1];
    if (isSoft && !HAS_PREDICATE.test(last.text)) {
      last.text += sep + text;
    } else {
      clauses.push({ text, joinBefore: sep });
    }
  }
  return clauses;
}

// Strip positive crown claims from ONE sentence (terminator and trailing
// whitespace included); returns the sentence unchanged when nothing matched.
function stripSentence(sentence) {
  const m = /^([\s\S]*?)([.!?]+["')\]”’*_~]*\s*)?$/.exec(sentence);
  const body = m[1];
  const tail = m[2] || '';
  const lead = /^\s*/.exec(body)[0];
  const core = body.slice(lead.length);
  const hasPalm = PALM_WORD.test(core);
  const clauses = splitClauses(core);
  let dropNext = false;
  let changed = false;
  let prevCrownish = false;
  const kept = [];
  for (const clause of clauses) {
    const crownish = CROWN_TERM.test(clause.text)
      || (PALM_ONLY_TERM.test(clause.text) && (PALM_WORD.test(clause.text) || (hasPalm && !NON_PALM_SUBJECT.test(clause.text))));
    // "... the crown, but it looks healthy": a bare pronoun clause right after a
    // crown clause vouches for the crown.
    const pronounClaim = prevCrownish && PRONOUN_START.test(clause.text) && makesPositiveHealthClaim(clause.text);
    const claim = isCrownHealthClaim(clause.text, hasPalm) || pronounClaim;
    prevCrownish = crownish;
    // An orphaned remainder ("... is not clearly visible") that followed a
    // dropped clause has lost its subject: it goes with it.
    if (claim || (dropNext && ORPHAN_START.test(clause.text))) {
      changed = true;
      dropNext = true;
      continue;
    }
    dropNext = false;
    kept.push(clause);
  }
  if (!changed) return sentence;
  if (!kept.length) return '';
  let out = kept.map((c, i) => (i === 0 ? c.text : c.joinBefore + c.text)).join('').replace(/[,;\s]+$/, '');
  if (/^[A-Z]/.test(core) && /^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return `${lead}${out}${tail}`;
}

// Remove every positive crown / spear / newest-frond health claim. Unchanged
// text (including non-strings) comes back as the same value. A line that loses
// every sentence is removed with them; blank separator lines stay.
function stripCrownHealthClaims(text) {
  if (typeof text !== 'string' || !text) return text;
  let changed = false;
  const original = text.split('\n');
  const lines = original.map((line) => {
    const sentences = splitSentences(line);
    const rebuilt = sentences.map((sentence) => {
      const next = stripSentence(sentence);
      if (next !== sentence) changed = true;
      return next;
    });
    return rebuilt.join('').trimEnd();
  });
  if (!changed) return text;
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
  // Whitespace collapses FIRST so a code split across a line break ("Gate:\n4521")
  // reads as one phrase to the redactor.
  const t = redactCodes(value.replace(/\s+/g, ' ').trim()).slice(0, MAX_DETAIL_CHARS);
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

// The repo's customer-copy compliance screen (the same one a tech's own tip
// line passes). Lazy for the same reason as redactCodes.
function copyViolations(text) {
  return require('./technician-report-copy').customerCopyViolations(text);
}

// The text a customer may read for an edit: the technician's words, minus any
// crown-health sentence (the palm rule outranks an edit). Wording the
// compliance screen rejects never prints (completion refuses it first; this is
// the render-side backstop for anything frozen another way).
function editText(finding) {
  if (!finding || finding.action !== 'edit') return null;
  // Redact before the char cap could split a code, and again nowhere else: every
  // customer path reads the technician's text through here.
  const text = stripCrownHealthClaims(redactCodes(cleanDetail(finding.detail) || ''));
  if (!text || !text.trim() || copyViolations(text).length) return null;
  return text.trim();
}

// Edits whose wording fails the customer-copy screen, for the completion route
// to refuse with an actionable message (like a tech's own tip line). Empty with
// the gate off.
function rejectedTechFindingEdits(review) {
  if (!techFindingsCopyLive()) return [];
  return normalizeTechFindings(review && review.decisions)
    .filter((f) => f.action === 'edit' && f.detail)
    .map((f) => ({ key: f.key, label: f.label, violations: copyViolations(f.detail) }))
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

// Caption vocabulary per finding. A caption is tied to a finding when it uses
// that finding's words; one with generic assessment wording ("visible signals")
// cannot be placed reliably and is treated as tied to every replaced finding.
const CAPTION_WORDS = {
  pest_activity: /\b(?:pests?|insects?|scale|mites?|aphids?|whiteflies|whitefly|mealybugs?|thrips|caterpillars?|crawlers?|stippl\w*|speckl\w*|sticky|residue|black\s+film|webbing|sooty|chew\w*|honeydew|infest\w*)\b/i,
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

// Customer-facing photo captions under the technician's decisions: a caption on
// a hidden / edited finding's subject is dropped, then the crown strip runs.
// Strings in, strings out (empties removed).
function filterCaptionsForCustomer(captions, findings) {
  const replaced = (Array.isArray(findings) ? findings : [])
    .filter((f) => f && (f.action === 'hidden' || (f.action === 'edit' && editText(f))))
    .map((f) => f.key);
  return (Array.isArray(captions) ? captions : [])
    .filter((c) => typeof c === 'string' && !captionTiedToReplacedFinding(c, replaced))
    .map((c) => stripCrownHealthClaims(c))
    .filter((c) => typeof c === 'string' && c.trim());
}

// A photo summary written about the photos as a whole: a hidden or edited
// finding withdraws it (it could repeat what the technician replaced); the
// crown strip applies otherwise. Returns null when nothing is left.
function summaryForCustomer(summary, findings) {
  if (typeof summary !== 'string' || !summary.trim()) return null;
  const replacedAny = (Array.isArray(findings) ? findings : [])
    .some((f) => f && (f.action === 'hidden' || (f.action === 'edit' && editText(f))));
  if (replacedAny) return null;
  const out = stripCrownHealthClaims(summary);
  return typeof out === 'string' && out.trim() ? out : null;
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
  captionTiedToReplacedFinding,
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
