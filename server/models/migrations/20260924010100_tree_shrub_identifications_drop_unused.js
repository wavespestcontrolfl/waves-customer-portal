/**
 * Drop the unused report/claim/funnel columns from tree_shrub_identifications.
 *
 * 20260924000120_tree_shrub_identifications created them only for parity with
 * pest_identifications, but tree & shrub has no public funnel and no customer
 * report page: the admin routes refuse generate-link / send-report for it, so
 * nothing can ever populate a report token, its expiry, a claim, a first view,
 * a pricing snapshot, or a report-sent stamp. Keeping them would publish a
 * report/claim contract before that feature exists (AGENTS.md: no speculative
 * schema). When a tree & shrub report ships, its own migration adds what it
 * actually needs.
 *
 * Superseding migration, not an edit: 20260924000120 is already pushed and the
 * Railway preview DB has run it, and knex tracks migrations by filename, so an
 * in-place edit would be a silent no-op there.
 *
 * down() re-adds every column exactly as 20260924000120 defined it (types,
 * nullability, and the two UNIQUE constraints knex named
 * <table>_<column>_unique).
 */

const TABLE = 'tree_shrub_identifications';

// Column name → the original 20260924000120 definition, for down().
const DROPPED_COLUMNS = [
  ['report_token', (t) => t.string('report_token', 32).nullable().unique()],
  ['report_expires_at', (t) => t.timestamp('report_expires_at', { useTz: true }).nullable()],
  ['claim_token', (t) => t.string('claim_token', 32).nullable().unique()],
  ['claimed_at', (t) => t.timestamp('claimed_at', { useTz: true }).nullable()],
  ['report_first_viewed_at', (t) => t.timestamp('report_first_viewed_at', { useTz: true }).nullable()],
  ['pricing_snapshot', (t) => t.jsonb('pricing_snapshot').nullable()],
  ['last_sent_at', (t) => t.timestamp('last_sent_at', { useTz: true }).nullable()],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [column] of DROPPED_COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      // Dropping the column drops its UNIQUE constraint/index with it.
      await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(column); });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [column, add] of DROPPED_COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.schema.alterTable(TABLE, (t) => { add(t); });
    }
  }
};

exports.DROPPED_COLUMNS = DROPPED_COLUMNS.map(([column]) => column);
