/**
 * SMS scheduling decide step, SHADOW (GATE_SMS_SCHEDULING_DECIDE, dark): the
 * model's answer is read strictly, every check refuses to staff, a slot the
 * calendar already shows is confirm-only, and nothing but a decision row is
 * written. Synthetic people and numbers only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const decide = require('../services/sms-scheduling-decide');

const GATE = 'GATE_SMS_SCHEDULING_DECIDE';
const NOW = new Date('2026-10-02T15:00:00Z');
const CUSTOMER = { id: 'cust-1', phone: '+19415550100', service_contact_phone: null, service_contact2_phone: null };
const VISIT_ID = '11111111-1111-4111-8111-111111111111';
const SLOTS = [
  { date_label: 'Tuesday, October 6', window_label: '10:00 AM - 12:00 PM', date: '2026-10-06', start: '10:00', end: '12:00' },
  { date_label: 'Wednesday, October 7', window_label: '2:00 PM - 4:00 PM', date: '2026-10-07', start: '14:00', end: '16:00' },
];
const OFFER = {
  id: 'offer-1', kind: 'move_visit', customer_id: 'cust-1', scheduled_service_id: VISIT_ID,
  estimate_id: null, service_key: null, slots: SLOTS, sent_at: new Date('2026-10-02T13:00:00Z'),
  // The visit as it stood just before the offer went out (read by the send step).
  visit_snapshot: { date: '2026-10-05', start: '08:00', end: '10:00', status: 'confirmed', scheduled_service_id: VISIT_ID, pre_send: true },
};
const VISIT = {
  id: VISIT_ID, customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-10-05',
  window_start: '08:00:00', window_end: '10:00:00', visit_id: null, source_action: null, customer_confirmed: true,
};
const accept = (n = 1, quote = 'Tuesday works', confidence = 'high') => ({ action: 'accept_slot', slot_number: n, customer_quote: quote, confidence });
const evaluate = (over = {}) => {
  const offer = over.offer || OFFER;
  const decision = over.decision || accept();
  const pick = decide.resolvePick([offer], decision);
  return decide.evaluateDecision({
    offer, slot: pick?.slot || null, decision, inboundBody: 'Tuesday works for us, thanks!', customer: CUSTOMER,
    fromPhone: '+19415550100', visit: VISIT, visitAfter: VISIT, movedSinceOffer: false, now: NOW, ...over,
  });
};

afterEach(() => { delete process.env[GATE]; });

describe('readDecision', () => {
  test('a well-formed answer is kept; anything off-schema is null', () => {
    expect(decide.readDecision(accept())).toEqual(accept());
    expect(decide.readDecision({ ...accept(), action: 'book_it' })).toBeNull();
    expect(decide.readDecision({ ...accept(), slot_number: 1.5 })).toBeNull();
    expect(decide.readDecision({ ...accept(), confidence: 'certain' })).toBeNull();
    expect(decide.readDecision(null)).toBeNull();
  });
});

describe('evaluateDecision', () => {
  test('a clean accept of an offered slot for a movable visit would move it', () => {
    expect(evaluate()).toEqual({
      outcome: 'would_move',
      refusals: [],
      would_have: {
        kind: 'move_visit', scheduled_service_id: VISIT_ID, date: '2026-10-06', start: '10:00', arrival_end: '12:00',
        from: { date: '2026-10-05', start: '08:00', end: '10:00' },
      },
    });
  });

  test('accepting the slot the calendar already shows is confirm-only (no write)', () => {
    const visit = { ...VISIT, scheduled_date: '2026-10-06', window_start: '10:00:00', window_end: '12:00:00' };
    const offer = { ...OFFER, visit_snapshot: { ...OFFER.visit_snapshot, date: '2026-10-06', start: '10:00', end: '12:00' } };
    expect(evaluate({ offer, visit, visitAfter: visit }).outcome).toBe('confirm_only');
  });

  test('a grounded decline or asks-other-time takes no action; unclear goes to staff', () => {
    expect(evaluate({ inboundBody: 'Sorry, none of those work', decision: { ...accept(0, 'none of those work'), action: 'decline' } }).outcome).toBe('no_action');
    expect(evaluate({ inboundBody: 'How about Friday instead?', decision: { ...accept(0, 'how about Friday'), action: 'asks_other_time' } }).outcome).toBe('no_action');
    expect(evaluate({ decision: { ...accept(0, ''), action: 'unclear' } })).toMatchObject({ outcome: 'staff', refusals: ['unclear'] });
  });

  test('a decline is grounded like an accept: invented words, low confidence or a stranger refuse it to staff', () => {
    const decline = (quote, confidence = 'high') => ({ ...accept(0, quote, confidence), action: 'decline' });
    expect(evaluate({ decision: decline('none work') })).toMatchObject({ outcome: 'staff', refusals: ['quote_not_in_text'] });
    expect(evaluate({ inboundBody: 'none work', decision: decline('none work', 'low') }).refusals).toContain('not_high_confidence');
    expect(evaluate({ inboundBody: 'none work', decision: decline('none work'), fromPhone: '+19415550199' }).refusals).toContain('phone_not_on_file');
  });

  test('a malformed or missing answer is an error row', () => {
    expect(evaluate({ decision: null }).outcome).toBe('error');
  });

  test.each([
    ['slot_out_of_range', { decision: accept(3) }],
    ['quote_not_in_text', { decision: accept(1, 'Monday is perfect') }],
    ['not_high_confidence', { decision: accept(1, 'Tuesday works', 'medium') }],
    ['customer_mismatch', { customer: { ...CUSTOMER, id: 'cust-2' } }],
    ['phone_not_on_file', { fromPhone: '+19415550199' }],
    ['slot_in_past', { now: new Date('2026-10-08T15:00:00Z') }],
    ['visit_missing', { visit: null }],
    ['visit_not_movable', { visit: { ...VISIT, status: 'completed' } }],
    ['grouped_visit', { visit: { ...VISIT, visit_id: 'group-1' } }],
    ['moved_since_offer', { movedSinceOffer: true }],
    ['slot_no_longer_open', { slotStillOpen: { ok: false, reason: 'open_times_no_longer_offered' } }],
    ['visit_changed_since_offer', { offer: { ...OFFER, visit_snapshot: { ...OFFER.visit_snapshot, date: '2026-10-04' } } }],
    ['visit_changed_since_offer', { offer: { ...OFFER, visit_snapshot: { ...OFFER.visit_snapshot, status: 'pending' } } }],
    ['no_pre_send_snapshot', { offer: { ...OFFER, visit_snapshot: null } }],
    ['portal_request_open', { portalRequestOpen: true }],
    ['reminder_offer_pending', { reminderOfferPending: true }],
    ['slot_off_hour', { offer: { ...OFFER, slots: [{ ...SLOTS[0], start: '09:30' }] } }],
    ['ambiguous_slot', { ambiguousSlot: true }],
    // A backfilled offer's snapshot was read after the send: it proves nothing.
    ['no_pre_send_snapshot', { offer: { ...OFFER, visit_snapshot: { ...OFFER.visit_snapshot, pre_send: undefined, post_send: true } } }],
    ['visit_changed_during_decide', { visitAfter: { ...VISIT, scheduled_date: '2026-10-09' } }],
    ['visit_changed_during_decide', { visitAfter: null }],
  ])('%s refuses the accept to staff', (reason, over) => {
    const verdict = evaluate(over);
    expect(verdict.outcome).toBe('staff');
    expect(verdict.refusals).toContain(reason);
  });

  test('a same-day slot whose start has passed (Eastern) is in the past; one still ahead is not', () => {
    // 10:00 ET on Oct 6 = 14:00Z (EDT).
    expect(evaluate({ now: new Date('2026-10-06T15:00:00Z') }).refusals).toContain('slot_in_past');
    expect(evaluate({ now: new Date('2026-10-06T13:30:00Z') }).refusals).not.toContain('slot_in_past');
  });

  test('the quote check ignores case, curly quotes and spacing, never wording', () => {
    expect(evaluate({ inboundBody: 'TUESDAY   works  for us', decision: accept(1, 'tuesday works') }).outcome).toBe('would_move');
    expect(evaluate({ inboundBody: 'We can’t do Tuesday', decision: accept(1, "can't do Tuesday") }).refusals).toEqual([]);
  });

  test('a slot whose date or window could not be read back is refused', () => {
    const offer = { ...OFFER, slots: [{ ...SLOTS[0], date: null }] };
    expect(evaluate({ offer }).refusals).toContain('slot_unresolved');
  });

  test('booking offers would book with their own ids; a legacy offer is never actionable', () => {
    const book = { ...OFFER, kind: 'book_new', scheduled_service_id: null, service_key: 'pest_control' };
    expect(evaluate({ offer: book, visit: null })).toEqual({
      outcome: 'would_book', refusals: [],
      would_have: { kind: 'book_new', estimate_id: null, service_key: 'pest_control', date: '2026-10-06', start: '10:00', arrival_end: '12:00' },
    });
    expect(evaluate({ offer: { ...OFFER, kind: 'unknown' }, visit: null }).refusals).toContain('offer_kind_not_actionable');
  });
});

describe('several open offers', () => {
  const BOOK = { ...OFFER, id: 'offer-2', kind: 'book_new', scheduled_service_id: null, service_key: 'pest_control', visit_snapshot: null,
    slots: [{ date_label: 'Friday, October 9', window_label: '1:00 PM - 3:00 PM', date: '2026-10-09', start: '13:00', end: '15:00' }] };

  test('a time carried by two standing offers is ambiguous; a time on one offer is not', () => {
    const twin = { ...BOOK, id: 'offer-3', slots: [{ ...SLOTS[0] }] };
    const offers = [twin, OFFER];
    expect(decide.slotIsAmbiguous(offers, decide.resolvePick(offers, accept(1)))).toBe(true);
    expect(decide.slotIsAmbiguous(offers, decide.resolvePick(offers, accept(3)))).toBe(false);
  });

  test('an international sender is never decided (its last ten digits could be someone else\'s)', async () => {
    process.env[GATE] = 'true';
    const dbh = jest.fn();
    await expect(decide.runShadowDecision({ customer: CUSTOMER, inboundBody: 'Tuesday works', inboundSmsLogId: 'in-1', fromPhone: '+447700900123', dbh, llm: { dispatch: jest.fn() } }))
      .resolves.toEqual({ recorded: false, reason: 'missing_input' });
    expect(dbh).not.toHaveBeenCalled();
  });

  test('slots are numbered across every open offer and a pick maps back to its own offer', () => {
    const offers = [BOOK, OFFER];
    expect(decide.resolvePick(offers, accept(1)).offer.id).toBe('offer-2');
    expect(decide.resolvePick(offers, accept(3))).toMatchObject({ offer: { id: 'offer-1' }, index: 1 });
    expect(decide.resolvePick(offers, accept(4))).toBeNull();
  });

  test('the text lists every offered time with what it is for, and puts the latest message last', () => {
    const text = decide.buildDecideText({
      offers: [BOOK, OFFER], inboundBody: 'Tuesday works',
      thread: [{ direction: 'outbound', message_body: 'We can do Tuesday or Wednesday.' }, { direction: 'inbound', message_body: 'Need to move it' }],
    });
    expect(text).toContain('1. Friday, October 9, 1:00 PM - 3:00 PM (to book a new visit;');
    expect(text).toContain('2. Tuesday, October 6, 10:00 AM - 12:00 PM (to move their upcoming visit;');
    expect(text).toContain('[Waves] We can do Tuesday or Wednesday.');
    expect(text.trim().endsWith('LATEST CUSTOMER MESSAGE:\nTuesday works')).toBe(true);
  });
});

describe('runShadowDecision', () => {
  test('gate off: nothing is read and no model is called', async () => {
    const dbh = jest.fn();
    const llm = { dispatch: jest.fn() };
    await expect(decide.runShadowDecision({ customer: CUSTOMER, inboundBody: 'Tuesday works', inboundSmsLogId: 'in-1', fromPhone: '+19415550100', dbh, llm }))
      .resolves.toEqual({ recorded: false, reason: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
    expect(llm.dispatch).not.toHaveBeenCalled();
  });

  test('gate on: a phone with no open offer costs one read and no model call', async () => {
    process.env[GATE] = 'true';
    const builder = { where: () => builder, first: async () => ({ id: 'in-1', created_at: NOW, to_phone: '+19415550199' }), orderBy: () => Promise.resolve([]) };
    const dbh = jest.fn(() => builder);
    const llm = { dispatch: jest.fn() };
    await expect(decide.runShadowDecision({ customer: CUSTOMER, inboundBody: 'Tuesday works', inboundSmsLogId: 'in-1', fromPhone: '+19415550100', now: NOW, dbh, llm }))
      .resolves.toEqual({ recorded: false, reason: 'no_open_offer' });
    expect(llm.dispatch).not.toHaveBeenCalled();
  });

  test('gate on: a database error is reported, never thrown', async () => {
    process.env[GATE] = 'true';
    const dbh = jest.fn(() => { throw new Error('connection lost'); });
    await expect(decide.runShadowDecision({ customer: CUSTOMER, inboundBody: 'x', inboundSmsLogId: 'in-1', fromPhone: '+19415550100', dbh, llm: { dispatch: jest.fn() } }))
      .resolves.toEqual({ recorded: false, reason: 'error' });
  });
});

describe('sweepUndecidedReplies', () => {
  test('gate off: nothing is read', async () => {
    const dbh = jest.fn();
    await expect(decide.sweepUndecidedReplies({ dbh })).resolves.toMatchObject({ scanned: 0, reason: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
  });

  test('gate on: each waiting reply is decided, a tapback is skipped, and errors are counted', async () => {
    process.env[GATE] = 'true';
    const rows = [
      { id: 'in-1', from_phone: '+19415550100', message_body: 'Tuesday works' },
      { id: 'in-2', from_phone: '+19415550100', message_body: 'Liked \u201cWe can do Tuesday\u201d' },
      { id: 'in-3', from_phone: '+19415550101', message_body: 'Wednesday please' },
    ];
    const builder = new Proxy({}, {
      get(_, m) {
        if (m === 'then') return (resolve) => resolve(rows);
        return () => builder;
      },
    });
    const dbh = jest.fn(() => builder);
    dbh.raw = jest.fn();
    const run = jest.fn(async ({ inboundSmsLogId }) => (inboundSmsLogId === 'in-3' ? { recorded: false, reason: 'error' } : { recorded: true }));
    await expect(decide.sweepUndecidedReplies({ dbh, run, now: NOW, maxPages: 1 })).resolves.toEqual({ scanned: 3, recorded: 1, errors: 1 });
    expect(run.mock.calls.map((c) => c[0].inboundSmsLogId)).toEqual(['in-1', 'in-3']);
    expect(run.mock.calls[0][0]).toMatchObject({ customer: null, inboundBody: 'Tuesday works', fromPhone: '+19415550100' });
  });
});

describe('the decision schema', () => {
  test('carries no numeric bounds (the Anthropic grammar rejects them) and requires every field', () => {
    expect(JSON.stringify(decide.DECISION_SCHEMA)).not.toMatch(/minimum|maximum/);
    expect(decide.DECISION_SCHEMA.required.sort()).toEqual(Object.keys(decide.DECISION_SCHEMA.properties).sort());
    expect(decide.DECISION_SCHEMA.additionalProperties).toBe(false);
  });
});
