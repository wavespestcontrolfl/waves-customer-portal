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

/**
 * @param {object} input
 * @param {object} input.data      the assembled report payload (incl. dynamicContext, lawnAssessment, summary)
 * @param {object} input.reportV2  buildLawnReportV2(...) output (insights etc.)
 * @returns {{ todaysResult: string|null, reentry: object|null, followUp: object|null, warnings: object[] } | null}
 */
function reconcileLawnReport({ data = {}, reportV2 = null } = {}) {
  if (!reportV2) return null;
  const warnings = [];
  const insights = Array.isArray(reportV2.insights) ? reportV2.insights : [];
  const hasIssue = insights.some((i) => i.status === 'watch' || i.status === 'needs_attention');

  // ── Follow-up detection ───────────────────────────────────────────────────
  // Honest framing: "planned" — we surface it as a reassurance card with the reason
  // from the next-visit focus. (A concrete date only if the data carries one.)
  const la = data.lawnAssessment || {};
  const nextVisitFocus = la.recommendations && la.recommendations.nextVisitFocus;
  const summaryText = `${la.aiSummary || ''} ${la.customerSummary || ''} ${data.summary || ''}`;
  const mentionsFollowUp = !!nextVisitFocus
    || /\bfollow[- ]?up\b|\bnext visit\b|\bre-?check\b|\breturn (?:on|this|next|to)\b/i.test(summaryText);
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
    todaysResult = `Routine service completed. No urgent homeowner action is needed today${followUp ? ', and a follow-up is already planned' : ''}.`;
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
      reentry = { status: 'Ready now', petAdvisory: 'Treated turf has dried — pets and family are fine on it now.' };
      warnings.push({ severity: 'info', code: 'reentry_until_dry_resolved', message: '"Ready now" shown with an "until dry" precaution; treatment has since dried.', suggestedFix: reentry.petAdvisory });
    } else if (untilDry && !allReady) {
      reentry = { status: 'Ready once dry', petAdvisory: 'Keep pets and family off treated turf until it dries.' };
      warnings.push({ severity: 'warning', code: 'reentry_not_yet_dry', message: 'Re-entry not yet dry — status should read "Ready once dry".', suggestedFix: reentry.status });
    }
  }

  return { todaysResult, reentry, followUp, warnings };
}

module.exports = { reconcileLawnReport, firstSentence };
