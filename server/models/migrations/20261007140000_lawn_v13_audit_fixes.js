/**
 * Lawn protocol v13, owner-approved audit fixes (owner 2026-10-06, "I approve all
 * changes"; evidence: the Fable premise audit of 2026-10-06, sections B to D).
 * Migrations 20261005120000 to 20261006210000 are pushed and frozen; this one
 * adds to what they staged. The recipe file (lawn-protocol-v13.json) carries the
 * text; this migration carries the data the plan reads.
 *
 * 1. Application limits (product_limits, read by application-limits through
 *    v13Limits and the completion path):
 *      - Arena 50 WDG: at most 2 applications a year (label cap 0.4 lb
 *        clothianidin per acre per year; one pass at 0.22-0.29 oz per 1,000 sq ft
 *        uses most of it, so the owner's two a year only work on different areas).
 *        The ledger has no area identity, so "never the same area twice" stays a
 *        rule on the recipe, the plan note and the checklist.
 *      - Celsius WG: the existing yearly count cap of 3 becomes 2 (the label's
 *        0.17 oz per 1,000 sq ft a year is two passes of 0.085). The 0.171 rate
 *        cap and the 60-day interval stay.
 *      - Certainty Turf Herbicide: at most 2 a year (label 2.66 oz per acre a year
 *        is two passes of 0.028 oz per 1,000 sq ft).
 *      - Blindside Herbicide: at most 2 a year (label 10 oz of product per acre a
 *        year); its turf list drops bahiagrass, as Celsius's already does.
 *      - LESCO Atrazine 1.05% 18-0-10 (new row below): at most 2 a year, at least
 *        60 days apart (label: "wait 2 months for a repeat application").
 *    A row is added only when the product has none of that type; an older cap is
 *    never overwritten except Celsius's 3 to 2 (recorded, restored by down()).
 *    No clothianidin cap is shared with Aloft: the catalog holds no Aloft row.
 * 2. The February atrazine option (St. Augustine only, a weedy lawn, tech's
 *    pick; the default February bag stays the 24-0-11): the catalog row (label
 *    EPA 10404-94, SiteOne 702202, $36.14 per 50 lb), its immediate water-in
 *    rule, and one non-default row in the St. Augustine staged February window.
 *    The other grasses never get the row.
 * 3. Gates on the staged rows, written only where the key is missing: Arena
 *    (oncePerAreaPerYear), Acelepryn (delay watering and mowing 24 hours; the
 *    product watering rule stays fail-closed because its grub use needs the
 *    opposite), Nutra-TECH in the June, August and September windows
 *    (northPortBlocked, the same key the April N ban uses), and every
 *    whole-lawn spreader row of the February, April, October, November and
 *    December windows (fertilizerSafety).
 * 4. One checklist line, `fertilizer_safety_check`, on those five windows'
 *    required_tasks (deflector on, 10 ft water band kept, hard surfaces swept).
 * 5. Dismiss: the staged Dismiss rows leave the recipe windows (a row a
 *    completion already references is kept, so no actual loses its link).
 *
 * Idempotent. One lawn_protocol_audit_log row per protocol (action
 * 'v13_audit_fixes') and one catalog-level row hold what was written, so down()
 * takes back exactly that: gate keys only while they still hold the value written
 * here, the checklist line, the Dismiss rows, the atrazine row and the limit rows
 * (Celsius back to 3 while it still reads 2). The atrazine catalog row is never
 * deleted (it may carry inventory or pricing), as with every earlier v13 catalog row.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261007140000_lawn_v13_audit_fixes';
const V13_VERSION = '2026.10-v13';
const ACTION = 'v13_audit_fixes';
const CATALOG_ACTION = 'v13_audit_fixes_cat';
const LIMIT_PREFIX = 'v13 audit 2026-10-06:';

const NAMES = {
  ARENA: 'Arena 50 WDG',
  CELSIUS: 'Celsius WG',
  CERTAINTY: 'Certainty Turf Herbicide',
  BLINDSIDE: 'Blindside Herbicide',
  ACELEPRYN: 'Acelepryn Insecticide',
  NUTRA: 'LESCO Nutra-TECH T&O Micronutrient Package',
  DISMISS: 'Dismiss 64 oz',
  ATRAZINE: 'LESCO Atrazine 1.05% 18-0-10 56% PolyPlus OPTI45 2%Fe 0.5%Mn 0.5%Mg AS MOP',
};

const FEB_WINDOW = 'feb_v13_spreader_green_up';
// Hose windows whose Nutra-TECH pass North Port may not make (city fact sheet: no
// turf fertilizing April 1 to September 30; owner 2026-10-06: June to September).
const NORTH_PORT_WINDOWS = new Set(['jun_v13_hose_blackout', 'aug_v13_hose_blackout', 'sep_v13_hose_blackout']);
// The spreader windows (February, April, October, November, December) and the checklist line they gain.
const FERTILIZER_WINDOWS = new Set([FEB_WINDOW, 'apr_v13_spreader_feeding', 'oct_v13_spreader_fall', 'nov_v13_spreader_feeding', 'dec_v13_spreader_feeding']);
const SAFETY_TASK = 'fertilizer_safety_check';

const ATRAZINE_WATERING = {
  mode: 'water_in',
  water_in_inches: 0.25,
  water_in_by_hours: 1,
  source: 'label',
  label_note: 'Label (EPA 10404-94): "This product must be watered in immediately after application." No amount is stated; 0.25 inch is the program water-in for a granular bag. Keep people and pets off until it is watered in and dry.',
  verified_at: '2026-10-06T00:00:00.000Z',
  verified_by: 'label-check-2026-10-06',
};

// The catalog row for the February atrazine option. Label values are from the 2008 notification
// label (EPA 10404-94); the 702202 bag label itself has not been read (SiteOne returns 403), so
// the water setback wording stays a check on the bag.
const ATRAZINE_PRODUCT = {
  name: NAMES.ATRAZINE,
  category: 'herbicide',
  product_type: 'pesticide',
  active_ingredient: 'Atrazine',
  ai_pct: 1.05,
  hrac_group: '5',
  epa_reg_number: '10404-94',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  rate_unit: 'lb',
  default_rate_per_1000: 4.0,
  min_label_rate_per_1000: 3.27,
  max_label_rate_per_1000: 4.37,
  max_annual_per_1000: 8.74,
  maximum_annual_rate: '4 lb atrazine ai per acre per year (2 applications at 4.37 lb of product per 1,000 sq ft)',
  reapplication_interval_days: 60,
  analysis_n: 18,
  analysis_p: 0,
  analysis_k: 10,
  slow_release_n_pct: 56,
  labeled_turf_species: JSON.stringify(['st_augustine', 'centipede']),
  excluded_turf_species: JSON.stringify(['bermuda', 'zoysia', 'bahia', 'kentucky_bluegrass', 'fescue', 'ryegrass', 'bentgrass', 'dichondra']),
  aquatic_buffer_ft: 200,
  irrigation_required: true,
  siteone_sku: '702202',
  best_price: 36.14,
  best_vendor: 'SiteOne',
  cost_per_unit: 0.7228,
  cost_unit: 'lb',
  needs_pricing: false,
  label_source_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/010404-00094-20080222.pdf',
  label_source_note: 'Added for the Waves lawn protocol v13 February option (owner 2026-10-06). St. Augustine and centipede only; 3.27 to 4.37 lb per 1,000 sq ft; 2 applications a year, 2 months apart; must be watered in immediately; not within 200 ft of a lake or pond or 66 ft of where runoff enters a stream (2008 label; read the bag).',
  post_application_watering: JSON.stringify(ATRAZINE_WATERING),
};

const BLINDSIDE_TURF = {
  labeled_turf_species: ['st_augustine', 'bermuda', 'centipede', 'zoysia'],
  excluded_turf_species: ['bahia', 'seashore_paspalum'],
};

// [product name, limit_type, value, unit, severity, description]
const LIMITS = [
  [NAMES.ARENA, 'annual_max_apps', 2, 'applications', 'hard_block',
    `${LIMIT_PREFIX} Arena 50 WDG: at most 2 applications per lawn per year, never the same area twice (label: 0.4 lb clothianidin per acre per year; one pass at 0.22 to 0.29 oz per 1,000 sq ft uses most of it).`],
  [NAMES.CERTAINTY, 'annual_max_apps', 2, 'applications', 'hard_block',
    `${LIMIT_PREFIX} Certainty: at most 2 passes per year (label: 2.66 oz per acre per year; one pass is 0.028 oz per 1,000 sq ft).`],
  [NAMES.BLINDSIDE, 'annual_max_apps', 2, 'applications', 'hard_block',
    `${LIMIT_PREFIX} Blindside: at most 2 passes per year (label: 10 oz of product per acre per year).`],
  [NAMES.ATRAZINE, 'annual_max_apps', 2, 'applications', 'hard_block',
    `${LIMIT_PREFIX} Atrazine bag: at most 2 applications per year (label: 4 lb ai per acre per year).`],
  [NAMES.ATRAZINE, 'min_interval_days', 60, 'days', 'hard_block',
    `${LIMIT_PREFIX} Atrazine bag: wait 2 months for a repeat application (label).`],
];
const CELSIUS_CAP = { type: 'annual_max_apps', before: 3, after: 2 };

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

async function loadResolver(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const aliases = (await knex.schema.hasTable('product_aliases'))
    ? await knex('product_aliases').select('product_id', 'alias_name') : [];
  const byName = new Map();
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) {
    if (!byName.has(normalize(row.name))) byName.set(normalize(row.name), row.id);
  }
  const byAlias = new Map();
  for (const row of aliases) if (!byAlias.has(normalize(row.alias_name))) byAlias.set(normalize(row.alias_name), row.product_id);
  return (name) => byName.get(normalize(name)) || byAlias.get(normalize(name)) || null;
}

// The gate keys a staged row should gain (only missing keys are written).
function gateAdds(row) {
  const add = {};
  if (row.product_name === NAMES.ARENA) add.oncePerAreaPerYear = true;
  if (row.product_name === NAMES.ACELEPRYN) { add.delayWateringHours = 24; add.delayMowingHours = 24; }
  if (row.product_name === NAMES.NUTRA && NORTH_PORT_WINDOWS.has(row.window_key)) add.northPortBlocked = true;
  if (FERTILIZER_WINDOWS.has(row.window_key) && row.default_in_plan === true) add.fertilizerSafety = true;
  return add;
}

function v13Rows(knex) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', V13_VERSION);
}

async function hasActuals(knex, productRowId) {
  return (await knex.schema.hasTable('lawn_protocol_product_actuals'))
    && Boolean(await knex('lawn_protocol_product_actuals').where({ protocol_product_id: productRowId }).first('id'));
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols')) || !(await knex.schema.hasTable('lawn_protocol_products'))
    || !(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('products_catalog'))) return;

  // 1 and 2: catalog row, turf lists, limits.
  let resolve = await loadResolver(knex);
  const catalogAudit = { limitIds: [], celsius: null, blindside: null, atrazineInserted: false };

  if (!resolve(NAMES.ATRAZINE)) {
    const columns = Object.keys(ATRAZINE_PRODUCT);
    const present = [];
    for (const column of columns) if (await knex.schema.hasColumn('products_catalog', column)) present.push(column);
    const [inserted] = await knex('products_catalog').insert({
      ...Object.fromEntries(present.map((column) => [column, ATRAZINE_PRODUCT[column]])),
      active: true,
      content_status: 'draft',
      customer_visibility: 'internal_only',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    }).returning('id');
    catalogAudit.atrazineInserted = true;
    if (await knex.schema.hasTable('audit_log')) {
      await recordAuditEvent({
        actor_type: 'system',
        action: `migration:${MIGRATION}:seeded`,
        resource_type: 'products_catalog',
        resource_id: String(inserted.id || inserted),
        metadata: { migration: MIGRATION, product: NAMES.ATRAZINE, before: null, after: ATRAZINE_WATERING },
        critical: true,
        trx: knex,
      });
    }
    resolve = await loadResolver(knex);
  }

  if (await knex.schema.hasTable('product_limits')) {
    for (const [name, type, value, unit, severity, description] of LIMITS) {
      const productId = resolve(name);
      if (!productId) continue;
      if (await knex('product_limits').where({ product_id: productId, match_type: 'product', limit_type: type }).first('id')) continue;
      const [row] = await knex('product_limits').insert({
        product_id: productId, match_type: 'product', limit_type: type, limit_value: value, limit_unit: unit, severity, description,
      }).returning('id');
      catalogAudit.limitIds.push(row.id || row);
    }
    // Celsius: two passes a year (the seeded count cap of 3 is older than the label read).
    const celsiusId = resolve(NAMES.CELSIUS);
    if (celsiusId) {
      const cap = await knex('product_limits').where({ product_id: celsiusId, match_type: 'product', limit_type: CELSIUS_CAP.type }).first('id', 'limit_value');
      if (cap && Number(cap.limit_value) === CELSIUS_CAP.before) {
        await knex('product_limits').where({ id: cap.id }).update({
          limit_value: CELSIUS_CAP.after,
          description: `${LIMIT_PREFIX} Celsius WG: at most 2 applications per year (label: 0.17 oz per 1,000 sq ft per calendar year; one pass is 0.085 oz).`,
          updated_at: knex.fn.now(),
        });
        catalogAudit.celsius = { id: cap.id, before: CELSIUS_CAP.before, after: CELSIUS_CAP.after };
      } else if (!cap) {
        const [row] = await knex('product_limits').insert({
          product_id: celsiusId, match_type: 'product', limit_type: CELSIUS_CAP.type, limit_value: CELSIUS_CAP.after, limit_unit: 'applications', severity: 'hard_block',
          description: `${LIMIT_PREFIX} Celsius WG: at most 2 applications per year (label: 0.17 oz per 1,000 sq ft per calendar year; one pass is 0.085 oz).`,
        }).returning('id');
        catalogAudit.limitIds.push(row.id || row);
      }
    }
  }

  const blindsideId = resolve(NAMES.BLINDSIDE);
  if (blindsideId) {
    const row = await knex('products_catalog').where({ id: blindsideId }).first('id', 'labeled_turf_species', 'excluded_turf_species');
    const patch = {};
    const before = {};
    for (const key of ['labeled_turf_species', 'excluded_turf_species']) {
      if (row && asArray(row[key]).length === 0) { patch[key] = JSON.stringify(BLINDSIDE_TURF[key]); before[key] = null; }
    }
    if (Object.keys(patch).length) {
      await knex('products_catalog').where({ id: blindsideId }).update({ ...patch, updated_at: knex.fn.now() });
      catalogAudit.blindside = { id: blindsideId, before, after: patch };
    }
  }

  // 3, 4, 5: the staged protocols.
  const rows = await v13Rows(knex).select('p.id', 'p.product_name', 'p.default_in_plan', 'p.gates', 'p.sort_order',
    'p.lawn_protocol_window_id', 'w.window_key', 'w.required_tasks', 'l.id as protocol_id', 'l.grass_track');
  const byProtocol = new Map();
  for (const row of rows) {
    if (!byProtocol.has(row.protocol_id)) byProtocol.set(row.protocol_id, { grassTrack: row.grass_track, rows: [] });
    byProtocol.get(row.protocol_id).rows.push(row);
  }
  const atrazineId = resolve(NAMES.ATRAZINE);

  for (const [protocolId, protocol] of byProtocol) {
    const audit = { gates: {}, tasks: [], dismiss: [], atrazineRowId: null };

    for (const row of protocol.rows) {
      const gates = asObject(row.gates);
      const add = Object.fromEntries(Object.entries(gateAdds(row)).filter(([key]) => !(key in gates)));
      if (!Object.keys(add).length) continue;
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, ...add }), updated_at: knex.fn.now() });
      audit.gates[row.id] = add;
    }

    const windows = new Map();
    for (const row of protocol.rows) if (!windows.has(row.lawn_protocol_window_id)) windows.set(row.lawn_protocol_window_id, row);
    for (const [windowId, row] of windows) {
      if (!FERTILIZER_WINDOWS.has(row.window_key)) continue;
      const tasks = asArray(row.required_tasks);
      if (tasks.includes(SAFETY_TASK)) continue;
      await knex('lawn_protocol_windows').where({ id: windowId }).update({ required_tasks: JSON.stringify([...tasks, SAFETY_TASK]), updated_at: knex.fn.now() });
      audit.tasks.push(windowId);
    }

    for (const row of protocol.rows.filter((r) => r.product_name === NAMES.DISMISS)) {
      if (await hasActuals(knex, row.id)) continue;
      const full = await knex('lawn_protocol_products').where({ id: row.id }).first();
      if (!full) continue;
      await knex('lawn_protocol_products').where({ id: row.id }).del();
      audit.dismiss.push(full);
    }

    if (protocol.grassTrack === 'st_augustine' && atrazineId) {
      const febRow = protocol.rows.find((r) => r.window_key === FEB_WINDOW);
      if (febRow && !protocol.rows.some((r) => r.window_key === FEB_WINDOW && r.product_name === NAMES.ATRAZINE)) {
        const sort = Math.max(...protocol.rows.filter((r) => r.window_key === FEB_WINDOW).map((r) => Number(r.sort_order) || 0)) + 1;
        const [inserted] = await knex('lawn_protocol_products').insert({
          lawn_protocol_window_id: febRow.lawn_protocol_window_id,
          product_id: atrazineId,
          product_name: NAMES.ATRAZINE,
          role: 'weedy_lawn_option',
          application_mode: 'broadcast',
          rate_per_1000: 4.0,
          rate_unit: 'lb',
          carrier_gal_per_1000: null,
          default_in_plan: false,
          gates: JSON.stringify({
            trigger: 'weedy_lawn',
            stAugustineOnly: true,
            wholeLawn: true,
            replacesDefaultBag: true,
            waterInNow: true,
            avoidHighWaterTable: true,
            minDistanceFromWaterFt: 200,
            blackoutSensitive: true,
            fertilizerSafety: true,
          }),
          annual_counter: JSON.stringify({}),
          mixing: JSON.stringify({}),
          report_copy: JSON.stringify({ role: 'weedy_lawn_option' }),
          sort_order: sort,
        }).returning('id');
        audit.atrazineRowId = inserted.id || inserted;
      }
    }

    if (!Object.keys(audit.gates).length && !audit.tasks.length && !audit.dismiss.length && !audit.atrazineRowId) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007140000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['gates', 'required_tasks', 'products']),
      before_snapshot: JSON.stringify({ dismissRows: audit.dismiss }),
      after_snapshot: JSON.stringify({ gates: audit.gates, tasks: audit.tasks, atrazineRowId: audit.atrazineRowId }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }

  if (catalogAudit.limitIds.length || catalogAudit.celsius || catalogAudit.blindside || catalogAudit.atrazineInserted) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261007140000',
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['product_limits', 'products_catalog']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(catalogAudit),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log')) || !(await knex.schema.hasTable('lawn_protocol_products'))) return;

  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'before_snapshot', 'after_snapshot');
  for (const log of logs) {
    const after = asObject(log.after_snapshot);
    for (const [rowId, written] of Object.entries(after.gates || {})) {
      const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'gates');
      if (!row) continue;
      const gates = asObject(row.gates);
      for (const [key, value] of Object.entries(written)) if (isDeepStrictEqual(gates[key], value)) delete gates[key];
      await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
    }
    for (const windowId of after.tasks || []) {
      const window = await knex('lawn_protocol_windows').where({ id: windowId }).first('id', 'required_tasks');
      if (!window) continue;
      await knex('lawn_protocol_windows').where({ id: windowId })
        .update({ required_tasks: JSON.stringify(asArray(window.required_tasks).filter((task) => task !== SAFETY_TASK)), updated_at: knex.fn.now() });
    }
    if (after.atrazineRowId) await knex('lawn_protocol_products').where({ id: after.atrazineRowId, product_name: NAMES.ATRAZINE }).del();
    for (const dismissRow of asObject(log.before_snapshot).dismissRows || []) {
      const window = await knex('lawn_protocol_windows').where({ id: dismissRow.lawn_protocol_window_id }).first('id');
      if (!window) continue;
      const back = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id, product_name: NAMES.DISMISS }).first('id');
      if (back) continue;
      const { id: _id, created_at: _created, updated_at: _updated, ...rest } = dismissRow;
      await knex('lawn_protocol_products').insert({
        ...rest,
        gates: JSON.stringify(asObject(rest.gates)),
        annual_counter: JSON.stringify(asObject(rest.annual_counter)),
        mixing: JSON.stringify(asObject(rest.mixing)),
        report_copy: JSON.stringify(asObject(rest.report_copy)),
      });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }

  const catalogLogs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of catalogLogs) {
    const after = asObject(log.after_snapshot);
    if (await knex.schema.hasTable('product_limits')) {
      for (const limitId of after.limitIds || []) await knex('product_limits').where({ id: limitId }).del();
      if (after.celsius) {
        await knex('product_limits').where({ id: after.celsius.id, limit_value: after.celsius.after })
          .update({ limit_value: after.celsius.before, description: 'Celsius WG: max 3 applications per year per property. Exceeding voids warranty and risks turf damage.', updated_at: knex.fn.now() });
      }
    }
    if (after.blindside) {
      const row = await knex('products_catalog').where({ id: after.blindside.id }).first('labeled_turf_species', 'excluded_turf_species');
      const undo = {};
      for (const [key, written] of Object.entries(after.blindside.after || {})) {
        if (row && isDeepStrictEqual(asArray(row[key]), asArray(written))) undo[key] = null;
      }
      if (Object.keys(undo).length) await knex('products_catalog').where({ id: after.blindside.id }).update(undo);
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.NAMES = NAMES;
exports.LIMITS = LIMITS;
exports.CELSIUS_CAP = CELSIUS_CAP;
exports.ATRAZINE_PRODUCT = ATRAZINE_PRODUCT;
exports.ATRAZINE_WATERING = ATRAZINE_WATERING;
exports.FERTILIZER_WINDOWS = FERTILIZER_WINDOWS;
exports.NORTH_PORT_WINDOWS = NORTH_PORT_WINDOWS;
exports.SAFETY_TASK = SAFETY_TASK;
exports.gateAdds = gateAdds;
