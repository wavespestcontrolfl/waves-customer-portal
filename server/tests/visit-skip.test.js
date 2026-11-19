/**
 * Skip one recurring plan visit (owner decision 2026-11-13: the office only, and a paid visit is moved, never
 * skipped): the rule that says which visit may be skipped (services/visit-skip.js).
 *
 * A skip marks the visit `skipped`, books no make-up visit and texts nobody. It runs none of the cancel
 * follow-through (invoice void, card fee rails, linked-visit cascade), so the rule refuses every visit that would
 * need one. It reads the bare-visit classifier the Intelligence Bar cancel card uses and ignores only the make-up
 * code. That classifier has its own suite (appointment-cancel-impact.test.js) and is mocked here; these tests pin
 * what the skip rule does with its answer, and what the cancel window is told.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Every call below passes its own connection: a read through the pool would be a read outside the caller's lock.
jest.mock('../models/db', () => jest.fn(() => { throw new Error('visit-skip read the pool instead of the connection it was given'); }));
const mockImpact = jest.fn();
jest.mock('../services/appointment-cancel-impact', () => ({ computeCancelAppointmentImpact: (...a) => mockImpact(...a) }));

const { skipVerdict, assertSkippable, skipPreview, nextPlanVisitDate, _private: { MESSAGES } } = require('../services/visit-skip');

// A knex-shaped reader over rows in memory. It honours the filters visit-skip.js writes (equality, the series group,
// status list, "later than", order, limit), so a query that asks for the wrong rows fails a test.
function memoryConn(rows) {
  const sortable = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value));
  const keyOf = (column) => String(column).replace(/^scheduled_services\./, '');
  const conn = () => {
    const filters = [];
    let order = null;
    let cap = Infinity;
    const b = {
      where(column, op, value) {
        if (typeof column === 'function') {
          const anyOf = [];
          const group = {
            where(col, val) { anyOf.push((row) => row[keyOf(col)] === val); return group; },
            orWhere(col, val) {
              if (typeof col === 'function') {
                const every = [];
                const nested = {
                  whereNot(key, expected) { every.push((row) => row[keyOf(key)] !== expected); return nested; },
                  whereRaw() {
                    every.push((row) => !(row.source_action === 'voice_agent'
                      && row.status === 'confirmed' && row.customer_confirmed !== true));
                    return nested;
                  },
                };
                col(nested);
                anyOf.push((row) => every.every((match) => match(row)));
                return group;
              }
              anyOf.push(typeof col === 'object'
                ? (row) => Object.entries(col).every(([key, expected]) => (row[keyOf(key)] ?? null) === expected)
                : (row) => row[keyOf(col)] === val);
              return group;
            },
            whereNull(col) { anyOf.push((row) => row[keyOf(col)] == null); return group; },
            whereNotNull(col) { anyOf.push((row) => row[keyOf(col)] != null); return group; },
            orWhereNotNull(col) { anyOf.push((row) => row[keyOf(col)] != null); return group; },
            orWhereNotIn(col, values) { anyOf.push((row) => !values.includes(row[keyOf(col)])); return group; },
          };
          column.call(group, group);
          filters.push((row) => anyOf.some((match) => match(row)));
        } else if (column && typeof column === 'object') {
          filters.push((row) => Object.entries(column).every(([key, val]) => row[key] === val));
        } else if (op === '>' || op === '>=') {
          filters.push((row) => op === '>'
            ? sortable(row[column]) > sortable(value)
            : sortable(row[column]) >= sortable(value));
        } else {
          throw new Error(`memoryConn: unsupported where(${column}, ${op})`);
        }
        return b;
      },
      whereIn(column, values) { filters.push((row) => values.includes(row[column])); return b; },
      whereNotNull(column) { filters.push((row) => row[column] != null); return b; },
      orderBy(column, direction) { order = [column, direction]; return b; },
      limit(n) { cap = n; return b; },
      rows() {
        const hits = rows.filter((row) => filters.every((match) => match(row)));
        if (order) hits.sort((x, y) => sortable(x[order[0]]).localeCompare(sortable(y[order[0]])) * (order[1] === 'desc' ? -1 : 1));
        return hits.slice(0, cap).map((row) => ({ ...row }));
      },
      async first() { return b.rows()[0]; },
      async select() { return b.rows(); },
    };
    return b;
  };
  return conn;
}

// The second visit of a quarterly pest plan: open, nobody on the way, a child of the series root.
const planVisit = (over = {}) => ({
  id: 'visit-2', status: 'pending', track_state: 'scheduled', is_recurring: true, recurring_parent_id: 'visit-1',
  is_callback: false, followup_included: false, scheduled_date: '2027-03-20', recurring_pattern: 'quarterly',
  service_id: 'pest-service', property_id: 'house-1', window_start: '09:00:00', ...over,
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

describe('skipPreview: what the cancel window shows', () => {
  const quarterly = () => [
    planVisit({ id: 'visit-1', recurring_parent_id: null, status: 'completed', scheduled_date: '2026-12-20' }),
    planVisit(),
    // Later rows of the same series that are not the plan's next open visit:
    planVisit({ id: 'visit-3-cancelled', status: 'cancelled', scheduled_date: '2027-04-10' }),
    planVisit({ id: 'booster', is_recurring: false, scheduled_date: '2027-05-01' }),
    planVisit({ id: 'visit-4', status: 'confirmed', scheduled_date: '2027-09-20' }),
    planVisit({ id: 'visit-3', scheduled_date: '2027-06-21' }),
    // Another customer's plan is never read.
    planVisit({ id: 'other-plan', recurring_parent_id: 'other-root', scheduled_date: '2027-03-25' }),
  ];

  test('an unknown visit has no preview', async () => {
    await expect(skipPreview('missing', office(memoryConn(quarterly())))).resolves.toBeNull();
  });

  test('an eligible visit names the plan\'s next open visit, and no lawn round on a pest plan', async () => {
    bare();
    await expect(skipPreview('visit-2', office(memoryConn(quarterly())))).resolves.toEqual({
      eligible: true, code: 'ok', message: '', nextVisitDate: '2027-06-21', lawnRound: null,
    });
  });

  test('skipping the series root looks through its children for the next visit', async () => {
    bare();
    const rows = quarterly().map((row) => (row.id === 'visit-1' ? { ...row, status: 'pending' } : row));
    await expect(skipPreview('visit-1', office(memoryConn(rows)))).resolves.toMatchObject({ eligible: true, nextVisitDate: '2027-03-20' });
  });

  test('the last booked visit of a plan has no next visit to name', async () => {
    bare();
    await expect(skipPreview('visit-4', office(memoryConn(quarterly())))).resolves.toMatchObject({ eligible: true, nextVisitDate: null });
  });

  test('a visit that may not be skipped carries the reason and no dates', async () => {
    refused('prepaid_coverage');
    await expect(skipPreview('visit-2', office(memoryConn(quarterly())))).resolves.toEqual({
      eligible: false, code: 'prepaid', message: MESSAGES.prepaid, nextVisitDate: null, lawnRound: null,
    });
  });

  test('a technician gets the refusal, not the plan\'s dates', async () => {
    await expect(skipPreview('visit-2', { conn: memoryConn(quarterly()), isAdmin: false }))
      .resolves.toEqual({ eligible: false, code: 'admin_only', message: MESSAGES.admin_only, nextVisitDate: null, lawnRound: null });
  });

  test('a lawn plan on nine rounds names the round the skip drops', async () => {
    bare();
    const rows = quarterly().map((row) => ({ ...row, recurring_pattern: 'lawn_rounds_9' }));
    await expect(skipPreview('visit-2', office(memoryConn(rows)))).resolves.toMatchObject({
      eligible: true, lawnRound: { round: 3, start: '2027-03-15', end: '2027-04-23' },
    });
  });

  test('dates read from Postgres as Date values give the same calendar days', async () => {
    bare();
    const rows = quarterly().map((row) => ({ ...row, recurring_pattern: 'lawn_rounds_9', scheduled_date: new Date(`${row.scheduled_date}T00:00:00Z`) }));
    await expect(skipPreview('visit-2', office(memoryConn(rows)))).resolves.toMatchObject({
      nextVisitDate: '2027-06-21', lawnRound: { round: 3, start: '2027-03-15', end: '2027-04-23' },
    });
  });
});

describe('public next-visit date scope', () => {
  test('requires durable service and property keys when used by a customer tracker', async () => {
    const row = planVisit({ service_id: null });
    await expect(nextPlanVisitDate(memoryConn([row]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBeNull();
  });

  test('does not name a later row from another service or house', async () => {
    const row = planVisit();
    const rows = [
      planVisit({ id: 'wrong-service', scheduled_date: '2027-04-01', service_id: 'lawn-service' }),
      planVisit({ id: 'wrong-house', scheduled_date: '2027-04-02', property_id: 'house-2' }),
      planVisit({ id: 'same-service-house', scheduled_date: '2027-06-21' }),
    ];
    await expect(nextPlanVisitDate(memoryConn(rows), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBe('2027-06-21');
  });

  test('does not name an overdue open occurrence as the public next visit', async () => {
    const { addETDays, etDateString } = require('../utils/datetime-et');
    const skippedDate = etDateString(addETDays(new Date(), -5));
    const overdueDate = etDateString(addETDays(new Date(), -2));
    const futureDate = etDateString(addETDays(new Date(), 5));
    const row = planVisit({ scheduled_date: skippedDate });
    const overdue = planVisit({ id: 'overdue', scheduled_date: overdueDate });
    const upcoming = planVisit({ id: 'upcoming', scheduled_date: futureDate });

    await expect(nextPlanVisitDate(memoryConn([overdue, upcoming]), row, skippedDate, {
      requireServiceAndProperty: true,
    })).resolves.toBe(futureDate);
  });

  test('filters both marked unplaced shapes before the bounded date scan', async () => {
    const row = planVisit();
    const parked = Array.from({ length: 12 }, (_, index) => planVisit({
      id: `parked-${index}`,
      scheduled_date: `2027-04-${String(index + 1).padStart(2, '0')}`,
      customer_pick_by: index < 6 ? '2027-03-21T18:00:00.000Z' : null,
      recurring_dispatch_due_date: index >= 6 ? `2027-04-${String(index + 1).padStart(2, '0')}` : null,
      window_start: null,
    }));
    const booked = planVisit({ id: 'booked-next', scheduled_date: '2027-06-21', window_start: '09:00:00' });
    await expect(nextPlanVisitDate(memoryConn([...parked, booked]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBe('2027-06-21');
  });

  test('preserves a markerless legacy windowless visit as the next date', async () => {
    const row = planVisit();
    const legacyDateOnly = planVisit({
      id: 'legacy-date-only', scheduled_date: '2027-04-01', window_start: null,
      customer_pick_by: null, recurring_dispatch_due_date: null,
    });
    await expect(nextPlanVisitDate(memoryConn([legacyDateOnly]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBe('2027-04-01');
  });

  test('filters unreviewed dispatch-owned bookings before the public scan limit', async () => {
    const row = planVisit();
    const sources = ['ai_call_pipeline_followup', 'ai_call_outbound_review', 'voice_agent'];
    const hidden = Array.from({ length: 12 }, (_, index) => planVisit({
      id: `unreviewed-${index}`,
      scheduled_date: `2027-04-${String(index + 1).padStart(2, '0')}`,
      source_action: sources[index % sources.length],
      customer_confirmed: false,
    }));
    const visible = planVisit({ id: 'visible-next', scheduled_date: '2027-06-21' });
    await expect(nextPlanVisitDate(memoryConn([...hidden, visible]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBe('2027-06-21');
  });

  test('returns no date conservatively when a bounded public batch contains only non-plan linked visits', async () => {
    const row = planVisit();
    const linked = Array.from({ length: 12 }, (_, index) => planVisit({
      id: `booster-${index}`,
      scheduled_date: `2027-04-${String(index + 1).padStart(2, '0')}`,
      is_recurring: false,
    }));
    const visible = planVisit({ id: 'visible-next', scheduled_date: '2027-06-21' });
    await expect(nextPlanVisitDate(memoryConn([...linked, visible]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBeNull();
  });

  test.each([
    ['office-reviewed pending call booking', { status: 'pending', source_action: 'ai_call_outbound_review', customer_confirmed: true }],
    ['confirmed outbound booking', { status: 'confirmed', source_action: 'ai_call_outbound_review', customer_confirmed: false }],
  ])('keeps a %s visible like signed-in Schedule', async (_label, shape) => {
    const row = planVisit();
    const candidate = planVisit({ id: 'reviewed', scheduled_date: '2027-04-01', ...shape });
    await expect(nextPlanVisitDate(memoryConn([candidate]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBe('2027-04-01');
  });

  test('hides the confirmed but unreviewed voice-agent move shape', async () => {
    const row = planVisit();
    const hidden = planVisit({
      id: 'voice-moved', scheduled_date: '2027-04-01', status: 'confirmed',
      source_action: 'voice_agent', customer_confirmed: false,
    });
    const visible = planVisit({ id: 'visible-next', scheduled_date: '2027-06-21' });
    await expect(nextPlanVisitDate(memoryConn([hidden, visible]), row, '2027-03-20', { requireServiceAndProperty: true }))
      .resolves.toBe('2027-06-21');
  });
});
