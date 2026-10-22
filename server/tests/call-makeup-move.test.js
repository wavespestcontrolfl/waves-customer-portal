// Make-up move (GATE_CALL_MAKEUP_MOVE): a recurring visit that was MISSED and
// then agreed to a new time on a call is MOVED, never booked a second time.
// Pure planner, the agreement grounding it uses, the applier against a mocked
// connection, and the processor wiring (a full processRecording() run cannot
// be mocked end to end, so the step is tested behaviorally and the branch order
// is pinned structurally). Fixtures are fictitious (555-01xx numbers, synthetic
// ids and addresses).
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
const {
  planMakeupMoveFromCall: planWithLabelTrust,
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
// The ET wall clock the booking step would have inserted (V1 preferred_date_time).
const BOOKING_SLOT = '2026-10-20T17:00';

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
    ...overrides,
  };
  if (!Object.hasOwn(row, 'catalog_service_name')) row.catalog_service_name = row.service_id ? row.service_type : null;
  return row;
};
const noshow = (overrides = {}) => ({
  id: NOSHOW_ID, scheduled_service_id: VISIT_ID, original_date: '2026-10-13', original_window: '09:00:00-10:00:00', resolved_at: null, ...overrides,
});
const baseArgs = (over = {}) => ({ v2: v2(), call: call(), customer: customer(), candidates: [visit()], noshowLogs: [noshow()], now: NOW, bookingSlot: BOOKING_SLOT, ...over });

