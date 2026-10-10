/**
 * Lawn protocol v13 matrix adds: alias-resolved catalog rows and the Advion limits.
 *
 * Two things the earlier migrations in this chain left open:
 *
 * 1. Headway and Advion catalog facts. 180000 does not insert a catalog row when `resolveProductId`
 *    finds one (by normalized name, or by an alias). 181000 to 186000 then look the row up by the exact
 *    canonical name, so a row found only through its alias (or a differently cased name) kept empty
 *    facts: Headway its FRAC group, rate, EPA number, watering rule and report text; Advion its EPA
 *    number, label rates, watering rule and report text. Here the row is resolved the same way 180000
 *    resolved it and the same facts go into EMPTY fields only. A row that is then freeze-ready and was
 *    never approved for the service report is approved, as 185000 did for the production Headway row.
 *
 * 2. Advion limits. 182000 skipped a limit type when the product already had any row of that type,
 *    whatever its value. A weaker row (a shorter interval, more applications a year, a non-blocking
 *    severity, a non-product match) is now tightened to the label limit; a missing type is inserted.
 *    A row that is already as strict or stricter is left alone.
 *
 * Every change is recorded with its before-value. down() restores a field only while it still holds
 * the value written here.
 */
const crypto = require('crypto');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const fixes = require('./20261007181000_lawn_v13_matrix_adds_fixes');
const round2 = require('./20261007182000_lawn_v13_matrix_adds_round2');
const round3 = require('./20261007183000_lawn_v13_matrix_adds_round3');
const round4 = require('./20261007184000_lawn_v13_matrix_adds_round4');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const ACTION = 'v13_matrix_alias_rows_and_advion_limits';
const ACTOR = 'migration 20261007189500';
const MIGRATION = '20261007189500_lawn_v13_matrix_alias_rows_and_advion_limits';
const APPROVED = 'approved_for_service_report';
const HEADWAY_EPA = '100-1216';

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isEmpty = (value) => value == null || String(value).trim() === '';
const isFlOz = (value) => normalize(value) === 'fl oz';
const validEpa = (value) => !isEmpty(value) && !/^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(String(value).trim());
const factFill = (name) => round4.FACTS.find((fact) => fact.name === name).fill;

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// The facts each product needs; a function of the row where one fact depends on another.
const PRODUCTS = [
  {
    name: matrix.HEAD,
    rule: matrix.WATERING.find((item) => item.name === matrix.HEAD).rule,
    facts: (row) => ({
      ...factFill(matrix.HEAD),
      epa_reg_number: HEADWAY_EPA,
      frac_group: round3.HEADWAY_FRAC,
      rate_unit: round3.HEADWAY_UNIT,
      // The 3 fl oz rate only where the row's unit is empty or already fl oz.
      ...(isEmpty(row.rate_unit) || isFlOz(row.rate_unit) ? { default_rate_per_1000: round3.HEADWAY_RATE } : {}),
    }),
  },
  {
    name: matrix.ADVION,
    rule: fixes.ADVION_RULE,
    facts: () => ({
      ...factFill(matrix.ADVION),
      epa_reg_number: fixes.ADVION_EPA,
      max_label_rate_per_1000: fixes.ADVION_LABEL_RATE,
      max_annual_per_1000: fixes.ADVION_ANNUAL_RATE,
    }),
  },
];

// Exact catalog name (active rows first), else an exact alias: the lookup 180000 used.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

// Every fact the freeze reads is present: a valid EPA number, a stored valid watering rule, a type and a summary.
function freezeReady(row) {
  const rule = row.post_application_watering != null ? validateRule(row.post_application_watering) : { valid: false };
  return validEpa(row.epa_reg_number) && rule.valid && !isEmpty(row.product_type) && !isEmpty(row.service_report_summary);
}

async function fillFacts(knex, product, columns) {
  const id = await resolveProductId(knex, product.name);
  if (!id) return null;
  const row = await knex('products_catalog').where({ id }).first();
  if (!row) return null;
  const update = {};
  const fields = {};
  const set = (column, after, stored = after) => { update[column] = stored; fields[column] = { before: row[column] ?? null, after }; };
  for (const [column, value] of Object.entries(product.facts(row))) {
    if (column in columns && isEmpty(row[column])) set(column, value);
  }
  if ('post_application_watering' in columns && row.post_application_watering == null) {
    set('post_application_watering', product.rule, JSON.stringify(product.rule));
  }
  if (APPROVED in columns && !row[APPROVED] && freezeReady({ ...row, ...update })) set(APPROVED, true);
  if (!Object.keys(update).length) return null;
  await knex('products_catalog').where({ id }).update({ ...update, updated_at: knex.fn.now() });
  return { id, name: row.name, fields };
}

