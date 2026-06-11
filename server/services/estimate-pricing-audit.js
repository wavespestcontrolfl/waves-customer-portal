const db = require('../models/db');
const { costLineFromUsage } = require('./product-costing');
const { matchServiceProtocol } = require('./protocol-matcher');

const SERVICE_MAP = {
  pest_control: {
    label: 'Pest Control',
    serviceTypes: ['Quarterly Pest Control', 'Pest Control', 'General Pest Perimeter'],
    areaField: 'homeSqFt',
  },
  lawn_care: {
    label: 'Lawn Care',
    serviceTypes: ['Lawn Care'],
    areaField: 'lawnSqFt',
  },
  tree_shrub: {
    label: 'Tree & Shrub',
    serviceTypes: ['Tree & Shrub'],
    areaField: 'bedArea',
  },
  mosquito: {
    label: 'Mosquito',
    serviceTypes: ['Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'],
    areaField: 'lotSqFt',
  },
  termite_bait: {
    label: 'Termite Bait',
    serviceTypes: ['Termite Bait', 'Termite Bait Station'],
    areaField: 'homeSqFt',
  },
  rodent_bait: {
    label: 'Rodent Bait',
    serviceTypes: ['Rodent Bait', 'Rodent Control'],
    areaField: 'homeSqFt',
  },
  palm_injection: {
    label: 'Palm Injection',
    serviceTypes: ['Palm Injection'],
    areaField: 'homeSqFt',
  },
  one_time_pest: {
    label: 'One-Time Pest',
    serviceTypes: ['One-Time Pest', 'Pest Control'],
    areaField: 'homeSqFt',
  },
  one_time_lawn: {
    label: 'One-Time Lawn',
    serviceTypes: ['One-Time Lawn', 'Lawn Care'],
    areaField: 'lawnSqFt',
  },
  one_time_mosquito: {
    label: 'One-Time Mosquito',
    serviceTypes: ['One-Time Mosquito', 'Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'],
    areaField: 'lotSqFt',
  },
  bora_care: {
    label: 'Bora-Care',
    serviceTypes: ['Bora-Care', 'Bora Care'],
    areaField: 'homeSqFt',
  },
  pre_slab_termidor: {
    label: 'Pre-Slab Termidor',
    serviceTypes: ['Pre-Slab Termidor', 'Termidor Trench'],
    areaField: 'homeSqFt',
  },
  pre_slab_termiticide: {
    label: 'Pre-Slab Termiticide Treatment',
    serviceTypes: ['Pre-Slab Termiticide Treatment', 'Pre-Slab Termidor', 'Termidor Trench'],
    areaField: 'homeSqFt',
  },
  trenching: {
    label: 'Termidor Trench',
    serviceTypes: ['Termidor Trench', 'Termite Trench'],
    areaField: 'homeSqFt',
  },
  rodent_trapping: {
    label: 'Rodent Trapping',
    serviceTypes: ['Rodent Trapping', 'Rodent Control'],
    areaField: 'homeSqFt',
  },
  rodent_sanitation: {
    label: 'Rodent Sanitation',
    serviceTypes: ['Rodent Sanitation'],
    areaField: 'homeSqFt',
  },
  exclusion: {
    label: 'Exclusion',
    serviceTypes: ['Exclusion', 'Rodent Exclusion'],
    areaField: 'homeSqFt',
  },
  flea: {
    label: 'Flea Treatment',
    serviceTypes: ['Flea Treatment'],
    areaField: 'homeSqFt',
  },
  stinging: {
    label: 'Stinging Insect',
    serviceTypes: ['Stinging Insect', 'Wasp Treatment'],
    areaField: 'homeSqFt',
  },
  german_roach: {
    label: 'German Roach',
    serviceTypes: ['German Roach', 'Roach Treatment'],
    areaField: 'homeSqFt',
  },
  german_roach_initial: {
    label: 'German Roach Initial',
    serviceTypes: ['German Roach', 'Roach Treatment'],
    areaField: 'homeSqFt',
  },
  pest_initial_roach: {
    label: 'Initial Roach Knockdown',
    serviceTypes: ['Roach Treatment', 'Pest Control'],
    areaField: 'homeSqFt',
  },
};

