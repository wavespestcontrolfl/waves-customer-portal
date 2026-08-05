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
    // chinch bug or drought…" (owner 2026-08-04). SEMICOLONS only: cutting
    // at a list comma fabricates a "complete" sentence that silently drops
    // trailing items (codex P2 r8) — comma-only over-length text keeps the
    // honest ellipsis fallback.
    const head = out.slice(0, max);
    const clauseEnd = head.lastIndexOf('; ');
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
// target/goal figure is identified by its naming words and never rewritten).
function reconcileRainFigure(text, canonicalRain) {
  const t = String(text || '');
  if (!t || canonicalRain == null) return null;
  let changed = false;
  const out = t.split(/(?<=[.!?])\s+/).map((sentence) => {
    // Same rain/window vocabulary the narrative layer produces — a stale
    // total phrased as "Precipitation over the last seven days was 2.72
    // inches" must qualify too (codex P2 r6).
    if (!/\brain(?:fall)?\b|\bprecipitation\b/i.test(sentence)) return sentence;
    if (!/\bweek\b|\b7[- ]days?\b|\b(?:past|last) seven\b|\bseven days\b|\btotal(?:ing|ed|s)?\b/i.test(sentence)) return sentence;
    // A COMBINED rain+irrigation/total-water figure is not the rain total —
    // rewriting "Rain and irrigation totaled 1.95 inches" to rain-only would
    // contradict the widget's Total row (codex P2 r5).
    // Qualifiers may sit between the connector and irrigation ("plus your
    // irrigation", "and the weekly irrigation" — codex P2 r13).
    if (/\b(?:rain(?:fall)?|precipitation)\s*(?:,|and|&|\+|plus)\s*(?:your\s+|the\s+|weekly\s+|any\s+)*irrigation\b|\birrigation\s*(?:,|and|&|\+|plus)\s*(?:your\s+|the\s+|weekly\s+|any\s+)*(?:rain(?:fall)?|precipitation)\b|\bcombined water\b|\btotal water\b/i.test(sentence)) return sentence;
    // No sentence-level target bailout (codex P2 #3197 r1): "totaling 2.72
    // inches was above the 0.75 inch target" is the exact comparison this
    // pass reconciles. Per-number word guards do the work; only the FIRST
    // qualifying figure is rewritten, and a skipped figure does not consume
    // the attempt.
    let done = false;
    // `inch(?:es)?` — a singular "1 inch" total must match too (codex P2 r2).
    // Bare `in` (no period) is a common abbreviation too (codex P2 r4); the
    // lookahead keeps prose like "2 in the morning" from reading as a unit.
    // The gap accepts a hyphen so adjectival totals ("The 2.72-inch rainfall
    // total") reconcile too (codex P2 r14).
    return sentence.replace(/\b(\d+(?:\.\d+)?)([\s-]*)(inch(?:es)?|in\.|in\b(?!\s+(?:the|a|an)\b)|")/gi, (match, value, gap, unit, offset) => {
      if (done) return match;
      const v = Number(value);
      if (!Number.isFinite(v)) return match;
      // A figure inside a target/goal phrase ("below the 0.75 inches target",
      // "target of 0.75 inch", "recommended 1 inch") is never a rain total —
      // skip it WITHOUT consuming the attempt. This word-level guard replaces
      // the old below-half-canonical value guard, which also skipped
      // genuinely stale LOW totals (0.2" stale vs 0.8" canonical — codex P2
      // r3): a target is identified by how it's named, not by being small.
      // Before-guard: the target word must DIRECTLY precede this number with
      // no digits AND no clause punctuation between — "target of 0.75" is a
      // target, but in "above the target, totaling 2.72 inches" the target
      // word belongs to an earlier clause and the figure IS the weekly total
      // (codex P2 r9). "0.75 inch target, rain totaled 2.72" also lets 2.72
      // qualify.
      const before = sentence.slice(Math.max(0, offset - 24), offset);
      const after = sentence.slice(offset + match.length, offset + match.length + 24);
      const TARGET_WORD = '(?:target|goal|aim(?:ing)?|recommend(?:ed|s)?|ideal)';
      // After-guard tolerates a rate qualifier between the figure and the
      // target word — "0.75 inches per week target" is still the target
      // (codex P2 r4) — and treats a DELTA figure the same way: "2.2 inches
      // above the weekly target" measures distance from the target, not the
      // rain total (codex P2 r5). Both skip without consuming the attempt.
      if (new RegExp(`\\b${TARGET_WORD}\\b[^.\\d,;:]{0,12}$`, 'i').test(before)
        || new RegExp(`^\\s*(?:(?:over|above|below|under|past|beyond|short\\s+of)\\s+)?(?:the\\s+)?(?:(?:per|a|each)\\s+week\\s+|weekly\\s+|/\\s*wk\\s+)?${TARGET_WORD}\\b`, 'i').test(after)) return match;
      // The sentence already quotes the canonical figure → it agrees with the
      // widget; stop scanning so a later, different number (e.g. the target)
      // is never mistaken for a stale total.
      if (Math.abs(v - canonicalRain) <= 0.05) { done = true; return match; }
      done = true;
      changed = true;
      // Keep the unit grammatical when the value changes across the
      // singular/plural boundary ("1 inch" → "1.52 inches" — codex P3 r12).
      // Hyphenated adjectival compounds stay singular ("2.96-inch total").
      const newVal = formatInches(canonicalRain);
      let newUnit = unit;
      if (!gap.includes('-')) {
        if (/^inch$/i.test(unit) && Number(newVal) !== 1) newUnit = `${unit}es`;
        else if (/^inches$/i.test(unit) && Number(newVal) === 1) newUnit = unit.slice(0, -2);
      }
      return `${newVal}${gap}${newUnit}`;
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
// The tolerance lookahead covers the bare AND the "stress" form: without
// `(?:\s+stress)?`, "drought stress tolerance" backtracked to match bare
// "drought" and produced "uneven sprinkler coverage stress tolerance"
// (codex P2 r2). "dry patch(es)" is in the set too (codex P2 r5), but only
// rewrites in a hypothesis-marked sentence — see the cue check below — since
// "dry patches" can also be a literal field observation.
// "drought-related" is its own leading alternative (the (?!-) hyphen guard
// would otherwise exclude it) and rewrites to "sprinkler-coverage-related";
// dry spot(s)/area(s) join patch(es) under the hypothesis-cue gate
// (codex P2 r7).
// The tolerance lookahead accepts a hyphen or space before "toleran…" so
// "drought stress-tolerant" is excluded like "drought stress tolerance"
// (codex P2 r13).
// …and the praise exclusion covers resistance/resilience wording alongside
// tolerance ("drought resistant", "drought resilience" — codex P2 r14).
const DROUGHT_HYPOTHESIS_RE = /\b(?:localized\s+|an?\s+)?(?:drought[- ]related|drought[- ]stress(?:ed)?|drought|dry\s+(?:pockets?|spells?|patch(?:es)?|spots?|areas?))\b(?!-)(?!(?:\s+stress)?[\s-]+(?:toleran|resist|resilien))/gi;
const HYPOTHESIS_CUE_RE = /\bor\b|\bcould\b|\bmay\b|\bmight\b|\bpossibly\b|\bconsistent with\b|\bsuggests?\b|\bline up with\b/i;

function replaceDroughtHypothesis(text) {
  const t = String(text || '');
  if (!t) return null;
  let changed = false;
  const out = t.split(/(?<=[.!?])\s+/).map((sentence) => {
    // A sentence qualifies via the stress-signal cues OR because it IS the
    // hypothesis in its terse headline form ("Dry pocket near the sidewalk",
    // "Localized drought near the edge" — codex P2 r4). A bare "drought"
    // with no stress context still needs the cue ("A drought was declared
    // in the county" stays untouched).
    // "damage" joins the stress cues — the dashboard's own category is
    // "Stress / Damage Signals" and summaries phrase the hypothesis with it
    // ("Damage could be drought-related" — codex P2 r15).
    if (!/chinch|stress|thin|tan\b|patch|scuff|damage/i.test(sentence)
      && !/\bdry\s+pockets?\b|\blocalized\s+drought\b/i.test(sentence)) return sentence;
    // Headline-position matches keep their capitalization ("Dry pocket near
    // the sidewalk" → "Uneven sprinkler coverage near the sidewalk").
    // dry patch/spot/area forms only rewrite under a hypothesis cue — "a few
    // dry patches were noted" is an OBSERVATION and must survive verbatim.
    // The cue must PRECEDE the match nearby ("could be … or dry spots") — a
    // cue word later in the sentence ("…, and color is improving or stable")
    // must not convert an observed dry area into a hypothesis (codex P2 r8),
    // and the backward search stops at clause punctuation so a cue in an
    // EARLIER clause ("improving or stable; dry spots were noted") doesn't
    // leak across the boundary (codex P2 r9).
    const cueBefore = (offset) => {
      const seg = sentence.slice(Math.max(0, offset - 48), offset);
      const clause = seg.slice(Math.max(seg.lastIndexOf(';'), seg.lastIndexOf(':'), seg.lastIndexOf('.')) + 1);
      return HYPOTHESIS_CUE_RE.test(clause);
    };
    const replaced = sentence.replace(DROUGHT_HYPOTHESIS_RE, (m, offset) => {
      // Negation is checked PER MATCH, not per sentence: it must attach to
      // this occurrence (negator + up to three plain same-clause words right
      // before it; punctuation breaks the chain), so "No current signs of
      // dry pockets, but drought stress remains possible" preserves the
      // negated phrase AND still reconciles the later hypothesis
      // (codex P2 r3/r4/r7).
      if (/\b(?:no|not|isn['’]t|without)\s+(?:[a-z'’-]+\s+){0,3}$/i.test(sentence.slice(0, offset))) return m;
      if (/dry\s+(?:patch|spots?|areas?)/i.test(m) && !cueBefore(offset)) return m;
      // dry pocket/spell: a hypothesis under a cue OR a terse headline
      // ("Dry pocket near the sidewalk") — but never an OBSERVATION sentence
      // ("Dry pockets were noted in thin turf", codex P2 r10): observation
      // verbs veto the headline path.
      if (/dry\s+(?:pockets?|spells?)/i.test(m) && !cueBefore(offset)) {
        const sentenceStart = /^\W*$/.test(sentence.slice(0, offset));
        const observed = /\b(?:noted|observed|seen|found|documented|recorded|visible|showing)\b/i.test(sentence);
        if (!sentenceStart || observed) return m;
      }
      // A negation can also FOLLOW the phrase ("Drought stress was not
      // observed", "isn't visible") — check the same clause after the match
      // before replacing (codex P2 r12); clause punctuation ends the search.
      // Dismissal terms count as negation too — "Drought stress is unlikely"
      // / "was ruled out" already agrees with the water data and must not be
      // flipped into a coverage claim (codex P2 r14).
      const tail = sentence.slice(offset + m.length);
      if (/^[^.;,:]{0,30}\b(?:not|no|isn['’]t|wasn['’]t|aren['’]t|weren['’]t|never|unlikely|less\s+likely|ruled\s+out|doubtful|improbable)\b/i.test(tail)) return m;
      // Adjectival forms — hyphenated or space-form "drought stressed"
      // (codex P2 r9/r12), or "drought stress" directly modifying
      // symptoms/signs/related (codex P2 r10) — take the adjectival
      // replacement so the sentence stays grammatical.
      if (/drought[- ]related\b/i.test(m)
        || /drought[- ]stressed\b/i.test(m)
        || /drought-stress\b/i.test(m)
        || (/drought[- ]stress$/i.test(m) && /^\s*(?:symptoms?|signs?|related)\b/i.test(tail))) {
        return /^[A-Z]/.test(m) ? 'Sprinkler-coverage-related' : 'sprinkler-coverage-related';
      }
      return /^[A-Z]/.test(m) ? 'Uneven sprinkler coverage' : 'uneven sprinkler coverage';
    });
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
  let snapshot = null;
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
    // The hero snapshot COPIES insight strings at build time (watching =
    // headlines, mainWatch = top whatWeSaw, wavesNext / customerAction from
    // the top issue) — patching only the insights left the hero telling the
    // customer to recheck drought stress (codex P2 r3).
    const snap = reportV2.snapshot;
    if (snap) {
      const fields = {};
      let touched = false;
      for (const f of ['statusHeadline', 'scoreExplanation', 'rootCause', 'mainWatch', 'wavesNext', 'customerAction']) {
        const replaced = replaceDroughtHypothesis(snap[f]);
        if (replaced) { fields[f] = replaced; touched = true; }
      }
      if (Array.isArray(snap.watching)) {
        const watching = snap.watching.map((w) => replaceDroughtHypothesis(w) || w);
        if (watching.some((w, idx) => w !== snap.watching[idx])) { fields.watching = watching; touched = true; }
      }
      if (touched) { snapshot = { ...snap, ...fields }; droughtWarn('The hero snapshot'); }
    }
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
    snapshot,
    insights: insights === rawInsights ? null : insights,
  };
}

/**
 * Apply reconcileLawnReport's fixes onto an assembled report payload in
 * place. Shared by the public route AND the queued PDF renderer — the queue
 * builds its payload directly and renders under the deterministic storage
 * key, so a queue render without this pass would bake the pre-reconciliation
 * copy into the cache and the direct route would then serve it as current
 * (codex P2 #3197 r6). Best-effort: any throw leaves the payload untouched.
 */
function applyLawnReportReconciliation(data, dynamicContext = null) {
  if (!data || !data.reportV2) return data;
  try {
    const fix = reconcileLawnReport({
      data: { ...data, dynamicContext },
      reportV2: data.reportV2,
      serviceLine: data.serviceLine,
    });
    if (!fix) return data;
    data.reportV2 = {
      ...data.reportV2,
      todaysResult: fix.todaysResult || data.reportV2.todaysResult || null,
      followUp: fix.followUp || data.reportV2.followUp || null,
      // Rain-contradicted drought hypotheses reworded in place (null = untouched).
      insights: fix.insights || data.reportV2.insights,
      photoSummary: fix.photoSummary || data.reportV2.photoSummary,
      snapshot: fix.snapshot || data.reportV2.snapshot,
      consistencyWarnings: fix.warnings || [],
    };
    // Stale weekly-rain figure in the AI summary rewritten to the widget's
    // total so the report never quotes two different rain numbers.
    if (fix.summary) data.summary = fix.summary;
    if (fix.reentry && dynamicContext && dynamicContext.reentry) {
      dynamicContext.reentry = { ...dynamicContext.reentry, petAdvisory: fix.reentry.petAdvisory };
    }
  } catch { /* reconciliation is best-effort — never block the report */ }
  return data;
}

module.exports = {
  reconcileLawnReport,
  applyLawnReportReconciliation,
  firstSentence,
  reconcileRainFigure,
  replaceDroughtHypothesis,
};
