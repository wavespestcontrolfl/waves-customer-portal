/**
 * referrals.referee_customer_id: the friend's customer row, stamped when a Step 2 settlement posts the member's credit
 * (referral-engine creditReferralOnFirstService, GATE_REFERRAL_STEP2). It lets the finance views (acquisition cost,
 * EBITDA) find a settled referral's friend without matching phones, and without needing a friend credit row (a $0
 * friend credit posts none). Nullable: a referral that never settled under Step 2 has none, and the finance views fall
 * back to the friend's credit ledger row for older rows.
 *
 * Additive; down drops the index and the column.
 */
const TABLE = 'referrals';
const COLUMN = 'referee_customer_id';
const INDEX = 'referrals_referee_customer_id_index';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => t.uuid(COLUMN));
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? (??) WHERE ?? IS NOT NULL', [INDEX, TABLE, COLUMN, COLUMN]);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('DROP INDEX IF EXISTS ??', [INDEX]);
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn(COLUMN));
  }
};

exports._COLUMN = COLUMN;
