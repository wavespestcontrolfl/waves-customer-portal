/**
 * purchase-receipts/receipt-equipment-link.js — the equipment bell's body
 * and link (one matching open tool alert → that row; otherwise a new-row
 * dialog with the name filled in; gate off → null so the agent keeps its
 * plain bell) and the receipt line claim the Assets save runs under lock.
 */
jest.mock('../services/truck-kit', () => ({
  truckKitEnabled: jest.fn(() => true),
  matchReceiptToOpenAlert: jest.fn(async () => null),
}));
const truckKit = require('../services/truck-kit');
const link = require('../services/purchase-receipts/receipt-equipment-link');

const LINE = '44444444-2222-4333-8444-555555555555';
const TOOL = '33333333-2222-4333-8444-555555555555';

beforeEach(() => { jest.clearAllMocks(); truckKit.truckKitEnabled.mockReturnValue(true); truckKit.matchReceiptToOpenAlert.mockResolvedValue(null); });

describe('equipmentBellFor', () => {
  test('gate off: null (the agent keeps its plain bell)', async () => {
    truckKit.truckKitEnabled.mockReturnValue(false);
    expect(await link.equipmentBellFor({}, { lineId: LINE, line: { raw_title: 'Moisture Meter' } })).toBeNull();
    expect(truckKit.matchReceiptToOpenAlert).not.toHaveBeenCalled();
  });

  test('a matching open alert: names the tool and links to its row with the line id', async () => {
    truckKit.matchReceiptToOpenAlert.mockResolvedValue({ equipment_id: TOOL, name: 'Moisture meter', alert_type: 'tool_missing', vehicle_name: 'Truck 2' });
    const bell = await link.equipmentBellFor({}, { lineId: LINE, line: { raw_title: 'Extech MO55 Moisture Meter' } });
    expect(bell.body).toBe('"Extech MO55 Moisture Meter" looks like equipment, not stock. Moisture meter is reported missing on Truck 2: open its row to record the replacement.');
    expect(bell.link).toBe(`/admin/equipment?tab=assets&edit=${TOOL}&receipt_line=${LINE}`);
    expect(bell.equipmentId).toBe(TOOL);
  });

  test('a damaged tool with no truck reads "damaged" and no place', async () => {
    truckKit.matchReceiptToOpenAlert.mockResolvedValue({ equipment_id: TOOL, name: 'Duster', alert_type: 'tool_damaged', vehicle_name: null });
    const bell = await link.equipmentBellFor({}, { lineId: LINE, line: { raw_title: 'Hand duster' } });
    expect(bell.body).toMatch(/Duster is reported damaged: open its row/);
  });

  test('no match: the plain wording, linked to a new-row dialog with the name filled in (capped)', async () => {
    const long = 'Stihl BR 800 X Magnum Backpack Blower with extra long title '.repeat(4).trim();
    const bell = await link.equipmentBellFor({}, { lineId: LINE, line: { raw_title: long } });
    expect(bell.body).toBe(`"${long}" wasn't added: looks like equipment, not stock — add it to the equipment list if you're keeping it.`);
    expect(bell.link.startsWith(`/admin/equipment?tab=assets&new=1&name=${encodeURIComponent(long.slice(0, 120))}&receipt_line=${LINE}`)).toBe(true);
    expect(bell.equipmentId).toBeNull();
  });
});

describe('claimReceiptLine / linkReceiptLine', () => {
  function trx(row) {
    const calls = [];
    const chain = {
      where: jest.fn((cond) => { calls.push(['where', cond]); return chain; }),
      forUpdate: jest.fn(() => { calls.push(['forUpdate']); return chain; }),
      first: jest.fn(async (...cols) => { calls.push(['first', cols]); return row ? { ...row } : null; }),
      update: jest.fn(async (patch) => { calls.push(['update', patch]); return 1; }),
    };
    const t = jest.fn(() => chain);
    t.calls = calls;
    return t;
  }

  test('a bad id never reads', async () => {
    const t = trx(null);
    expect(await link.claimReceiptLine(t, 'nope')).toBe('not-found');
    expect(t).not.toHaveBeenCalled();
  });

  test('locks the line; a missing or non-equipment line is not-found', async () => {
    const t = trx(null);
    expect(await link.claimReceiptLine(t, LINE)).toBe('not-found');
    expect(t.calls.map(([m]) => m)).toEqual(['where', 'forUpdate', 'first']);
    expect(await link.claimReceiptLine(trx({ id: LINE, status: 'logged', equipment_id: null }), LINE)).toBe('not-found');
  });

  test('an unfiled equipment line, or the same row again, is claimable; another row is already-linked', async () => {
    expect(await link.claimReceiptLine(trx({ id: LINE, status: 'agent_equipment', equipment_id: null }), LINE, TOOL)).toBeNull();
    expect(await link.claimReceiptLine(trx({ id: LINE, status: 'agent_equipment', equipment_id: TOOL }), LINE, TOOL)).toBeNull();
    expect(await link.claimReceiptLine(trx({ id: LINE, status: 'agent_equipment', equipment_id: 'other' }), LINE, TOOL)).toBe('already-linked');
    // A create has no row yet: a line already filed under any row is refused.
    expect(await link.claimReceiptLine(trx({ id: LINE, status: 'agent_equipment', equipment_id: 'other' }), LINE)).toBe('already-linked');
  });

  test('linkReceiptLine writes equipment_id on the line', async () => {
    const t = trx({ id: LINE });
    await link.linkReceiptLine(t, LINE, TOOL);
    expect(t.calls).toEqual([['where', { id: LINE }], ['update', { equipment_id: TOOL }]]);
  });
});
