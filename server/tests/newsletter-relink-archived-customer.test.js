/**
 * One twin picker (liveTwinSubselect) for first-link and archive-time relink:
 * normalized-email match, canonical live-customer scope, deterministic order.
 */
jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(async () => ({ rowCount: 1 })); return db; });
jest.mock('../services/newsletter-sunset', () => ({ REENGAGEMENT_TAG: 'reengagement_due' }));

const db = require('../models/db');
const { liveTwinSubselect, linkToCustomer, relinkSubscribersFromArchivedCustomer } = require('../services/newsletter-subscribers');
const { CUSTOMER_STAGES } = require('../services/customer-stages');

const SCOPE = /c\.active = true\s+AND c\.deleted_at IS NULL\s+AND c\.pipeline_stage IN \((\?, )*\?\)/;
const ORDER = /ORDER BY c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC\s+LIMIT 1\)/;

beforeEach(() => jest.clearAllMocks());

describe('liveTwinSubselect', () => {
  test('normalized email match + canonical scope + deterministic order, stages bound from customer-stages', () => {
    const { sql, bindings } = liveTwinSubselect('?', { excludeCustomerId: 'arch-1' });
    expect(sql).toMatch(/LOWER\(TRIM\(c\.email\)\) = \?/);
    expect(sql).toMatch(/c\.id <> \?/);
    expect(sql).toMatch(SCOPE);
    expect(sql).toMatch(ORDER);
    expect(bindings).toEqual(['arch-1', ...CUSTOMER_STAGES]);
    expect(CUSTOMER_STAGES).not.toContain('new_lead');
  });
});

describe('linkToCustomer picks the LIVE twin', () => {
  test('unlinked subscriber whose email matches an archived AND a live profile → linked to the live one (scope in SQL, only NULL links touched)', async () => {
    await linkToCustomer('Household@Example.com');
    expect(db.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/UPDATE newsletter_subscribers\s+SET customer_id = twin\.id/);
    expect(sql).toMatch(/FROM \(SELECT c\.id FROM customers c\s+WHERE LOWER\(TRIM\(c\.email\)\) = \?/);
    expect(sql).toMatch(SCOPE);
    expect(sql).toMatch(ORDER);
    expect(sql).toMatch(/newsletter_subscribers\.email = \?\s+AND newsletter_subscribers\.customer_id IS NULL/);
    expect(bindings).toEqual(['household@example.com', ...CUSTOMER_STAGES, 'household@example.com']);
  });

  test('only an archived profile matches → subselect yields no row, UPDATE is a no-op (stays unlinked)', async () => {
    db.raw.mockResolvedValueOnce({ rowCount: 0 });
    await expect(linkToCustomer('solo@example.com')).resolves.toBeUndefined();
    // The scope lives in the FROM-subselect: with no live twin the join is empty.
    expect(db.raw.mock.calls[0][0]).toMatch(SCOPE);
  });

  test('empty email is a no-op', async () => {
    await linkToCustomer('');
    expect(db.raw).not.toHaveBeenCalled();
  });
});

describe('relinkSubscribersFromArchivedCustomer uses the same picker', () => {
  function fakeTrx(twinId) {
    const subs = { where: jest.fn(() => subs), update: jest.fn(async () => (twinId ? 2 : 0)) };
    const trx = jest.fn(() => subs);
    trx.raw = jest.fn(async () => ({ rows: [{ id: twinId }] }));
    trx.fn = { now: () => 'NOW()' };
    return { trx, subs };
  }

  test('archive with a live twin → subscribers relinked; picker keyed on the archived profile email, archived id excluded', async () => {
    const { trx, subs } = fakeTrx('twin-1');
    const out = await relinkSubscribersFromArchivedCustomer(trx, 'archived-1');
    expect(out).toEqual({ twinId: 'twin-1', relinked: 2 });
    const [sql, bindings] = trx.raw.mock.calls[0];
    expect(sql).toMatch(/LOWER\(TRIM\(c\.email\)\) = \(SELECT LOWER\(TRIM\(email\)\) FROM customers WHERE id = \?\)/);
    expect(sql).toMatch(/c\.id <> \?/);
    expect(sql).toMatch(SCOPE);
    expect(sql).toMatch(ORDER);
    expect(bindings).toEqual(['archived-1', 'archived-1', ...CUSTOMER_STAGES]);
    expect(subs.where).toHaveBeenCalledWith({ customer_id: 'archived-1' });
    expect(subs.update).toHaveBeenCalledWith({ customer_id: 'twin-1', updated_at: 'NOW()' });
  });

  test('archive without a live twin → link untouched', async () => {
    const { trx, subs } = fakeTrx(null);
    const out = await relinkSubscribersFromArchivedCustomer(trx, 'archived-2');
    expect(out).toEqual({ twinId: null, relinked: 0 });
    expect(subs.update).not.toHaveBeenCalled();
  });
});
