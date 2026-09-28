// 20260928105000 — a rollback of the termite perk catalog change appends
// compensating audit events, so the forward events 20260928150000/160000
// wrote are not left as the latest word on the restored rows (Codex r13 P2
// on #5161).

const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20260928105000_member_termite_perk_rollback_audit');
const perk = require('../models/migrations/20260928110000_member_termite_inspection_perk');

function fakeKnex({ hasAuditLog = true, rows = {} } = {}) {
  const inserted = [];
  const knex = (table) => ({
    where: (cond) => ({
      first: async () => (table === 'discounts' ? rows[cond.discount_key] : rows.service),
    }),
    insert: async (events) => { expect(table).toBe('audit_log'); inserted.push(...events); },
  });
  knex.schema = { hasTable: async (name) => name === 'audit_log' && hasAuditLog };
  return { knex, inserted };
}

const RESTORED_ROWS = {
  waveguard_member_wdo: { id: 11, ...migration.DISCOUNT_RESTORED.waveguard_member_wdo },
  free_termite_inspection: { id: 12, ...migration.DISCOUNT_RESTORED.free_termite_inspection },
  service: { id: 'svc-ti', is_active: false, base_price: null },
};
const FORWARD_ROWS = {
  waveguard_member_wdo: { id: 11, ...migration.DISCOUNT_FORWARD.waveguard_member_wdo },
  free_termite_inspection: { id: 12, ...migration.DISCOUNT_FORWARD.free_termite_inspection },
  service: { id: 'svc-ti', is_active: false, base_price: '0.00' },
};

test('sorts before 20260928110000, so a batch rollback runs its down() after the restore commits', () => {
  const files = fs.readdirSync(path.join(__dirname, '../models/migrations')).sort();
  expect(files.indexOf('20260928105000_member_termite_perk_rollback_audit.js'))
    .toBeLessThan(files.indexOf('20260928110000_member_termite_inspection_perk.js'));
});

function recordingKnex(writes) {
  return (table) => ({
    where: (cond) => ({
      update: async (values) => {
        const { updated_at: _updatedAt, ...rest } = values;
        writes[table === 'discounts' ? cond.discount_key : 'service'] = rest;
      },
    }),
  });
}

test('the forward values it records as "before" are what 20260928110000 up() wrote (then 140000 switched the service off)', async () => {
  const writes = {};
  await perk.up(recordingKnex(writes));
  expect(writes.waveguard_member_wdo).toEqual(migration.DISCOUNT_FORWARD.waveguard_member_wdo);
  expect(writes.free_termite_inspection).toEqual(migration.DISCOUNT_FORWARD.free_termite_inspection);
  expect({ ...writes.service, is_active: false }).toEqual(migration.SERVICE_FORWARD);
});

test('the restored values it checks for are exactly what 20260928110000 down() writes', async () => {
  const writes = {};
  await perk.down(recordingKnex(writes));
  expect(writes.waveguard_member_wdo).toEqual(migration.DISCOUNT_RESTORED.waveguard_member_wdo);
  expect(writes.free_termite_inspection).toEqual(migration.DISCOUNT_RESTORED.free_termite_inspection);
  expect(writes.service).toEqual(migration.SERVICE_RESTORED);
});

test('after the restore, down() appends one rollback event per restored row', async () => {
  const { knex, inserted } = fakeKnex({ rows: RESTORED_ROWS });
  await migration.down(knex);
  expect(inserted).toHaveLength(3);
  const meta = inserted.map((e) => JSON.parse(e.metadata));
  expect(inserted[0]).toMatchObject({ actor_type: 'system', action: 'discount_catalog.update', resource_type: 'discount', resource_id: '11' });
  expect(meta[0]).toMatchObject({
    migration: '20260928110000_member_termite_inspection_perk',
    direction: 'down',
    changed_fields: ['name', 'description', 'service_key_filter'],
    before: { service_key_filter: 'termite_inspection' },
    after: { service_key_filter: 'wdo_inspection' },
  });
  expect(inserted[1]).toMatchObject({ resource_id: '12' });
  expect(inserted[2]).toMatchObject({ action: 'service_catalog.update', resource_type: 'service', resource_id: 'svc-ti' });
  expect(meta[2]).toMatchObject({
    changed_fields: ['base_price'],
    before: { is_active: false, base_price: 0 },
    after: { is_active: false, base_price: null },
  });
});

test('records nothing for rows that do not carry the restored values (restore not run)', async () => {
  const { knex, inserted } = fakeKnex({ rows: FORWARD_ROWS });
  await migration.down(knex);
  expect(inserted).toHaveLength(0);
});

test('up() changes nothing; down() writes nothing without an audit table or rows', async () => {
  const none = fakeKnex({ rows: RESTORED_ROWS, hasAuditLog: false });
  await migration.up(none.knex);
  await migration.down(none.knex);
  expect(none.inserted).toHaveLength(0);
  const empty = fakeKnex({ rows: {} });
  await migration.down(empty.knex);
  expect(empty.inserted).toHaveLength(0);
});
