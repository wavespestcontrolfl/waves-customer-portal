/**
 * inventory-agent.js equipmentBell (scope PR 3): the receipt-link read for
 * an agent_equipment line runs inside its own savepoint on the settlement
 * transaction, so a failed SQL read (a column missing before a migration, a
 * bad row) is rolled back to the savepoint and the plain bell still writes
 * on a live transaction; a good read releases the savepoint and returns the
 * bell body and link.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/purchase-receipts/receipt-equipment-link', () => ({ equipmentBellFor: jest.fn() }));
const link = require('../services/purchase-receipts/receipt-equipment-link');
const logger = require('../services/logger');
const { equipmentBell } = require('../services/purchase-receipts/inventory-agent');

function fakeTrx() {
  const raw = [];
  return { isTransaction: true, raw: jest.fn(async (sql) => { raw.push(sql); }), sql: raw };
}
const LINE = '44444444-2222-4333-8444-555555555555';

test('a good read releases its savepoint and returns the bell', async () => {
  const trx = fakeTrx();
  link.equipmentBellFor.mockResolvedValueOnce({ body: 'b', link: '/admin/equipment?tab=assets&new=1' });
  const out = await equipmentBell(trx, { lineId: LINE, line: { raw_title: 'Moisture meter' } });
  expect(out).toEqual({ body: 'b', link: '/admin/equipment?tab=assets&new=1' });
  expect(link.equipmentBellFor).toHaveBeenCalledWith(trx, { lineId: LINE, line: { raw_title: 'Moisture meter' } });
  expect(trx.sql.map((s) => s.split(' ')[0])).toEqual(['SAVEPOINT', 'RELEASE']);
});

test('a failed read rolls back to its savepoint, warns, and answers null (the plain bell)', async () => {
  const trx = fakeTrx();
  link.equipmentBellFor.mockRejectedValueOnce(new Error('column "equipment_id" does not exist'));
  expect(await equipmentBell(trx, { lineId: LINE, line: { raw_title: 'Moisture meter' } })).toBeNull();
  expect(trx.sql.map((s) => s.replace(/ \w+$/, ''))).toEqual(['SAVEPOINT', 'ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT']);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`receipt link read failed for line ${LINE}`));
});
