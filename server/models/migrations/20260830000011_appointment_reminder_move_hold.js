/**
 * appointment_reminders.move_hold_until — a durable send hold for grouped
 * unit moves (visit-groups.moveVisitAsUnit; codex #3609 r28/r29).
 *
 * The unit mover moves members in separate transactions; while a stop is
 * mid-move (and after a PARTIAL move, until staff repair it) NO automated
 * message may fire for its members — but the sent flags cannot carry that
 * hold: sync_appointment_reminder_on_service_change recalculates them for
 * every slot change the move itself writes. This column is untouched by
 * that trigger and honored by the senders (deliverConfirmation's deferred
 * recheck, the 72h/24h reminder sweep): a row is quiet while
 * move_hold_until > now(). Self-healing: the mover stamps now()+24h, clears
 * it on full success, and leaves it to expire on a partial so a forgotten
 * repair can never silence a customer forever.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('appointment_reminders'))) return;
  if (await knex.schema.hasColumn('appointment_reminders', 'move_hold_until')) return;
  await knex.schema.alterTable('appointment_reminders', (t) => {
    t.timestamp('move_hold_until');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('appointment_reminders'))) return;
  if (!(await knex.schema.hasColumn('appointment_reminders', 'move_hold_until'))) return;
  await knex.schema.alterTable('appointment_reminders', (t) => {
    t.dropColumn('move_hold_until');
  });
};
