/**
 * Data pass (GATE_SEPARATE_COMBO_VISITS flip, 2026-08-31) — the last four
 * live combined-label visits, both owner-decided 2026-08-31:
 *
 * Leg A — CANCEL two "Quarterly Pest + Termite Bait Station Service"
 *   visits (one customer, one series parent). Prod read: that customer
 *   already holds a separate quarterly pest series AND a separate termite
 *   bait series for the same windows — these two are leftovers of an
 *   earlier, since-cancelled accept. Owner chose the migration over the UI
 *   so the customer receives NO cancellation notice for visits they never
 *   knew about (direct writes fire zero comms). Mirrors the app's cancel
 *   shape without the notification: status 'cancelled' + cancelled_at +
 *   cancellation_reason, and the reminder row marked cancelled under the
 *   same "visit is cancelled" EXISTS guard handleCancellation uses. CAS:
 *   still open, still that label, still linked to the retired combined
 *   row, no invoice / prepay term / visit group attached (all NULL today).
 *
 * Leg B — RELABEL two "Quarterly Termite Bait Station + Termite Bond
 *   Service" visits (one customer, Square rebooking-cleanup imports:
 *   "Clarified by operator as termite service"; the customer has NO
 *   estimate and NO termite_bonds row — no bond was ever sold through the
 *   portal, and the label was a cleanup guess). Left alone, completion
 *   would mint a default 1-year warranty out of nothing. They become plain
 *   Termite Bait Station Service visits: label + service_id + snapshot
 *   (the edit path's triple), reminder relabeled under the old-label
 *   guard. If the owner later confirms a bond WAS sold, a rider is a
 *   one-line follow-up. Same CAS / ledger / down() rules as 20260831000071.
 *
 * Population by exact label + open status, never by customer or name.
 * 'rescheduled' placeholders are not live for either leg.
 */

const STATE_KEY = 'migration.20260831000072.state';
const DUP_LABEL = 'Quarterly Pest + Termite Bait Station Service';
const DUP_COMBO_KEY = 'pest_termite_bait_quarterly';
const BOND_LABEL = 'Quarterly Termite Bait Station + Termite Bond Service';
const NEW_LABEL = 'Termite Bait Station Service';
const TARGET_KEY = 'termite_bait';
const CANCEL_REASON = 'Duplicate combined visit: this customer already has separate quarterly pest and termite bait series booked (combo retirement data pass, 2026-08-31).';
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

