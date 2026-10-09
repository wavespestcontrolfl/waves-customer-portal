/**
 * Lawn protocol v13, final advisor pass: the staged rows (owner 2026-10-09, "fix them"; review in
 * lawn-program-scope-20261001/fable-advice-20261009-v13-final-pass.md). ONE migration, written so that it needs no follow-up
 * file: every row it writes is read back and kept in the audit row, and down() restores only what it still finds as written.
 * The recipe file (lawn-protocol-v13.json) carries the same wording; the count caps and yearly amounts live in code
 * (config/lawn-v13-count-caps.js), so no product_limits row is written.
 *
 * What this writes, on EVERY v13 protocol (version 2026.10-v13, whatever the grass track or status).
 *
 *   1. Blindside rate. Label (Blindside, EPA Reg. No. 279-3411): a single application is 0.075 to 0.23 oz per 1,000 sq ft
 *      (3.25 to 10 oz per acre) and "do not exceed 10 oz. product per acre per year" = 0.23 oz per 1,000 sq ft, so two passes a
 *      year are legal only at 0.115 oz. Every ACTIVE Blindside row that is still at its staged state (no rate, unit
 *      'label_rate') becomes 0.115 'oz' (the unit the Celsius rows use). A retired row (gates.retired true) is not touched, and
 *      a row somebody already gave another rate or unit is left and logged: a stored edit is never overwritten.
 *   2. November weed spots. The program rule is "Blindside November through March" and the recipe's November visit now lists the
 *      December weed lines, but the November window had no weed rows. In the November window (nov_v13_spreader_feeding) each of
 *      Celsius WG, Certainty Turf Herbicide, LESCO 90/10 Nonionic Surfactant and Blindside Herbicide that the December window
 *      (dec_v13_spreader_feeding) carries as an ACTIVE row is inserted with the exact shape of that December row (role, mode,
 *      rate, unit, carrier, default_in_plan, gates, annual_counter, mixing, report_copy), Blindside at 0.115 oz, sort_order after
 *      the window's rows in the December order. Insert-if-missing: a window that already holds the product (active or retired,
 *      by id or by name) gets nothing.
 *   The Pythium line is recipe text only (owner ruling 2026-10-09): Artavia twice in a row stays, as a named exception to the group
 *   rule, because Headway is azoxystrobin + propiconazole (FRAC 11 + 3), so it would repeat group 11 too, and nothing else in the kit
 *   is a Pythium product. No Pythium row is written.
 *   The Topchoice scrub-jay setback (500 ft from habitat of the Florida scrub jay, bluetail mole skink and sand skink) is
 *   recipe text only: the Topchoice rows' gates are guarded by exact equality in four pushed migrations (20261009100000 to
 *   20261009103000), and no window or row field carries office notes for the add-on, so nothing is written for it here.
 *
 * Every product is resolved by exact catalog name (active rows first), else an exact alias. A product that cannot be resolved
 * skips its write with a log line. A table that does not exist skips the whole migration.
 *
 * Idempotent: a second run finds the rates at 0.115 and the rows in place and writes nothing. One 'v13_final_pass' audit row per
 * protocol that changed records the ids and the values before and after; each inserted row's columns are read back after the
 * insert and kept, because down() deletes it only while every one of them still reads that way.
 *
 * Why the older down() guards still hold. Only two columns of an existing row change: rate_per_1000 and rate_unit of a Blindside
 * row (the staged state becomes 0.115 oz). The downs that touch Blindside rows read other columns: 20261007179000 deletes
 * its inserted row only while product_name, default_in_plan, gates.trigger, gates.annualMaxApps and
 * annual_counter.maxApplications are what it wrote (no rate); 20261005140000 deletes by id and name; 20261007175000 and 20261007177000
 * remove or restore gates.annualMaxApps and annual_counter.maxApplications by row id; 20261008130000 and 20261008132000 un-retire
 * a row by gates.retired only; the fire ant migrations (20261009100000 to 20261009103000) read Topchoice and Advion rows. None reads
 * a Blindside rate, so they behave as before. The inserted rows are new ids no older audit row lists, and every older down() acts on
 * the ids it recorded. A rollback of this migration runs first (newest first).
 *
 * down(), exact-equality guarded:
 *   - a protocol that a scheduled visit or a completion references is NOT touched (the staging migration's guard): logged, left,
 *     its audit row too;
 *   - an inserted row is deleted only while EVERY column this wrote still holds what the database read right after the insert and
 *     no completion actual references it; a Blindside rate goes back to its value before only while the row still holds the
 *     written rate and unit. Anything else (a rate, a gate or a name edited since) leaves the whole protocol and its audit row as
 *     they are. A row staff deleted is not a blocker: there is nothing left to delete or restore.
 */

const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_final_pass';
const ACTOR = 'migration 20261009150000';
const MIGRATION = '20261009150000_lawn_v13_final_pass';
const LOG = '[lawn-v13-final-pass]';

const N = staged.NAMES;
const BLINDSIDE = 'Blindside Herbicide';

const WINDOWS = { NOV: 'nov_v13_spreader_feeding', DEC: 'dec_v13_spreader_feeding' };

