// Profile-enrichment writer — gate codes/pets/notes from extraction into
// property_preferences + internal_notes, admin-edit-preserving.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { enrichFromCall, _test } = require('../services/call-profile-enrichment');
const { extractCodes, appendWithProvenance } = _test;

describe('extractCodes (conservative keyword+digits only)', () => {
  test('pulls explicit gate/lockbox/garage codes', () => {
    expect(extractCodes('The front gate code is 4545, use the main entrance')).toMatchObject({ property_gate_code: '4545' });
    expect(extractCodes('lockbox code: 6214 on the door')).toMatchObject({ lockbox_code: '6214' });
    expect(extractCodes('garage is 88991')).toMatchObject({ garage_code: '88991' });
    expect(extractCodes('community entrance code is 1234')).toMatchObject({ neighborhood_gate_code: '1234' });
  });

  test('never invents codes from bare numbers', () => {
    const out = extractCodes('house number 4545 on Main St, call me at 941-555-0100');
    expect(Object.values(out).every((v) => v === null)).toBe(true);
  });
});

describe('appendWithProvenance', () => {
  test('appends with a dated tag and preserves existing text', () => {
    const out = appendWithProvenance('Admin note: side gate sticks', 'dogs in back yard', '2026-07-10T01:00:00Z');
    expect(out).toContain('Admin note: side gate sticks');
    expect(out).toContain('[call 2026-07-10] dogs in back yard');
  });

  test('idempotent on reprocess (same addition not duplicated)', () => {
    const once = appendWithProvenance(null, 'gate code 4545', '2026-07-10');
    const twice = appendWithProvenance(once, 'gate code 4545', '2026-07-11');
    expect(twice).toBe(once);
  });
});

describe('enrichFromCall', () => {
  test('gate off → no writes, no reads', async () => {
    isEnabled.mockReturnValue(false);
    const res = await enrichFromCall({ customerId: 'c1', extraction: { property: { access_notes: 'gate code is 4545' } } });
    expect(res.skipped).toBe('gate_off');
    expect(db).not.toHaveBeenCalled();
  });

  test('fills only empty structured fields; admin values survive', async () => {
    isEnabled.mockReturnValue(true);
    const updates = [];
    db.mockImplementation((table) => {
      const builder = {
        where: () => builder,
        first: async () => (table === 'property_preferences'
          ? { customer_id: 'c1', property_gate_code: '9999', lockbox_code: null, access_notes: null, pet_details: null }
          : { internal_notes: null }),
        update: async (u) => { updates.push({ table, u }); return 1; },
        insert: async () => {},
      };
      return builder;
    });
    await enrichFromCall({
      customerId: 'c1',
      extraction: { property: { access_notes: 'front gate code is 4545 and lockbox 6214' } },
      callCreatedAt: '2026-07-10T01:00:00Z',
    });
    const prefUpdate = updates.find((x) => x.table === 'property_preferences');
    expect(prefUpdate.u.property_gate_code).toBeUndefined(); // admin's 9999 preserved
    expect(prefUpdate.u.lockbox_code).toBe('6214');          // empty field filled
    expect(prefUpdate.u.access_notes).toContain('[call 2026-07-10]');
  });

  test('creates the preferences row when none exists', async () => {
    isEnabled.mockReturnValue(true);
    const inserts = [];
    db.mockImplementation((table) => {
      const builder = {
        where: () => builder,
        first: async () => null,
        insert: async (row) => { inserts.push({ table, row }); },
        update: async () => 1,
      };
      return builder;
    });
    const res = await enrichFromCall({
      customerId: 'c1',
      extraction: { property: { access_notes: 'garage code is 1122', pets_on_property: { details: 'two dogs in yard' } } },
    });
    expect(res.applied).toContain('property_preferences_created');
    expect(inserts[0].row.garage_code).toBe('1122');
    expect(inserts[0].row.pet_details).toBe('two dogs in yard');
  });

  test('a write failure never throws out of the call path', async () => {
    isEnabled.mockReturnValue(true);
    db.mockImplementation(() => ({ where() { return this; }, first: async () => { throw new Error('boom'); } }));
    const res = await enrichFromCall({ customerId: 'c1', extraction: { property: { access_notes: 'gate code is 4545' } } });
    expect(res.applied).toEqual([]);
  });
});