describe('planMakeupMoveFromCall', () => {
  test('the incident: a missed confirmed quarterly visit with an open no-show moves to the agreed slot', () => {
    expect(planMakeup(baseArgs())).toMatchObject({
      action: 'apply', visitId: VISIT_ID, dateMove: true, noshowLogId: NOSHOW_ID,
      from: { date: '2026-10-13', start: '09:00', end: '10:00' },
      newDate: '2026-10-20', newWindow: { start: '17:00', end: '18:00' },
    });
  });

  test('a lawn customer\'s missed every-6-weeks visit moves even when the call names the one-time lawn service', () => {
    const lawn = visit({ id: LAWN_VISIT_ID, service_id: 'lawn-6wk', service_type: 'Lawn Care Service', status: 'pending' });
    const plan = planMakeup(baseArgs({
      v2: v2({ service_request: { primary_service_category: 'lawn_care', specific_service_name: 'One-Time Lawn Care Service' } }),
      candidates: [lawn], noshowLogs: [noshow({ scheduled_service_id: LAWN_VISIT_ID })],
    }));
    expect(plan).toMatchObject({ action: 'apply', visitId: LAWN_VISIT_ID });
  });

  test('a call still filed as reschedule_requested is the reschedule lane\'s, not a make-up', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { status: 'reschedule_requested' } }) }))).toMatchObject({ action: 'skip', reason: 'not_a_confirmed_slot' });
  });

  test('a call that is neither a follow-up nor existing-customer scheduling is skipped', () => {
    const plan = planMakeup(baseArgs({ v2: v2({ call_nature: 'new_lead', service_request: { service_intent: 'quote_only' } }) }));
    expect(plan).toMatchObject({ action: 'skip', reason: 'not_a_follow_up_call' });
    expect(planMakeup(baseArgs({ v2: v2({ call_nature: 'new_lead' }) }))).toMatchObject({ action: 'apply' });
  });

  test('secondary categories send the call back to today\'s path', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { secondary_categories: ['lawn_care'] } }) }))).toMatchObject({ action: 'skip', reason: 'service_needs_review' });
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
    expect(plan).toMatchObject({ action: 'needs_review', reason: 'ambiguous_missed_visit' });
    expect(plan.candidateIds.sort()).toEqual([VISIT_ID, LAWN_VISIT_ID].sort());
  });

  test('a missed visit of another service line does not make the call ambiguous', () => {
    const lawn = visit({ id: LAWN_VISIT_ID, service_id: 'lawn-6wk', service_type: 'Lawn Care Service' });
    const plan = planMakeup(baseArgs({ candidates: [visit(), lawn],
      noshowLogs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID })] }));
    expect(plan).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('a missed visit of a different service line than the call is skipped', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { primary_service_category: 'lawn_care', specific_service_name: 'Lawn Care Service' } }) })))
      .toMatchObject({ action: 'skip', reason: 'service_line_differs' });
  });

  test('a call that names a real service of another line is skipped, a generic or same-line name is compatible', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { specific_service_name: 'Mosquito Control Service' } }) }))).toMatchObject({ reason: 'service_line_differs' });
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { specific_service_name: 'Quarterly Pest Control Service' } }) }))).toMatchObject({ action: 'apply' });
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { specific_service_name: null } }) }))).toMatchObject({ action: 'apply' });
  });

  test('a call whose category names no line cannot pick a visit', () => {
    expect(planMakeup(baseArgs({ v2: v2({ service_request: { primary_service_category: 'other' } }) }))).toMatchObject({ reason: 'service_line_unknown' });
  });

  test('the catch-all placeholder visit is never moved', () => {
    const placeholder = visit({ service_id: 'general', service_type: 'Waves Pest Control Appointment Service', catalog_service_key: 'general_appointment', catalog_service_name: 'Waves Pest Control Appointment Service' });
    expect(planMakeup(baseArgs({ candidates: [placeholder] }))).toMatchObject({ action: 'skip', reason: 'placeholder_candidate' });
  });

  test('a placeholder missed beside a real one is review, not a silent pick', () => {
    const placeholder = visit({ id: LAWN_VISIT_ID, service_id: 'general', catalog_service_key: 'general_appointment', catalog_service_name: 'Waves Pest Control Appointment Service' });
    expect(planMakeup(baseArgs({ candidates: [visit(), placeholder], noshowLogs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID })] })))
      .toMatchObject({ action: 'needs_review', reason: 'service_needs_review' });
  });

  test('a call that names a different appointment date is not a make-up of this visit', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { moved_appointment_date: '2026-10-24' } }) }))).toMatchObject({ reason: 'moved_appointment_not_candidate' });
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { moved_appointment_date: '2026-10-13' } }) }))).toMatchObject({ action: 'apply' });
  });

  test('identity: a caller on a number not on file, or an unmatched call, is skipped', () => {
    expect(planMakeup(baseArgs({ call: call({ from_phone: '+15555550177' }) }))).toMatchObject({ reason: 'caller_phone_not_on_file' });
    expect(planMakeup(baseArgs({ call: call({ customer_id: null }) }))).toMatchObject({ reason: 'customer_not_matched' });
    expect(planMakeup(baseArgs({ customer: customer({ id: 'someone-else' }) }))).toMatchObject({ reason: 'customer_not_matched' });
  });

  test('inferred speaker labels cannot authorize a move', () => {
    expect(planWithLabelTrust(baseArgs())).toMatchObject({ reason: 'untrusted_speaker_labels' });
  });

  test('low or missing scheduling confidence is skipped', () => {
    expect(planMakeup(baseArgs({ v2: v2({ confidence: { scheduling_window: 0.5 } }) }))).toMatchObject({ reason: 'low_scheduling_confidence' });
    expect(planMakeup(baseArgs({ v2: v2({ confidence: { scheduling_window: null } }) }))).toMatchObject({ reason: 'low_scheduling_confidence' });
  });

  test('a confirmed start in the past, or off the hour, is skipped', () => {
    expect(planMakeup(baseArgs({ now: new Date('2026-10-21T00:00:00Z') }))).toMatchObject({ reason: 'confirmed_start_in_past' });
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { confirmed_start_at: '2026-10-20T17:30:00-04:00' } }) }))).toMatchObject({ reason: 'off_grid_start_time' });
  });

  test('spam, voicemail, a non-decision-maker and a do-not-contact request are skipped', () => {
    expect(planMakeup(baseArgs({ v2: v2({ meta: { is_spam: true } }) }))).toMatchObject({ reason: 'spam' });
    expect(planMakeup(baseArgs({ v2: v2({ meta: { is_voicemail: true } }) }))).toMatchObject({ reason: 'voicemail' });
    expect(planMakeup(baseArgs({ v2: v2({ caller: { decision_maker_present: false } }) }))).toMatchObject({ reason: 'caller_not_decision_maker' });
    expect(planMakeup(baseArgs({ v2: v2({ consent: { do_not_contact_request: true } }) }))).toMatchObject({ reason: 'do_not_contact_requested' });
    expect(planMakeup(baseArgs({ v2: null }))).toMatchObject({ reason: 'no_v2_extraction' });
  });

  test('the caller must have accepted, and an agent who did not commit fails closed', () => {
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { caller_accepted_slot: false } }) }))).toMatchObject({ action: 'skip', reason: 'caller_did_not_accept' });
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { caller_accepted_slot: null } }) }))).toMatchObject({ action: 'skip', reason: 'caller_did_not_accept' });
    expect(planMakeup(baseArgs({ v2: v2({ scheduling: { agent_committed_booking: false } }) }))).toMatchObject({ action: 'skip', reason: 'agent_did_not_commit' });
  });

  test('an inbound caller the carrier did not fully attest holds for review; an outbound call needs no attestation', () => {
    for (const metadata of [{ stir_verstat: 'TN-Validation-Passed-B' }, { stir_verstat: 'TN-Validation-Passed-C' }, { stir_verstat: 'No-TN-Validation' }, {}, null]) {
      expect(planMakeup(baseArgs({ call: call({ metadata }) }))).toMatchObject({ action: 'needs_review', reason: 'caller_not_attested', visitId: VISIT_ID });
    }
    expect(planMakeup(baseArgs({ call: call({ metadata: JSON.stringify({ stir_verstat: 'TN-Validation-Passed-A' }) }) }))).toMatchObject({ action: 'apply' });
    const outbound = call({ direction: 'outbound-dial', from_phone: '+15555550100', to_phone: PHONE, metadata: null });
    expect(planMakeup(baseArgs({ call: outbound }))).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('the move stands in for the booking only: no booking slot, or a different one, is skipped', () => {
    expect(planMakeup(baseArgs({ bookingSlot: null }))).toMatchObject({ action: 'skip', reason: 'not_the_booking_slot' });
    expect(planMakeup(baseArgs({ bookingSlot: '2026-10-20T18:00' }))).toMatchObject({ action: 'skip', reason: 'not_the_booking_slot' });
    expect(planMakeup(baseArgs({ bookingSlot: '2026-10-21T17:00' }))).toMatchObject({ action: 'skip', reason: 'not_the_booking_slot' });
    expect(planMakeup(baseArgs({ bookingSlot: '2026-10-20T17:00:00-04:00' }))).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('a visit at another saved property is not a candidate when the call is about the primary one', () => {
    const other = visit({ property_id: 'prop-2' });
    const props = [{ id: 'prop-2', active: true, address_line1: '200 Other Road', city: 'Bradenton', zip: '34205' }];
    expect(planMakeup(baseArgs({ candidates: [other], properties: props }))).toMatchObject({ action: 'skip', reason: 'property_needs_review' });
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

// ── applier against a mocked connection ─────────────────────────────────
function makeConn({ prior = null, cust = customer(), visits = [visit()], logs = [noshow()], properties = [], extraction = v2(),
  settledCall = {}, handled = false, moved = false, portalRequest = null, smsOffer = false, callBooking = null } = {}) {
  const writes = { updates: [], inserts: [] };
  const offerRows = smsOffer ? [{ id: 'pending-offer', notes: JSON.stringify({ option1: { date: '2026-10-24', window: { start: '08:00', end: '09:00' } } }) }] : [];
  const builder = (table) => {
    const state = { table, where: [], whereIn: [], nullCols: [], updateArg: null };
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
        if (table === 'scheduled_services' && state.where.some(([w]) => w && typeof w === 'object' && 'source_call_log_id' in w)) return Promise.resolve(callBooking || undefined);
        if (table === 'scheduled_services') return Promise.resolve(visits[0]);
        return Promise.resolve(undefined);
      },
      then(resolve, reject) {
        if (table === 'customer_properties') return Promise.resolve(properties).then(resolve, reject);
        if (table === 'reschedule_log') {
          if (state.nullCols.includes('customer_response')) return Promise.resolve(offerRows).then(resolve, reject);
          if (state.nullCols.includes('resolved_at')) return Promise.resolve(logs).then(resolve, reject);
          return Promise.resolve([]).then(resolve, reject);
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
const applyArgs = (conn, rebooker, over = {}) => ({ conn, call: call(), procToken: 'tok-1', procGeneration: 3, now: NOW, rebooker, bookingSlot: BOOKING_SLOT, ...over });

describe('applyCallMakeupMove', () => {
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
    expect(opts).toMatchObject({ keepStatus: true, notifyRequested: false, expect: { scheduled_date: '2026-10-13', window_start: '09:00:00', status: 'confirmed', is_recurring: true } });
    expect(opts).not.toHaveProperty('seriesPolicy');

    const activity = conn.writes.inserts.find((i) => i.table === 'activity_log');
    expect(activity.row.action).toBe(MAKEUP_ACTIVITY_ACTION);
    expect(JSON.parse(activity.row.metadata)).toMatchObject({ call_log_id: CALL_ID, scheduled_service_id: VISIT_ID, noshow_log_id: NOSHOW_ID,
      from: { date: '2026-10-13' }, to: { date: '2026-10-20', start: '17:00', end: '18:00' } });
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

  test('a reprocess finds its own marker and is a no-op (no move, no booking)', async () => {
    const conn = makeConn({ prior: { metadata: JSON.stringify({ call_log_id: CALL_ID, scheduled_service_id: VISIT_ID }) } });
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'noop', reason: 'already_applied', visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('no missed visit: skipped, nothing written, rebooker untouched (today\'s booking runs)', async () => {
    const conn = makeConn({ logs: [] });
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'skipped', reason: 'no_missed_visit' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(conn.writes.inserts).toHaveLength(0);
    expect(conn.writes.updates).toHaveLength(0);
  });

  test('a normal reschedule call (reschedule_requested) is skipped by this lane', async () => {
    const conn = makeConn({ extraction: v2({ scheduling: { status: 'reschedule_requested' } }) });
    expect(await applyCallMakeupMove(applyArgs(conn, { reschedule: jest.fn() }))).toMatchObject({ outcome: 'skipped', reason: 'not_a_confirmed_slot' });
  });

  test.each([
    ['a pass that lost the claim', { processing_token: 'other-token' }, 'superseded_by_newer_pass'],
    ['a newer generation', { processing_generation: 4 }, 'superseded_by_newer_pass'],
    ['a finalized call link edit', { customer_id: 'another-customer' }, 'customer_link_changed'],
  ])('%s stands down', async (_label, settledCall, reason) => {
    const conn = makeConn({ settledCall });
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'skipped', reason });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a visit this call already booked (live or staff-cancelled) leaves it to the booking guards; seen during the move, it holds', async () => {
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(makeConn({ callBooking: { id: 'earlier-booking' } }), rebooker)))
      .toMatchObject({ outcome: 'skipped', reason: 'call_already_booked' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const conn = makeConn();
    const lateConn = makeConn({ callBooking: { id: 'earlier-booking' } });
    const racing = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => opts.moveGuard({ trx: lateConn, service: conn.visits[0] })) };
    expect(await applyCallMakeupMove(applyArgs(conn, racing))).toMatchObject({ outcome: 'needs_review', reason: 'handled_after_call' });
    expect(lateConn.writes.inserts).toHaveLength(0);
  });

  test('a move of the candidate after the call HOLDS (never books); only the candidate counts, and the no-show evidence row does not', async () => {
    const conn = makeConn({ moved: true });
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'handled_after_call', visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    // Scoped to the candidate visit: an unrelated visit's move never waves the duplicate booking through.
    expect(fs.readFileSync(require.resolve('../services/call-reschedule-apply'), 'utf8')).toMatch(/newerMove = \(trx, visitId\) => trx\('reschedule_log'\)\n\s+\.where\(\{ scheduled_service_id: visitId \}\)/);
    // The newer-move fence excludes customer_noshow rows (the evidence is itself one).
    const source = fs.readFileSync(require.resolve('../services/call-reschedule-apply'), 'utf8');
    expect(source).toMatch(/whereNot\('reason_code', 'customer_noshow'\)/);
  });

  test.each([
    ['an open portal reschedule request', { portalRequest: { id: 'req-1' } }, 'portal_request_open'],
    ['an outstanding reschedule-options text', { smsOffer: true }, 'pending_sms_offer'],
    ['a staff-handled card', { handled: true }, 'handled_by_staff'],
  ])('%s holds the booking for review', async (_label, state, reason) => {
    const conn = makeConn(state);
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason, visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('two missed candidates hold the booking and move nothing', async () => {
    const second = visit({ id: LAWN_VISIT_ID, scheduled_date: new Date('2026-10-10T00:00:00Z') });
    const conn = makeConn({ visits: [visit(), second], logs: [noshow(), noshow({ id: 'b2', scheduled_service_id: LAWN_VISIT_ID, original_date: '2026-10-10' })] });
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'ambiguous_missed_visit' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a portal request opened during the move is caught on the move transaction and holds', async () => {
    const conn = makeConn();
    // The request appears between the pre-check and the guard: the guard's own transaction sees it.
    const lateConn = makeConn({ portalRequest: { id: 'req-late' } });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => opts.moveGuard({ trx: lateConn, service: conn.visits[0] })) };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'handled_after_call' });
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
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      const settledConn = makeConn({ logs: [] });
      await opts.moveGuard({ trx: settledConn, service: conn.visits[0] });
    }) };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'changed_before_apply' });
  });

  test('a rebooker refusal (slot taken, bad window) HOLDS the booking and writes no activity row', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn().mockRejectedValue(Object.assign(new Error('slot taken'), { code: 'SLOT_TAKEN' })) };
    expect(await applyCallMakeupMove(applyArgs(conn, rebooker))).toMatchObject({ outcome: 'needs_review', reason: 'move_failed_SLOT_TAKEN', visitId: VISIT_ID });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('a failed reminder sync does not undo a committed move', async () => {
    AppointmentReminders.handleReschedule.mockRejectedValueOnce(new Error('sms provider down'));
    const conn = makeConn();
    expect(await applyCallMakeupMove(applyArgs(conn, guardedRebooker(conn)))).toMatchObject({ outcome: 'applied' });
  });
});

