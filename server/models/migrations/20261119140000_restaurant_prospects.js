/**
 * restaurant_prospects: the weekly restaurant prospect list built from Florida's public restaurant files
 * (services/prospects/dbpr-restaurants.js; owner approval 2026-11-19). Three kinds of row:
 *   new_license   a new food license in Manatee, Sarasota or Charlotte, Punta Gorda left out (source_key = Application Number)
 *   owner_change  an ownership change in the same counties (source_key = Application Number)
 *   inspection    an inspection that cited violation 35 (source_key = Inspection Visit ID)
 * (kind, source_key) is the identity: a re-read of the same file refreshes last_seen_at and nothing else.
 *
 * pest_evidence is for inspections only. NULL = the public report page is not read yet; true = the report holds a
 * 35A finding (roaches, rodents, flies); false = 35B only (outer openings not protected) or no 35 code on the page.
 * detail_attempts counts failed report reads. detail holds the disposition, the inspection type, the high-priority
 * count and, for 35A, the code and text of each finding (license kinds: the application type).
 * Public business records only: no customer data. Nothing here sends anything to anyone.
 *
 * Additive; down drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('restaurant_prospects')) return;
  await knex.schema.createTable('restaurant_prospects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('kind', 20).notNullable();
    t.string('source_key', 40).notNullable();
    t.string('license_number', 40);
    t.string('license_id', 40);
    t.string('license_type_code', 20);
    t.string('business_name', 200);
    t.string('address', 200);
    t.string('city', 80);
    t.string('zip', 10);
    t.string('county', 40);
    t.string('phone', 20);
    t.integer('seats');
    t.date('event_date');
    t.boolean('pest_evidence');
    t.jsonb('detail').notNullable().defaultTo('{}');
    t.integer('detail_attempts').notNullable().defaultTo(0);
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['kind', 'source_key'], { indexName: 'restaurant_prospects_kind_source_key' });
    t.index(['kind', 'event_date'], 'restaurant_prospects_kind_event_date_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('restaurant_prospects');
};
