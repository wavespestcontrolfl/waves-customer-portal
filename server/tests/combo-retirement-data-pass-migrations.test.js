/**
 * Flip-time data pass for GATE_SEPARATE_COMBO_VISITS:
 *   20260831000070 — archive the two two-program catalog rows + deactivate
 *                    their completion profiles (marker-recorded rollback)
 *   20260831000071 — relabel the two "Quarterly Pest + Termite Control
 *                    Service" visits to Termite Bait Station (CAS both ways,
 *                    reminder relabel, ledger-preserving re-runs)
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const archive = require('../models/migrations/20260831000070_retire_two_program_combined_services');
const relabel = require('../models/migrations/20260831000071_relabel_pest_termite_control_visits_to_bait');

const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];

function fakeKnex(db, { missingTables = [], missingColumns = [] } = {}) {
  const knex = (table) => {
    const preds = [];
    const rows = () => db[table] || [];
    const q = {
      where(a) {
        if (typeof a === 'function') {
          const g = { nulls: [], orNotIns: [] };
          const b = { whereNull(c) { g.nulls.push(c); return b; }, orWhereNotIn(c, v) { g.orNotIns.push({ c, v }); return b; } };
          a(b);
          preds.push((r) => g.nulls.some((c) => r[c] == null) || g.orNotIns.some((x) => !x.v.includes(r[x.c])));
          return q;
        }
        preds.push((r) => Object.entries(a).every(([k, v]) => (r[k] ?? null) === v));
        return q;
      },
      whereNull(col) { preds.push((r) => r[col] == null); return q; },
      whereRaw(sql, bindings) {
        if (!/^EXISTS \(SELECT 1 FROM services WHERE id = \? AND service_key = \? AND is_active = true AND is_archived = false\)$/.test(sql)) throw new Error(`fake whereRaw: ${sql}`);
        const [id, key] = bindings;
        preds.push(() => (db.services || []).some((s) => s.id === id && s.service_key === key && s.is_active === true && s.is_archived === false));
        return q;
      },
      async select(...cols) { return rows().filter((r) => preds.every((p) => p(r))).map((r) => { const o = {}; (cols.length ? cols : Object.keys(r)).forEach((c) => { o[c] = r[c] ?? null; }); return o; }); },
      async first(...cols) { const h = rows().find((r) => preds.every((p) => p(r))); if (!h) return undefined; const o = {}; (cols.length ? cols : Object.keys(h)).forEach((c) => { o[c] = h[c] ?? null; }); return o; },
      async update(patch) { const hits = rows().filter((r) => preds.every((p) => p(r))); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      async insert(row) { db[table] = db[table] || []; db[table].push({ ...row }); return [1]; },
      async del() { const keep = rows().filter((r) => !preds.every((p) => p(r))); const n = rows().length - keep.length; db[table] = keep; return n; },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => !missingTables.includes(t), hasColumn: async (t, c) => !missingColumns.includes(`${t}.${c}`) };
  knex.fn = { now: () => 'now' };
  return knex;
}

describe('20260831000070 retire two-program combined catalog rows', () => {
  const seed = () => ({
    services: [
      { service_key: 'pest_termite_bait_quarterly', is_active: true, is_archived: false, customer_visible: true, booking_enabled: true, groupable: true, internal_notes: '[combined_cutover_action=inserted]' },
      { service_key: 'lawn_tree_shrub_combo', is_active: true, is_archived: false, customer_visible: true, booking_enabled: true, groupable: true, internal_notes: '[combined_cutover_action=inserted]' },
      { service_key: 'termite_bait', is_active: true, is_archived: false, customer_visible: true, booking_enabled: true, groupable: true, internal_notes: null },
    ],
    service_completion_profiles: [
      { service_key: 'pest_termite_bait_quarterly', active: true, notes: '[combined_cutover_action=inserted]' },
      { service_key: 'lawn_tree_shrub_combo', active: true, notes: null },
    ],
  });
  const svc = (db, k) => db.services.find((r) => r.service_key === k);
  const prof = (db, k) => db.service_completion_profiles.find((r) => r.service_key === k);

  test('up() archives both rows (prior flags recorded beside the existing marker), deactivates profiles, leaves others', async () => {
    const db = seed();
    await archive.up(fakeKnex(db));
    expect(svc(db, 'pest_termite_bait_quarterly')).toMatchObject({ is_active: false, is_archived: true, customer_visible: false, booking_enabled: false, groupable: false });
    expect(svc(db, 'pest_termite_bait_quarterly').internal_notes).toBe('[combined_cutover_action=inserted] [two_program_retire=a-vbg]');
    expect(prof(db, 'lawn_tree_shrub_combo').active).toBe(false);
    expect(svc(db, 'termite_bait')).toMatchObject({ is_active: true, groupable: true });
  });

  test('idempotent up(); down() restores exactly the recorded flags and strips only our marker', async () => {
    const db = seed();
    await archive.up(fakeKnex(db));
    await archive.up(fakeKnex(db));
    expect(svc(db, 'lawn_tree_shrub_combo').internal_notes).toBe('[combined_cutover_action=inserted] [two_program_retire=a-vbg]');
    await archive.down(fakeKnex(db));
    expect(svc(db, 'lawn_tree_shrub_combo')).toMatchObject({ is_active: true, is_archived: false, customer_visible: true, booking_enabled: true, groupable: true, internal_notes: '[combined_cutover_action=inserted]' });
    expect(prof(db, 'pest_termite_bait_quarterly')).toMatchObject({ active: true, notes: '[combined_cutover_action=inserted]' });
  });

  test('down() leaves a row whose marker an admin removed; missing columns tolerated', async () => {
    const db = seed();
    await archive.up(fakeKnex(db));
    svc(db, 'lawn_tree_shrub_combo').internal_notes = 'admin note';
    await archive.down(fakeKnex(db));
    expect(svc(db, 'lawn_tree_shrub_combo').is_active).toBe(false);
    const db2 = seed();
    db2.services.forEach((r) => { delete r.groupable; delete r.booking_enabled; });
    const k = fakeKnex(db2, { missingColumns: ['services.groupable', 'services.booking_enabled'] });
    await archive.up(k); await archive.down(k);
    expect(svc(db2, 'pest_termite_bait_quarterly').is_active).toBe(true);
  });
});

describe('20260831000071 relabel pest+termite-control visits to termite bait', () => {
  const seed = () => ({
    services: [{ id: 'svc-tb', service_key: 'termite_bait', is_active: true, is_archived: false }],
    scheduled_services: [
      { id: 'v1', service_type: relabel.OLD_LABEL, service_id: null, service_key_snapshot: null, status: 'pending' },
      { id: 'v2', service_type: relabel.OLD_LABEL, service_id: null, service_key_snapshot: null, status: null },
      { id: 'v-done', service_type: relabel.OLD_LABEL, service_id: null, service_key_snapshot: null, status: 'cancelled' },
      { id: 'v-snap', service_type: relabel.OLD_LABEL, service_id: null, service_key_snapshot: 'pest_general_quarterly', status: 'pending' },
      { id: 'v-other', service_type: 'Quarterly Pest + Termite Bait Station Service', service_id: 'svc-x', service_key_snapshot: null, status: 'pending' },
    ],
    appointment_reminders: [
      { scheduled_service_id: 'v1', service_type: relabel.OLD_LABEL },
      { scheduled_service_id: 'v2', service_type: 'Something the office edited' },
    ],
    system_settings: [],
  });
  const row = (db, id) => db.scheduled_services.find((r) => r.id === id);
  const state = (db) => JSON.parse(db.system_settings.find((r) => r.key === relabel.STATE_KEY).value);

  test('relabels + links + stamps the open unlinked rows, relabels their reminders, touches nothing else', async () => {
    const db = seed();
    await relabel.up(fakeKnex(db));
    for (const id of ['v1', 'v2']) {
      expect(row(db, id)).toMatchObject({ service_type: relabel.NEW_LABEL, service_id: 'svc-tb', service_key_snapshot: 'termite_bait' });
    }
    expect(row(db, 'v-done').service_type).toBe(relabel.OLD_LABEL); // history
    expect(row(db, 'v-snap').service_id).toBeNull(); // a snapshot is identity evidence — not ours
    expect(row(db, 'v-other').service_type).toBe('Quarterly Pest + Termite Bait Station Service');
    expect(db.appointment_reminders.find((r) => r.scheduled_service_id === 'v1').service_type).toBe(relabel.NEW_LABEL);
    expect(db.appointment_reminders.find((r) => r.scheduled_service_id === 'v2').service_type).toBe('Something the office edited');
    expect(state(db)).toEqual({ relabeled: [{ id: 'v1', service_id: 'svc-tb', reminder: true }, { id: 'v2', service_id: 'svc-tb', reminder: false }], missing_catalog: false });
  });

  test('missing catalog row → nothing relabeled, flagged in state', async () => {
    const db = seed();
    db.services[0].is_archived = true;
    await relabel.up(fakeKnex(db));
    expect(row(db, 'v1').service_type).toBe(relabel.OLD_LABEL);
    expect(state(db)).toEqual({ relabeled: [], missing_catalog: true });
  });

  test('a re-run keeps the ledger; down() restores only rows still carrying exactly what we set', async () => {
    const db = seed();
    await relabel.up(fakeKnex(db));
    await relabel.up(fakeKnex(db));
    expect(state(db).relabeled).toHaveLength(2);
    row(db, 'v2').status = 'completed'; // became history under the relabel
    await relabel.down(fakeKnex(db));
    expect(row(db, 'v1')).toMatchObject({ service_type: relabel.OLD_LABEL, service_id: null, service_key_snapshot: null });
    expect(db.appointment_reminders.find((r) => r.scheduled_service_id === 'v1').service_type).toBe(relabel.OLD_LABEL);
    expect(row(db, 'v2').service_type).toBe(relabel.NEW_LABEL); // history kept
    expect(db.system_settings.find((r) => r.key === relabel.STATE_KEY)).toBeUndefined();
  });

  test('no snapshot column / no reminders table → still links; safe no-ops on missing tables', async () => {
    const db = seed();
    db.scheduled_services.forEach((r) => { delete r.service_key_snapshot; });
    await relabel.up(fakeKnex(db, { missingColumns: ['scheduled_services.service_key_snapshot'], missingTables: ['appointment_reminders'] }));
    expect(row(db, 'v1').service_id).toBe('svc-tb');
    expect(row(db, 'v1').service_key_snapshot).toBeUndefined();
    await relabel.down(fakeKnex(db, { missingTables: ['scheduled_services'] }));
  });
});
