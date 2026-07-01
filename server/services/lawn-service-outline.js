const crypto = require('crypto');
const protocols = require('../config/protocols.json');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TEMPLATE_VERSION = 'mvp-1';
const CONTENT_LIBRARY_VERSION = 'seed-v1';
const PRODUCT_REGISTRY_VERSION = 'public-facts-v1';
const PROTOCOL_VERSION = 'lawn-v4';
const LAWN_SERVICE_TIME_ZONE = 'America/New_York';

const BANNED_PHRASES = [
  'safe for pets',
  'safe for kids',
  'safe for children',
  'guaranteed green lawn',
  'kills all bugs',
  'eliminates weeds permanently',
  'always applied',
  'non-toxic',
  'nontoxic',
  'chemical-free',
  'harmless',
  'no risk',
  'epa approved',
  'organic',
  'pesticide-free',
  'will be applied',
  'guaranteed results',
  'permanent solution',
  'one-time fix',
  'no need to water',
  'no follow-up needed',
];

const TURF_LABELS = {
  st_augustine: 'St. Augustine',
  bermuda: 'Bermuda',
  zoysia: 'Zoysia',
  bahia: 'Bahia',
  mixed: 'Mixed turf',
  unknown: 'Unknown turf',
};

const TURF_MODULE_KEYS = {
  st_augustine: 'st_augustine_protocol_summary',
  bermuda: 'bermuda_protocol_summary',
  zoysia: 'zoysia_protocol_summary',
  bahia: 'bahia_protocol_summary',
  mixed: 'mixed_turf_summary',
  unknown: 'unknown_turf_summary',
};

const SEASON_MODULE_KEYS = {
  jan_mar: 'season_jan_mar',
  apr_may: 'season_apr_may',
  jun_sep: 'season_jun_sep',
  oct_dec: 'season_oct_dec',
};

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizeTurfType(value) {
  const raw = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!raw) return 'unknown';
  if (raw.includes('mixed') || raw.includes('multiple')) return 'mixed';
  if (raw.includes('augustine') || raw.includes('st aug') || raw.includes('staug')) return 'st_augustine';
  if (raw.includes('bermuda')) return 'bermuda';
  if (raw.includes('zoysia') || raw.includes('zoysiagrass')) return 'zoysia';
  if (raw.includes('bahia')) return 'bahia';
  return 'unknown';
}

function detectTurfFromObject(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = firstNonEmpty(
    data.turfType,
    data.turf_type,
    data.grassType,
    data.grass_type,
    data.lawnTurfType,
    data.lawn?.turfType,
    data.lawn?.grassType,
    data.property?.turfType,
    data.property?.grassType,
  );
  if (direct) return direct;

  const haystack = JSON.stringify(data).toLowerCase();
  if (haystack.includes('st. augustine') || haystack.includes('st augustine')) return 'St. Augustine';
  if (haystack.includes('bermuda')) return 'Bermuda';
  if (haystack.includes('zoysia')) return 'Zoysia';
  if (haystack.includes('bahia')) return 'Bahia';
  return '';
}

function resolveSeasonBand(month) {
  const m = Number(month);
  if ([1, 2, 3].includes(m)) return 'jan_mar';
  if ([4, 5].includes(m)) return 'apr_may';
  if ([6, 7, 8, 9].includes(m)) return 'jun_sep';
  return 'oct_dec';
}

function currentMonthNumber(date = new Date(), timeZone = LAWN_SERVICE_TIME_ZONE) {
  const value = date instanceof Date ? date : new Date(date);
  const resolvedDate = Number.isNaN(value.getTime()) ? new Date() : value;
  try {
    const month = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
    }).format(resolvedDate);
    const numericMonth = Number(month);
    if (Number.isInteger(numericMonth) && numericMonth >= 1 && numericMonth <= 12) return numericMonth;
  } catch {
    // Fall through to the runtime local month if Intl time-zone resolution fails.
  }
  return resolvedDate.getMonth() + 1;
}

