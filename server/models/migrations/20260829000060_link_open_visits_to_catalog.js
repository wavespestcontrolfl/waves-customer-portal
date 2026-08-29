/**
 * Link OPEN unlinked visits to their catalog row by exact name (owner GO
 * 2026-08-29, follow-up to the label backfills 20260829000010/000040).
 *
 * After those backfills every open legacy visit carries a CURRENT catalog
 * name but still has service_id NULL. Identity resolution already treats
 * an exact name match as the same identity as a link
 * (service-completion-profiles.js lookupServiceForScheduledService: id →
 * service_key_snapshot → exact name), so linking these rows changes no
 * closeout/report/pricing outcome — it makes the identity DURABLE: a
 * future catalog rename no longer strands them, and series children born
 * from them inherit the link instead of a label.
 *
 * Population: open visits (NULL status is open; terminal rows keep their
 * history untouched — Invariant 1) with service_id NULL whose service_type
 * equals, case-insensitively, the name of exactly ONE active catalog row.
 * An ambiguous name (two active rows) never links (fail closed). Where the
 * row has no service_key_snapshot, the matched row's service_key is stamped
 * too — the same pair the edit path stamps together (admin-schedule.js
 * resolvedServiceId + resolvedServiceKey). A row whose EXISTING snapshot
 * names a different service than its label matches is a conflict —
 * lookupServiceForScheduledService honors the snapshot ahead of the label,
 * and a service_id would outrank both — so it is never linked (listed in
 * the state row for the owner instead).
 *
 * Per-row CAS both ways: the forward write re-checks the visit's label,
 * its NULL linkage and — at write time — that the catalog row still
 * carries that name and is still active (an admin rename in flight makes
 * the write miss). down() unlinks only rows still open, still carrying the
 * same label and exactly the linkage this migration set, from the recorded
 * state row.
 */

const STATE_KEY = 'migration.20260829000060.state';
const TERMINAL_VISIT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

function openVisitStatus(q) {
  return q.where((b) => b.whereNull('status').orWhereNotIn('status', TERMINAL_VISIT_STATUSES));
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');

  // Exactly-one-active-row names only.
  const active = await knex('services').where({ is_active: true }).select('id', 'name', 'service_key');
  const byLower = new Map();
  for (const s of active) {
    if (typeof s.name !== 'string' || !s.name.trim()) continue;
    const key = s.name.trim().toLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key).push(s);
  }

  const cols = ['id', 'service_type', ...(hasSnapshotCol ? ['service_key_snapshot'] : [])];
  const visits = await openVisitStatus(knex('scheduled_services').whereNull('service_id')).select(...cols);

  const state = { linked: [], ambiguous: [], conflicts: [] };
  for (const v of visits) {
    const label = typeof v.service_type === 'string' ? v.service_type.trim().toLowerCase() : '';
    if (!label) continue;
    const matches = byLower.get(label) || [];
    if (matches.length !== 1) {
      if (matches.length > 1) state.ambiguous.push({ id: v.id, service_type: v.service_type });
      continue;
    }
    const svc = matches[0];
    // An existing service_key_snapshot is DURABLE identity evidence that
    // lookupServiceForScheduledService honors ahead of the label — and a
    // service_id would outrank it. A snapshot naming a different service
    // than the label matches is a conflict: never re-point the row's
    // effective identity by linking it; list it for the owner (codex P0).
    const snapshot = hasSnapshotCol && v.service_key_snapshot != null ? String(v.service_key_snapshot).trim() : '';
    if (snapshot && snapshot !== String(svc.service_key || '').trim()) {
      state.conflicts.push({ id: v.id, service_type: v.service_type, service_key_snapshot: v.service_key_snapshot, matched_service_key: svc.service_key || null });
      continue;
    }
    const stampSnapshot = hasSnapshotCol && !snapshot && !!svc.service_key;
    let q = openVisitStatus(
      knex('scheduled_services')
        .where({ id: v.id, service_type: v.service_type })
        .whereNull('service_id')
    ).whereRaw('EXISTS (SELECT 1 FROM services WHERE id = ? AND lower(name) = lower(?) AND is_active = true)', [svc.id, v.service_type]);
    // The snapshot is part of the identity the CAS checks either way: still
    // NULL when this write stamps it, still the matching key when it agreed.
    if (hasSnapshotCol) q = stampSnapshot ? q.whereNull('service_key_snapshot') : q.where({ service_key_snapshot: v.service_key_snapshot });
    const patch = { service_id: svc.id };
    if (stampSnapshot) patch.service_key_snapshot = svc.service_key;
    const count = await q.update(patch);
    if (count) {
      state.linked.push({
        id: v.id,
        service_type: v.service_type,
        service_id: svc.id,
        service_key_snapshot: stampSnapshot ? svc.service_key : null,
      });
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
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  let state;
  try {
    state = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch {
    return; // unreadable state — leave data as-is rather than guess
  }
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');

  for (const rec of Array.isArray(state.linked) ? state.linked : []) {
    if (!rec || !rec.id || !rec.service_id || typeof rec.service_type !== 'string') continue;
    // Only while still open (a visit completed under the link is history),
    // still carrying the same label, and exactly the linkage this set.
    let q = openVisitStatus(
      knex('scheduled_services').where({ id: rec.id, service_type: rec.service_type, service_id: rec.service_id })
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
