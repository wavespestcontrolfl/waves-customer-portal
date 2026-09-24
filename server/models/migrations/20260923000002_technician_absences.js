/**
 * technician_absences — "tech out today" (GATE_TECH_OUT_REDISTRIBUTE).
 *
 * One row per technician marked out for a calendar date. markTechOut
 * (services/tech-out.js) inserts the row and stores the redistribution
 * summary it computed (which stops moved, which parked as dispatch alerts)
 * on `redistribution`; clearTechOut stamps cleared_at/cleared_by without
 * moving anything back. The unique index on (technician_id, absence_date)
 * is the source of truth for "already marked out today" — a second attempt
 * hits the DB constraint (23505), which the service maps to a clean
 * ALREADY_OUT error rather than a duplicate row.
 *
 * No FK on created_by/cleared_by: both are technicians.id in practice, but
 * the actor stamp must never block on a technician row being deleted later,
 * matching other audit-stamp columns in this codebase (e.g. reviewed_by).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('technician_absences')) return;
  await knex.schema.createTable('technician_absences', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('technician_id').notNullable().references('id').inTable('technicians');
    t.date('absence_date').notNullable();
    t.text('reason').notNullable();
    t.text('note');
    t.uuid('created_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('cleared_at', { useTz: true });
    t.uuid('cleared_by');
    t.jsonb('redistribution');
  });
  // Partial: only ONE uncleared absence per tech+date. A cleared row ("tech
  // is back") must not block marking the same tech out again later the same
  // day — the service's ALREADY_OUT check reads the same predicate.
  await knex.raw(
    'CREATE UNIQUE INDEX technician_absences_open_uniq ON technician_absences (technician_id, absence_date) WHERE cleared_at IS NULL',
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('technician_absences');
};
