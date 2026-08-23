/**
 * One twin picker (liveTwinSubselect) for first-link and archive-time relink:
 * normalized-email match, canonical live-customer scope, deterministic order.
 */
jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(async () => ({ rowCount: 1 })); return db; });
jest.mock('../services/newsletter-sunset', () => ({ REENGAGEMENT_TAG: 'reengagement_due' }));

const db = require('../models/db');
const { liveTwinSubselect, linkToCustomer, linkManyToCustomers, relinkSubscribersForEmail } = require('../services/newsletter-subscribers');
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

describe('linkManyToCustomers (CSV bulk import) uses the same picker, set-based', () => {
  test('archived + live profile for an imported email → the LIVE one wins; only-archived → row left unlinked', async () => {
    db.raw.mockResolvedValueOnce({ rowCount: 2 });
    const linked = await linkManyToCustomers([' Live@Example.com ', 'archived-only@example.com', 'live@example.com']);
    expect(linked).toBe(2);
    expect(db.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = db.raw.mock.calls[0];
    // One winner per normalized email, chosen by the canonical scope + order:
    // an archived (deleted_at) or non-customer-stage profile is not a
    // candidate at all, so an email whose only profile is archived matches
    // nothing and its subscriber row keeps customer_id NULL.
    expect(sql).toMatch(/DISTINCT ON \(LOWER\(TRIM\(c\.email\)\)\)/);
    expect(sql).toMatch(/c\.active = true/);
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    expect(sql).toMatch(/c\.pipeline_stage IN \((\?, )*\?\)/);
    expect(sql).toMatch(/ORDER BY LOWER\(TRIM\(c\.email\)\), c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC/);
    expect(sql).toMatch(/WHERE LOWER\(TRIM\(ns\.email\)\) = t\.email_key/);
    // First link only — never re-points an already-linked subscriber.
    expect(sql).toMatch(/ns\.customer_id IS NULL/);
    // Emails normalized + deduped, and bound (never interpolated).
    expect(bindings).toEqual([
      ['live@example.com', 'archived-only@example.com'],
      ...CUSTOMER_STAGES,
      ['live@example.com', 'archived-only@example.com'],
    ]);
  });

  test('no usable emails → no query', async () => {
    expect(await linkManyToCustomers([])).toBe(0);
    expect(await linkManyToCustomers([null, '   '])).toBe(0);
    expect(db.raw).not.toHaveBeenCalled();
  });
});

describe('relinkSubscribersForEmail (archive AND restore) uses the same picker', () => {
  function fakeTrx(winnerId) {
    const subs = {};
    ['whereRaw', 'whereNotNull', 'whereNot', 'whereIn'].forEach((m) => { subs[m] = jest.fn(() => subs); });
    subs.update = jest.fn(async () => (winnerId ? 2 : 0));
    const trx = jest.fn(() => subs);
    trx.raw = jest.fn(async () => ({ rows: [{ id: winnerId }] }));
    trx.fn = { now: () => 'NOW()' };
    return { trx, subs };
  }

  test('archive of the primary → rows carrying that email move to the live secondary; matched on the SUBSCRIBER email and the email\'s own profile set', async () => {
    const { trx, subs } = fakeTrx('secondary-1');
    const out = await relinkSubscribersForEmail(trx, ' Household@Example.com ');
    expect(out).toEqual({ winnerId: 'secondary-1', relinked: 2 });
    const [sql, bindings] = trx.raw.mock.calls[0];
    expect(sql).toMatch(/LOWER\(TRIM\(c\.email\)\) = \?/);
    expect(sql).toMatch(SCOPE);
    expect(sql).toMatch(ORDER);
    expect(bindings).toEqual(['household@example.com', ...CUSTOMER_STAGES]);
    expect(subs.whereRaw).toHaveBeenCalledWith('LOWER(TRIM(email)) = ?', ['household@example.com']);
    expect(subs.whereNotNull).toHaveBeenCalledWith('customer_id');
    expect(subs.whereNot).toHaveBeenCalledWith('customer_id', 'secondary-1');
    // Only links into THIS email's profile set move (never a foreign link).
    const inner = { select: jest.fn(() => inner), from: jest.fn(() => inner), whereRaw: jest.fn(() => inner) };
    subs.whereIn.mock.calls[0][1].call(inner);
    expect(inner.from).toHaveBeenCalledWith('customers');
    expect(inner.whereRaw).toHaveBeenCalledWith('LOWER(TRIM(email)) = ?', ['household@example.com']);
    expect(subs.update).toHaveBeenCalledWith({ customer_id: 'secondary-1', updated_at: 'NOW()' });
  });

  test('restore of the primary → same call re-picks the primary (symmetric)', async () => {
    const { trx, subs } = fakeTrx('primary-1');
    const out = await relinkSubscribersForEmail(trx, 'household@example.com');
    expect(out.winnerId).toBe('primary-1');
    expect(subs.update).toHaveBeenCalledWith({ customer_id: 'primary-1', updated_at: 'NOW()' });
  });

  test('no live profile for the email → links untouched; empty email → no query', async () => {
    const { trx, subs } = fakeTrx(null);
    expect(await relinkSubscribersForEmail(trx, 'solo@example.com')).toEqual({ winnerId: null, relinked: 0 });
    expect(subs.update).not.toHaveBeenCalled();
    expect(await relinkSubscribersForEmail(trx, '')).toEqual({ winnerId: null, relinked: 0 });
    expect(trx.raw).toHaveBeenCalledTimes(1);
  });
});
