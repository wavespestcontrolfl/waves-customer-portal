const db = require('../models/db');
const protocols = require('../config/protocols.json');
const { etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TRACK_BY_GRASS = {
  st_augustine: 'st_augustine',
  bermuda: 'bermuda',
  zoysia: 'zoysia',
  bahia: 'bahia',
};

function toServiceDate(value, fallback = new Date()) {
  const dateOnly = value
    ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10)
    : etDateString(fallback);
  const parsed = parseETDateTime(`${dateOnly}T12:00`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function monthDayValue(month, day) {
  if (!month || !day) return null;
  return Number(month) * 100 + Number(day);
}

function dateMonthDayValue(date) {
  const et = etParts(date);
  return et.month * 100 + et.day;
}

function isDateInWindow(date, rule) {
  const start = monthDayValue(rule.restricted_start_month, rule.restricted_start_day);
  const end = monthDayValue(rule.restricted_end_month, rule.restricted_end_day);
  if (!start || !end) return false;
  const current = dateMonthDayValue(date);
  return start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
}

function parseMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeProtocolProductText(value) {
  return normalizeText(
    String(value || '')
      .replace(/\([^)]*\$[^)]*\)/g, ' ')
      .replace(/^[★⚠\s-]+/g, ' ')
      .replace(/\bblackout\b/ig, ' ')
      .replace(/\bweather gated\b/ig, ' ')
  );
}

function productAliases(name) {
  const normalized = normalizeText(name);
  const tokens = normalized.split(' ').filter(Boolean);
  const withoutVendor = tokens.length > 1 ? tokens.slice(1) : tokens;
  const withoutVendorAndNpk = withoutVendor.filter((token) => !/^\d+$/.test(token));
  return [
    normalized,
    withoutVendor.join(' '),
    withoutVendorAndNpk.join(' '),
    tokens.filter((token) => !/^\d+$/.test(token)).join(' '),
  ].filter((alias, index, arr) => alias && alias.length > 5 && arr.indexOf(alias) === index);
}

function parseProtocolLines(text, role) {
  if (!text) return [];
  return String(text)
    .split('\n')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({
      raw,
      role,
      conditional: role !== 'base' || /^if\b/i.test(raw) || /\bif\b/i.test(raw),
      product: null,
    }));
}

