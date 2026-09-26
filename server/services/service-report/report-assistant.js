const { customerVisiblePressureIndex } = require('../pest-pressure/display');

const { WAVES_SUPPORT_PHONE_DISPLAY: WAVES_PHONE_DISPLAY } = require('../../constants/business');

// AW-06: cues that route a typed question to the re-entry answer. A
// location word ("outside"/"inside") only counts when the question is not
// about treatment — "What was applied outside today?" must reach the
// treatment answer, not be hijacked here. Safety-subject words (who is
// affected) always win regardless of the rest of the wording, and their
// plural forms are included (the old matcher had "pet" but missed "pets").
const SAFETY_SUBJECT_RE = /\b(pets?|dogs?|cats?|kids?|child(?:ren)?)\b/;
// Bare "come back" / "go back" / "wait" are NOT cues: "When will you come
// back?" is a scheduling question.
const REENTRY_PHRASE_RE = /\bre-?enter(?:ing|y)?\b|\bready\b|\bsafe\b|\bback\s*(?:out|outside|in|inside)\b/;
// A location word still means re-entry ("When can we go outside again?")
// unless the question is about what was applied there.
const LOCATION_RE = /\b(outside|inside|outdoors|indoors)\b/;
const TREATMENT_QUESTION_RE = /\b(treat|treats|treating|treated|treatment|treatments|product|products|application|applications|apply|applies|applied|applying|spray|sprays|sprayed|spraying|bait|baits|baited|chemical|chemicals|used)\b/;
// AW-06 r1: a location word also must not mean re-entry when the question is
// about what was FOUND there — "What did you find outdoors?" / "Did you see
// any ants indoors?" are findings questions, not re-entry timing.
const FINDINGS_QUESTION_RE = /\b(find|found|finding|see|saw|notice|noticed|activity|ants?|pests?|bugs?|roaches?|spiders?|rodents?|mice|rats?)\b/;
// A temporal "when/after/how long … go/get/come/let … in/out" question is
// re-entry even when it names the treatment ("When can I go inside after
// the treatment?").
// ("When will you come back?" stays a scheduling question.)
const REENTRY_TEMPORAL_RE = /\b(?:when|after|how\s+long|how\s+soon)\b[^?.]*\b(?:go|get|let|walk|play)\b[^?.]*\b(?:in|out|inside|outside|indoors|outdoors)\b/;
function isReentryIntent(q) {
  return SAFETY_SUBJECT_RE.test(q)
    || REENTRY_PHRASE_RE.test(q)
    || REENTRY_TEMPORAL_RE.test(q)
    || (LOCATION_RE.test(q) && !TREATMENT_QUESTION_RE.test(q) && !FINDINGS_QUESTION_RE.test(q));
}
// Results questions ("Is the weed treatment working?") belong to the trend
// answer even though they name the treatment.
const EFFECTIVENESS_RE = /\b(working|improving|helping|trending|results?|better|worse)\b/;
// Explicit advice wording outranks the broad lawn-trend subjects ("What do
// you recommend for the stress areas?").
const ADVICE_RE = /\b(recommend\w*|what\s+should\s+i|should\s+i|what\s+action|next\s+step)\b/;
const TREND_RE = /\b(pressure|trend|trending|better|worse|score|index|improving|lawn|turf|weeds?|fungus|thatch|stress|damage|coverage|color|thicken\w*|thin)\b/;

