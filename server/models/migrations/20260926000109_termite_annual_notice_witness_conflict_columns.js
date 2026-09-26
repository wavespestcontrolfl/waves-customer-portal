/**
 * Termite annual plan — slice 5, Codex #4921 r10 P2.
 *
 * A notice-witness CONFLICT (a delivered notice whose record disagrees with
 * what another sender already wrote — e.g. on-time evidence vs a late record)
 * rings a staff bell. That bell's notifyAdmin insert can fail, and nothing
 * else would ever re-ring it. These two columns make it durable:
 *   notice_witness_conflict            jsonb — the unresolved conflict's
 *                                      details (rung, intended vs recorded
 *                                      columns, acceptance time)
 *   notice_witness_conflict_belled_at  timestamptz — stamped ONLY after the
 *                                      bell insert is confirmed; while NULL
 *                                      with a conflict present, the daily
 *                                      sweep re-files the bell.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

const COLUMNS = [
  ['notice_witness_conflict', (t) => t.jsonb('notice_witness_conflict')],
  ['notice_witness_conflict_belled_at', (t) => t.timestamp('notice_witness_conflict_belled_at', { useTz: true })],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const [col, add] of COLUMNS) {
    if (await knex.schema.hasColumn('annual_prepay_terms', col)) continue;
    await knex.schema.alterTable('annual_prepay_terms', (t) => { add(t); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const [col] of COLUMNS) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', col))) continue;
    await knex.schema.alterTable('annual_prepay_terms', (t) => { t.dropColumn(col); });
  }
};
