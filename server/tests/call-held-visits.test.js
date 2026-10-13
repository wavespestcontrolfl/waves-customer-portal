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
  customer_id: 'cust-1', status: 'pending', sched_date: DAY, window_start: '11:00:00',
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

  it.each(['spam_discarded', 'wrong_number_closed', 'vendor_logged'])('never holds disposition %s', (disposition) => {
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

  it('clears when the call\'s customer has a live visit that day (a confirmed slot: near the agreed time)', () => {
    const linked = call({ customer_id: 'cust-1' });
    expect(run([linked], [visit({ window_start: '11:00:00' })])).toEqual([]);
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

  it('does not clear a day-only row on a visit on another date (a recurring visit generated after the call)', () => {
    const linked = call({ customer_id: 'cust-1', ai_extraction_enriched: dayOnly() });
    expect(run([linked], [visit({ sched_date: '2026-10-20', created_at: '2026-10-12T15:00:00Z' })])).toHaveLength(1);
    expect(run([linked], [visit({ created_at: '2026-10-01T15:00:00Z' })])).toEqual([]); // the promised day itself
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

describe('the call marker', () => {
  it('clears on "Call ID: <call_log id>" in internal notes ("Book it" prefills it), under any customer and date', () => {
    const booked = visit({ customer_id: 'cust-household', internal_notes: 'Booked from a phone call. Call ID: call-1.', sched_date: '2026-10-20' });
    expect(run([call()], [booked])).toEqual([]);
    expect(run([call({ ai_extraction_enriched: dayOnly() })], [booked])).toEqual([]);
    // A call row with no Twilio SID still clears on its id.
    expect(run([call({ twilio_call_sid: null })], [booked])).toEqual([]);
    expect(run([call()], [visit({ customer_id: 'cust-household', internal_notes: 'Call ID: call-2.' })])).toHaveLength(1);
  });

  it('still clears on the pipeline SID marker, in either notes column', () => {
    expect(run([call()], [visit({ customer_id: 'cust-x', internal_notes: 'Call SID: CAsynthetic001.', sched_date: '2026-10-20' })])).toEqual([]);
    expect(run([call()], [visit({ customer_id: 'cust-x', notes: 'Call SID: CAsynthetic001.', sched_date: '2026-10-20' })])).toEqual([]);
  });

  it('nothing is inferred from a shared phone number or a matching address', () => {
    const lookalike = visit({ customer_id: 'cust-other', customer_phone: '+19415550100', visit_address: '12 Test Lane', visit_city: 'Bradenton', visit_zip: '34205' });
    expect(run([call()], [lookalike])).toHaveLength(1);
    expect(run([call({ ai_extraction_enriched: dayOnly() })], [lookalike])).toHaveLength(1);
  });
});

describe('only a real conversation holds a visit', () => {
  it.each([
    ['a voicemail row', { processing_status: 'voicemail' }],
    ['a spam row', { processing_status: 'spam' }],
    ['a voicemail lead', { processing_status: 'processed', answered_by: 'voicemail' }],
  ])('never holds a CONFIRMED slot from %s', (_name, over) => {
    expect(run([call(over)])).toEqual([]);
  });

  it('never holds a confirmed slot the extraction marks as voicemail or spam', () => {
    expect(run([call({ ai_extraction_enriched: extraction({ meta: { is_voicemail: true } }) })])).toEqual([]);
    expect(run([call({ ai_extraction_enriched: extraction({ spam_verdict: { spam_kind: 'solicitation' } }) })])).toEqual([]);
  });

  it('keeps a confirmed slot on a call whose customer or lead creation failed', () => {
    expect(run([call({ processing_status: 'customer_creation_failed' })])).toHaveLength(1);
  });
});

describe('a confirmed promise has a time', () => {
  it('an unrelated same-day visit outside the window tolerance does not clear it', () => {
    const linked = call({ customer_id: 'cust-1' }); // agreed 11:00 AM
    expect(run([linked], [visit({ window_start: '15:00:00' })])).toHaveLength(1);
    expect(run([linked], [visit({ window_start: '12:00:00' })])).toEqual([]);
  });

  it('a day-only ask is answered by any live visit that day', () => {
    const linked = call({ customer_id: 'cust-1', ai_extraction_enriched: dayOnly() });
    expect(run([linked], [visit({ window_start: '15:00:00' })])).toEqual([]);
  });
});

describe('legacy rows', () => {
  it('a visit with no status is an open visit and clears the row', () => {
    expect(run([call({ customer_id: 'cust-1' })], [visit({ status: null })])).toEqual([]);
  });

  it('a skipped visit is not a booking', () => {
    expect(run([call({ customer_id: 'cust-1' })], [visit({ status: 'skipped' })])).toHaveLength(1);
  });
});

describe('a one-day request stored without a range end', () => {
  it('is a day-only ask for that day; a longer range is not', () => {
    const oneDay = (end) => call({ ai_extraction_enriched: dayOnly({}, { requested_date_range_end: end }) });
    expect(run([oneDay(null)])).toHaveLength(1);
    expect(run([oneDay(undefined)])).toHaveLength(1);
    expect(run([oneDay('2026-10-16')])).toEqual([]);
  });
});

describe('a no_action_needed disposition does not hide an open request', () => {
  const noAction = (over = {}, sched = {}) => call({ ai_extraction_enriched: dayOnly({ recommended_disposition: 'no_action_needed', ...over }, sched) });

  it('a requested visit the caller did not drop is still held', () => {
    expect(run([noAction()])).toHaveLength(1);
  });

  it('a requested visit the caller dropped is not: declined price, or no appointment needed', () => {
    expect(run([noAction({ service_request: { price: { caller_response: 'declined' } } })])).toEqual([]);
    expect(run([noAction({ service_request: { urgency: 'no_appointment_needed' } })])).toEqual([]);
  });

  it('spam, wrong-number and vendor dispositions are never held', () => {
    for (const d of ['spam_discarded', 'wrong_number_closed', 'vendor_logged']) {
      expect(run([call({ ai_extraction_enriched: dayOnly({ recommended_disposition: d }) })])).toEqual([]);
    }
  });
});

describe('the requested part of the day', () => {
  it('rides on the row; "any" or a missing value is no preference', () => {
    const row = (sched) => run([call({ ai_extraction_enriched: dayOnly({}, sched) })])[0];
    expect(row({ preferred_time_of_day: 'morning' }).daypart).toBe('morning');
    expect(row({ preferred_time_of_day: 'any' }).daypart).toBeNull();
    expect(row({}).daypart).toBeNull();
  });
});

describe('the stated unit', () => {
  it('rides on the row address', () => {
    const [row] = run([call({ ai_extraction_enriched: dayOnly({ property: { service_address: { street_line_1: '40 Sample Rd', street_line_2: 'Unit 4', city: 'Bradenton', postal_code: '34205' } } }) })]);
    expect(row.address).toEqual({ line1: '40 Sample Rd', line2: 'Unit 4', city: 'Bradenton', zip: '34205' });
  });
});
