const db = require('../models/db');
const { etParts } = require('../utils/datetime-et');
const { isDeepStrictEqual } = require('node:util');

// The checked-in field reference and plan matcher are released with protocol
// product/rate/gate changes. Portal publication may update DB-owned SOP and
// closeout fields, but must never activate a divergent treatment definition.
async function protocolTreatmentSnapshot(knex, protocolId) {
  const windows = await knex('lawn_protocol_windows')
    .where({ lawn_protocol_id: protocolId })
    .select('window_key', 'month', 'title', 'visit_type', 'goal', 'default_carrier_gal_per_1000', 'production_mode', 'main_tank', 'spot_work', 'conditional_triggers')
    .orderBy('window_key');
  const products = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where('w.lawn_protocol_id', protocolId)
    .select('w.window_key', 'p.product_id', 'p.product_name', 'p.role', 'p.application_mode', 'p.rate_per_1000', 'p.rate_unit', 'p.carrier_gal_per_1000', 'p.default_in_plan', 'p.gates', 'p.annual_counter', 'p.mixing', 'p.sort_order')
    .orderBy('w.window_key').orderBy('p.sort_order').orderBy('p.product_name').orderBy('p.product_id').orderBy('p.role');
  const gates = await knex('lawn_protocol_gates')
    .where({ lawn_protocol_id: protocolId })
    .select('gate_key', 'gate_type', 'severity', 'title', 'rule_text', 'logic')
    .orderBy('gate_key');
  return { windows, products, gates };
}

async function protocolReferenceSyncIssues(knex, protocol) {
  if (protocol.status !== 'draft') return [];
  const active = await knex('lawn_protocols')
    .where({ protocol_key: protocol.protocol_key, status: 'active' }).first();
  if (!active) return [{ severity: 'block', code: 'reference_baseline_missing', message: 'The active protocol is unavailable. Publication requires its reviewed treatment baseline.', metadata: {} }];
  const [baseline, proposed] = await Promise.all([
    protocolTreatmentSnapshot(knex, active.id), protocolTreatmentSnapshot(knex, protocol.id),
  ]);
  return Object.keys(baseline).filter((section) => !isDeepStrictEqual(baseline[section], proposed[section])).map((section) => {
    const fields = new Set();
    const rows = [...baseline[section], ...proposed[section]];
    for (const field of new Set(rows.flatMap((row) => Object.keys(row)))) {
      if (!isDeepStrictEqual(baseline[section].map((row) => row[field]), proposed[section].map((row) => row[field]))) fields.add(field);
    }
    return {
      severity: 'block', code: 'reference_sync_required',
      message: `Treatment ${section} changed (${[...fields].join(', ')}). Update the field reference, protocol data and catalog together in a reviewed release before publishing this draft. SOP links and closeout tasks can be published here.`,
      metadata: { section, changedFields: [...fields], activeProtocolId: active.id },
    };
  });
}

