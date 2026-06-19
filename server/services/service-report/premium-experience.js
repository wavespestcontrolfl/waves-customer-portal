const crypto = require('crypto');
const db = require('../../models/db');
const { customerVisiblePressureIndex } = require('../pest-pressure/display');

const PROMPT_VERSION = 'service_report_premium_experience_v1';

const SEVERITY_RANK = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const FORBIDDEN_PATTERNS = [
  /\binfestation\b/i,
  /\beliminated\b/i,
  /\bguaranteed\b/i,
  /\bdangerous\b/i,
  /\btoxic\b/i,
  /\bpoison\b/i,
  /\bunsafe\b/i,
  /\bdeadly\b/i,
  /\bapocalypse\b/i,
  /\bwar zone\b/i,
];

const PEST_DOSSIERS = {
  ghost_ant: {
    label: 'Ghost ant',
    whyItMatters: 'Ghost ants often trail from mulch beds toward small gaps, door sweeps, and entry points.',
    customerFriendlyBehavior: 'They can appear in small trails and may follow edges or protected paths.',
  },
  ant: {
    label: 'Ant',
    whyItMatters: 'Ant activity often follows protected edges, moisture, mulch contact, or small entry gaps.',
    customerFriendlyBehavior: 'Light trailing can still appear around exterior edges after treatment.',
  },
  american_roach: {
    label: 'American roach',
    whyItMatters: 'American roaches are commonly associated with moisture, drains, landscape beds, and exterior harborage.',
    customerFriendlyBehavior: 'They are often managed by reducing exterior conditions that support activity.',
  },
  german_roach: {
    label: 'German roach',
    whyItMatters: 'German roach activity needs targeted monitoring because it is usually tied to interior food and moisture sources.',
    customerFriendlyBehavior: 'Follow-up and sanitation details matter when this pest is documented.',
  },
  spider: {
    label: 'Spider',
    whyItMatters: 'Spider activity often follows insect pressure, webs, lights, and protected exterior corners.',
    customerFriendlyBehavior: 'Web removal and exterior treatment help reduce recurring activity.',
  },
};

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatEnumLabel(value) {
  const key = normalizeKey(value);
  const special = {
    ghost_ant: 'ghost ants',
    american_roach: 'American roaches',
    german_roach: 'German roaches',
    fire_ant: 'fire ants',
    spider: 'spiders',
    perimeter_spray: 'Perimeter spray',
    bait_placement: 'Bait placement',
    spot_treatment: 'Spot treatment',
    pin_stream: 'Pin stream',
    broadcast_spray: 'Broadcast spray',
    granular_broadcast: 'Granular broadcast',
    fog_ulv: 'ULV fog',
  };
  if (special[key]) return special[key];
  return key.split('_').filter(Boolean).map((word, index) => (
    index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
  )).join(' ');
}

function severityRank(value) {
  return SEVERITY_RANK[normalizeKey(value)] || 0;
}

function compareFindingPriority(a, b) {
  const severityDelta = severityRank(b.severity) - severityRank(a.severity);
  if (severityDelta) return severityDelta;
  const categoryRank = {
    conducive_condition: 4,
    pest_activity: 3,
    damage: 2,
    observation: 1,
    no_activity: 0,
  };
  return (categoryRank[normalizeKey(b.category)] || 0) - (categoryRank[normalizeKey(a.category)] || 0);
}

function applicationMethod(product = {}, serviceLine = 'pest') {
  const raw = normalizeKey(product.application_method || product.method);
  if (raw && raw !== 'null') return raw;
  const category = normalizeKey(product.product_category);
  const name = normalizeKey(product.product_name);
  if (category.includes('bait') || name.includes('bait') || name.includes('gel')) return 'bait_placement';
  if (category.includes('fert') || category.includes('granular')) return 'granular_broadcast';
  if (serviceLine === 'mosquito') return 'fog_ulv';
  if (serviceLine === 'lawn') return category.includes('herb') ? 'spot_treatment' : 'broadcast_spray';
  if (serviceLine === 'palm' || serviceLine === 'tree_shrub') return 'foliar_spray';
  return 'perimeter_spray';
}

