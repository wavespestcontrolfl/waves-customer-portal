/**
 * Skip one recurring plan visit (owner decision 2026-11-13: the office only, and a paid visit is moved, never
 * skipped): the rule that says which visit may be skipped (services/visit-skip.js).
 *
 * A skip marks the visit `skipped`, books no make-up visit and texts nobody. It runs none of the cancel
 * follow-through (invoice void, card fee rails, linked-visit cascade), so the rule refuses every visit that would
 * need one. It reads the bare-visit classifier the Intelligence Bar cancel card uses and ignores only the make-up
 * code. That classifier has its own suite (appointment-cancel-impact.test.js) and is mocked here; these tests pin
 * what the skip rule does with its answer.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Every call below passes its own connection: a read through the pool would be a read outside the caller's lock.
jest.mock('../models/db', () => jest.fn(() => { throw new Error('visit-skip read the pool instead of the connection it was given'); }));
const mockImpact = jest.fn();
jest.mock('../services/appointment-cancel-impact', () => ({ computeCancelAppointmentImpact: (...a) => mockImpact(...a) }));

const { skipVerdict, assertSkippable, _private: { MESSAGES } } = require('../services/visit-skip');

// A knex-shaped reader over rows in memory: the one read assertSkippable makes, where({ id }).first().
function memoryConn(rows) {
  return () => {
    let wanted = {};
    const b = {
      where(match) { wanted = match; return b; },
      async first() {
        const row = rows.find((candidate) => Object.entries(wanted).every(([key, value]) => candidate[key] === value));
        return row ? { ...row } : undefined;
      },
    };
    return b;
  };
}

// The second visit of a quarterly pest plan: open, nobody on the way, a child of the series root.
const planVisit = (over = {}) => ({
  id: 'visit-2', status: 'pending', track_state: 'scheduled', is_recurring: true, recurring_parent_id: 'visit-1',
  is_callback: false, followup_included: false, scheduled_date: '2027-03-20', recurring_pattern: 'quarterly', ...over,
});
const office = (conn = memoryConn([])) => ({ conn, isAdmin: true, actorId: 'admin-1' });
const bare = () => mockImpact.mockResolvedValue({ card_cancel_refusals: [] });
const refused = (...codes) => mockImpact.mockResolvedValue({ card_cancel_refusals: codes });

beforeEach(() => { mockImpact.mockReset(); });

describe('who may skip, and which visit', () => {
  test('an open plan visit with nothing on it may be skipped by the office', async () => {
    bare();
    const conn = memoryConn([]);
    await expect(skipVerdict(planVisit(), office(conn))).resolves.toEqual({ eligible: true, code: 'ok', message: '' });
    // The money and card state is read through the caller's connection (its transaction at commit), for this actor.
    expect(mockImpact).toHaveBeenCalledWith('visit-2', { conn, actorId: 'admin-1' });
  });

  test('a PaymentIntent cache goes to the classifier as given; without one the classifier is called as before', async () => {
    bare();
    const conn = memoryConn([]);
    const piCache = new Map();
    await skipVerdict(planVisit(), { ...office(conn), piCache });
    expect(mockImpact).toHaveBeenLastCalledWith('visit-2', { conn, actorId: 'admin-1', piCache, piCacheOnly: false });
  });

  test.each([[{ isAdmin: false }], [{}]])('a caller that is not the office is refused before anything is read (%j)', async (who) => {
    await expect(skipVerdict(planVisit(), { conn: memoryConn([]), ...who }))
      .resolves.toEqual({ eligible: false, code: 'admin_only', message: 'Only the office can skip a visit.' });
    expect(mockImpact).not.toHaveBeenCalled();
  });

  test.each(['en_route', 'on_site', 'completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'])(
    'a visit that is %s can no longer be skipped', async (status) => {
      await expect(skipVerdict(planVisit({ status }), office())).resolves.toMatchObject({ eligible: false, code: 'not_live' });
      expect(mockImpact).not.toHaveBeenCalled();
    });

  test.each(['en_route', 'on_property'])('an open visit whose tracker already says %s is not skipped', async (trackState) => {
    await expect(skipVerdict(planVisit({ status: 'confirmed', track_state: trackState }), office()))
      .resolves.toMatchObject({ eligible: false, code: 'not_live' });
    expect(mockImpact).not.toHaveBeenCalled();
  });

  test('a visit that no longer exists is not skipped', async () => {
    await expect(skipVerdict(undefined, office())).resolves.toMatchObject({ eligible: false, code: 'not_live' });
  });

  test.each([
    ['a one-time visit', { is_recurring: false, recurring_parent_id: null }],
    ['a paid booster on a plan', { is_recurring: false, recurring_parent_id: 'visit-1' }],
    ['a free callback', { is_callback: true }],
    ['an included follow-up', { followup_included: true }],
  ])('%s is not a plan visit: the office cancels it instead', async (_label, over) => {
    await expect(skipVerdict(planVisit(over), office())).resolves.toEqual({
      eligible: false, code: 'not_plan_visit', message: 'Only a visit of a recurring plan can be skipped. Cancel this visit instead.',
    });
    expect(mockImpact).not.toHaveBeenCalled();
  });

  test.each([
    ['the series root', { id: 'visit-1', recurring_parent_id: null }],
    ['a legacy child whose is_recurring is NULL', { is_recurring: null }],
    ['a confirmed visit', { status: 'confirmed' }],
  ])('%s is a plan visit', async (_label, over) => {
    bare();
    await expect(skipVerdict(planVisit(over), office())).resolves.toMatchObject({ eligible: true, code: 'ok' });
  });
});

describe('money, cards and linked visits', () => {
  test('the make-up visit a cancel would book does not stop a skip: a skip books none', async () => {
    refused('plan_makeup_visit');
    await expect(skipVerdict(planVisit(), office())).resolves.toMatchObject({ eligible: true, code: 'ok' });
  });

  test.each([[['prepaid_coverage']], [['plan_makeup_visit', 'prepaid_coverage']], [['invoice_linked', 'prepaid_coverage']]])(
    'a visit that is paid for already is moved, not skipped (%j)', async (codes) => {
      refused(...codes);
      await expect(skipVerdict(planVisit(), office())).resolves.toEqual({
        eligible: false, code: 'prepaid', message: 'This visit is paid for already. Move it to a new date instead of skipping it.',
      });
    });

  // Every other effect a cancel would have to clean up. A new code the classifier grows later lands here too.
  test.each([
    'linked_followup', 'card_rail_present', 'card_fee_agreement', 'card_payment_on_invoice', 'estimate_deposit',
    'grouped_visit', 'followup_child', 'invoice_holds_money', 'inspection_credit', 'invoice_linked', 'a_code_added_later',
  ])('a visit with %s on it is cancelled instead, never skipped', async (code) => {
    refused('plan_makeup_visit', code);
    await expect(skipVerdict(planVisit(), office())).resolves.toEqual({
      eligible: false, code: 'has_money_or_links', message: 'This visit has an invoice, a card or a linked visit on it. Cancel it instead.',
    });
  });

  test('a visit the classifier no longer finds is not skipped', async () => {
    mockImpact.mockResolvedValue(null);
    await expect(skipVerdict(planVisit(), office())).resolves.toMatchObject({ eligible: false, code: 'not_live' });
  });

  test('a failed read of the money and card state never passes for "nothing on it"', async () => {
    mockImpact.mockRejectedValue(new Error('invoices read failed'));
    await expect(skipVerdict(planVisit(), office())).rejects.toThrow('invoices read failed');
  });
});

describe('assertSkippable: the check at commit', () => {
  test('it reads the visit through the transaction it is given and lets an eligible skip pass', async () => {
    bare();
    const trx = memoryConn([planVisit()]);
    await expect(assertSkippable(trx, 'visit-2', { isAdmin: true, actorId: 'admin-1' })).resolves.toBeUndefined();
    expect(mockImpact).toHaveBeenCalledWith('visit-2', { conn: trx, actorId: 'admin-1' });
  });

  test('with the cache of the check made before the lock, it reads PaymentIntents from that cache alone (no Stripe call under the lock)', async () => {
    bare();
    const trx = memoryConn([planVisit()]);
    const piCache = new Map();
    await assertSkippable(trx, 'visit-2', { isAdmin: true, actorId: 'admin-1', piCache });
    expect(mockImpact).toHaveBeenCalledWith('visit-2', { conn: trx, actorId: 'admin-1', piCache, piCacheOnly: true });
  });

  test('a PaymentIntent that appeared after the first check fails the skip: the classifier\'s throw is not swallowed', async () => {
    mockImpact.mockRejectedValue(new Error('PaymentIntent pi_1 was not checked before the lock'));
    await expect(assertSkippable(memoryConn([planVisit()]), 'visit-2', { isAdmin: true, piCache: new Map() })).rejects.toThrow('was not checked before the lock');
  });

  test.each([
    ['a paid visit', () => refused('prepaid_coverage'), [planVisit()], { isAdmin: true }, 409, 'skip_prepaid', MESSAGES.prepaid],
    ['a visit with an invoice', () => refused('invoice_linked'), [planVisit()], { isAdmin: true }, 409, 'skip_has_money_or_links', MESSAGES.has_money_or_links],
    ['a visit another request completed first', bare, [planVisit({ status: 'completed' })], { isAdmin: true }, 409, 'skip_not_live', MESSAGES.not_live],
    ['a visit that is gone', bare, [], { isAdmin: true }, 409, 'skip_not_live', MESSAGES.not_live],
    ['a technician', bare, [planVisit()], { isAdmin: false }, 403, 'skip_admin_only', MESSAGES.admin_only],
  ])('%s is refused with a status, a code and a sentence for the office', async (_label, arrange, rows, who, status, code, message) => {
    arrange();
    await expect(assertSkippable(memoryConn(rows), 'visit-2', who)).rejects.toMatchObject({ status, code, message });
  });
});
