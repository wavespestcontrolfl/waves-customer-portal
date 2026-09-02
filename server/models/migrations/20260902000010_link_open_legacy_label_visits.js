/**
 * Link OPEN unlinked visits to their catalog row through the SHARED label
 * bridge (post-service report audit, 2026-09-02).
 *
 * 20260829000060 linked open visits by EXACT catalog name; 20260831000030
 * added the single "Quarterly Pest Control" alias. Prod still carries open
 * visits with other pre-convention labels ("Pest Control" on a quarterly
 * series, …) that never link, so their completion resolves identity by
 * label inference instead of the catalog. The booking stamping contract
 * (services/booking/create-scheduled-service.js resolveCatalogIdentity)
 * already defines the canonical bridge for exactly this population:
 *
 *   legacyCatalogName(label, recurring_pattern)   — the (label, cadence)
 *     map series generation resolves through ("Pest Control" + quarterly
 *     → "Quarterly Pest Control Service"), decisive BEFORE suffix expansion
 *     so a recurring row never lands on the one-time service;
 *   serviceNameCandidates(cadenceName || label) — the " Service" suffix,
 *     visit-program and cadence-qualifier aliases completion itself uses;
 *   unique LIVE catalog row across every candidate — more than one
 *     distinct match is ambiguity and never links. A name any OTHER row
 *     (inactive or archived) also carries is ambiguous too, exactly as
 *     000060 ruled: the pre-link lookup matches names over ALL rows.
 *
 * This migration applies that same bridge to the open backlog, with the
 * identity rules of 000060/000030 unchanged:
 *   - population: OPEN visits only (NULL status is open; terminal rows keep
 *     their history — Invariant 1) with service_id NULL;
 *   - an existing service_key_snapshot that names a different key is a
 *     conflict — never re-pointed, listed in the state row; a NULL snapshot
 *     is stamped with the target key alongside the link (the pair the edit
 *     path stamps together);
 *   - per-row CAS both ways: the forward write re-checks label, NULL
 *     linkage, open status, the snapshot half it relied on, and that the
 *     target row still carries the key and is still live; down() unlinks
 *     only rows still open, still carrying the label and exactly the
 *     linkage (and snapshot) this migration set.
 *
 * Combined labels ("Quarterly Pest + Termite Control Service") match no
 * candidate and stay for the owner's combo ruling, as before.
 */

const { serviceNameCandidates } = require('../../services/service-completion-profiles');
const { legacyCatalogName } = require('../../config/service-name-aliases');

const STATE_KEY = 'migration.20260902000010.state';
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

function isLive(row) {
  return row.is_active === true && row.is_archived !== true;
}

// The contract's resolution, over a preloaded catalog: cadence map first,
// then the candidate expansion, unique LIVE row, and no candidate name
// shared with any other catalog row (live or not).
function resolveCatalogRow(visit, catalog) {
  const label = typeof visit.service_type === 'string' ? visit.service_type.trim() : '';
  if (!label) return { row: null, reason: 'no_label' };
  const cadenceName = legacyCatalogName(label, visit.recurring_pattern);
  const candidates = serviceNameCandidates(cadenceName || label).map((c) => c.toLowerCase());
  if (!candidates.length) return { row: null, reason: 'no_candidates' };
  const hits = catalog.filter((s) => typeof s.name === 'string' && candidates.includes(s.name.trim().toLowerCase()));
  const distinct = [...new Map(hits.map((h) => [h.id, h])).values()];
  if (distinct.length === 0) return { row: null, reason: 'no_match' };
  if (distinct.length > 1) return { row: null, reason: 'ambiguous' };
  if (!isLive(distinct[0])) return { row: null, reason: 'inactive_only' };
  return { row: distinct[0], reason: null };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'service_id'))) return;
  const hasSnapshotCol = await knex.schema.hasColumn('scheduled_services', 'service_key_snapshot');
  const hasPatternCol = await knex.schema.hasColumn('scheduled_services', 'recurring_pattern');

  // A re-run must never erase the rollback ledger: links from an earlier
  // run stay recorded (keyed by visit id); ambiguous/conflicts are
  // re-derived from this scan.
  const prior = await loadState(knex);
  const state = { linked: Array.isArray(prior?.linked) ? prior.linked : [], ambiguous: [], conflicts: [] };
  const alreadyLinked = new Set(state.linked.map((l) => l.id));

  const catalog = await knex('services').select('id', 'name', 'service_key', 'is_active', 'is_archived');
  const cols = [
    'id', 'service_type',
    ...(hasSnapshotCol ? ['service_key_snapshot'] : []),
    ...(hasPatternCol ? ['recurring_pattern'] : []),
  ];
  const visits = await openVisitStatus(knex('scheduled_services').whereNull('service_id')).select(...cols);

  for (const v of visits) {
    const { row: svc, reason } = resolveCatalogRow(v, catalog);
    if (!svc) {
      if (reason === 'ambiguous') state.ambiguous.push({ id: v.id, service_type: v.service_type });
      continue;
    }
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
      'EXISTS (SELECT 1 FROM services WHERE id = ? AND service_key = ? AND is_active = true AND is_archived IS NOT TRUE)',
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
exports.resolveCatalogRow = resolveCatalogRow;
