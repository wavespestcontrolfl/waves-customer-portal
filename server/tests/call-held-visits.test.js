// Held visits (owner 2026-10-12): a visit promised to a caller on a recorded
// call with nothing booked shows on Dispatch as a display-only HELD row. These
// tests pin the pure selection (both kinds, every clearing rule, the day-only
// exclusions) and the gate-off no-op. All identities are synthetic.
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
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
  describe('a reschedule with no visit on file', () => {
    const moved = (sched = {}) => extraction({
      scheduling: {
        status: 'reschedule_requested', confirmed_start_at: `${DAY}T12:00:00-04:00`,
        agent_committed_booking: true, caller_accepted_slot: true, ...sched,
      },
    });
    const movedCall = (over = {}, sched = {}) => call({ customer_id: 'cust-1', ai_extraction_enriched: moved(sched), ...over });

    it('holds the agreed slot as a confirmed row when the customer has no visit', () => {
      const [row] = run([movedCall()]);
      expect(row).toMatchObject({ kind: 'confirmed', minutes: 720, time_label: '12:00 PM', customer_id: 'cust-1' });
    });

    it('does not hold it when the customer has a visit the call could be moving', () => {
      expect(run([movedCall()], [visit({ sched_date: '2026-10-20' })])).toHaveLength(0);
      expect(run([movedCall()], [visit({ sched_date: '2026-10-13', status: 'rescheduled' })])).toHaveLength(0);
      expect(run([movedCall()], [visit({ sched_date: '2026-10-12', status: 'completed' })])).toHaveLength(0);
    });

    it('ignores a visit before the call day, a cancelled visit and another customer\'s visit', () => {
      const rows = [
        visit({ sched_date: '2026-10-09', status: 'completed' }),
        visit({ sched_date: '2026-10-16', status: 'cancelled' }),
        visit({ sched_date: '2026-10-16', customer_id: 'cust-2' }),
      ];
      expect(run([movedCall()], rows)).toHaveLength(1);
    });

    it('clears once the slot is booked', () => {
      expect(run([movedCall()], [visit({ window_start: '12:00:00' })])).toHaveLength(0);
      expect(run([movedCall()], [visit({ customer_id: 'cust-7', sched_date: '2026-10-15', internal_notes: 'Call ID: call-1.' })])).toHaveLength(0);
    });

    it('needs a linked customer, the staff commitment and the caller\'s acceptance', () => {
      expect(run([movedCall({ customer_id: null })])).toHaveLength(0);
      expect(run([movedCall({}, { agent_committed_booking: false })])).toHaveLength(0);
      expect(run([movedCall({}, { agent_committed_booking: false, definite_commitment: true })])).toHaveLength(0);
      expect(run([movedCall({}, { agent_committed_booking: null })])).toHaveLength(0);
      // The firm-promise judgement stands in when the commitment flag is absent.
      expect(run([movedCall({}, { agent_committed_booking: undefined, definite_commitment: true })])).toHaveLength(1);
      expect(run([movedCall({}, { caller_accepted_slot: null })])).toHaveLength(0);
      expect(run([movedCall({}, { confirmed_start_at: null })])).toHaveLength(0);
    });
  });

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