const PRODUCT_INSIGHTS = [
  {
    match: /\btaurus\b|fipronil/i,
    activeIngredient: 'Fipronil',
    role: 'non-repellent exterior residual treatment',
    customerMeaning: 'This type of chemistry is used around structural edges because insects can cross treated zones without being immediately repelled.',
  },
  {
    match: /\bbifen\b|\bbifenthrin\b|talstar/i,
    activeIngredient: 'Bifenthrin',
    role: 'pyrethroid residual treatment',
    customerMeaning: 'This adds a faster-acting residual barrier on exterior surfaces where crawling insects travel.',
  },
  {
    // Exact chemistry terms only (AW-07): a brand name alone (e.g. "LESCO",
    // which sells fertilizers as well as adjuvants) is not reliable evidence
    // of what a product actually is. Category-based classification below
    // covers a catalog-approved adjuvant whose name doesn't use these words.
    match: /90\/10|nonionic\s*surfactant|\bsurfactant\b/i,
    role: 'spray adjuvant',
    customerMeaning: 'This is not the insecticide. It helps the spray mix wet and spread more evenly on treated surfaces.',
  },
  {
    match: /demand\s*cs|lambda/i,
    activeIngredient: 'Lambda-cyhalothrin',
    role: 'microencapsulated residual treatment',
    customerMeaning: 'Microencapsulated products are commonly used for exterior residual control around entry-prone areas.',
  },
  {
    match: /alpine|dinotefuran/i,
    activeIngredient: 'Dinotefuran',
    role: 'non-repellent targeted treatment',
    customerMeaning: 'Non-repellent products are useful where trailing insects need to contact the treatment instead of avoiding it.',
  },
  {
    match: /advion|indoxacarb/i,
    activeIngredient: 'Indoxacarb',
    role: 'bait treatment',
    customerMeaning: 'Baits are designed to be found and carried or fed on by target pests, so light activity near bait can be expected at first.',
  },
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function compact(values) {
  return values.map(cleanText).filter(Boolean);
}

function unique(values) {
  return [...new Set(compact(values))];
}

function sentenceJoin(values) {
  return compact(values).join(' ');
}

function reportEnumLabel(value) {
  const key = normalizeKey(value);
  const labels = {
    ghost_ant: 'ghost ants',
    american_roach: 'American roaches',
    german_roach: 'German roaches',
    roach: 'roaches',
    ant: 'ants',
    spider: 'spiders',
    perimeter_spray: 'perimeter spray',
    bait_placement: 'bait placement',
    spot_treatment: 'spot treatment',
    broadcast_spray: 'broadcast spray',
    granular_broadcast: 'granular broadcast',
    pin_stream: 'pin-stream treatment',
  };
  return labels[key] || key.replace(/_/g, ' ');
}

function serviceDateText(value) {
  if (!value) return '';
  const raw = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = dateOnly
    ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12))
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function serviceTimeText(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return text;
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function pickRecommendedFinding(findings = []) {
  const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  return [...findings]
    .sort((a, b) => (rank[String(b.severity || '').toLowerCase()] || 0) - (rank[String(a.severity || '').toLowerCase()] || 0))
    .find((finding) => cleanText(finding.recommendation)) || null;
}

function productName(app = {}) {
  return cleanText(app.product?.name || app.productName || app.product_name || 'Treatment');
}

// AW-07: classify from the approved catalog product_type/category (frozen or
// live-approved — whichever report-data.js's attachApprovedReportProductFacts
// already resolved onto app.product) before falling back to exact
// product/ingredient text matches. A brand name alone is never sufficient
// evidence of chemistry or function (a brand covers multiple product types).
function categoryInsightFor(app = {}) {
  const product = app.product || {};
  // Only approved catalog facts may drive a chemistry claim; a frozen-null or
  // unapproved product still carries its recorded category string.
  if (!product.facts_approved) return null;
  const productType = String(product.product_type || '').toLowerCase();
  const category = String(product.category || '').toLowerCase();
  if (productType === 'wetting_agent' || /\b(surfactant|adjuvant|wetting agent)\b/.test(category)) {
    return {
      role: 'spray adjuvant',
      customerMeaning: 'This is not the insecticide. It helps the spray mix wet and spread more evenly on treated surfaces.',
    };
  }
  return null;
}

function insightFor(app = {}) {
  const categoryInsight = categoryInsightFor(app);
  if (categoryInsight) return categoryInsight;
  const haystack = [
    productName(app),
    app.product?.active_ingredient,
    app.product?.activeIngredient,
  ].join(' ');
  return PRODUCT_INSIGHTS.find((insight) => insight.match.test(haystack)) || null;
}

function activeIngredientFor(app = {}) {
  return cleanText(
    app.product?.active_ingredient
    || app.product?.activeIngredient
    || insightFor(app)?.activeIngredient
  );
}

function epaRegFor(app = {}) {
  return cleanText(app.product?.epa_reg || app.product?.epaReg);
}

function rateText(app = {}) {
  const rate = cleanText(app.rate);
  const unit = cleanText(app.rateUnit);
  const total = cleanText(app.totalAmount);
  const amountUnit = cleanText(app.amountUnit);
  const area = cleanText(app.areaValue);
  const areaUnit = cleanText(app.areaUnit);
  if (rate && unit && total && amountUnit) return `rate ${rate} ${unit}; total ${total} ${amountUnit}`;
  if (rate && unit) return `rate ${rate} ${unit}`;
  if (total && amountUnit) return `total used ${total} ${amountUnit}`;
  if (area && areaUnit) return `treated area ${area} ${areaUnit}`;
  return '';
}

// No re-entry or rainfast figure is rendered here: customer surfaces never
// carry a fixed re-entry/drying duration (AGENTS.md compliance language) —
// the re-entry answer gives the once-dry guidance instead.
function applicationScope(data = {}) {
  const apps = Array.isArray(data.applications) ? data.applications : [];
  const serviceAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas : [];
  const text = [
    ...serviceAreas,
    ...apps.map((app) => app.applicationArea || app.area || app.method || app.methodLabel),
  ].join(' ').toLowerCase();
  const hasInterior = /\b(interior|inside|kitchen|bath|bedroom|baseboard|living room)\b/.test(text);
  const hasExterior = /\b(exterior|outside|outdoor|perimeter|foundation|eave|soffit|yard|front|back|rear|side|lanai|patio|pool|garage|driveway|landscape|mulch|entry|threshold)\b/.test(text);
  if (hasExterior && !hasInterior) return 'exterior-only';
  if (hasInterior && !hasExterior) return 'interior-only';
  if (hasInterior && hasExterior) return 'interior and exterior';
  return '';
}

function scopePhrase(scope) {
  if (scope === 'exterior-only') return 'an exterior-only';
  if (scope === 'interior-only') return 'an interior-only';
  if (scope === 'interior and exterior') return 'an interior/exterior';
  return '';
}

function conditionSummary(conditions = {}) {
  const temp = conditions.temp_f ?? conditions.temp;
  const humidity = conditions.humidity_pct ?? conditions.humidity;
  const wind = conditions.wind_mph ?? conditions.wind;
  const rain = conditions.rain_24h_in ?? conditions.rainfall_in;
  const facts = [
    temp != null ? `${Math.round(Number(temp))}F` : null,
    humidity != null ? `${Math.round(Number(humidity))}% humidity` : null,
    wind != null ? `${Math.round(Number(wind))} mph wind` : null,
    rain != null ? `${Number(rain).toFixed(2)} in rain` : null,
  ].filter(Boolean);
  if (!facts.length) return '';
  const source = cleanText(conditions.source);
  return `${source || 'Application conditions'}: ${facts.join(', ')}.`;
}

function answerAppliedToday({ data = {} } = {}) {
  const applications = Array.isArray(data.applications) ? data.applications : [];
  if (!applications.length) return 'No product applications were recorded on this report.';

  const scope = applicationScope(data);
  const methodLabels = unique(applications.map((app) => app.methodLabel || reportEnumLabel(app.method))).slice(0, 3);
  const serviceName = cleanText(data.serviceDisplayName || data.serviceType || 'service');
  const scopeText = scopePhrase(scope);
  const intro = sentenceJoin([
    `Today was${scopeText ? ` ${scopeText}` : ''} ${serviceName}.`,
    methodLabels.length ? `The logged application methods were ${methodLabels.join(', ')}.` : '',
    conditionSummary(data.conditions),
  ]);

  const lines = applications.slice(0, 4).map((app) => {
    const insight = insightFor(app);
    const name = productName(app);
    const method = cleanText(app.methodLabel || reportEnumLabel(app.method));
    const area = cleanText(app.applicationArea || app.area);
    const targets = Array.isArray(app.targets) && app.targets.length
      ? `targets ${app.targets.map(reportEnumLabel).join(', ')}`
      : '';
    const active = activeIngredientFor(app);
    const epa = epaRegFor(app);
    const technical = compact([
      insight?.role,
      active ? `active ingredient: ${active}` : '',
      method,
      area ? `area: ${area}` : '',
      targets,
      rateText(app),
      epa ? `EPA Reg. ${epa}` : '',
    ]);
    const meaning = insight?.customerMeaning ? ` ${insight.customerMeaning}` : '';
    return `${name}: ${technical.join('; ')}.${meaning}`;
  });

  const sourceLine = 'Sources used: this service report, product label/catalog fields when available, and stored application conditions.';
  return [intro, ...lines, sourceLine].filter(Boolean).join('\n');
}

function recommendationList(data = {}) {
  const findings = Array.isArray(data.findings) ? data.findings : [];
  return unique([
    ...(Array.isArray(data.recommendations) ? data.recommendations : []),
    ...findings.map((finding) => finding.recommendation),
  ]);
}

function targetsFromApplications(applications = []) {
  return unique(applications.flatMap((app) => (
    Array.isArray(app.targets) ? app.targets.map(reportEnumLabel) : []
  )));
}

function answerNextSteps({ data = {}, nextAppointment } = {}) {
  const dynamic = data.dynamicContext || {};
  const lawnAssessment = data.lawnAssessment || null;
  if (data.serviceLine === 'lawn' && lawnAssessment?.snapshot) {
    const cards = Array.isArray(lawnAssessment.recommendationCards) ? lawnAssessment.recommendationCards : [];
    const cardLines = cards
      .map((card) => cleanText(card.customerCopy || card.title))
      .filter(Boolean)
      .slice(0, 2);
    const watchItems = Array.isArray(lawnAssessment.snapshot.nextWatchItems)
      ? lawnAssessment.snapshot.nextWatchItems.map(cleanText).filter(Boolean)
      : [];
    const expected = lawnAssessment.snapshot.expectedWindow || {};
    const expectedLine = expected.minDays && expected.maxDays
      ? `Visible improvement usually takes ${expected.minDays}-${expected.maxDays} days, depending on irrigation, mowing, rainfall, and site conditions.`
      : '';
    return [
      cardLines.length ? `Recommended next step: ${cardLines[0]}` : '',
      cardLines.length > 1 ? `Also noted: ${cardLines.slice(1).join(' ')}` : '',
      watchItems.length ? `What we are watching: ${watchItems.slice(0, 2).join(' ')}` : '',
      expectedLine,
      nextAppointment ? `Next scheduled visit: ${serviceDateText(nextAppointment.scheduled_date)}.` : '',
    ].filter(Boolean).join('\n') || lawnAssessment.snapshot.summary;
  }
  const primaryMove = dynamic.premiumExperience?.primaryMove?.title
    || dynamic.aiSummary?.recommendedNextStep?.text
    || pickRecommendedFinding(Array.isArray(data.findings) ? data.findings : [])?.recommendation;
  const recommendations = recommendationList(data);
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const scope = applicationScope(data);
  const targetText = targetsFromApplications(applications).slice(0, 3).join(', ');
  const reentry = dynamic.reentry?.customerSummary;
  const weather = dynamic.premiumExperience?.weatherCall
    ? sentenceJoin([dynamic.premiumExperience.weatherCall.headline, dynamic.premiumExperience.weatherCall.body])
    : '';

  if (primaryMove || recommendations.length) {
    return [
      primaryMove ? `Priority next step: ${primaryMove}` : `Recommended next step: ${recommendations[0]}`,
      recommendations.length > 1 ? `Also noted: ${recommendations.slice(1, 3).join(' ')}` : '',
      reentry ? `Re-entry: ${reentry}` : '',
      nextAppointment ? `Next scheduled visit: ${serviceDateText(nextAppointment.scheduled_date)}.` : '',
    ].filter(Boolean).join('\n');
  }

  const watchArea = targetText
    ? `Watch for ${targetText} around the treated areas.`
    : 'Watch the documented treatment areas.';
  const scopeLine = scope === 'exterior-only'
    ? 'No interior prep was called out because this report shows exterior treatment only.'
    : scope === 'interior-only'
      ? 'Interior areas were documented, so follow the re-entry guidance before using treated spaces normally.'
      : 'Follow the re-entry guidance before normal use of treated areas.';
  const rinseLine = applications.some((app) => /spray|broadcast|perimeter|spot/i.test(`${app.method} ${app.methodLabel}`))
    ? 'Avoid rinsing, pressure-washing, or disturbing the treated perimeter today unless Waves gives different instructions.'
    : '';

  return [
    'No special repair or prep was flagged for you on this report.',
    scopeLine,
    reentry ? `Re-entry: ${reentry}` : '',
    rinseLine,
    weather,
    `${watchArea} Text Waves if activity increases, moves inside, or shows up in a new area before the next visit.`,
    nextAppointment ? `Next scheduled visit: ${serviceDateText(nextAppointment.scheduled_date)}.` : '',
  ].filter(Boolean).join('\n');
}

function answerReentry({ data = {} } = {}) {
  const dynamic = data.dynamicContext || {};
  if (dynamic.reentry?.customerSummary) return dynamic.reentry.customerSummary;
  const advisory = data.advisory || {};
  // Owner rule (site-compliance): customer surfaces never phrase re-entry as
  // a minute count. Ready-at times come from dynamic.reentry above; without
  // that anchor this fallback speaks in "once dry" terms only, matching
  // reentry.js's framing (audit 2026-07-16 — this was the one surface that
  // still said "N min outside, N min inside").
  const hasWindow = Number(advisory.exterior_reentry_min) > 0 || Number(advisory.interior_reentry_min) > 0;
  // AW-06: no recorded interval is not itself an answer — hand the customer
  // an explicit way to confirm it's safe rather than leaving them with a
  // bare "not recorded" and nothing to do next.
  const base = hasWindow
    ? 'Give treated areas time to fully dry before normal use.'
    : `No re-entry timer was recorded for this report — call or text ${WAVES_PHONE_DISPLAY} and we'll confirm the timing for your treated areas.`;
  return `${base}${advisory.pet_advisory ? ` ${advisory.pet_advisory}` : ''}`;
}

function answerTrend({ data = {} } = {}) {
  const dynamic = data.dynamicContext || {};
  const lawnAssessment = data.lawnAssessment || null;
  if (lawnAssessment?.scores) {
    const scores = lawnAssessment.scores;
    // Scores can be null for categories that weren't assessed — only mention the
    // ones we actually have, so the assistant never says "null% overall".
    const breakdown = [
      scores.turfDensity != null ? `density/coverage ${scores.turfDensity}%` : null,
      scores.weedSuppression != null ? `weed cleanliness ${scores.weedSuppression}%` : null,
      scores.colorHealth != null ? `color/nutrients ${scores.colorHealth}%` : null,
      scores.stressDamage != null ? `stress/damage ${scores.stressDamage}%` : null,
    ].filter(Boolean);
    return [
      lawnAssessment.snapshot?.summary,
      lawnAssessment.customerSummary,
      scores.overallScore != null ? `Current lawn health is ${scores.overallScore}% overall.` : null,
      breakdown.length ? `Breakdown: ${breakdown.join(', ')}.` : null,
    ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' ');
  }
  if (dynamic.pressureTrend?.customerSummary) return dynamic.pressureTrend.customerSummary;
  const visibleIndex = customerVisiblePressureIndex(data.pressureIndex);
  // No reading → say so. 0.3 is the display FLOOR for real readings, never a
  // stand-in for missing data (audit 2026-07-16: the old `|| '0.3'` fallback
  // invented a score on reports whose pressure is hidden or absent).
  if (visibleIndex != null) return `This visit's pressure index is ${visibleIndex.toFixed(1)} on a 0-5 scale. Lower is better.`;
  return 'A pressure reading was not recorded for this visit, so there is no score to compare yet. Text Waves if you are seeing activity and we will take a look.';
}

function answerFindings({ data = {} } = {}) {
  const lawnAssessment = data.lawnAssessment || null;
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
  if (lawnAssessment?.snapshot) {
    const snapshot = lawnAssessment.snapshot;
    const findingLines = Array.isArray(snapshot.findings)
      ? snapshot.findings.map((finding) => cleanText(finding.customerCopy)).filter(Boolean)
      : [];
    return [
      snapshot.summary,
      findingLines.slice(0, 3).join('\n'),
    ].filter(Boolean).join('\n');
  }
  if (lawnAssessment?.observations) return lawnAssessment.observations;
  if (!findings.length && recommendations.length) {
    return recommendations.slice(0, 3).map((rec) => `Recommended next step: ${rec}`).join('\n');
  }
  if (!findings.length) return 'No activity was observed this visit. Routine protective service will continue on schedule.';
  return findings.slice(0, 3).map((finding) => {
    const detail = finding.detail ? ` ${finding.detail}` : '';
    const rec = finding.recommendation ? ` Recommended: ${finding.recommendation}` : '';
    return `${finding.title}.${detail}${rec}`;
  }).join('\n');
}

// Customer-facing arrival window = window_start + 2 hours. window_end is the
// internal job block that drives scheduling and must never be spoken to the
// customer (same rule as the confirmation SMS echoes).
function arrivalWindowEnd(windowStart) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(windowStart || ''));
  if (!m) return null;
  const total = ((Number(m[1]) * 60) + Number(m[2]) + 120) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
}

