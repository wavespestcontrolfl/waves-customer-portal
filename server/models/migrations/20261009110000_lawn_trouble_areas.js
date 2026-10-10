/**
 * Lawn trouble areas and the place of a spot treatment (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09).
 *
 * A spot treatment now records WHERE on the lawn it went (Front, Back, Left side, Right side), so the
 * v13 yearly limits can be counted per place and the lawn can remember its trouble areas.
 *
 *   service_products.treated_place              varchar(24), nullable. The place the technician chose
 *   property_application_history.treated_place  for a spot row; written at completion beside the
 *                                               product record and the ledger row. NULL = no place on
 *                                               record (every row before this gate, and every whole-lawn
 *                                               row): such a row counts against EVERY place of its lawn.
 *
 *   lawn_trouble_areas                          one row per (property, place, type): the first writer
 *                                               wins (first_seen_on, source); a later treatment only
 *                                               moves last_seen_on / last_treated_on / the last service
 *                                               record and reactivates a cleared row. A technician can
 *                                               clear one (status cleared, cleared_at, cleared_by).
 *                                               Technician and office only: no customer read.
 *
 * The closed lists are checked by the database for the new table (place, type, status, source) and by the
 * code for the two nullable columns (those tables are large and shared; a CHECK there adds nothing the
 * writer does not already enforce). Nothing reads any of it while the gate is off.
 *
 * down() drops the new table, then the two columns and their index. The columns hold only what this
 * migration's writer put there (a place the technician chose), so dropping them loses nothing a prior
 * version read.
 */
const TABLE = 'lawn_trouble_areas';
const LEDGER = 'property_application_history';
const PRODUCTS = 'service_products';
const LEDGER_INDEX = 'idx_pah_customer_property_place';

const PLACES = ['front', 'back', 'left_side', 'right_side'];
const TYPES = ['weeds', 'fungus', 'take_all', 'chinch', 'other_insect', 'dry_spot'];
const SOURCES = ['tech_tap', 'guide_card'];

const inList = (values) => values.map((value) => `'${value}'`).join(', ');

exports.PLACES = PLACES;
exports.TYPES = TYPES;
exports.SOURCES = SOURCES;

exports.up = async function up(knex) {
  for (const table of [PRODUCTS, LEDGER]) {
    if ((await knex.schema.hasTable(table)) && !(await knex.schema.hasColumn(table, 'treated_place'))) {
      await knex.schema.alterTable(table, (t) => { t.string('treated_place', 24).nullable(); });
    }
  }
  // The per-place reader scopes by the ledger's own property (20261007178000), so the index leads with it.
  if ((await knex.schema.hasTable(LEDGER)) && (await knex.schema.hasColumn(LEDGER, 'property_id'))) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${LEDGER_INDEX} ON ${LEDGER} (customer_id, property_id, product_id, treated_place)`);
  }

  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('property_id').notNullable().references('id').inTable('customer_properties').onDelete('CASCADE');
    t.string('place', 24).notNullable();
    t.string('type', 24).notNullable();
    t.string('status', 12).notNullable().defaultTo('active');
    t.string('source', 16).notNullable();
    t.date('first_seen_on').notNullable();
    t.date('last_seen_on').notNullable();
    t.date('last_treated_on').nullable();
    // The service records of the first and the latest treatment. A record that is removed later leaves the area.
    t.uuid('first_service_record_id').nullable().references('id').inTable('service_records').onDelete('SET NULL');
    t.uuid('last_service_record_id').nullable().references('id').inTable('service_records').onDelete('SET NULL');
    t.timestamp('cleared_at', { useTz: true }).nullable();
    t.uuid('cleared_by_technician_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['property_id', 'place', 'type'], { indexName: 'uq_lawn_trouble_areas_place_type' });
    t.index(['property_id', 'status'], 'idx_lawn_trouble_areas_property_status');
  });
  await knex.raw(`ALTER TABLE ${TABLE}
    ADD CONSTRAINT chk_lawn_trouble_areas_place CHECK (place IN (${inList(PLACES)})),
    ADD CONSTRAINT chk_lawn_trouble_areas_type CHECK (type IN (${inList(TYPES)})),
    ADD CONSTRAINT chk_lawn_trouble_areas_status CHECK (status IN ('active', 'cleared')),
    ADD CONSTRAINT chk_lawn_trouble_areas_source CHECK (source IN (${inList(SOURCES)}))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
  await knex.raw(`DROP INDEX IF EXISTS ${LEDGER_INDEX}`);
  for (const table of [LEDGER, PRODUCTS]) {
    if ((await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, 'treated_place'))) {
      await knex.schema.alterTable(table, (t) => { t.dropColumn('treated_place'); });
    }
  }
};
