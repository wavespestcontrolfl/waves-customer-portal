/**
 * Data pass (GATE_SEPARATE_COMBO_VISITS flip, 2026-08-31): the two live
 * "Quarterly Pest + Termite Control Service" visits become plain
 * Termite Bait Station Service visits.
 *
 * Prod read 2026-08-31: exactly two OPEN visits carry that combined label
 * (one customer, one series parent), both unlinked (service_id NULL, no
 * snapshot). Their evidence is unambiguous: the customer already holds a
 * separate quarterly pest series for the same window, the series' linked
 * siblings are termite_bait, and the label was never a catalog name (a
 * converter-only combined label from the retired pest+bait route). Under
 * the retired route the bait leg IS its own visit — so relabel + link +
 * stamp the snapshot, the same triple the edit path writes.
 *
 * Population: OPEN (NULL status is open; terminal rows keep their history)
 * visits with exactly that label, service_id NULL and service_key_snapshot
 * NULL. Per-row CAS re-asserts all of that AND that the target catalog row
 * still carries service_key termite_bait, active and unarchived. The
 * appointment_reminders row (if any) is relabeled too — the reminder text
 * reads its own service_type — guarded by the old label. State row records
 * each write so down() restores label/identity/reminder only where the row
 * still carries exactly what this migration set.
 *
 * NOT touched here: the two "Quarterly Pest + Termite Bait Station Service"
 * duplicates and the two "…Termite Bait Station + Termite Bond Service"
 * visits — owner-decided (cancel path; bond term) in their own migration.
 */

const STATE_KEY = 'migration.20260831000071.state';
const OLD_LABEL = 'Quarterly Pest + Termite Control Service';
const NEW_LABEL = 'Termite Bait Station Service';
const TARGET_KEY = 'termite_bait';
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

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

  const prior = await loadState(knex);
  const state = { relabeled: Array.isArray(prior?.relabeled) ? prior.relabeled : [], missing_catalog: false };
  const done = new Set(state.relabeled.map((r) => r.id));

  const svc = await knex('services')
    .where({ service_key: TARGET_KEY, is_active: true, is_archived: false })
    .first('id', 'service_key');
  if (!svc) {
    state.missing_catalog = true;
  } else {
    let q = openVisitStatus(knex('scheduled_services').where({ service_type: OLD_LABEL }).whereNull('service_id'));
    if (hasSnapshotCol) q = q.whereNull('service_key_snapshot');
    const visits = await q.select('id');
    for (const v of visits) {
      let cas = openVisitStatus(
        knex('scheduled_services').where({ id: v.id, service_type: OLD_LABEL }).whereNull('service_id'),
      ).whereRaw(
        'EXISTS (SELECT 1 FROM services WHERE id = ? AND service_key = ? AND is_active = true AND is_archived = false)',
        [svc.id, TARGET_KEY],
      );
      if (hasSnapshotCol) cas = cas.whereNull('service_key_snapshot');
      const patch = { service_type: NEW_LABEL, service_id: svc.id };
      if (hasSnapshotCol) patch.service_key_snapshot = TARGET_KEY;
      const n = await cas.update(patch);
      if (!n) continue;
      let reminderRelabeled = false;
      if (hasReminders) {
        reminderRelabeled = (await knex('appointment_reminders')
          .where({ scheduled_service_id: v.id, service_type: OLD_LABEL })
          .update({ service_type: NEW_LABEL })) > 0;
      }
      if (!done.has(v.id)) {
        state.relabeled.push({ id: v.id, service_id: svc.id, reminder: reminderRelabeled });
        done.add(v.id);
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
  for (const rec of state.relabeled || []) {
    if (!rec || !rec.id || !rec.service_id) continue;
    // Only while still open and still carrying exactly what we set.
    let q = openVisitStatus(
      knex('scheduled_services').where({ id: rec.id, service_type: NEW_LABEL, service_id: rec.service_id }),
    );
    if (hasSnapshotCol) q = q.where({ service_key_snapshot: TARGET_KEY });
    const patch = { service_type: OLD_LABEL, service_id: null };
    if (hasSnapshotCol) patch.service_key_snapshot = null;
    const n = await q.update(patch);
    if (n && rec.reminder && hasReminders) {
      await knex('appointment_reminders')
        .where({ scheduled_service_id: rec.id, service_type: NEW_LABEL })
        .update({ service_type: OLD_LABEL });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.STATE_KEY = STATE_KEY;
exports.OLD_LABEL = OLD_LABEL;
exports.NEW_LABEL = NEW_LABEL;
