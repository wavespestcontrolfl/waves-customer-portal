/**
 * The governed rates and limits of the five chemical area add-ons, in the DB-backed protocol store (Codex round 9 on #6135).
 *
 * A product's governed rate, gates and annual counter in a treatment are kept in TWO sources of truth (AGENTS.md "Lawn protocol
 * data fan-out"): the field-exec program in config/protocols.json and lawn_protocol_products (rate_per_1000, rate_unit, gates,
 * annual_counter) with its window and protocol. The add-on program existed only in the JSON. This writes it to the DB store:
 *
 *   lawn_protocols          one row, protocol_key 'area_addon', grass_track 'area_addon', status active. The grass track names no
 *                           real grass, so no lawn lookup (they all filter by a real grass track) can ever select it.
 *   lawn_protocol_windows   one window per chemical add-on, window_key = the add-on's catalog service key. month is NOT NULL in
 *                           this table and a keyed one-time treatment has no calendar month: 0 stands for "any month" (calendar
 *                           months are 1 to 12, so no month lookup can match it).
 *   lawn_protocol_products  one row per window: the governed product, rate_per_1000 and rate_unit (the add-on's rate, NOT the
 *                           catalog default_rate_per_1000, which belongs to the lawn program and is untouched), default_in_plan
 *                           false and a gate naming the add-on's service key (optional rows are never default selections),
 *                           annual_counter { maxApplications, windowMonths: 12, minDaysApart }.
 *
 * A test loads the rows below and the protocols.json program and AREA_ADDONS and pins rate, unit, yearly count and interval for
 * each add-on, so the DB and the JSON cannot disagree.
 *
 * Insert-if-missing and idempotent: a protocol with this key and version is never rewritten, a window or product row that
 * exists is never touched. One lawn_protocol_audit_log row lists what was inserted; down() deletes only those rows (products
 * and windows that still hold exactly what was written; the protocol only when nothing else hangs off it).
 */
const PROTOCOL_KEY = 'area_addon';
const VERSION = '2026.10-area-addon-1';
const ACTION = 'area_addon_protocol_rows';
const MIGRATION = '20261010120000_area_addon_protocol_rows';

// Frozen at landing, like every protocol migration. The catalog product is found by this name (exact, then alias).
const ADDONS = [
  { visit: 1, serviceKey: 'area_addon_bed_pre_emergent', product: 'Snapshot 2.5TG', ratePer1000: 3.45, rateUnit: 'lb', maxPerYear: 4, minDaysApart: 60, requiresGrass: null, title: 'Bed pre-emergent (one-time add-on)', goal: 'One granular pre-emergent application to the landscape beds.' },
  { visit: 2, serviceKey: 'area_addon_lawn_insect_spot', product: 'Arena 50 WDG', ratePer1000: 0.147, rateUnit: 'oz', maxPerYear: 2, minDaysApart: 56, requiresGrass: 'st_augustine', title: 'Lawn insect spot (one-time add-on)', goal: 'One insect spot treatment of damaged St. Augustine turf and its green edge.' },
  { visit: 3, serviceKey: 'area_addon_fire_ant_yard', product: 'Topchoice Granular Insecticide', ratePer1000: 2, rateUnit: 'lb', maxPerYear: 1, minDaysApart: null, requiresGrass: null, title: 'Fire ant yard (one-time add-on)', goal: 'One broadcast fire ant granule application across the lawn.' },
  { visit: 4, serviceKey: 'area_addon_lawn_insect_preventive', product: 'Acelepryn Insecticide', ratePer1000: 0.184, rateUnit: 'fl_oz', maxPerYear: 1, minDaysApart: null, requiresGrass: null, title: 'Yearly lawn insect preventive (one-time add-on)', goal: 'One yearly preventive insect spray across the lawn.' },
  { visit: 5, serviceKey: 'area_addon_hardscape_weed', product: 'Roundup QuikPro SC', ratePer1000: 16, rateUnit: 'fl_oz', maxPerYear: 2, minDaysApart: null, requiresGrass: null, title: 'Hard-surface weed control (one-time add-on)', goal: 'One weed-kill spray on hard surfaces and bare ground.' },
];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TABLES = ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log', 'products_catalog'];

// What the gate and the counter say for one add-on (the same numbers the program and AREA_ADDONS carry).
const gatesOf = (a) => ({ trigger: 'area_addon_sold', addOnServiceKey: a.serviceKey, ...(a.requiresGrass ? { requiresGrass: a.requiresGrass } : {}) });
const counterOf = (a) => ({ maxApplications: a.maxPerYear, windowMonths: 12, ...(a.minDaysApart ? { minDaysApart: a.minDaysApart } : {}) });

