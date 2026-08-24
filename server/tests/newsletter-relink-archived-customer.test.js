/**
 * One twin picker (liveTwinSubselect) for first-link and archive/restore
 * relink: normalized-email match, ARCHIVED-only scope (deleted_at IS NULL —
 * deliberately not whereLiveCustomer, so link semantics stay exactly what they
 * were minus archived rows), deterministic order.
 */
jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(async () => ({ rowCount: 1 })); return db; });
jest.mock('../services/newsletter-sunset', () => ({ REENGAGEMENT_TAG: 'reengagement_due' }));

const db = require('../models/db');
const {
  liveTwinSubselect, linkToCustomer, linkManyToCustomers,
  relinkSubscribersForEmail, relinkSubscribersFromArchivedCustomer,
  relinkArchivedLinkedSubscribers,
} = require('../services/newsletter-subscribers');

const SCOPE = /AND c\.deleted_at IS NULL/;
// Lifecycle predicates must NOT appear: customer_id is a LINK, and lead-stage
// profiles have always been valid link targets.
const NO_LIFECYCLE = [/c\.active = true/, /c\.pipeline_stage/];
const ORDER = /ORDER BY c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC\s+LIMIT 1\)/;

beforeEach(() => jest.clearAllMocks());

describe('liveTwinSubselect', () => {
  test('normalized email match + archived-only scope + deterministic order', () => {
    const { sql, bindings } = liveTwinSubselect('?', { excludeCustomerId: 'arch-1' });
    expect(sql).toMatch(/LOWER\(TRIM\(c\.email\)\) = \?/);
    expect(sql).toMatch(/c\.id <> \?/);
    expect(sql).toMatch(SCOPE);
    expect(sql).toMatch(ORDER);
    // Only the excludeCustomerId binding — no stage list to bind any more.
    expect(bindings).toEqual(['arch-1']);
  });

  test('a lead-stage (new_lead / contacted) profile is STILL a valid link target — the picker filters archived rows only', () => {
    const { sql, bindings } = liveTwinSubselect('?');
    NO_LIFECYCLE.forEach((re) => expect(sql).not.toMatch(re));
    expect(bindings).toEqual([]);
    // Every consumer of the picker inherits that: no lifecycle predicate
    // anywhere in the link path, so buildSubscriberQuery's customers/leads
    // audiences (customer_id IS [NOT] NULL) keep their pre-PR meaning.
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
    NO_LIFECYCLE.forEach((re) => expect(sql).not.toMatch(re));
    expect(bindings).toEqual(['household@example.com', 'household@example.com']);
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
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    NO_LIFECYCLE.forEach((re) => expect(sql).not.toMatch(re));
    expect(sql).toMatch(/ORDER BY LOWER\(TRIM\(c\.email\)\), c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC/);
    expect(sql).toMatch(/WHERE LOWER\(TRIM\(ns\.email\)\) = t\.email_key/);
    // First link only — never re-points an already-linked subscriber.
    expect(sql).toMatch(/ns\.customer_id IS NULL/);
    // Emails normalized + deduped, and bound (never interpolated).
    expect(bindings).toEqual([
      ['live@example.com', 'archived-only@example.com'],
      ['live@example.com', 'archived-only@example.com'],
    ]);
  });

  test('no usable emails → no query', async () => {
    expect(await linkManyToCustomers([])).toBe(0);
    expect(await linkManyToCustomers([null, '   '])).toBe(0);
    expect(db.raw).not.toHaveBeenCalled();
  });
});