function matchCatalogProduct(line, products) {
  const normalizedLine = normalizeProtocolProductText(line.raw);
  if (!normalizedLine) return null;

  const candidates = products
    .map((product) => {
      const name = normalizeText(product.name);
      if (!name) return null;
      const aliases = productAliases(product.name);
      const direct = aliases.some((alias) => normalizedLine.includes(alias));
      const reverse = aliases.some((alias) => alias.includes(normalizedLine));
      const firstTwo = name.split(' ').slice(0, 2).join(' ');
      const tokenMatch = firstTwo.length > 5 && normalizedLine.includes(firstTwo);
      if (!direct && !reverse && !tokenMatch) return null;
      return { product, score: name.length + (direct ? 100 : 0) + (tokenMatch ? 20 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.product || null;
}

function productHasNitrogen(product) {
  return Number(product?.analysis_n || 0) > 0;
}

function productHasPhosphorus(product) {
  return Number(product?.analysis_p || 0) > 0;
}

function parseNpkFromText(value) {
  const match = String(value || '').match(/\b(\d{1,2})-(\d{1,2})-(\d{1,2})\b/);
  if (!match) return null;
  return {
    n: Number(match[1]),
    p: Number(match[2]),
    k: Number(match[3]),
  };
}

function itemHasNitrogen(item) {
  if (item.product) return productHasNitrogen(item.product);
  const npk = parseNpkFromText(item.raw);
  return Number(npk?.n || 0) > 0;
}

function itemHasPhosphorus(item) {
  if (item.product) return productHasPhosphorus(item.product);
  const npk = parseNpkFromText(item.raw);
  return Number(npk?.p || 0) > 0;
}

function itemIsPgr(item) {
  const category = normalizeText(item.product?.category);
  const raw = normalizeText(item.raw);
  return category.includes('plant growth regulator')
    || category === 'pgr'
    || raw.includes('primo')
    || raw.includes('pgr');
}

function getProductGroups(product) {
  return {
    moa: product?.moa_group || null,
    frac: product?.frac_group || null,
    irac: product?.irac_group || null,
    hrac: product?.hrac_group || null,
  };
}

function normalizeOptionList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeOptionList(item));
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isConditionalSelected(item, options = {}) {
  if (!item.conditional) return true;
  const selectedIds = new Set(normalizeOptionList(options.selectedConditionalProductIds));
  const selectedNames = new Set(normalizeOptionList(options.selectedConditionalProductNames).map(normalizeText));
  const selectedRaw = new Set(normalizeOptionList(options.selectedConditionalRaw).map(normalizeText));
  return (item.product?.id && selectedIds.has(String(item.product.id)))
    || (item.product?.name && selectedNames.has(normalizeText(item.product.name)))
    || selectedRaw.has(normalizeText(item.raw));
}

function calculateProductAmount({ product, lawnSqft, carrierGalPer1000 }) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const rate = Number(product?.default_rate_per_1000 || 0);
  const unit = product?.rate_unit || null;
  const amount = treatedUnits > 0 && rate > 0 ? Number((treatedUnits * rate).toFixed(3)) : null;
  const carrierGallons = treatedUnits > 0 && Number(carrierGalPer1000 || 0) > 0
    ? Number((treatedUnits * Number(carrierGalPer1000)).toFixed(2))
    : null;
  return {
    ratePer1000: rate || null,
    rateUnit: unit,
    amount,
    amountUnit: unit,
    carrierGallons,
  };
}

function buildMixOrder(items) {
  const order = [
    'water_conditioner',
    'dry_wg_wdg_wp_df',
    'liquid_flowable_sc',
    'ec_ew',
    'solution_sl',
    'liquid_fertilizer',
    'adjuvant_last',
  ];
  const rank = new Map(order.map((key, index) => [key, index]));
  return items
    .filter((item) => item.product)
    .slice()
    .sort((a, b) => {
      const ar = rank.has(a.product.mixing_order_category) ? rank.get(a.product.mixing_order_category) : 99;
      const br = rank.has(b.product.mixing_order_category) ? rank.get(b.product.mixing_order_category) : 99;
      return ar - br || a.product.name.localeCompare(b.product.name);
    })
    .map((item, index) => ({
      step: index + 1,
      productId: item.product.id,
      productName: item.product.name,
      category: item.product.mixing_order_category || 'unclassified',
      instruction: item.product.mixing_instructions || item.raw,
    }));
}

function summarizeOrdinanceStatus({ date, ordinances, candidateItems }) {
  const blocks = [];
  const warnings = [];
  const activeWindows = ordinances.filter((rule) => isDateInWindow(date, rule));
  const hasNitrogen = candidateItems.some((item) => itemHasNitrogen(item));
  const hasPhosphorus = candidateItems.some((item) => itemHasPhosphorus(item));

  for (const rule of activeWindows) {
    if (rule.restricted_nitrogen && hasNitrogen) {
      blocks.push({
        code: 'nitrogen_blackout',
        severity: 'block',
        message: `${rule.jurisdiction_name} restricts nitrogen during this visit window.`,
        source: rule.source_name || null,
      });
    }
    if (rule.restricted_phosphorus && hasPhosphorus) {
      blocks.push({
        code: 'phosphorus_blackout',
        severity: 'block',
        message: `${rule.jurisdiction_name} restricts phosphorus during this visit window.`,
        source: rule.source_name || null,
      });
    }
  }

  const phosphorusSoilTestRule = ordinances.find((rule) => rule.phosphorus_requires_soil_test);
  if (phosphorusSoilTestRule && hasPhosphorus) {
    warnings.push({
      code: 'phosphorus_soil_test',
      severity: 'warning',
      message: `${phosphorusSoilTestRule.jurisdiction_name} requires soil-test support before phosphorus is applied.`,
    });
  }

  if (!ordinances.length) {
    warnings.push({
      code: 'ordinance_unknown',
      severity: 'warning',
      message: 'No active municipality ordinance row matched this property.',
    });
  }

  return { activeWindows, blocks, warnings };
}

function summarizeCalibration({ calibration, calibrations, date }) {
  const activeCalibrations = Array.isArray(calibrations)
    ? calibrations
    : (calibration ? [calibration] : []);

  if (!activeCalibrations.length) {
    return {
      selected: null,
      blocks: [{
        code: 'missing_calibration',
        severity: 'block',
        message: 'No active equipment calibration is available for mix math.',
      }],
      warnings: [],
    };
  }

  if (activeCalibrations.length > 1 && !calibration) {
    return {
      selected: null,
      blocks: [{
        code: 'equipment_selection_required',
        severity: 'block',
        message: 'Multiple active equipment calibrations exist. Select the intended equipment system before mix math can be trusted.',
      }],
      warnings: [],
      options: activeCalibrations.map((row) => ({
        equipmentSystemId: row.equipment_system_id,
        systemName: row.system_name,
        systemType: row.system_type,
        carrierGalPer1000: row.carrier_gal_per_1000 ? Number(row.carrier_gal_per_1000) : null,
        tankCapacityGal: row.tank_capacity_gal ? Number(row.tank_capacity_gal) : null,
        expiresAt: row.expires_at || null,
      })),
    };
  }

  const selected = calibration || activeCalibrations[0];
  const warnings = [];
  const blocks = [];
  if (selected.expires_at && new Date(selected.expires_at) < date) {
    blocks.push({
      code: 'expired_calibration',
      severity: 'block',
      message: `Calibration for ${selected.system_name || selected.name || 'selected equipment'} is expired.`,
    });
  }

  if (!selected.tank_capacity_gal) {
    warnings.push({
      code: 'missing_tank_capacity',
      severity: 'warning',
      message: 'Equipment tank capacity is missing; tank-fill checks are limited.',
    });
  }

  return { selected, blocks, warnings };
}

function calculateNutrients(items, lawnSqft) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const totals = { n: 0, p: 0, k: 0 };
  for (const item of items) {
    const amount = Number(item.mix?.amount || 0);
    if (!item.product || !amount || !treatedUnits) continue;
    const pounds = amountToPounds(amount, item.mix?.amountUnit || item.product.rate_unit);
    if (pounds == null) continue;
    totals.n += pounds * (Number(item.product.analysis_n || 0) / 100);
    totals.p += pounds * (Number(item.product.analysis_p || 0) / 100);
    totals.k += pounds * (Number(item.product.analysis_k || 0) / 100);
  }
  return {
    nPer1000: treatedUnits ? Number((totals.n / treatedUnits).toFixed(3)) : 0,
    pPer1000: treatedUnits ? Number((totals.p / treatedUnits).toFixed(3)) : 0,
    kPer1000: treatedUnits ? Number((totals.k / treatedUnits).toFixed(3)) : 0,
  };
}

function amountToPounds(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const normalized = normalizeText(unit);
  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalized)) return n;
  if (['oz', 'ounce', 'ounces'].includes(normalized)) return n / 16;
  // Fluid ounces are volume. Without density/specific gravity, treating
  // them as pounds would corrupt N/P compliance math.
  if (['fl oz', 'fl_oz', 'floz', 'fluid ounce', 'fluid ounces'].includes(normalized)) return null;
  return null;
}

