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

// The retired follow-up card's stock line. It is a placeholder, not a task.
const STOCK_NO_ACTION = /^no action is needed\b/i;
// Watering wording a lead field may not carry under a watering banner.
const WATERING_WORDS = /water|irrigat|sprinkler/i;

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

/**
 * @param {object} reportV2 a finished (reconciled) lawn reportV2 payload
 * @returns {{ headline: string|null, why: string|null, progress: string|null,
 *   applied: string|null, yourPart: string[], next: string|null } | null}
 *   null when there is no snapshot to lead with.
 */
function deriveLawnLead(reportV2) {
  const snapshot = reportV2 && reportV2.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const topIssue = topIssueOf(reportV2);
  const bannerPresent = bannerHasWateringLines(reportV2.banner);
  return {
    headline: pick([snapshot.statusHeadline], bannerPresent),
    why: pick([snapshot.rootCause, snapshot.scoreExplanation], bannerPresent),
    // Slot only: a later PR writes snapshot.progress.
    progress: pick([snapshot.progress], bannerPresent),
    applied: pick([snapshot.treatmentSummary], bannerPresent),
    yourPart: deriveYourPart(reportV2, topIssue, bannerPresent),
    // The client composes this with snapshot.nextVisit.label.
    next: pick([
      reportV2.followUp && reportV2.followUp.reason,
      topIssue && topIssue.nextVisitPlan,
      snapshot.wavesNext,
    ], bannerPresent),
  };
}

function countWords(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Visible-word total of the lead region: the banner lines (and mow hold line)
 * the page prints right above it, every lead field, and a constant for the
 * static labels. The word-budget test holds this at 250 or less.
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
  return parts.reduce((sum, part) => sum + countWords(part), 0) + STATIC_LABEL_WORDS;
}

module.exports = { deriveLawnLead, leadWords, STATIC_LABEL_WORDS };
