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
 * date_exception_cadence_date is the row's SERIES POSITION — the cadence
 * date it deviated from — so a collective sweep orders and selects siblings
 * by position, not by the deliberately exceptional date (an exception pulled
 * before the anchor is still a later occurrence).
 *
 * BACKFILL (existing rows must keep working — AGENTS.md): every live cadence
 * visit that the rebooker moved on its own before this lane (reschedule_log
 * rows for a single-visit date move by staff, the customer, an SMS reply or
 * a rain-out — never auto-dispatch, never a `_series` anchor log) is stamped
 * as an exception with its earliest logged original_date as its cadence
 * position, so the first collective move shifts it instead of regenerating
 * it. Moves made from the Edit appointment modal before this lane wrote no
 * reschedule_log row — for those, a second pass walks every live series and
 * marks any occurrence whose date deviates from the cadence projected off
 * the series' first live occurrence (same projector rescheduleSeries uses),
 * with that projected date as its cadence position. A false positive costs
 * nothing (the row shifts by the delta instead of being re-projected); a
 * miss would erase a customer's exception — so deviation wins.
 */
const { nextRecurringDate, recurrenceOrdinalOptions, isMonthBasedRecurrence } = require('../../services/rebooker');
const { parseETDateTime, etParts, etDateString, addETDays } = require('../../utils/datetime-et');

const dateOnly = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

// Pure: which live occurrences of one series sit off their projected cadence
// date. `rows` = the series' live occurrences (parent included when live)
// ordered by series position (cadence date, else date). Exported for tests.
function planCadenceExceptions(parent, rows) {
  if (!parent?.recurring_pattern || !rows.length) return [];
  const anchorDate = dateOnly(rows[0].date_exception ? rows[0].date_exception_cadence_date || rows[0].scheduled_date : rows[0].scheduled_date);
  const opts = {
    ...(isMonthBasedRecurrence(parent.recurring_pattern)
      ? recurrenceOrdinalOptions(anchorDate)
      : { nth: parent.recurring_nth, weekday: parent.recurring_weekday }),
    intervalDays: parent.recurring_interval_days,
  };
  const shiftWeekend = (out) => {
    if (!parent.skip_weekends) return out;
    const at = parseETDateTime(`${out}T12:00`);
    const { dayOfWeek } = etParts(at);
    if (dayOfWeek !== 0 && dayOfWeek !== 6) return out;
    const back = parent.weekend_shift === 'back';
    return etDateString(addETDays(at, back ? (dayOfWeek === 6 ? -1 : -2) : (dayOfWeek === 6 ? 2 : 1)));
  };
  const planned = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.date_exception === true) continue;
    const expected = shiftWeekend(nextRecurringDate(anchorDate, parent.recurring_pattern, i, opts));
    if (expected && dateOnly(row.scheduled_date) !== expected) planned.push({ id: row.id, expected });
  }
  return planned;
}
exports.planCadenceExceptions = planCadenceExceptions;

