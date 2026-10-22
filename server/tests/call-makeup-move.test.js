// Make-up move (GATE_CALL_MAKEUP_MOVE): a recurring visit that was MISSED and
// then agreed to a new time on a call is MOVED, never booked a second time.
// The decision sits at the booking transaction's fresh insert, so the pure
// planner judges the booking's own row; then the booking-transaction check,
// the reprocess check and the move against a mocked connection, and the
// processor wiring (a full processRecording() run cannot be mocked end to
// end, so the steps are tested behaviorally and the hook's position is pinned
// structurally). Fixtures are fictitious (555-01xx numbers, synthetic ids and
// addresses).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-dispatch', () => ({ applySeriesMoveEffects: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((name) => name === 'callAgentCommitTrustedLabels' || actual.isEnabled(name)) };
});

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const {
  planMakeupMoveFromCall: planWithLabelTrust,
  planCallMakeupForBooking,
  priorCallMakeupDecision,
  applyCallMakeupMove,
  MAKEUP_ACTIVITY_ACTION,
  MAKEUP_REASON_CODE,
  INITIATED_BY,
} = require('../services/call-reschedule-apply');
const { lineOfV2Category, linesOfServiceName } = require('../services/call-estimate-service-match');
const AppointmentReminders = require('../services/appointment-reminders');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');

const planMakeup = (args) => planWithLabelTrust({ transcriptLabelsTrusted: true, ...args });

// The incident shape: the call is Saturday Oct 17 2026 3 PM ET; the missed
// visit was Tuesday Oct 13; the agreed slot is Tuesday Oct 20 at 5 PM.
const NOW = new Date('2026-10-17T19:20:00Z');
const CALL_START = new Date('2026-10-17T19:07:24Z');
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const CALL_ID = 'a0000000-0000-4000-8000-000000000001';
const VISIT_ID = '70000000-0000-4000-8000-000000000001';
const LAWN_VISIT_ID = '70000000-0000-4000-8000-000000000002';
const NOSHOW_ID = 'b0000000-0000-4000-8000-000000000001';
const PHONE = '+15555550101';
const ADDRESS = { address_line1: '100 Example Street', city: 'Bradenton', zip: '34205' };
const SLOT = '2026-10-20T17:00:00-04:00';
const AGENT_SLOT = 'We will come by on Tuesday October 20 at 5 PM.';
const ACCEPT = 'Yes, that works.';
const TRANSCRIPT = `Caller: Nobody came on the 13th.\nAgent: No, I need to come by. ${AGENT_SLOT}\nCaller: ${ACCEPT}`;
const WORDS = { day: 'Tuesday October 20', hour: '5', period: 'PM' };

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}

// What the extraction recorded for the incident: confirmed (not
// reschedule_requested), agent_committed_booking null, definite_commitment
// false, a placeholder specific_service_name.
function v2(overrides = {}) {
  const base = {
    meta: { is_spam: false, is_voicemail: false },
    caller: { decision_maker_present: true },
    consent: { do_not_contact_request: false },
    confidence: { scheduling_window: 0.95 },
    call_nature: 'existing_customer_scheduling',
    customer_history: { status: 'current_active' },
    service_request: {
      primary_service_category: 'pest_general',
      specific_service_name: 'Waves Pest Control Appointment Service',
      service_intent: 'follow_up_existing_service',
      secondary_categories: [],
    },
    scheduling: {
      status: 'confirmed',
      confirmed_start_at: SLOT,
      caller_accepted_slot: true,
      agent_committed_booking: null,
      definite_commitment: false,
      relative_date_used: false,
      agreed_slot_words: WORDS,
    },
    evidence: [
      { field_path: '/scheduling/confirmed_start_at', speaker: 'agent', quote: AGENT_SLOT },
      { field_path: '/scheduling/caller_accepted_slot', speaker: 'caller', quote: ACCEPT },
    ],
  };
  return deepMerge(base, overrides);
}

const call = (overrides = {}) => ({
  id: CALL_ID, customer_id: CUSTOMER_ID, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
  created_at: CALL_START, transcription: TRANSCRIPT, metadata: { stir_verstat: 'TN-Validation-Passed-A' }, ...overrides,
});
const customer = (overrides = {}) => ({ id: CUSTOMER_ID, phone: PHONE, ...ADDRESS, ...overrides });
const visit = (overrides = {}) => {
  const row = {
    id: VISIT_ID, customer_id: CUSTOMER_ID, property_id: null, service_id: 'pest-quarterly', service_type: 'Quarterly Pest Control Service',
    scheduled_date: new Date('2026-10-13T00:00:00Z'), window_start: '09:00:00', window_end: '10:00:00',
    estimated_duration_minutes: null, status: 'confirmed', source_action: null, visit_id: null, parent_service_id: null,
    source_call_log_id: null, internal_notes: null, is_recurring: true, self_booking_id: null, customer_confirmed: true,
    en_route_at: null, arrived_at: null, check_in_time: null, actual_start_time: null, completed_at: null, has_service_record: false,
    ...overrides,
  };
  if (!Object.hasOwn(row, 'catalog_service_name')) row.catalog_service_name = row.service_id ? row.service_type : null;
  return row;
};
const noshow = (overrides = {}) => ({
  id: NOSHOW_ID, scheduled_service_id: VISIT_ID, original_date: '2026-10-13', original_window: '09:00:00-10:00:00', resolved_at: null, ...overrides,
});
// The row the booking transaction was about to insert (call-recording-
// processor.js insertData), plus what the booking knew about its follow-up
// plan and re-service catalog row.
const booking = (overrides = {}) => ({
  customer_id: CUSTOMER_ID, property_id: null,
  service_address_line1: ADDRESS.address_line1, service_address_line2: null, service_address_city: ADDRESS.city, service_address_zip: ADDRESS.zip,
  scheduled_date: '2026-10-20', window_start: '17:00', status: 'confirmed', followUpPlanned: false, reService: false, callbackHold: false, ...overrides,
});
const baseArgs = (over = {}) => ({ v2: v2(), call: call(), customer: customer(), properties: [], booking: booking(),
  candidates: [visit()], noshowLogs: [noshow()], now: NOW, ...over });
const held = (reason) => expect.objectContaining({ action: 'needs_review', reason });