// Owner 2026-10-19, call audit 2026-10-19: staff and an existing customer agreed to MOVE a visit
// to a new day with no time. The visit stays put; the strip shows a display-only row on the TARGET
// day. The shape below is the stored extraction of that call (synthetic identities).
describe('a move to a day with no time (move_day_only)', () => {
  const FROM = '2026-11-06';
  const moveSched = (sched = {}) => ({
    status: 'reschedule_requested', moved_appointment_date: FROM,
    requested_date_range_start: DAY, requested_date_range_end: DAY, preferred_time_of_day: 'unspecified',
    agent_committed_booking: true, caller_accepted_slot: true, ...sched,
  });
  const moveCall = (over = {}, sched = {}, ext = {}) => call({
    id: 'call-mv', twilio_call_sid: 'CAmove001', customer_id: 'cust-1', ai_extraction_enriched: extraction({ scheduling: moveSched(sched), ...ext }), ...over,
  });
  const oldVisit = (over = {}) => visit({ id: 'visit-old', sched_date: FROM, window_start: '09:00:00', ...over });

  it('holds the move on the target day, linked to the visit on the old day, with no time', () => {
    const [row] = run([moveCall()], [oldVisit()], [], { customerNames: new Map([['cust-1', 'Pat Sample']]) });
    expect(row).toMatchObject({
      call_log_id: 'call-mv', kind: 'move_day_only', date_et: DAY, minutes: null, time_label: null, daypart: null,
      customer_id: 'cust-1', caller_name: 'Pat Sample', from_date_et: FROM, from_visit_id: 'visit-old',
    });
  });

  it('a timed reschedule with unset commitment flags is never a "time not set" move (Codex #6345 r1)', () => {
    const sched = { agent_committed_booking: null, caller_accepted_slot: null };
    expect(run([moveCall({}, { ...sched, confirmed_start_at: '2026-10-14T14:00:00Z' })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, { ...sched, proposed_start_at: '2026-10-14T14:00:00Z' })], [oldVisit()])).toEqual([]);
  });

  it('a completed or on-site old-day visit clears the move (Codex #6345 r1)', () => {
    expect(run([moveCall()], [oldVisit({ status: 'completed' })])).toEqual([]);
    expect(run([moveCall()], [oldVisit({ status: 'on_site' })])).toEqual([]);
  });

  it('two movable visits on the old day keep the row but link to the day, not a visit (Codex #6345 r1)', () => {
    const [row] = run([moveCall()], [oldVisit(), oldVisit({ id: 'visit-old-2', window_start: '13:00:00' })]);
    expect(row).toMatchObject({ kind: 'move_day_only', from_date_et: FROM, from_visit_id: null });
  });

  it('is not held on the old day or any other day', () => {
    expect(run([moveCall()], [oldVisit()], [], { dateET: FROM })).toEqual([]);
    expect(run([moveCall()], [oldVisit()], [], { dateET: '2026-10-15' })).toEqual([]);
  });

  it('needs a linked customer, and no explicit refusal: unset commitment fields pass, a stated "no" does not', () => {
    expect(run([moveCall({ customer_id: null })], [oldVisit()])).toEqual([]);
    // The call-195c40dd shape: the extractor left all three commitment fields null (no time slot).
    const nulls = { agent_committed_booking: null, definite_commitment: null, caller_accepted_slot: null };
    expect(run([moveCall({}, nulls)], [oldVisit()])).toHaveLength(1);
    const missing = { agent_committed_booking: undefined, definite_commitment: undefined, caller_accepted_slot: undefined };
    expect(run([moveCall({}, missing)], [oldVisit()])).toHaveLength(1);
    expect(run([moveCall({}, { ...nulls, agent_committed_booking: false })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, { ...nulls, caller_accepted_slot: false })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, { agent_committed_booking: false, definite_commitment: true })], [oldVisit()])).toEqual([]);
  });

  it('leaves the timed move on the strict rule: a null commitment is still no confirmed row', () => {
    const timed = extraction({ scheduling: { status: 'reschedule_requested', confirmed_start_at: `${DAY}T12:00:00-04:00` } });
    expect(run([call({ customer_id: 'cust-1', ai_extraction_enriched: timed })])).toEqual([]);
  });

  it('needs a reschedule_requested status, a one-day range on the target day and a valid old day', () => {
    expect(run([moveCall({}, { status: 'none' })], [oldVisit()])).toEqual([]);
    // A plain request is the existing day_only row, never a move.
    expect(run([moveCall({}, { status: 'requested' })], [oldVisit()]).map((r) => r.kind)).toEqual(['day_only']);
    expect(run([moveCall({}, { requested_date_range_end: '2026-10-16' })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, { moved_appointment_date: null })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, { moved_appointment_date: 'next Friday' })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, { moved_appointment_date: DAY })], [oldVisit({ sched_date: DAY })])).toEqual([]);
  });

  it('never holds a voicemail, spam, an unprocessed call or a dropped disposition', () => {
    expect(run([moveCall({ processing_status: 'voicemail' })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({ answered_by: 'voicemail' })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, {}, { spam_verdict: { spam_kind: 'robocall' } })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, {}, { meta: { is_voicemail: true } })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({ processing_status: 'received' })], [oldVisit()])).toEqual([]);
    expect(run([moveCall({}, {}, { recommended_disposition: 'spam_discarded' })], [oldVisit()])).toEqual([]);
  });

  it('does not hold a move onto a day that has passed', () => {
    const later = new Date('2026-10-15T16:00:00Z');
    expect(run([moveCall()], [oldVisit()], [], { now: later })).toEqual([]);
    // Today (ET) is still held.
    expect(run([moveCall()], [oldVisit()], [], { now: new Date('2026-10-14T20:00:00Z') })).toHaveLength(1);
  });

  it('is not held when the call also carries a timed slot (that is a confirmed row, or a reschedule card)', () => {
    const timedToo = moveCall({}, { confirmed_start_at: `${DAY}T12:00:00-04:00` });
    const rows = run([timedToo], [oldVisit()]);
    expect(rows).toEqual([]);
  });

  describe('clears', () => {
    it('when the visit on the old day is gone: moved, cancelled, rescheduled or missing', () => {
      expect(run([moveCall()], [])).toEqual([]);
      expect(run([moveCall()], [oldVisit({ status: 'cancelled' })])).toEqual([]);
      expect(run([moveCall()], [oldVisit({ status: 'rescheduled' })])).toEqual([]);
      expect(run([moveCall()], [oldVisit({ status: 'skipped' })])).toEqual([]);
      expect(run([moveCall()], [oldVisit({ sched_date: '2026-11-13' })])).toEqual([]);
    });

    it('does not count another customer\'s visit on the old day as the visit to move', () => {
      expect(run([moveCall()], [oldVisit({ customer_id: 'cust-2' })])).toEqual([]);
    });

    it('holds with a legacy visit that has no status, and with several visits on the old day', () => {
      expect(run([moveCall()], [oldVisit({ status: null })])).toHaveLength(1);
      const [row] = run([moveCall()], [oldVisit({ id: 'visit-pm', window_start: '14:00:00' }), oldVisit({ id: 'visit-am', window_start: '08:00:00' })]);
      expect(row.from_visit_id).toBeNull(); // ambiguous: the row links to the old day
    });

    it('when the customer has a live visit on the target day, at any time', () => {
      expect(run([moveCall()], [oldVisit(), visit({ id: 'visit-new', sched_date: DAY, window_start: '15:00:00' })])).toEqual([]);
      expect(run([moveCall()], [oldVisit(), visit({ id: 'visit-new', sched_date: DAY, status: 'confirmed' })])).toEqual([]);
    });

    it('keeps the row when the target-day visit is cancelled, rescheduled or another customer\'s', () => {
      expect(run([moveCall()], [oldVisit(), visit({ sched_date: DAY, status: 'cancelled' })])).toHaveLength(1);
      expect(run([moveCall()], [oldVisit(), visit({ sched_date: DAY, status: 'rescheduled' })])).toHaveLength(1);
      expect(run([moveCall()], [oldVisit(), visit({ sched_date: DAY, customer_id: 'cust-2' })])).toHaveLength(1);
    });

    it('when the office closed the call, not while a card is open or closed by the system', () => {
      const closed = [{ call_log_id: 'call-mv', status: 'dismissed', resolution_source: 'human' }];
      expect(run([moveCall()], [oldVisit()], closed)).toEqual([]);
      expect(run([moveCall()], [oldVisit()], [...closed, { call_log_id: 'call-mv', status: 'open', resolution_source: null }])).toHaveLength(1);
      expect(run([moveCall()], [oldVisit()], [{ call_log_id: 'call-mv', status: 'resolved', resolution_source: 'auto' }])).toHaveLength(1);
    });

    it('when a visit carries the call', () => {
      expect(run([moveCall()], [oldVisit(), visit({ customer_id: 'cust-9', sched_date: '2026-10-20', internal_notes: 'Call ID: call-mv.' })])).toEqual([]);
    });
  });

  it('reads an extraction stored as a JSON string', () => {
    const stored = JSON.stringify(extraction({ scheduling: moveSched() }));
    expect(run([moveCall({ ai_extraction_enriched: stored })], [oldVisit()])).toHaveLength(1);
  });
});

