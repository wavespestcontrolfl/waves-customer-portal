'use strict';

/**
 * Building facts read off each new-home permit's public ACA record page
 * (round 2 / PR R2-A of the property-lookup address-match lane). The weekly
 * report sync (construction_permit_records, 20260813000031) knows WHICH
 * permits are new dwellings but not how big they are; the permit's own
 * Application Information lists the plan's conditioned and under-roof square
 * footage, stories, bedrooms and bathrooms months before the county roll has
 * the house. manatee-permit-detail.js collects them; nothing reads them for a
 * price yet.
 *
 * Columns on the existing table, not a sibling table: the facts are 1:1 with
 * the permit row, every reader already matches on this table's parcel_pin /
 * address_loose_key, and the report upsert only merges the columns its row
 * carries, so it can never null these. ONLY building facts live here (no
 * contractor contact, no owner): the page's other fields are never read.
 *
 *   detail_status      ok | no_fields | not_found | error; NULL = never tried
 *   detail_fetched_at  when the last attempt finished
 *   detail_co_date     the CO date the row carried when it was last fetched,
 *                      so a CO arriving later (plan swaps ride revisions)
 *                      reads as "changed since" without comparing timestamps
 *                      across the ET / UTC boundary
 *
 * All columns are nullable with no default, so the add is a metadata-only
 * change on the live table and the previous server (which never names them)
 * keeps working through the deploy. Re-runnable: each column is guarded.
 */

const TABLE = 'construction_permit_records';

const COLUMNS = {
  conditioned_sqft: (t) => t.integer('conditioned_sqft'),
  under_roof_sqft: (t) => t.integer('under_roof_sqft'),
  stories: (t) => t.decimal('stories', 3, 1),
  bedrooms: (t) => t.integer('bedrooms'),
  bathrooms: (t) => t.decimal('bathrooms', 4, 1),
  detail_status: (t) => t.string('detail_status', 12),
  detail_fetched_at: (t) => t.timestamp('detail_fetched_at'),
  detail_co_date: (t) => t.date('detail_co_date'),
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [name, add] of Object.entries(COLUMNS)) {
    if (await knex.schema.hasColumn(TABLE, name)) continue;
    await knex.schema.alterTable(TABLE, (t) => { add(t); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const name of Object.keys(COLUMNS)) {
    if (await knex.schema.hasColumn(TABLE, name)) {
      await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(name); });
    }
  }
};
