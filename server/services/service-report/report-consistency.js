/**
 * Lawn Report V2 — consistency / reconciliation layer.
 *
 * Both report reviews converged on the same fix: the sections must AGREE before the
 * report renders. The deterministic builders already resolve the water amount-vs-
 * coverage contradiction and the customer-vs-Waves action ownership inside
 * lawn-report-v2. This module reconciles the remaining cross-section contradictions
 * that span the V2 dashboard AND the legacy operational cards:
 *
 *   - "Today's result: no high-priority issues" while watch items / a follow-up exist
 *   - Re-entry "Ready now" shown alongside "keep pets off until dry"
 *   - A scheduled/planned follow-up buried in prose instead of surfaced as a card
 *
 * It returns reconciled values + a warnings array (info | warning | blocker). The
 * caller attaches the reconciled values onto reportV2 and the renderer prefers them.
 * Pure + best-effort: returns null when there's nothing to reconcile.
 */

// Customer-facing lead extraction for the today's-result hero. Unlike
// firstSentence (whose callers want a short excerpt and tolerate a "…"),
// the hero must be a COMPLETE sentence: the boundary logic skips periods
// that belong to abbreviations ("The St. Augustine lawn…" shipped the
// hero "The St." — codex P1 #3187 r4) and decimals ("2.77 in"), and
// anything over the cap returns '' (caller falls back to the neutral
// lead) rather than truncating.
// Initialisms are recognized by their DOTTED sequence — a period, letter,
// period tail ("U.S." ends ".S.", "e.g." ends ".g.") — never by a blanket
// single-letter rule: "We applied Heritage G." is a real catalog product
// ending a real sentence, and suppressing that boundary merged the next
// sentence into the hero (codex P2 #3187 r5 → r20).
const LEAD_ABBREVIATIONS = /(?:\b(?:St|Mr|Mrs|Ms|Dr|Sr|Jr|vs|etc|approx|Ave|Blvd|Rd|Ft|Mt|No)|\.[A-Za-z])\.$/i;

function leadSentence(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // A boundary is a terminator followed by whitespace and a capital/digit
  // start — a decimal's period has no following whitespace, so it never
  // matches; an abbreviation's period is skipped by the suffix test.
  const boundary = /[.!?](?=\s+["'(]?[A-Z0-9])/g;
  let match;
  while ((match = boundary.exec(t))) {
    const candidate = t.slice(0, match.index + 1);
    if (LEAD_ABBREVIATIONS.test(candidate)) continue;
    return candidate.length <= max ? candidate : '';
  }
  return /[.!?]$/.test(t) && t.length <= max ? t : '';
}

function firstSentence(text, max = 170) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^[^.!?]*[.!?]/);
  let out = (m ? m[0] : t).trim();
  if (out.length > max) {
    out = out.slice(0, max);
    const lastSpace = out.lastIndexOf(' ');
    if (lastSpace > 40) out = out.slice(0, lastSpace);
    out = `${out.replace(/[,;:]\s*$/, '').trim()}…`;
  }
  return out;
}

// Re-entry advisory rewrites name the treated surface, so they are
// per-service-line: the lawn wording ("treated turf") landing on a tree &
// shrub report told the customer the wrong surface was treated (T&S audit
// 2026-07-18 P1). Unknown lines get no rewrite rather than a wrong noun.
const REENTRY_REWRITES = {
  lawn: {
    dried: 'Treated turf has dried — pets and family are fine on it now.',
    untilDry: 'Keep pets and family off treated turf until it dries.',
  },
  tree_shrub: {
    dried: 'Treated beds and foliage have dried — pets and family are fine around them now.',
    untilDry: 'Keep pets and family off treated beds and foliage until they dry.',
  },
};

/**
 * @param {object} input
 * @param {object} input.data      the assembled report payload (incl. dynamicContext, lawnAssessment, summary)
 * @param {object} input.reportV2  the V2 payload (buildLawnReportV2 / buildTreeShrubReportV2 output)
 * @param {string} [input.serviceLine='lawn']  report service line; drives which
 *   reconciliations run. Lawn gets the full pass. Tree & shrub gets ONLY the
 *   re-entry rewrite (with its own surface wording): its todaysResult comes
 *   from the typed snapshot / insight builders, and its section never renders
 *   a followUp card, so a prose-derived "follow-up already planned" claim
 *   would surface with no supporting card (T&S audit 2026-07-18). Any other
 *   line is a no-op.
 * @returns {{ todaysResult: string|null, reentry: object|null, followUp: object|null, warnings: object[] } | null}
 */
