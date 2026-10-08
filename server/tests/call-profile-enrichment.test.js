// Profile-enrichment writer — gate codes/pets/notes from extraction into
// property_preferences + internal_notes, admin-edit-preserving.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { enrichFromCall, _test } = require('../services/call-profile-enrichment');
const { extractCodes, appendWithProvenance } = _test;
// The preference write runs under the customer advisory lock inside a
// transaction; the mock hands the same builder factory back as trx.
db.transaction = jest.fn(async (work) => work(Object.assign((table) => db(table), { raw: jest.fn() })));

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
        forUpdate: () => builder,
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
        forUpdate: () => builder,
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
    db.mockImplementation(() => ({ where() { return this; }, forUpdate() { return this; }, first: async () => { throw new Error('boom'); } }));
    const res = await enrichFromCall({ customerId: 'c1', extraction: { property: { access_notes: 'gate code is 4545' } } });
    expect(res.applied).toEqual([]);
  });
});

describe('provider note on internal_notes', () => {
  // Runs enrichFromCall against a customer with empty notes; returns the note written, or null.
  async function noteFor({ extraction, legacy = null, existing = null }) {
    isEnabled.mockReturnValue(true);
    const updates = [];
    db.mockImplementation((table) => {
      const builder = {
        where: () => builder,
        forUpdate: () => builder,
        first: async () => ({ internal_notes: existing }),
        update: async (u) => { updates.push({ table, u }); return 1; },
        insert: async () => {},
      };
      return builder;
    });
    await enrichFromCall({ customerId: 'c1', extraction, legacy, callCreatedAt: '2026-10-08T21:46:00Z' });
    const write = updates.find((x) => x.table === 'customers');
    return write ? write.u.internal_notes : existing;
  }

  describe('append-only: a provider this day\'s line already names is not named again', () => {
    test('a reprocess under the new label adds no second statement and rewrites nothing', async () => {
      const existing = 'Staff: gate sticks\n[call 2026-10-08] Referred by: a neighbor | Switching from: Acme Pest';
      const note = await noteFor({
        existing,
        extraction: { customer_history: { status: 'former_lapsed', competitor_name: 'Acme Pest' } },
        legacy: { referred_by: 'a neighbor' },
      });
      expect(note).toBe(existing);
    });

    test('two calls on one day naming one provider: the first call\'s line stands', async () => {
      const existing = '[call 2026-10-08] Switching from: Acme Pest';
      const note = await noteFor({ existing, extraction: { customer_history: { status: 'new_customer', competitor_name: 'Acme Pest' } } });
      expect(note).toBe(existing);
    });

    test('a V2 null removes nothing an earlier pass wrote', async () => {
      const existing = '[call 2026-10-08] Switching from: Sample Home Inspections';
      const note = await noteFor({
        existing,
        extraction: { customer_history: { status: 'new_customer', competitor_name: null } },
        legacy: { competitor_name: 'Sample Home Inspections' },
      });
      expect(note).toBe(existing);
    });

    test('a different provider the same day, or the same provider another day, is added', async () => {
      const sameDay = await noteFor({
        existing: '[call 2026-10-08] Switching from: Beta Lawn',
        extraction: { customer_history: { status: 'new_customer', competitor_name: 'Acme Pest' } },
      });
      expect(sameDay).toBe('[call 2026-10-08] Switching from: Beta Lawn\n[call 2026-10-08] Other provider named: Acme Pest');
      const otherDay = await noteFor({
        existing: '[call 2026-09-01] Switching from: Acme Pest',
        extraction: { customer_history: { status: 'new_customer', competitor_name: 'Acme Pest' } },
      });
      expect(otherDay).toBe('[call 2026-09-01] Switching from: Acme Pest\n[call 2026-10-08] Other provider named: Acme Pest');
    });
  });

  test('a caller leaving a provider reads "Switching from"', async () => {
    const note = await noteFor({ extraction: { customer_history: { status: 'switching_from_competitor', competitor_name: 'Acme Pest' } } });
    expect(note).toBe('[call 2026-10-08] Switching from: Acme Pest');
  });

  test('a provider only used before or compared is named without a switch claim', async () => {
    const note = await noteFor({ extraction: { customer_history: { status: 'new_customer', competitor_name: 'Acme Pest' } } });
    expect(note).toBe('[call 2026-10-08] Other provider named: Acme Pest');
    expect(note).not.toMatch(/Switching from/);
  });

  test('a V2 null is not refilled from the legacy extraction (home inspector on a realtor call)', async () => {
    const note = await noteFor({
      extraction: { customer_history: { status: 'new_customer', competitor_name: null } },
      legacy: { competitor_name: 'Sample Home Inspections' },
    });
    expect(note).toBeNull();
  });

  test('a V2 history block with the field omitted is not refilled either', async () => {
    const note = await noteFor({
      extraction: { customer_history: { status: 'unknown' } },
      legacy: { competitor_name: 'Sample Home Inspections' },
    });
    expect(note).toBeNull();
  });

  test('no V2 history block: the legacy name is kept, with no switch claim', async () => {
    const note = await noteFor({ extraction: { property: {} }, legacy: { competitor_name: 'Acme Pest' } });
    expect(note).toBe('[call 2026-10-08] Other provider named: Acme Pest');
  });
});