async function lockDraftProtocol(knex, protocolId) {
  const protocol = await knex('lawn_protocols').where({ id: protocolId }).forUpdate().first();
  if (protocol?.status !== 'draft') {
    const error = new Error('This protocol is no longer an editable draft. Reload before making changes.');
    error.statusCode = 409;
    error.isOperational = true;
    throw error;
  }
  return protocol;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRowJson(row, fields) {
  if (!row) return null;
  const out = { ...row };
  for (const [field, fallback] of Object.entries(fields)) {
    out[field] = parseJson(out[field], fallback);
  }
  return out;
}

function normalizeProtocol(row) {
  return normalizeRowJson(row, {
    default_carriers: {},
    production_rules: {},
    required_profile_fields: [],
    source_refs: [],
  });
}

function normalizeWindow(row) {
  return normalizeRowJson(row, {
    main_tank: {},
    spot_work: [],
    required_tasks: [],
    conditional_triggers: [],
    customer_note_templates: [],
    service_report_context: {},
    assessment_bridge: {},
    inventory_bridge: {},
    wiki_refs: [],
  });
}

function normalizeProduct(row) {
  return normalizeRowJson(row, {
    gates: {},
    annual_counter: {},
    mixing: {},
    report_copy: {},
  });
}

function normalizeGate(row) {
  return normalizeRowJson(row, {
    logic: {},
    wiki_refs: [],
  });
}

// strict: propagate DB errors instead of swallowing them to null/[] —
// callers that persist derived state keyed on this data (pre-visit brief
// grounding hash) must not read a transient outage as "no protocol".
// Default stays fail-soft for existing consumers (waveguard plan engine).
async function getActiveLawnProtocol(knex = db, filters = {}) {
  const { strict = false } = filters;
  const soft = (promise, fallback) => (strict ? promise : promise.catch(() => fallback));
  const query = knex('lawn_protocols')
    .where({ status: 'active' })
    .orderBy('effective_from', 'desc')
    .orderBy('created_at', 'desc');

  if (filters.protocolKey) query.where({ protocol_key: filters.protocolKey });
  if (filters.grassTrack) query.where({ grass_track: filters.grassTrack });
  if (filters.region) query.where({ region: filters.region });

  const protocol = normalizeProtocol(await soft(query.first(), null));
  if (!protocol) return null;

  const [windows, gates] = await Promise.all([
    soft(knex('lawn_protocol_windows')
      .where({ lawn_protocol_id: protocol.id })
      .orderBy('sort_order', 'asc')
      .orderBy('month', 'asc'), []),
    soft(knex('lawn_protocol_gates')
      .where({ lawn_protocol_id: protocol.id })
      .orderBy('gate_type', 'asc')
      .orderBy('gate_key', 'asc'), []),
  ]);

  return {
    ...protocol,
    windows: windows.map(normalizeWindow),
    gates: gates.map(normalizeGate),
  };
}

async function getLawnProtocolById(knex = db, id, { strict = false } = {}) {
  const soft = (promise, fallback) => (strict ? promise : promise.catch(() => fallback));
  const protocol = normalizeProtocol(await soft(knex('lawn_protocols').where({ id }).first(), null));
  if (!protocol) return null;

  const [windows, gates] = await Promise.all([
    soft(knex('lawn_protocol_windows')
      .where({ lawn_protocol_id: protocol.id })
      .orderBy('sort_order', 'asc')
      .orderBy('month', 'asc'), []),
    soft(knex('lawn_protocol_gates')
      .where({ lawn_protocol_id: protocol.id })
      .orderBy('gate_type', 'asc')
      .orderBy('gate_key', 'asc'), []),
  ]);

  return {
    ...protocol,
    windows: windows.map(normalizeWindow),
    gates: gates.map(normalizeGate),
  };
}

async function getProtocolWindowContext(knex = db, { serviceDate = new Date(), grassTrack = 'st_augustine', region = 'swfl', protocolId = null, windowKey = null, strict = false } = {}) {
  const protocol = protocolId
    ? await getLawnProtocolById(knex, protocolId, { strict })
    : await getActiveLawnProtocol(knex, { grassTrack, region, strict });
  if (!protocol) return null;

  const month = etParts(serviceDate).month;
  const window = windowKey
    ? protocol.windows.find((item) => item.window_key === windowKey) || null
    : protocol.windows.find((item) => Number(item.month) === Number(month)) || null;
  if (!window) return { protocol, window: null, products: [], gates: protocol.gates };

  const productsQuery = knex('lawn_protocol_products as lpp')
    .leftJoin('products_catalog as pc', 'lpp.product_id', 'pc.id')
    .where('lpp.lawn_protocol_window_id', window.id)
    .select(
      'lpp.*',
      'pc.name as catalog_product_name',
      'pc.category as catalog_category',
      'pc.active_ingredient',
      'pc.analysis_n',
      'pc.analysis_p',
      'pc.analysis_k',
      'pc.frac_group',
      'pc.irac_group',
      'pc.hrac_group',
      'pc.moa_group',
    )
    .orderBy('lpp.sort_order', 'asc');
  const products = strict ? await productsQuery : await productsQuery.catch(() => []);

  return {
    protocol,
    window,
    products: products.map(normalizeProduct),
    gates: protocol.gates,
  };
}

function summarizeProtocolContext(context) {
  if (!context?.protocol) return null;
  return {
    protocolKey: context.protocol.protocol_key,
    id: context.protocol.id,
    version: context.protocol.version,
    name: context.protocol.name,
    status: context.protocol.status,
    effectiveFrom: context.protocol.effective_from,
    effectiveTo: context.protocol.effective_to,
    grassTrack: context.protocol.grass_track,
    region: context.protocol.region,
    operatingSentence: context.protocol.operating_sentence,
    window: context.window ? {
      key: context.window.window_key,
      month: context.window.month,
      title: context.window.title,
      visitType: context.window.visit_type,
      goal: context.window.goal,
      defaultCarrierGalPer1000: context.window.default_carrier_gal_per_1000 != null
        ? Number(context.window.default_carrier_gal_per_1000)
        : null,
      productionMode: context.window.production_mode,
      requiredTasks: context.window.required_tasks,
      serviceReportContext: context.window.service_report_context,
      assessmentBridge: context.window.assessment_bridge,
      inventoryBridge: context.window.inventory_bridge,
      wikiRefs: context.window.wiki_refs,
      customerNoteTemplates: context.window.customer_note_templates,
    } : null,
    products: (context.products || []).map((product) => ({
      id: product.id,
      productId: product.product_id,
      productName: product.catalog_product_name || product.product_name,
      protocolProductName: product.product_name,
      role: product.role,
      applicationMode: product.application_mode,
      ratePer1000: product.rate_per_1000 != null ? Number(product.rate_per_1000) : null,
      rateUnit: product.rate_unit,
      carrierGalPer1000: product.carrier_gal_per_1000 != null ? Number(product.carrier_gal_per_1000) : null,
      defaultInPlan: product.default_in_plan,
      gates: product.gates,
      annualCounter: product.annual_counter,
      groups: {
        frac: product.frac_group || null,
        irac: product.irac_group || null,
        hrac: product.hrac_group || null,
        moa: product.moa_group || null,
      },
      analysis: {
        n: product.analysis_n,
        p: product.analysis_p,
        k: product.analysis_k,
      },
    })),
    gates: (context.gates || []).map((gate) => ({
      id: gate.id,
      key: gate.gate_key,
      type: gate.gate_type,
      severity: gate.severity,
      title: gate.title,
      ruleText: gate.rule_text,
      logic: gate.logic,
      wikiRefs: gate.wiki_refs,
    })),
  };
}

module.exports = {
  protocolReferenceSyncIssues,
  lockDraftProtocol,
  getActiveLawnProtocol,
  getLawnProtocolById,
  getProtocolWindowContext,
  summarizeProtocolContext,
};
