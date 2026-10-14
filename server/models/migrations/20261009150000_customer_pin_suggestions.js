/**
 * Pin check after a visit (GATE_PIN_PARKED_CHECK, owner "build guardrail" 2026-10-09).
 *
 * customer_pin_suggestions holds the suggestions the daily job in services/pin-parked-check.js makes: a
 * customer whose completed visit had the technician's truck parked 175 m to 1500 m from the saved map pin
 * (and never inside the arrival radius) gets ONE open suggestion naming where the truck stopped. Staff apply it
 * through the existing verify_pin action, or dismiss it. The table never changes a pin.
 *
 *   status        open        the one live suggestion for the customer (a partial unique index allows one)
 *                 applied     staff used the truck's spot through verify_pin
 *                 dismissed   staff said the pin is right; not raised again for the same pin
 *                 superseded  closed by the system: the pin was verified or changed, a later stop landed inside
 *                             the arrival radius, or the customer is gone. The row stays as history.
 *   pin_*         the customer's saved pin when the suggestion was made (what verify_pin replaces)
 *   parked_*      the centre of the truck's stop, and distance_m / stop_minutes how far from the pin and how long
 *   notified_at   when the admin notification was posted; NULL = not yet (the job retries it, the bell is keyed
 *                 on the suggestion id so a retry never rings twice)
 *
 * The closed status list is checked by the database. down() drops the table; it holds only what the job wrote.
 */
const TABLE = 'customer_pin_suggestions';
const STATUSES = ['open', 'applied', 'dismissed', 'superseded'];

exports.STATUSES = STATUSES;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('scheduled_service_id').nullable().references('id').inTable('scheduled_services').onDelete('SET NULL');
    t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.date('visit_date').notNullable();
    t.decimal('pin_lat', 10, 7).notNullable();
    t.decimal('pin_lng', 10, 7).notNullable();
    t.decimal('parked_lat', 10, 7).notNullable();
    t.decimal('parked_lng', 10, 7).notNullable();
    t.integer('distance_m').notNullable();
    t.integer('stop_minutes').notNullable();
    t.timestamp('stop_started_at', { useTz: true }).nullable();
    t.string('status', 12).notNullable().defaultTo('open');
    t.timestamp('resolved_at', { useTz: true }).nullable();
    t.uuid('resolved_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('notified_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT customer_pin_suggestions_status_check
    CHECK (status IN (${STATUSES.map((value) => `'${value}'`).join(', ')}))`);
  // One live suggestion per customer: a re-run, a second instance or a double click can never add a second.
  await knex.raw(`CREATE UNIQUE INDEX customer_pin_suggestions_one_open ON ${TABLE} (customer_id) WHERE status = 'open'`);
  await knex.raw(`CREATE INDEX customer_pin_suggestions_customer_status ON ${TABLE} (customer_id, status)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
