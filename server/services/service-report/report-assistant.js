const db = require('../../models/db');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');

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
    match: /90\/10|nonionic|surfactant|lesco/i,
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

function productContextFor(app = {}, productContext = {}) {
  const byApplicationId = productContext.byApplicationId || {};
  const byProductName = productContext.byProductName || {};
  return byApplicationId[app.id]
    || byProductName[normalizeKey(productName(app))]
    || {};
}

function insightFor(app = {}, meta = {}) {
  const haystack = [
    productName(app),
    app.product?.active_ingredient,
    app.product?.activeIngredient,
    meta.active_ingredient,
    meta.activeIngredient,
    meta.name,
  ].join(' ');
  return PRODUCT_INSIGHTS.find((insight) => insight.match.test(haystack)) || null;
}

function activeIngredientFor(app = {}, meta = {}) {
  return cleanText(
    app.product?.active_ingredient
    || app.product?.activeIngredient
    || meta.active_ingredient
    || meta.activeIngredient
    || insightFor(app, meta)?.activeIngredient
  );
}

function epaRegFor(app = {}, meta = {}) {
  return cleanText(app.product?.epa_reg || app.product?.epaReg || meta.epa_reg_number || meta.epaRegNumber);
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

function rainfastText(meta = {}) {
  const minutes = Number(meta.rainfast_minutes ?? meta.rainfastMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `rainfast about ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `rainfast about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`;
}

function reiText(meta = {}) {
  const hours = Number(meta.rei_hours ?? meta.reiHours);
  if (!Number.isFinite(hours) || hours <= 0) return '';
  return `label REI ${hours} hr`;
}

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

function answerAppliedToday({ data = {}, productContext = {} } = {}) {
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
    const meta = productContextFor(app, productContext);
    const insight = insightFor(app, meta);
    const name = productName(app);
    const method = cleanText(app.methodLabel || reportEnumLabel(app.method));
    const area = cleanText(app.applicationArea || app.area);
    const targets = Array.isArray(app.targets) && app.targets.length
      ? `targets ${app.targets.map(reportEnumLabel).join(', ')}`
      : '';
    const active = activeIngredientFor(app, meta);
    const epa = epaRegFor(app, meta);
    const technical = compact([
      insight?.role,
      active ? `active ingredient: ${active}` : '',
      method,
      area ? `area: ${area}` : '',
      targets,
      rateText(app),
      rainfastText(meta),
      reiText(meta),
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
  const parts = [];
  if (Number(advisory.exterior_reentry_min) > 0) parts.push(`${advisory.exterior_reentry_min} min outside`);
  if (Number(advisory.interior_reentry_min) > 0) parts.push(`${advisory.interior_reentry_min} min inside`);
  const base = parts.length ? `Re-entry guidance: ${parts.join(', ')}.` : 'No re-entry timer was recorded for this report.';
  return `${base}${advisory.pet_advisory ? ` ${advisory.pet_advisory}` : ''}`;
}

function answerTrend({ data = {} } = {}) {
  const dynamic = data.dynamicContext || {};
  const lawnAssessment = data.lawnAssessment || null;
  if (lawnAssessment?.scores) {
    const scores = lawnAssessment.scores;
    return [
      lawnAssessment.snapshot?.summary,
      lawnAssessment.customerSummary,
      `Current lawn health is ${scores.overallScore}% overall.`,
      `Breakdown: density/coverage ${scores.turfDensity}%, weed cleanliness ${scores.weedSuppression}%, color/nutrients ${scores.colorHealth}%, stress/damage ${scores.stressDamage}%.`,
    ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' ');
  }
  return dynamic.pressureTrend?.customerSummary
    || `This visit's pressure index is ${customerVisiblePressureIndex(data.pressureIndex)?.toFixed(1) || '0.3'} on a 0-5 scale. Lower is better.`;
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

function answerNextAppointment({ nextAppointment } = {}) {
  if (!nextAppointment) {
    return 'I do not see another appointment scheduled yet. Reply to the text message or call Waves if you want us to set one up.';
  }
  const window = [nextAppointment.window_start, nextAppointment.window_end].filter(Boolean).map(serviceTimeText).join(' to ');
  return `Your next appointment is ${serviceDateText(nextAppointment.scheduled_date)} for ${nextAppointment.service_type || 'service'}${window ? `, window ${window}` : ''}.`;
}

function answerServiceReportQuestion({
  question,
  data,
  nextAppointment,
  productContext,
} = {}) {
  const q = String(question || '').toLowerCase();

  if (/\b(re-?enter|ready|pet|dog|cat|kid|child|outside|inside|irrigation)\b/.test(q)) {
    return answerReentry({ data });
  }

  if (/\b(pressure|trend|better|worse|score|index|improving|lawn|turf|weed|fungus|thatch)\b/.test(q)) {
    return answerTrend({ data });
  }

  if (/\b(treat|treated|product|application|spray|bait|chemical|applied)\b/.test(q)) {
    return answerAppliedToday({ data, productContext });
  }

  if (/\b(do|next step|recommend|recommendation|action|mulch|follow up|follow-up)\b/.test(q)) {
    return answerNextSteps({ data, nextAppointment });
  }

  if (/\b(next|upcoming|appointment|appt|schedule|scheduled|come back)\b/.test(q)) {
    return answerNextAppointment({ nextAppointment });
  }

  if (/\b(find|found|activity|issue|problem|clear|photo|map|where)\b/.test(q)) {
    return answerFindings({ data });
  }

  const summary = data?.dynamicContext?.aiSummary;
  if (summary?.headline || summary?.body) {
    return [summary.headline, summary.body].filter(Boolean).join(' ');
  }
  return 'This service is complete. You can review the treatment map, applications, findings, conditions, and customer advisory on this report.';
}

async function loadReportAssistantProductContext(data = {}, knex = db) {
  const applications = Array.isArray(data.applications) ? data.applications : [];
  const ids = unique(applications.map((app) => app.product?.catalogId || app.product?.catalog_id));
  const names = unique(applications.map(productName));
  if (!ids.length && !names.length) return { byApplicationId: {}, byProductName: {} };

  try {
    const rows = await knex('products_catalog')
      .where(function productLookup() {
        if (ids.length) this.whereIn('id', ids);
        if (names.length) this.orWhereIn('name', names);
      })
      .select(
        'id',
        'name',
        'active_ingredient',
        'epa_reg_number',
        'moa_group',
        'irac_group',
        'frac_group',
        'hrac_group',
        'formulation',
        'rainfast_minutes',
        'rei_hours',
        'reentry_text',
        'label_url',
        'sds_url',
        'label_source_note',
        'label_verified_at',
        'requires_surfactant',
        'allows_surfactant',
      );
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const byName = new Map(rows.map((row) => [normalizeKey(row.name), row]));
    return applications.reduce((ctx, app) => {
      const meta = byId.get(String(app.product?.catalogId || app.product?.catalog_id || ''))
        || byName.get(normalizeKey(productName(app)))
        || {};
      if (Object.keys(meta).length) {
        ctx.byApplicationId[app.id] = meta;
        ctx.byProductName[normalizeKey(productName(app))] = meta;
      }
      return ctx;
    }, { byApplicationId: {}, byProductName: {} });
  } catch {
    return { byApplicationId: {}, byProductName: {} };
  }
}

module.exports = {
  answerServiceReportQuestion,
  answerAppliedToday,
  answerNextSteps,
  loadReportAssistantProductContext,
};
