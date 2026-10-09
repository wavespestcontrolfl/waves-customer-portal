// The pin suggestion store (pin check after a visit): wording, visibility and the close paths.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn().mockResolvedValue(1) }));

const store = require('../services/customer-pin-suggestions');
const { closeAdminAlertKeys } = require('../services/admin-alert-episodes');

const row = {
  id: '22222222-2222-4222-8222-222222222222', customer_id: 'c1', visit_date: '2026-10-08', pin_lat: '27.4900000', pin_lng: '-82.5700000',
  parked_lat: '27.4948600', parked_lng: '-82.5700000', distance_m: 540, stop_minutes: 25, status: 'open',
};
const detail = (overrides = {}) => ({ customer: { latitude: '27.4900000', longitude: '-82.5700000' }, review: { status: 'geocoded' }, ...overrides });

describe('wording and shape', () => {
  test('the evidence text is the owner wording with the visit date and the distance', () => {
    expect(store.evidenceText(row)).toBe('Truck parked here during the completed visit on Oct 8, 2026 (Bouncie GPS). Pin was 540 m away.');
  });
  test('a date column that arrives as a Date still names the right day', () => {
    expect(store.evidenceText({ ...row, visit_date: new Date(2026, 9, 8) })).toContain('Oct 8, 2026');
  });
  test('the panel gets numbers, the site_visit source and the evidence', () => {
    expect(store.publicShape(row)).toEqual({
      id: row.id, visit_date: '2026-10-08', latitude: 27.49486, longitude: -82.57, distance_m: 540, stop_minutes: 25,
      source: 'site_visit', evidence: store.evidenceText(row),
    });
  });
});

describe('visibleSuggestion (a GET never writes)', () => {
  test('shows an open suggestion for the unchanged pin', () => {
    expect(store.visibleSuggestion(detail(), row).id).toBe(row.id);
  });
  test.each([
    ['no suggestion', detail(), null],
    ['a verified review', detail({ review: { status: 'verified' } }), row],
    ['a confirmed outside-area review', detail({ review: { status: 'outside_area' } }), row],
    ['a pin that moved', detail({ customer: { latitude: '27.5', longitude: '-82.57' } }), row],
    ['a customer with no pin', detail({ customer: { latitude: null, longitude: null } }), row],
  ])('hides it for %s', (_name, d, r) => {
    expect(store.visibleSuggestion(d, r)).toBeNull();
  });
});

describe('closing', () => {
  // A stand-in for knex that supports the calls the store makes. Records the order of lock, update and bell close.
  function conn({ open = row, updates = [] } = {}) {
    const order = [];
    const c = (table) => {
      const state = { where: null, set: null };
      const b = {
        where(w) { state.where = w; return b; },
        first: async () => (open && (!state.where.status || state.where.status === 'open') && (!state.where.id || state.where.id === open.id) ? open : undefined),
        update(set) { state.set = set; updates.push({ table, where: state.where, set }); order.push('update'); return b; },
        returning: async () => (open && state.where.id === open.id && state.where.status === 'open' ? [{ ...open, status: state.set.status }] : []),
      };
      return b;
    };
    c.fn = { now: () => 'NOW' };
    c.raw = async (sql, bindings) => { order.push(`lock:${bindings[1]}`); return {}; };
    c.transaction = async (fn) => fn(c);
    c.updates = updates;
    c.order = order;
    return c;
  }
  beforeEach(() => closeAdminAlertKeys.mockClear());

  test('dismiss closes only an open suggestion of that customer and closes its bell', async () => {
    const c = conn();
    const closed = await store.dismiss('c1', row.id, 'actor-1', c);
    expect(closed.status).toBe('dismissed');
    expect(c.updates[0].set).toMatchObject({ status: 'dismissed', resolved_by: 'actor-1' });
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(c, [`pin-suggestion:${row.id}`], 'dismissed', expect.any(Object));
    // The customer's lock comes before the close, so it cannot interleave with the bell being posted.
    expect(c.order).toEqual(['lock:c1', 'update']);
    expect(await store.dismiss('c1', 'another-id', 'actor-1', conn())).toBeNull();
    expect(await store.dismiss('c1', row.id, 'actor-1', conn({ open: null }))).toBeNull();
  });

  test('verify_pin from the suggestion marks it applied; any other verify_pin supersedes it', async () => {
    expect((await store.closeAfterVerify('c1', { suggestionId: row.id, actorId: 'actor-1', conn: conn() })).status).toBe('applied');
    expect((await store.closeAfterVerify('c1', { suggestionId: null, actorId: 'actor-1', conn: conn() })).status).toBe('superseded');
    expect((await store.closeAfterVerify('c1', { suggestionId: 'someone-elses', conn: conn() })).status).toBe('superseded');
  });

  test('a bell that cannot be closed rolls the close back instead of leaving a live bell', async () => {
    closeAdminAlertKeys.mockRejectedValueOnce(new Error('notifications down'));
    await expect(store.closeSuggestion(row.id, 'dismissed', { conn: conn() })).rejects.toThrow('notifications down');
  });

  test('nothing open means nothing to close, and a failure never throws into the verify_pin response', async () => {
    expect(await store.closeAfterVerify('c1', { conn: conn({ open: null }) })).toBeNull();
    const broken = () => { throw new Error('boom'); };
    broken.fn = { now: () => 'NOW' };
    broken.transaction = async (fn) => fn(broken);
    expect(await store.closeAfterVerify('c1', { conn: broken })).toBeNull();
  });
});
