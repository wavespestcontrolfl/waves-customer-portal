/**
 * Lawn report LEAD (lawn report rebuild P7, GATE_LAWN_REPORT_LEAD).
 *
 * The above-the-fold block of the web report: state, why, progress, what was
 * applied, the homeowner's part this week and the next visit, in one place so
 * each fact has ONE owner on screen. Pure and derived: every field is read off
 * the finished reportV2, never written by a model or composed from a second
 * source, so the lead can only repeat what the rest of the payload already
 * says. It is derived at the TAIL of applyLawnReportReconciliation (from the
 * final reconciled strings), so a rain-contradicted drought hypothesis is
 * already reworded here and no field needs its own drought pass.
 *
 * Action ownership: the watering banner (reportV2.banner) owns the
 * aftercare / watering task whenever it carries lines. Under a banner the
 * lead's "your part" is the top issue's own homeowner action, and only when it
 * does not restate the aftercare task the banner already shows, and no lead
 * field carries watering wording at all (the banner and the water card own it;
 * a field that is all watering falls to its next source, or to null, and the
 * client falls back to the status label for a null headline). The stock "No
 * action is needed" sentence is never emitted: an empty list renders nothing.
 */

const { aftercareCustomerTask, normalizeLawnAftercare } = require('./lawn-aftercare');
const { issueRestatesAftercare } = require('./lawn-report-insights');

// The client's static labels around the lead ("What we applied today", "Your
// part this week", "Next visit", the score ring word) count against the 250
// visible-word budget as one constant, not per label.
const STATIC_LABEL_WORDS = 24;
const YOUR_PART_MAX = 2;
// The lead region's visible-word ceiling (SCOPE content contract).
const LEAD_WORD_BUDGET = 250;
// Fields given up, in order, when a real payload runs over the budget. A
// generated treatment narrative can run to 1,200 characters (codex P2 #5496
// r4); what was applied is still listed in full under "What Waves did today"
// and Products Applied further down, so it goes last of the three.
const BUDGET_DROP_ORDER = ['progress', 'why', 'applied'];
// Per-field word caps. Model-written copy (the narrative overlay, a generated
// treatment narrative) reaches these fields unbounded, so any one field over
// its cap is left out of the lead rather than cut mid-sentence; the same
// text still prints on its own card below (codex P2 #5496 r5). With every
// field capped and the drop order above, the region fits the budget for any
// banner of up to about 85 words: after the drops the most that remains is
// headline 12 + yourPart 2 x 30 + next 30 + visit date ~9 + labels 24.
const FIELD_WORD_CAPS = { headline: 12, why: 40, progress: 35, applied: 60, yourPart: 30, next: 30 };

// The retired follow-up card's stock line. It is a placeholder, not a task.
const STOCK_NO_ACTION = /^no action is needed\b/i;
// Watering and moisture wording a lead field may not carry under a watering
// banner. Plans phrase the water story without the word "water" ("Recheck
// the moisture balance next visit."), so moisture, dryness, drought, damp and
// rain count too (codex P0 #5496 r1), and so does sprinkler "coverage".
// This wording test is the ONE rule for banner ownership. Lead fields are
// copied from insight cards through several snapshot aliases (statusHeadline,
// wavesNext, rootCause), so a rule keyed on which card a string came from
// leaks through each alias in turn (codex #5496 r2, r3); every water and
// coverage card string the customer sees carries one of these words.
const WATERING_WORDS = /water|irrigat|sprinkl|moist|\bdr(?:y|ier|ies|ied|ying|yness)\b|drought|damp|\brain|coverage/i;

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function bannerHasWateringLines(banner) {
  return !!banner && Array.isArray(banner.lines) && banner.lines.length > 0;
}

function topIssueOf(reportV2) {
  const insights = Array.isArray(reportV2?.insights) ? reportV2.insights : [];
  const ranked = insights
    .map((card, index) => ({ card, index }))
    .sort((a, b) => (Number(a.card?.priority) || a.index + 1) - (Number(b.card?.priority) || b.index + 1));
  const hit = ranked.find(({ card }) => card && (card.status === 'needs_attention' || card.status === 'watch'));
  return hit ? hit.card : null;
}

// The first non-blank candidate; under a banner, the first one with no
// watering wording.
function pick(candidates, bannerPresent) {
  for (const candidate of candidates) {
    const text = clean(candidate);
    if (text && !(bannerPresent && WATERING_WORDS.test(text))) return text;
  }
  return null;
}

