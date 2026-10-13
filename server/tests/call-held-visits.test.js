// Held visits (owner 2026-10-12): a visit promised to a caller on a recorded
// call with nothing booked shows on Dispatch as a display-only HELD row. These
// tests pin the pure selection (both kinds, every clearing rule, the day-only
// exclusions) and the gate-off no-op. All identities are synthetic.
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const db = require('../models/db');
const { computeHeldVisits, listHeldVisits } = require('../services/call-held-visits');

const NOW = new Date('2026-10-12T16:00:00Z');
const CALL_AT = '2026-10-12T14:30:00Z'; // Oct 12, 10:30 AM ET
const DAY = '2026-10-14';

function extraction(over = {}) {
  return {
    caller: { name_full: 'Pat Sample', first_name: 'Pat', last_name: 'Sample' },
    property: { service_address: { street_line_1: '12 Test Lane', city: 'Bradenton', postal_code: '34205' } },
    service_request: { specific_service_name: 'General Pest Control' },
    scheduling: { status: 'confirmed', confirmed_start_at: `${DAY}T11:00:00-04:00`, scheduling_notes_raw: 'Gate is open.' },
    ...over,
  };
}
const dayOnly = (over = {}, sched = {}) => extraction({
  scheduling: {
    status: 'requested', requested_date_range_start: DAY, requested_date_range_end: DAY, ...sched,
  },
  ...over,
});

function call(over = {}) {
  return {
    id: 'call-1', twilio_call_sid: 'CAsynthetic001', customer_id: null, direction: 'inbound',
    created_at: CALL_AT, from_phone: '+19415550100', to_phone: '+19415550111',
    processing_status: 'processed', v2_extraction_status: 'valid',
    ai_extraction_enriched: extraction(), ...over,
  };
}
const visit = (over = {}) => ({
  customer_id: 'cust-1', status: 'scheduled', sched_date: DAY, window_start: '11:00:00',
  created_at: '2026-10-12T15:00:00Z', source_call_log_id: null, notes: '', ...over,
});
const run = (calls, booked = [], triage = [], opts = {}) => computeHeldVisits(calls, booked, triage, { dateET: DAY, now: NOW, ...opts });

