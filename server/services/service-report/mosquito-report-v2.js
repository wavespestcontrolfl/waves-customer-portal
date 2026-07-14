/**
 * Mosquito Report V2 aggregator — the customer-facing recurring mosquito report.
 *
 * Same family as pest-report-v2.js (a thin, PURE arranger — no DB, node-testable),
 * but the reframe is different: mosquito value is YARD USABILITY, and the customer's
 * real questions are "can we use the yard?" / "is it working?" / "what's breeding
 * risk right now?". So the hero leads with a STATUS (Yard protected / We're watching
 * / Action needed), the habitat card shows WHERE treatment and breeding risk live
 * (foliage, standing water, lanai — not the pest report's entry points, which are
 * meaningless for a yard-wide fog/foliar service), and the outlook card leads with
 * the mosquito seasonal forecast + the weather at application time, because mosquito
 * pressure is weather-driven in a way no other service line is.
 *
 * premium-experience.js computes for every service line, but its
 * propertyDefenseStatus is pest-semantic (perimeter spray / front entry / lanai /
 * pool pad — a mosquito visit would always read "No perimeter application was
 * logged"), so this module derives its own overall status and habitat items from
 * the report's findings + applications instead. primaryMove / aiSummaryPersonality
 * / weatherCall ARE line-generic and are reused as-is.
 *
 * Honest-copy rules carry over: every synthesized line runs through the shared
 * banned-copy guard, and no internal A/B/C/D zone letters appear (habitat items
 * are derived from finding text, never zone labels).
 */

const { validateCustomerCopy } = require('./premium-experience');

const STATUS_BY_KEY = {
  protected: { key: 'protected', label: 'Yard protected', tone: 'good' },
  watching: { key: 'watching', label: 'We’re watching', tone: 'watch' },
  recommended: { key: 'recommended', label: 'One step recommended', tone: 'watch' },
  action: { key: 'action', label: 'Action needed', tone: 'attention' },
};

const STATUS_SUMMARY = {
  protected: 'Today’s mosquito treatment is complete and your yard is in a strong position.',
  watching: 'Today’s service is complete — Waves will keep watching the documented areas.',
  recommended: 'One customer action would help strengthen your mosquito plan between visits.',
  action: 'One recommendation needs attention to reduce mosquito activity at your property.',
};

// Yard-wide treatment methods a mosquito visit can log (service-line-configs
// allowedMethods for mosquito, plus granular larvicide placements).
const TREATMENT_METHODS = new Set(['fog_ulv', 'foliar_spray', 'spot_treatment', 'granular_broadcast']);

// Habitat watch items — derived from finding TEXT (title + detail), the same
// heuristic style as the pest defense builder's lanai/pool checks. Standing
// water is the one that matters most: it is the breeding-site signal.
const HABITAT_NODES = [
  {
    key: 'standing_water',
    label: 'Standing water',
    pattern: /standing water|stagnant|breeding|bird ?bath|plant saucer|saucer|bromeliad|bucket|container|tarp|kiddie pool|pond|puddl/i,
    watched: 'A standing-water breeding site was documented — see today’s findings.',
    clear: 'No standing-water breeding sites were documented today.',
  },
  {
    key: 'foliage',
    label: 'Dense foliage',
    pattern: /foliage|shrub|hedge|bush|dense plant|overgrown|vegetation|leaf litter|ground cover/i,
    watched: 'Mosquito resting activity was documented in the landscape foliage.',
    clear: 'No unusual activity was documented in the landscape foliage.',
  },
  {
    key: 'lanai_patio',
    label: 'Lanai & patio',
    pattern: /lanai|patio|porch|pool deck|screen enclosure|screened/i,
    watched: 'Activity or a recommendation was documented around the lanai or patio.',
    clear: 'No lanai or patio activity was documented.',
  },
  {
    key: 'drainage',
    label: 'Gutters & drainage',
    pattern: /gutter|downspout|drain|french drain|swale|runoff|irrigation leak/i,
    watched: 'A drainage or gutter condition was documented — moisture there can support breeding.',
    clear: 'No gutter or drainage conditions were documented.',
  },
];

function text(value) {
  // premium-experience wraps customer strings as sourceBacked → { text, sourceKeys }.
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value.text === 'string') return value.text.trim();
  return '';
}

function safeCopy(value, fallback) {
  const copy = text(value);
  if (copy && validateCustomerCopy(copy)) return copy;
  return fallback;
}

