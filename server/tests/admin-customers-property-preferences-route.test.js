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
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(async () => false) }));

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

  test('irrigationInchesPerWeek is dropped (not saved) for a customer with no lawn-care evidence', async () => {
    hasLawnServiceEvidence.mockResolvedValueOnce(false);
    const res = await putPrefs({ irrigationInchesPerWeek: 1.5, accessNotes: 'note' });
    expect(res.status).toBe(200);
    expect(mockState.prefsRow.irrigation_inches_per_week).toBeUndefined();
    expect(mockState.prefsRow.access_notes).toBe('note');
  });

  test('irrigationInchesPerWeek saves for a WaveGuard tier customer without a lookup', async () => {
    mockState.customerRow = { id: 'cust-1', waveguard_tier: 'Gold', lawn_type: null };
    const res = await putPrefs({ irrigationInchesPerWeek: 1.5 });
    expect(res.status).toBe(200);
    expect(res.body.preferences.irrigation_inches_per_week).toBe(1.5);
    expect(hasLawnServiceEvidence).not.toHaveBeenCalled();
  });

  test('wateringDays and mowingDays round-trip as JSON-stringified jsonb writes', async () => {
    const res = await putPrefs({ wateringDays: ['Mon', 'Wed'], mowingDays: ['Tue'] });
    expect(res.status).toBe(200);
    expect(typeof mockState.prefsRow.watering_days).toBe('string');
    expect(JSON.parse(mockState.prefsRow.watering_days)).toEqual(['Mon', 'Wed']);
    expect(JSON.parse(mockState.prefsRow.mowing_days)).toEqual(['Tue']);
  });
});
