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
    // Over-cap: prefer ending on a complete CLAUSE (the tech's long
    // next-visit focus lines are single sentences joined by semicolons), so
    // the card never trails off mid-thought with "…inspect edge areas for
    // chinch bug or drought…" (owner 2026-08-04). Word-boundary + ellipsis
    // survives only as the no-clause-boundary fallback.
    const head = out.slice(0, max);
    const clauseEnd = Math.max(head.lastIndexOf('; '), head.lastIndexOf(', '));
    if (clauseEnd > 40) {
      out = `${head.slice(0, clauseEnd).trim()}.`;
    } else {
      out = head;
      const lastSpace = out.lastIndexOf(' ');
      if (lastSpace > 40) out = out.slice(0, lastSpace);
      out = `${out.replace(/[,;:]\s*$/, '').trim()}…`;
    }
  }
  return out;
}

// Re-entry advisory rewrites name the treated surface, so they are
// per-service-line: the lawn wording ("treated turf") landing on a tree &
// shrub report told the customer the wrong surface was treated (T&S audit
// 2026-07-18 P1). Unknown lines get no rewrite rather than a wrong noun.
const REENTRY_REWRITES = {
  lawn: {
    // Label-consistent framing (dried → may re-enter) without a safety
    // adjective: "are fine" read as a safety assurance the label language
    // never makes (owner compliance pass 2026-08-04).
    dried: 'Treated turf has dried, so pets and family can use the lawn again.',
    untilDry: 'Keep pets and family off treated turf until it dries.',
  },
  tree_shrub: {
    dried: 'Treated beds and foliage have dried, so pets and family can be around them again.',
    untilDry: 'Keep pets and family off treated beds and foliage until they dry.',
  },
};