function answerNextAppointment({ nextAppointment } = {}) {
  if (!nextAppointment) {
    return 'I do not see another appointment scheduled yet. Reply to the text message or call Waves if you want us to set one up.';
  }
  const windowEnd = arrivalWindowEnd(nextAppointment.window_start);
  const window = [nextAppointment.window_start, windowEnd].filter(Boolean).map(serviceTimeText).join(' to ');
  return `Your next appointment is ${serviceDateText(nextAppointment.scheduled_date)} for ${nextAppointment.service_type || 'service'}${window ? `, window ${window}` : ''}.`;
}

function answerServiceReportQuestion({
  question,
  data,
  nextAppointment,
} = {}) {
  const q = String(question || '').toLowerCase();

  // This week's watering plan, when the report carries one, answers any
  // watering question first — never re-entry or generic copy under the
  // plan shown on the same page (codex #3565 gh-r29). Without a plan the
  // existing routing (irrigation → re-entry) stands.
  // Safety first: re-entry / pets / kids questions answer with the once-dry
  // rule even when they mention minutes or water (codex gh-r30). AW-06: a
  // bare location word ("outside"/"inside") is no longer enough on its own —
  // see isReentryIntent — so "What was applied outside today?" reaches the
  // treatment answer below instead of being hijacked here.
  if (isReentryIntent(q)) {
    return answerReentry({ data });
  }

  const weekPlan = data?.reportV2?.water?.weekPlan;
  const aftercare = data?.reportV2?.aftercare;
  // Controller phrasing without the word "water" — "How long should I run
  // each zone?", "how many minutes per zone" — is a watering question too
  // (codex gh-r38); the safety-intent guard above still wins.
  // Controller-shaped phrasing only — "what time zone is my appointment"
  // must fall through to the appointment router (codex gh-r46).
  const zoneRuntimeIntent = !/\btime\s*zones?\b/.test(q)
    && /\bzones?\b/.test(q) && /\b(run|runs|running|minutes?|duration|how long)\b/.test(q);
  const wateringIntent = /\b(water|watering|irrigat\w*|sprinklers?|run ?time)\b/.test(q) || zoneRuntimeIntent;
  // Aftercare: "should I water after today's treatment?" answers with the
  // label instruction, plus the reduced plan when a watering-in is credited.
  if (wateringIntent && aftercare?.watering && /\b(treat\w*|application|applied|product|spray\w*|today)\b/.test(q)) {
    // Same guards as the rendered card: a credited watering-in only for a
    // REQUIRED watering-in, on a visit inside the plan week, on a plan that
    // prescribes a run (codex gh-r31).
    const credited = aftercare.waterInRequired === true && weekPlan?.visitInPlanWeek === true && weekPlan?.prescribesRun === true;
    const reduced = credited && weekPlan?.afterTreatment?.title ? weekPlan.afterTreatment : null;
    // A HOLD plan beside a required watering-in: the answer must carry the
    // plan's no-extra-runs guidance too — the label instruction alone reads
    // as permission to resume the normal schedule (codex gh-r45).
    const holdBeside = !reduced && aftercare.waterInRequired === true
      && weekPlan?.visitInPlanWeek === true && weekPlan?.prescribesRun === false && weekPlan?.title
      ? weekPlan : null;
    return [aftercare.watering, reduced ? `${reduced.title}. ${reduced.detail}` : (holdBeside ? `${holdBeside.title}. ${holdBeside.detail}` : null)].filter(Boolean).join(' ');
  }
  if (weekPlan?.title && wateringIntent) {
    return [weekPlan.title, weekPlan.detail].filter(Boolean).join(' ');
  }

  if (/\b(irrigation)\b/.test(q)) {
    return answerReentry({ data });
  }

  // AW-06: exact-word matching missed inflections ("treated", "applying",
  // "products", "used") — this is the branch "What was applied outside
  // today?" and "Why was <product> used?" must reach. Checked before the
  // trend branch below: a question that mentions both ("What was applied to
  // the weeds?", "What did you spray on the thin areas?") is asking about
  // the treatment, not the lawn trend, so treatment cues win when both match.
  if (TREATMENT_QUESTION_RE.test(q)) {
    // "Is the treatment working?" asks about results, not what was applied.
    return EFFECTIVENESS_RE.test(q) ? answerTrend({ data }) : answerAppliedToday({ data });
  }

  // Explicit scheduling wording outranks the broad advice phrases ("Should I
  // schedule my next appointment?").
  if (/\b(appointment|appt|schedule|scheduled|next service|next visit)\b/.test(q)) {
    return answerNextAppointment({ nextAppointment });
  }

  if (ADVICE_RE.test(q)) {
    return answerNextSteps({ data, nextAppointment });
  }

  // Explicit findings wording outranks the broad lawn subjects ("What damage
  // did you find?" on a pest report).
  if (/\b(find|found|finding|findings)\b/.test(q)) {
    return answerFindings({ data });
  }

  // AW-06: covers the lawn V2 insight chips too (water/weeds/damage/
  // coverage/color categories in ReportViewPage.jsx's reportAskPrompts),
  // which all read from this same score breakdown in answerTrend.
  if (TREND_RE.test(q)) {
    return answerTrend({ data });
  }

  // "watch" added (AW-06): "What should I watch for next?" is advisory
  // next-steps intent, not an appointment-date lookup — checked here, before
  // the bare "next" appointment branch below.
  if (/\b(do|watch|next step|recommend|recommendation|action|mulch|follow up|follow-up)\b/.test(q)) {
    return answerNextSteps({ data, nextAppointment });
  }

  if (/\b(next|upcoming|appointment|appt|schedule|scheduled|come back)\b/.test(q)) {
    return answerNextAppointment({ nextAppointment });
  }

  if (/\b(find|found|activity|issue|problem|clear|photo|map|where)\b/.test(q) || FINDINGS_QUESTION_RE.test(q)) {
    return answerFindings({ data });
  }

  const summary = data?.dynamicContext?.aiSummary;
  if (summary?.headline || summary?.body) {
    return [summary.headline, summary.body].filter(Boolean).join(' ');
  }
  return 'This service is complete. You can review the treatment map, applications, findings, conditions, and customer advisory on this report.';
}

module.exports = {
  answerServiceReportQuestion,
  answerAppliedToday,
  answerNextSteps,
};