describe('relinkSubscribersFromArchivedCustomer (archive route) keys on the SUBSCRIBER email', () => {
  function fakeTrx(rowCount) {
    const trx = jest.fn();
    trx.raw = jest.fn(async () => ({ rowCount }));
    return trx;
  }

  test('a subscriber whose stored email no longer matches the archived customer email is still relinked — to the twin of ITS OWN email', async () => {
    const trx = fakeTrx(1);
    const out = await relinkSubscribersFromArchivedCustomer(trx, 'archived-1');
    expect(out).toEqual({ relinked: 1 });
    const [sql, bindings] = trx.raw.mock.calls[0];
    // Rows are found by the archived LINK, never by the customer's current
    // email — that is what catches the stale snapshot.
    expect(sql).toMatch(/WHERE ns\.customer_id = \?/);
    expect(sql).toMatch(/SELECT LOWER\(TRIM\(x\.email\)\) FROM newsletter_subscribers x WHERE x\.customer_id = \?/);
    // …and each row moves to the winner for ITS OWN normalized email.
    expect(sql).toMatch(/DISTINCT ON \(LOWER\(TRIM\(c\.email\)\)\)/);
    expect(sql).toMatch(/LOWER\(TRIM\(ns\.email\)\) = t\.email_key/);
    // Same scope + order as the picker; the archived profile is not a candidate.
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    expect(sql).toMatch(/c\.id <> \?/);
    expect(sql).toMatch(/ORDER BY LOWER\(TRIM\(c\.email\)\), c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC/);
    NO_LIFECYCLE.forEach((re) => expect(sql).not.toMatch(re));
    expect(bindings).toEqual(['archived-1', 'archived-1', 'archived-1']);
  });

  test('no non-archived profile for those emails → nothing moves; no id → no query', async () => {
    const trx = fakeTrx(0);
    expect(await relinkSubscribersFromArchivedCustomer(trx, 'archived-2')).toEqual({ relinked: 0 });
    expect(await relinkSubscribersFromArchivedCustomer(trx, null)).toEqual({ relinked: 0 });
    expect(trx.raw).toHaveBeenCalledTimes(1);
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
    expect(bindings).toEqual(['household@example.com']);
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

describe('relinkArchivedLinkedSubscribers (pre-send sweep) generalizes the archive-side relink', () => {
  function fakeConn(rowCount) {
    const conn = jest.fn();
    conn.raw = jest.fn(async () => ({ rowCount }));
    return conn;
  }

  test('every archived-linked subscriber with a live same-email twin moves — re-booked households relink before an audience is selected', async () => {
    const conn = fakeConn(3);
    expect(await relinkArchivedLinkedSubscribers(conn)).toEqual({ relinked: 3 });
    const [sql] = conn.raw.mock.calls[0];
    // Rows are found by their archived LINK (never the customer's current
    // email), and each moves to the winner for ITS OWN normalized email —
    // same shape as relinkSubscribersFromArchivedCustomer, without the
    // single-customer anchor.
    expect(sql).toMatch(/JOIN customers ax ON ax\.id = x\.customer_id/);
    expect(sql).toMatch(/ax\.deleted_at IS NOT NULL/);
    expect(sql).toMatch(/ns\.customer_id IN \(SELECT ac\.id FROM customers ac WHERE ac\.deleted_at IS NOT NULL\)/);
    expect(sql).toMatch(/DISTINCT ON \(LOWER\(TRIM\(c\.email\)\)\)/);
    expect(sql).toMatch(/LOWER\(TRIM\(ns\.email\)\) = t\.email_key/);
    // Same picker scope + ordering; still link semantics, not lifecycle.
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    expect(sql).toMatch(/ORDER BY LOWER\(TRIM\(c\.email\)\), c\.is_primary_profile DESC NULLS LAST, c\.created_at ASC, c\.id ASC/);
    NO_LIFECYCLE.forEach((re) => expect(sql).not.toMatch(re));
  });

  test('nothing stale → { relinked: 0 }', async () => {
    expect(await relinkArchivedLinkedSubscribers(fakeConn(0))).toEqual({ relinked: 0 });
  });

  test('sendCampaign runs the sweep BEFORE seeding/refetching the audience, for fresh sends AND resumes (source contract)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'newsletter-sender.js'), 'utf8');
    const relinkAt = src.indexOf('await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);');
    expect(relinkAt).toBeGreaterThan(-1);
    const sendCampaignAt = src.indexOf('async function sendCampaign(');
    const seedAt = src.indexOf('if (!opts.existingDeliveriesOnly) {', sendCampaignAt);
    expect(relinkAt).toBeGreaterThan(sendCampaignAt);
    expect(relinkAt).toBeLessThan(seedAt);
    // Unconditional within sendCampaign — resumes re-read customer_id at
    // dispatch time, so the sweep must not be gated on fresh sends only.
    const between = src.slice(sendCampaignAt, relinkAt);
    expect(src.slice(relinkAt - 900, relinkAt)).not.toMatch(/if \(!opts\.existingDeliveriesOnly\) \{\s*$/);
    expect(between).toContain('validateFlagshipEventSelection'); // after the content gates, before the audience
  });
});