function findNutrientProductsMissingRates(items) {
  return items.filter((item) => {
    if (!item.product) return false;
    const hasNutrients = Number(item.product.analysis_n || 0) > 0
      || Number(item.product.analysis_p || 0) > 0
      || Number(item.product.analysis_k || 0) > 0;
    return hasNutrients && !item.mix?.amount;
  });
}

function findNutrientProductsMissingConversions(items) {
  return items.filter((item) => {
    if (!item.product || !item.mix?.amount) return false;
    const hasComplianceNutrients = Number(item.product.analysis_n || 0) > 0
      || Number(item.product.analysis_p || 0) > 0;
    if (!hasComplianceNutrients) return false;
    return amountToPounds(item.mix.amount, item.mix.amountUnit || item.product.rate_unit) == null;
  });
}

function selectProtocolVisit(profile, serviceDate) {
  const trackKey = profile?.track_key && protocols.lawn?.[profile.track_key]
    ? profile.track_key
    : TRACK_BY_GRASS[profile?.grass_type] || null;
  const track = trackKey ? protocols.lawn?.[trackKey] : null;
  const month = MONTH_ABBR[etParts(serviceDate).month - 1];
  const visit = track?.visits?.find((v) => v.month === month) || null;
  return { trackKey, track, month, visit };
}