function normalizeApplication(product = {}, record = {}) {
  const method = applicationMethod(product, record.service_line || 'pest');
  return {
    id: product.id,
    productName: cleanText(product.product_name) || 'Product application',
    method,
    methodLabel: formatEnumLabel(method),
    zoneIds: parseJsonArray(product.zone_ids).map(String),
    area: cleanText(product.application_area || product.area),
    targets: parseJsonArray(product.targets).map(normalizeKey).filter(Boolean),
    activeIngredient: cleanText(product.active_ingredient),
    epaReg: cleanText(product.epa_reg_number || product.epa_reg),
  };
}

function normalizeFinding(finding = {}) {
  return {
    id: finding.id,
    serviceRecordId: finding.service_record_id,
    zoneId: finding.zone_id,
    category: normalizeKey(finding.category),
    severity: normalizeKey(finding.severity) || 'info',
    title: cleanText(finding.title),
    detail: cleanText(finding.detail),
    recommendation: cleanText(finding.recommendation),
  };
}

async function loadPremiumRows(record, knex = db) {
  if (!record?.id) return { findings: [], applications: [], zones: [], visitRows: [] };
  const [findings, products, zones, visitRows] = await Promise.all([
    knex('service_findings')
      .where({ service_record_id: record.id })
      .select('id', 'service_record_id', 'category', 'severity', 'title', 'detail', 'recommendation', 'zone_id')
      .catch(() => []),
    knex('service_products')
      .where({ service_record_id: record.id })
      .catch(() => []),
    knex('property_zones')
      .where({ customer_id: record.customer_id, is_active: true })
      .select('id', 'letter', 'label', 'category')
      .catch(() => []),
    knex('service_records')
      .where({ customer_id: record.customer_id, status: 'completed' })
      .where(function sameServiceLine() {
        if (record.service_line) this.where({ service_line: record.service_line });
        else this.where({ service_type: record.service_type });
      })
      .select('id', 'pressure_index')
      .catch(() => []),
  ]);

  return {
    findings: findings.map(normalizeFinding),
    applications: products.map((product) => normalizeApplication(product, record)),
    zones: zones.map((zone) => ({
      id: String(zone.id),
      letter: cleanText(zone.letter),
      label: cleanText(zone.label),
      category: normalizeKey(zone.category),
    })),
    visitRows,
  };
}

function sourceBacked(text, sourceKeys) {
  return { text: cleanText(text), sourceKeys: sourceKeys.filter(Boolean) };
}

function highestPriorityRecommendation(findings = []) {
  return [...findings]
    .filter((finding) => finding.recommendation)
    .sort(compareFindingPriority)[0] || null;
}

function buildPrimaryMoveContext({ findings = [] } = {}) {
  const finding = highestPriorityRecommendation(findings);
  if (!finding) return undefined;
  return {
    title: finding.recommendation,
    why: finding.detail || finding.title,
    impact: finding.category === 'conducive_condition'
      ? 'This helps remove a condition that can support recurring activity.'
      : 'This helps reduce recurring activity at the documented service area.',
    sourceKeys: [`finding:${finding.id}`],
    findingId: finding.id,
    status: 'open',
    dueLabel: 'Before next service',
  };
}

function validateCustomerCopy(text) {
  const copy = cleanText(text);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(copy)) return false;
  }
  return true;
}