const NAME_TO_KEY = [
  [/tree.*shrub/i, 'tree_shrub'],
  [/lawn/i, 'lawn_care'],
  [/mosquito/i, 'mosquito'],
  [/termite|bait station/i, 'termite_bait'],
  [/rodent.*bait/i, 'rodent_bait'],
  [/rodent.*trap/i, 'rodent_trapping'],
  [/sanitation/i, 'rodent_sanitation'],
  [/exclusion/i, 'exclusion'],
  [/palm/i, 'palm_injection'],
  [/bora/i, 'bora_care'],
  [/termidor|trench/i, 'trenching'],
  [/flea/i, 'flea'],
  [/roach/i, 'german_roach'],
  [/stinging|wasp/i, 'stinging'],
  [/mosquito/i, 'one_time_mosquito'],
  [/pest/i, 'pest_control'],
];

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function dimensionsFrom(data) {
  const inputs = data?.inputs || data?.engineInputs || {};
  const result = data?.result || data?.engineResult || {};
  const property = result.property || {};
  const homeSqFt = Number(inputs.homeSqFt || property.homeSqFt || property.squareFootage || 0);
  const lotSqFt = Number(inputs.lotSqFt || property.lotSqFt || 0);
  const lawnSqFt = Number(inputs.lawnSqFt || property.estimatedTurfSf || property.estimatedTurfSqFt || inputs.estimatedTurfSf || 0);
  const bedArea = Number(inputs.bedArea || property.estimatedBedAreaSf || property.estimatedBedSqFt || 0);
  return { homeSqFt, lotSqFt, lawnSqFt, bedArea };
}

function keyFromName(name) {
  const value = String(name || '');
  for (const [pattern, key] of NAME_TO_KEY) {
    if (pattern.test(value)) return key;
  }
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
}

function mosquitoCogs(program, addOns = {}) {
  const raw = String(program || '').toLowerCase();
  const serviceTypes = raw.includes('precision') || raw.includes('scion') || raw.includes('residual')
    ? ['Mosquito Treatment - Precision Barrier', 'Mosquito Treatment - IGR']
    : ['Mosquito Treatment - Essential Barrier', 'Mosquito Treatment - IGR'];
  const serviceTypeFixedMultipliers = {};
  const stationCount = Number(addOns.stationCount || 0);
  const dunkCount = Number(addOns.dunkCount || 0);
  if (stationCount > 0) {
    serviceTypes.push('Mosquito Treatment - Stations');
    serviceTypeFixedMultipliers['Mosquito Treatment - Stations'] = stationCount;
  }
  if (dunkCount > 0) {
    serviceTypes.push('Mosquito Treatment - Dunks');
    serviceTypeFixedMultipliers['Mosquito Treatment - Dunks'] = dunkCount;
  }
  return { serviceTypes, serviceTypeFixedMultipliers };
}

function normalizeRecurringLines(result) {
  const discount = Number(result?.recurring?.discount || 0);
  const lines = [];
  for (const svc of result?.recurring?.services || []) {
    const monthly = Number(svc.monthly ?? svc.mo ?? 0);
    const serviceKey = keyFromName(svc.name);
    const line = {
      serviceKey,
      label: svc.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'recurring',
      price: money(monthly * 12 * (1 - discount)),
      monthly: money(monthly * (1 - discount)),
      priceBeforeDiscount: money(monthly * 12),
      discount,
      priceSource: 'saved_estimate.result.recurring.services',
    };
    if (serviceKey === 'mosquito') {
      const mqMeta = result?.results?.mqMeta || {};
      const selectedMosquito = Array.isArray(result?.results?.mq)
        ? result.results.mq[mqMeta.ri ?? 1]
        : null;
      const cogs = mosquitoCogs(mqMeta.program, mqMeta.addOns || {});
      line.cogsServiceTypes = cogs.serviceTypes;
      line.cogsServiceTypeFixedMultipliers = cogs.serviceTypeFixedMultipliers;
      line.visitsPerYear = Number(selectedMosquito?.v || 0) || undefined;
    }
    lines.push(line);
  }
  if (Number(result?.recurring?.rodentBaitMo || 0) > 0) {
    lines.push({
      serviceKey: 'rodent_bait',
      label: 'Rodent Bait',
      cadence: 'recurring',
      price: money(Number(result.recurring.rodentBaitMo) * 12),
      monthly: money(result.recurring.rodentBaitMo),
      priceBeforeDiscount: money(Number(result.recurring.rodentBaitMo) * 12),
      discount: 0,
      priceSource: 'saved_estimate.result.recurring.rodentBaitMo',
    });
  }
  if (Number(result?.recurring?.palmInjectionMo || 0) > 0) {
    lines.push({
      serviceKey: 'palm_injection',
      label: 'Palm Injection',
      cadence: 'recurring',
      price: money(Number(result.recurring.palmInjectionAnn || result.recurring.palmInjectionMo * 12)),
      monthly: money(result.recurring.palmInjectionMo),
      priceBeforeDiscount: money(Number(result.recurring.palmInjectionAnn || result.recurring.palmInjectionMo * 12)),
      discount: 0,
      priceSource: 'saved_estimate.result.recurring.palmInjectionMo',
    });
  }
  return lines;
}

