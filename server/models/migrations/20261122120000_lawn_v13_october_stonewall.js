/**
 * Lawn protocol v13: the October spreader product becomes LESCO Stonewall 0.37% 18-0-10
 * (owner 2026-11-21, "stonewall"). The same swap shape as 20261007120500, which moved October
 * from Stonewall 15-0-15 to the Dimension granular.
 *
 * What changes. Each v13 protocol's October step (window oct_v13_spreader_fall, all grass
 * tracks) goes from LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus
 * Fertilizer (dithiopyr, EPA 10404-87) to LESCO Stonewall 0.37% 18-0-10 (prodiamine, EPA
 * 10404-114), at the SAME rate: 4.04 lb of product per 1,000 sq ft, spreader. Same analysis, so
 * the same 0.73 lb N and 0.4 lb K2O per 1,000 sq ft. Prodiamine: 4.04 x 43.56 x 0.0037 =
 * 0.65 lb ai per acre.
 *
 * Out of scope, left exactly as it is: the 9x April step and the North Port March swap (both
 * stay on the Dimension granular), January Stonewall 4FL, March and June Dimension 2EW, every
 * price field, every catalog row's label, watering and report fields, and every product_limits
 * row that already exists. A 9-visit lawn already gets January Stonewall 4FL (0.68 lb prodiamine
 * per acre) and October (0.65); a third prodiamine application (April, 0.45) would pass the
 * label's yearly maximum, so April stays dithiopyr.
 *
 * The label (EPA accepted label 10404-114, May 1 2020):
 *   - at most 405 lb of product per acre = 9.3 lb per 1,000 sq ft = 1.5 lb ai per acre in a
 *     calendar year on bermudagrass, bahiagrass, centipedegrass, seashore paspalum,
 *     St. Augustinegrass, tall fescue and zoysia ("Do not apply more than 1.5 lb a.i. per
 *     calendar year per acre");
 *   - listed rates: 135 lb/A = 3.1 lb per 1,000 = 0.50 lb ai/A; 176 = 4.0 = 0.65; 203 = 4.7 = 0.75;
 *     270 = 6.2 = 1.0; 405 = 9.3 = 1.5. Single or sequential applications are allowed inside
 *     the yearly maximum; the label states no other per-application maximum, no maximum number
 *     of applications and no minimum interval;
 *   - activation: at least 0.5 inch of rainfall or irrigation within 14 days after application.
 *     Not for new or overseeded turf within 60 days of seeding or before the second mowing.
 *     It does not control established weeds.
 * Year total, both plans: January Stonewall 4FL 0.5 fl oz per 1,000 sq ft (0.68 lb ai per acre)
 * plus this step (0.65) = 1.33 lb prodiamine per acre, under 1.5. October no longer carries
 * dithiopyr.
 *
 * What this writes. It acts only on a row that is still EXACTLY the October row 20261007120500
 * wrote: the Dimension granular by name and product id, at 4.04 lb, with its dithiopyr counter.
 * Any other state (renamed, re-rated, already Stonewall, no Stonewall catalog row)
 * is left as it is and logged.
 *   1. The row: product name, product id, the N and K2O gate text (values unchanged), the
 *      annual counter (prodiamine_lb_per_1000, the granular's own unit; the staged Stonewall
 *      4FL rows count prodiamine_oz_per_1000). report_copy holds only the row's role, never a
 *      product name, so it is not touched.
 *   2. The window goal text, only while it still reads the 10-07 text.
 *   3. The Stonewall product id is resolved ONCE (exact catalog name, else an exact alias). The
 *      row exists in production but not in a database built from migrations alone (CI, a dev
 *      copy): where neither a name nor an alias matches, the catalog row is INSERTED with the
 *      production values (the insert style of 20261005130000), so every database ends on the
 *      same October product. Customer-copy and approval columns keep their defaults (the owner
 *      approves them). A catalog row that exists is NEVER updated.
 *      No row to swap = no lookup and no write.
 *   4. The yearly prodiamine cap row (annual_max_rate, active_ingredient prodiamine, 1.5 lb ai
 *      per acre written as 9.3068 lb of this bag per 1,000 sq ft) is inserted only where the
 *      Stonewall product has none. Production has it; a database that lacks it gets it. The
 *      4FL cap and every other limit row are never changed.
 * Chemical group: no write. The production Stonewall row holds its group in the older free-text
 * column (moa_group 'Group 3', hrac_group NULL), as the liquid pre-emergents do. The rotation
 * check's pre_emergent_group_3 exemption (waveguard-approval-engine) reads the group from either
 * column, so the October bag after a Group 3 pre-emergent raises no approval block.
 *
 * Idempotent: a second run finds no Dimension row to swap and writes nothing. One
 * 'v13_october_stonewall' audit row per protocol records each value before and after; one
 * 'v13_october_stonewall_catalog' row records the inserted catalog row and the inserted cap row.
 *
 * down(), exact-equality guarded:
 *   - a row goes back only while it is still the Stonewall row this wrote (name and product id),
 *     and each column and gate key only while it holds the written value; the window goal only
 *     while it reads the new text;
 *   - a protocol that a scheduled visit or a completion references is NOT touched (the staging
 *     migration's guard): the rollback logs and leaves it, its audit row and the cap row;
 *   - when no protocol was left: an inserted cap row goes only while every field still equals
 *     what was inserted; a catalog row this migration INSERTED is deleted only while nothing
 *     references it (no foreign key, no protocol row, no application).
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const octoberDimension = require('./20261007120500_lawn_v13_october_dimension');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_october_stonewall';
const CATALOG_ACTION = 'v13_october_stonewall_catalog';
const OCTOBER_WINDOW = 'oct_v13_spreader_fall';
const OLD_NAME = octoberDimension.NEW_NAME;
const NEW_NAME = 'LESCO Stonewall 0.37% 18-0-10';

const OCT_RATE = octoberDimension.OCT_RATE; // 4.04 lb per 1,000 sq ft, unchanged
const OLD_GOAL = octoberDimension.NEW_GOAL;
const NEW_GOAL = 'Stonewall 18-0-10 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.';
const OLD_COUNTER_KEY = octoberDimension.NEW_GATES.annualCounter; // 'dithiopyr_lb_per_1000'
const NEW_COUNTER_KEY = 'prodiamine_lb_per_1000';
// The N and K2O text is the same bag analysis at the same rate (4.04 lb x 18% = 0.73 lb N; x 10% = 0.40 lb K2O).
const NEW_GATES = { targetN: octoberDimension.NEW_GATES.targetN, targetK2O: octoberDimension.NEW_GATES.targetK2O, annualCounter: NEW_COUNTER_KEY };
const JSON_COLUMNS = new Set(['annual_counter']);

// Label: 1.5 lb ai per acre per year. 1.5 / 43.56 = 0.034435 lb ai per 1,000 sq ft; the bag holds 0.37% prodiamine.
const STRENGTH = 0.0037;
const CAP_VALUE = Math.round((1.5 / 43.56 / STRENGTH) * 10000) / 10000; // 9.3068 lb of bag per 1,000 sq ft per year
const CAP_SPEC = {
  match_type: 'active_ingredient',
  match_value: 'prodiamine',
  limit_type: 'annual_max_rate',
  limit_value: CAP_VALUE,
  limit_unit: 'lb/1000sf/year',
  severity: 'hard_block',
  description: `Prodiamine yearly cap, all products: 1.5 lb ai/acre/year (EPA 10404-114 label: 405 lb of product per acre = 9.3 lb per 1,000 sq ft), written as ${CAP_VALUE} lb of ${NEW_NAME} per 1,000 sq ft. Every prodiamine product shares this one cap.`,
};

// The production row, read 2026-11-21. Inserted only where no row has this exact name and no alias spells it.
// Customer-copy and approval columns (content_status, customer_visibility, approved_for_service_report, ...)
// keep their column defaults: production has them already and the approval is the owner's.
// The label water-in rule is the one 20261022120000 stores for this name. analysis_n/p/k is the bag's guaranteed
// analysis (18-0-10, in its name): the production row does not hold it (nor does production's Dimension granular row),
// but the Dimension row of a migration-built database does (20261005130000), so the two bags read alike there.
const CATALOG_ROW = {
  name: NEW_NAME,
  category: 'herbicide',
  subcategory: 'Pre-emergent + fertilizer combo',
  active_ingredient: 'Prodiamine 0.37% + 18-0-10',
  moa_group: 'Group 3',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  epa_reg_number: '10404-114',
  default_rate_per_1000: 3.1,
  min_label_rate_per_1000: 3.1,
  max_label_rate_per_1000: 9.3,
  rate_unit: 'lb',
  analysis_n: 18,
  analysis_p: 0,
  analysis_k: 10,
  service_lines: JSON.stringify(['lawn']),
  post_application_watering: JSON.stringify({
    mode: 'water_in',
    source: 'label',
    label_note: 'Label: "activated by at least 0.5 inch of rainfall or irrigation prior to weed seed germination and within 14 days following application."',
    verified_at: '2026-10-22T00:00:00.000Z',
    verified_by: 'label-check-2026-10-22',
    water_in_inches: 0.5,
    water_in_by_hours: 336,
  }),
  active: true,
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), JSON deeply.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

// Exact catalog name (active rows first), else an exact alias; null when neither exists.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

// ── Staged rows ──────────────────────────────────────────────────────────────

// Writes `columns` and `gateKeys` onto a staged row and returns what it recorded:
// every value before and after, read BEFORE the write.
async function patchRow(knex, row, columns, gateKeys) {
  const gates = asObject(row.gates);
  const record = { rowId: row.id, guard: { product_name: columns.product_name, product_id: columns.product_id }, columns: {}, gates: {} };
  const update = { updated_at: knex.fn.now() };
  for (const [column, after] of Object.entries(columns)) {
    const current = JSON_COLUMNS.has(column) ? asObject(row[column]) : (row[column] ?? null);
    record.columns[column] = { before: current, after };
    update[column] = JSON_COLUMNS.has(column) ? JSON.stringify(after) : after;
  }
  const next = { ...gates };
  for (const [key, after] of Object.entries(gateKeys)) {
    record.gates[key] = { had: key in gates, before: gates[key] ?? null, after };
    next[key] = after;
  }
  update.gates = JSON.stringify(next);
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
  return record;
}

// Puts back each column and gate key of a record that still holds the written value, and
// only on a row that is still the Stonewall row this wrote.
async function revertRow(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  const { product_name: name, product_id: productId } = record.guard;
  if (!row || row.product_name !== name || String(row.product_id) !== String(productId)) return;
  const update = { updated_at: knex.fn.now() };
  for (const [column, change] of Object.entries(record.columns || {})) {
    if (!same(row[column], change.after)) continue;
    update[column] = JSON_COLUMNS.has(column) ? JSON.stringify(change.before) : change.before;
  }
  const gates = asObject(row.gates);
  for (const [key, change] of Object.entries(record.gates || {})) {
    if (!isDeepStrictEqual(gates[key], change.after)) continue;
    if (change.had) gates[key] = change.before; else delete gates[key];
  }
  update.gates = JSON.stringify(gates);
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
}

// Is this staged row exactly the October row 20261007120500 wrote?
function isDimensionOctoberRow(row, dimensionId) {
  if (row.product_name !== OLD_NAME || !dimensionId || String(row.product_id) !== String(dimensionId)) return false;
  if (!same(row.rate_per_1000, OCT_RATE)) return false;
  return asObject(row.annual_counter).counter === OLD_COUNTER_KEY && asObject(row.gates).annualCounter === OLD_COUNTER_KEY;
}

// The October rows to swap: { protocolId, window, row } per v13 protocol. A protocol whose row is
// anything else is logged and left.
async function findSwaps(knex, dimensionId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  const known = new Map(protocols.map((protocol) => [String(protocol.id), protocol]));
  const windows = (await knex('lawn_protocol_windows').where({ window_key: OCTOBER_WINDOW }).select('id', 'lawn_protocol_id', 'goal'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  const swaps = [];
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id })
      .select('id', 'product_id', 'product_name', 'rate_per_1000', 'gates', 'annual_counter');
    if (rows.some((row) => row.product_name === NEW_NAME)) continue;
    const candidates = rows.filter((row) => row.product_name === OLD_NAME);
    const exact = candidates.length === 1 && isDimensionOctoberRow(candidates[0], dimensionId) ? candidates[0] : null;
    if (!exact) {
      console.log(`[lawn-v13-october-stonewall] protocol ${known.get(String(window.lawn_protocol_id)).protocol_key}: the October row is not the Dimension row 20261007120500 wrote; left as it is`);
      continue;
    }
    swaps.push({ protocolId: window.lawn_protocol_id, window, row: exact });
  }
  return swaps;
}

// Inserts the yearly prodiamine cap for `productId` only where it has none; returns what it inserted.
async function insertCapIfMissing(knex, productId) {
  const have = await knex('product_limits')
    .where({ product_id: productId, match_type: CAP_SPEC.match_type, match_value: CAP_SPEC.match_value, limit_type: CAP_SPEC.limit_type }).first('id');
  if (have) return [];
  const row = { product_id: productId, ...CAP_SPEC };
  const [made] = await knex('product_limits').insert(row).returning('id');
  return [{ id: made && typeof made === 'object' ? made.id : made, ...row }];
}

// Inserts the catalog row (production values) and returns its id.
async function insertCatalogRow(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const row = Object.fromEntries(Object.entries(CATALOG_ROW).filter(([column]) => column in columns));
  const [made] = await knex('products_catalog').insert({ ...row, created_at: knex.fn.now(), updated_at: knex.fn.now() }).returning('id');
  return made && typeof made === 'object' ? made.id : made;
}

const REQUIRED_TABLES = [
  'products_catalog', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log',
];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const dimensionId = await resolveProductId(knex, OLD_NAME);
  const swaps = dimensionId ? await findSwaps(knex, dimensionId) : [];
  if (!swaps.length) return;
  let stonewallId = await resolveProductId(knex, NEW_NAME);
  let insertedProductId = null;
  if (!stonewallId) {
    // The row lives in production; a database built from migrations alone has none: insert it, never update one that exists.
    stonewallId = await insertCatalogRow(knex);
    insertedProductId = stonewallId;
  }

  for (const { protocolId, window, row } of swaps) {
    const counter = { ...asObject(row.annual_counter), counter: NEW_COUNTER_KEY };
    const record = await patchRow(knex, row, { product_name: NEW_NAME, product_id: stonewallId, annual_counter: counter }, NEW_GATES);
    let goalWindowId = null;
    if (window.goal === OLD_GOAL) {
      await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal: NEW_GOAL, updated_at: knex.fn.now() });
      goalWindowId = window.id;
    }
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261122120000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION,
      changed_fields: JSON.stringify(['products', 'goal']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows: [record], goalWindowId, oldGoal: OLD_GOAL, newGoal: NEW_GOAL }),
      metadata: JSON.stringify({ migration: '20261122120000_lawn_v13_october_stonewall', gate: 'GATE_LAWN_V13' }),
    });
  }

  const caps = await insertCapIfMissing(knex, stonewallId);
  if (caps.length || insertedProductId) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: 'migration 20261122120000',
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['catalog', 'limits']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ productId: stonewallId, insertedProductId, caps }),
      metadata: JSON.stringify({ migration: '20261122120000_lawn_v13_october_stonewall' }),
    });
  }
};

// ── Down ─────────────────────────────────────────────────────────────────────

// A protocol a scheduled visit or a completion points at: the staging migration's own guard.
async function protocolReferenced(knex, protocol) {
  if (await knex.schema.hasTable('scheduled_services')) {
    const visit = await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id');
    if (visit) return true;
  }
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  const completion = await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id');
  return Boolean(completion);
}

// Reverts one protocol's audit record; returns true when the protocol was left because it is referenced.
async function revertProtocol(knex, log) {
  const after = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-october-stonewall] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  for (const record of after.rows || []) await revertRow(knex, record);
  if (after.goalWindowId) {
    const window = await knex('lawn_protocol_windows').where({ id: after.goalWindowId }).first('id', 'goal');
    if (window && window.goal === after.newGoal) await knex('lawn_protocol_windows').where({ id: window.id }).update({ goal: after.oldGoal, updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

// Deletes an inserted limit row only while every field still equals what was inserted.
async function removeInsertedLimit(knex, written) {
  const row = await knex('product_limits').where({ id: written.id }).first();
  if (!row) return;
  const fields = ['product_id', 'match_type', 'match_value', 'limit_type', 'limit_value', 'limit_unit', 'severity', 'description'];
  if (fields.every((field) => same(row[field] ?? null, written[field] ?? null))) await knex('product_limits').where({ id: written.id }).del();
}

// Is any row pointing at the product? Every foreign key to products_catalog, plus the tables a test schema clones without keys.
async function productReferenced(knex, productId) {
  const keys = (await knex.raw(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'products_catalog'::regclass`)).rows;
  const spots = new Map(keys.map((key) => [`${key.tbl}.${key.col}`, key]));
  for (const key of [{ tbl: 'lawn_protocol_products', col: 'product_id' }, { tbl: 'property_application_history', col: 'product_id' },
    { tbl: 'service_products', col: 'product_id' }, { tbl: 'product_limits', col: 'product_id' }, { tbl: 'product_aliases', col: 'product_id' }]) spots.set(`${key.tbl}.${key.col}`, key);
  for (const { tbl, col } of spots.values()) {
    const table = String(tbl).replace(/^"?[^".]+"?\./, '').replace(/"/g, '');
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex(table).where({ [col]: productId }).first(col)) return true;
  }
  return false;
}

async function revertCatalog(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { insertedProductId, caps = [] } = asObject(log.after_snapshot);
    for (const written of caps) await removeInsertedLimit(knex, written);
    if (insertedProductId) {
      const row = await knex('products_catalog').where({ id: insertedProductId }).first('id', 'name');
      if (row && row.name === NEW_NAME && !(await productReferenced(knex, insertedProductId))) await knex('products_catalog').where({ id: insertedProductId }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  let kept = 0;
  for (const log of logs) if (await revertProtocol(knex, log)) kept += 1;
  if (kept) {
    console.log('[lawn-v13-october-stonewall] catalog row and cap row kept: a protocol still uses the Stonewall row');
    return;
  }
  await revertCatalog(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.OCT_RATE = OCT_RATE;
exports.OLD_GOAL = OLD_GOAL;
exports.NEW_GOAL = NEW_GOAL;
exports.OLD_COUNTER_KEY = OLD_COUNTER_KEY;
exports.NEW_COUNTER_KEY = NEW_COUNTER_KEY;
exports.NEW_GATES = NEW_GATES;
exports.CAP_SPEC = CAP_SPEC;
exports.CATALOG_ROW = CATALOG_ROW;
exports.CAP_VALUE = CAP_VALUE;