function buildAiSummaryPersonalityContext({
  aiSummary,
  pressureTrend,
  primaryMove,
  findings = [],
  applications = [],
  now = new Date(),
} = {}) {
  const inputHash = sha256(stableStringify({
    aiSummary,
    pressureTrend,
    primaryMove,
    findings: findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      detail: finding.detail,
      recommendation: finding.recommendation,
    })),
    applications: applications.map((app) => ({
      id: app.id,
      productName: app.productName,
      method: app.method,
      targets: app.targets,
    })),
  }));

  const mainFinding = [...findings].sort(compareFindingPriority)[0];
  const pressureLine = pressureTrend?.customerSummary || 'Service is complete.';
  const treatedLine = applications.length
    ? `We completed ${applications.map((app) => app.methodLabel.toLowerCase()).filter(Boolean).slice(0, 2).join(' and ')} for this visit.`
    : 'We documented today’s service and recommendations.';
  const findingLine = mainFinding
    ? `${mainFinding.title}${mainFinding.detail ? `. ${mainFinding.detail}` : ''}`
    : 'No material pest activity was documented today.';
  const moveLine = primaryMove?.title || 'Keep an eye on the areas documented in this report.';

  const variants = {
    straight: {
      mode: 'straight',
      headline: aiSummary?.headline || `Service is complete. ${pressureLine}`,
      body: aiSummary?.body || [findingLine, treatedLine].join(' '),
      bullets: [
        sourceBacked(pressureLine, ['pressure_trend']),
        primaryMove ? sourceBacked(`Recommended next step: ${primaryMove.title}`, primaryMove.sourceKeys) : null,
      ].filter(Boolean),
    },
    simple: {
      mode: 'simple',
      headline: pressureTrend?.direction === 'down'
        ? 'Good news: pressure is down.'
        : 'Today’s service is wrapped.',
      body: `${findingLine} ${treatedLine}`,
      bullets: [
        sourceBacked('Lower pressure is better.', ['pressure_trend']),
        primaryMove ? sourceBacked(moveLine, primaryMove.sourceKeys) : null,
      ].filter(Boolean),
    },
    unfiltered: {
      mode: 'unfiltered',
      headline: primaryMove
        ? 'Here is the straight shot.'
        : 'Nothing dramatic today.',
      body: primaryMove
        ? unfilteredBody(primaryMove, mainFinding)
        : 'The report is clean: keep watching the documented areas and text Waves if activity changes.',
      bullets: [
        primaryMove ? sourceBacked(moveLine, primaryMove.sourceKeys) : sourceBacked(pressureLine, ['pressure_trend']),
      ],
    },
  };

  for (const variant of Object.values(variants)) {
    const combined = [
      variant.headline,
      variant.body,
      ...variant.bullets.map((bullet) => bullet.text),
    ].join(' ');
    if (!validateCustomerCopy(combined)) {
      variant.headline = variants.straight.headline;
      variant.body = variants.straight.body;
      variant.bullets = variants.straight.bullets;
    }
  }

  return {
    defaultMode: 'straight',
    variants,
    generatedAt: now.toISOString(),
    inputHash,
    promptVersion: PROMPT_VERSION,
    generationMode: 'deterministic_fallback',
  };
}

function unfilteredBody(primaryMove, finding) {
  const text = `${primaryMove.title} ${finding?.title || ''} ${finding?.detail || ''}`.toLowerCase();
  if (text.includes('mulch')) {
    return 'The mulch is still helping activity reach the entry. Pull it back and the front door gets easier to protect.';
  }
  if (text.includes('moisture') || text.includes('water')) {
    return 'Moisture keeps pressure hanging around. Drying that area down gives the treatment plan a better shot.';
  }
  if (text.includes('gap') || text.includes('door')) {
    return 'That entry gap is doing you no favors. Closing it makes this spot easier to control.';
  }
  return `${primaryMove.title} This is the one move that gives today’s treatment more help between visits.`;
}

