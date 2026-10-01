// 20260928190000 — the WaveGuard member perk is a free annual termite
// inspection, never a WDO (owner 2026-09-28). Re-scopes both member discounts
// to termite_inspection, un-archives the Termite Inspection Service at $0 but
// keeps it inactive, and audits every change — the rollback included — in
// the same transaction as the write.

const mockRecordAuditEvent = jest.fn(async () => 'audit-1');
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockRecordAuditEvent(...a) }));
const migration = require('../models/migrations/20260928190000_member_termite_perk');

const { DISCOUNTS, SERVICE_PERK, SERVICE_PRIOR } = migration;

function fakeKnex(rows, { hasArchived = true, hasAuditLog = true } = {}) {
  const updates = [];
  const knex = (table) => ({
    where: (cond) => ({
      forUpdate: () => ({
        first: async () => (table === 'discounts' ? rows[cond.discount_key] : rows.service),
      }),
      update: async (values) => {
        const { updated_at: _updatedAt, ...rest } = values;
        updates.push({ table, id: cond.id, values: rest });
      },
    }),
  });
  knex.schema = {
    hasColumn: async (table, col) => table === 'services' && col === 'is_archived' && hasArchived,
    hasTable: async (name) => name === 'audit_log' && hasAuditLog,
  };
  return { knex, updates };
}

const rowsAt = (key, service) => ({
  waveguard_member_wdo: { id: 11, ...DISCOUNTS.waveguard_member_wdo[key] },
  free_termite_inspection: { id: 12, ...DISCOUNTS.free_termite_inspection[key] },
  service: { id: 'svc-ti', ...service },
});

beforeEach(() => mockRecordAuditEvent.mockClear());

test('up() re-scopes both member discounts to termite_inspection and un-archives the service at $0, still inactive', async () => {
  const { knex, updates } = fakeKnex(rowsAt('prior', SERVICE_PRIOR));
  await migration.up(knex);
  expect(updates).toEqual([
    { table: 'discounts', id: 11, values: DISCOUNTS.waveguard_member_wdo.perk },
    { table: 'discounts', id: 12, values: DISCOUNTS.free_termite_inspection.perk },
    { table: 'services', id: 'svc-ti', values: { is_active: false, is_archived: false, base_price: 0 } },
  ]);
  expect(DISCOUNTS.waveguard_member_wdo.perk.service_key_filter).toBe('termite_inspection');
  expect(DISCOUNTS.free_termite_inspection.perk.service_key_filter).toBe('termite_inspection');
});

test('up() writes one critical audit event per changed row, on the migration connection, with live before values', async () => {
  const { knex } = fakeKnex(rowsAt('prior', { ...SERVICE_PRIOR, base_price: null }));
  await migration.up(knex);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(3);
  const [discount, , service] = mockRecordAuditEvent.mock.calls.map((c) => c[0]);
  expect(discount).toMatchObject({
    actor_type: 'system:migration',
    action: 'discount_catalog.update',
    resource_type: 'discount',
    resource_id: '11',
    critical: true,
    trx: knex,
    metadata: {
      migration: '20260928190000_member_termite_perk',
      direction: 'up',
      changed_fields: ['name', 'description', 'service_key_filter'],
      before: { service_key_filter: 'wdo_inspection' },
      after: { service_key_filter: 'termite_inspection' },
    },
  });
  expect(service).toMatchObject({
    action: 'service_catalog.update',
    resource_type: 'service',
    resource_id: 'svc-ti',
    metadata: {
      changed_fields: ['is_archived', 'base_price'],
      before: { is_active: false, is_archived: true, base_price: null },
      after: { is_active: false, is_archived: false, base_price: 0 },
    },
  });
});

test('down() restores rows still at the perk values and appends a rollback event for each', async () => {
  const { knex, updates } = fakeKnex(rowsAt('perk', { ...SERVICE_PERK, base_price: '0.00' }));
  await migration.down(knex);
  expect(updates).toEqual([
    { table: 'discounts', id: 11, values: DISCOUNTS.waveguard_member_wdo.prior },
    { table: 'discounts', id: 12, values: DISCOUNTS.free_termite_inspection.prior },
    { table: 'services', id: 'svc-ti', values: SERVICE_PRIOR },
  ]);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(3);
  for (const [event] of mockRecordAuditEvent.mock.calls) {
    expect(event).toMatchObject({ critical: true, trx: knex, metadata: { direction: 'down' } });
  }
  expect(mockRecordAuditEvent.mock.calls[0][0].metadata).toMatchObject({
    before: { service_key_filter: 'termite_inspection' },
    after: { service_key_filter: 'wdo_inspection' },
  });
});

test('down() leaves a row staff changed since the migration alone, unaudited', async () => {
  const rows = rowsAt('perk', { ...SERVICE_PERK, is_active: true, base_price: 95 });
  rows.waveguard_member_wdo.description = 'Edited by staff.';
  const { knex, updates } = fakeKnex(rows);
  await migration.down(knex);
  expect(updates).toEqual([{ table: 'discounts', id: 12, values: DISCOUNTS.free_termite_inspection.prior }]);
  expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
});

test('re-running up() on rows already at the perk values writes nothing', async () => {
  const { knex, updates } = fakeKnex(rowsAt('perk', { ...SERVICE_PERK, base_price: '0.00' }));
  await migration.up(knex);
  expect(updates).toHaveLength(0);
  expect(mockRecordAuditEvent).not.toHaveBeenCalled();
});

test('without an is_archived column the service moves on is_active and base_price only', async () => {
  const { knex, updates } = fakeKnex(rowsAt('prior', { is_active: false, base_price: null }), { hasArchived: false });
  await migration.up(knex);
  expect(updates[2]).toEqual({ table: 'services', id: 'svc-ti', values: { is_active: false, base_price: 0 } });
});

test('a failed audit write aborts the migration', async () => {
  mockRecordAuditEvent.mockRejectedValueOnce(new Error('audit down'));
  const { knex } = fakeKnex(rowsAt('prior', SERVICE_PRIOR));
  await expect(migration.up(knex)).rejects.toThrow('audit down');
});