function reconcileLawnReport({ data = {}, reportV2 = null, serviceLine = 'lawn' } = {}) {
  if (!reportV2) return null;
  const reentryWording = REENTRY_REWRITES[serviceLine] || null;
  if (!reentryWording) return null;
  const lawnPass = serviceLine === 'lawn';
  const warnings = [];
  const insights = Array.isArray(reportV2.insights) ? reportV2.insights : [];
  const hasIssue = lawnPass && insights.some((i) => i.status === 'watch' || i.status === 'needs_attention');

  // ── Follow-up detection (lawn only — see serviceLine doc above) ──────────
  // Honest framing: "planned" — we surface it as a reassurance card with the reason
  // from the next-visit focus. (A concrete date only if the data carries one.)
  const la = data.lawnAssessment || {};
  const nextVisitFocus = la.recommendations && la.recommendations.nextVisitFocus;
  const summaryText = `${la.aiSummary || ''} ${la.customerSummary || ''} ${data.summary || ''}`;
  // Don't manufacture a "follow-up planned" card from loose summary text when the
  // copy explicitly says none is needed — a real nextVisitFocus still counts.
  const deniesFollowUp = /\bno\b[^.]{0,40}\b(?:follow[- ]?up|re-?check|return|next visit)\b|\b(?:follow[- ]?up|re-?check)\b[^.]{0,20}\bnot needed\b|\bno (?:further|additional) (?:visit|action)\b/i.test(summaryText);
  // Prose only counts with an explicit follow-up COMMITMENT ("a follow-up is
  // planned", "we'll re-check", "we will return/come back"). Routine sign-offs
  // ("see you at your next visit") and advice ("return to normal watering")
  // used to fabricate a "Follow-up already planned" card telling the customer
  // an unbooked visit was scheduled (audit 2026-07-16).
  const mentionsFollowUp = lawnPass && (!!nextVisitFocus
    || (!deniesFollowUp && /\bfollow[- ]?up\b|\bre-?check\b|\breturn visit\b|\b(?:will|we['’]ll) (?:return|come back|be back)\b/i.test(summaryText)));
  let followUp = null;
  if (mentionsFollowUp) {
    followUp = {
      scheduled: true,
      headline: 'Follow-up already planned',
      reason: firstSentence(nextVisitFocus) || 'We’ll recheck the areas we flagged and compare them against today’s photos.',
      customerAction: 'No action is needed from you before then unless the area changes quickly.',
    };
  }

  // ── Today's result reconciliation ─────────────────────────────────────────
  let todaysResult = null;
  if (hasIssue || followUp) {
    // Lead with THIS visit's story, not one fixed sentence for every
    // customer (owner feedback 2026-08-03). The summary's first sentence is
    // already vetted customer copy — it renders verbatim in Visit Summary —
    // so it can't introduce a new claim. Only a COMPLETE sentence qualifies
    // (leadSentence returns '' for fragments and over-cap text); anything
    // else keeps the neutral lead. The greeting strip mirrors the client's
    // cleanVisitSummary so the hero never opens with a thank-you line.
    const summaryLead = leadSentence(
      String(data.summary || '').replace(/^Thanks for having us out today\.\s*/i, '').trim()
    );
    const lead = summaryLead || 'Routine service completed.';
    // No follow-up clause here (owner directive 2026-08-03): the follow-up
    // card below carries that promise; the hero states only today's outcome.
    todaysResult = `${lead} No urgent homeowner action is needed today.`;
    warnings.push({
      severity: 'warning',
      code: 'todays_result_overclaims_clear',
      message: 'Legacy "no high-priority issues were noted" contradicts the watch items / follow-up on this report.',
      suggestedFix: todaysResult,
    });
  }

  // ── Re-entry reconciliation ───────────────────────────────────────────────
  // "Ready now" must not sit next to "keep pets off until dry". If the readiness
  // window has passed (treatment dried), reword the precaution to past tense; if it
  // hasn't, the status should read "Ready once dry".
  let reentry = null;
  const re = data.dynamicContext && data.dynamicContext.reentry;
  if (re && Array.isArray(re.targets) && re.targets.length) {
    const allReady = re.targets.every((t) => t.statusAtGeneratedAt === 'ready');
    const untilDry = /until\s+dry/i.test(re.petAdvisory || '');
    if (untilDry && allReady) {
      reentry = { status: 'Ready now', petAdvisory: reentryWording.dried };
      warnings.push({ severity: 'info', code: 'reentry_until_dry_resolved', message: '"Ready now" shown with an "until dry" precaution; treatment has since dried.', suggestedFix: reentry.petAdvisory });
    } else if (untilDry && !allReady) {
      reentry = { status: 'Ready once dry', petAdvisory: reentryWording.untilDry };
      warnings.push({ severity: 'warning', code: 'reentry_not_yet_dry', message: 'Re-entry not yet dry — status should read "Ready once dry".', suggestedFix: reentry.status });
    }
  }

  return { todaysResult, reentry, followUp, warnings };
}

module.exports = { reconcileLawnReport, firstSentence };
