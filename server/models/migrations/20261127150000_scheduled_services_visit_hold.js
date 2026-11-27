// Visit on hold, "customer will call" (owner 2026-11-27, "build hold"; GATE_VISIT_HOLD).
//
// A held visit keeps its status (pending / confirmed), so every plan-count reader still sees it as a visit of the plan.
// The hold lives in four columns on scheduled_services; readers that send, move or show a visit skip a row whose
// held_at is set (services/visit-hold.js). Nothing is written here: every column starts NULL, so every existing row
// reads "not held".
//
//   held_at            when the visit was put on hold; NULL = not held. THE hold predicate: a reader that skips held
//                      visits tests `held_at IS NULL` and nothing else. Cleared on release and on the series close.
//   held_by            the staff login that put it on hold (technicians.id; an admin is a technicians row too).
//                      SET NULL on delete so offboarding a login never blocks.
//   hold_note          the short note typed with the hold (staff only, never reaches a customer). <= 280 characters.
//   hold_released_at   when the last hold ended (release, reschedule, or the series close); NULL while a hold is open or
//                      for a visit never held. A new hold clears it.
//
// A partial index serves the office list of held visits and the day-14 sweep without touching live rows.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const has = (c) => knex.schema.hasColumn('scheduled_services', c);
  const needHeldAt = !(await has('held_at'));
  const needHeldBy = !(await has('held_by'));
  const needNote = !(await has('hold_note'));
  const needReleased = !(await has('hold_released_at'));
  if (needHeldAt || needHeldBy || needNote || needReleased) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      if (needHeldAt) t.timestamp('held_at', { useTz: true }).nullable();
      if (needHeldBy) t.uuid('held_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      if (needNote) t.string('hold_note', 280).nullable();
      if (needReleased) t.timestamp('hold_released_at', { useTz: true }).nullable();
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_scheduled_services_held ON scheduled_services (held_at) WHERE held_at IS NOT NULL');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_held');
  for (const c of ['hold_released_at', 'hold_note', 'held_by', 'held_at']) {
    if (await knex.schema.hasColumn('scheduled_services', c)) {
      await knex.schema.alterTable('scheduled_services', (t) => t.dropColumn(c));
    }
  }
};
