/**
 * GET /api/admin/customers/:id/new-sod — the read-only lines the Customer 360
 * new-sod form shows: the hold lines for the saved record (computed from
 * sodHolds, not restated in the client), the last Waves pre-emergent, and the
 * "under 12 weeks before the sod" warning. Office only; it writes nothing.
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

const mockState = { customer: { id: 'cust-1' }, prefsRow: null, productRows: [], productsThrow: false };

jest.mock('../models/db', () => {
  const chain = (resolve) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'join', 'leftJoin', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => resolve());
    q.select = jest.fn(async () => resolve());
    return q;
  };
  const dbFn = jest.fn((table) => {
    if (table === 'customers') return chain(() => mockState.customer);
    if (table === 'property_preferences') return chain(() => mockState.prefsRow);
    if (String(table).startsWith('service_products')) {
      mockState.historyQuery = chain(() => {
        if (mockState.productsThrow) throw new Error('relation does not exist');
        return mockState.productRows;
      });
      return mockState.historyQuery;
    }
    throw new Error(`Unexpected table ${table}`);
  });
  return dbFn;
});

const router = require('../routes/admin-customers');
const { etDateString, addETDays } = require('../utils/datetime-et');

const daysAgo = (n) => etDateString(addETDays(new Date(), -n));

async function getNewSod(query = {}) {
  const layer = router.stack.find((e) => e.route?.path === '/:id/new-sod' && e.route?.methods?.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const result = { status: 200, body: null, error: null };
  const res = {
    status(c) { result.status = c; return res; },
    json(p) { result.body = p; return res; },
  };
  await handler({ params: { id: 'cust-1' }, query }, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => {
  mockState.customer = { id: 'cust-1' };
  mockState.prefsRow = null;
  mockState.productRows = [];
  mockState.productsThrow = false;
});

const DIMENSION = { service_date: '2026-06-10', product_name: 'LESCO Dimension 0.25% Granular', applied_ingredient: null, applied_category: 'herbicide', catalog_ingredient: 'Dithiopyr', catalog_category: 'herbicide', catalog_subcategory: null };
const FERT = { service_date: '2026-08-20', product_name: 'LESCO 24-0-11', applied_ingredient: null, applied_category: 'fertilizer', catalog_ingredient: null, catalog_category: 'fertilizer', catalog_subcategory: null };

describe('GET /api/admin/customers/:id/new-sod', () => {
  it('404s for a missing customer', async () => {
    mockState.customer = undefined;
    expect((await getNewSod()).status).toBe(404);
  });

  it('a customer with no sod record and no pre-emergent history gets empty lines and no warning', async () => {
    const { body } = await getNewSod();
    expect(body.newSod).toEqual({ holdLines: [], lastPreEmergent: null, lastPreEmergentUnreadable: false, preEmergentWarning: null });
  });

  it('names the newest pre-emergent, skipping newer products that are not one', async () => {
    mockState.productRows = [FERT, DIMENSION];
    const { body } = await getNewSod();
    expect(body.newSod.lastPreEmergent).toEqual({ date: '2026-06-10', dateText: 'Jun 10, 2026', product: 'LESCO Dimension 0.25% Granular' });
  });

  it('reads the pre-emergent from the applied row when the catalog has no match', async () => {
    mockState.productRows = [{ service_date: '2026-03-02', product_name: 'Prodiamine 65 WDG', applied_ingredient: 'Prodiamine', applied_category: 'herbicide', catalog_ingredient: null, catalog_category: null, catalog_subcategory: null }];
    const { body } = await getNewSod();
    expect(body.newSod.lastPreEmergent).toMatchObject({ date: '2026-03-02', dateText: 'Mar 2, 2026', product: 'Prodiamine 65 WDG' });
  });

  it('a failed history read is reported as unreadable, never as none on record, and does not fail the page', async () => {
    mockState.productsThrow = true;
    const { status, body } = await getNewSod();
    expect(status).toBe(200);
    expect(body.newSod.lastPreEmergent).toBeNull();
    expect(body.newSod.lastPreEmergentUnreadable).toBe(true);
    expect(body.newSod.preEmergentWarning).toBeNull();
  });

  it('warns when the pre-emergent was under 84 days before the saved sod date, and not at 84 days', async () => {
    mockState.productRows = [{ ...DIMENSION, service_date: daysAgo(30) }];
    mockState.prefsRow = { sod_laid_on: daysAgo(3), sod_covers: 'whole', sod_area: null, sod_rooted_on: null };
    let { body } = await getNewSod();
    expect(body.newSod.preEmergentWarning).toBe('Pre-emergent was applied less than 12 weeks before this sod. Tell the customer.');

    // Exactly 84 days before the sod: no warning. 83 days: warning.
    mockState.productRows = [{ ...DIMENSION, service_date: daysAgo(87) }];
    ({ body } = await getNewSod());
    expect(body.newSod.preEmergentWarning).toBeNull();
    mockState.productRows = [{ ...DIMENSION, service_date: daysAgo(86) }];
    ({ body } = await getNewSod());
    expect(body.newSod.preEmergentWarning).not.toBeNull();
  });

  it('judges a typed, unsaved date (?sodLaidOn=) and ignores the saved one; an empty or bad date gives no warning', async () => {
    mockState.productRows = [{ ...DIMENSION, service_date: daysAgo(60) }];
    mockState.prefsRow = { sod_laid_on: daysAgo(200), sod_covers: 'whole', sod_area: null, sod_rooted_on: null };
    expect((await getNewSod()).body.newSod.preEmergentWarning).toBeNull();
    expect((await getNewSod({ sodLaidOn: daysAgo(5) })).body.newSod.preEmergentWarning).not.toBeNull();
    expect((await getNewSod({ sodLaidOn: '' })).body.newSod.preEmergentWarning).toBeNull();
    expect((await getNewSod({ sodLaidOn: 'not-a-date' })).body.newSod.preEmergentWarning).toBeNull();
    // Same checks as the save: a future day is not a sod date.
    const future = etDateString(addETDays(new Date(), 4));
    expect((await getNewSod({ sodLaidOn: future })).body.newSod.preEmergentWarning).toBeNull();
  });

  it('no warning when the pre-emergent came after the sod date', async () => {
    mockState.productRows = [{ ...DIMENSION, service_date: daysAgo(2) }];
    mockState.prefsRow = { sod_laid_on: daysAgo(20), sod_covers: 'whole', sod_area: null, sod_rooted_on: null };
    expect((await getNewSod()).body.newSod.preEmergentWarning).toBeNull();
  });

  it('whole-lawn record: three hold lines with dates, from the server', async () => {
    mockState.prefsRow = { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null, sod_rooted_on: null };
    const { body } = await getNewSod();
    const byKey = Object.fromEntries(body.newSod.holdLines.map((l) => [l.key, l]));
    expect(Object.keys(byKey)).toEqual(['fertilizer', 'weedKiller', 'preEmergent']);
    expect(byKey.fertilizer.text).toBe(`Fertilizer is held until Oct 31, 2026${byKey.fertilizer.active ? '' : ' (this hold is over)'}.`);
    expect(byKey.weedKiller.text).toContain('Weed killer is held until Oct 31, 2026 and until the technician confirms the sod is rooted');
    expect(byKey.preEmergent.text).toContain('Pre-emergent is held until Oct 1, 2027');
  });

  it('the history read is a date window, never a row limit', async () => {
    await getNewSod();
    const q = mockState.historyQuery;
    expect(q.limit).not.toHaveBeenCalled();
    // An incomplete visit records applied products too.
    expect(q.whereIn).toHaveBeenCalledWith('sr.status', ['completed', 'incomplete']);
    const window = q.where.mock.calls.find((call) => call[0] === 'sr.service_date');
    expect(window[1]).toBe('>=');
    // Reaches past the oldest sod date the form accepts (24 months) plus the 12 weeks before it.
    expect(window[2] <= daysAgo(24 * 31 + 84)).toBe(true);
  });

  it('this home only: another street, another unit and another ZIP are left out; no stamp or an omitted unit is kept', async () => {
    const home = { home_line1: '100 Sample St', home_line2: 'Unit 3', home_city: 'Testville', home_zip: '34200' };
    const at = (days, stamp) => ({ ...DIMENSION, service_date: daysAgo(days), ...home, ...stamp });
    const named = async (rows) => { mockState.productRows = rows; return (await getNewSod()).body.newSod.lastPreEmergent?.date || null; };
    expect(await named([at(10, { service_address_line1: '55 Other Rd', service_address_zip: '34200' })])).toBeNull();
    expect(await named([at(10, { service_address_line1: '100 Sample St', service_address_line2: 'Unit 4', service_address_zip: '34200' })])).toBeNull();
    expect(await named([at(10, { service_address_line1: '100 Sample St Unit 4' })])).toBeNull();
    expect(await named([at(10, { service_address_line1: '100 Sample St', service_address_line2: 'Unit 3', service_address_zip: '34999' })])).toBeNull();
    expect(await named([at(10, { service_address_line1: null })])).toBe(daysAgo(10));
    expect(await named([at(10, { service_address_line1: '100 Sample Street' })])).toBe(daysAgo(10));
    expect(await named([at(10, { service_address_line1: '100 Sample St', service_address_line2: 'Unit 3' })])).toBe(daysAgo(10));
    // The newer visit was at another unit: the older one at this home is the one named.
    expect(await named([at(5, { service_address_line1: '100 Sample St', service_address_line2: 'Unit 4' }), at(40, { service_address_line1: null })])).toBe(daysAgo(40));
  });

  it('a pre-emergent after the sod date does not hide one applied shortly before it', async () => {
    mockState.productRows = [{ ...DIMENSION, service_date: daysAgo(5) }, { ...DIMENSION, service_date: daysAgo(60) }];
    const { body } = await getNewSod({ sodLaidOn: daysAgo(40) });
    expect(body.newSod.lastPreEmergent.date).toBe(daysAgo(5));
    expect(body.newSod.preEmergentWarning).toMatch(/less than 12 weeks/);
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
