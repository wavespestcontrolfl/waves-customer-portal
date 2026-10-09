/**
 * PUT /api/admin/customers/:id/property-preferences — the staff-facing
 * counterpart to the customer portal's PUT /api/property/preferences
 * (server/tests/property-prefs-partial-validation.test.js covers that
 * route). Both writers now share their field schemas, ALLOWED_FIELDS and
 * per-field validator via server/services/property-preferences-schema.js;
 * this file pins the admin route's OWN behavior: it upserts the row,
 * accepts two staff-only fields the portal never exposes, sends no
 * customer notification, and reports rejected fields the same way the
 * portal does.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(async () => false), hasIrrigationEmailOptIn: jest.fn(async () => false) }));

const mockAccountMembershipEmail = { sendAccountUpdated: jest.fn(async () => ({ ok: true })) };
jest.mock('../services/account-membership-email', () => mockAccountMembershipEmail);

const mockState = { prefsRow: null, customerRow: { id: 'cust-1', waveguard_tier: null, lawn_type: null } };

jest.mock('../models/db', () => {
  const prefsTable = () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => mockState.prefsRow);
    q.update = jest.fn(async (patch) => {
      mockState.prefsRow = { ...mockState.prefsRow, ...patch };
      return 1;
    });
    q.insert = jest.fn(async (data) => {
      mockState.prefsRow = { id: 'pref-1', created_at: new Date().toISOString(), ...data };
      return [1];
    });
    return q;
  };
  const customersTable = () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.forShare = jest.fn(() => q);
    q.first = jest.fn(async () => mockState.customerRow);
    return q;
  };
  const dbFn = jest.fn((table) => {
    if (table === 'property_preferences') return prefsTable();
    if (table === 'customers') return customersTable();
    throw new Error(`Unexpected table ${table}`);
  });
  dbFn.transaction = jest.fn(async (cb) => cb(dbFn));
  dbFn.raw = jest.fn(async () => undefined);
  dbFn.fn = { now: jest.fn(() => new Date().toISOString()) };
  return dbFn;
});

const router = require('../routes/admin-customers');
const db = require('../models/db');
const { recordAuditEvent } = require('../services/audit-log');
const { hasLawnServiceEvidence } = require('../services/irrigation-weekly-email');

async function putPrefs(body) {
  const layer = router.stack.find((e) => e.route?.path === '/:id/property-preferences' && e.route?.methods?.put);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = {
    params: { id: 'cust-1' },
    body,
    technicianId: 'admin-1',
    ip: '127.0.0.1',
    get: jest.fn(() => 'jest-test'),
  };
  const result = { status: 200, body: null, error: null };
  const res = {
    status(c) { result.status = c; return res; },
    json(p) { result.body = p; return res; },
  };
  await handler(req, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  await new Promise((r) => setImmediate(r));
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.prefsRow = null;
  mockState.customerRow = { id: 'cust-1', waveguard_tier: null, lawn_type: null };
});

describe('PUT /api/admin/customers/:id/property-preferences', () => {
  test('creates the row (upsert) when none exists, and persists valid fields', async () => {
    const res = await putPrefs({ propertyGateCode: '4477', accessNotes: 'Use the side gate' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.preferences.property_gate_code).toBe('4477');
    expect(res.body.preferences.access_notes).toBe('Use the side gate');
    expect(mockState.prefsRow.customer_id).toBe('cust-1');
  });

  test('updates (not re-inserts) an existing row, changing only the sent fields', async () => {
    mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', property_gate_code: '1111', access_notes: 'old note' };
    const res = await putPrefs({ accessNotes: 'new note' });
    expect(res.status).toBe(200);
    expect(res.body.preferences.access_notes).toBe('new note');
    // Untouched field survives the partial update.
    expect(res.body.preferences.property_gate_code).toBe('1111');
  });

  test('a mixed batch persists the valid fields and 200s with a rejected list (matches the portal contract)', async () => {
    const res = await putPrefs({ accessNotes: 'Use the side gate', hoaEmail: 'not-an-email' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.rejected).toEqual([{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }]);
    expect(mockState.prefsRow.access_notes).toBe('Use the side gate');
    expect(mockState.prefsRow.hoa_email).toBeUndefined();
  });

  test('a batch where every field is invalid 400s with nothing saved', async () => {
    const res = await putPrefs({ hoaEmail: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual([{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }]);
    expect(mockState.prefsRow).toBeNull();
  });

  test('an unknown field is silently dropped, not reported as rejected', async () => {
    const res = await putPrefs({ accessNotes: 'note', notAField: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toBeUndefined();
  });

  test('rejects an invalid enum value (mowingTimeOfDay) with a per-field message', async () => {
    const res = await putPrefs({ mowingTimeOfDay: 'whenever' });
    expect(res.status).toBe(400);
    expect(res.body.rejected[0].field).toBe('mowingTimeOfDay');
  });

  test('accepts the two staff-only fields the portal does not expose', async () => {
    const res = await putPrefs({ chemicalSensitivities: true, chemicalSensitivityDetails: 'Bee allergy — no residual spray near patio' });
    expect(res.status).toBe(200);
    expect(res.body.preferences.chemical_sensitivities).toBe(true);
    expect(res.body.preferences.chemical_sensitivity_details).toBe('Bee allergy — no residual spray near patio');
  });

  test('never sends a customer notification email', async () => {
    await putPrefs({ preferredDay: 'monday', wateringDays: ['Mon', 'Wed'] });
    expect(mockAccountMembershipEmail.sendAccountUpdated).not.toHaveBeenCalled();
  });

  test('records an audit event naming only the changed FIELD NAMES, never the code values', async () => {
    await putPrefs({ propertyGateCode: '9982', lockboxCode: '5501' });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const call = recordAuditEvent.mock.calls[0][0];
    expect(call.action).toBe('customer.property_preferences.updated');
    expect(call.resource_id).toBe('cust-1');
    expect(call.metadata.fields.sort()).toEqual(['lockbox_code', 'property_gate_code']);
    // The values never ride in the metadata blob at all.
    expect(JSON.stringify(call.metadata)).not.toContain('9982');
    expect(JSON.stringify(call.metadata)).not.toContain('5501');
  });

  test('irrigationInchesPerWeek is REJECTED (not silently dropped) for a customer with no lawn-care evidence, but the rest of the batch still saves', async () => {
    hasLawnServiceEvidence.mockResolvedValueOnce(false);
    const res = await putPrefs({ irrigationInchesPerWeek: 1.5, accessNotes: 'note' });
    expect(res.status).toBe(200);
    expect(mockState.prefsRow.irrigation_inches_per_week).toBeUndefined();
    expect(mockState.prefsRow.access_notes).toBe('note');
    expect(res.body.rejected).toEqual([{
      field: 'irrigationInchesPerWeek',
      message: expect.stringMatching(/not eligible/i),
    }]);
  });

  test('irrigationInchesPerWeek alone, ineligible customer, 400s with nothing saved (still reported via rejected, not just a joined string)', async () => {
    hasLawnServiceEvidence.mockResolvedValueOnce(false);
    const res = await putPrefs({ irrigationInchesPerWeek: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual([{
      field: 'irrigationInchesPerWeek',
      message: expect.stringMatching(/not eligible/i),
    }]);
    expect(mockState.prefsRow).toBeNull();
  });

  test('irrigationInchesPerWeek saves for a WaveGuard tier customer without a lookup', async () => {
    mockState.customerRow = { id: 'cust-1', waveguard_tier: 'Gold', lawn_type: null };
    const res = await putPrefs({ irrigationInchesPerWeek: 1.5 });
    expect(res.status).toBe(200);
    expect(res.body.preferences.irrigation_inches_per_week).toBe(1.5);
    expect(hasLawnServiceEvidence).not.toHaveBeenCalled();
  });

  test('clearing irrigationInchesPerWeek to null succeeds even for an ineligible customer — a clear is never gated', async () => {
    mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', irrigation_inches_per_week: 1.5 };
    const res = await putPrefs({ irrigationInchesPerWeek: null });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toBeUndefined();
    expect(mockState.prefsRow.irrigation_inches_per_week).toBeNull();
    expect(hasLawnServiceEvidence).not.toHaveBeenCalled();
  });

  test('wateringDays and mowingDays round-trip as JSON-stringified jsonb writes', async () => {
    const res = await putPrefs({ wateringDays: ['Mon', 'Wed'], mowingDays: ['Tue'] });
    expect(res.status).toBe(200);
    expect(typeof mockState.prefsRow.watering_days).toBe('string');
    expect(JSON.parse(mockState.prefsRow.watering_days)).toEqual(['Mon', 'Wed']);
    expect(JSON.parse(mockState.prefsRow.mowing_days)).toEqual(['Tue']);
  });

  describe('blackout window integrity', () => {
    test('rejects a lone blackoutEnd with no blackoutStart (neither saved)', async () => {
      const res = await putPrefs({ blackoutEnd: '2026-12-25', accessNotes: 'note' });
      expect(res.status).toBe(200);
      expect(res.body.rejected).toEqual([{
        field: 'blackoutEnd',
        message: expect.stringMatching(/set or cleared together/i),
      }]);
      expect(mockState.prefsRow.blackout_end).toBeUndefined();
      expect(mockState.prefsRow.blackout_start).toBeUndefined();
      expect(mockState.prefsRow.access_notes).toBe('note');
    });

    test('rejects end before start', async () => {
      const res = await putPrefs({ blackoutStart: '2026-12-25', blackoutEnd: '2026-12-01' });
      expect(res.status).toBe(400);
      expect(res.body.rejected).toEqual([{
        field: 'blackoutEnd',
        message: expect.stringMatching(/on or after/i),
      }]);
      expect(mockState.prefsRow).toBeNull();
    });

    test('accepts a valid start/end pair', async () => {
      const res = await putPrefs({ blackoutStart: '2026-12-01', blackoutEnd: '2026-12-25' });
      expect(res.status).toBe(200);
      expect(res.body.rejected).toBeUndefined();
      expect(mockState.prefsRow.blackout_start).toBeTruthy();
      expect(mockState.prefsRow.blackout_end).toBeTruthy();
    });

    test('accepts clearing both together (both null/empty)', async () => {
      mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', blackout_start: '2026-01-01', blackout_end: '2026-01-05' };
      const res = await putPrefs({ blackoutStart: '', blackoutEnd: '' });
      expect(res.status).toBe(200);
      expect(res.body.rejected).toBeUndefined();
      // The Joi date schema normalizes '' to null before it ever reaches
      // storage — belt-and-braces even though the client sends null itself.
      expect(mockState.prefsRow.blackout_start).toBeNull();
      expect(mockState.prefsRow.blackout_end).toBeNull();
    });
  });

  describe('irrigation_confirmed_fields ledger (admin writes UNCONFIRM, never confirm)', () => {
    test('a genuinely changed sizing field is stripped from irrigation_confirmed_fields in the same update', async () => {
      mockState.prefsRow = {
        id: 'pref-1', customer_id: 'cust-1',
        irrigation_run_minutes: 15,
        irrigation_confirmed_fields: ['irrigation_run_minutes', 'watering_days'],
      };
      await putPrefs({ irrigationRunMinutes: 30 });
      const rawCalls = db.raw.mock.calls.filter(([sql]) => String(sql).includes('jsonb_array_elements_text'));
      expect(rawCalls).toHaveLength(1);
      // Bindings are [ [...fieldsToRemove] ] — irrigation_run_minutes changed
      // (15 -> 30) so it's the one being unconfirmed; watering_days was not
      // touched this save and is left alone.
      expect(rawCalls[0][1][0]).toEqual(['irrigation_run_minutes']);
    });

    test('re-saving a sizing field with the SAME value does not touch the confirmed-fields ledger', async () => {
      mockState.prefsRow = {
        id: 'pref-1', customer_id: 'cust-1',
        irrigation_run_minutes: 30,
        irrigation_confirmed_fields: ['irrigation_run_minutes'],
      };
      await putPrefs({ irrigationRunMinutes: 30, accessNotes: 'note' });
      const rawCalls = db.raw.mock.calls.filter(([sql]) => String(sql).includes('jsonb_array_elements_text'));
      expect(rawCalls).toHaveLength(0);
    });

    test('rain_sensor changing is stripped from the confirmed set too', async () => {
      mockState.prefsRow = {
        id: 'pref-1', customer_id: 'cust-1', rain_sensor: false,
        irrigation_confirmed_fields: ['rain_sensor'],
      };
      await putPrefs({ rainSensor: true });
      const rawCalls = db.raw.mock.calls.filter(([sql]) => String(sql).includes('jsonb_array_elements_text'));
      expect(rawCalls).toHaveLength(1);
      expect(rawCalls[0][1][0]).toEqual(['rain_sensor']);
    });
  });

  describe('irrigation_system stamp (mirrors the portal writer)', () => {
    test('any genuine irrigation-field edit stamps irrigation_system: true, unblocking a legacy false row', async () => {
      mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', irrigation_system: false };
      const res = await putPrefs({ irrigationControllerLocation: 'Side yard' });
      expect(res.status).toBe(200);
      expect(res.body.preferences.irrigation_system).toBe(true);
    });

    test('a non-irrigation edit does not touch irrigation_system', async () => {
      mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', irrigation_system: false };
      const res = await putPrefs({ accessNotes: 'note' });
      expect(res.status).toBe(200);
      expect(res.body.preferences.irrigation_system).toBe(false);
    });
  });
});

describe('codex r2', () => {
  it('404s for a missing or archived customer and writes nothing', async () => {
    mockState.customerRow = null;
    const result = await putPrefs({ neighborhoodGateCode: '1234' });
    expect(result.status).toBe(404);
    expect(mockState.prefsRow).toBeNull();
  });

  it('entering sensitivity details without the flag turns the flag on', async () => {
    mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', chemical_sensitivities: false };
    const result = await putPrefs({ chemicalSensitivityDetails: 'Asthma in the household' });
    expect(result.status).toBe(200);
    expect(mockState.prefsRow.chemical_sensitivities).toBe(true);
  });

  it('an explicit flag in the same request wins over the details inference', async () => {
    mockState.prefsRow = { id: 'pref-1', customer_id: 'cust-1', chemical_sensitivities: true };
    await putPrefs({ chemicalSensitivities: false, chemicalSensitivityDetails: 'Resolved last year' });
    expect(mockState.prefsRow.chemical_sensitivities).toBe(false);
  });
});

describe('codex r3 — enum columns validate on value', () => {
  it('an off-list preferredDay is a per-field rejection and the rest still saves', async () => {
    const result = await putPrefs({ preferredDay: 'saturday', accessNotes: 'Code box by the mailbox' });
    expect(result.status).toBe(200);
    expect(result.body.rejected.map((r) => r.field)).toEqual(['preferredDay']);
    expect(mockState.prefsRow.access_notes).toBe('Code box by the mailbox');
    expect(mockState.prefsRow).not.toHaveProperty('preferred_day', 'saturday');
  });

  it('accepts valid enum values and clears an empty contact preference to null', async () => {
    const result = await putPrefs({ preferredDay: 'tuesday', preferredTime: 'early_morning', contactPreference: '' });
    expect(result.status).toBe(200);
    expect(mockState.prefsRow).toMatchObject({ preferred_day: 'tuesday', preferred_time: 'early_morning', contact_preference: null });
  });
});

describe('the new-sod record — staff-only sodLaidOn / sodCovers / sodArea', () => {
  const { etDateString, addETDays } = require('../utils/datetime-et');
  const daysAgo = (n) => etDateString(addETDays(new Date(), -n));
  const stored = (extra = {}) => ({ id: 'pref-1', customer_id: 'cust-1', ...extra });

  it('saves a real recent day as the plain YYYY-MM-DD string; covers defaults to whole; area stays empty', async () => {
    const day = daysAgo(3);
    const result = await putPrefs({ sodLaidOn: day });
    expect(result.status).toBe(200);
    expect(mockState.prefsRow).toMatchObject({ sod_laid_on: day, sod_covers: 'whole', sod_area: null, sod_rooted_on: null });
    expect(typeof mockState.prefsRow.sod_laid_on).toBe('string');
    expect(recordAuditEvent.mock.calls[0][0].metadata).toEqual({ fields: ['sod_laid_on'] });
  });

  it('part needs a named area (trimmed); whole drops it', async () => {
    const day = daysAgo(3);
    let res = await putPrefs({ sodLaidOn: day, sodCovers: 'part' });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual([{ field: 'sodArea', message: 'Name the part of the lawn that has new sod.' }]);
    expect(mockState.prefsRow).toBeNull();

    res = await putPrefs({ sodLaidOn: day, sodCovers: 'part', sodArea: '  back lawn by the pool ' });
    expect(res.status).toBe(200);
    expect(mockState.prefsRow).toMatchObject({ sod_covers: 'part', sod_area: 'back lawn by the pool' });

    res = await putPrefs({ sodCovers: 'whole', sodArea: 'ignored' });
    expect(res.status).toBe(200);
    expect(mockState.prefsRow).toMatchObject({ sod_laid_on: day, sod_covers: 'whole', sod_area: null });
  });

  it('merges with the stored row: an area-only edit keeps the date and covers; a covers-only switch to part needs an area', async () => {
    const day = daysAgo(10);
    mockState.prefsRow = stored({ sod_laid_on: day, sod_covers: 'part', sod_area: 'front yard' });
    expect((await putPrefs({ sodArea: 'side yard' })).status).toBe(200);
    expect(mockState.prefsRow).toMatchObject({ sod_laid_on: day, sod_covers: 'part', sod_area: 'side yard' });

    mockState.prefsRow = stored({ sod_laid_on: day, sod_covers: 'whole', sod_area: null });
    const res = await putPrefs({ sodCovers: 'part', accessNotes: 'Side gate' });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ field: 'sodArea', message: 'Name the part of the lawn that has new sod.' }]);
    expect(mockState.prefsRow).toMatchObject({ sod_covers: 'whole', access_notes: 'Side gate' });
  });

  it('covers and area without any date are rejected', async () => {
    const res = await putPrefs({ sodCovers: 'part', sodArea: 'front yard' });
    expect(res.status).toBe(400);
    expect(res.body.rejected[0]).toMatchObject({ field: 'sodLaidOn' });
    expect(mockState.prefsRow).toBeNull();
  });

  it('null and an empty string both clear the whole record, including the rooted day', async () => {
    for (const cleared of [null, '']) {
      mockState.prefsRow = stored({ sod_laid_on: daysAgo(40), sod_covers: 'part', sod_area: 'front yard', sod_rooted_on: daysAgo(2) });
      expect((await putPrefs({ sodLaidOn: cleared })).status).toBe(200);
      expect(mockState.prefsRow).toMatchObject({ sod_laid_on: null, sod_covers: null, sod_area: null, sod_rooted_on: null });
    }
  });

  it('a different sod date clears the rooted day; the same day keeps it', async () => {
    const first = daysAgo(40);
    mockState.prefsRow = stored({ sod_laid_on: first, sod_covers: 'whole', sod_rooted_on: daysAgo(2) });
    expect((await putPrefs({ sodLaidOn: first })).status).toBe(200);
    expect(mockState.prefsRow.sod_rooted_on).toBe(daysAgo(2));
    expect((await putPrefs({ sodLaidOn: daysAgo(39) })).status).toBe(200);
    expect(mockState.prefsRow).toMatchObject({ sod_laid_on: daysAgo(39), sod_rooted_on: null });
  });

  it('sod_rooted_on is not accepted from this route', async () => {
    const res = await putPrefs({ sodLaidOn: daysAgo(40), sodRootedOn: daysAgo(2), sod_rooted_on: daysAgo(2) });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toBeUndefined();
    expect(mockState.prefsRow.sod_rooted_on).toBeNull();
  });

  it('a future day, a day over 24 months old and a non-date are rejected by field; the rest of the batch still saves', async () => {
    const future = etDateString(addETDays(new Date(), 2));
    let res = await putPrefs({ sodLaidOn: future, accessNotes: 'Side gate' });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ field: 'sodLaidOn', message: 'Sod date cannot be in the future.' }]);
    expect(mockState.prefsRow.sod_laid_on).toBeUndefined();
    expect(mockState.prefsRow.access_notes).toBe('Side gate');

    res = await putPrefs({ sodLaidOn: daysAgo(800) });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual([{ field: 'sodLaidOn', message: 'Sod date cannot be more than 24 months ago.' }]);

    res = await putPrefs({ sodLaidOn: '2026-02-30' });
    expect(res.status).toBe(400);
    expect(res.body.rejected[0].field).toBe('sodLaidOn');
  });

  it('rejects covers outside whole/part and an area over 120 characters (the column width)', async () => {
    let res = await putPrefs({ sodLaidOn: daysAgo(3), sodCovers: 'some' });
    expect(res.status).toBe(200);
    expect(res.body.rejected[0].field).toBe('sodCovers');
    res = await putPrefs({ sodLaidOn: daysAgo(3), sodCovers: 'part', sodArea: 'x'.repeat(121) });
    expect(res.body.rejected.map((r) => r.field)).toEqual(['sodArea', 'sodArea']);
    res = await putPrefs({ sodLaidOn: daysAgo(3), sodCovers: 'part', sodArea: 'x'.repeat(120) });
    expect(res.status).toBe(200);
    expect(mockState.prefsRow.sod_area).toHaveLength(120);
  });

  it('the customer portal does not know any of the new-sod fields (staff only)', () => {
    const { PREFS_FIELD_SCHEMAS, ALLOWED_FIELDS, validatePrefsBody } = require('../services/property-preferences-schema');
    const body = { sodLaidOn: daysAgo(3), sodCovers: 'whole', sodArea: 'x', sodRootedOn: daysAgo(1), accessNotes: 'kept' };
    expect(validatePrefsBody(PREFS_FIELD_SCHEMAS, body)).toMatchObject({ value: { accessNotes: 'kept' }, rejected: [] });
    for (const field of ['sodLaidOn', 'sodCovers', 'sodArea', 'sodRootedOn']) expect(PREFS_FIELD_SCHEMAS).not.toHaveProperty(field);
    for (const column of ['sod_laid_on', 'sod_covers', 'sod_area', 'sod_rooted_on']) expect(ALLOWED_FIELDS).not.toContain(column);
    const portalSource = require('fs').readFileSync(require('path').join(__dirname, '../routes/property.js'), 'utf8');
    expect(portalSource).not.toMatch(/sod_|sodLaid|lawn-sod-holds/);
  });
});