async function backfillCadenceDeviations(knex) {
  const parents = await knex('scheduled_services as p')
    .whereExists(function liveChild() {
      this.select(1).from('scheduled_services as c')
        .whereRaw('c.recurring_parent_id = p.id')
        .where('c.is_recurring', true)
        .whereNotIn('c.status', ['completed', 'cancelled'])
        .whereRaw("c.scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date");
    })
    .whereNotNull('p.recurring_pattern')
    .select('p.*');
  let stamped = 0;
  for (const parent of parents) {
    const rows = await knex('scheduled_services')
      .whereRaw('(id = ? OR (recurring_parent_id = ? AND is_recurring = true))', [parent.id, parent.id])
      .whereNotIn('status', ['completed', 'cancelled'])
      .whereRaw("scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date")
      .orderByRaw('COALESCE(date_exception_cadence_date, scheduled_date) asc, scheduled_date asc')
      .select('id', 'scheduled_date', 'date_exception', 'date_exception_cadence_date');
    for (const plan of planCadenceExceptions(parent, rows)) {
      stamped += await knex('scheduled_services')
        .where({ id: plan.id, date_exception: false })
        .update({
          date_exception: true,
          date_exception_source: 'backfill_cadence',
          date_exception_at: knex.fn.now(),
          date_exception_cadence_date: plan.expected,
        });
    }
  }
  return stamped;
}
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
      t.string('status', 20).notNullable().defaultTo('committed'); // committed | failed | reverted | superseded
      t.text('error');
      t.jsonb('rows').notNullable().defaultTo('[]');
      t.jsonb('result');
      t.boolean('customer_notified').notNullable().defaultTo(false);
      // Whether the initiating surface asked for the customer text — read
      // by the effects reconciler when it finishes a pass that died.
      t.boolean('notify_requested').notNullable().defaultTo(false);
      t.timestamp('notified_at', { useTz: true });
      t.timestamp('conflict_card_at', { useTz: true });
      t.timestamp('reminders_synced_at', { useTz: true });
      // Post-commit effects run under a short lease held by ONE pass; the
      // three completion markers above are stamped after each effect lands,
      // so a pass that dies mid-way leaves an expired lease and unfinished
      // markers for the next retry — never a permanent skip.
      t.timestamp('effects_lease_until', { useTz: true });
      t.string('effects_lease_owner', 64);
      t.timestamp('reverted_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index('anchor_service_id');
      t.index('customer_id');
      t.index('created_at');
    });
  }
  // Partial unique, scoped to the anchor: a failed attempt must not block the
  // retry that succeeds, and a caller-minted key only ever replays a move of
  // the SAME appointment (rebooker.rescheduleSeries checks the target too).
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_series_moves_operation_key_committed ON series_moves (anchor_service_id, operation_key) WHERE operation_key IS NOT NULL AND status = 'committed'",
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
      t.date('date_exception_cadence_date');
    });
    const backfilled = await knex.raw(`
      UPDATE scheduled_services s
         SET date_exception = true,
             date_exception_source = 'backfill',
             date_exception_at = l.last_moved_at,
             date_exception_cadence_date = l.first_original_date
        FROM (
          -- Cadence position = the original_date of the FIRST logged move
          -- (by created_at — the date the row deviated from), not the
          -- calendar-smallest original_date: a visit first pushed back and
          -- later pulled forward must not be positioned at its later slot.
          SELECT f.scheduled_service_id,
                 f.original_date AS first_original_date,
                 m.last_moved_at
            FROM (
              SELECT DISTINCT ON (scheduled_service_id) scheduled_service_id, original_date
                FROM reschedule_log
               WHERE original_date IS NOT NULL
                 AND new_date IS NOT NULL
                 AND original_date <> new_date
                 AND COALESCE(initiated_by, '') <> 'auto_dispatch'
                 AND COALESCE(reason_code, '') NOT LIKE '%\\_series'
               ORDER BY scheduled_service_id, created_at ASC, id ASC
            ) f
            JOIN (
              SELECT scheduled_service_id, MAX(created_at) AS last_moved_at
                FROM reschedule_log
               WHERE original_date IS NOT NULL
                 AND new_date IS NOT NULL
                 AND original_date <> new_date
                 AND COALESCE(initiated_by, '') <> 'auto_dispatch'
                 AND COALESCE(reason_code, '') NOT LIKE '%\\_series'
               GROUP BY scheduled_service_id
            ) m ON m.scheduled_service_id = f.scheduled_service_id
        ) l
       WHERE s.id = l.scheduled_service_id
         AND s.is_recurring = true
         AND s.status NOT IN ('completed', 'cancelled')
         AND s.scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date
         AND s.date_exception = false
    `);
     
    console.log(`[20260828000030] backfilled ${backfilled.rowCount ?? '?'} pre-existing manual date exception(s) from reschedule_log`);
    const deviations = await backfillCadenceDeviations(knex);
     
    console.log(`[20260828000030] backfilled ${deviations} cadence deviation(s) (modal-moved and other unlogged exceptions)`);
  }
};

exports.down = async function down(knex) {
  const hasException = await knex.schema.hasColumn('scheduled_services', 'date_exception');
  if (hasException) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('date_exception');
      t.dropColumn('date_exception_source');
      t.dropColumn('date_exception_at');
      t.dropColumn('date_exception_cadence_date');
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
