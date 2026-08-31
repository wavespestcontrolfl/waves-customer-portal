/**
 * Link OPEN unlinked "Quarterly Pest Control" visits to pest_general_quarterly.
 *
 * 20260829000060 linked open visits whose label EXACTLY matches one catalog
 * name. Visit-groups went live with #3624 and grouping only sees visits
 * that carry a service_id; prod read 2026-08-31 still shows 7 unlinked
 * upcoming open visits. Three are plain "Quarterly Pest Control" rows — a
 * label alias the exact-name pass could not match (the catalog name is
 * "Quarterly Pest Control Service") — one customer's manually created
 * quarterly program, the quarterly pest program by any reading. This is
 * that alias, applied with the SAME identity rules as 000060:
 *
 *   - population: OPEN visits (NULL status is open; terminal rows keep
 *     their history — Invariant 1) with service_id NULL and the alias label
 *     (trimmed, case-insensitive), across the whole table;
 *   - an existing service_key_snapshot is DURABLE identity evidence that
 *     lookupServiceForScheduledService honors ahead of the label — and a
 *     service_id would outrank it. A snapshot naming a different key is a
 *     conflict: never re-point the row; list it in the state row instead.
 *     A NULL snapshot is stamped with the target key alongside the link —
 *     the same pair the edit path stamps together;
 *   - per-row CAS both ways: the forward write re-checks label, NULL
 *     linkage, open status, the snapshot half it relied on, AND that the
 *     target catalog row still carries the key and is still active and
 *     unarchived (a concurrent catalog edit makes the write miss). down()
 *     unlinks only rows still open, still carrying the label and exactly
 *     the linkage (and snapshot) this migration set.
 *
 * The other four unlinked rows carry COMBO labels ("Quarterly Termite Bait
 * Station + Termite Bond Service", "Quarterly Pest + Termite Control
 * Service") and are deliberately NOT aliased: the owner's open combo-row
 * ruling (service-name lane, 08-28) decides what a combo visit becomes.
 */

const STATE_KEY = 'migration.20260831000030.state';
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

// Stored label alias → catalog service_key. One entry on purpose (see header).
const LABEL_TO_KEY = {
  'quarterly pest control': 'pest_general_quarterly',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'service_id'))) return;
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');

  // A re-run must never erase the rollback ledger: links from an earlier
  // run stay recorded (keyed by visit id) so down() can still undo them;
  // conflicts/missing_catalog are re-derived from this scan.
  const prior = await loadState(knex);
  const state = { linked: Array.isArray(prior?.linked) ? prior.linked : [], conflicts: [], missing_catalog: [] };
  const alreadyLinked = new Set(state.linked.map((l) => l.id));
  const cols = ['id', 'service_type', ...(hasSnapshotCol ? ['service_key_snapshot'] : [])];
  const visits = await openVisitStatus(knex('scheduled_services').whereNull('service_id')).select(...cols);

  for (const [alias, serviceKey] of Object.entries(LABEL_TO_KEY)) {
    const svc = await knex('services')
      .where({ service_key: serviceKey, is_active: true, is_archived: false })
      .first('id', 'service_key');
    if (!svc) { state.missing_catalog.push(serviceKey); continue; } // leave rows for the admin

    for (const v of visits) {
      const label = typeof v.service_type === 'string' ? v.service_type.trim().toLowerCase() : '';
      if (label !== alias) continue;
      const snapshot = hasSnapshotCol && v.service_key_snapshot != null ? String(v.service_key_snapshot).trim() : '';
      if (snapshot && snapshot !== svc.service_key) {
        state.conflicts.push({ id: v.id, service_type: v.service_type, service_key_snapshot: v.service_key_snapshot, target_service_key: svc.service_key });
        continue;
      }
      const stampSnapshot = hasSnapshotCol && !snapshot;
      let q = openVisitStatus(
        knex('scheduled_services')
          .where({ id: v.id, service_type: v.service_type })
          .whereNull('service_id'),
      ).whereRaw(
        'EXISTS (SELECT 1 FROM services WHERE id = ? AND service_key = ? AND is_active = true AND is_archived = false)',
        [svc.id, svc.service_key],
      );
      if (hasSnapshotCol) q = stampSnapshot ? q.whereNull('service_key_snapshot') : q.where({ service_key_snapshot: v.service_key_snapshot });
      const patch = { service_id: svc.id };
      if (stampSnapshot) patch.service_key_snapshot = svc.service_key;
      const count = await q.update(patch);
      if (count && !alreadyLinked.has(v.id)) {
        state.linked.push({
          id: v.id,
          service_type: v.service_type,
          service_id: svc.id,
          service_key_snapshot: stampSnapshot ? svc.service_key : null,
        });
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
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const state = await loadState(knex);
  if (!state) return; // no ledger (or unreadable) — leave data as-is rather than guess
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');

  for (const rec of Array.isArray(state.linked) ? state.linked : []) {
    if (!rec || !rec.id || !rec.service_id || typeof rec.service_type !== 'string') continue;
    // Only while still open (a visit completed under the link is history),
    // still carrying the same label, and exactly the linkage this set.
    let q = openVisitStatus(
      knex('scheduled_services').where({ id: rec.id, service_type: rec.service_type, service_id: rec.service_id }),
    );
    const patch = { service_id: null };
    if (hasSnapshotCol && rec.service_key_snapshot) {
      q = q.where({ service_key_snapshot: rec.service_key_snapshot });
      patch.service_key_snapshot = null;
    }
    await q.update(patch);
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.STATE_KEY = STATE_KEY;
exports.LABEL_TO_KEY = LABEL_TO_KEY;
