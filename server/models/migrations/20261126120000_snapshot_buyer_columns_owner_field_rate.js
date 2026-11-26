/**
 * Buyer view metrics (owner approved 2026-11-26): the stored monthly snapshot gets the figures a buyer of the business
 * asks about, and the owner's own field time gets a wage input beside the office-time ones.
 *
 * company_financials
 *   owner_field_hourly_rate numeric(8,2) NULL   what an hour of the owner's FIELD work is worth (a tech wage). NULL or 0 =
 *                                               not counted. Effective-dated like owner_office_hourly_rate: a month reads the
 *                                               row in effect on its last day.
 *
 * monthly_financial_snapshots (all nullable: NULL = the row was written before the column existed, or the figure could not
 * be worked out that month; the dashboard says which). Written by services/monthly-financial-snapshot.js.
 *   book_gross_margin_pct   numeric(7,2)  P&L basis: (revenue - COGS categories - pay-run wages - owner field allowance) / revenue
 *   owner_field_hours       numeric(8,2)  the owner's completed stops x job-costing standard minutes, in hours
 *   owner_field_allowance   numeric(12,2) owner_field_hours x owner_field_hourly_rate, rounded once to cents (0 = not counted)
 *   owner_paid_profit       numeric(12,2) EBITDA less the owner's office and field allowances
 *   sde                     numeric(12,2) seller's discretionary earnings: EBITDA before any owner pay
 *   recurring_revenue       numeric(12,2) visit revenue from plan members that month
 *   recurring_mature_revenue numeric(12,2) the part of it from plans at least 12 months old at month start
 *   prepaid_owed            numeric(12,2) annual-prepay money collected for visits not yet done at month end
 *   autopay_renewing_share  numeric(6,4)  0 to 1: share of recurring_revenue from customers on chargeable autopay
 *                                         (there is no renewing-agreement flag on a customer, so autopay is the whole test)
 *
 * Seed (owner ruling 2026-11-26): the owner wants $25 an hour counted for his field hours now, so the migration that adds
 * owner_field_hourly_rate sets it to 25 on every existing company_financials row, once (only in the run that adds the
 * column, so a re-run never overwrites a figure he has since changed). It is a plain Settings figure: he edits or clears
 * it under Settings -> Your own office time, and a later row carries his new value forward.
 *
 * Additive and idempotent. down() drops only what this migration added.
 */
const OWNER_FIELD_RATE_DOLLARS = 25;

const SETTINGS_COLUMNS = [['owner_field_hourly_rate', 8, 2]];

const SNAPSHOT_COLUMNS = [
  ['book_gross_margin_pct', 7, 2],
  ['owner_field_hours', 8, 2],
  ['owner_field_allowance', 12, 2],
  ['owner_paid_profit', 12, 2],
  ['sde', 12, 2],
  ['recurring_revenue', 12, 2],
  ['recurring_mature_revenue', 12, 2],
  ['prepaid_owed', 12, 2],
  ['autopay_renewing_share', 6, 4],
];

async function addDecimals(knex, table, columns) {
  for (const [col, precision, scale] of columns) {
    if (!(await knex.schema.hasColumn(table, col))) {
      await knex.schema.alterTable(table, (t) => {
        t.decimal(col, precision, scale).nullable();
      });
    }
  }
}

async function dropColumns(knex, table, columns) {
  for (const [col] of columns) {
    if (await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn(col);
      });
    }
  }
}

exports.up = async function up(knex) {
  const rateColumnExisted = await knex.schema.hasColumn('company_financials', 'owner_field_hourly_rate');
  await addDecimals(knex, 'company_financials', SETTINGS_COLUMNS);
  if (!rateColumnExisted) {
    await knex('company_financials').whereNull('owner_field_hourly_rate').update({ owner_field_hourly_rate: OWNER_FIELD_RATE_DOLLARS });
  }
  await addDecimals(knex, 'monthly_financial_snapshots', SNAPSHOT_COLUMNS);
};

exports.down = async function down(knex) {
  await dropColumns(knex, 'monthly_financial_snapshots', SNAPSHOT_COLUMNS);
  await dropColumns(knex, 'company_financials', SETTINGS_COLUMNS);
};

exports.OWNER_FIELD_RATE_DOLLARS = OWNER_FIELD_RATE_DOLLARS;
exports.SETTINGS_COLUMNS = SETTINGS_COLUMNS;
exports.SNAPSHOT_COLUMNS = SNAPSHOT_COLUMNS;
