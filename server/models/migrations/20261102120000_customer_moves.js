// Customer moving flow, PR 1 (owner 2026-11-02, "a moving email where they can
// do it"), dark behind GATE_MOVING_FLOW.
//
//   customer_moves  one row per move a customer tells us about. The office
//                   sends a link (email or text) that carries `token`; the
//                   public /moving/:token page fills in the new address and the
//                   move dates; submitting it makes one office item
//                   (service_requests row `service_request_id`).
//
// Address checks are a PAID Google call, so the row also carries the spend
// guard: validation_calls / validation_day (calls today, ET) cap the checks per
// link, and last_check holds the last typed text, Google's answer and when it
// ran, so the same text is answered from the row for 24 hours and a submit can
// only use an address the SERVER checked (never a verdict the browser sends).
//
// This table changes nothing else: no property, visit, price or plan row is
// touched by a move. One open-or-submitted move per customer (partial unique
// index); a closed move leaves room for the next one.
//
// The office half (PR 2: "Estimate for new home" and "Apply move") fills the
// columns reserved for it here, so it needs no second migration:
// to_property_id (the saved property for the new home), estimate_id (the
// new-home estimate), applied_at / applied_by, and closed_reason (why the row
// closed: applied, cancelled, out_of_area). PR 1 never writes them.
//
// No data is written here; the table starts empty.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_moves')) return;
  await knex.schema.createTable('customer_moves', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('token', 64).notNullable().unique();
    t.string('status', 16).notNullable().defaultTo('open');
    t.uuid('from_property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
    t.text('typed_address').nullable();
    t.jsonb('normalized_address').nullable();
    t.string('address_verdict', 16).nullable();
    t.jsonb('last_check').nullable();
    t.integer('validation_calls').notNullable().defaultTo(0);
    t.date('validation_day').nullable();
    t.date('move_out_date').nullable();
    t.date('move_in_date').nullable();
    t.uuid('service_request_id').nullable().references('id').inTable('service_requests').onDelete('SET NULL');
    t.timestamp('link_sent_at', { useTz: true }).nullable();
    t.uuid('link_sent_by').nullable();
    t.string('link_channel', 16).nullable();
    t.timestamp('submitted_at', { useTz: true }).nullable();
    t.uuid('to_property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
    t.uuid('estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
    t.timestamp('applied_at', { useTz: true }).nullable();
    t.uuid('applied_by').nullable();
    t.timestamp('closed_at', { useTz: true }).nullable();
    t.string('closed_reason', 24).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['customer_id'], 'customer_moves_customer_idx');
  });
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_status_check
    CHECK (status IN ('open', 'submitted', 'closed'))`);
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_address_verdict_check
    CHECK (address_verdict IS NULL OR address_verdict IN ('in_area', 'out_of_area', 'unverified'))`);
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_closed_reason_check
    CHECK (closed_reason IS NULL OR closed_reason IN ('applied', 'cancelled', 'out_of_area'))`);
  await knex.raw(`CREATE UNIQUE INDEX customer_moves_one_live_per_customer
    ON customer_moves (customer_id) WHERE status IN ('open', 'submitted')`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_moves');
};