function normalizeOneTimeLines(result) {
  const lines = [];
  for (const item of result?.oneTime?.items || []) {
    const serviceKey = item.service || keyFromName(item.name);
    const line = {
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'one_time',
      price: money(item.price),
      monthly: null,
      priceBeforeDiscount: money(item.price),
      discount: 0,
      priceSource: 'saved_estimate.result.oneTime.items',
    };
    if (serviceKey === 'one_time_mosquito') {
      const cogs = mosquitoCogs('monthly', item.addOns || {});
      line.cogsServiceTypes = cogs.serviceTypes;
      line.cogsServiceTypeFixedMultipliers = cogs.serviceTypeFixedMultipliers;
    }
    lines.push(line);
  }
  for (const item of result?.oneTime?.specItems || []) {
    const serviceKey = item.service || keyFromName(item.name);
    lines.push({
      serviceKey,
      label: item.name || SERVICE_MAP[serviceKey]?.label || serviceKey,
      cadence: 'one_time',
      price: money(item.price),
      monthly: null,
      priceBeforeDiscount: money(item.price),
      discount: 0,
      priceSource: 'saved_estimate.result.oneTime.specItems',
    });
  }
  if (Number(result?.oneTime?.membershipFee || 0) > 0) {
    lines.push({
      serviceKey: 'waveguard_membership',
      label: 'WaveGuard Membership',
      cadence: 'one_time',
      price: money(result.oneTime.membershipFee),
      monthly: null,
      priceBeforeDiscount: money(result.oneTime.membershipFee),
      discount: 0,
      priceSource: 'saved_estimate.result.oneTime.membershipFee',
      skipCogs: true,
    });
  }
  return lines;
}

async function loadInventoryCostRows() {
  if (!(await db.schema.hasTable('service_product_usage')) || !(await db.schema.hasTable('products_catalog'))) {
    return { available: false, rows: [] };
  }
  const rows = await db('service_product_usage')
    .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
    .select(
      'service_product_usage.service_type',
      'service_product_usage.usage_amount',
      'service_product_usage.usage_unit',
      'service_product_usage.usage_per_1000sf',
      'service_product_usage.notes',
      'products_catalog.id as product_id',
      'products_catalog.name as product_name',
      'products_catalog.cost_per_unit',
      'products_catalog.cost_unit',
      'products_catalog.best_price',
      'products_catalog.unit_size_oz',
      'products_catalog.best_vendor',
    );
  return { available: true, rows };
}

function inventoryCostFromRows(serviceKey, dimensions, inventory, serviceTypesOverride = null, serviceTypeFixedMultipliers = {}) {
  const map = SERVICE_MAP[serviceKey];
  if (!map) return { status: 'unmapped', totalPerVisit: 0, annualCost: 0, lines: [], warnings: ['No service-to-inventory mapping yet'] };
  if (!inventory?.available) {
    return { status: 'missing_cogs', totalPerVisit: 0, annualCost: 0, lines: [], warnings: ['Inventory COGS tables are unavailable'] };
  }

  const serviceTypes = serviceTypesOverride || map.serviceTypes;
  const allRows = (inventory.rows || []).filter((row) => serviceTypes.includes(row.service_type));
  const matchedServiceType = serviceTypes.find((serviceType) => allRows.some((row) => row.service_type === serviceType)) || null;
  const rows = serviceTypesOverride
    ? allRows
    : (matchedServiceType ? allRows.filter((row) => row.service_type === matchedServiceType) : []);
  if (!rows.length) return { status: 'missing_cogs', totalPerVisit: 0, annualCost: 0, lines: [], warnings: ['No inventory COGS rows mapped'] };

  const areaSqFt = Number(dimensions[map.areaField] || 0);
  const warnings = [];
  let totalPerVisit = 0;
  let fixedCost = 0;
  const lines = rows.map((row) => {
    const cost = costLineFromUsage(row, areaSqFt);
    if (cost.warning) warnings.push(cost.warning);
    const multiplier = Number(serviceTypeFixedMultipliers[row.service_type] || 1);
    const lineCost = (cost.cost || 0) * multiplier;
    const isFixed = serviceTypeFixedMultipliers[row.service_type] != null;
    if (isFixed) fixedCost += lineCost;
    else totalPerVisit += lineCost;
    return {
      productId: row.product_id,
      productName: row.product_name,
      serviceType: row.service_type,
      cost: money(lineCost),
      costTiming: isFixed ? 'fixed' : 'per_visit',
      source: cost.source || 'missing',
      warning: cost.warning || null,
    };
  });
  return {
    status: warnings.length ? 'warning' : 'ok',
    totalPerVisit: money(totalPerVisit),
    fixedCost: money(fixedCost),
    matchedServiceType,
    lines,
    warnings,
  };
}

