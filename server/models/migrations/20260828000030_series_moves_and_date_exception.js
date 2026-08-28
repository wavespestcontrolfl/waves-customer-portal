/**
 * Collective series moves — one operation boundary per shift (owner rulings
 * 2026-07-30 "schedule follows the last treatment" + 2026-08-28 "any and all
 * recurring appts move with their sister appts").
 *
 * series_moves: one row per series shift (any surface). operation_key dedupes
 * the INITIATING action — a retried request with the same key returns the
 * committed result instead of shifting the series again; the row's id is the
 * idempotency key for every downstream effect (SMS, conflict card, reminder
 * sync, board broadcast — each stamps its marker here). `rows` holds per-row
 * before/after snapshots INCLUDING updated_at so a later Undo can refuse to
 * overwrite an appointment somebody edited after the move (restore recorded
 * state, never a negative delta). Failed attempts are recorded too (status
 * 'failed', written outside the move transaction) — the row doubles as the
 * telemetry the un-gate review reads.
 *
 * scheduled_services.date_exception: this occurrence intentionally deviates
 * from its series-derived date (a this-visit-only move by staff, the
 * customer, or an SMS reply — never auto-dispatch, whose nudges are not
 * intent). A collective move shifts an exception by the anchor's delta instead
 * of regenerating it from cadence, so "Nov 17 because the customer is
 * traveling" survives "Sep 10 → Sep 15". Clears when a collective move lands
 * the row back on its cadence-derived date. Provenance columns explain why a
 * row is exceptional without reschedule_log archaeology.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('series_moves'))) {
    await knex.schema.createTable('series_moves', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('operation_key', 120);
      t.uuid('anchor_service_id').notNullable().references('id').inTable('scheduled_services');
      t.uuid('parent_service_id').references('id').inTable('scheduled_services');
      t.uuid('customer_id').references('id').inTable('customers');
      t.string('source_surface', 40).notNullable();
      t.string('initiated_by', 20).notNullable();
      t.string('reason_code', 30);
      t.date('original_date').notNullable();
      t.date('new_date').notNullable();
      t.integer('delta_days').notNullable();
      t.integer('movable_count').notNullable().defaultTo(0);
      t.integer('skipped_count').notNullable().defaultTo(0);
      t.integer('exception_count').notNullable().defaultTo(0);
      t.integer('conflict_count').notNullable().defaultTo(0);
      t.string('status', 20).notNullable().defaultTo('committed'); // committed | failed | reverted
      t.text('error');
      t.jsonb('rows').notNullable().defaultTo('[]');
      t.jsonb('result');
      t.boolean('customer_notified').notNullable().defaultTo(false);
      t.timestamp('notified_at', { useTz: true });
      t.timestamp('conflict_card_at', { useTz: true });
      t.timestamp('reminders_synced_at', { useTz: true });
      t.timestamp('reverted_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index('anchor_service_id');
      t.index('customer_id');
      t.index('created_at');
    });
  }
  // Partial unique: a failed attempt must not block the retry that succeeds.
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_series_moves_operation_key_committed ON series_moves (operation_key) WHERE operation_key IS NOT NULL AND status = 'committed'",
  );

  if (!(await knex.schema.hasColumn('reschedule_log', 'series_move_id'))) {
    await knex.schema.alterTable('reschedule_log', (t) => {
      t.uuid('series_move_id').references('id').inTable('series_moves');
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_reschedule_log_series_move_id ON reschedule_log (series_move_id) WHERE series_move_id IS NOT NULL');

  const hasException = await knex.schema.hasColumn('scheduled_services', 'date_exception');
  if (!hasException) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.boolean('date_exception').notNullable().defaultTo(false);
      t.string('date_exception_source', 30);
      t.timestamp('date_exception_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  const hasException = await knex.schema.hasColumn('scheduled_services', 'date_exception');
  if (hasException) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('date_exception');
      t.dropColumn('date_exception_source');
      t.dropColumn('date_exception_at');
    });
  }
  await knex.raw('DROP INDEX IF EXISTS idx_reschedule_log_series_move_id');
  if (await knex.schema.hasColumn('reschedule_log', 'series_move_id')) {
    await knex.schema.alterTable('reschedule_log', (t) => {
      t.dropColumn('series_move_id');
    });
  }
  await knex.schema.dropTableIfExists('series_moves');
};
