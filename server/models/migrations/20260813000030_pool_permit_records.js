'use strict';

/**
 * pool_permit_records — synced Manatee County Pool-Spa permits (ACA
 * "Pool Permits (CSV)" report, reportID 22615).
 *
 * Why a synced table: the county GIS BuildingDeptSearch layer the live
 * lookup queries carries OPEN permits only (STAT='O', live-probed
 * 2026-08-13 — a permit that closed in April is already gone), and the
 * PAO extra-features roll only picks a finished pool up on the NEXT
 * assessment roll. A pool finaled after Jan 1 is therefore invisible to
 * both live sources for up to a year. The ACA issued-date report includes
 * Closed / Pending Closure / Inspection Passed records, so a weekly sync
 * closes that blind window.
 *
 * One row per ACA record id, refreshed on every sync (statuses move
 * Permit Issued → Pending Closure → Closed). Rows are public county
 * records. Canceled permits are KEPT (cheap, and status history is
 * useful) but consumers must exclude status 'Canceled' — a canceled
 * permit is not pool evidence.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pool_permit_records')) return;
  await knex.schema.createTable('pool_permit_records', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('county', 20).notNullable().defaultTo('Manatee');
    table.string('record_id', 40).notNullable().unique();
    table.string('record_status', 60);
    table.string('record_type', 40);
    table.string('project_type', 40);
    table.decimal('job_value', 12, 2);
    table.date('issued_date');
    table.string('address_line1', 160);
    table.string('city', 80);
    table.string('zip', 10);
    // 10-digit PAO PIN when the report's parcel number normalizes to one
    // (13 digits ending '000' → first 10); otherwise the raw digits.
    table.string('parcel_pin', 20);
    table.string('parcel_raw', 40);
    // Exact shared-normalization key (customer-properties addressKey) plus a
    // loose house-number+first-street-word+zip key. The loose key exists
    // because the report abbreviates suffixes the shared canon doesn't map
    // ("SAMPLE CV" vs "Sample Cove") — parcel PIN is the primary join,
    // loose key the fallback, exact key the bonus.
    table.string('address_key', 160);
    table.string('address_loose_key', 80);
    table.string('contractor_name', 160);
    table.string('contractor_license', 40);
    table.string('owner_name', 160);
    table.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    table.index(['parcel_pin'], 'idx_pool_permit_records_pin');
    table.index(['address_loose_key'], 'idx_pool_permit_records_loose');
    table.index(['address_key'], 'idx_pool_permit_records_key');
    table.index(['issued_date'], 'idx_pool_permit_records_issued');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pool_permit_records'))) return;
  await knex.schema.dropTable('pool_permit_records');
};
