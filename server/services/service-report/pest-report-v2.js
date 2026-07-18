/**
 * Pest Report V2 aggregator — the customer-facing "protection-first" pest report.
 *
 * Unlike the lawn report (a health SCORE built from photos), the pest report's job
 * is to make the (mostly invisible) protection work visible and to reassure — or
 * escalate. So the hero leads with a STATUS (Protected / We're watching / Action
 * needed), derived from the already-built premium-experience "property defense
 * status", with the numeric pest-pressure / activity reading kept as SUPPORTING
 * evidence rather than the headline.
 *
 * This is a thin, PURE arranger over intelligence that already exists and is
 * already wired into dynamicContext.premiumExperience (see premium-experience.js):
 *   propertyDefenseStatus · primaryMove · bugFiles · pressureReceipt ·
 *   weatherCall · aiSummaryPersonality.
 * Phase 1 surfaces that work (it was built but never rendered) and adds a seasonal
 * "what to expect" forecast (pest-forecast/, resolved + fetched by the caller and
 * passed in here so this module stays pure / node-testable).
 *
 * Honest-copy + no-jargon rules: internal A/B/C/D zone LETTERS are stripped from
 * every customer string (the same decision we applied to the lawn report — letters
 * mean nothing to a homeowner), and any synthesized line is run through the shared
 * banned-copy guard.
 */

const { validateCustomerCopy } = require('./premium-experience');
const { detectServiceLine } = require('./service-line-configs');

// propertyDefenseStatus.overallLabel → the customer-facing protection status.
// tone drives the client accent (good = green, watch = amber, attention = red).
const STATUS_BY_DEFENSE_LABEL = {
  strong: { key: 'protected', label: 'Protected', tone: 'good' },
  watch: { key: 'watching', label: 'We’re watching', tone: 'watch' },
  needs_attention: { key: 'recommended', label: 'One step recommended', tone: 'watch' },
  action_required: { key: 'action', label: 'Action needed', tone: 'attention' },
};
const DEFAULT_STATUS = { key: 'watching', label: 'We’re watching', tone: 'watch' };

const LEVEL_RANK = { high: 3, elevated: 2, moderate: 1, low: 0 };

function text(value) {
  // premium-experience wraps customer strings as sourceBacked → { text, sourceKeys }.
  // Accept either the wrapped object or a bare string.
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value.text === 'string') return value.text.trim();
  return '';
}

// Strip a leading internal zone letter ("A · Front yard" → "Front yard"). The
// letter prefix comes from premium-experience bug files (`${zone.letter} · …`);
// homeowners never saw the lettered map, so the letter is noise here too.
function stripZoneLetter(value) {
  return String(value || '').replace(/^[A-Za-z]\s*·\s*/, '').trim();
}

function safeSummary(value, fallback) {
  const copy = text(value);
  if (copy && validateCustomerCopy(copy)) return copy;
  return fallback;
}

function buildDefense(defenseStatus) {
  if (!defenseStatus?.items?.length) return null;
  const items = defenseStatus.items.map((item) => ({
    key: item.key,
    label: item.label,
    status: item.status, // active | watched | clear
    detail: stripZoneLetter(text(item.detail) || item.detail || ''),
  }));
  return { summary: defenseStatus.summary, items };
}

function buildPrimaryMove(primaryMove) {
  if (!primaryMove?.title) return null;
  return {
    title: text(primaryMove.title) || primaryMove.title,
    why: text(primaryMove.why) || primaryMove.why || '',
    impact: text(primaryMove.impact) || primaryMove.impact || '',
    dueLabel: primaryMove.dueLabel || 'Before next service',
  };
}

function buildBugFiles(bugFiles) {
  if (!Array.isArray(bugFiles) || !bugFiles.length) return [];
  return bugFiles.map((bug) => ({
    pestKey: bug.pestKey,
    suspectLabel: bug.suspectLabel || bug.likelyId?.label || 'Pest',
    confirmedByTech: Boolean(bug.likelyId?.confirmedByTech),
    whereSeen: stripZoneLetter(text(bug.whereSeen)),
    whyItMatters: text(bug.whyItMatters),
    whatWeDid: text(bug.whatWeDid),
    yourMove: text(bug.yourMove) || null,
  })).filter((bug) => bug.suspectLabel);
}

function buildSupportingMetric({ pestPressure, activity }) {
  if (pestPressure && pestPressure.showOnCustomerReport !== false && pestPressure.enabled !== false) {
    const score = pestPressure.displayScore ?? pestPressure.score;
    // A visible-but-insufficient pressure view (score still null) can still
    // carry the one-shot client-rating calibration. Since the dashboard
    // suppresses the standalone PestPressureCard, the rating prompt must
    // ride this metric or first/insufficient reports lose the calibration
    // flow entirely (parity with the same codex finding on Mosquito V2).
    // The client hides the score pill when score is null.
    if (score != null || pestPressure.canCaptureClientRating) {
      return {
        kind: 'pressure',
        score: score != null ? String(score) : null,
        max: pestPressure.maxScore || 5,
        label: score != null ? (pestPressure.label || null) : null,
        trend: score != null ? (pestPressure.trend || null) : null,
        caption: 'Pest pressure',
        // Keep the one-shot client-rating calibration flow that the suppressed
        // legacy PestPressureCard used to own.
        rating: pestPressure.canCaptureClientRating
          ? { question: pestPressure.clientRatingQuestion || 'Over the past 3 months, how much pest activity have you noticed?' }
          : null,
        submittedRating: pestPressure.submittedClientRating ?? null,
      };
    }
  }
  if (activity && (activity.levelWord || activity.score != null)) {
    return {
      kind: 'activity',
      score: activity.score != null ? String(activity.score) : null,
      max: activity.maxScore || 5,
      label: activity.levelWord || null,
      trend: activity.trend || null,
      caption: activity.label || 'Activity',
    };
  }
  return null;
}