function buildPropertyDefenseStatusContext({ record, findings = [], applications = [], zones = [], pressureTrend } = {}) {
  const pressure = pressureTrend?.current?.pressureIndex ?? customerVisiblePressureIndex(record?.pressure_index);
  const activeMethods = new Set(applications.map((app) => app.method));
  const textByZone = new Map(zones.map((zone) => [zone.id, `${zone.letter} ${zone.label}`.toLowerCase()]));
  const findingText = findings.map((finding) => `${finding.title} ${finding.detail} ${textByZone.get(String(finding.zoneId)) || ''}`.toLowerCase());
  const hasFrontEntry = findingText.some((text) => text.includes('front') || text.includes('entry') || text.includes('threshold'));
  const hasLanaiActivity = findingText.some((text) => text.includes('lanai') && !text.includes('clear'));
  const hasPoolActivity = findingText.some((text) => text.includes('pool') && !text.includes('clear'));
  const highAction = findings.some((finding) => ['critical', 'high'].includes(finding.severity) && finding.recommendation);
  const anyRecommendation = findings.some((finding) => finding.recommendation);
  const lowPressure = Number.isFinite(pressure) && pressure < 2;
  const pressureLabel = Number.isFinite(pressure)
    ? `${pressure < 2 ? 'Low' : pressure < 3.5 ? 'Moderate' : 'Elevated'} · ${Number(pressure).toFixed(1)} / 5`
    : 'Tracking after more visits';

  const items = [
    {
      key: 'perimeter_shield',
      label: 'Perimeter shield',
      status: activeMethods.has('perimeter_spray') || activeMethods.has('broadcast_spray') ? 'active' : 'watched',
      detail: activeMethods.has('perimeter_spray') || activeMethods.has('broadcast_spray')
        ? 'Exterior protection was applied today.'
        : 'No perimeter application was logged today.',
      sourceKeys: applications.map((app) => `application:${app.id}`).slice(0, 3),
    },
    {
      key: 'front_entry',
      label: 'Front entry',
      status: hasFrontEntry ? 'watched' : 'clear',
      detail: hasFrontEntry ? 'Activity or a recommendation was documented near the entry.' : 'No active entry finding was documented.',
      sourceKeys: findings.filter((finding) => /front|entry|threshold/i.test(`${finding.title} ${finding.detail}`)).map((finding) => `finding:${finding.id}`),
    },
    {
      key: 'lanai',
      label: 'Lanai',
      status: hasLanaiActivity ? 'watched' : 'clear',
      detail: hasLanaiActivity ? 'Lanai activity was documented.' : 'No lanai activity was documented.',
      sourceKeys: findings.filter((finding) => /lanai/i.test(`${finding.title} ${finding.detail}`)).map((finding) => `finding:${finding.id}`),
    },
    {
      key: 'pool_equipment_pad',
      label: 'Pool equipment pad',
      status: hasPoolActivity ? 'watched' : 'clear',
      detail: hasPoolActivity ? 'Pool equipment area activity was documented.' : 'No pool equipment pad activity was documented.',
      sourceKeys: findings.filter((finding) => /pool/i.test(`${finding.title} ${finding.detail}`)).map((finding) => `finding:${finding.id}`),
    },
    {
      key: 'pressure',
      label: 'Pressure',
      status: lowPressure ? 'active' : 'watched',
      detail: pressureLabel,
      sourceKeys: ['pressure_trend'],
    },
  ];

  const overallLabel = highAction
    ? 'action_required'
    : anyRecommendation
      ? 'needs_attention'
      : lowPressure
        ? 'strong'
        : 'watch';

  return {
    overallLabel,
    summary: overallLabel === 'strong'
      ? 'Your property is in a strong position after this visit.'
      : overallLabel === 'needs_attention'
        ? 'One customer action would help strengthen the service plan.'
        : overallLabel === 'action_required'
          ? 'One recommendation needs attention to reduce recurring activity.'
          : 'Waves will keep watching the documented activity areas.',
    items,
  };
}