// ── Advion limits ────────────────────────────────────────────────────────────

// A minimum interval is weaker when shorter; a yearly count is weaker when higher.
function weaker(row, spec) {
  const value = Number(row.limit_value);
  if (!Number.isFinite(value)) return true;
  return spec.limit_type === 'min_interval_days' ? value < spec.limit_value : value > spec.limit_value;
}

// The row enforces the label limit for this product: a hard block, matched on the product, in the label's unit.
function enforces(row, spec) {
  return row.severity === spec.severity && (row.match_type == null || row.match_type === 'product')
    && normalize(row.limit_unit) === normalize(spec.limit_unit) && !weaker(row, spec);
}

async function tightenAdvionLimits(knex) {
  if (!(await knex.schema.hasTable('product_limits'))) return null;
  const productId = await resolveProductId(knex, matrix.ADVION);
  if (!productId) return null;
  const inserted = [];
  const updated = [];
  for (const spec of round2.ADVION_LIMITS) {
    const rows = await knex('product_limits').where({ product_id: productId, limit_type: spec.limit_type }).orderBy('created_at');
    if (rows.some((row) => enforces(row, spec))) continue;
    const target = { match_type: 'product', ...spec };
    if (!rows.length) {
      const [made] = await knex('product_limits').insert({ product_id: productId, ...target }).returning('id');
      inserted.push({ id: made && typeof made === 'object' ? made.id : made, product_id: productId, ...target });
      continue;
    }
    // Tighten the first row of this type; the other rows of the type stay as they are.
    const row = rows[0];
    const before = Object.fromEntries(Object.keys(target).map((field) => [field, row[field] ?? null]));
    await knex('product_limits').where({ id: row.id }).update({ ...target, updated_at: knex.fn.now() });
    updated.push({ id: row.id, before, after: target });
  }
  return inserted.length || updated.length ? { productId, inserted, updated } : null;
}

const REQUIRED = ['products_catalog', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const columns = await knex('products_catalog').columnInfo();
  const catalog = [];
  for (const product of PRODUCTS) {
    const change = await fillFacts(knex, product, columns);
    if (change) catalog.push(change);
  }
  const limits = await tightenAdvionLimits(knex);
  if (!catalog.length && !limits) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify([...(catalog.length ? ['catalog'] : []), ...(limits ? ['limits'] : [])]),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ catalog, limits }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── Down ─────────────────────────────────────────────────────────────────────

// limit_value is a pg decimal ('84.0000'): numbers compare as numbers; jsonb compares as parsed JSON.
function sameValue(current, written) {
  if (written != null && typeof written === 'object') return JSON.stringify(asObject(current)) === JSON.stringify(written);
  if (typeof written === 'number') return Number(current) === written;
  if (typeof written === 'boolean') return Boolean(current) === written;
  return String(current ?? '') === String(written ?? '');
}

async function revertCatalog(knex, change) {
  const row = await knex('products_catalog').where({ id: change.id }).first();
  if (!row) return;
  const update = {};
  for (const [column, { before, after }] of Object.entries(change.fields || {})) {
    if (!sameValue(row[column], after)) continue;
    update[column] = before != null && typeof before === 'object' ? JSON.stringify(before) : before;
  }
  if (Object.keys(update).length) await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
}

async function revertLimits(knex, limits) {
  if (!limits || !(await knex.schema.hasTable('product_limits'))) return;
  for (const written of limits.inserted || []) {
    const { id, ...fields } = written;
    const row = await knex('product_limits').where({ id }).first();
    if (row && Object.entries(fields).every(([field, value]) => sameValue(row[field], value))) await knex('product_limits').where({ id }).del();
  }
  for (const change of limits.updated || []) {
    const row = await knex('product_limits').where({ id: change.id }).first();
    if (row && Object.entries(change.after).every(([field, value]) => sameValue(row[field], value))) {
      await knex('product_limits').where({ id: change.id }).update({ ...change.before, updated_at: knex.fn.now() });
    }
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    for (const change of after.catalog || []) await revertCatalog(knex, change);
    await revertLimits(knex, after.limits);
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.PRODUCTS = PRODUCTS;