async function getApplicableOrdinances(knex, profile) {
  if (!profile) return [];
  const county = String(profile.county || '').trim();
  const city = String(profile.municipality || '').trim();
  if (!county && !city) return [];

  let query = knex('municipality_ordinances').where({ active: true });
  query = query.where(function () {
    if (county) this.orWhere(function () {
      this.where({ jurisdiction_type: 'county' }).whereILike('county', county);
    });
    if (city) this.orWhere(function () {
      this.where({ jurisdiction_type: 'city' }).whereILike('city', city);
    });
  });
  return query;
}

async function getLatestAssessment(knex, customerId) {
  const row = await knex('lawn_assessments')
    .where({ customer_id: customerId })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
  if (!row) return null;
  return {
    ...row,
    stress_flags: parseMaybeJson(row.stress_flags, row.stress_flags || null),
    adjusted_scores: parseMaybeJson(row.adjusted_scores, row.adjusted_scores || null),
  };
}

async function getActiveCalibrations(knex, filters = {}) {
  const query = knex('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where('ec.active', true)
    .where('es.active', true)
    .select(
      'ec.*',
      'es.name as system_name',
      'es.system_type',
      'es.tank_capacity_gal',
      'es.default_application_type',
    )
    .orderBy('es.system_type', 'asc')
    .orderBy('ec.expires_at', 'asc');

  if (filters.equipmentSystemId) {
    query.where('ec.equipment_system_id', filters.equipmentSystemId);
  }
  if (filters.calibrationId) {
    query.where('ec.id', filters.calibrationId);
  }

  return query.catch(() => []);
}

async function getProducts(knex) {
  return knex('products_catalog')
    .where(function () {
      this.where({ active: true }).orWhereNull('active');
    })
    .select(
      'id', 'name', 'category', 'active_ingredient', 'moa_group',
      'frac_group', 'irac_group', 'hrac_group',
      'analysis_n', 'analysis_p', 'analysis_k',
      'default_rate_per_1000', 'rate_unit',
      'mixing_order_category', 'mixing_instructions',
      'label_verified_at',
    )
    .catch(() => []);
}

function calculateNutrientLedgerFromRows(rows, products, lawnSqft, year) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const totals = { n: 0, p: 0, k: 0 };
  for (const row of rows) {
    const product = matchCatalogProduct({ raw: row.product_name }, products);
    const amount = Number(row.total_amount || 0);
    if (!product || !amount) continue;
    const pounds = amountToPounds(amount, row.amount_unit);
    if (pounds == null) continue;
    totals.n += pounds * (Number(product.analysis_n || 0) / 100);
    totals.p += pounds * (Number(product.analysis_p || 0) / 100);
    totals.k += pounds * (Number(product.analysis_k || 0) / 100);
  }

  return {
    year,
    nApplied: treatedUnits ? Number((totals.n / treatedUnits).toFixed(3)) : 0,
    pApplied: treatedUnits ? Number((totals.p / treatedUnits).toFixed(3)) : 0,
    kApplied: treatedUnits ? Number((totals.k / treatedUnits).toFixed(3)) : 0,
    totalN: Number(totals.n.toFixed(3)),
    totalP: Number(totals.p.toFixed(3)),
    totalK: Number(totals.k.toFixed(3)),
  };
}

