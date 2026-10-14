/**
 * Lawn protocol v13: corrects the stored reason on the Dylox 6.2 G count limit (Codex round 2 on #6228).
 * 20261009173000 is pushed and frozen, so the correction lives here. The count itself (2 a calendar year) does not change.
 *
 * Why. 20261009173000 wrote a description that says two 3 lb applications reach the label's amount for surface feeding
 * insects. That reason does not hold for this program. The Dylox 6.2 G label (EPA Reg. No. 432-1308) lists chinch bugs under
 * "ROOT FEEDING INSECTS" (3 lb per 1,000 sq ft) with white grubs and mole crickets; "SURFACE FEEDING INSECTS" is sod webworm,
 * cranberry girdler, cutworm and armyworm, and the lower yearly amount (16.2 lb active ingredient = 261 lb of product per
 * acre) is theirs. The program uses Dylox for grubs, mole crickets and chinch bugs only, so the label's limits for it are 3
 * applications a calendar year and 395 lb of product per acre a year (the 9.07 lb per 1,000 sq ft row). 2 a year is a Waves
 * rule, stricter than the label.
 *
 * What this writes. On the Dylox 6.2 G annual_max_apps limit, the description becomes the corrected sentence, only while the
 * row still reads exactly what 20261009173000 wrote (value 2, its description). Any other row is left. Nothing else is
 * touched: no value, no gate, no other limit. One 'v13_dylox_two_a_year_description' audit row records the row id.
 *
 * Idempotent: a second run finds no row with the old description.
 *
 * down(): the description goes back only while the row still reads exactly as this wrote it; the audit row is removed.
 *
 * How 20261009173000's down() behaves after this write. In any rollback this down() runs first (knex rolls back newest first)
 * and puts the old description back, so 20261009173000's down() finds the row as it wrote it. Run on its own while this
 * write is in place, 20261009173000's down() finds a description it did not write and leaves the row at 2: a count limit
 * that stays, never a wrong restore. 20261009172000's down() is as that header states (it also leaves a row at 2).
 */

const crypto = require('crypto');
const second = require('./20261009173000_lawn_v13_dylox_two_a_year');

const ACTION = 'v13_dylox_two_a_year_description';
const ACTOR = 'migration 20261009174000';
const MIGRATION = '20261009174000_lawn_v13_dylox_two_a_year_description';
const CAP = 2;
const WAS = second.LIMIT.description;
const DESCRIPTION = 'Dylox 6.2 G: at most 2 applications per lawn per calendar year (Waves rule, stricter than the label). The label (EPA Reg. No. 432-1308) allows 3 a calendar year and 395 lb of product per acre a year for the root feeding insects this program treats with it: grubs, mole crickets and chinch bugs.';

const REQUIRED_TABLES = ['product_limits', 'lawn_protocol_audit_log'];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// The rows 20261009173000 wrote and nobody has edited: its count, its description.
const written = (knex, description) => knex('product_limits')
  .where({ limit_type: 'annual_max_apps', description })
  .whereRaw('limit_value = ?', [CAP]);

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const rows = await written(knex, WAS).select('id');
  const changed = [];
  for (const row of rows) {
    const count = await written(knex, WAS).where({ id: row.id }).update({ description: DESCRIPTION, updated_at: knex.fn.now() });
    if (count) changed.push(row.id);
  }
  if (!changed.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: ACTION,
    changed_fields: JSON.stringify(['limits']),
    before_snapshot: JSON.stringify({ description: WAS }),
    after_snapshot: JSON.stringify({ description: DESCRIPTION, limitIds: changed }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'after_snapshot')) {
    for (const id of asObject(log.after_snapshot).limitIds || []) {
      await written(knex, DESCRIPTION).where({ id }).update({ description: WAS, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
};

exports.ACTION = ACTION;
exports.DESCRIPTION = DESCRIPTION;