// ── processor wiring ────────────────────────────────────────────────────
describe('processor wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  describe('applyCallMakeupMoveStep', () => {
    const { applyCallMakeupMoveStep } = require('../services/call-recording-processor')._test;
    const applyModule = require('../services/call-reschedule-apply');
    afterEach(() => jest.restoreAllMocks());

    test('passes the claim and the resolved customer to the applier and returns its outcome', async () => {
      const spy = jest.spyOn(applyModule, 'applyCallMakeupMove').mockResolvedValue({ outcome: 'applied', visitId: VISIT_ID });
      const out = await applyCallMakeupMoveStep({ call: call({ customer_id: null }), callSid: 'CA1', customerId: CUSTOMER_ID, procToken: 'tok-1', procGeneration: 3 });
      expect(out).toEqual({ outcome: 'applied', visitId: VISIT_ID });
      expect(spy.mock.calls[0][0]).toMatchObject({ procToken: 'tok-1', procGeneration: 3, call: { id: CALL_ID, customer_id: CUSTOMER_ID } });
    });

    test('an unexpected throw HOLDS the booking (needs_review), it never falls back to booking', async () => {
      jest.spyOn(applyModule, 'applyCallMakeupMove').mockRejectedValue(new Error('db down'));
      expect(await applyCallMakeupMoveStep({ call: call(), callSid: 'CA1', customerId: CUSTOMER_ID, procToken: 't', procGeneration: 1 }))
        .toMatchObject({ outcome: 'needs_review', reason: 'makeup_check_failed' });
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

  test('the step runs only behind the gate, after every earlier veto, and BEFORE the booking transaction', () => {
    const gate = source.indexOf("isEnabled('callMakeupMove') && !v2RoutingBlocked && !legacyGeoVeto");
    expect(gate).toBeGreaterThan(-1);
    const stepCall = source.indexOf('await applyCallMakeupMoveStep(', gate);
    const chainStart = source.indexOf('    if (v2RoutingBlocked) {', gate);
    const appliedBranch = source.indexOf("} else if (makeupMove && makeupMove.outcome !== 'needs_review') {");
    const heldBranch = source.indexOf('} else if (makeupMove) {');
    const bookingBranch = source.indexOf('} else if (extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && canCreateAppointmentFromCall) {\n      // Declared OUTSIDE the try');
    expect(stepCall).toBeGreaterThan(gate);
    expect(chainStart).toBeGreaterThan(stepCall);
    expect(appliedBranch).toBeGreaterThan(chainStart);
    expect(heldBranch).toBeGreaterThan(appliedBranch);
    // Both make-up branches come before the booking branch, so a moved or held call never inserts.
    expect(bookingBranch).toBeGreaterThan(heldBranch);
  });

  test('applied: no schedule row is reported, so no confirmation text, and the enforce fallback files no card', () => {
    const start = source.indexOf("} else if (makeupMove && makeupMove.outcome !== 'needs_review') {");
    const block = source.slice(start, source.indexOf('} else if (makeupMove) {'));
    expect(block).toContain("skippedReason: 'makeup_move_applied'");
    expect(block).toContain('scheduleCreated: false');
    expect(block).toContain('smsSent: false');
    expect(block).not.toContain('scheduledServiceId');
    expect(source).toMatch(/const heldReasons = new Set\(\[[^\]]*'makeup_move_applied'\]\)/);
  });

  test('needs_review: held with a review card, never a new visit', () => {
    const start = source.indexOf('} else if (makeupMove) {');
    const block = source.slice(start, source.indexOf('} else if (extracted.appointment_confirmed', start));
    expect(block).toContain("skippedReason: 'missed_visit_makeup_needs_review'");
    expect(block).toContain('fileSkippedBookingCard(');
    expect(block).toContain("bridgeNeedsConfirmation.push('missed_visit_makeup_needs_review')");
    expect(block).not.toContain('scheduledServiceId:');
    expect(block).not.toMatch(/insert\(/);
  });

  test('gate off: dark unless GATE_CALL_MAKEUP_MOVE is exactly true, and the step is its only reader', () => {
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