// Blindside label EPA 279-3411: 0.075 to 0.23 oz per 1,000 sq ft a pass, no more than 0.23 oz per 1,000 sq ft a year.
const BLINDSIDE_RATE = 0.115;
const BLINDSIDE_UNIT = 'oz';
const STAGED_UNIT = 'label_rate';

// The December weed rows the November window gets, in the December order.
const WEED_NAMES = [N.CEL, N.CER, N.NIS, BLINDSIDE];

// Every column of an inserted protocol row that this migration sets. The audit row keeps what the database held for them right
// after the insert; down() deletes the row only while all of them still read that way.
const OWNED_COLUMNS = ['lawn_protocol_window_id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit', 'carrier_gal_per_1000',
  'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy', 'sort_order'];
const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isEmpty = (value) => value == null || String(value).trim() === '';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), JSON deeply, booleans as booleans.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// One catalog read and one alias read: name -> product id, active rows first, then an exact alias; null when neither exists.
async function loadResolver(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const byName = new Map();
  for (const row of [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))) {
    if (!byName.has(normalize(row.name))) byName.set(normalize(row.name), row.id);
  }
  const byAlias = new Map();
  if (await knex.schema.hasTable('product_aliases')) {
    for (const row of await knex('product_aliases').select('product_id', 'alias_name')) {
      if (!byAlias.has(normalize(row.alias_name))) byAlias.set(normalize(row.alias_name), row.product_id);
    }
  }
  return (name) => byName.get(normalize(name)) || byAlias.get(normalize(name)) || null;
}

const isRetired = (row) => asObject(row.gates).retired === true;
const isProduct = (row, name, id) => row.product_name === name || (id != null && String(row.product_id) === String(id));

// The protocol's products with their window key, one read.
function loadRows(knex, protocolId) {
  return knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where('w.lawn_protocol_id', protocolId)
    .orderBy(['w.month', 'p.sort_order', 'p.id'])
    .select('p.*', 'w.window_key');
}

// ── 1. Blindside rate ────────────────────────────────────────────────────────

const atRate = (row) => same(row.rate_per_1000, BLINDSIDE_RATE) && row.rate_unit === BLINDSIDE_UNIT;
const atStagedState = (row) => isEmpty(row.rate_per_1000) && (isEmpty(row.rate_unit) || row.rate_unit === STAGED_UNIT);

async function writeBlindsideRates(knex, rows, blindsideId, record) {
  for (const row of rows.filter((r) => isProduct(r, BLINDSIDE, blindsideId) && !isRetired(r) && !atRate(r))) {
    if (!atStagedState(row)) {
      record.skipped.push({ rowId: row.id, window: row.window_key, why: `Blindside row already states ${row.rate_per_1000} ${row.rate_unit}` });
      console.log(`${LOG} Blindside row ${row.id} (${row.window_key}) already states ${row.rate_per_1000} ${row.rate_unit}: left as it is`);
      continue;
    }
    // Guarded on the exact state read, so a concurrent edit is never overwritten.
    const query = knex('lawn_protocol_products').where({ id: row.id }).whereNull('rate_per_1000');
    if (row.rate_unit == null) query.whereNull('rate_unit'); else query.where('rate_unit', row.rate_unit);
    if (!(await query.update({ rate_per_1000: BLINDSIDE_RATE, rate_unit: BLINDSIDE_UNIT, updated_at: knex.fn.now() }))) continue;
    record.rates.push({
      rowId: row.id, window: row.window_key, product_name: row.product_name,
      before: { rate_per_1000: row.rate_per_1000 ?? null, rate_unit: row.rate_unit ?? null },
      after: { rate_per_1000: BLINDSIDE_RATE, rate_unit: BLINDSIDE_UNIT },
    });
  }
}

// ── 2. Inserted rows ───────────────────────────────────────────────────

// Inserts one row built from `shape` into `windowId`, after the window's rows in `rows` (which learns the new row, so the next insert
// sorts after it); returns the audit entry (the columns read back after the insert).
async function insertRow(knex, windowId, rows, productId, name, shape, kind) {
  const sortOrder = Math.max(0, ...rows.filter((row) => row.window_key === shape.windowKey).map((row) => Number(row.sort_order) || 0)) + 1;
  const [made] = await knex('lawn_protocol_products').insert({
    lawn_protocol_window_id: windowId,
    product_id: productId,
    product_name: name,
    role: shape.role,
    application_mode: shape.application_mode,
    rate_per_1000: shape.rate_per_1000,
    rate_unit: shape.rate_unit,
    carrier_gal_per_1000: shape.carrier_gal_per_1000,
    default_in_plan: shape.default_in_plan,
    gates: JSON.stringify(asObject(shape.gates)),
    annual_counter: JSON.stringify(asObject(shape.annual_counter)),
    mixing: JSON.stringify(asObject(shape.mixing)),
    report_copy: JSON.stringify(asObject(shape.report_copy)),
    sort_order: sortOrder,
  }).returning('id');
  const id = made && typeof made === 'object' ? made.id : made;
  const owned = await knex('lawn_protocol_products').where({ id }).first(OWNED_COLUMNS);
  rows.push({ id, window_key: shape.windowKey, product_id: productId, product_name: name, sort_order: sortOrder, gates: shape.gates });
  return { id, kind, windowKey: shape.windowKey, product_name: name, product_id: productId, owned };
}

