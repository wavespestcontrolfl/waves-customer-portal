'use strict';

/**
 * mail_prospects: the facts of the home and its quarterly pest plan price (mailer step 2a, shadow). Read from two free
 * public county sources (the parcel map and the permit record page) and priced as a dry run of the portal's own estimate
 * save, by services/mail/home-price.js. Only services/mail/home-price-store.js writes these columns.
 *
 *   home_sqft / home_sqft_source   the size the price used, and where it came from: parcel_map | permit_plan
 *   home_stories                   the story count the price used. (The list's own `stories` column keeps the parcel
 *                                  map's value at match time and is not touched.)
 *   lot_sqft                       the parcel map's lot size
 *   price_status                   NULL = not tried yet; priced | not_clean | missing_fact | failed
 *                                  priced and not_clean are settled; missing_fact and failed are tried again
 *   price_reason                   why the status is not priced (a code of this feature)
 *   price_annual / price_setup_fee / price_digest / priced_at
 *                                  the price and the engine digest it came from, kept only on a priced row
 *   price_checked_at               when the pass last settled or tried the row
 *
 * Rules the table keeps, whatever code writes to it: the two enums; a priced row holds all four price columns and any
 * other row holds none of them; sizes are positive. No backfill and no default: every row starts untried.
 *
 * Additive and idempotent. down drops the constraints and the columns.
 */
const TABLE = 'mail_prospects';

const COLUMNS = {
  home_sqft: (t) => t.integer('home_sqft'),
  home_sqft_source: (t) => t.string('home_sqft_source', 16),
  home_stories: (t) => t.decimal('home_stories', 3, 1),
  lot_sqft: (t) => t.integer('lot_sqft'),
  price_status: (t) => t.string('price_status', 16),
  price_reason: (t) => t.string('price_reason', 40),
  price_annual: (t) => t.decimal('price_annual', 10, 2),
  price_setup_fee: (t) => t.decimal('price_setup_fee', 10, 2),
  price_digest: (t) => t.string('price_digest', 80),
  priced_at: (t) => t.timestamp('priced_at', { useTz: true }),
  price_checked_at: (t) => t.timestamp('price_checked_at', { useTz: true }),
};

const CHECKS = {
  mail_prospects_home_sqft_source_check: "home_sqft_source IS NULL OR home_sqft_source IN ('parcel_map', 'permit_plan')",
  mail_prospects_price_status_check: "price_status IS NULL OR price_status IN ('priced', 'missing_fact', 'not_clean', 'failed')",
  mail_prospects_price_only_when_priced: `CASE WHEN price_status = 'priced'
    THEN price_annual IS NOT NULL AND price_setup_fee IS NOT NULL AND price_digest IS NOT NULL AND priced_at IS NOT NULL
    ELSE price_annual IS NULL AND price_setup_fee IS NULL AND price_digest IS NULL AND priced_at IS NULL END`,
  mail_prospects_home_facts_positive: `(home_sqft IS NULL OR home_sqft > 0) AND (home_stories IS NULL OR home_stories > 0)
    AND (lot_sqft IS NULL OR lot_sqft > 0) AND (price_annual IS NULL OR price_annual > 0)
    AND (price_setup_fee IS NULL OR price_setup_fee >= 0)`,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [name, add] of Object.entries(COLUMNS)) {
    if (await knex.schema.hasColumn(TABLE, name)) continue;
    await knex.schema.alterTable(TABLE, (t) => { add(t); });
  }
  for (const [name, check] of Object.entries(CHECKS)) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${check})`, [TABLE, name]);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const name of Object.keys(CHECKS)) {
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, name]);
  }
  for (const name of Object.keys(COLUMNS)) {
    if (await knex.schema.hasColumn(TABLE, name)) {
      await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(name); });
    }
  }
};
