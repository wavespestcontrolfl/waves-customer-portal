/**
 * booking_make_room_checks: the make-room check's log (owner ruling 2026-11-06, "build this first";
 * GATE_BOOKING_MAKE_ROOM, services/scheduling/booking-make-room.js). One row per estimate-page offer list the check
 * ran on: whether a taken hour could have been freed for the new customer, the drive minutes it saves over the best
 * free time, and how many stops would move. Nothing reads it to change a visit or a list.
 *
 * Ids, dates, hours and minutes only: no customer name, address, phone number or map pin. `report` holds the
 * check's counts by reason and up to MAX_FULL_CHECKS passing hours as { date, start, techId, detourMin, savingMin,
 * moves: [{ id, from: 'HH:MM', to: 'HH:MM' }] }. estimate_id has no foreign key on purpose: this is a log, and an
 * estimate row must never be blocked by it. Additive; down drops the table.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('booking_make_room_checks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('mode').notNullable();
    t.text('surface').notNullable();
    t.uuid('estimate_id').nullable();
    t.boolean('fired').notNullable().defaultTo(false);
    t.integer('best_saving_min').nullable();
    t.integer('moved_count').nullable();
    t.jsonb('report').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['created_at'], 'booking_make_room_checks_created_at_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('booking_make_room_checks');
};
