/**
 * Lawn protocol v13 matrix adds, Codex round 4 (PR #6116). Migrations 20261007180000 to 20261007183000 are
 * pushed and frozen; this one fixes their data. Every write is guarded, recorded and put back by down().
 *
 *   1. Report facts. A completion freezes each applied product's report facts from its catalog row
 *      (approvedReportProductFacts): a row with approved_for_service_report false freezes NULL facts, so a
 *      report could not name the product or carry its watering rule. The catalog rows the earlier
 *      migrations INSERTED (LESCO Elite 0-0-50, Advion Fire Ant Bait, and Headway Fungicide on a database
 *      that had none) are approved here, with the minimal verified facts the freeze reads:
 *        - 0-0-50: product type fertilizer, manufacturer, the plain customer summary; its watering rule was
 *          written by 180000.
 *        - Advion: product type pesticide, manufacturer Syngenta, label source and version (the EPA accepted
 *          label, EPA Reg. No. 100-1481, accepted 2018-12-19, read 2026-10-07), the plain customer summary;
 *          its EPA number and watering rule were written by 181000.
 *        - Headway: product type pesticide, manufacturer Syngenta, label source (EPA Reg. No. 100-1216), summary.
 *      A row is touched only while it is exactly as the earlier migration left it (approved false, the
 *      inserted label source note, draft content status) and each fact only where its field is empty. A
 *      row prod already had (Headway Fungicide there) carries none of our note and is never touched.
 *   2. Rollback. 183000's down() puts the Talak rate and gate and the Headway catalog fields back without
 *      asking whether a protocol is live. This migration's down() runs first: when any v13 protocol is
 *      referenced by a scheduled visit or a completion, it rewrites 183000's audit rows so that down() has
 *      nothing to revert (the originals are kept under `keptLive`; the earlier lanes' neutralize pattern)
 *      and leaves this migration's own catalog approvals in place.
 */

const crypto = require('crypto');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const matrix = require('./20261007180000_lawn_v13_matrix_adds');
const round3 = require('./20261007183000_lawn_v13_matrix_adds_round3');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_matrix_adds_round4_catalog';
const ACTOR = 'migration 20261007184000';
const MIGRATION = '20261007184000_lawn_v13_matrix_adds_round4';

const ADVION_LABEL_URL = 'https://www3.epa.gov/pesticides/chem_search/ppls/000100-01481-20181219.pdf';
const HEADWAY_LABEL_URL = 'https://www.domyown.com/msds/Headway_Label.pdf';

const spec = (name) => matrix.CATALOG.find((product) => product.name === name);

// The minimal facts per inserted row. `owned(row)` says the row is still what our migrations left.
const FACTS = [
  {
    name: matrix.SOP,
    owned: (row) => row.label_source_note === spec(matrix.SOP).label_source_note,
    fill: {
      product_type: 'fertilizer',
      manufacturer: 'LESCO / SiteOne',
      public_summary: 'LESCO Elite 0-0-50 may be used as a potassium feeding, with no nitrogen or phosphorus, where the lawn would benefit from it.',
      service_report_summary: 'LESCO Elite 0-0-50 was applied as a potassium feeding according to the technician service notes.',
    },
  },
  {
    name: matrix.ADVION,
    // 181000 replaced the inserted note with the label-checked one; either is ours.
    owned: (row) => row.label_source_note === spec(matrix.ADVION).label_source_note
      || String(row.label_source_note || '').startsWith('Advion Fire Ant Bait label (EPA Reg. No. 100-1481, accepted 2018-12-19)'),
    fill: {
      product_type: 'pesticide',
      manufacturer: 'Syngenta',
      label_source_url: ADVION_LABEL_URL,
      label_version: 'EPA accepted label, 2018-12-19',
      public_summary: 'Advion Fire Ant Bait may be used for fire ant management where the label directions and local rules support treatment.',
      service_report_summary: 'Advion Fire Ant Bait was applied for fire ant management according to label directions and the technician service notes.',
    },
  },
  {
    name: matrix.HEAD,
    owned: (row) => row.label_source_note === spec(matrix.HEAD).label_source_note,
    fill: {
      product_type: 'pesticide',
      manufacturer: 'Syngenta',
      label_source_url: HEADWAY_LABEL_URL,
      label_version: 'Headway liquid label, EPA Reg. No. 100-1216',
      public_summary: 'Headway may be used for turf disease management where the label directions and local rules support treatment.',
      service_report_summary: 'Headway was applied for turf disease management according to label directions and the technician service notes.',
    },
  },
];

const isEmpty = (value) => value == null || String(value).trim() === '';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// A row we may approve: ours, never approved, still a draft internal row.
function untouched(row, fact) {
  return fact.owned(row) && !row.approved_for_service_report
    && (isEmpty(row.content_status) || row.content_status === 'draft')
    && (isEmpty(row.customer_visibility) || row.customer_visibility === 'internal_only');
}

async function approve(knex, fact, columns) {
  const row = await knex('products_catalog').where({ name: fact.name }).first();
  if (!row || !untouched(row, fact)) return null;
  const fields = { approved_for_service_report: true };
  for (const [column, value] of Object.entries(fact.fill)) {
    if (column in columns && isEmpty(row[column])) fields[column] = value;
  }
  await knex('products_catalog').where({ id: row.id }).update({ ...fields, updated_at: knex.fn.now() });
  return { id: row.id, name: row.name, fields };
}

const REQUIRED = ['products_catalog', 'lawn_protocols', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;
  const columns = await knex('products_catalog').columnInfo();
  if (!('approved_for_service_report' in columns)) return;
  const approved = [];
  for (const fact of FACTS) {
    const done = await approve(knex, fact, columns);
    if (done) approved.push(done);
  }
  if (!approved.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ approved }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── down ─────────────────────────────────────────────────────────────────────

async function protocolReferenced(knex, protocol) {
  if (await knex.schema.hasTable('scheduled_services')) {
    if (await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
  }
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  const completion = await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id');
  return Boolean(completion);
}

async function anyLive(knex) {
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key')) {
    if (await protocolReferenced(knex, protocol)) return true;
  }
  return false;
}

// 183000's down() reverts without a live check: leave it nothing to revert while a protocol is live.
async function neutralizeRound3(knex) {
  const neutral = { [round3.ACTION]: { changes: [] }, [round3.CATALOG_ACTION]: { headway: null } };
  for (const [action, empty] of Object.entries(neutral)) {
    for (const log of await knex('lawn_protocol_audit_log').where({ action }).select('id', 'after_snapshot')) {
      const after = asObject(log.after_snapshot);
      if (after.keptLive) continue;
      await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...empty, keptLive: after }) });
    }
  }
}

async function revertApprovals(knex) {
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    for (const made of asObject(log.after_snapshot).approved || []) {
      const row = await knex('products_catalog').where({ id: made.id }).first();
      if (!row) continue;
      const update = {};
      for (const [column, value] of Object.entries(made.fields)) {
        if (row[column] === value) update[column] = column === 'approved_for_service_report' ? false : null;
      }
      if (Object.keys(update).length) await knex('products_catalog').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  if (await anyLive(knex)) {
    await neutralizeRound3(knex);
    console.log(`[lawn-v13-matrix-adds-round4] a visit or completion references ${V13_VERSION}: 20261007183000 will not revert; catalog approvals kept`);
    return;
  }
  await revertApprovals(knex);
};

exports.ACTION = ACTION;
exports.FACTS = FACTS;