function openVisitStatus(q) {
  return q.where((b) => b.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES));
}

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return typeof row.value === 'string' ? JSON.parse(row.value) : row.value; } catch { return null; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'service_id'))) return;
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  const hasCancelledAt = await knex.schema.hasColumn('scheduled_services', 'cancelled_at');
  const hasCancelReason = await knex.schema.hasColumn('scheduled_services', 'cancellation_reason');
  const hasVisitId = await knex.schema.hasColumn('scheduled_services', 'visit_id');
  const hasPrepayTerm = await knex.schema.hasColumn('scheduled_services', 'annual_prepay_term_id');

  const prior = await loadState(knex);
  const state = {
    cancelled: Array.isArray(prior?.cancelled) ? prior.cancelled : [],
    relabeled: Array.isArray(prior?.relabeled) ? prior.relabeled : [],
    missing_catalog: false,
  };
  const doneCancel = new Set(state.cancelled.map((r) => r.id));
  const doneRelabel = new Set(state.relabeled.map((r) => r.id));

  // ── Leg A: cancel the duplicate combined visits ──
  const combo = await knex('services').where({ service_key: DUP_COMBO_KEY }).first('id');
  if (combo) {
    const dups = await openVisitStatus(
      knex('scheduled_services').where({ service_type: DUP_LABEL, service_id: combo.id }),
    ).select('id');
    for (const v of dups) {
      let cas = openVisitStatus(
        knex('scheduled_services').where({ id: v.id, service_type: DUP_LABEL, service_id: combo.id }),
      );
      if (hasVisitId) cas = cas.whereNull('visit_id');
      if (hasPrepayTerm) cas = cas.whereNull('annual_prepay_term_id');
      cas = cas.whereNotExists(function noInvoice() {
        this.select(1).from('invoices').whereRaw('invoices.scheduled_service_id = scheduled_services.id');
      });
      const patch = { status: 'cancelled', updated_at: knex.fn.now() };
      if (hasCancelledAt) patch.cancelled_at = knex.fn.now();
      if (hasCancelReason) patch.cancellation_reason = CANCEL_REASON;
      const n = await cas.update(patch);
      if (!n) continue;
      let reminderClosed = false;
      if (hasReminders) {
        reminderClosed = (await knex('appointment_reminders')
          .where({ scheduled_service_id: v.id, cancelled: false })
          .whereRaw("EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = appointment_reminders.scheduled_service_id AND ss.status = 'cancelled')")
          .update({ cancelled: true, updated_at: knex.fn.now() })) > 0;
      }
      if (!doneCancel.has(v.id)) {
        state.cancelled.push({ id: v.id, reminder: reminderClosed });
        doneCancel.add(v.id);
      }
    }
  }

  // ── Leg B: relabel the Square-import "bait + bond" visits to plain bait ──
  const bait = await knex('services')
    .where({ service_key: TARGET_KEY, is_active: true, is_archived: false })
    .first('id', 'service_key');
  if (!bait) {
    state.missing_catalog = true;
  } else {
    let q = openVisitStatus(knex('scheduled_services').where({ service_type: BOND_LABEL }).whereNull('service_id'));
    if (hasSnapshotCol) q = q.whereNull('service_key_snapshot');
    const rows = await q.select('id');
    for (const v of rows) {
      let cas = openVisitStatus(
        knex('scheduled_services').where({ id: v.id, service_type: BOND_LABEL }).whereNull('service_id'),
      ).whereRaw(
        'EXISTS (SELECT 1 FROM services WHERE id = ? AND service_key = ? AND is_active = true AND is_archived = false)',
        [bait.id, TARGET_KEY],
      );
      if (hasSnapshotCol) cas = cas.whereNull('service_key_snapshot');
      const patch = { service_type: NEW_LABEL, service_id: bait.id };
      if (hasSnapshotCol) patch.service_key_snapshot = TARGET_KEY;
      const n = await cas.update(patch);
      if (!n) continue;
      let reminderRelabeled = false;
      if (hasReminders) {
        reminderRelabeled = (await knex('appointment_reminders')
          .where({ scheduled_service_id: v.id, service_type: BOND_LABEL })
          .update({ service_type: NEW_LABEL })) > 0;
      }
      if (!doneRelabel.has(v.id)) {
        state.relabeled.push({ id: v.id, service_id: bait.id, reminder: reminderRelabeled });
        doneRelabel.add(v.id);
      }
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  const state = await loadState(knex);
  if (!state) return;
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');
  const hasReminders = await knex.schema.hasTable('appointment_reminders');
  const hasCancelledAt = await knex.schema.hasColumn('scheduled_services', 'cancelled_at');
  const hasCancelReason = await knex.schema.hasColumn('scheduled_services', 'cancellation_reason');

  // Leg A: revive ONLY rows still cancelled with exactly our reason.
  for (const rec of state.cancelled || []) {
    if (!rec || !rec.id) continue;
    let q = knex('scheduled_services').where({ id: rec.id, status: 'cancelled', service_type: DUP_LABEL });
    if (hasCancelReason) q = q.where({ cancellation_reason: CANCEL_REASON });
    const patch = { status: 'pending', updated_at: knex.fn.now() };
    if (hasCancelledAt) patch.cancelled_at = null;
    if (hasCancelReason) patch.cancellation_reason = null;
    const n = await q.update(patch);
    if (n && rec.reminder && hasReminders) {
      await knex('appointment_reminders')
        .where({ scheduled_service_id: rec.id, cancelled: true })
        .update({ cancelled: false, updated_at: knex.fn.now() });
    }
  }

  // Leg B: only while still open and still carrying exactly what we set.
  for (const rec of state.relabeled || []) {
    if (!rec || !rec.id || !rec.service_id) continue;
    let q = openVisitStatus(
      knex('scheduled_services').where({ id: rec.id, service_type: NEW_LABEL, service_id: rec.service_id }),
    );
    if (hasSnapshotCol) q = q.where({ service_key_snapshot: TARGET_KEY });
    const patch = { service_type: BOND_LABEL, service_id: null };
    if (hasSnapshotCol) patch.service_key_snapshot = null;
    const n = await q.update(patch);
    if (n && rec.reminder && hasReminders) {
      await knex('appointment_reminders')
        .where({ scheduled_service_id: rec.id, service_type: NEW_LABEL })
        .update({ service_type: BOND_LABEL });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.STATE_KEY = STATE_KEY;
exports.DUP_LABEL = DUP_LABEL;
exports.BOND_LABEL = BOND_LABEL;
exports.NEW_LABEL = NEW_LABEL;
exports.CANCEL_REASON = CANCEL_REASON;