const toNum = (v) => {
  // null-check BEFORE Number(): Number(null) and Number('') are a finite 0,
  // which would invent a 0" rain reading / 0" target on rain-unknown reports
  // (codex P1 #3197 r1 — the same trap the client baseline guard documents).
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const formatInches = (n) => String(Math.round(n * 100) / 100);

// The AI visit summary bakes a rainfall total in at completion time, while the
// Water This Week widget recomputes at request time — the same report was
// telling the customer "2.72 inches" and "2.96 in" at once (owner 2026-08-04).
// Sentence-scoped: only a weekly-total rain sentence is touched, only its first
// inch figure, and only when it's in the canonical figure's neighborhood (a
// target mention like "0.75 inch" is below half the canonical and never
// rewritten; a sentence naming the target is skipped entirely).
function reconcileRainFigure(text, canonicalRain) {
  const t = String(text || '');
  if (!t || canonicalRain == null) return null;
  let changed = false;
  const out = t.split(/(?<=[.!?])\s+/).map((sentence) => {
    if (!/\brain(?:fall)?\b/i.test(sentence)) return sentence;
    if (!/\bweek\b|\b7[- ]day\b|\bpast seven\b|\btotal(?:ing|ed|s)?\b/i.test(sentence)) return sentence;
    // No sentence-level target bailout (codex P2 #3197 r1): "totaling 2.72
    // inches was above the 0.75 inch target" is the exact comparison this
    // pass reconciles. The per-number guards do the work instead — a figure
    // below half the canonical (the target mention) is skipped, and only the
    // FIRST qualifying figure is rewritten; a skipped figure does not consume
    // the attempt.
    let replacedOne = false;
    return sentence.replace(/\b(\d+(?:\.\d+)?)(\s*)(inches?|in\.|")/gi, (match, value, gap, unit) => {
      if (replacedOne) return match;
      const v = Number(value);
      if (!Number.isFinite(v) || Math.abs(v - canonicalRain) <= 0.05 || v < canonicalRain * 0.5) return match;
      replacedOne = true;
      changed = true;
      return `${formatInches(canonicalRain)}${gap}${unit}`;
    });
  }).join(' ');
  return changed ? out : null;
}

// A drought / dry-pocket hypothesis sitting on a report whose own widget shows
// rain far above target contradicts the data on the page (owner 2026-08-04:
// "we know from rainfall that this would not necessarily be the case"). When
// weekly rain is at least an inch over target, the hypothesis is reworded to
// the water-adequate differential the coverage copy already uses. Hypothesis
// sentences only: the sentence must be about the stress signals, negated
// mentions are left alone, and "drought-tolerant"/"drought tolerance" praise
// never matches.
const DROUGHT_HYPOTHESIS_RE = /\b(?:localized\s+|a\s+)?(?:drought(?:\s+stress)?|dry\s+pockets?|dry\s+spells?)\b(?!-)(?!\s+toleran)/gi;

function replaceDroughtHypothesis(text) {
  const t = String(text || '');
  if (!t) return null;
  let changed = false;
  const out = t.split(/(?<=[.!?])\s+/).map((sentence) => {
    if (!/chinch|stress|thin|tan\b|patch|scuff/i.test(sentence)) return sentence;
    if (/\bno\b[^.]{0,30}\b(?:drought|dry)\b/i.test(sentence)) return sentence;
    const replaced = sentence.replace(DROUGHT_HYPOTHESIS_RE, 'uneven sprinkler coverage');
    if (replaced !== sentence) changed = true;
    return replaced;
  }).join(' ');
  return changed ? out : null;
}

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
  const rawInsights = Array.isArray(reportV2.insights) ? reportV2.insights : [];
  const hasIssue = lawnPass && rawInsights.some((i) => i.status === 'watch' || i.status === 'needs_attention');

  // ── Rain-figure reconciliation (lawn only) ────────────────────────────────
  // Keep the AI summary's weekly rain total in agreement with the live widget.
  const canonicalRain = lawnPass ? toNum(reportV2.water && reportV2.water.rainInches) : null;
  let summary = null;
  if (canonicalRain != null) {
    summary = reconcileRainFigure(data.summary, canonicalRain);
    if (summary) {
      warnings.push({
        severity: 'warning',
        code: 'summary_rain_figure_stale',
        message: `Visit summary's weekly rain total disagrees with the Water This Week widget (${formatInches(canonicalRain)}").`,
        suggestedFix: summary,
      });
    }
  }
  const liveSummary = summary || data.summary;

  // ── Drought-hypothesis reconciliation (lawn only) ─────────────────────────
  // Rain an inch or more OVER target → a drought / dry-pocket differential
  // contradicts the page's own water data; reword to the coverage differential.
  const rainTarget = lawnPass ? toNum(reportV2.water && reportV2.water.targetInches) : null;
  const rainWellAboveTarget = canonicalRain != null && rainTarget != null && canonicalRain >= rainTarget + 1;
  let insights = rawInsights;
  let photoSummary = null;
  const droughtWarn = (where) => warnings.push({
    severity: 'warning',
    code: 'drought_hypothesis_contradicts_rainfall',
    message: `${where} attributed stress to drought/dry conditions while measured weekly rain (${formatInches(canonicalRain)}") is well above the ${formatInches(rainTarget)}" target.`,
  });
  if (rainWellAboveTarget) {
    const summaryDrought = replaceDroughtHypothesis(liveSummary);
    if (summaryDrought) { summary = summaryDrought; droughtWarn('Visit summary'); }
    const patched = insights.map((i) => {
      const fields = {};
      let touched = false;
      // The full set of insight fields the card renders (LawnReportV2.jsx
      // InsightLine rows + the headline) — nextVisitPlan is the rendered
      // "Next visit" row (codex P2 #3197 r1: a bare `nextVisit` left the
      // visible line saying drought while the rest was reconciled).
      for (const f of ['headline', 'whatWeSaw', 'whyItMatters', 'wavesAction', 'customerAction', 'nextVisitPlan']) {
        const replaced = replaceDroughtHypothesis(i && i[f]);
        if (replaced) { fields[f] = replaced; touched = true; }
      }
      return touched ? { ...i, ...fields } : i;
    });
    if (patched.some((p, idx) => p !== insights[idx])) { insights = patched; droughtWarn('A priority finding'); }
    photoSummary = replaceDroughtHypothesis(reportV2.photoSummary);
    if (photoSummary) droughtWarn('The photo narrative');
  }

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
    // The reason rides through the same drought reconciliation as the cards —
    // "inspect edge areas for drought stress" must not survive on a
    // rain-above-target report when every other surface was corrected.
    const focus = (rainWellAboveTarget && replaceDroughtHypothesis(nextVisitFocus)) || nextVisitFocus;
    followUp = {
      scheduled: true,
      headline: 'Follow-up already planned',
      reason: firstSentence(focus) || 'We’ll recheck the areas we flagged and compare them against today’s photos.',
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
      String(summary || data.summary || '').replace(/^Thanks for having us out today\.\s*/i, '').trim()
    );
    // No follow-up clause here (owner directive 2026-08-03): the follow-up
    // card below carries that promise; the hero states only today's outcome.
    // No appended "No urgent homeowner action is needed today." either (owner
    // 2026-08-04): it rendered on EVERY reconciled report — redundant next to
    // the follow-up card's "no action" line and contradictory when the
    // snapshot carries a real "Your next step".
    todaysResult = summaryLead || 'Routine service completed.';
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

  return {
    todaysResult,
    reentry,
    followUp,
    warnings,
    // Non-null ONLY when a reconciliation changed the text — the route applies
    // these over the payload; null means "keep what the payload already has".
    summary,
    photoSummary,
    insights: insights === rawInsights ? null : insights,
  };
}

module.exports = { reconcileLawnReport, firstSentence, reconcileRainFigure, replaceDroughtHypothesis };