async function calculateNutrientLedger(knex, customerId, products, lawnSqft, serviceDate = new Date()) {
  const year = etParts(serviceDate).year;
  const rows = await knex('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .where('sr.customer_id', customerId)
    .where('sr.service_date', '>=', `${year}-01-01`)
    .select('sp.product_name', 'sp.total_amount', 'sp.amount_unit')
    .catch(() => []);

  return calculateNutrientLedgerFromRows(rows, products, lawnSqft, year);
}

async function buildPlanForService(serviceId, options = {}) {
  const knex = options.db || db;
  const now = options.now || new Date();

  const service = await knex('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .where('ss.id', serviceId)
    .select(
      'ss.*',
      'c.first_name', 'c.last_name', 'c.address_line1', 'c.city', 'c.state', 'c.zip',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .first();

  if (!service) {
    const err = new Error('Scheduled service not found');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  const serviceDate = toServiceDate(service.scheduled_date, now);
  const profile = await knex('customer_turf_profiles')
    .where({ customer_id: service.customer_id, active: true })
    .first()
    .catch(() => null);
  const products = await getProducts(knex);
  const latestAssessment = await getLatestAssessment(knex, service.customer_id);
  const ordinances = await getApplicableOrdinances(knex, profile);
  const activeCalibrations = await getActiveCalibrations(knex, {
    equipmentSystemId: options.equipmentSystemId,
    calibrationId: options.calibrationId,
  });
  const nutrientLedger = await calculateNutrientLedger(knex, service.customer_id, products, profile?.lawn_sqft, serviceDate);

  const { trackKey, track, month, visit } = selectProtocolVisit(profile, serviceDate);
  const baseLines = parseProtocolLines(visit?.primary, 'base');
  const conditionalLines = parseProtocolLines(visit?.secondary, 'conditional');
  const candidateItems = [...baseLines, ...conditionalLines].map((line) => {
    const product = matchCatalogProduct(line, products);
    const item = { ...line, product };
    return {
      ...item,
      selected: isConditionalSelected(item, options),
    };
  });
  const plannedCandidateItems = candidateItems.filter((item) => item.selected);

  const calibrationSummary = summarizeCalibration({ calibrations: activeCalibrations, date: serviceDate });
  const calibration = calibrationSummary.selected;
  const carrier = Number(calibration?.carrier_gal_per_1000 || 0);
  const lawnSqft = Number(profile?.lawn_sqft || 0);
  const planItems = candidateItems.map((item) => ({
    raw: item.raw,
    role: item.role,
    conditional: item.conditional,
    selected: item.selected,
    matched: !!item.product,
    product: item.product ? {
      id: item.product.id,
      name: item.product.name,
      category: item.product.category,
      activeIngredient: item.product.active_ingredient,
      groups: getProductGroups(item.product),
      labelVerifiedAt: item.product.label_verified_at || null,
      analysis_n: item.product.analysis_n,
      analysis_p: item.product.analysis_p,
      analysis_k: item.product.analysis_k,
      mixing_order_category: item.product.mixing_order_category,
      mixing_instructions: item.product.mixing_instructions,
    } : null,
    mix: item.product ? calculateProductAmount({
      product: item.product,
      lawnSqft,
      carrierGalPer1000: carrier,
    }) : null,
  }));
  const plannedItems = planItems.filter((item) => item.selected);

  const ordinanceSummary = summarizeOrdinanceStatus({ date: serviceDate, ordinances, candidateItems: plannedCandidateItems });
  const nutrientProjection = calculateNutrients(plannedItems, lawnSqft);
  const warnings = [
    ...ordinanceSummary.warnings,
    ...calibrationSummary.warnings,
  ];
  const blocks = [
    ...ordinanceSummary.blocks,
    ...calibrationSummary.blocks,
  ];

  if (!profile) {
    blocks.push({
      code: 'missing_turf_profile',
      severity: 'block',
      message: 'Customer has no active turf profile. Create the profile before planning a WaveGuard treatment.',
    });
  }
  if (profile && !profile.lawn_sqft) {
    blocks.push({
      code: 'missing_lawn_area',
      severity: 'block',
      message: 'Turf profile is missing lawn square footage, so mix amounts cannot be calculated.',
    });
  }
  if (!track || !visit) {
    blocks.push({
      code: 'missing_protocol_visit',
      severity: 'block',
      message: `No WaveGuard protocol visit found for ${trackKey || 'unmapped track'} in ${month}.`,
    });
  }
  if (candidateItems.some((item) => !item.product)) {
    warnings.push({
      code: 'unmatched_protocol_products',
      severity: 'warning',
      message: 'Some protocol lines did not match products_catalog rows; exact label math is limited until the protocol is normalized.',
    });
  }

  const missingNutrientRates = findNutrientProductsMissingRates(plannedItems);
  for (const item of missingNutrientRates) {
    blocks.push({
      code: 'missing_nutrient_rate',
      severity: 'block',
      productId: item.product.id,
      productName: item.product.name,
      message: `${item.product.name} has nutrient analysis but no verified default rate, so N/P/K projection cannot be trusted.`,
    });
  }

  const missingNutrientConversions = findNutrientProductsMissingConversions(plannedItems);
  for (const item of missingNutrientConversions) {
    blocks.push({
      code: 'missing_nutrient_density',
      severity: 'block',
      productId: item.product.id,
      productName: item.product.name,
      message: `${item.product.name} uses a volume rate with N/P analysis but no density, so N/P projection cannot be trusted.`,
    });
  }

  const stressFlags = latestAssessment?.stress_flags || {};
  if (
    (stressFlags.drought_stress || stressFlags.heat_stress || stressFlags.recent_scalp)
    && plannedCandidateItems.some((item) => itemIsPgr(item))
  ) {
    blocks.push({
      code: 'pgr_on_stressed_turf',
      severity: 'block',
      message: 'Latest assessment flags turf stress; PGR requires manager approval before it can stay on the plan.',
    });
  }

  const annualNLimit = Number(profile?.annual_n_budget_target || ordinances.find((o) => o.annual_n_limit_per_1000)?.annual_n_limit_per_1000 || 4);
  const projectedN = Number((Number(nutrientLedger.nApplied || 0) + nutrientProjection.nPer1000).toFixed(3));
  if (projectedN >= annualNLimit * 0.9) {
    warnings.push({
      code: 'annual_n_budget_near_limit',
      severity: projectedN > annualNLimit ? 'block' : 'warning',
      message: `Projected annual N is ${projectedN}/${annualNLimit} lb per 1,000 sq ft.`,
    });
    if (projectedN > annualNLimit) {
      blocks.push({
        code: 'annual_n_budget_exceeded',
        severity: 'block',
        message: `This plan would exceed the annual N budget (${projectedN}/${annualNLimit}).`,
      });
    }
  }

  const status = blocks.length ? 'blocked' : warnings.length ? 'warning' : 'approved';

  return {
    status,
    serviceId: service.id,
    generatedAt: now.toISOString(),
    propertyGate: {
      customerId: service.customer_id,
      customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
      service: service.service_type,
      serviceTier: service.waveguard_tier || null,
      trackKey,
      trackName: track?.name || null,
      month,
      visit: visit?.visit || null,
      lawnSqft: profile?.lawn_sqft || null,
      municipality: profile?.municipality || service.city || null,
      county: profile?.county || null,
      ordinanceStatus: ordinanceSummary.activeWindows.length ? 'restricted_window_active' : 'no_active_blackout',
      annualN: {
        used: nutrientLedger.nApplied,
        projected: projectedN,
        limit: annualNLimit,
        unit: 'lb N / 1,000 sqft / year',
      },
      latestAssessment: latestAssessment ? {
        id: latestAssessment.id,
        serviceDate: latestAssessment.service_date,
        overallScore: latestAssessment.overall_score,
        stressFlags,
      } : null,
      warnings,
      blocks,
    },
    protocol: {
      objective: visit?.notes || null,
      base: planItems.filter((item) => item.role === 'base'),
      conditional: planItems.filter((item) => item.role === 'conditional'),
      blocked: blocks,
    },
    mixCalculator: {
      equipmentSystemId: calibration?.equipment_system_id || null,
      carrierGalPer1000: calibration?.carrier_gal_per_1000 ? Number(calibration.carrier_gal_per_1000) : null,
      tankCapacityGal: calibration?.tank_capacity_gal ? Number(calibration.tank_capacity_gal) : null,
      lawnSqft: profile?.lawn_sqft || null,
      nutrientProjection,
      items: plannedItems,
      conditionalOptions: planItems.filter((item) => item.role === 'conditional' && !item.selected),
    },
    equipmentCalibration: calibrationSummary,
    mixingOrder: buildMixOrder(plannedItems),
    closeout: {
      requiredPhotos: ['before', 'after'],
      captureActualProductAmounts: true,
      customerRecapPreview: visit
        ? `${month} WaveGuard visit planned for ${track?.name || 'selected turf track'}.`
        : null,
    },
  };
}

module.exports = {
  buildPlanForService,
  calculateProductAmount,
  calculateNutrientLedgerFromRows,
  calculateNutrients,
  buildMixOrder,
  findNutrientProductsMissingRates,
  findNutrientProductsMissingConversions,
  isDateInWindow,
  matchCatalogProduct,
  amountToPounds,
  parseProtocolLines,
  isConditionalSelected,
  summarizeCalibration,
  summarizeOrdinanceStatus,
};