function buildAiSummary(personality) {
  const straight = personality?.variants?.straight;
  if (!straight) return null;
  const headline = safeSummary(straight.headline, '');
  const body = safeSummary(straight.body, '');
  if (!headline && !body) return null;
  return { headline: headline || null, body: body || null };
}

// Shape the raw pest-forecast payload (pest-forecast/forecast.js) into a compact
// "what to expect this season" card: the lead summary, this month's weather line,
// and the 2–3 pests most worth watching (rising first, then highest level).
function buildForecast(forecast) {
  if (!forecast || !Array.isArray(forecast.pests) || !forecast.pests.length) return null;
  const ranked = [...forecast.pests].sort((a, b) => {
    const aUp = a.trend === 'up' ? 1 : 0;
    const bUp = b.trend === 'up' ? 1 : 0;
    if (aUp !== bUp) return bUp - aUp;
    const aRank = LEVEL_RANK[a.level] ?? 0;
    const bRank = LEVEL_RANK[b.level] ?? 0;
    if (aRank !== bRank) return bRank - aRank;
    return (b.score10 || 0) - (a.score10 || 0);
  });
  const pests = ranked.slice(0, 3).map((p) => ({
    key: p.key,
    label: p.label,
    emoji: p.emoji || null,
    level: p.level || null,
    trend: p.trend || null,
    note: p.note || null,
  }));
  return {
    monthName: forecast.month_name || null,
    locationLabel: forecast.location?.label || null,
    weatherSummary: forecast.weather?.summary || null,
    headline: forecast.summary || null,
    disclaimer: forecast.disclaimer || null,
    pests,
  };
}

/**
 * buildPestReportV2 — pure. Returns the pestReportV2 payload, or null when there
 * is no pest intelligence to surface (premium-experience produced nothing).
 *
 * @param {object}  premiumExperience  dynamicContext.premiumExperience
 * @param {object}  pestPressure       data.pestPressure (recurring view) | null
 * @param {object}  activity           data.activity (typed view) | null
 * @param {object}  forecast           raw pest-forecast payload (caller-fetched) | null
 * @param {string}  technicianReport   tech-reviewed AI report copy (caller passes
 *                                     data.summary only when summarySource is
 *                                     'technician_report') | null
 */
function buildPestReportV2({
  premiumExperience,
  pestPressure = null,
  activity = null,
  forecast = null,
  technicianReport = null,
} = {}) {
  if (!premiumExperience) return null;
  const defenseStatus = premiumExperience.propertyDefenseStatus;
  const defense = buildDefense(defenseStatus);
  const primaryMove = buildPrimaryMove(premiumExperience.primaryMove);
  const bugFiles = buildBugFiles(premiumExperience.bugFiles);
  const supportingMetric = buildSupportingMetric({ pestPressure, activity });
  // The tech-reviewed AI report copy is the most visit-specific summary we
  // have — it takes the hero's summary slot over the deterministic
  // personality copy. Re-screened here so this pure module never trusts the
  // caller's validation.
  const technicianCopy = technicianReport && validateCustomerCopy(String(technicianReport).trim())
    ? String(technicianReport).trim()
    : null;
  const aiSummary = technicianCopy
    ? { headline: null, body: technicianCopy }
    : buildAiSummary(premiumExperience.aiSummaryPersonality);
  const forecastCard = buildForecast(forecast);

  // Nothing meaningful to show → don't render an empty V2 shell.
  if (!defense && !primaryMove && !bugFiles.length && !supportingMetric && !forecastCard) {
    return null;
  }

  const overallLabel = defenseStatus?.overallLabel;
  const status = STATUS_BY_DEFENSE_LABEL[overallLabel] || DEFAULT_STATUS;
  const statusSummary = safeSummary(
    defenseStatus?.summary,
    'Your service is complete and your protection plan is on track.',
  );

  return {
    status,
    statusSummary,
    supportingMetric,
    defense,
    primaryMove,
    bugFiles,
    pressureReceipt: premiumExperience.pressureReceipt || null,
    weatherCall: premiumExperience.weatherCall || null,
    aiSummary,
    forecast: forecastCard,
  };
}

// PDF cache-key component (mirrors mosquitoReportV2PdfSignature — see that
// function's comment). PEST_REPORT_V2 was never part of the key, so pest
// PDFs cached before the pest V2 flip still serve the pre-dashboard render
// on permanent links; including the gate re-renders each once on next view.
// Scoped to pest-line records so nothing else mass-invalidates.
function pestReportV2PdfSignature(service = {}) {
  if (process.env.PEST_REPORT_V2 !== 'true') return '';
  const line = service.service_line || detectServiceLine(service.service_type);
  // 'b' = the typed-activity composition (owner ruling 2026-07-14): typed
  // pest PDFs now render the ActivityCard alongside the dashboard, so PDFs
  // cached under '-pestv2' would keep hiding the gauge/chart/progress chip
  // on permanent links (codex P2). Bump this suffix whenever the pest-line
  // report COMPOSITION changes — each pest PDF re-renders once on next view.
  return line === 'pest' ? '-pestv2b' : '';
}

module.exports = {
  buildPestReportV2,
  pestReportV2PdfSignature,
  // exported for tests
  stripZoneLetter,
  buildForecast,
  STATUS_BY_DEFENSE_LABEL,
};