function deriveYourPart(reportV2, topIssue, bannerPresent) {
  const snapshot = reportV2.snapshot;
  const candidates = [];
  if (!bannerPresent) {
    candidates.push(snapshot.customerAction);
  } else {
    const aftercareTask = aftercareCustomerTask(
      normalizeLawnAftercare(reportV2.aftercare),
      reportV2.water ? reportV2.water.weekPlan : null,
    );
    if (!issueRestatesAftercare(topIssue, aftercareTask)) candidates.push(topIssue?.customerAction);
  }
  const out = [];
  for (const candidate of candidates) {
    const text = pick([candidate], bannerPresent);
    if (text && !STOCK_NO_ACTION.test(text) && !out.includes(text)) out.push(text);
  }
  return out.slice(0, YOUR_PART_MAX);
}

// The client composes this with snapshot.nextVisit.label. A planned
// follow-up owns the line: when its reason is banner-owned watering wording
// the line is left empty rather than swapped for a different plan, so the
// lead never presents a second plan as the follow-up (and the top finding
// card keeps its own plan, see LawnInsightCards). Without a follow-up the
// top finding's plan is the only source (snapshot.wavesNext is that same plan
// copied at build time).
function deriveNext(reportV2, topIssue, bannerPresent) {
  const followUpReason = clean(reportV2.followUp && reportV2.followUp.reason);
  if (followUpReason) return pick([followUpReason], bannerPresent);
  return pick([topIssue && topIssue.nextVisitPlan], bannerPresent);
}

/**
 * @param {object} reportV2 a finished (reconciled) lawn reportV2 payload
 * @returns {{ headline: string|null, why: string|null, progress: string|null,
 *   applied: string|null, yourPart: string[], next: string|null } | null}
 *   null when there is no snapshot to lead with.
 */
function deriveLawnLead(reportV2) {
  const snapshot = reportV2 && reportV2.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const bannerPresent = bannerHasWateringLines(reportV2.banner);
  const topIssue = topIssueOf(reportV2);
  const lead = {
    headline: pick([snapshot.statusHeadline], bannerPresent),
    why: pick([snapshot.rootCause, snapshot.scoreExplanation], bannerPresent),
    // Slot only: a later PR writes snapshot.progress.
    progress: pick([snapshot.progress], bannerPresent),
    // What Waves applied is a statement of record, not watering advice: a
    // product summary that says "watered in" keeps its place in the lead.
    applied: clean(snapshot.treatmentSummary),
    yourPart: deriveYourPart(reportV2, topIssue, bannerPresent),
    next: deriveNext(reportV2, topIssue, bannerPresent),
  };
  for (const field of ['headline', 'why', 'progress', 'applied', 'next']) {
    if (countWords(lead[field]) > FIELD_WORD_CAPS[field]) lead[field] = null;
  }
  lead.yourPart = lead.yourPart.filter((task) => countWords(task) <= FIELD_WORD_CAPS.yourPart);
  for (const field of BUDGET_DROP_ORDER) {
    if (leadWords({ ...reportV2, lead }) <= LEAD_WORD_BUDGET) break;
    lead[field] = null;
  }
  return lead;
}

function countWords(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t ? t.split(/\s+/).length : 0;
}

// The date half of the client's "Next visit" line (LawnLeadCard's
// nextVisitSentence): the label, plus "Expected around" and the cadence
// phrase on an estimate.
function nextVisitDateWords(nextVisit) {
  if (!nextVisit || !nextVisit.label || nextVisit.label === 'Invalid Date') return 0;
  if (nextVisit.source !== 'estimated') return countWords(nextVisit.label);
  return countWords(`Expected around ${nextVisit.label}${nextVisit.cadenceWeeks ? ` (about every ${nextVisit.cadenceWeeks} weeks)` : ''}`);
}

/**
 * Visible-word total of the lead region: the banner lines (and mow hold line)
 * the page prints right above it, every lead field, the next-visit date the
 * client joins to lead.next, and a constant for the static labels. The
 * word-budget test holds this at 250 or less.
 */
function leadWords(reportV2) {
  const lead = (reportV2 && reportV2.lead) || null;
  const banner = (reportV2 && reportV2.banner) || null;
  const parts = [];
  if (banner && Array.isArray(banner.lines)) parts.push(...banner.lines);
  if (banner && banner.mowHold) parts.push(banner.mowHold.line);
  if (lead) {
    parts.push(lead.headline, lead.why, lead.progress, lead.applied, lead.next);
    if (Array.isArray(lead.yourPart)) parts.push(...lead.yourPart);
  }
  const dateWords = lead ? nextVisitDateWords(reportV2.snapshot && reportV2.snapshot.nextVisit) : 0;
  return parts.reduce((sum, part) => sum + countWords(part), 0) + dateWords + STATIC_LABEL_WORDS;
}

module.exports = { deriveLawnLead, leadWords, STATIC_LABEL_WORDS, WATERING_WORDS, LEAD_WORD_BUDGET, FIELD_WORD_CAPS };
