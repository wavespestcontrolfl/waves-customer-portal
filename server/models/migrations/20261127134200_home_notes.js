// home_notes: ONE short lasting staff note per customer ("About this home"), shown at the top of every visit on the
// technician's Visit Brief (owner 2026-11-26, "ALL REC"). Any technician assigned to a visit for the customer, and any
// admin, can read and edit it. Staff-only free text: it never reaches a customer, a report, a token page or a model.
// Keyed by customer alone, like property_preferences (which the brief's access block already reads for every visit of a
// customer): a customer with several homes shares one note, and a visit never has to resolve which home it is at.
//
//   customer_id       the customer the note belongs to; UNIQUE (one note each); ON DELETE CASCADE: it goes with the customer
//   body              the note, never empty (saving an empty note deletes the row). The API and the screens cap a save at
//                     1000 characters; the table allows up to 2100 only so a customer merge can join two full notes
//                     ("<kept note>\n(merged) <archived note>" = 1000 + 10 + 1000) without ever dropping text
//   revision          1 on creation, +1 on every save: what the stale-save check compares (updated_at is for display only)
//   updated_by_type   'technician' | 'admin': the role of the staff login that last saved it
//   updated_by_id     that staff login (technicians.id; no FK so offboarding a login never touches the note)
//
// No data is written here; the table starts empty. down() drops the table: nothing else references it.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('home_notes')) return;
  await knex.schema.createTable('home_notes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().unique().references('id').inTable('customers').onDelete('CASCADE');
    t.text('body').notNullable();
    t.integer('revision').notNullable().defaultTo(1);
    t.string('updated_by_type', 16).notNullable();
    t.uuid('updated_by_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('ALTER TABLE home_notes ADD CONSTRAINT home_notes_body_chk CHECK (length(body) BETWEEN 1 AND 2100)');
  await knex.raw('ALTER TABLE home_notes ADD CONSTRAINT home_notes_revision_chk CHECK (revision >= 1)');
  await knex.raw("ALTER TABLE home_notes ADD CONSTRAINT home_notes_updated_by_type_chk CHECK (updated_by_type IN ('technician', 'admin'))");
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('home_notes');
};