function pestKeysFromRows(findings = [], applications = []) {
  const found = new Set();
  for (const app of applications) {
    for (const target of app.targets || []) {
      const key = normalizeKey(target);
      if (PEST_DOSSIERS[key]) found.add(key);
      if (key.includes('ant')) found.add(key.includes('ghost') ? 'ghost_ant' : 'ant');
      if (key.includes('roach')) found.add(key.includes('german') ? 'german_roach' : 'american_roach');
      if (key.includes('spider')) found.add('spider');
    }
  }
  for (const finding of findings) {
    const text = `${finding.title} ${finding.detail}`.toLowerCase();
    if (text.includes('ghost ant')) found.add('ghost_ant');
    else if (text.includes('ant')) found.add('ant');
    if (text.includes('american roach') || text.includes('palmetto')) found.add('american_roach');
    if (text.includes('german roach')) found.add('german_roach');
    if (text.includes('spider')) found.add('spider');
  }
  return [...found].filter((key) => PEST_DOSSIERS[key]).slice(0, 3);
}

function buildBugFilesContext({ findings = [], applications = [], zones = [], primaryMove } = {}) {
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  return pestKeysFromRows(findings, applications).map((pestKey) => {
    const dossier = PEST_DOSSIERS[pestKey];
    const relatedFindings = findings.filter((finding) => {
      const text = normalizeKey(`${finding.title} ${finding.detail}`);
      return text.includes(pestKey) || (pestKey.includes('ant') && text.includes('ant')) || (pestKey.includes('roach') && text.includes('roach'));
    });
    const relatedApps = applications.filter((app) => (
      (app.targets || []).some((target) => target === pestKey || (pestKey.includes('ant') && target.includes('ant')))
    ));
    const firstFinding = relatedFindings[0];
    const zone = firstFinding?.zoneId ? zoneById.get(String(firstFinding.zoneId)) : null;
    const where = zone
      ? `${zone.letter} · ${zone.label}`
      : firstFinding?.title || 'Documented service area';

    return {
      pestKey,
      suspectLabel: dossier.label,
      likelyId: {
        label: dossier.label,
        confirmedByTech: Boolean(firstFinding),
      },
      whereSeen: sourceBacked(where, firstFinding ? [`finding:${firstFinding.id}`] : []),
      whyItMatters: sourceBacked(dossier.whyItMatters, ['pest_dossier']),
      whatWeDid: sourceBacked(
        relatedApps.length
          ? relatedApps.map((app) => `${app.methodLabel} with ${app.productName}`).join('; ')
          : dossier.customerFriendlyBehavior,
        relatedApps.map((app) => `application:${app.id}`),
      ),
      yourMove: primaryMove ? sourceBacked(primaryMove.title, primaryMove.sourceKeys) : undefined,
      findingIds: relatedFindings.map((finding) => finding.id),
      applicationIds: relatedApps.map((app) => app.id),
      zoneIds: [...new Set(relatedFindings.map((finding) => finding.zoneId).filter(Boolean))],
    };
  });
}

function buildWhyActivityContext({ findings = [], applications = [] } = {}) {
  const hasAnt = findings.some((finding) => /ant/i.test(`${finding.title} ${finding.detail}`))
    || applications.some((app) => (app.targets || []).some((target) => target.includes('ant')));
  const baitApps = applications.filter((app) => app.method === 'bait_placement');
  if (hasAnt && baitApps.length) {
    return {
      title: 'Why you might still see ants',
      body: 'Ant bait is designed to be carried back by the colony. Seeing light activity near a baited area for a short period can be normal.',
      whenToTextUs: 'Text us if activity increases, moves indoors, or continues after the expected service window.',
      sourceKeys: baitApps.map((app) => `application:${app.id}`),
      relatedApplicationIds: baitApps.map((app) => app.id),
    };
  }
  const perimeterApps = applications.filter((app) => ['perimeter_spray', 'broadcast_spray'].includes(app.method));
  if (perimeterApps.length) {
    return {
      title: 'Why you might see light activity outside',
      body: 'Exterior treatments are applied to reduce activity around entry-prone areas. Occasional outdoor activity can still appear while the treatment band is active.',
      whenToTextUs: 'Text us if activity increases or moves inside after the re-entry window.',
      sourceKeys: perimeterApps.map((app) => `application:${app.id}`),
      relatedApplicationIds: perimeterApps.map((app) => app.id),
    };
  }
  return undefined;
}