function estimateHasLawnService(estimate = {}, estimateData = {}) {
  const fields = [
    estimate.service_interest,
    estimate.serviceInterest,
    estimate.notes,
    estimate.description,
    estimateData.serviceInterest,
    estimateData.service_interest,
    estimateData.serviceLine,
    estimateData.service_line,
    estimateData.serviceType,
  ];
  const serviceLines = [
    ...(Array.isArray(estimate.serviceLines) ? estimate.serviceLines : []),
    ...(Array.isArray(estimate.service_lines) ? estimate.service_lines : []),
    ...(Array.isArray(estimateData.serviceLines) ? estimateData.serviceLines : []),
    ...(Array.isArray(estimateData.service_lines) ? estimateData.service_lines : []),
  ];
  return [...fields, ...serviceLines].some((value) => {
    const s = String(value || '').toLowerCase();
    return s.includes('lawn') || s.includes('turf');
  });
}

function resolveTurf({ estimate = {}, estimateData = {}, input = {} }) {
  const source = firstNonEmpty(
    input.turfType,
    input.turf_type,
    estimate.turf_type,
    estimate.turfType,
    detectTurfFromObject(estimateData),
    estimate.notes,
    estimate.description,
  );
  const turfType = normalizeTurfType(source);
  return {
    turfType,
    label: TURF_LABELS[turfType] || TURF_LABELS.unknown,
    confidence: turfType === 'unknown' ? 'unknown' : source ? 'inferred' : 'unknown',
    mixed: turfType === 'mixed',
  };
}

function resolveJurisdictionId(address) {
  const a = String(address || '').toLowerCase();
  if (/(sarasota|venice|north port|nokomis|osprey|englewood)/.test(a)) return 'sarasota_county_fl';
  if (/(manatee|bradenton|palmetto|parrish|lakewood ranch|ellenton|anna maria)/.test(a)) return 'manatee_county_fl';
  if (/(charlotte|port charlotte|punta gorda|rotunda)/.test(a)) return 'charlotte_county_fl';
  return 'generic_swfl';
}

function isRestrictedSeason(rule, month) {
  if (!rule?.restricted_start_month || !rule?.restricted_end_month) return false;
  const start = Number(rule.restricted_start_month);
  const end = Number(rule.restricted_end_month);
  const m = Number(month);
  if (start <= end) return m >= start && m <= end;
  return m >= start || m <= end;
}