// The database read behind a day-only move: the customer's old-day visit has to be fetched
// (with its id) beside the target-day visits, or the row could never find its visit to move.
describe('listHeldVisits reads the old day of a move', () => {
  afterEach(() => { isEnabled.mockReturnValue(false); db.mockReset(); });

  function builder(rows, log) {
    const qb = {};
    ['where', 'whereRaw', 'whereNotNull', 'select', 'whereIn', 'orWhere', 'orWhereRaw'].forEach((m) => {
      qb[m] = jest.fn((...args) => {
        log.push([m, ...args.filter((a) => typeof a !== 'function')]);
        // Run a grouped where / orWhere callback against the same recorder.
        args.filter((a) => typeof a === 'function').forEach((fn) => fn.call(qb));
        return qb;
      });
    });
    qb.modify = jest.fn((fn) => { fn(qb); return qb; });
    qb.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return qb;
  }

  it('selects the visit id and asks for the customer\'s visits on the old day', async () => {
    isEnabled.mockReturnValue(true);
    const FROM = '2026-11-06';
    const moveCall = call({
      id: 'call-mv', customer_id: 'cust-1',
      ai_extraction_enriched: extraction({ scheduling: {
        status: 'reschedule_requested', moved_appointment_date: FROM, requested_date_range_start: DAY, requested_date_range_end: DAY,
        agent_committed_booking: true, caller_accepted_slot: true,
      } }),
    });
    const logs = { call_log: [], scheduled_services: [] };
    const tables = {
      call_log: [moveCall],
      scheduled_services: [visit({ id: 'visit-old', sched_date: FROM })],
      triage_items: [],
      customers: [{ id: 'cust-1', first_name: 'Pat', last_name: 'Sample' }],
    };
    db.mockImplementation((table) => builder(tables[table], logs[table] || []));
    db.raw = jest.fn((sql) => sql);

    const rows = await listHeldVisits(DAY, { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'move_day_only', from_date_et: FROM, from_visit_id: 'visit-old', caller_name: 'Pat Sample' });
    // The sandbox-call filter stays on the call read.
    expect(logs.call_log.some(([m, sql]) => m === 'whereRaw' && /<> \?/.test(sql) && /COALESCE/.test(sql))).toBe(true);
    const sched = logs.scheduled_services;
    expect(sched.find(([m, col]) => m === 'select' && col === 'id')).toBeTruthy();
    expect(sched.some(([m, sql, binds]) => m === 'whereRaw' && /= ANY\(\?\)/.test(sql) && JSON.stringify(binds) === JSON.stringify([[FROM]]))).toBe(true);
  });
});
