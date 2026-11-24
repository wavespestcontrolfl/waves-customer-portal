'use strict';

/**
 * mail_prospects: the price pass's row version, and a facts check that also refuses NaN (mailer step 2a, shadow).
 * It follows 20261122200000, which is frozen.
 *
 *   price_attempts   how many times the price pass wrote the row (0 = never). It is the row's version: a write names
 *                    the count it read and adds one, so a stale run cannot replace a newer result. (A check time would
 *                    not do: inside one transaction every write has the same now().) NOT NULL, default 0: every row
 *                    starts untried.
 *
 * The facts check of 20261122200000 compares with > 0 and >= 0. A PostgreSQL numeric NaN compares above every number,
 * so that check lets a NaN amount through and a row could settle as priced with no real amount. This migration
 * replaces the check under its own name: the three numeric columns refuse NaN by name.
 *
 * Additive and idempotent. down puts the first check back and drops the column.
 */
const TABLE = 'mail_prospects';
const COLUMN = 'price_attempts';

const FACTS_CHECK = 'mail_prospects_home_facts_positive';
const ATTEMPTS_CHECK = 'mail_prospects_price_attempts_check';

// The check as 20261122200000 wrote it (down puts it back).
const FACTS_FIRST = `(home_sqft IS NULL OR home_sqft > 0) AND (home_stories IS NULL OR home_stories > 0)
    AND (lot_sqft IS NULL OR lot_sqft > 0) AND (price_annual IS NULL OR price_annual > 0)
    AND (price_setup_fee IS NULL OR price_setup_fee >= 0)`;

const FACTS_NO_NAN = `(home_sqft IS NULL OR home_sqft > 0)
    AND (home_stories IS NULL OR (home_stories > 0 AND home_stories <> 'NaN'))
    AND (lot_sqft IS NULL OR lot_sqft > 0)
    AND (price_annual IS NULL OR (price_annual > 0 AND price_annual <> 'NaN'))
    AND (price_setup_fee IS NULL OR (price_setup_fee >= 0 AND price_setup_fee <> 'NaN'))`;

async function setCheck(knex, name, check) {
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, name]);
  await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${check})`, [TABLE, name]);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => { t.integer(COLUMN).notNullable().defaultTo(0); });
  }
  await setCheck(knex, ATTEMPTS_CHECK, `${COLUMN} >= 0`);
  await setCheck(knex, FACTS_CHECK, FACTS_NO_NAN);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  // The first check goes back only while its columns are there (a down of 20261122200000 drops them with the check).
  if (await knex.schema.hasColumn(TABLE, 'price_annual')) await setCheck(knex, FACTS_CHECK, FACTS_FIRST);
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, ATTEMPTS_CHECK]);
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
  }
};