describe('which calls are held', () => {
  it('holds a confirmed slot with no visit, with its time and display fields', () => {
    const [row] = run([call()]);
    expect(row).toMatchObject({
      call_log_id: 'call-1', kind: 'confirmed', date_et: DAY, minutes: 660, time_label: '11:00 AM',
      caller_name: 'Pat Sample', phone: '+19415550100', service: 'General Pest Control', customer_id: null,
      address: { line1: '12 Test Lane', city: 'Bradenton', zip: '34205' }, notes: 'Gate is open.',
      call_at: '2026-10-12T14:30:00.000Z',
    });
  });

  it('holds a day-only request with no time', () => {
    const [row] = run([call({ ai_extraction_enriched: dayOnly() })]);
    expect(row).toMatchObject({ kind: 'day_only', minutes: null, time_label: null });
  });

  it('reads an extraction stored as a JSON string', () => {
    expect(run([call({ ai_extraction_enriched: JSON.stringify(extraction()) })])).toHaveLength(1);
    expect(run([call({ ai_extraction_enriched: JSON.stringify(dayOnly()) })])[0].kind).toBe('day_only');
  });

  it('uses to_phone on an outbound call, the linked customer name, and cuts notes at 200 characters', () => {
    const [row] = run(
      [call({ direction: 'outbound', customer_id: 'cust-9', ai_extraction_enriched: extraction({ scheduling: { status: 'confirmed', confirmed_start_at: `${DAY}T09:30:00-04:00`, scheduling_notes_raw: 'x'.repeat(300) } }) })],
      [], [], { customerNames: new Map([['cust-9', 'Lee Linked']]) },
    );
    expect(row.phone).toBe('+19415550111');
    expect(row.caller_name).toBe('Lee Linked');
    expect(row.notes).toHaveLength(200);
    expect(row.time_label).toBe('9:30 AM');
  });

  it('names an unnamed caller Unknown caller', () => {
    expect(run([call({ ai_extraction_enriched: extraction({ caller: {} }) })])[0].caller_name).toBe('Unknown caller');
  });

  it('ignores another date, an unreadable extraction, an invalid or in-flight call, and calls older than 30 days', () => {
    expect(run([call({ ai_extraction_enriched: extraction({ scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-15T11:00:00-04:00' } }) })])).toEqual([]);
    expect(run([call({ ai_extraction_enriched: 'not json' })])).toEqual([]);
    expect(run([call({ v2_extraction_status: 'invalid' })])).toEqual([]);
    expect(run([call({ processing_status: 'processing' })])).toEqual([]);
    expect(run([call({ processing_status: null })])).toEqual([]);
    expect(run([call({ created_at: '2026-09-01T14:30:00Z' })])).toEqual([]);
  });

  it('gives one confirmed row when a call carries both kinds of evidence', () => {
    const both = extraction({ scheduling: {
      status: 'confirmed', confirmed_start_at: `${DAY}T11:00:00-04:00`, requested_date_range_start: DAY, requested_date_range_end: DAY,
    } });
    const rows = run([call({ ai_extraction_enriched: both })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('confirmed');
  });
});

describe('day-only exclusions', () => {
  it.each([
    ['a voicemail', { processing_status: 'voicemail' }],
    ['a spam row', { processing_status: 'spam' }],
    // A voicemail that became a lead is 'processed': still a one-sided request, not an agreed visit.
    ['a voicemail lead (answered by voicemail)', { processing_status: 'processed', answered_by: 'voicemail' }],
  ])('never holds %s', (_name, over) => {
    expect(run([call({ ...over, ai_extraction_enriched: dayOnly() })])).toEqual([]);
  });

  it('never holds a voicemail the extraction marks as one', () => {
    expect(run([call({ ai_extraction_enriched: dayOnly({ meta: { is_voicemail: true } }) })])).toEqual([]);
  });

  it('never holds a spam verdict, but accepts not_spam', () => {
    expect(run([call({ ai_extraction_enriched: dayOnly({ spam_verdict: { spam_kind: 'robocall' } }) })])).toEqual([]);
    expect(run([call({ ai_extraction_enriched: dayOnly({ spam_verdict: { spam_kind: 'not_spam' } }) })])).toHaveLength(1);
  });

  it.each(['no_action_needed', 'spam_discarded', 'wrong_number_closed', 'vendor_logged'])('never holds disposition %s', (disposition) => {
    expect(run([call({ ai_extraction_enriched: dayOnly({ recommended_disposition: disposition }) })])).toEqual([]);
  });

  it('needs a one-day range equal to the day, in a requested, offered or ambiguous status', () => {
    expect(run([call({ ai_extraction_enriched: dayOnly({}, { requested_date_range_end: '2026-10-16' }) })])).toEqual([]);
    expect(run([call({ ai_extraction_enriched: dayOnly({}, { status: 'none' }) })])).toEqual([]);
    expect(run([call({ ai_extraction_enriched: dayOnly({}, { status: 'ambiguous' }) })])).toHaveLength(1);
    expect(run([call({ ai_extraction_enriched: dayOnly({}, { status: 'offered' }) })])).toHaveLength(1);
  });

  it('does not hold a date before the call\'s own ET day', () => {
    const early = call({ created_at: '2026-10-15T14:00:00Z', ai_extraction_enriched: dayOnly() });
    expect(run([early], [], [], { now: new Date('2026-10-16T00:00:00Z') })).toEqual([]);
    // 02:00Z on Oct 15 is still Oct 14 in ET, so Oct 14 is the call's own day.
    const sameEtDay = call({ created_at: '2026-10-15T02:00:00Z', ai_extraction_enriched: dayOnly() });
    expect(run([sameEtDay], [], [], { now: new Date('2026-10-16T00:00:00Z') })).toHaveLength(1);
  });
});

describe('clearing rules', () => {
  it('clears when a visit carries the call by source_call_log_id, on any date and any customer', () => {
    expect(run([call()], [visit({ customer_id: 'other', sched_date: '2026-11-01', source_call_log_id: 'call-1' })])).toEqual([]);
  });

  it('clears when a visit notes carry the Call SID marker', () => {
    expect(run([call()], [visit({ customer_id: 'other', sched_date: '2026-11-01', notes: 'Call SID: CAsynthetic001' })])).toEqual([]);
  });

  it('clears when the call\'s customer has a live visit that day, at any time', () => {
    const linked = call({ customer_id: 'cust-1' });
    expect(run([linked], [visit({ window_start: '16:00:00' })])).toEqual([]);
    expect(run([call({ customer_id: 'cust-1', ai_extraction_enriched: dayOnly() })], [visit()])).toEqual([]);
  });

  it('keeps the row when that visit is cancelled or rescheduled, on another day, or another customer\'s', () => {
    const linked = call({ customer_id: 'cust-1' });
    expect(run([linked], [visit({ status: 'cancelled' })])).toHaveLength(1);
    expect(run([linked], [visit({ status: 'rescheduled' })])).toHaveLength(1);
    expect(run([linked], [visit({ sched_date: '2026-10-15' })])).toHaveLength(1);
    expect(run([linked], [visit({ customer_id: 'cust-2' })])).toHaveLength(1);
    expect(run([call()], [visit()])).toHaveLength(1); // unlinked call matches no customer
  });

  it('clears a confirmed row through the namesake rule, only for a live visit made after the call', () => {
    const namesakes = new Map([['call-1', new Set(['cust-2'])]]);
    const namesakeVisit = visit({ customer_id: 'cust-2', status: 'confirmed', created_at: '2026-10-12T15:00:00Z' });
    expect(run([call()], [namesakeVisit], [], { namesakes })).toEqual([]);
    expect(run([call()], [{ ...namesakeVisit, created_at: '2026-10-01T15:00:00Z' }], [], { namesakes })).toHaveLength(1);
    expect(run([call()], [namesakeVisit], [], { namesakes: new Map() })).toHaveLength(1);
  });

  it('does not apply the namesake rule to a day-only row', () => {
    const namesakes = new Map([['call-1', new Set(['cust-2'])]]);
    const namesakeVisit = visit({ customer_id: 'cust-2', status: 'confirmed' });
    expect(run([call({ ai_extraction_enriched: dayOnly() })], [namesakeVisit], [], { namesakes })).toHaveLength(1);
  });

  it('clears a day-only row when its customer got any live visit after the call, on any date', () => {
    const linked = call({ customer_id: 'cust-1', ai_extraction_enriched: dayOnly() });
    expect(run([linked], [visit({ sched_date: '2026-10-20', created_at: '2026-10-12T15:00:00Z' })])).toEqual([]);
    expect(run([linked], [visit({ sched_date: '2026-10-20', created_at: '2026-10-01T15:00:00Z' })])).toHaveLength(1);
    expect(run([linked], [visit({ sched_date: '2026-10-20', status: 'cancelled' })])).toHaveLength(1);
  });

  it('does not clear a confirmed row on a later visit on another date', () => {
    expect(run([call({ customer_id: 'cust-1' })], [visit({ sched_date: '2026-10-20' })])).toHaveLength(1);
  });

  it('clears when the office closed the call, not while a card is still open or closed by the system', () => {
    const closed = [{ call_log_id: 'call-1', status: 'dismissed', resolution_source: 'human' }];
    expect(run([call()], [], closed)).toEqual([]);
    expect(run([call()], [], [...closed, { call_log_id: 'call-1', status: 'open', resolution_source: null }])).toHaveLength(1);
    expect(run([call()], [], [{ call_log_id: 'call-1', status: 'resolved', resolution_source: 'auto' }])).toHaveLength(1);
    expect(run([call()], [], [{ call_log_id: 'call-2', status: 'dismissed', resolution_source: 'human' }])).toHaveLength(1);
  });
});

describe('order and gate', () => {
  it('sorts timed rows by time, then day-only rows', () => {
    const at = (id, hhmm) => call({ id, twilio_call_sid: `CA${id}`, ai_extraction_enriched: extraction({ scheduling: { status: 'confirmed', confirmed_start_at: `${DAY}T${hhmm}:00-04:00` } }) });
    const rows = run([
      call({ id: 'c-day', twilio_call_sid: 'CAday', ai_extraction_enriched: dayOnly() }),
      at('c-pm', '14:00'), at('c-am', '08:15'),
    ]);
    expect(rows.map((r) => r.call_log_id)).toEqual(['c-am', 'c-pm', 'c-day']);
  });

  it('listHeldVisits returns an empty list with the gate off and never touches the database', async () => {
    delete process.env.GATE_CALL_HELD_VISIT;
    expect(await listHeldVisits(DAY, { now: NOW })).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });
});

// A visit the office books by hand (or through "Book it") carries no call reference, and an
// unlinked call has no customer to match: the caller's number or the stated address clears it.
describe('a hand booking after the call clears the row', () => {
  const unlinkedDayOnly = () => call({ ai_extraction_enriched: dayOnly() });

  it('clears on a later visit under a customer who carries the caller number, any date', () => {
    const booked = visit({ customer_id: 'cust-new', customer_phone: '(941) 555-0100', sched_date: '2026-10-16' });
    expect(run([unlinkedDayOnly()], [booked])).toEqual([]);
    expect(run([call()], [booked])).toEqual([]); // a confirmed slot too
    expect(run([unlinkedDayOnly()], [visit({ customer_id: 'cust-new', customer_secondary_phone: '+19415550100' })])).toEqual([]);
  });

  it('clears on a later visit at the stated address', () => {
    expect(run([unlinkedDayOnly()], [visit({ customer_id: 'cust-new', visit_address: '12 Test Ln' })])).toEqual([]);
  });

  it('does not clear on another number and address, an older visit, or a cancelled one', () => {
    const other = visit({ customer_id: 'cust-x', customer_phone: '+19415550199', visit_address: '99 Other Road' });
    expect(run([unlinkedDayOnly()], [other])).toHaveLength(1);
    const older = visit({ customer_id: 'cust-new', customer_phone: '+19415550100', created_at: '2026-10-12T14:00:00Z' });
    expect(run([unlinkedDayOnly()], [older])).toHaveLength(1);
    const cancelled = visit({ customer_id: 'cust-new', customer_phone: '+19415550100', status: 'cancelled' });
    expect(run([unlinkedDayOnly()], [cancelled])).toHaveLength(1);
  });

  it('an outbound call matches on the number Waves dialed', () => {
    const outbound = call({ direction: 'outbound-api', ai_extraction_enriched: dayOnly() });
    expect(run([outbound], [visit({ customer_id: 'cust-new', customer_phone: '+19415550111' })])).toEqual([]);
    expect(run([outbound], [visit({ customer_id: 'cust-new', customer_phone: '+19415550100' })])).toHaveLength(1);
  });
});