// The row of `rows` in the window for the product, active ones first.
const findIn = (rows, windowKey, name, id) => rows
  .filter((row) => row.window_key === windowKey && isProduct(row, name, id))
  .sort((a, b) => Number(isRetired(a)) - Number(isRetired(b)))[0] || null;

async function writeNovemberWeeds(knex, protocol, rows, windows, resolve, record) {
  const window = windows.get(WINDOWS.NOV);
  if (!window) return;
  for (const name of WEED_NAMES) {
    const productId = resolve(name);
    if (!productId) {
      record.skipped.push({ window: WINDOWS.NOV, product_name: name, why: 'not in the catalog' });
      console.log(`${LOG} ${name} not found in the catalog: no November row written for ${protocol.protocol_key}`);
      continue;
    }
    if (findIn(rows, WINDOWS.NOV, name, productId)) continue;
    const template = findIn(rows, WINDOWS.DEC, name, productId);
    if (!template || isRetired(template)) {
      record.skipped.push({ window: WINDOWS.NOV, product_name: name, why: 'no active December row to copy' });
      console.log(`${LOG} no active December ${name} row to copy for ${protocol.protocol_key}: no November row written`);
      continue;
    }
    const isBlind = name === BLINDSIDE;
    record.inserted.push(await insertRow(knex, window, rows, productId, name, {
      ...template,
      windowKey: WINDOWS.NOV,
      rate_per_1000: isBlind ? BLINDSIDE_RATE : template.rate_per_1000,
      rate_unit: isBlind ? BLINDSIDE_UNIT : template.rate_unit,
    }, 'november_weed'));
  }
}

async function writeProtocol(knex, protocol, resolve) {
  const record = { rates: [], inserted: [], skipped: [] };
  const rows = await loadRows(knex, protocol.id);
  const windowList = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).select('id', 'window_key');
  const windows = new Map(windowList.map((window) => [window.window_key, window.id]));
  await writeBlindsideRates(knex, rows, resolve(BLINDSIDE), record);
  await writeNovemberWeeds(knex, protocol, rows, windows, resolve, record);
  return record;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  if (!protocols.length) return;
  const resolve = await loadResolver(knex);
  for (const protocol of protocols) {
    const record = await writeProtocol(knex, protocol, resolve);
    if (!record.rates.length && !record.inserted.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({ rates: record.rates.map((rate) => ({ rowId: rate.rowId, ...rate.before })) }),
      after_snapshot: JSON.stringify(record),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
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

// What the rollback of one protocol would touch, or why it must not touch anything: { blocker, inserted, rates }.
// Everything is checked before anything is written: one row that is not exactly what up() wrote leaves the whole protocol as it is.
async function planRollback(knex, record) {
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');
  const inserted = [];
  for (const made of record.inserted || []) {
    const row = await knex('lawn_protocol_products').where({ id: made.id }).first(OWNED_COLUMNS);
    if (!row) continue;
    if (hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: made.id }).first('id')) {
      return { blocker: `a completion actual references the ${made.product_name} row` };
    }
    if (!made.owned || !OWNED_COLUMNS.every((column) => same(row[column], made.owned[column]))) {
      return { blocker: `the ${made.product_name} row was edited after it was inserted` };
    }
    inserted.push(made);
  }
  const rates = [];
  for (const entry of record.rates || []) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'rate_per_1000', 'rate_unit');
    if (!row) continue;
    if (!same(row.rate_per_1000, entry.after.rate_per_1000) || row.rate_unit !== entry.after.rate_unit) {
      return { blocker: 'a Blindside rate was edited after it was written' };
    }
    rates.push(entry);
  }
  return { blocker: null, inserted, rates };
}

// Reverts one protocol's audit record; returns true when the protocol was left (referenced, or edited since).
async function revertProtocol(knex, log) {
  const record = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`${LOG} rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  const plan = await planRollback(knex, record);
  if (plan.blocker) {
    console.log(`${LOG} rollback skipped for protocol ${protocol ? protocol.protocol_key : log.lawn_protocol_id}: ${plan.blocker}`);
    return true;
  }
  for (const made of plan.inserted) {
    await knex('lawn_protocol_products').where({ id: made.id, product_name: made.product_name }).del();
  }
  for (const entry of plan.rates) {
    await knex('lawn_protocol_products').where({ id: entry.rowId }).update({ ...entry.before, updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  for (const log of logs) await revertProtocol(knex, log);
};

exports.ACTION = ACTION;
exports.WINDOWS = WINDOWS;
exports.WEED_NAMES = WEED_NAMES;
exports.BLINDSIDE = BLINDSIDE;
exports.BLINDSIDE_RATE = BLINDSIDE_RATE;
exports.BLINDSIDE_UNIT = BLINDSIDE_UNIT;
exports.OWNED_COLUMNS = OWNED_COLUMNS;
