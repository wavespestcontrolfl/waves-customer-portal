'use strict';

/**
 * construction_permit_records — synced Manatee County building permits from
 * the public ACA "Res/Com Permits Issued (Under Construction)" (reportID
 * 17907) and "Res/Com COs Issued" (reportID 17709) CSV reports.
 *
 * Why: satellite vision misreads active construction (a 2026 home on 2025
 * imagery scores as an empty lot — the exact Reagan Landing failure), and
 * nothing in the lookup knows a parcel is mid-build or JUST completed. An
 * issued permit marks the start of the blind window; the CO marks the end
 * (and is ground truth for "brand-new home"). One row per permit number —
 * the CO report refreshes co_date/status onto the row the issued report
 * created. These reports carry building-type/type-of-work vocabulary only
 * (New Single Family, Alteration, ...) — pool/enclosure/re-roof categories
 * are NOT in any public Manatee report; pool_permit_records stays the pool
 * source.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('construction_permit_records')) return;
  await knex.schema.createTable('construction_permit_records', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('county', 20).notNullable().defaultTo('Manatee');
    table.string('permit_no', 40).notNullable().unique();
    table.string('status', 60);
    table.string('permit_type', 40); // Residential / Commercial / Mobile Home / Modular
    table.string('type_of_work', 80); // New Single Family / Alteration ... (issued report only)
    table.date('issued_date');
    table.date('co_date'); // set when the CO report has seen the permit
    table.decimal('job_value', 14, 2);
    table.string('address_raw', 200); // one-line "200 SAMPLE TRL  PARRISH 34219"
    table.string('zip', 10);
    table.string('parcel_pin', 20);
    table.string('parcel_raw', 40);
    table.string('address_loose_key', 80);
    table.string('contractor_name', 160);
    table.string('contractor_license', 40);
    table.string('owner_name', 160);
    table.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
    table.index(['parcel_pin'], 'idx_construction_permits_pin');
    table.index(['address_loose_key'], 'idx_construction_permits_loose');
    table.index(['issued_date'], 'idx_construction_permits_issued');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('construction_permit_records'))) return;
  await knex.schema.dropTable('construction_permit_records');
};
