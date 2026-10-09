/**
 * Lawn protocol v13 final pass, part 2: Blindside in the catalog, and ONE application a year on the staged rows.
 * (Codex round 1 on #6187. 20261009150000 is pushed with a PR and frozen, so these two writes live here.)
 *
 *   1. Catalog rate. Blindside Herbicide (EPA Reg. No. 279-3411; warm-season single rate 0.149 to 0.23 oz per 1,000 sq ft, no
 *      more than 0.23 oz per 1,000 sq ft a year) is created by 20261005130000 with no default_rate_per_1000 and no rate_unit, so a
 *      fresh database has no rate behind the 0.149 oz the staged rows and the recipe state. The row is resolved the way
 *      20261007189700 resolves Advion (exact name, active rows first, else an exact alias) and:
 *        - an empty rate_unit becomes 'oz';
 *        - an empty default_rate_per_1000 becomes 0.149, only when the unit is (now) oz.
 *      Any other value is someone's own number and stays. Production already holds 0.149 oz, so this writes nothing there.
 *
 *   2. One application a year. At 0.149 oz one pass fits the label's yearly 0.23 oz, so the app now enforces and shows a count of
 *      1 (config/lawn-v13-count-caps.js: effectiveCap 1; the yearly amount blocks a second pass as well). Every staged Blindside
 *      row of every v13 protocol that is NOT retired (gates.retired) and still holds exactly 2 gets gates.annualMaxApps 1 and
 *      annual_counter.maxApplications 1, each only where it holds exactly 2 (an edited figure is never replaced). One audit
 *      row per protocol lists the rows and which figure changed. A row is matched by name or by the resolved Blindside product id.
 *
 * Idempotent: a second run finds no empty catalog field and no figure of 2 and writes nothing.
 *
 * down(): not at all while a scheduled visit or a completion references a v13 protocol (the facts that visit was planned and
 * reported against stay), as 20261007189700 does. Otherwise it restores the catalog rate and unit together, only while every field
 * written here still holds the value written (an edit of either leaves both, and logs it), and a staged figure to 2 only while it still reads 1, then deletes the audit rows. A row somebody has edited
 * since, or deleted, is left alone.
 *
 * How the older downs behave after part 2 (migrations roll back newest first, so this down() runs before all of them; the lines
 * below are what each does if the figures are still 1 when it runs, for example when this down() skipped a referenced protocol):
 *   - 20261007175000 (added annualMaxApps / maxApplications 2 where absent): its down() removes a key only while it equals 2. A
 *     Blindside row at 1 is skipped and keeps the key at 1; the audit row is deleted. A skip, never a wrong delete.
 *   - 20261007177000 (clamped figures above 2 down to 2): its down() puts the old figure back only while the row still holds 2.
 *     A row at 1 is skipped. A skip.
 *   - 20261007179000 (inserted the Blindside spot rows): its down() deletes an inserted row only while gates.annualMaxApps and
 *     annual_counter.maxApplications equal 2. A row at 1 is skipped and the row stays (the same outcome as a row somebody edited).
 *   - 20261009150000 (the November weed rows, the Blindside rate): its down() deletes an inserted row only while every column it
 *     wrote still reads that way; the November Blindside row it cloned from December carries gates and annual_counter of 2, so at
 *     1 the whole protocol is left as it is (its planRollback blocks on an edited inserted row). A skip.
 *   - 20261008130000 and 20261008132000 un-retire a row through gates.retired only; 20261005140000 deletes by row id and name; the
 *     fire ant migrations (20261009100000 to 20261009103000) read Topchoice and Advion rows. None reads a Blindside count.
 * Each of those leaves a figure at 1 where it skips, and none deletes, restores or un-restores a row wrongly, so nothing here
 * makes an older down() unsafe. The run order (newest first) restores the 2 before any of them looks.
 */
const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const ACTION_CATALOG = 'v13_final_pass_blindside_catalog';
const ACTION_CAP = 'v13_final_pass_blindside_cap';
const ACTOR = 'migration 20261009151000';
const MIGRATION = '20261009151000_lawn_v13_final_pass_blindside_catalog';
const LOG = '[lawn-v13-final-pass-blindside-catalog]';

const BLINDSIDE = 'Blindside Herbicide';
const RATE = 0.149;
const UNIT = 'oz';
const OLD_CAP = 2;
const NEW_CAP = 1;

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isEmpty = (value) => value == null || String(value).trim() === '';
const isRate = (value, rate) => value != null && Math.abs(Number(value) - rate) < 1e-9;

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Exact catalog name (active rows first), else an exact alias: the lookup 20261007189700 uses.
async function resolveProductId(knex) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(BLINDSIDE));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(BLINDSIDE));
  return alias ? alias.product_id : null;
}

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// ── 1. catalog ───────────────────────────────────────────────────────────────