function formatWeatherFacts(conditions = {}) {
  const temp = conditions.temp_f ?? conditions.temp;
  const humidity = conditions.humidity_pct ?? conditions.humidity;
  const wind = conditions.wind_mph ?? conditions.wind;
  const rain = conditions.rain_24h_in;
  return [
    temp != null ? `${Math.round(Number(temp))}°F` : null,
    humidity != null ? `${Math.round(Number(humidity))}% humidity` : null,
    wind != null ? `${Number(wind)} mph wind` : null,
    rain != null ? `${Number(rain).toFixed(2)} in rain` : null,
  ].filter(Boolean).join(' · ');
}

function buildWeatherCallContext({ record } = {}) {
  const conditions = {
    ...parseJsonObject(record?.conditions),
    ...parseJsonObject(record?.weather_data),
  };
  if (!Object.keys(conditions).length) return undefined;
  const wind = Number(conditions.wind_mph ?? conditions.wind);
  const rain = Number(conditions.rain_24h_in);
  let headline = 'Weather call';
  let body = 'Conditions were documented at application time for this service record.';
  if (Number.isFinite(rain) && rain > 0.25) {
    headline = 'Recent rainfall noted.';
    body = 'Recent rainfall was considered during application decisions.';
  } else if (Number.isFinite(wind) && wind > 15) {
    headline = 'Wind was elevated.';
    body = 'Treatment decisions were adjusted to match label and site conditions.';
  } else if (Number.isFinite(wind) && wind > 10) {
    headline = 'Wind noted during service.';
    body = 'Wind was elevated, so application decisions were adjusted to site conditions.';
  } else if ((!Number.isFinite(rain) || rain <= 0.1) && (!Number.isFinite(wind) || wind <= 10)) {
    headline = 'Good treatment window.';
    body = 'Low rainfall and moderate wind supported exterior application.';
  }
  return {
    headline,
    body,
    factsLine: formatWeatherFacts(conditions),
    sourceLabel: cleanText(conditions.source),
    sourceKeys: ['condition'],
  };
}

function buildPressureReceiptContext({ pressureTrend, visitRows = [], findings = [], zones = [] } = {}) {
  const stats = [];
  if (pressureTrend?.points?.length >= 2 && pressureTrend.percentChange > 0 && pressureTrend.direction === 'down') {
    stats.push({
      label: 'Pressure down',
      value: `${pressureTrend.percentChange}%`,
      // Same recent-window baseline as pressure-trend.js — it's the oldest of
      // the last few visits, not the customer's first-ever reading.
      detail: 'Over your recent visits',
      sourceKeys: ['pressure_trend'],
    });
  }
  const visitCount = Math.max(visitRows.length, pressureTrend?.points?.length || 0);
  if (visitCount > 0) {
    stats.push({
      label: 'Visits completed',
      value: String(visitCount),
      sourceKeys: ['service_history'],
    });
  }
  if (zones.length) {
    stats.push({
      label: 'Zones tracked',
      value: String(zones.length),
      sourceKeys: ['property_zones'],
    });
  }
  const interiorToday = findings.some((finding) => /interior|inside|kitchen|bath|garage/i.test(`${finding.title} ${finding.detail}`));
  stats.push({
    label: 'Interior activity today',
    value: interiorToday ? 'Observed' : 'None documented',
    sourceKeys: findings.map((finding) => `finding:${finding.id}`).slice(0, 4),
  });
  if (!stats.length) return undefined;
  return {
    headline: 'Since starting WaveGuard',
    stats,
  };
}

