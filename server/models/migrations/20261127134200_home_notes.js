// home_notes: ONE short lasting staff note per home ("About this home"), shown at the top of every visit on the
// technician's Visit Brief (owner 2026-11-26, "ALL REC"). Any technician assigned to a visit at the home, and any
// admin, can read and edit it. Staff-only free text: it never reaches a customer, a report, a token page or a model.
//
//   customer_id       the customer the home belongs to (ON DELETE CASCADE: the note goes with the customer)
//   property_id       the customer_properties row the visit is at; NULL = a customer with no single known property
//                     (ON DELETE CASCADE: the note goes with the property it describes)
//   body              the note, at most 1000 characters, never empty (saving an empty note deletes the row)
//   updated_by_type   'technician' | 'admin': the role of the staff login that last saved it
//   updated_by_id     that staff login (technicians.id; no FK so offboarding a login never touches the note)
//
// One row per home: the unique index treats a NULL property as ONE home per customer (COALESCE to the nil uuid), so
// "customer with no property" cannot hold two notes. No data is written here; the table starts empty.
// down() drops the table: nothing else references it.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('home_notes')) return;
  await knex.schema.createTable('home_notes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('property_id').nullable().references('id').inTable('customer_properties').onDelete('CASCADE');
    t.text('body').notNullable();
    t.string('updated_by_type', 16).notNullable();
    t.uuid('updated_by_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('ALTER TABLE home_notes ADD CONSTRAINT home_notes_body_chk CHECK (length(body) BETWEEN 1 AND 1000)');
  await knex.raw("ALTER TABLE home_notes ADD CONSTRAINT home_notes_updated_by_type_chk CHECK (updated_by_type IN ('technician', 'admin'))");
  await knex.raw("CREATE UNIQUE INDEX home_notes_home_uidx ON home_notes (customer_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid))");
  await knex.raw('CREATE INDEX home_notes_property_idx ON home_notes (property_id) WHERE property_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('home_notes');
};
