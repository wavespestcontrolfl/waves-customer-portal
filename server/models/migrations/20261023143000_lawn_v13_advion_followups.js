/**
 * Lawn protocol v13, Advion follow-ups (owner 2026-10-23). Follows 20261023140000, 20261023141000 and 20261023142000, which are frozen.
 *
 * Two data fixes, both guarded and both recorded in one audit row:
 *
 * 1. service_lines. The Advion Insect Granule row 20261023140000 inserted has no service_lines, so the lawn sheet's product search cannot find
 *    it. Set it to ["lawn"], on that row only (found by its catalog audit marker) and only while service_lines is still empty.
 *
 * 2. Acelepryn, mole cricket nymphs. The Acelepryn catalog rule is target-split: caterpillars hold 24 hours, grubs water in. A use with no
 *    recorded target reads the FIRST entry (the caterpillar hold). The June staged Acelepryn row is the mole cricket offer; the completion now
 *    records "Tawny mole crickets" for it by default (lawn-spot-target.js), and this adds the matching entry: mole crickets water in, 0.25 inch
 *    within 24 hours, the same amount as the grub use (owner rule). Acelepryn is a pre-existing row, so this is a read-modify-write of its
 *    post_application_watering: the entry is appended ONLY when the rule has a by_target list, valid, with no entry that already covers
 *    mole crickets, and the rest of the rule is not touched. A rule that is not in that shape is left alone and logged.
 *
 * down() is all or nothing: it removes exactly the appended entry from the Acelepryn rule, and clears service_lines on the Advion row, only
 * while each is still exactly as written (the rule without the entry equals what up() read; service_lines is still ["lawn"]). Otherwise it does
 * nothing and logs why. A visit or completion that references a v13 protocol does not matter here (data on catalog rows only), but a rule
 * staff edited since is never rewritten.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const catalogMigration = require('./20261023140000_lawn_v13_advion_insect_granule');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const ACTION = 'v13_advion_followups';
const ACTOR = 'migration 20261023143000';
const MIGRATION = '20261023143000_lawn_v13_advion_followups';
const ACELEPRYN = 'Acelepryn Insecticide';
const SERVICE_LINES = ['lawn'];
const MOLE_CRICKET_ENTRY = Object.freeze({ match: ['mole cricket'], mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}
const asList = (value) => {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  return Array.isArray(parsed) ? parsed : [];
};

async function insertedAdvionId(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: catalogMigration.CATALOG_ACTION }).select('after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted && productId) return String(productId);
  }
  return null;
}

async function hasAll(knex) {
  return (await knex.schema.hasTable('products_catalog')) && (await knex.schema.hasTable('lawn_protocol_audit_log'))
    && (await knex.schema.hasColumn('products_catalog', 'service_lines'));
}

const coversMoleCrickets = (entry) => Array.isArray(entry && entry.match) && entry.match.some((word) => 'mole cricket'.includes(String(word).toLowerCase()) || String(word).toLowerCase().includes('mole cricket'));

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  if (await knex('lawn_protocol_audit_log').where({ action: ACTION }).first('id')) return;
  const record = {};

  const advionId = await insertedAdvionId(knex);
  if (advionId) {
    const row = await knex('products_catalog').where({ id: advionId }).first('id', 'service_lines');
    if (row && !asList(row.service_lines).length) {
      await knex('products_catalog').where({ id: advionId }).update({ service_lines: JSON.stringify(SERVICE_LINES), updated_at: knex.fn.now() });
      record.serviceLines = { productId: advionId, before: row.service_lines ?? null, after: SERVICE_LINES };
    }
  }

  const ace = await knex('products_catalog').where({ name: ACELEPRYN }).first('id', 'post_application_watering');
  if (ace) {
    const rule = asObject(ace.post_application_watering);
    const entries = Array.isArray(rule.by_target) ? rule.by_target : null;
    if (entries && !entries.some(coversMoleCrickets)) {
      const after = { ...rule, by_target: [...entries, { ...MOLE_CRICKET_ENTRY }] };
      if (validateRule(after).valid) {
        await knex('products_catalog').where({ id: ace.id }).update({ post_application_watering: JSON.stringify(after), updated_at: knex.fn.now() });
        record.acelepryn = { productId: String(ace.id), before: rule, after };
      } else {
        console.log('[lawn-v13-advion-followups] Acelepryn rule left alone: the rule with the mole cricket entry would not validate');
      }
    } else {
      console.log('[lawn-v13-advion-followups] Acelepryn rule left alone: no by_target list, or an entry already covers mole crickets');
    }
  }

  if (!record.serviceLines && !record.acelepryn) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(Object.keys(record)),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify(record),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;
  const records = logs.map((log) => asObject(log.after_snapshot));
  // Check everything first: one row changed since makes the whole rollback a no-op.
  for (const record of records) {
    if (record.serviceLines) {
      const row = await knex('products_catalog').where({ id: record.serviceLines.productId }).first('service_lines');
      if (row && !isDeepStrictEqual(asList(row.service_lines), record.serviceLines.after)) {
        console.log('[lawn-v13-advion-followups] rollback did nothing: the Advion service_lines changed since');
        return;
      }
    }
    if (record.acelepryn) {
      const row = await knex('products_catalog').where({ id: record.acelepryn.productId }).first('post_application_watering');
      if (row && !isDeepStrictEqual(asObject(row.post_application_watering), record.acelepryn.after)) {
        console.log('[lawn-v13-advion-followups] rollback did nothing: the Acelepryn rule changed since');
        return;
      }
    }
  }
  for (const record of records) {
    if (record.serviceLines) {
      await knex('products_catalog').where({ id: record.serviceLines.productId }).update({
        service_lines: record.serviceLines.before == null ? null : JSON.stringify(asList(record.serviceLines.before)), updated_at: knex.fn.now(),
      });
    }
    if (record.acelepryn) {
      await knex('products_catalog').where({ id: record.acelepryn.productId }).update({ post_application_watering: JSON.stringify(record.acelepryn.before), updated_at: knex.fn.now() });
    }
  }
  for (const log of logs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
};

exports.ACTION = ACTION;
exports.SERVICE_LINES = SERVICE_LINES;
exports.MOLE_CRICKET_ENTRY = MOLE_CRICKET_ENTRY;
exports.ACELEPRYN = ACELEPRYN;
