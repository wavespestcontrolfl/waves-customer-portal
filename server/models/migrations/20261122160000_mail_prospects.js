'use strict';

/**
 * mail_prospects: one row per household a Waves mail list found (list_key says which list; the first is
 * 'new_home': a home a builder just sold to a person, read from the Manatee County Clerk's public daily deed list
 * and matched to a parcel and a new-home permit). The only module that reads or writes it is
 * services/mail/prospect-store.js.
 *
 * Names are copied from a public county record (recipient_names as the Clerk lists them). The first lists only
 * fill the table (shadow): nothing is sent from it.
 *
 * status: eligible | held_back | not_eligible | unmatched. 'held_back' is the fixed one in five homes that never get
 * a card, so a later PR can compare them with the mailed ones. reason is null for eligible / held_back.
 *
 * Text the county wrote (the deed's legal description, the parcel's address, city and subdivision) is stored in
 * text columns: a long value must never make a deed fail on every run. The limited columns hold this feature's own
 * codes and ids whose shape the readers check (instrument number, parcel number, permit number, zip).
 *
 * One home can be on a list once: the partial unique index covers only live rows (eligible, held_back), so a second
 * deed for the same parcel is stored as not_eligible / duplicate_parcel instead of failing the run. Reading the same
 * deed again updates its row: (list_key, source, source_ref) is the identity.
 *
 * Additive; down drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('mail_prospects')) return;
  await knex.schema.createTable('mail_prospects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('list_key', 40).notNullable();
    t.string('source', 40).notNullable();
    t.string('source_ref', 40).notNullable();
    t.date('recorded_date').notNullable();
    t.jsonb('seller_names').notNullable().defaultTo('[]');
    t.jsonb('recipient_names').notNullable().defaultTo('[]');
    t.string('buyer_kind', 20);
    t.decimal('consideration', 14, 2);
    t.text('legal_description');
    t.string('status', 20).notNullable();
    t.string('reason', 40);
    t.string('match_basis', 20);
    t.string('parcel_pin', 20);
    t.string('permit_no', 40);
    t.date('co_date');
    t.text('address_line1');
    t.text('city');
    t.string('state', 2).defaultTo('FL');
    t.string('zip', 10);
    t.text('subdivision');
    t.integer('living_sqft');
    t.decimal('stories', 4, 1);
    t.integer('year_built');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['list_key', 'source', 'source_ref'], { indexName: 'mail_prospects_list_source_ref_key' });
    t.index(['list_key', 'status'], 'mail_prospects_list_status_idx');
    t.index(['recorded_date'], 'mail_prospects_recorded_date_idx');
  });
  await knex.raw(
    "CREATE UNIQUE INDEX mail_prospects_one_live_per_parcel ON mail_prospects (list_key, parcel_pin) WHERE status IN ('eligible', 'held_back')",
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('mail_prospects');
};