async function inventoryCostFor(serviceKey, dimensions) {
  return inventoryCostFromRows(serviceKey, dimensions, await loadInventoryCostRows());
}

function visitsFor(line, result) {
  if (line.cadence === 'one_time') return 1;
  if (line.visitsPerYear) return Number(line.visitsPerYear);
  const item = (result?.lineItems || []).find((i) => i.service === line.serviceKey);
  if (item?.visits || item?.visitsPerYear) return Number(item.visits || item.visitsPerYear);
  if (line.serviceKey === 'lawn_care') return Number(result?.results?.lawn?.find((x) => x.recommended)?.v || 9);
  if (line.serviceKey === 'mosquito') return 12;
  if (line.serviceKey === 'pest_control') return Number(result?.results?.pest?.apps || 4);
  if (line.serviceKey === 'tree_shrub') {
    // Use the selected/recommended row, not ts[0] — Light (4 visits) now sorts
    // ahead of Standard, so ts[0] would understate visits for a Standard plan.
    const ts = Array.isArray(result?.results?.ts) ? result.results.ts : [];
    const chosen = ts.find((x) => x?.selected) || ts.find((x) => x?.recommended) || ts[0];
    return Number(chosen?.v || 6);
  }
  if (line.serviceKey === 'rodent_bait') return 4;
  if (line.serviceKey === 'termite_bait') return 1;
  return 1;
}

function protocolFor(line) {
  const map = SERVICE_MAP[line.serviceKey];
  const serviceType = map?.serviceTypes?.[0] || line.label;
  try {
    const protocols = require('../config/protocols.json');
    const match = matchServiceProtocol(protocols, serviceType);
    return {
      serviceType,
      programKey: match.programKey || null,
      matched: !!match.matched,
      visitName: match.matchedVisit?.name || match.matchedVisit?.month || null,
      reason: match.reason || null,
    };
  } catch (err) {
    return { serviceType, programKey: null, matched: false, visitName: null, reason: err.message };
  }
}

async function buildEstimatePricingAudit(estimate, context = {}) {
  const data = parseJson(estimate.estimate_data) || {};
  const result = data.result || data.engineResult || {};
  const dimensions = dimensionsFrom(data);
  const inventory = context.inventory || await loadInventoryCostRows();
  const rawLines = [
    ...normalizeRecurringLines(result),
    ...normalizeOneTimeLines(result),
  ];
  const lines = [];

  for (const raw of rawLines) {
    const protocol = raw.skipCogs ? null : protocolFor(raw);
    const cogs = raw.skipCogs
      ? { status: 'not_applicable', totalPerVisit: 0, lines: [], warnings: [] }
      : inventoryCostFromRows(raw.serviceKey, dimensions, inventory, raw.cogsServiceTypes, raw.cogsServiceTypeFixedMultipliers);
    const visits = visitsFor(raw, result);
    const estimatedCost = money((cogs.totalPerVisit || 0) * visits + (cogs.fixedCost || 0));
    const grossProfit = money(raw.price - estimatedCost);
    const margin = raw.price > 0 ? Math.round((grossProfit / raw.price) * 1000) / 1000 : null;
    const warnings = [
      ...(cogs.warnings || []),
      ...(cogs.status === 'missing_cogs' ? ['Missing inventory COGS mapping'] : []),
      ...(margin != null && margin < 0.35 ? [`Margin below 35% floor (${Math.round(margin * 100)}%)`] : []),
    ];
    lines.push({
      ...raw,
      protocol,
      cogs: { ...cogs, visitsPerYear: visits, estimatedCost },
      grossProfit,
      margin,
      status: warnings.length ? 'warning' : 'ok',
      warnings,
    });
  }

  const revenue = money(Number(estimate.annual_total || 0) + Number(estimate.onetime_total || 0));
  const estimatedCost = money(lines.reduce((sum, line) => sum + (line.cogs?.estimatedCost || 0), 0));
  const grossProfit = money(revenue - estimatedCost);
  return {
    estimate: {
      id: estimate.id,
      customerName: estimate.customer_name,
      address: estimate.address,
      status: estimate.status,
      monthlyTotal: money(estimate.monthly_total),
      annualTotal: money(estimate.annual_total),
      onetimeTotal: money(estimate.onetime_total),
      waveguardTier: estimate.waveguard_tier,
      pricingVersion: result.pricingVersion || data.pricingVersion || null,
    },
    dimensions,
    totals: {
      revenue,
      estimatedCost,
      grossProfit,
      margin: revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 1000 : null,
    },
    lines,
  };
}