async function hasTables(knex) {
  for (const table of TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false)).find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

exports.PROTOCOL_KEY = PROTOCOL_KEY;
exports.VERSION = VERSION;
exports.ADDONS = ADDONS;
exports.gatesOf = gatesOf;
exports.counterOf = counterOf;

exports.up = async function up(knex) {
  if (!(await hasTables(knex))) return;
  let protocol = await knex('lawn_protocols').where({ protocol_key: PROTOCOL_KEY, version: VERSION }).first('id');
  const written = { protocol: null, windows: [], products: [] };
  if (!protocol) {
    const [made] = await knex('lawn_protocols').insert({
      protocol_key: PROTOCOL_KEY,
      version: VERSION,
      name: 'Area Add-On Treatments',
      region: 'swfl',
      grass_track: 'area_addon',
      status: 'active',
      effective_from: '2026-10-08',
      operating_sentence: 'One-time add-on treatments sold on an estimate, one application each, routed by catalog service key. The label rate depends on the treated area; the card computes no tank amount.',
      default_carriers: JSON.stringify({}),
      production_rules: JSON.stringify({ oneTime: true, routedBy: 'catalog_service_key', calendarWindow: false, source: 'config/protocols.json area_addon' }),
      required_profile_fields: JSON.stringify([]),
      source_refs: JSON.stringify([{ type: 'program', ref: 'server/config/protocols.json#area_addon' }, { type: 'pricing', ref: 'AREA_ADDONS (pricing-engine/constants.js)' }]),
    }).returning('id');
    protocol = { id: made && (made.id || made) };
    written.protocol = protocol.id;
  }
  for (const a of ADDONS) {
    let window = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id, window_key: a.serviceKey }).first('id');
    if (!window) {
      const [made] = await knex('lawn_protocol_windows').insert({
        lawn_protocol_id: protocol.id,
        month: 0,
        window_key: a.serviceKey,
        title: a.title,
        visit_type: 'area_addon',
        goal: a.goal,
        production_mode: 'area_sold',
        sort_order: a.visit,
      }).returning('id');
      window = { id: made && (made.id || made) };
      written.windows.push(window.id);
    }
    if (await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).first('id')) continue;
    const productId = await resolveProductId(knex, a.product);
    if (!productId) console.log(`[area-addon-protocol-rows] no catalog row or alias for ${a.product}; its protocol row is written by name only`);
    const [made] = await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: window.id,
      product_id: productId,
      product_name: a.product,
      role: 'area_addon',
      application_mode: 'area',
      rate_per_1000: a.ratePer1000,
      rate_unit: a.rateUnit,
      carrier_gal_per_1000: null,
      default_in_plan: false,
      gates: JSON.stringify(gatesOf(a)),
      annual_counter: JSON.stringify(counterOf(a)),
      mixing: JSON.stringify({}),
      report_copy: JSON.stringify({ role: 'area_addon', serviceKey: a.serviceKey }),
      sort_order: 1,
    }).returning('id');
    written.products.push(made && (made.id || made));
  }
  if (!written.protocol && !written.windows.length && !written.products.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: protocol.id,
    actor_name: `migration ${MIGRATION.slice(0, 14)}`,
    entity_type: 'protocol',
    entity_id: protocol.id,
    action: ACTION,
    changed_fields: JSON.stringify(['protocol', 'windows', 'products']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify(written),
    metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_AREA_ADDONS' }),
  });
};

const asObject = (value) => {
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
};

exports.down = async function down(knex) {
  if (!(await hasTables(knex))) return;
  const audits = await knex('lawn_protocol_audit_log').where({ action: ACTION });
  for (const audit of audits) {
    const written = asObject(audit.after_snapshot);
    for (const id of written.products || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first('role', 'default_in_plan', 'rate_per_1000', 'rate_unit');
      if (row && row.role === 'area_addon' && !row.default_in_plan) await knex('lawn_protocol_products').where({ id }).del();
    }
    for (const id of written.windows || []) {
      const window = await knex('lawn_protocol_windows').where({ id }).first('visit_type');
      if (!window || window.visit_type !== 'area_addon') continue;
      if (!(await knex('lawn_protocol_products').where({ lawn_protocol_window_id: id }).first('id'))) await knex('lawn_protocol_windows').where({ id }).del();
    }
    if (written.protocol && !(await knex('lawn_protocol_windows').where({ lawn_protocol_id: written.protocol }).first('id'))) {
      await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
      await knex('lawn_protocols').where({ id: written.protocol, protocol_key: PROTOCOL_KEY }).del();
    } else {
      await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
    }
  }
};