describe('planMakeupMoveFromCall', () => {
  test('the incident: a missed confirmed quarterly visit with an open no-show moves to the booking\'s slot', () => {
    expect(planMakeup(baseArgs())).toMatchObject({
      action: 'apply', visitId: VISIT_ID, noshowLogId: NOSHOW_ID,
      from: { date: '2026-10-13', start: '09:00', end: '10:00' },
      newDate: '2026-10-20', newWindow: { start: '17:00', end: '18:00' },
    });
  });

  test('the visit keeps its own length at the booking\'s start', () => {
    const long = { candidates: [visit({ window_end: '10:30:00' })], noshowLogs: [noshow({ original_window: '09:00:00-10:30:00' })] };
    expect(planMakeup(baseArgs(long))).toMatchObject({ action: 'apply', newWindow: { start: '17:00', end: '18:30' } });
    // A booking start the visit's length would carry past midnight holds.
    const late = { booking: booking({ window_start: '23:00' }), v2: v2({ scheduling: { confirmed_start_at: '2026-10-20T23:00:00-04:00' } }) };
    expect(planMakeup(baseArgs({ ...late, ...long }))).toEqual(held('window_runs_past_midnight'));
  });

  test('a lawn customer\'s missed every-6-weeks visit moves even when the call names the one-time lawn service', () => {
    const lawn = visit({ id: LAWN_VISIT_ID, service_id: 'lawn-6wk', service_type: 'Lawn Care Service', status: 'pending' });
    const plan = planMakeup(baseArgs({
      v2: v2({ service_request: { primary_service_category: 'lawn_care', specific_service_name: 'One-Time Lawn Care Service' } }),
      candidates: [lawn], noshowLogs: [noshow({ scheduled_service_id: LAWN_VISIT_ID })],
    }));
    expect(plan).toMatchObject({ action: 'apply', visitId: LAWN_VISIT_ID });
  });

  // With a missed visit of the call's line on the books, nothing below lets
  // the insert through: each one HOLDS the booking for a person.
  test('a call still filed as reschedule_requested is held, never booked beside the missed visit', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { status: 'reschedule_requested' } }) }))).toEqual(held('not_a_confirmed_slot'));
  });

  test('a call that is neither a follow-up nor existing-customer scheduling is held; either one alone is enough', () => {
    expect(planMakeup(baseArgs({ v2: v2({ call_nature: 'new_lead', service_request: { service_intent: 'quote_only' } }) }))).toEqual(held('not_a_follow_up_call'));
    expect(planMakeup(baseArgs({ v2: v2({ call_nature: 'new_lead' }) }))).toMatchObject({ action: 'apply' });
  });

  test('secondary categories hold', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { secondary_categories: ['lawn_care'] } }) }))).toEqual(held('service_needs_review'));
  });

  test.each([
    ['bed bugs', 'bed_bug'],
    ['a wasp nest', 'stinging_insect'],
  ])('a specialty call (%s) beside a missed general pest visit is held, never a move of the program visit', (_label, category) => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { primary_service_category: category } }) }))).toEqual(held('specialty_service'));
  });

  test('a WDO inspection or termite call beside missed bait monitoring is held', () => {
    const bait = visit({ service_id: 'termite-bait', service_type: 'Termite Bait Monitoring Service' });
    for (const category of ['wdo', 'termite']) {
      expect(planMakeup(baseArgs({ candidates: [bait], v2: v2({ service_request: { primary_service_category: category, specific_service_name: null } }) })))
        .toEqual(held('specialty_service'));
    }
  });

  test('a promised visit 2 or a package follow-up holds: the moved visit has no such child', () => {
    expect(planMakeup(baseArgs({ booking: booking({ followUpPlanned: true }) }))).toEqual(held('follow_up_visit_promised'));
  });

  test('a covered re-service booking holds: the call says the last treatment happened', () => {
    expect(planMakeup(baseArgs({ booking: booking({ reService: true }) }))).toEqual(held('reservice_booking'));
  });

  test('the extraction\'s agreed slot must be the booking\'s own', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { confirmed_start_at: '2026-10-20T18:00:00-04:00' } }) }))).toEqual(held('slot_differs_from_extraction'));
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { confirmed_start_at: null } }) }))).toEqual(held('slot_differs_from_extraction'));
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { confirmed_start_at: '2026-10-20T21:00:00Z' } }) }))).toMatchObject({ action: 'apply' });
  });

  test('a pass that armed the disclaimed-number hold holds: a person sorts the numbers before the visit moves', () => {
    expect(planMakeup(baseArgs({ booking: booking({ callbackHold: true }) }))).toEqual(held('caller_number_disclaimed'));
  });

  test('a booking that would have gone in pending for an address check holds', () => {
    expect(planMakeup(baseArgs({ booking: booking({ status: 'pending' }) }))).toEqual(held('address_needs_review'));
  });

  test('no open no-show row: nothing proves a missed visit', () => {
    expect(planMakeup(baseArgs({ noshowLogs: [] }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
  });

  test('a resolved no-show row is not evidence', () => {
    expect(planMakeup(baseArgs({ noshowLogs: [noshow({ resolved_at: new Date('2026-10-14T00:00:00Z') })] }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
  });

  test('a no-show row for another occurrence (date or window) is not evidence for this slot', () => {
    expect(planMakeup(baseArgs({ noshowLogs: [noshow({ original_date: '2026-09-13' })] }))).toMatchObject({ reason: 'no_missed_visit' });
    expect(planMakeup(baseArgs({ noshowLogs: [noshow({ original_window: '13:00:00-14:00:00' })] }))).toMatchObject({ reason: 'no_missed_visit' });
    expect(planMakeup(baseArgs({ noshowLogs: [noshow({ original_date: null })] }))).toMatchObject({ reason: 'no_missed_visit' });
  });

  test('a future-dated or today\'s visit is never a make-up candidate', () => {
    expect(planMakeup(baseArgs({ candidates: [visit({ scheduled_date: new Date('2026-10-20T00:00:00Z') })], noshowLogs: [noshow({ original_date: '2026-10-20' })] })))
      .toMatchObject({ reason: 'no_missed_visit' });
    expect(planMakeup(baseArgs({ candidates: [visit({ scheduled_date: new Date('2026-10-17T00:00:00Z') })], noshowLogs: [noshow({ original_date: '2026-10-17' })] })))
      .toMatchObject({ reason: 'no_missed_visit' });
  });

  test('a visit moved after the call FROM a missed date is held, with no evidence needed: someone already acted on it', () => {
    const moved = visit({ scheduled_date: new Date('2026-10-24T00:00:00Z'), moved_after_call: true });
    expect(planMakeup(baseArgs({ candidates: [moved], noshowLogs: [] }))).toEqual(held('handled_after_call'));
    // The same future row without that history is just an upcoming visit.
    expect(planMakeup(baseArgs({ candidates: [visit({ scheduled_date: new Date('2026-10-24T00:00:00Z') })], noshowLogs: [] })))
      .toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
  });

  test('a visit older than the 30-day look-back is left alone', () => {
    expect(planMakeup(baseArgs({ candidates: [visit({ scheduled_date: new Date('2026-09-10T00:00:00Z') })], noshowLogs: [noshow({ original_date: '2026-09-10' })] })))
      .toMatchObject({ reason: 'no_missed_visit' });
  });

  test.each([
    ['grouped', { visit_id: 'grp-1' }],
    ['a child row', { parent_service_id: 'p-1' }],
    ['not recurring', { is_recurring: false }],
    ['dispatch-owned', { source_action: 'auto_dispatch' }],
    ['parked at rescheduled', { status: 'rescheduled' }],
    ['already no_show', { status: 'no_show' }],
  ])('a candidate that is %s is not moved', (_label, row) => {
    const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
    const over = row.source_action === 'auto_dispatch' ? { source_action: DISPATCH_OWNED_PENDING_SOURCE_ACTIONS[0] } : row;
    expect(planMakeup(baseArgs({ candidates: [visit(over)] }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
  });

  test('an unactivated AI office-review booking is not moved', () => {
    const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');
    expect(planMakeup(baseArgs({ candidates: [visit({ source_action: OFFICE_REVIEW_PENDING_SOURCE_ACTIONS[0] })] }))).toMatchObject({ reason: 'no_missed_visit' });
  });

  test('two missed visits of the same line need review', () => {
    const second = visit({ id: LAWN_VISIT_ID, scheduled_date: new Date('2026-10-10T00:00:00Z') });
    const plan = planMakeup(baseArgs({ candidates: [visit(), second],
      noshowLogs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID, original_date: '2026-10-10' })] }));
    expect(plan).toEqual(held('ambiguous_missed_visit'));
    expect(plan.visitId).toBeNull();
    expect(plan.candidateIds.sort()).toEqual([VISIT_ID, LAWN_VISIT_ID].sort());
  });

  test('a missed visit of another service line does not make the call ambiguous', () => {
    const lawn = visit({ id: LAWN_VISIT_ID, service_id: 'lawn-6wk', service_type: 'Lawn Care Service' });
    const plan = planMakeup(baseArgs({ candidates: [visit(), lawn],
      noshowLogs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID })] }));
    expect(plan).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('a missed visit of a different service line than the call says nothing about this booking: the insert goes ahead', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { primary_service_category: 'lawn_care', specific_service_name: 'Lawn Care Service' } }) })))
      .toMatchObject({ action: 'skip', reason: 'service_line_differs' });
  });

  test('a call that names a real service of another line holds; a generic or same-line name is compatible', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { specific_service_name: 'Mosquito Control Service' } }) }))).toEqual(held('service_line_differs'));
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { specific_service_name: 'Quarterly Pest Control Service' } }) }))).toMatchObject({ action: 'apply' });
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { specific_service_name: null } }) }))).toMatchObject({ action: 'apply' });
  });

  test('a call whose category names no line cannot pick a visit: held', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { primary_service_category: 'other' } }) }))).toEqual(held('service_line_unknown'));
  });

  test('the catch-all placeholder visit is never moved, alone or beside a real one', () => {
    const placeholder = (over = {}) => visit({ service_id: 'general', service_type: 'Waves Pest Control Appointment Service',
      catalog_service_key: 'general_appointment', catalog_service_name: 'Waves Pest Control Appointment Service', ...over });
    expect(planMakeup(baseArgs({ candidates: [placeholder()] }))).toEqual(held('placeholder_candidate'));
    expect(planMakeup(baseArgs({ candidates: [visit(), placeholder({ id: LAWN_VISIT_ID })],
      noshowLogs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID })] }))).toEqual(held('placeholder_candidate'));
  });

  test('a call that names a different appointment date is about another visit: held', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { moved_appointment_date: '2026-10-24' } }) }))).toEqual(held('moved_appointment_not_candidate'));
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { moved_appointment_date: '2026-10-13' } }) }))).toMatchObject({ action: 'apply' });
  });

  test('identity: a caller on a number not on file, or an unmatched call, holds', () => {
    expect(planMakeup(baseArgs({ call: call({ from_phone: '+15555550177' }) }))).toEqual(held('caller_phone_not_on_file'));
    expect(planMakeup(baseArgs({ call: call({ customer_id: null }) }))).toEqual(held('customer_not_matched'));
    expect(planMakeup(baseArgs({ call: call({ customer_id: 'someone-else' }) }))).toEqual(held('customer_not_matched'));
  });

  test('inferred speaker labels cannot authorize a move', () => {
    expect(planWithLabelTrust(baseArgs())).toEqual(held('untrusted_speaker_labels'));
  });

  test('low or missing scheduling confidence holds', () => {
    expect(planMakeup(baseArgs({ v2: v2({ confidence: { scheduling_window: 0.5 } }) }))).toEqual(held('low_scheduling_confidence'));
    expect(planMakeup(baseArgs({ v2: v2({ confidence: { scheduling_window: null } }) }))).toEqual(held('low_scheduling_confidence'));
  });

  test('spam, voicemail, a non-decision-maker, a do-not-contact request and no extraction hold', () => {
    expect(planMakeup(baseArgs({ v2: v2({ meta: { is_spam: true } }) }))).toEqual(held('spam_or_voicemail'));
    expect(planMakeup(baseArgs({ v2: v2({ meta: { is_voicemail: true } }) }))).toEqual(held('spam_or_voicemail'));
    expect(planMakeup(baseArgs({ v2: v2({ caller: { decision_maker_present: false } }) }))).toEqual(held('caller_not_decision_maker'));
    expect(planMakeup(baseArgs({ v2: v2({ consent: { do_not_contact_request: true } }) }))).toEqual(held('do_not_contact_requested'));
    expect(planMakeup(baseArgs({ v2: null }))).toEqual(held('no_v2_extraction'));
  });

  test('the caller must have accepted, and an agent who did not commit holds', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { caller_accepted_slot: false } }) }))).toEqual(held('caller_did_not_accept'));
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { caller_accepted_slot: null } }) }))).toEqual(held('caller_did_not_accept'));
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { agent_committed_booking: false } }) }))).toEqual(held('agent_did_not_commit'));
  });

  test('an inbound caller the carrier did not fully attest holds for review; an outbound call needs no attestation', () => {
    for (const metadata of [{ stir_verstat: 'TN-Validation-Passed-B' }, { stir_verstat: 'TN-Validation-Passed-C' }, { stir_verstat: 'No-TN-Validation' }, {}, null]) {
      expect(planMakeup(baseArgs({ call: call({ metadata }) }))).toMatchObject({ action: 'needs_review', reason: 'caller_not_attested', visitId: VISIT_ID });
    }
    expect(planMakeup(baseArgs({ call: call({ metadata: JSON.stringify({ stir_verstat: 'TN-Validation-Passed-A' }) }) }))).toMatchObject({ action: 'apply' });
    const outbound = call({ direction: 'outbound-dial', from_phone: '+15555550100', to_phone: PHONE, metadata: null });
    expect(planMakeup(baseArgs({ call: outbound }))).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('the open no-show row alone is not proof of a miss: any field work or a service record leaves the visit alone', () => {
    for (const worked of [{ en_route_at: new Date() }, { arrived_at: new Date() }, { check_in_time: new Date() },
      { actual_start_time: '14:05' }, { completed_at: new Date() }, { has_service_record: true }]) {
      expect(planMakeup(baseArgs({ candidates: [visit(worked)] }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
    }
    // Field-work columns never loaded: no proof, never a move.
    const unknown = visit();
    delete unknown.arrived_at;
    expect(planMakeup(baseArgs({ candidates: [unknown] }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
    // A person's "This was a miss" on the card is proof even when a column is set.
    expect(planMakeup(baseArgs({ candidates: [visit({ en_route_at: new Date() })], noshowLogs: [noshow({ miss_confirmed_at: new Date() })] })))
      .toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('the no-show detector reads make-up moves as call promises', () => {
    const detector = fs.readFileSync(require.resolve('../services/no-show-detector'), 'utf8');
    expect(detector).toContain("const CALL_MOVE_ACTIONS = ['call_reschedule_applied', 'call_makeup_move_applied'];");
    expect(detector).not.toMatch(/action'?: 'call_reschedule_applied' \}/);
  });

  test('the booking\'s own property: a visit at another saved property is not a candidate, the same one is', () => {
    const props = [{ id: 'prop-2', active: true, address_line1: '200 Other Road', city: 'Bradenton', zip: '34205' }];
    const other = visit({ property_id: 'prop-2' });
    expect(planMakeup(baseArgs({ candidates: [other], properties: props }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
    const atOther = booking({ property_id: 'prop-2', service_address_line1: '200 Other Road' });
    expect(planMakeup(baseArgs({ candidates: [other], properties: props, booking: atOther }))).toMatchObject({ action: 'apply', visitId: VISIT_ID });
    // A visit that carries its own service address is matched on it.
    expect(planMakeup(baseArgs({ candidates: [visit({ service_address_line1: '200 Other Road', service_address_city: 'Bradenton', service_address_zip: '34205' })] })))
      .toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
    // A property id that no active saved property resolves never falls back to the primary address.
    expect(planMakeup(baseArgs({ candidates: [visit({ property_id: 'prop-gone' })] }))).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
  });
});

describe('the incident wording', () => {
  // The real call's shape (synthetic names): the day and the hour are in two
  // agent turns, the hour is "around five", nobody says "reschedule". The
  // booking step accepted this call and booked Tuesday 5 PM, so the make-up
  // move must accept it too, or the duplicate booking goes through again.
  const REAL = [
    'Caller: Did you spray the other day?',
    'Agent: No, I need to come by. How\'s tomorrow look?',
    'Caller: It is raining today.',
    'Agent: Tomorrow looks better, and then we have a little bit of rain on Monday. You want me to do, like, for Tuesday?',
    'Caller: Yeah, we have to wait until the rain stops.',
    'Agent: I\'ll plan on coming out there on Tuesday. Are you home on Tuesday?',
    'Caller: I\'m at work all day.',
    'Agent: What time do you get home?',
    'Caller: About five.',
    'Agent: Let\'s plan on getting there. I\'ll get there around five.',
    'Caller: Okay.',
  ].join('\n');
  const realV2 = () => v2({
    scheduling: { agreed_slot_words: { day: null, hour: 'five', period: null } },
    evidence: [
      { field_path: '/scheduling/confirmed_start_at', speaker: 'agent', quote: 'I\'ll get there around five.' },
      { field_path: '/scheduling/caller_accepted_slot', speaker: 'caller', quote: 'Okay.' },
    ],
  });

  test('moves the missed quarterly visit to the slot the booking step accepted', () => {
    const plan = planMakeup(baseArgs({ v2: realV2(), call: call({ transcription: REAL }) }));
    expect(plan).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });
});

describe('service lines', () => {
  test('the shared line mapper', () => {
    expect(lineOfV2Category('pest_general')).toBe('pest');
    expect(lineOfV2Category('lawn_care')).toBe('lawn');
    expect(lineOfV2Category('bundled_waveguard')).toBeNull();
    expect(linesOfServiceName('One-Time Lawn Care Service')).toEqual(['lawn']);
    expect(linesOfServiceName('')).toEqual([]);
  });
});

// ── the database steps against a mocked connection ──────────────────────
function makeConn({ prior = null, cust = customer(), visits = [visit()], logs = [noshow()], properties = [], extraction = v2(),
  settledCall = {}, handled = false, moved = false, movedAfter = [], portalRequest = null, smsOffer = false, callBooking = null, dayTaken = null } = {}) {
  const writes = { updates: [], inserts: [] };
  const offerRows = smsOffer ? [{ id: 'pending-offer', notes: JSON.stringify({ option1: { date: '2026-10-24', window: { start: '08:00', end: '09:00' } } }) }] : [];
  const builder = (table) => {
    const state = { table, where: [], whereIn: [], nullCols: [], updateArg: null };
    const whereHas = (key) => state.where.some(([w]) => w === key || (w && typeof w === 'object' && key in w));
    const q = {
      where(...a) { state.where.push(a); return q; },
      whereIn(...a) { state.whereIn.push(a); return q; },
      whereNot() { return q; },
      whereNotIn() { return q; },
      whereNull(col) { state.nullCols.push(col); return q; },
      leftJoin() { return q; },
      whereRaw() { return q; },
      orderBy() { return q; },
      count() { state.counted = true; return q; },
      forUpdate() { return q; },
      forShare() { return q; },
      modify(fn) { fn(q); return q; },
      select() { return q; },
      update(arg) { state.updateArg = arg; writes.updates.push({ table, arg, where: state.where, nullCols: state.nullCols }); return q; },
      returning() { return Promise.resolve([]); },
      insert(row) { writes.inserts.push({ table, row }); return Promise.resolve([{ id: 'act-1' }]); },
      first() {
        if (table === 'call_log') {
          return Promise.resolve({ ...call(), processing_generation: 3, processing_token: 'tok-1', v2_extraction_status: 'valid',
            ai_extraction_enriched: extraction, ...settledCall });
        }
        if (table === 'activity_log') return Promise.resolve(prior);
        if (table === 'customers') return Promise.resolve(cust);
        if (table === 'triage_items') return Promise.resolve(state.counted ? { n: 0 } : (handled ? { id: 'handled-card' } : undefined));
        if (table === 'reschedule_log') return Promise.resolve(moved ? { id: 'later-move' } : undefined);
        if (table === 'service_requests') return Promise.resolve(portalRequest || undefined);
        if (table === 'scheduled_services' && whereHas('source_call_log_id')) return Promise.resolve(callBooking || undefined);
        if (table === 'scheduled_services' && whereHas('scheduled_date')) return Promise.resolve(dayTaken || undefined);
        if (table === 'scheduled_services') return Promise.resolve(visits[0]);
        return Promise.resolve(undefined);
      },
      then(resolve, reject) {
        if (table === 'customer_properties') return Promise.resolve(properties).then(resolve, reject);
        if (table === 'reschedule_log') {
          if (state.nullCols.includes('customer_response')) return Promise.resolve(offerRows).then(resolve, reject);
          if (state.nullCols.includes('resolved_at')) return Promise.resolve(logs).then(resolve, reject);
          return Promise.resolve(movedAfter).then(resolve, reject);
        }
        if (table === 'scheduled_services' && state.updateArg == null) return Promise.resolve(visits).then(resolve, reject);
        if (state.updateArg != null) return Promise.resolve(1).then(resolve, reject);
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return q;
  };
  const conn = (table) => builder(table);
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.transaction = async (fn) => fn(conn);
  conn.writes = writes;
  conn.visits = visits;
  return conn;
}
const guardedRebooker = (conn, result = { success: true }) => ({
  reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
    await opts.beforeMove(conn);
    await opts.moveGuard({ trx: conn, service: conn.visits[0] });
    return result;
  }),
});
const bookingArgs = (over = {}) => ({ call: call(), procToken: 'tok-1', procGeneration: 3, booking: booking(), now: NOW, ...over });
// The plan the booking transaction hands the processor (planCallMakeupForBooking).
const applyPlan = () => ({ ...planMakeup(baseArgs()), booking: booking() });
const applyArgs = (conn, rebooker, over = {}) => ({ conn, call: call(), plan: applyPlan(), procToken: 'tok-1', procGeneration: 3, now: NOW, rebooker, ...over });
// The move's own transaction sees a different database than the booking's did.
const racingRebooker = (conn, lateConn) => ({ reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => opts.moveGuard({ trx: lateConn, service: conn.visits[0] })) });

describe('planCallMakeupForBooking (the booking transaction, at its insert)', () => {
  test('the incident: apply, with the booking it was judged on, nothing written', async () => {
    const trx = makeConn();
    const plan = await planCallMakeupForBooking(trx, bookingArgs());
    expect(plan).toMatchObject({ action: 'apply', visitId: VISIT_ID, newDate: '2026-10-20', newWindow: { start: '17:00', end: '18:00' }, booking: booking() });
    expect(trx.writes.inserts).toHaveLength(0);
    expect(trx.writes.updates).toHaveLength(0);
  });

  test('no missed visit: skip, so the row is inserted as always', async () => {
    const trx = makeConn({ logs: [] });
    expect(await planCallMakeupForBooking(trx, bookingArgs())).toMatchObject({ action: 'skip', reason: 'no_missed_visit' });
    expect(trx.writes.inserts).toHaveLength(0);
  });

  test.each([
    ['a pass that lost the claim', { processing_token: 'other-token' }, 'superseded_by_newer_pass'],
    ['a newer generation', { processing_generation: 4 }, 'superseded_by_newer_pass'],
    ['a call linked to another customer', { customer_id: 'another-customer' }, 'customer_link_changed'],
  ])('%s stands down to the booking\'s own outcome', async (_label, settledCall, reason) => {
    expect(await planCallMakeupForBooking(makeConn({ settledCall }), bookingArgs())).toMatchObject({ action: 'skip', reason });
  });

  test.each([
    ['this call\'s own earlier booking (live, or cancelled by staff)', { callBooking: { id: 'earlier-booking' } }, 'call_already_booked'],
    ['a staff-handled card', { handled: true }, 'handled_by_staff'],
    ['a move of the visit after the call', { moved: true }, 'handled_after_call'],
    ['an open portal reschedule request', { portalRequest: { id: 'req-1' } }, 'portal_request_open'],
    ['an outstanding reschedule-options text', { smsOffer: true }, 'pending_sms_offer'],
  ])('%s holds the booking for review', async (_label, state, reason) => {
    const trx = makeConn(state);
    expect(await planCallMakeupForBooking(trx, bookingArgs())).toMatchObject({ action: 'needs_review', reason, visitId: VISIT_ID });
    expect(trx.writes.inserts).toHaveLength(0);
  });

  test('a visit moved after the call from a missed date is loaded and held, even with its no-show settled', async () => {
    const trx = makeConn({ visits: [visit({ scheduled_date: new Date('2026-10-24T00:00:00Z') })], logs: [], movedAfter: [{ scheduled_service_id: VISIT_ID }] });
    expect(await planCallMakeupForBooking(trx, bookingArgs())).toMatchObject({ action: 'needs_review', reason: 'handled_after_call' });
  });

  test('two missed candidates hold', async () => {
    const second = visit({ id: LAWN_VISIT_ID, scheduled_date: new Date('2026-10-10T00:00:00Z') });
    const trx = makeConn({ visits: [visit(), second], logs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID, original_date: '2026-10-10' })] });
    expect(await planCallMakeupForBooking(trx, bookingArgs())).toMatchObject({ action: 'needs_review', reason: 'ambiguous_missed_visit' });
  });

  test('a call still filed as reschedule_requested holds beside the missed visit', async () => {
    const trx = makeConn({ extraction: v2({ scheduling: { status: 'reschedule_requested' } }) });
    expect(await planCallMakeupForBooking(trx, bookingArgs())).toMatchObject({ action: 'needs_review', reason: 'not_a_confirmed_slot' });
  });
});

describe('priorCallMakeupDecision (the reprocess check, before the booking branch)', () => {
  const movedVisit = () => visit({ scheduled_date: new Date('2026-10-20T00:00:00Z'), window_start: '17:00:00', window_end: '18:00:00', source_call_log_id: CALL_ID });
  const marker = (over = {}) => ({ metadata: JSON.stringify({
    call_log_id: CALL_ID, scheduled_service_id: VISIT_ID, to: { date: '2026-10-20', start: '17:00', end: '18:00' }, processing_generation: 2,
    source_hash: createHash('sha256').update(JSON.stringify([TRANSCRIPT, v2()])).digest('hex'), ...over }) });

  test('a call that never applied a make-up: null, the booking branch runs', async () => {
    expect(await priorCallMakeupDecision(makeConn(), { call: call(), procToken: 'tok-1' })).toBeNull();
  });

  test('the same call and the visit still at the marked slot: noop, the moved visit IS the booking (a reprocess bumps the generation)', async () => {
    const conn = makeConn({ prior: marker(), visits: [movedVisit()] });
    expect(await priorCallMakeupDecision(conn, { call: call(), procToken: 'tok-1' })).toEqual({ outcome: 'noop', reason: 'already_applied', visitId: VISIT_ID });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('a changed transcript or extraction, a moved visit, or another pass\'s claim holds for review', async () => {
    const decide = (state) => priorCallMakeupDecision(makeConn({ prior: marker(), visits: [movedVisit()], ...state }), { call: call(), procToken: 'tok-1' });
    const review = { outcome: 'needs_review', reason: 'prior_makeup_differs', visitId: VISIT_ID };
    expect(await decide({ settledCall: { transcription: `${TRANSCRIPT}\nCaller: Actually, make it Wednesday.` } })).toEqual(review);
    expect(await decide({ extraction: v2({ scheduling: { confirmed_start_at: '2026-10-21T17:00:00-04:00' } }) })).toEqual(review);
    expect(await decide({ visits: [visit({ scheduled_date: new Date('2026-10-23T00:00:00Z'), window_start: '09:00:00', window_end: '10:00:00' })] })).toEqual(review);
    expect(await decide({ settledCall: { processing_token: 'peer-token' } })).toEqual(review);
  });
});

describe('applyCallMakeupMove (after the booking transaction)', () => {
  beforeEach(() => {
    AppointmentReminders.handleReschedule.mockClear().mockResolvedValue({});
    emitDispatchJobUpdate.mockClear().mockResolvedValue({});
    require('../routes/admin-dispatch').applySeriesMoveEffects.mockClear();
  });

  test('moves the missed visit through the rebooker with the default series policy, logs it, stamps the call, sends nothing', async () => {
    const conn = makeConn();
    const rebooker = guardedRebooker(conn);
    const result = await applyCallMakeupMove(applyArgs(conn, rebooker));

    expect(result).toMatchObject({ outcome: 'applied', visitId: VISIT_ID, newDate: '2026-10-20', newWindow: { start: '17:00', end: '18:00' } });
    const [id, date, win, reason, by, opts] = rebooker.reschedule.mock.calls[0];
    expect([id, date, win, reason, by]).toEqual([VISIT_ID, '2026-10-20', { start: '17:00', end: '18:00' }, MAKEUP_REASON_CODE, INITIATED_BY]);
    expect(MAKEUP_REASON_CODE).toBe('ai_call_makeup');
    expect(reason.length).toBeLessThanOrEqual(30);
    expect(opts).toMatchObject({ keepStatus: true, notifyRequested: false, sourceSurface: 'call_makeup',
      expect: { scheduled_date: '2026-10-13', window_start: '09:00:00', status: 'confirmed', is_recurring: true } });
    expect(opts).not.toHaveProperty('seriesPolicy');

    const activity = conn.writes.inserts.find((i) => i.table === 'activity_log');
    expect(activity.row.action).toBe(MAKEUP_ACTIVITY_ACTION);
    expect(JSON.parse(activity.row.metadata)).toMatchObject({ call_log_id: CALL_ID, scheduled_service_id: VISIT_ID, noshow_log_id: NOSHOW_ID,
      from: { date: '2026-10-13' }, to: { date: '2026-10-20', start: '17:00', end: '18:00' }, processing_generation: 3 });
    // The moved row carries the call (booking dedup + commitment proof), only when nobody else's.
    const stamp = conn.writes.updates.find((u) => u.table === 'scheduled_services' && u.arg.source_call_log_id);
    expect(stamp.arg.source_call_log_id).toBe(CALL_ID);
    expect(stamp.nullCols).toContain('source_call_log_id');
    // Nothing customer-facing: the only insert is the audit row; reminders resync without a send.
    expect(conn.writes.inserts.map((i) => i.table)).toEqual(['activity_log']);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith(VISIT_ID, '2026-10-20T17:00', { sendNotification: false });
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: VISIT_ID, actorId: null });
  });

  test('a series move finishes through the shared durable pass with notification off', async () => {
    const conn = makeConn();
    const result = { success: true, seriesMoveId: 'series-1' };
    const out = await applyCallMakeupMove(applyArgs(conn, guardedRebooker(conn, result)));
    expect(out.outcome).toBe('applied');
    expect(require('../routes/admin-dispatch').applySeriesMoveEffects).toHaveBeenCalledWith({ result, serviceId: VISIT_ID,
      newDate: '2026-10-20', newWindow: { start: '17:00', end: '18:00' }, notify: false, actorId: null, reasonText: null });
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
  });

  test('a series move whose post-commit effects throw is still applied (the reconciler retries), never a review card', async () => {
    const conn = makeConn();
    const effects = require('../routes/admin-dispatch').applySeriesMoveEffects;
    effects.mockRejectedValueOnce(new Error('effects down'));
    const out = await applyCallMakeupMove(applyArgs(conn, guardedRebooker(conn, { success: true, seriesMoveId: 'series-2' })));
    expect(out).toMatchObject({ outcome: 'applied', visitId: VISIT_ID });
    expect(fs.readFileSync(require.resolve('../routes/admin-dispatch'), 'utf8')).toMatch(/RECONCILE_SURFACES = \[[^\]]*'call_makeup'/);
  });

  test('a marker another pass wrote meanwhile makes the move a no-op that writes nothing', async () => {
    const conn = makeConn({ prior: { metadata: JSON.stringify({ call_log_id: CALL_ID, scheduled_service_id: VISIT_ID }) } });
    expect(await applyCallMakeupMove(applyArgs(conn, guardedRebooker(conn)))).toMatchObject({ outcome: 'noop', reason: 'already_applied', visitId: VISIT_ID });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test.each([
    ['a pass that lost the claim', { processing_token: 'other-token' }, 'superseded_by_newer_pass'],
    ['a newer generation', { processing_generation: 4 }, 'superseded_by_newer_pass'],
    ['a call linked to another customer', { customer_id: 'another-customer' }, 'customer_link_changed'],
  ])('%s holds without moving (the booking already inserted nothing)', async (_label, settledCall, reason) => {
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(makeConn({ settledCall }), rebooker))).toMatchObject({ outcome: 'needs_review', reason, visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test.each([
    ['a live visit landing on the agreed day', { dayTaken: { id: 'staff-replacement' } }, 'existing_appointment_on_target_date'],
    ['this call\'s own booking appearing', { callBooking: { id: 'earlier-booking' } }, 'call_already_booked'],
    ['a portal request opened', { portalRequest: { id: 'req-late' } }, 'portal_request_open'],
    ['a staff move of the visit', { moved: true }, 'handled_after_call'],
  ])('%s between the booking transaction and the move\'s own holds', async (_label, state, reason) => {
    const conn = makeConn();
    const lateConn = makeConn(state);
    expect(await applyCallMakeupMove(applyArgs(conn, racingRebooker(conn, lateConn)))).toMatchObject({ outcome: 'needs_review', reason, visitId: VISIT_ID });
    expect(lateConn.writes.inserts).toHaveLength(0);
  });

  test('a row edited during the move cannot receive the stale decision', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => opts.moveGuard({ trx: conn,
      service: { ...conn.visits[0], service_id: 'mosquito-monthly', service_type: 'Monthly Mosquito Control Service' } })) };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'changed_before_apply' });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('a no-show settled during the move (someone rebooked it) holds instead of double-moving', async () => {
    const conn = makeConn();
    expect(await applyCallMakeupMove(applyArgs(conn, racingRebooker(conn, makeConn({ logs: [] }))))).toMatchObject({ outcome: 'needs_review', reason: 'changed_before_apply' });
  });

  test('an extraction rewritten during the move holds', async () => {
    const conn = makeConn();
    const lateConn = makeConn({ extraction: v2({ scheduling: { caller_accepted_slot: false } }) });
    expect(await applyCallMakeupMove(applyArgs(conn, racingRebooker(conn, lateConn)))).toMatchObject({ outcome: 'needs_review', reason: 'changed_before_apply' });
  });

  test('a rebooker refusal (slot taken, bad window) HOLDS the booking and writes no activity row', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn().mockRejectedValue(Object.assign(new Error('slot taken'), { code: 'SLOT_TAKEN' })) };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'move_failed_SLOT_TAKEN', visitId: VISIT_ID });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('a failed or empty reminder sync does not undo a committed move (the in-transaction trigger re-timed the reminder)', async () => {
    AppointmentReminders.handleReschedule.mockRejectedValueOnce(new Error('sms provider down'));
    const conn = makeConn();
    expect(await applyCallMakeupMove(applyArgs(conn, guardedRebooker(conn)))).toMatchObject({ outcome: 'applied' });
    AppointmentReminders.handleReschedule.mockResolvedValueOnce(null);
    const again = makeConn();
    expect(await applyCallMakeupMove(applyArgs(again, guardedRebooker(again)))).toMatchObject({ outcome: 'applied' });
    expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('reminder re-sync returned nothing'));
  });
});

// ── processor wiring ────────────────────────────────────────────────────
describe('processor wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  describe('callMakeupStep', () => {
    const { callMakeupStep } = require('../services/call-recording-processor')._test;

    test('runs against the make-up module and returns its outcome', async () => {
      const run = jest.fn().mockResolvedValue({ outcome: 'applied', visitId: VISIT_ID });
      expect(await callMakeupStep('move', 'CA1', run)).toEqual({ outcome: 'applied', visitId: VISIT_ID });
      expect(run).toHaveBeenCalledWith(require('../services/call-reschedule-apply'));
      expect(await callMakeupStep('prior', 'CA1', jest.fn().mockResolvedValue(null))).toBeNull();
    });

    test('an unexpected throw HOLDS the booking (needs_review), it never falls back to booking', async () => {
      expect(await callMakeupStep('move', 'CA1', jest.fn().mockRejectedValue(new Error('db down'))))
        .toEqual({ outcome: 'needs_review', reason: 'makeup_check_failed' });
    });
  });

  test('after the disposition is written, an applied make-up move revises a stale callback disposition (gated, never blocking)', () => {
    const zero = source.indexOf('await applyZeroTriageLayers({ call, callSid, contactPhone, extracted, v2Result, appointmentResult, customerId');
    const revise = source.indexOf("reviseDispositionAfterAppliedMove({ call, callSid, procGeneration, reason: 'makeup_move_applied' })");
    expect(zero).toBeGreaterThan(-1);
    expect(revise).toBeGreaterThan(zero);
    expect(source.slice(revise - 200, revise)).toMatch(/skippedReason === 'makeup_move_applied' && isEnabled\('callDispositionV1'\)/);
    expect(source.slice(revise, revise + 220)).toMatch(/\.catch\(/);
  });

  test('the decision sits at the booking transaction\'s fresh insert, after every booking guard', () => {
    const hook = source.indexOf("require('./call-reschedule-apply').planCallMakeupForBooking(trx, {");
    expect(hook).toBeGreaterThan(-1);
    for (const guard of [
      'const existing = await findExistingCallAppointment({',
      'const attachable = await findAttachableCallAppointment({',
      'const sameDayExisting = await trx(\'scheduled_services\')',
      "return { __held: { reason: 'open_reservice_callback_exists' } };",
      "return { __held: { reason: 'arranger_slot_elapsed_pre_insert' } };",
    ]) {
      const at = source.indexOf(guard);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(hook);
    }
    const insert = source.indexOf('.insert(insertData)', hook);
    expect(insert).toBeGreaterThan(hook);
    const block = source.slice(source.lastIndexOf('if (makeupGateOn) {', hook), insert);
    expect(block).toContain("if (makeup.action !== 'skip') return { __makeup: makeup };");
    expect(block).toContain('followUpPlanned: Boolean(callFollowUpPlan), reService: isReServiceCatalogRow(callBookingCatalogRow)');
    expect(block).toContain('callbackHold: callbackNumberNeededHoldActive');
  });

  test('after the booking transaction: held, then make-up, then the inserted or reused row', () => {
    const heldBranch = source.indexOf('if (svc && svc.__held) {');
    const makeupBranch = source.indexOf('} else if (svc && svc.__makeup) {', heldBranch);
    const rowBranch = source.indexOf('if (reusedExistingSchedule) {\n                scheduleWasReused = true;', makeupBranch);
    expect(heldBranch).toBeGreaterThan(-1);
    expect(makeupBranch).toBeGreaterThan(heldBranch);
    expect(rowBranch).toBeGreaterThan(makeupBranch);
    const block = source.slice(makeupBranch, rowBranch);
    expect(block).toContain("makeup.applyCallMakeupMove({ conn: db, call, plan: svc.__makeup, procToken, procGeneration })");
    expect(block).toContain("svc.__makeup.action === 'apply'");
    expect(block).toContain('appointmentResult = await settleMakeup(');
  });

  test('the reprocess check runs behind the gate, after every earlier veto, before the booking branch', () => {
    const gate = source.indexOf("const makeupGateOn = isEnabled('callMakeupMove') && !v2RoutingBlocked && !legacyGeoVeto");
    expect(gate).toBeGreaterThan(-1);
    const prior = source.indexOf('makeup.priorCallMakeupDecision(db, {', gate);
    const chainStart = source.indexOf('    if (v2RoutingBlocked) {', gate);
    const priorBranch = source.indexOf('} else if (makeupPrior) {\n      appointmentResult = await settleMakeup(makeupPrior);', chainStart);
    const bookingBranch = source.indexOf('} else if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && canCreateAppointmentFromCall) {\n      // Declared OUTSIDE the try');
    expect(prior).toBeGreaterThan(gate);
    expect(chainStart).toBeGreaterThan(prior);
    expect(priorBranch).toBeGreaterThan(chainStart);
    expect(bookingBranch).toBeGreaterThan(priorBranch);
  });

  test('settled: moved reports no schedule row (no confirmation text, no fallback card); held files the review card, never a visit', () => {
    const start = source.indexOf('const settleMakeup = async (makeup) => {');
    const block = source.slice(start, source.indexOf('    if (v2RoutingBlocked) {', start));
    const [moved, heldPart] = block.split("logger.warn(`[call-proc] Held auto-booking");
    expect(moved).toContain('scheduleCreated: false');
    expect(moved).toContain('smsSent: false');
    expect(moved).toContain("skippedReason: 'makeup_move_applied'");
    expect(heldPart).toContain("bridgeNeedsConfirmation.push('missed_visit_makeup_needs_review')");
    expect(heldPart).toContain('fileSkippedBookingCard(');
    expect(heldPart).toContain("skippedReason: 'missed_visit_makeup_needs_review'");
    expect(block).not.toContain('scheduledServiceId');
    expect(block).not.toMatch(/insert\(/);
    expect(source).toMatch(/const heldReasons = new Set\(\[[^\]]*'makeup_move_applied'\]\)/);
  });

  test('gate off: dark unless GATE_CALL_MAKEUP_MOVE is exactly true, read in one place', () => {
    const read = (value) => {
      const saved = process.env.GATE_CALL_MAKEUP_MOVE;
      if (value === undefined) delete process.env.GATE_CALL_MAKEUP_MOVE; else process.env.GATE_CALL_MAKEUP_MOVE = value;
      let gate;
      jest.isolateModules(() => { gate = jest.requireActual('../config/feature-gates').gates.callMakeupMove; });
      if (saved === undefined) delete process.env.GATE_CALL_MAKEUP_MOVE; else process.env.GATE_CALL_MAKEUP_MOVE = saved;
      return gate;
    };
    expect(read(undefined)).toBe(false);
    expect(read('1')).toBe(false);
    expect(read('true')).toBe(true);
    expect(source.match(/isEnabled\('callMakeupMove'\)/g)).toHaveLength(1);
  });

  test('the commitment tracker accepts the make-up move as proof the promised visit was kept', () => {
    const commitments = fs.readFileSync(path.join(__dirname, '../services/call-commitments.js'), 'utf8');
    expect(commitments).toContain('MAKEUP_ACTIVITY_ACTION: MAKEUP_APPLIED');
    expect(commitments).toContain('.whereIn("action", [RESCHEDULE_APPLIED, MAKEUP_APPLIED])');
  });
});