async function catalogUp(knex, id) {
  const row = id ? await knex('products_catalog').where({ id }).first('id', 'name', 'default_rate_per_1000', 'rate_unit') : null;
  if (!row) return;
  const fields = {};
  if (isEmpty(row.rate_unit)) fields.rate_unit = { before: row.rate_unit ?? null, after: UNIT };
  const oz = isEmpty(row.rate_unit) || normalize(row.rate_unit) === UNIT;
  if (oz && isEmpty(row.default_rate_per_1000)) fields.default_rate_per_1000 = { before: row.default_rate_per_1000 ?? null, after: RATE };
  if (!Object.keys(fields).length) return;
  const update = Object.fromEntries(Object.entries(fields).map(([column, change]) => [column, change.after]));
  await knex('products_catalog').where({ id }).update({ ...update, updated_at: knex.fn.now() });
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION_CATALOG,
    changed_fields: JSON.stringify(Object.keys(fields)),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ id, name: row.name, fields }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
}

async function catalogDown(knex) {
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION_CATALOG }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    const row = after.id ? await knex('products_catalog').where({ id: after.id }).first('id', 'default_rate_per_1000', 'rate_unit') : null;
    // The rate and its unit are one fact: restore the fields written here only while ALL of them still hold what was written. If an
    // admin has edited either one since, both stay (a rate left with a null unit would be unreadable).
    const written = Object.entries(after.fields || {});
    const untouched = row && written.length > 0 && written.every(([column, change]) => (column === 'rate_unit' ? row.rate_unit === change.after : isRate(row[column], change.after)));
    if (untouched) {
      const update = Object.fromEntries(written.map(([column, change]) => [column, change.before]));
      await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
    } else if (row) {
      console.log(`${LOG} ${after.name || BLINDSIDE}: the catalog rate or unit was edited since; both stay`);
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

// ── 2. one application a year on the staged rows ─────────────────────────────

const STAGED_TABLES = ['lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocols', 'lawn_protocol_audit_log'];

async function capUp(knex, id) {
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', staged.V13_VERSION)
    .where((q) => { q.where('p.product_name', BLINDSIDE); if (id) q.orWhere('p.product_id', id); })
    .select('p.id', 'p.gates', 'p.annual_counter', 'l.id as protocol_id')
    .orderBy('p.id');
  const byProtocol = new Map();
  for (const row of rows) {
    const gates = asObject(row.gates);
    const counter = asObject(row.annual_counter);
    if (gates.retired === true) continue;
    const changed = { id: row.id, gate: false, counter: false };
    const update = {};
    if (gates.annualMaxApps === OLD_CAP) { update.gates = JSON.stringify({ ...gates, annualMaxApps: NEW_CAP }); changed.gate = true; }
    if (counter.maxApplications === OLD_CAP) { update.annual_counter = JSON.stringify({ ...counter, maxApplications: NEW_CAP }); changed.counter = true; }
    if (!changed.gate && !changed.counter) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
    if (!byProtocol.has(row.protocol_id)) byProtocol.set(row.protocol_id, []);
    byProtocol.get(row.protocol_id).push(changed);
  }
  for (const [protocolId, changed] of byProtocol) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocolId,
      action: ACTION_CAP,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({ cap: OLD_CAP }),
      after_snapshot: JSON.stringify({ cap: NEW_CAP, rows: changed }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
}

async function capDown(knex) {
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION_CAP }).select('id', 'after_snapshot')) {
    for (const changed of asObject(log.after_snapshot).rows || []) {
      const row = await knex('lawn_protocol_products').where({ id: changed.id }).first('gates', 'annual_counter');
      if (!row) continue;
      const gates = asObject(row.gates);
      const counter = asObject(row.annual_counter);
      const update = {};
      if (changed.gate && gates.annualMaxApps === NEW_CAP) { update.gates = JSON.stringify({ ...gates, annualMaxApps: OLD_CAP }); }
      if (changed.counter && counter.maxApplications === NEW_CAP) { update.annual_counter = JSON.stringify({ ...counter, maxApplications: OLD_CAP }); }
      if (Object.keys(update).length) await knex('lawn_protocol_products').where({ id: changed.id }).update({ ...update, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, ['products_catalog', 'lawn_protocol_audit_log']))) return;
  const id = await resolveProductId(knex);
  if (!id) console.log(`${LOG} no catalog row or alias for ${BLINDSIDE}; no catalog rate written`);
  await catalogUp(knex, id);
  if (await hasAll(knex, STAGED_TABLES)) await capUp(knex, id);
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex, ['products_catalog', 'lawn_protocol_audit_log']))) return;
  if (await anyV13ProtocolReferenced(knex)) {
    console.log(`${LOG} a visit or completion references ${staged.V13_VERSION}: the catalog rate and the staged figures stay`);
    return;
  }
  await catalogDown(knex);
  if (await hasAll(knex, STAGED_TABLES)) await capDown(knex);
};

exports.ACTION_CATALOG = ACTION_CATALOG;
exports.ACTION_CAP = ACTION_CAP;
exports.RATE = RATE;
exports.UNIT = UNIT;
exports.OLD_CAP = OLD_CAP;
exports.NEW_CAP = NEW_CAP;