function sanitizeProtocolLine(line) {
  return String(line || '')
    .replace(/\([^)]*\$[^)]*\)/g, '')
    .replace(/[★⚠]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function protocolLines(text) {
  return String(text || '')
    .split('\n')
    .map(sanitizeProtocolLine)
    .filter(Boolean);
}

function customerProtocolBullets(visit) {
  if (!visit) return [];
  const lines = [...protocolLines(visit.primary), ...protocolLines(visit.secondary)];
  return lines
    .filter((line) => !/material|labor|cost/i.test(line))
    .slice(0, 8)
    .map((line) => `${line} may be relevant when turf condition, weather, label directions, and local rules allow.`);
}

function protocolVisitForMonth(turfType, month) {
  const track = protocols.lawn?.[turfType];
  if (!track) return null;
  const monthName = MONTHS[Number(month) - 1];
  return (track.visits || []).find((visit) => String(visit.month || '').toLowerCase() === monthName.toLowerCase()) || null;
}

function protocolTrack(turfType) {
  return protocols.lawn?.[turfType] || null;
}

async function loadApprovedModules(db) {
  const rows = await db('lawn_service_content_modules')
    .where({ status: 'approved' })
    .where(function () {
      this.whereNull('valid_to').orWhere('valid_to', '>', db.fn.now());
    })
    .orderBy('version', 'desc');
  const modules = {};
  for (const row of rows) {
    if (!modules[row.key]) modules[row.key] = row;
  }
  return modules;
}

async function loadFertilizerRule(db, jurisdictionId) {
  if (jurisdictionId === 'generic_swfl') {
    return {
      jurisdiction_id: 'generic_swfl',
      jurisdiction_name: 'Southwest Florida service area',
      version: 'generic-2026-05-30',
      public_summary: 'Local fertilizer rules may affect nitrogen or phosphorus applications during certain months.',
      nitrogen_restricted: true,
      phosphorus_restricted: true,
      phosphorus_soil_test_required: true,
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
    };
  }
  return db('jurisdiction_fertilizer_rules')
    .where({ jurisdiction_id: jurisdictionId, status: 'approved' })
    .orderBy('version', 'desc')
    .first();
}

function approvedModuleText(modules, key, fallback = '') {
  return modules[key]?.plain_text || fallback;
}

function estimateSnapshot(estimate = {}, estimateData = {}) {
  return {
    id: estimate.id || null,
    customerName: estimate.customer_name || estimate.customerName || null,
    customerId: estimate.customer_id || estimate.customerId || null,
    leadId: estimate.lead_id || estimate.leadId || null,
    address: estimate.address || null,
    customerPhone: estimate.customer_phone || estimate.customerPhone || null,
    customerEmail: estimate.customer_email || estimate.customerEmail || null,
    monthlyTotal: estimate.monthly_total || estimate.monthlyTotal || null,
    oneTimeTotal: estimate.onetime_total || estimate.onetimeTotal || null,
    tier: estimate.waveguard_tier || estimate.tier || estimateData.tier || null,
    serviceInterest: estimate.service_interest || estimate.serviceInterest || estimateData.serviceInterest || null,
    token: estimate.token || null,
  };
}

function addressSummary(address) {
  const parts = String(address || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 2).join(', ');
  return parts[0] || 'Service property';
}

function estimateViewPath(estimate) {
  if (!estimate?.token) return null;
  return `/estimate/${encodeURIComponent(estimate.token)}`;
}

function makeSection(key, title, body, bullets = []) {
  return {
    key,
    title,
    body,
    bullets: bullets.filter(Boolean),
  };
}

function turfPriorities(turfType) {
  if (turfType === 'st_augustine') {
    return [
      'Density and color support',
      'Chinch bug scouting',
      'Weed and sedge pressure monitoring',
      'Disease, irrigation, heat, shade, and thatch observations',
      'Soil-test-gated fertility decisions',
    ];
  }
  if (turfType === 'bermuda') {
    return [
      'Active growth and density management',
      'Seasonal nitrogen planning',
      'Armyworm and mole cricket scouting',
      'Disease risk review and winter dormancy expectations',
      'Growth-regulator documentation where used',
    ];
  }
  if (turfType === 'zoysia') {
    return [
      'Conservative fertility and growth stimulation',
      'Large patch monitoring and prevention',
      'Irrigation control and overwatering observations',
      'Thatch monitoring',
      'Weed control without over-stressing turf',
    ];
  }
  if (turfType === 'bahia') {
    return [
      'Realistic improvement for low-input turf',
      'Irrigated versus non-irrigated classification',
      'Mole cricket monitoring',
      'Weed reduction',
      'Seed head and dormancy expectations',
    ];
  }
  if (turfType === 'mixed') {
    return [
      'Confirm turf zones before product-specific decisions',
      'Avoid product assumptions that fit one turf but not another',
      'Document shaded, non-irrigated, high-traffic, or new-sod areas',
    ];
  }
  return [
    'Confirm grass type during the first lawn assessment',
    'Document irrigation, weed pressure, pest pressure, disease indicators, and stress',
    'Hold turf-specific product details until the lawn type is confirmed',
  ];
}

function buildTreatmentCategories({ turfType, visit, seasonBand }) {
  const base = [
    { label: 'Lawn assessment', reason: 'Technician observations decide what the lawn actually needs.' },
    { label: 'Weed and sedge management', reason: 'Used when turf type, weed pressure, temperature, and label directions allow.' },
    { label: 'Pest scouting', reason: 'The target pest changes by turf type, season, and symptoms.' },
    { label: 'Iron, micronutrients, and stress support', reason: 'Supports color and turf health without always pushing growth.' },
    { label: 'Post-service reporting', reason: 'The report shows what was actually done and any customer action items.' },
  ];
  if (['jan_mar', 'apr_may'].includes(seasonBand)) {
    base.splice(1, 0, { label: 'Prevention and spring preparation', reason: 'Seasonal timing helps reduce preventable weed and pest problems.' });
  }
  if (seasonBand === 'jun_sep') {
    base.splice(1, 0, { label: 'Summer stress strategy', reason: 'Summer visits often avoid unnecessary growth pushing and focus on stress and pest pressure.' });
  }
  if (seasonBand === 'oct_dec') {
    base.splice(1, 0, { label: 'Recovery and winter preparation', reason: 'Fall and winter visits may focus on recovery, disease risk, potassium, magnesium, and dormancy expectations.' });
  }
  if (turfType === 'st_augustine') base.push({ label: 'Chinch bug and large patch checks', reason: 'St. Augustine can be vulnerable to insect and disease pressure in Southwest Florida.' });
  if (turfType === 'bermuda') base.push({ label: 'Growth response and armyworm checks', reason: 'Bermuda is a higher-input turf that benefits from active monitoring.' });
  if (turfType === 'zoysia') base.push({ label: 'Large patch and thatch monitoring', reason: 'Zoysia is managed conservatively to avoid creating disease and thatch pressure.' });
  if (turfType === 'bahia') base.push({ label: 'Mole cricket and expectation management', reason: 'Bahia is low-input turf; pest monitoring and realistic expectations matter.' });
  if (visit) {
    base.push({ label: `${visit.month} protocol context`, reason: 'The current visit window shapes what may be inspected, held, or applied.' });
  }
  return base;
}

function productNeedlesFromVisit(visit) {
  const text = `${visit?.primary || ''}\n${visit?.secondary || ''}`;
  const names = new Set();
  for (const line of protocolLines(text)) {
    const cleaned = line
      .replace(/^if\s+/i, '')
      .replace(/^or\s+/i, '')
      .replace(/^blackout\s*[-:]\s*/i, '')
      .replace(/^premium:\s*/i, '')
      .trim();
    const candidate = cleaned.split(/ if | — | - |:| broadleaf| preventive| fert| fertilizer| foliar| liquid| scout| check| audit/i)[0].trim();
    if (candidate && candidate.length >= 4 && !/^(soil sample|all tiers|customer|pre-position|dormancy|no atrazine|speedzone safe)$/i.test(candidate)) {
      names.add(candidate);
    }
  }
  return [...names];
}

async function loadEligibleProductCards(db, { turfType, visit, includeProductCards }) {
  if (!includeProductCards || !visit || ['unknown', 'mixed'].includes(turfType)) return [];
  const needles = productNeedlesFromVisit(visit);
  if (!needles.length) return [];

  const rows = await db('products_catalog')
    .where('approved_for_estimate_packet', true)
    .whereIn('customer_visibility', ['public', 'portal_only'])
    .whereIn('content_status', ['approved_for_public', 'approved_for_portal', 'approved'])
    .select(
      'id',
      'name',
      'category',
      'product_type',
      'active_ingredient',
      'epa_reg_number',
      'fertilizer_analysis',
      'public_summary',
      'portal_summary',
      'customer_safety_summary',
      'customer_precaution_summary',
      'pet_kid_guidance_text',
      'reentry_text',
      'reentry_summary',
      'label_verified_at',
      'label_version',
      'review_due_at',
      'content_status',
      'approved_for_estimate_packet',
    )
    .limit(250);

  const cards = [];
  for (const row of rows) {
    const rowName = String(row.name || '').toLowerCase();
    const match = needles.find((needle) => {
      const n = String(needle || '').toLowerCase();
      return n.length >= 4 && (rowName.includes(n) || n.includes(rowName));
    });
    if (!match) continue;
    const category = String(row.category || '').toLowerCase();
    const productType = row.product_type
      || (/(herbicide|insecticide|fungicide|pgr|growth)/.test(category) ? 'pesticide' : category || 'other');
    const epaNumber = String(row.epa_reg_number || '').trim();
    if (productType === 'pesticide' && (!epaNumber || /^(n\/a|not epa|none)$/i.test(epaNumber))) continue;
    cards.push({
      id: row.id,
      name: row.name,
      category: row.category || 'Lawn care product',
      productType,
      activeIngredient: row.active_ingredient || null,
      epaRegistrationNumber: productType === 'pesticide' ? epaNumber : null,
      fertilizerAnalysis: row.fertilizer_analysis || null,
      summary: row.public_summary || row.portal_summary || 'This product may be used when site conditions, turf type, season, label directions, and local rules allow.',
      precaution: row.customer_precaution_summary || row.customer_safety_summary || row.pet_kid_guidance_text || null,
      reentry: row.reentry_summary || row.reentry_text || null,
      labelVerifiedAt: row.label_verified_at || null,
      labelVersion: row.label_version || null,
      relevanceReason: `${row.name} appears in the ${visit.month} ${TURF_LABELS[turfType]} protocol as a conditional or seasonal option.`,
    });
    if (cards.length >= 8) break;
  }
  return cards;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderOutlineHtml(content) {
  const sections = (content.sections || []).map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      <p>${escapeHtml(section.body)}</p>
      ${(section.bullets || []).length ? `<ul>${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
    </section>
  `).join('');
  return `
    <article class="service-outline-packet">
      <h1>${escapeHtml(content.title)}</h1>
      <p>${escapeHtml(content.intro)}</p>
      ${sections}
    </article>
  `;
}

function validateContent(content, { turfType, includeProductCards, jurisdictionRule }) {
  const text = JSON.stringify(content).toLowerCase();
  const errors = [];
  const warnings = [];
  for (const phrase of BANNED_PHRASES) {
    if (text.includes(phrase)) errors.push(`Banned phrase detected: ${phrase}`);
  }
  if (includeProductCards && ['unknown', 'mixed'].includes(turfType)) {
    errors.push('Product cards cannot be sent until turf type is confirmed for unknown or mixed turf.');
  }
  if (!jurisdictionRule?.jurisdiction_id) {
    errors.push('Local fertilizer rule could not be resolved.');
  }
  for (const card of content.productCards || []) {
    if (card.productType === 'pesticide' && !card.epaRegistrationNumber) {
      errors.push(`${card.name} is missing an EPA registration number.`);
    }
    if (!card.summary) errors.push(`${card.name} is missing approved customer summary copy.`);
    if (!card.labelVerifiedAt && card.productType === 'pesticide') {
      warnings.push(`${card.name} has no label verification date.`);
    }
  }
  if (!(content.sections || []).length) errors.push('Packet has no content sections.');
  return {
    status: errors.length ? 'blocked' : warnings.length ? 'warning' : 'passed',
    errors,
    warnings,
  };
}

function createPublicToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashNullable(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function buildOutline({ db, estimate, input = {}, now = new Date() }) {
  const estimateData = parseJsonMaybe(estimate.estimate_data || estimate.estimateData) || {};
  const month = Number(input.month || currentMonthNumber(now));
  const seasonBand = resolveSeasonBand(month);
  const modules = await loadApprovedModules(db);
  const turf = resolveTurf({ estimate, estimateData, input });
  const jurisdictionId = input.jurisdictionId || resolveJurisdictionId(estimate.address);
  const jurisdictionRule = await loadFertilizerRule(db, jurisdictionId);
  const restrictedSeasonActive = isRestrictedSeason(jurisdictionRule, month);
  const track = protocolTrack(turf.turfType);
  const visit = protocolVisitForMonth(turf.turfType, month);
  const includeProductCards = input.includeProductCards === true;
  const productCards = await loadEligibleProductCards(db, { turfType: turf.turfType, visit, includeProductCards });
  const seasonText = approvedModuleText(modules, SEASON_MODULE_KEYS[seasonBand]);
  const turfText = approvedModuleText(modules, TURF_MODULE_KEYS[turf.turfType], approvedModuleText(modules, 'unknown_turf_summary'));
  const snapshot = estimateSnapshot(estimate, estimateData);
  const customerName = firstNonEmpty(snapshot.customerName, 'your property');
  const tier = firstNonEmpty(input.serviceTier, snapshot.tier, estimateData.serviceTier, 'lawn care');

  const sections = [
    makeSection(
      'property_summary',
      'Property Summary',
      `This outline is based on the current lawn estimate for ${customerName}. Treatment decisions are finalized by turf condition, weather, product labels, and local rules at the time of service.`,
      [
        `Service area: ${addressSummary(snapshot.address)}`,
        `Service tier: ${tier}`,
        `Turf type: ${turf.label}`,
      ],
    ),
    makeSection('your_turf_type', `Your Turf Type: ${turf.label}`, turfText, turfPriorities(turf.turfType)),
    makeSection('season_focus', `${MONTHS[month - 1]} Service Focus`, seasonText, visit ? customerProtocolBullets(visit) : []),
    makeSection(
      'typical_visit',
      'What A Typical Visit Includes',
      approvedModuleText(modules, 'assessment_protocol'),
      [
        'Lawn condition assessment before application decisions',
        'Weed, sedge, insect, disease, irrigation, mowing, shade, heat, and drought observations',
        'Treatment decisions adjusted to turf type and current conditions',
        'Customer notes and follow-up items when the lawn needs action outside the treatment itself',
      ],
    ),
    makeSection(
      'treatment_categories',
      'Products Or Treatment Categories That May Be Relevant',
      approvedModuleText(modules, 'product_transparency'),
      buildTreatmentCategories({ turfType: turf.turfType, visit, seasonBand }).map((item) => `${item.label}: ${item.reason}`),
    ),
    makeSection(
      'local_rules',
      'Local Fertilizer-Rule Note',
      approvedModuleText(modules, 'local_fertilizer_rules'),
      [
        jurisdictionRule?.jurisdiction_name ? `Rule area: ${jurisdictionRule.jurisdiction_name}` : 'Rule area: to be confirmed',
        restrictedSeasonActive ? 'Restricted-season logic is active for this month.' : 'Restricted-season logic is not active for this month.',
        jurisdictionRule?.public_summary || 'Local fertilizer rules may affect what nutrient products can be used.',
      ],
    ),
    makeSection(
      'safety',
      'Safety And Product Transparency',
      approvedModuleText(modules, 'safety_and_label_compliance'),
      [
        'After a treatment, follow the technician service report and any product-specific instructions.',
        'As a general precaution, people and pets should stay off treated areas until the application has dried, unless the label or technician instructions require longer.',
        'Fertilizers, soil amendments, wetting agents, and biostimulants may not have EPA registration numbers because they are not pesticide products.',
      ],
    ),
    makeSection(
      'post_service_reports',
      'Post-Service Reports',
      approvedModuleText(modules, 'post_service_reports'),
      [
        'Service date, technician, service type, and areas serviced',
        'Products actually applied, including EPA registration numbers where applicable',
        'Photos, lawn observations, technician notes, what to expect, and customer action items',
      ],
    ),
    makeSection(
      'portal_tracking',
      'Portal, Reminders, And GPS-Tracked Service History',
      [
        approvedModuleText(modules, 'gps_tracking'),
        approvedModuleText(modules, 'service_reminders'),
        approvedModuleText(modules, 'customer_portal'),
      ].join(' '),
      [
        'Upcoming-visit and completed-service reminders',
        'Customer portal history for reports, photos, invoices, recommendations, and communication',
        'GPS-tracked service history for accountability and service review',
      ],
    ),
    makeSection('not_included', 'What This Does Not Include', approvedModuleText(modules, 'what_this_does_not_include')),
  ];

  if (turf.turfType === 'unknown') {
    sections.splice(3, 0, makeSection(
      'limited_outline',
      'Limited Outline Until Turf Is Confirmed',
      approvedModuleText(modules, 'unknown_turf_summary'),
      ['Product-specific recommendations are intentionally hidden until the first lawn assessment confirms the turf type.'],
    ));
  }

  if (turf.turfType === 'mixed') {
    sections.splice(3, 0, makeSection(
      'mixed_turf_caution',
      'Mixed Turf Requires Confirmation',
      approvedModuleText(modules, 'mixed_turf_summary'),
      ['Admin confirmation is required before product-specific details are shown.'],
    ));
  }

  const content = {
    title: `Your Waves Lawn Care Program Overview for ${turf.label}`,
    intro: 'Based on your estimate, this outline explains how Waves approaches your lawn care program, what we assess each visit, why treatments change by season, and how your service is documented.',
    generatedAt: now.toISOString(),
    detailLevel: input.detailLevel || 'standard',
    property: {
      customerName: snapshot.customerName,
      addressSummary: addressSummary(snapshot.address),
      turfType: turf.label,
      serviceTier: tier,
    },
    turf: {
      type: turf.turfType,
      label: turf.label,
      confidence: turf.confidence,
      mixed: turf.mixed,
      protocolTrackName: track?.name || null,
    },
    season: {
      month,
      monthName: MONTHS[month - 1],
      seasonBand,
      restrictedSeasonActive,
    },
    localRule: {
      jurisdictionId: jurisdictionRule?.jurisdiction_id || jurisdictionId,
      jurisdictionName: jurisdictionRule?.jurisdiction_name || null,
      version: jurisdictionRule?.version || null,
      summary: jurisdictionRule?.public_summary || null,
      restrictedSeasonActive,
    },
    sections,
    treatmentCategories: buildTreatmentCategories({ turfType: turf.turfType, visit, seasonBand }),
    productCards,
    cta: {
      label: snapshot.token ? 'View Estimate' : 'Request Callback',
      estimatePath: estimateViewPath(snapshot),
    },
  };

  const validation = validateContent(content, { turfType: turf.turfType, includeProductCards, jurisdictionRule });

  return {
    estimateData,
    estimateSnapshot: snapshot,
    inputSnapshot: {
      ...input,
      month,
      seasonBand,
      jurisdictionId,
      includeProductCards,
      includeProductCategories: input.includeProductCategories !== false,
    },
    summary: {
      title: content.title,
      turfType: turf.turfType,
      turfLabel: turf.label,
      seasonBand,
      month,
      jurisdictionId: jurisdictionRule?.jurisdiction_id || jurisdictionId,
      restrictedSeasonActive,
      productCardCount: productCards.length,
      validationStatus: validation.status,
      serviceLineDetected: estimateHasLawnService(estimate, estimateData),
    },
    content,
    contentHtml: renderOutlineHtml(content),
    validation,
    meta: {
      turf,
      track,
      visit,
      jurisdictionRule,
      templateVersion: TEMPLATE_VERSION,
      contentLibraryVersion: CONTENT_LIBRARY_VERSION,
      productRegistryVersion: PRODUCT_REGISTRY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    },
  };
}

module.exports = {
  BANNED_PHRASES,
  CONTENT_LIBRARY_VERSION,
  PRODUCT_REGISTRY_VERSION,
  PROTOCOL_VERSION,
  TEMPLATE_VERSION,
  buildOutline,
  createPublicToken,
  currentMonthNumber,
  estimateHasLawnService,
  hashNullable,
  hashToken,
  normalizeTurfType,
  renderOutlineHtml,
  resolveJurisdictionId,
  resolveSeasonBand,
  validateContent,
};