async function buildPremiumExperienceContext({
  record,
  dynamicContext = {},
  now = new Date(),
  knex = db,
} = {}) {
  if (!record?.id) return undefined;
  const rows = await loadPremiumRows(record, knex);
  const primaryMove = buildPrimaryMoveContext({ findings: rows.findings });
  const aiSummaryPersonality = buildAiSummaryPersonalityContext({
    aiSummary: dynamicContext.aiSummary,
    pressureTrend: dynamicContext.pressureTrend,
    primaryMove,
    findings: rows.findings,
    applications: rows.applications,
    now,
  });
  const propertyDefenseStatus = buildPropertyDefenseStatusContext({
    record,
    findings: rows.findings,
    applications: rows.applications,
    zones: rows.zones,
    pressureTrend: dynamicContext.pressureTrend,
  });
  const bugFiles = buildBugFilesContext({
    findings: rows.findings,
    applications: rows.applications,
    zones: rows.zones,
    primaryMove,
  });
  const whyActivity = buildWhyActivityContext({
    findings: rows.findings,
    applications: rows.applications,
  });
  const weatherCall = buildWeatherCallContext({ record });
  const pressureReceipt = buildPressureReceiptContext({
    pressureTrend: dynamicContext.pressureTrend,
    visitRows: rows.visitRows,
    findings: rows.findings,
    zones: rows.zones,
  });

  return {
    aiSummaryPersonality,
    bugFiles,
    propertyDefenseStatus,
    primaryMove,
    whyActivity,
    weatherCall,
    pressureReceipt,
  };
}

module.exports = {
  buildPremiumExperienceContext,
  buildAiSummaryPersonalityContext,
  buildBugFilesContext,
  buildPremiumExperienceContextFromRows: ({
    record = {},
    findings = [],
    applications = [],
    zones = [],
    visitRows = [],
    dynamicContext = {},
    now = new Date(),
  } = {}) => {
    const normalizedFindings = findings.map(normalizeFinding);
    const normalizedApplications = applications.map((app) => ({
      id: app.id,
      productName: cleanText(app.productName || app.product_name) || 'Product application',
      method: normalizeKey(app.method || app.application_method) || 'perimeter_spray',
      methodLabel: formatEnumLabel(app.method || app.application_method || 'perimeter_spray'),
      zoneIds: parseJsonArray(app.zoneIds || app.zone_ids).map(String),
      area: cleanText(app.area || app.application_area),
      targets: (Array.isArray(app.targets) ? app.targets : parseJsonArray(app.targets)).map(normalizeKey).filter(Boolean),
    }));
    const normalizedZones = zones.map((zone) => ({
      id: String(zone.id),
      letter: cleanText(zone.letter),
      label: cleanText(zone.label),
      category: normalizeKey(zone.category),
    }));
    const primaryMove = buildPrimaryMoveContext({ findings: normalizedFindings });
    return {
      aiSummaryPersonality: buildAiSummaryPersonalityContext({
        aiSummary: dynamicContext.aiSummary,
        pressureTrend: dynamicContext.pressureTrend,
        primaryMove,
        findings: normalizedFindings,
        applications: normalizedApplications,
        now,
      }),
      primaryMove,
      propertyDefenseStatus: buildPropertyDefenseStatusContext({
        record,
        findings: normalizedFindings,
        applications: normalizedApplications,
        zones: normalizedZones,
        pressureTrend: dynamicContext.pressureTrend,
      }),
      bugFiles: buildBugFilesContext({
        findings: normalizedFindings,
        applications: normalizedApplications,
        zones: normalizedZones,
        primaryMove,
      }),
      whyActivity: buildWhyActivityContext({
        findings: normalizedFindings,
        applications: normalizedApplications,
      }),
      weatherCall: buildWeatherCallContext({ record }),
      pressureReceipt: buildPressureReceiptContext({
        pressureTrend: dynamicContext.pressureTrend,
        visitRows,
        findings: normalizedFindings,
        zones: normalizedZones,
      }),
    };
  },
  buildPrimaryMoveContext,
  buildPropertyDefenseStatusContext,
  buildWeatherCallContext,
  buildWhyActivityContext,
  formatEnumLabel,
  validateCustomerCopy,
};
