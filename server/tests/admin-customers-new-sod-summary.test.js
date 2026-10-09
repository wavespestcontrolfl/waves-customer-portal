/**
 * GET /api/admin/customers/:id/new-sod — the read-only hold lines the Customer
 * 360 new-sod form shows for the saved record (computed from sodHolds, not
 * restated in the client). Office only; it writes nothing.
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

const mockState = { customer: { id: 'cust-1' }, prefsRow: null };

jest.mock('../models/db', () => {
  const chain = (resolve) => {
    const q = {};
    for (const m of ['where', 'whereNull']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => resolve());
    return q;
  };
  return jest.fn((table) => {
    if (table === 'customers') return chain(() => mockState.customer);
    if (table === 'property_preferences') return chain(() => mockState.prefsRow);
    throw new Error(`Unexpected table ${table}`);
  });
});

const router = require('../routes/admin-customers');
const { etDateString, addETDays } = require('../utils/datetime-et');

const daysAgo = (n) => etDateString(addETDays(new Date(), -n));

async function getNewSod() {
  const layer = router.stack.find((e) => e.route?.path === '/:id/new-sod' && e.route?.methods?.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const result = { status: 200, body: null, error: null };
  const res = {
    status(c) { result.status = c; return res; },
    json(p) { result.body = p; return res; },
  };
  await handler({ params: { id: 'cust-1' }, query: {} }, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => {
  mockState.customer = { id: 'cust-1' };
  mockState.prefsRow = null;
});

describe('GET /api/admin/customers/:id/new-sod', () => {
  it('404s for a missing customer', async () => {
    mockState.customer = undefined;
    expect((await getNewSod()).status).toBe(404);
  });

  it('a customer with no sod record gets no hold lines and nothing else', async () => {
    const { body } = await getNewSod();
    expect(body.newSod).toEqual({ holdLines: [], record: { sod_laid_on: null, sod_covers: null, sod_area: null } });
  });

  it('whole-lawn record: three hold lines with dates, from the server', async () => {
    mockState.prefsRow = { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null, sod_rooted_on: null };
    const { body } = await getNewSod();
    const byKey = Object.fromEntries(body.newSod.holdLines.map((l) => [l.key, l]));
    expect(Object.keys(byKey)).toEqual(['fertilizer', 'weedKiller', 'preEmergent']);
    // The record the lines were built from travels with them.
    expect(body.newSod.record).toEqual({ sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null });
    expect(byKey.fertilizer.text).toBe(`Fertilizer is held until Oct 31, 2026${byKey.fertilizer.active ? '' : ' (this hold is over)'}.`);
    expect(byKey.weedKiller.text).toContain('Weed killer is held until Oct 31, 2026 and until the technician confirms the sod is rooted');
    expect(byKey.preEmergent.text).toContain('Pre-emergent is held until Oct 1, 2027');
  });

  it('a record from months ago marks finished holds as over; the rooted check ends the weed killer hold', async () => {
    mockState.prefsRow = { sod_laid_on: daysAgo(50), sod_covers: 'whole', sod_area: null, sod_rooted_on: null };
    let lines = (await getNewSod()).body.newSod.holdLines;
    expect(lines.find((l) => l.key === 'fertilizer')).toMatchObject({ active: false });
    expect(lines.find((l) => l.key === 'fertilizer').text).toMatch(/\(this hold is over\)\.$/);
    // Past 30 days but not confirmed rooted: still held.
    expect(lines.find((l) => l.key === 'weedKiller')).toMatchObject({ active: true });

    mockState.prefsRow = { sod_laid_on: daysAgo(50), sod_covers: 'whole', sod_area: null, sod_rooted_on: daysAgo(10) };
    lines = (await getNewSod()).body.newSod.holdLines;
    expect(lines.find((l) => l.key === 'weedKiller')).toMatchObject({ active: false });
  });

  it('part of lawn: fertilizer is not held; the other holds name the area scope', async () => {
    mockState.prefsRow = { sod_laid_on: '2026-10-01', sod_covers: 'part', sod_area: 'back lawn', sod_rooted_on: null };
    const lines = (await getNewSod()).body.newSod.holdLines;
    expect(lines.find((l) => l.key === 'fertilizer')).toEqual({ key: 'fertilizer', active: false, text: 'Fertilizer is not held. The new sod covers only part of the lawn.' });
    expect(lines.find((l) => l.key === 'preEmergent').text).toContain('named area only');
  });
});