function findingText(finding) {
  return `${finding?.title || ''} ${finding?.detail || ''}`.toLowerCase();
}

// Findings that only state "nothing documented" must not light up watch states.
function isActiveFinding(finding) {
  return finding && finding.category !== 'no_activity';
}

function resolveStatusKey({ findings = [], treatedToday, pressureScore }) {
  const active = findings.filter(isActiveFinding);
  const highAction = active.some((finding) => ['critical', 'high'].includes(finding.severity) && finding.recommendation);
  if (highAction) return 'action';
  if (active.some((finding) => finding.recommendation)) return 'recommended';
  // Documented activity — even without a recommendation — is never "protected";
  // the honest read is that we treated and we're watching it.
  if (active.length) return 'watching';
  const lowPressure = Number.isFinite(pressureScore) && pressureScore < 2;
  // A yard-wide application with nothing flagged is the strong outcome for a
  // recurring mosquito visit — pressure (when tracked) can only confirm it.
  if (treatedToday && (lowPressure || !Number.isFinite(pressureScore))) return 'protected';
  return 'watching';
}

function buildHabitat({ findings = [], applications = [] }) {
  const treatments = applications.filter((app) => TREATMENT_METHODS.has(app.method));
  const treatedToday = treatments.length > 0;
  const activeFindings = findings.filter(isActiveFinding);
  const texts = activeFindings.map(findingText);

  const items = [
    {
      key: 'yard_treatment',
      label: 'Yard treatment',
      status: treatedToday ? 'active' : 'watched',
      detail: treatedToday
        ? 'Mosquito treatment was applied to resting and harborage areas today.'
        : 'No mosquito application was logged today.',
    },
    ...HABITAT_NODES.map((node) => {
      const hit = texts.some((t) => node.pattern.test(t));
      return {
        key: node.key,
        label: node.label,
        status: hit ? 'watched' : 'clear',
        detail: hit ? node.watched : node.clear,
      };
    }),
  ];

  const anyWatched = items.some((item) => item.status === 'watched' && item.key !== 'yard_treatment');
  let summary;
  if (!treatedToday) {
    summary = 'We checked the spots around your yard that can support mosquito breeding.';
  } else if (anyWatched) {
    summary = 'We treated the yard and flagged the spots that can support mosquito breeding.';
  } else {
    summary = 'We treated the yard and found no conditions that support mosquito breeding today.';
  }
  return { treatedToday, summary, items };
}

