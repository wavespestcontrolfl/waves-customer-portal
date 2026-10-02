/**
 * SMS offer ledger (GATE_SMS_OFFER_LEDGER, dark): what an accepted send
 * records in sms_offers. Pure row-building here; the supersede rule runs
 * against PostgreSQL in sms-offers-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const offers = require('../services/sms-offers');

// The drafter's own label and edit-plan functions, so the test follows the
// formats the live offers are rendered with.
const drafter = {
  schedulerDayLabel: (day) => {
    const [y, m, d] = String(day.date).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  },
  planOpenTimesRecheck: ({ snapshot, outgoingBody }) => {
    const still = snapshot.quotedWindows.filter((w) => String(outgoingBody).includes(w.window));
    return still.length ? { action: 'recheck', quotedWindows: still } : { action: 'skip' };
  },
};

const SENT_AT = new Date('2026-10-02T15:00:00Z'); // Friday, 11 AM Eastern
const VISIT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';

function decision(snapshot, body) {
  return { id: DECISION_ID, customer_id: CUSTOMER_ID, suggested_message: body, input_snapshot: JSON.stringify({ open_times_snapshot: snapshot }) };
}

const TWO_WINDOWS = [
  { date: 'Tuesday, October 6', window: '10:00 AM - 12:00 PM' },
  { date: 'Wednesday, October 7', window: '2:00 PM - 4:00 PM' },
];
const BODY = 'We can do Tuesday, October 6 10:00 AM - 12:00 PM or Wednesday, October 7 2:00 PM - 4:00 PM. Which works?';

describe('label resolution', () => {
  test('a day label resolves to the first matching date on or after the send date', () => {
    expect(offers.isoDateForLabel('Tuesday, October 6', SENT_AT, drafter.schedulerDayLabel)).toBe('2026-10-06');
    // Today counts: an offer for later the same day.
    expect(offers.isoDateForLabel('Friday, October 2', SENT_AT, drafter.schedulerDayLabel)).toBe('2026-10-02');
  });

  test('the send date is read in Eastern time, not UTC', () => {
    // 02:00Z on Oct 3 is still Friday Oct 2 in Florida.
    expect(offers.isoDateForLabel('Friday, October 2', new Date('2026-10-03T02:00:00Z'), drafter.schedulerDayLabel)).toBe('2026-10-02');
  });

  test('a label that names no real day resolves to null', () => {
    expect(offers.isoDateForLabel('Monday, October 6', SENT_AT, drafter.schedulerDayLabel)).toBeNull();
    expect(offers.isoDateForLabel('', SENT_AT, drafter.schedulerDayLabel)).toBeNull();
  });

  test('a window label resolves to its start and end', () => {
    expect(offers.windowForLabel('10:00 AM - 12:00 PM')).toEqual({ start: '10:00', end: '12:00' });
    expect(offers.windowForLabel('2:00 PM - 4:00 PM')).toEqual({ start: '14:00', end: '16:00' });
    expect(offers.windowForLabel('10 to noon')).toBeNull();
  });
});

describe('buildOfferRow', () => {
  test('a visit offer records the visit and every slot the sent text carried', () => {
    const snapshot = { lookup: { source: 'scheduler', scheduledServiceId: VISIT_ID, customerId: CUSTOMER_ID, city: 'Bradenton' }, quotedWindows: TWO_WINDOWS };
    const { row } = offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: BODY, providerMessageId: 'SM1', to: '+1 (941) 555-0100', sentAt: SENT_AT, drafter });
    expect(row).toMatchObject({
      agent_decision_id: DECISION_ID, provider_message_id: 'SM1', customer_id: CUSTOMER_ID, phone_last10: '9415550100',
      kind: 'move_visit', scheduled_service_id: VISIT_ID, estimate_id: null, service_key: null, status: 'open',
    });
    expect(JSON.parse(row.slots)).toEqual([
      { date_label: 'Tuesday, October 6', window_label: '10:00 AM - 12:00 PM', date: '2026-10-06', start: '10:00', end: '12:00' },
      { date_label: 'Wednesday, October 7', window_label: '2:00 PM - 4:00 PM', date: '2026-10-07', start: '14:00', end: '16:00' },
    ]);
    expect(row.expires_at.getTime() - row.sent_at.getTime()).toBe(offers.OFFER_TTL_HOURS * 3600000);
  });

  test('only the slots still in the sent text are recorded', () => {
    const snapshot = { lookup: { source: 'scheduler', scheduledServiceId: VISIT_ID, customerId: CUSTOMER_ID }, quotedWindows: TWO_WINDOWS };
    const trimmed = 'We can do Tuesday, October 6 10:00 AM - 12:00 PM. Does that work?';
    const { row } = offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: trimmed, to: '9415550100', sentAt: SENT_AT, drafter });
    expect(JSON.parse(row.slots)).toHaveLength(1);
    expect(JSON.parse(row.slots)[0].date).toBe('2026-10-06');
  });

  test('estimate and new-visit offers carry their own job identity, never a visit id', () => {
    const estimate = { lookup: { source: 'estimate', estimateId: 'e-1', customerId: CUSTOMER_ID }, quotedWindows: TWO_WINDOWS };
    expect(offers.buildOfferRow({ decision: decision(estimate, BODY), outgoingBody: BODY, to: '9415550100', sentAt: SENT_AT, drafter }).row)
      .toMatchObject({ kind: 'book_estimate', estimate_id: 'e-1', scheduled_service_id: null, service_key: null });
    const book = { lookup: { source: 'book', serviceKey: 'pest_control', customerId: CUSTOMER_ID }, quotedWindows: TWO_WINDOWS };
    expect(offers.buildOfferRow({ decision: decision(book, BODY), outgoingBody: BODY, to: '9415550100', sentAt: SENT_AT, drafter }).row)
      .toMatchObject({ kind: 'book_new', service_key: 'pest_control', scheduled_service_id: null });
  });

  test('a snapshot from before the scheduler-backed offers is counted as unknown', () => {
    const legacy = { lookup: { city: 'Bradenton', customerId: CUSTOMER_ID }, quotedWindows: TWO_WINDOWS };
    expect(offers.buildOfferRow({ decision: decision(legacy, BODY), outgoingBody: BODY, to: '9415550100', sentAt: SENT_AT, drafter }).row.kind).toBe('unknown');
  });

  test('a slot whose label cannot be read back is kept with null date and time', () => {
    const snapshot = { lookup: { source: 'scheduler', scheduledServiceId: VISIT_ID }, quotedWindows: [{ date: 'Someday soon', window: 'mid-morning' }] };
    const body = 'How about Someday soon mid-morning?';
    const { row } = offers.buildOfferRow({ decision: decision(snapshot, body), outgoingBody: body, to: '9415550100', sentAt: SENT_AT, drafter });
    expect(JSON.parse(row.slots)).toEqual([{ date_label: 'Someday soon', window_label: 'mid-morning', date: null, start: null, end: null }]);
  });

  test('nothing is recorded without an offer, a phone, or a quoted time in the sent text', () => {
    const snapshot = { lookup: { source: 'scheduler', scheduledServiceId: VISIT_ID }, quotedWindows: TWO_WINDOWS };
    expect(offers.buildOfferRow({ decision: { id: DECISION_ID, input_snapshot: null }, outgoingBody: BODY, to: '9415550100', drafter })).toEqual({ skip: 'no_offer_snapshot' });
    expect(offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: BODY, to: '555', drafter })).toEqual({ skip: 'no_phone' });
    expect(offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: 'Thanks, talk soon.', to: '9415550100', drafter })).toEqual({ skip: 'no_offer_in_sent_text' });
    const refusing = { ...drafter, planOpenTimesRecheck: () => ({ action: 'refuse', reason: 'edited_offer_text' }) };
    expect(offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: BODY, to: '9415550100', drafter: refusing })).toEqual({ skip: 'offer_text_unverifiable' });
  });
});

describe('with the drafter\'s real label and edit-plan functions', () => {
  const real = jest.requireActual('../services/sms-shadow-drafter');

  test('the exported day label is the one offers are rendered with', () => {
    expect(real.schedulerDayLabel({ date: '2026-10-06' })).toBe('Tuesday, October 6');
  });

  test('an unedited reply records its slots; a reviewer edit that rewrites the time records nothing', () => {
    const snapshot = { lookup: { source: 'scheduler', scheduledServiceId: VISIT_ID, customerId: CUSTOMER_ID }, quotedWindows: TWO_WINDOWS };
    const { row } = offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: BODY, to: '9415550100', sentAt: SENT_AT });
    expect(JSON.parse(row.slots).map((s) => `${s.date} ${s.start}`)).toEqual(['2026-10-06 10:00', '2026-10-07 14:00']);
    const rewritten = 'We can do Tuesday 10-12 or Wednesday 2-4. Which works?';
    expect(offers.buildOfferRow({ decision: decision(snapshot, BODY), outgoingBody: rewritten, to: '9415550100', sentAt: SENT_AT }).skip).toBeDefined();
  });
});

describe('recordOfferForSend', () => {
  const GATE = 'GATE_SMS_OFFER_LEDGER';
  afterEach(() => { delete process.env[GATE]; });

  test('gate off: nothing is read or written', async () => {
    const dbh = jest.fn();
    await expect(offers.recordOfferForSend({ agentDecisionId: DECISION_ID, outgoingBody: BODY, to: '9415550100', dbh })).resolves.toEqual({ recorded: false, reason: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
  });

  test('gate on: a database error is reported, never thrown', async () => {
    process.env[GATE] = 'true';
    const dbh = jest.fn(() => { throw new Error('connection lost'); });
    await expect(offers.recordOfferForSend({ agentDecisionId: DECISION_ID, outgoingBody: BODY, to: '9415550100', dbh })).resolves.toEqual({ recorded: false, reason: 'error' });
  });

  test('gate on: the warning carries the error code, never the message (a Knex error embeds the phone)', async () => {
    process.env[GATE] = 'true';
    const warn = jest.spyOn(require('../services/logger'), 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('insert into sms_offers values (9415550100)'), { code: '23505' });
    const dbh = jest.fn(() => { throw err; });
    await offers.recordOfferForSend({ agentDecisionId: DECISION_ID, outgoingBody: BODY, to: '9415550100', dbh });
    const logged = warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('23505');
    expect(logged).not.toContain('9415550100');
    warn.mockRestore();
  });

  test('backfill, gate off: the database is never touched', async () => {
    const dbh = jest.fn();
    await expect(offers.backfillMissedOffers({ dbh })).resolves.toMatchObject({ recorded: 0, reason: 'gate_off' });
    expect(dbh).not.toHaveBeenCalled();
  });

  test('backfill, gate on: a failed scan is reported, never thrown', async () => {
    process.env[GATE] = 'true';
    const dbh = jest.fn(() => { throw new Error('connection lost'); });
    dbh.raw = jest.fn();
    await expect(offers.backfillMissedOffers({ dbh })).resolves.toMatchObject({ recorded: 0, reason: 'error' });
  });

  test('gate on: a send with no decision records nothing', async () => {
    process.env[GATE] = 'true';
    const dbh = jest.fn();
    await expect(offers.recordOfferForSend({ outgoingBody: BODY, to: '9415550100', dbh })).resolves.toEqual({ recorded: false, reason: 'no_decision' });
    expect(dbh).not.toHaveBeenCalled();
  });
});