function summarizePricingRisk(audit) {
  const lines = Array.isArray(audit?.lines) ? audit.lines : [];
  const missingCogsLines = lines.filter((line) => ['missing_cogs', 'unmapped'].includes(line.cogs?.status));
  const lowMarginLines = lines.filter((line) => line.margin != null && line.margin < 0.35);
  const warningLines = lines.filter((line) => Array.isArray(line.warnings) && line.warnings.length > 0);
  const status = missingCogsLines.length > 0
    ? 'missing_cogs'
    : lowMarginLines.length > 0
      ? 'low_margin'
      : warningLines.length > 0
        ? 'warning'
        : 'ok';

  return {
    status,
    hasRisk: status !== 'ok',
    missingCogsCount: missingCogsLines.length,
    lowMarginCount: lowMarginLines.length,
    warningCount: warningLines.length,
    margin: audit?.totals?.margin ?? null,
    estimatedCost: audit?.totals?.estimatedCost || 0,
    labels: [
      missingCogsLines.length > 0 ? 'Missing COGS' : null,
      lowMarginLines.length > 0 ? 'Low Margin' : null,
      status === 'warning' ? 'Pricing Warning' : null,
    ].filter(Boolean),
  };
}

async function buildEstimatePricingRisk(estimate) {
  return summarizePricingRisk(await buildEstimatePricingAudit(estimate));
}

async function buildEstimatePricingRiskBatch(estimates) {
  const inventory = await loadInventoryCostRows();
  const riskById = new Map();
  for (const estimate of estimates || []) {
    riskById.set(estimate.id, summarizePricingRisk(await buildEstimatePricingAudit(estimate, { inventory })));
  }
  return riskById;
}

async function saveEstimatePricingAuditSnapshot(estimate, options = {}) {
  if (!estimate?.id || !(await db.schema.hasTable('estimate_pricing_audit_snapshots'))) return null;

  const audit = await buildEstimatePricingAudit(estimate);
  const [row] = await db('estimate_pricing_audit_snapshots').insert({
    estimate_id: estimate.id,
    trigger: options.trigger || 'send',
    send_method: options.sendMethod || estimate.send_method || null,
    pricing_version: audit.estimate?.pricingVersion || null,
    revenue: audit.totals?.revenue ?? null,
    estimated_cost: audit.totals?.estimatedCost ?? null,
    gross_profit: audit.totals?.grossProfit ?? null,
    margin: audit.totals?.margin ?? null,
    audit: JSON.stringify(audit),
  }).returning('*');

  return row || null;
}

async function getLatestEstimatePricingAuditSnapshot(estimateId) {
  if (!estimateId || !(await db.schema.hasTable('estimate_pricing_audit_snapshots'))) return null;
  const row = await db('estimate_pricing_audit_snapshots')
    .where({ estimate_id: estimateId })
    .orderBy('snapshot_at', 'desc')
    .first();
  if (!row) return null;

  return {
    id: row.id,
    estimateId: row.estimate_id,
    snapshotAt: row.snapshot_at,
    trigger: row.trigger,
    sendMethod: row.send_method,
    pricingVersion: row.pricing_version,
    totals: {
      revenue: money(row.revenue),
      estimatedCost: money(row.estimated_cost),
      grossProfit: money(row.gross_profit),
      margin: row.margin == null ? null : Number(row.margin),
    },
    audit: parseJson(row.audit) || row.audit,
  };
}

module.exports = {
  buildEstimatePricingAudit,
  buildEstimatePricingRisk,
  buildEstimatePricingRiskBatch,
  getLatestEstimatePricingAuditSnapshot,
  saveEstimatePricingAuditSnapshot,
  summarizePricingRisk,
};