function buildSupportingMetric({ pestPressure, activity }) {
  if (pestPressure && pestPressure.showOnCustomerReport !== false && pestPressure.enabled !== false) {
    const score = pestPressure.displayScore ?? pestPressure.score;
    if (score != null) {
      return {
        kind: 'pressure',
        score: String(score),
        max: pestPressure.maxScore || 5,
        label: pestPressure.label || null,
        trend: pestPressure.trend || null,
        caption: 'Mosquito pressure',
        rating: pestPressure.canCaptureClientRating
          ? { question: pestPressure.clientRatingQuestion || 'Over the past month, how much mosquito activity have you noticed in your yard?' }
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

function buildPrimaryMove(primaryMove) {
  if (!primaryMove?.title) return null;
  return {
    title: text(primaryMove.title) || primaryMove.title,
    why: text(primaryMove.why) || primaryMove.why || '',
    impact: text(primaryMove.impact) || primaryMove.impact || '',
    dueLabel: primaryMove.dueLabel || 'Before next service',
  };
}

// The one habit that helps every mosquito plan: weekly source reduction. Used
// only when the visit documented no finding-driven recommendation, and only
// when a breeding-risk habitat was flagged — a clean report doesn't need a
// filler chore card every single visit.
function defaultSourceReductionMove(habitat) {
  const breedingFlagged = habitat?.items?.some(
    (item) => ['standing_water', 'drainage'].includes(item.key) && item.status === 'watched',
  );
  if (!breedingFlagged) return null;
  return {
    title: 'Tip and toss standing water once a week',
    why: 'Mosquitoes can develop in as little as a bottle cap of standing water. Emptying plant saucers, buckets, toys, and birdbaths weekly removes breeding spots before larvae mature.',
    impact: 'This is the single habit that gives your treatments the most help between visits.',
    dueLabel: 'Weekly habit',
  };
}

function buildAiSummary(personality) {
  const straight = personality?.variants?.straight;
  if (!straight) return null;
  const headline = safeCopy(straight.headline, '');
  const body = safeCopy(straight.body, '');
  if (!headline && !body) return null;
  return { headline: headline || null, body: body || null };
}

// Mosquito-focused outlook: the mosquitoes entry from the seasonal pest
// forecast + the weather line, with the at-service conditions (weatherCall)
// as the factual footer. Mosquito is the one line where weather IS the story.
function buildOutlook({ forecast, weatherCall }) {
  const entry = Array.isArray(forecast?.pests)
    ? forecast.pests.find((p) => /mosquito/i.test(`${p.key || ''} ${p.label || ''}`))
    : null;
  const conditions = weatherCall
    ? {
      headline: safeCopy(weatherCall.headline, ''),
      body: safeCopy(weatherCall.body, ''),
      factsLine: weatherCall.factsLine || null,
    }
    : null;
  if (!entry && !conditions) return null;
  return {
    monthName: forecast?.month_name || null,
    locationLabel: forecast?.location?.label || null,
    weatherSummary: forecast?.weather?.summary || null,
    disclaimer: forecast?.disclaimer || null,
    mosquito: entry
      ? {
        label: entry.label || 'Mosquitoes',
        emoji: entry.emoji || null,
        level: entry.level || null,
        trend: entry.trend || null,
        note: entry.note || null,
      }
      : null,
    conditions: conditions && (conditions.headline || conditions.factsLine) ? conditions : null,
  };
}

/**
 * buildMosquitoReportV2 — pure. Returns the mosquitoReportV2 payload, or null
 * when there is nothing meaningful to surface.
 *
 * @param {object} premiumExperience  dynamicContext.premiumExperience
 * @param {object} pestPressure       data.pestPressure | null
 * @param {object} activity           data.activity | null
 * @param {Array}  findings           data.findings (customer-visible report findings)
 * @param {Array}  applications       data.applications (normalized, with .method)
 * @param {object} forecast           raw pest-forecast payload (caller-fetched) | null
 * @param {string} technicianReport   tech-reviewed AI report copy (caller passes
 *                                    data.summary only when summarySource is
 *                                    'technician_report') | null
 */
function buildMosquitoReportV2({
  premiumExperience,
  pestPressure = null,
  activity = null,
  findings = [],
  applications = [],
  forecast = null,
  technicianReport = null,
} = {}) {
  if (!premiumExperience) return null;

  const habitat = buildHabitat({ findings, applications });
  const supportingMetric = buildSupportingMetric({ pestPressure, activity });
  const primaryMove = buildPrimaryMove(premiumExperience.primaryMove)
    || defaultSourceReductionMove(habitat);
  const outlook = buildOutlook({ forecast, weatherCall: premiumExperience.weatherCall });

  // Same technician-copy precedence as the pest hero, re-screened here so this
  // pure module never trusts the caller's validation.
  const technicianCopy = technicianReport && validateCustomerCopy(String(technicianReport).trim())
    ? String(technicianReport).trim()
    : null;
  const aiSummary = technicianCopy
    ? { headline: null, body: technicianCopy }
    : buildAiSummary(premiumExperience.aiSummaryPersonality);

  // A recurring mosquito visit with no logged application, no findings, no
  // metric, and no outlook has nothing for a dashboard to say.
  if (!habitat.treatedToday && !supportingMetric && !primaryMove && !outlook
      && !findings.filter(isActiveFinding).length) {
    return null;
  }

  const pressureScore = Number(pestPressure?.displayScore ?? pestPressure?.score);
  const statusKey = resolveStatusKey({
    findings,
    treatedToday: habitat.treatedToday,
    pressureScore: Number.isFinite(pressureScore) ? pressureScore : null,
  });
  const status = STATUS_BY_KEY[statusKey] || STATUS_BY_KEY.watching;

  return {
    status,
    statusSummary: STATUS_SUMMARY[statusKey] || STATUS_SUMMARY.watching,
    supportingMetric,
    habitat: { summary: habitat.summary, items: habitat.items },
    primaryMove,
    outlook,
    aiSummary,
  };
}

module.exports = {
  buildMosquitoReportV2,
  // exported for tests
  resolveStatusKey,
  buildHabitat,
  buildOutlook,
  HABITAT_NODES,
};
