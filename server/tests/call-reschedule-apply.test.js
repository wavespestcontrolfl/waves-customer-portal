// Call reschedule apply: the fail-closed planner and the applier's writes
// (rebooker call, access note, activity row, card resolve) against a mocked
// connection. Fixtures are fictitious (555-01xx numbers, synthetic ids).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-dispatch', () => ({ applySeriesMoveEffects: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((name) => name === 'callAgentCommitTrustedLabels' || actual.isEnabled(name)) };
});

const {
  planRescheduleFromCall: planWithLabelTrust,
  applyCallReschedule,
  MIN_SCHEDULING_CONFIDENCE,
  ACTIVITY_ACTION,
  RESCHEDULE_REASON_CODE,
  INITIATED_BY,
  priorApplicationStillMatchesLiveCall,
} = require('../services/call-reschedule-apply');

const AppointmentReminders = require('../services/appointment-reminders');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');

const planRescheduleFromCall = (args) => planWithLabelTrust({ transcriptLabelsTrusted: true, ...args });

const NOW = new Date('2026-09-22T19:20:00Z'); // 3:20 PM ET
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const CALL_ID = 'a0000000-0000-4000-8000-000000000001';
const VISIT_ID = '70000000-0000-4000-8000-000000000001';
const PHONE = '+15555550101';
const ADDRESS = { address_line1: '100 Example Street', city: 'Bradenton', zip: '34205' };
const QUOTE = 'We will see you on Thursday September 24 at 12 PM.';
const ACCEPT = 'Yes, that works.';

// The agent's commitment naming a slot, as the extraction would quote it:
// "We will see you on Thursday September 24 at 12 PM."
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const quoteFor = (startAt) => {
  const m = String(startAt).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
  if (!m) return QUOTE;
  const [year, month, day, hour] = m.slice(1).map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `We will see you on ${weekday} ${MONTHS[month - 1]} ${day} at ${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}.`;
};
// The words the extraction records for that slot (schema 1.17.0), each
// verbatim in quoteFor's sentence.
const wordsFor = (startAt) => {
  const m = String(startAt).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
  if (!m) return null;
  const [year, month, day, hour] = m.slice(1).map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return { day: `${weekday} ${MONTHS[month - 1]} ${day}`, hour: String(hour % 12 || 12), period: hour < 12 ? 'AM' : 'PM' };
};

function v2(overrides = {}) {
  const base = {
    meta: { is_spam: false, is_voicemail: false },
    caller: { decision_maker_present: true },
    consent: { do_not_contact_request: false },
    confidence: { scheduling_window: 0.99 },
    service_request: { primary_service_category: 'pest_general', specific_service_name: 'Quarterly Pest Control Service' },
    scheduling: {
      status: 'reschedule_requested',
      agent_committed_booking: true,
      caller_accepted_slot: true,
      // The extraction's own language judgements (schema 1.20.0).
      definite_commitment: true,
      relative_date_used: false,
      moved_appointment_relative_date_used: false,
      confirmed_start_at: '2026-09-24T12:00:00-04:00',
    },
    property: { access_notes: 'Caller requested that the interior be serviced as well.' },
  };
  const merged = deepMerge(base, overrides);
  if (!Object.hasOwn(overrides.scheduling || {}, 'agreed_slot_words')) {
    merged.scheduling.agreed_slot_words = wordsFor(merged.scheduling.confirmed_start_at);
  }
  // The extraction's pinned quotes: the agent's commitment naming the slot
  // (also the agreed-slot quote) and the caller's acceptance.
  if (!Object.hasOwn(overrides, 'evidence')) {
    const slot = quoteFor(merged.scheduling.confirmed_start_at);
    merged.evidence = [
      { field_path: '/scheduling/agent_committed_booking', speaker: 'agent', quote: slot },
      { field_path: '/scheduling/confirmed_start_at', speaker: 'agent', quote: slot },
      { field_path: '/scheduling/caller_accepted_slot', speaker: 'caller', quote: ACCEPT },
    ];
  }
  return merged;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
}

const call = (overrides = {}) => ({
  id: CALL_ID, customer_id: CUSTOMER_ID, direction: 'inbound', from_phone: PHONE, to_phone: '+15555550100',
  created_at: new Date('2026-09-22T19:07:24Z'), transcription: `Agent: ${QUOTE}\nCaller: ${ACCEPT}`, ...overrides,
});
// Each call carries only ITS OWN commitment (#4806 single-sentence rule: any
// later non-acknowledgement sentence — such as a second, different
// commitment bundled into one fixture transcript — ungrounds the first).
// A same-day time change, as a real "9 is early, make it noon" call says it.
const RETIME_TRANSCRIPT = `Agent: You are on September 24th at 9 AM.\nCaller: Can it be later?\nAgent: ${QUOTE}\nCaller: ${ACCEPT}`;
const callFor = (startAt, overrides = {}) => call({ transcription: `Agent: ${quoteFor(startAt)}\nCaller: ${ACCEPT}`, ...overrides });
const customer = (overrides = {}) => ({ id: CUSTOMER_ID, phone: PHONE, ...ADDRESS, ...overrides });
const visit = (overrides = {}) => {
  const row = {
    id: VISIT_ID, customer_id: CUSTOMER_ID, property_id: null, service_id: 'pest-quarterly', service_type: 'Quarterly Pest Control Service',
    scheduled_date: new Date('2026-09-24T00:00:00Z'), window_start: '09:00:00', window_end: '10:00:00',
    estimated_duration_minutes: null, status: 'pending', source_action: null, visit_id: null, internal_notes: null, is_recurring: true,
    self_booking_id: null, customer_confirmed: true,
    ...overrides,
  };
  // loadCandidates joins the catalog and the planner matches THAT name, so an
  // unrepointed row's catalog name is its own label. Only a test that sets
  // catalog_service_name explicitly diverges (a repoint or a deleted catalog
  // row); a row with no service_id has no catalog row at all.
  if (!Object.hasOwn(row, 'catalog_service_name')) row.catalog_service_name = row.service_id ? row.service_type : null;
  return row;
};

describe('planRescheduleFromCall', () => {
  test('a relative moved-appointment flag with no resolved date never falls back to the lone candidate', () => {
    const args = { call: call(), customer: customer(), candidates: [visit()], now: NOW };
    expect(planRescheduleFromCall({ ...args, v2: v2() })).toMatchObject({ action: 'apply', visitId: VISIT_ID });
    expect(planRescheduleFromCall({ ...args, v2: v2({ scheduling: { moved_appointment_relative_date_used: true, moved_appointment_date: null } }) }))
      .toMatchObject({ reason: 'reschedule_not_agreed', agreementReason: 'moved_relative_without_date' });
  });

  test('relative dates resolve against the call\'s start (callStartedAt), not the row\'s created_at', () => {
    // The call began 11:50 PM ET Sep 23; its post-call row was written at
    // 12:10 AM ET Sep 24. "In two days" is Sep 25 from the start date.
    const said = 'We will see you in two days at two PM.';
    const extraction = v2({
      scheduling: {
        confirmed_start_at: '2026-09-25T14:00:00-04:00', relative_date_used: true,
        agreed_slot_words: { day: 'in two days', hour: 'two', period: 'PM' },
      },
      evidence: [
        { field_path: '/scheduling/agent_committed_booking', speaker: 'agent', quote: said },
        { field_path: '/scheduling/confirmed_start_at', speaker: 'agent', quote: said },
        { field_path: '/scheduling/caller_accepted_slot', speaker: 'caller', quote: ACCEPT },
        { field_path: '/scheduling/relative_date_used', speaker: 'agent', quote: said },
      ],
    });
    const args = {
      v2: extraction, customer: customer(), candidates: [visit()], now: new Date('2026-09-24T04:30:00Z'),
      call: call({
        created_at: new Date('2026-09-24T04:10:00Z'), duration_seconds: 1200, metadata: { source: 'status_callback' },
        transcription: `Agent: ${said}\nCaller: ${ACCEPT}`,
      }),
    };
    expect(planRescheduleFromCall(args)).toMatchObject({ action: 'apply', visitId: VISIT_ID });
    // The same row read as a call that started at created_at lands on Sep 26.
    expect(planRescheduleFromCall({ ...args, call: { ...args.call, metadata: {} } }))
      .toMatchObject({ reason: 'reschedule_not_agreed', agreementReason: 'agreed_slot_words_mismatch' });
  });

  test('the extraction\'s language judgements gate the automatic apply (schema 1.20.0)', () => {
    const args = { call: call(), customer: customer(), candidates: [visit()], now: NOW };
    expect(planRescheduleFromCall({ ...args, v2: v2() })).toMatchObject({ action: 'apply', visitId: VISIT_ID });
    for (const [scheduling, agreementReason] of [
      [{ definite_commitment: false }, 'agent_commitment_not_definite'],
      [{ definite_commitment: null }, 'agent_commitment_not_definite'],
      [{ relative_date_used: null }, 'relative_date_unjudged'],
    ]) {
      expect(planRescheduleFromCall({ ...args, v2: v2({ scheduling }) })).toMatchObject({ reason: 'reschedule_not_agreed', agreementReason });
    }
  });

  test('a different program near the destination cannot replace the requested service outside the span', () => {
    const args = { v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit({ scheduled_date: '2026-11-01' }), visit({ id: 'mosquito-visit', service_id: 'mosquito-monthly', service_type: 'Monthly Mosquito Control Service' })] };
    expect(planRescheduleFromCall(args).reason).toBe('no_visit_on_books');
    expect(planRescheduleFromCall({ ...args, candidates: [visit(), ...args.candidates.slice(1)] })).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  // Coarse categories cannot tell programs apart: a call that names no
  // service stays in review, even when V2 is sure of the category and the
  // property holds one visit.
  test('a call that names no service stays in review', () => {
    const noName = v2({ service_request: { specific_service_name: null, primary_service_category: 'pest_general' },
      confidence: { primary_service_category: 0.99 } });
    expect(planRescheduleFromCall({ v2: noName, call: call(), customer: customer(), now: NOW, candidates: [visit()] }).reason)
      .toBe('service_needs_review');
  });

  // A named service that matches nothing is an explicit mismatch, never a
  // fallback: the call asked about quarterly pest, so the property's only
  // in-span visit (monthly mosquito) must not stand in for it.
  test('an explicitly named service that matches nothing stays in review', () => {
    const mosquito = visit({ id: 'mosquito-visit', service_id: 'mosquito-monthly', service_type: 'Monthly Mosquito Control Service' });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW, candidates: [mosquito] }).reason)
      .toBe('service_needs_review');
  });

  // A name matching two programs resolves only among THOSE programs and
  // never picks between them, near the destination or not; another
  // program the name does not match is no candidate at all.
  test('a name matching two programs never picks between them', () => {
    const base = { v2: v2(), call: call(), customer: customer(), now: NOW };
    const farTwin = visit({ id: 'other-program', service_id: 'different-program', scheduled_date: '2026-12-01' });
    expect(planRescheduleFromCall({ ...base, candidates: [visit(), farTwin] }))
      .toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, 'other-program'] });
    const nearTwin = visit({ id: 'other-program', service_id: 'different-program', scheduled_date: '2026-09-26' });
    expect(planRescheduleFromCall({ ...base, candidates: [visit(), nearTwin] }))
      .toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, 'other-program'] });
    const lawn = visit({ id: 'lawn-visit', service_id: 'lawn-program', service_type: 'Lawn Care Service', scheduled_date: '2026-12-01' });
    expect(planRescheduleFromCall({ ...base, candidates: [visit(), lawn] })).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  // A call about two services may cover a visit this path would leave
  // unmoved while it resolves the card: secondary categories keep it in
  // review even when the named service matches one visit.
  test('a call V2 files under more than one service category stays in review', () => {
    const base = { call: call(), customer: customer(), now: NOW, candidates: [visit()] };
    expect(planRescheduleFromCall({ ...base, v2: v2({ service_request: { secondary_categories: ['lawn_care'] } }) }).reason)
      .toBe('service_needs_review');
    expect(planRescheduleFromCall({ ...base, v2: v2({ service_request: { secondary_categories: [] } }) }))
      .toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  // The catch-all booking placeholder names no service yet: a visit on it
  // may be the one the caller means, so the call stays in review, and the
  // placeholder is never moved as the named service's visit.
  test('a visit on the catch-all placeholder service keeps the call in review', () => {
    const placeholder = (overrides) => visit({ service_id: 'general-appointment', catalog_service_key: 'general_appointment',
      catalog_service_name: 'Waves Pest Control Appointment', ...overrides });
    const base = { call: call(), customer: customer(), now: NOW };
    expect(planRescheduleFromCall({ ...base, v2: v2(), candidates: [visit(), placeholder({ id: 'placeholder', scheduled_date: '2026-12-01' })] }).reason)
      .toBe('service_needs_review');
    expect(planRescheduleFromCall({ ...base, v2: v2({ service_request: { specific_service_name: 'Waves Pest Control Appointment' } }),
      candidates: [placeholder()] }).reason).toBe('service_needs_review');
  });

  // An orphaned in-span row may be the caller's target, so it keeps even a
  // coarse two-program name in review rather than being narrowed away.
  test('an unresolved in-span visit keeps a multi-program name in review', () => {
    const farTwin = visit({ id: 'other-program', service_id: 'different-program', scheduled_date: '2026-12-01' });
    const orphan = visit({ id: 'orphan', service_id: 'retired-program', catalog_service_name: null, scheduled_date: '2026-09-25' });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW, candidates: [visit(), farTwin, orphan] }).reason)
      .toBe('service_needs_review');
  });

  // V2 records only the new slot, so nothing on the call says which of
  // several upcoming visits it replaces: with more than one, the call stays
  // in review, even for a time change on a visit's own day.
  test('with several upcoming visits and no moved appointment named, the call stays in review', () => {
    const december = visit({ id: 'dec-visit', scheduled_date: '2026-12-24' });
    const plan = (startAt, callerLine, now = NOW) => planRescheduleFromCall({ v2: v2({ scheduling: { confirmed_start_at: startAt } }),
      customer: customer(), candidates: [visit(), december], now,
      call: call({ transcription: `Caller: ${callerLine}\nAgent: ${quoteFor(startAt)}\nCaller: ${ACCEPT}` }) });
    // Moves to another day, whichever visit is nearer: September moved to
    // December 17, December moved to October 1.
    expect(plan('2026-12-17T12:00:00-05:00', 'Move my September 24th visit to December 17th at noon.'))
      .toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, 'dec-visit'] });
    expect(plan('2026-10-01T12:00:00-04:00', 'Move my December 24th visit to October 1st at noon.'))
      .toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, 'dec-visit'] });
    // A time change on September 24 itself: the call may be moving December's
    // visit onto that day.
    expect(plan('2026-09-24T12:00:00-04:00', 'Move the later quarterly visit to September 24 at noon.').reason).toBe('ambiguous_visit');
    // Once September is behind today, December 24 is the only upcoming visit.
    expect(plan('2026-12-17T12:00:00-05:00', 'Move it to December 17th at noon.', new Date('2026-09-25T19:00:00Z')))
      .toMatchObject({ action: 'apply', visitId: 'dec-visit' });
  });

  // The extraction names the appointment being moved (schema 1.16.0), and a
  // grounded quote naming that date picks it among several upcoming visits.
  test('the grounded moved appointment picks the visit among several', () => {
    const december = visit({ id: 'dec-visit', scheduled_date: '2026-12-24' });
    const plan = (startAt, movedDate, movedQuote, extra = {}) => {
      const slot = quoteFor(startAt);
      return planRescheduleFromCall({ customer: customer(), candidates: [visit(), december], now: NOW,
        v2: v2({ scheduling: {
          confirmed_start_at: startAt, moved_appointment_date: movedDate, moved_appointment_words: movedQuote.replace(/^my | visit$/g, ''),
        }, evidence: [
          { field_path: '/scheduling/agent_committed_booking', speaker: 'agent', quote: slot },
          { field_path: '/scheduling/confirmed_start_at', speaker: 'agent', quote: slot },
          { field_path: '/scheduling/caller_accepted_slot', speaker: 'caller', quote: ACCEPT },
          { field_path: '/scheduling/moved_appointment_date', speaker: 'caller', quote: movedQuote },
        ] }),
        call: call({ transcription: `Caller: Can you move ${extra.said || movedQuote}?\nAgent: ${slot}\nCaller: ${ACCEPT}` }) });
    };
    // December's visit moved to December 17: the named date picks it.
    expect(plan('2026-12-17T12:00:00-05:00', '2026-12-24', 'my December 24th visit'))
      .toMatchObject({ action: 'apply', visitId: 'dec-visit', from: { date: '2026-12-24' }, newDate: '2026-12-17' });
    // A same-day time change on September 24, named as such: no day needed in the slot quote.
    expect(plan('2026-09-24T12:00:00-04:00', '2026-09-24', 'my September 24th visit'))
      .toMatchObject({ action: 'apply', visitId: VISIT_ID });
    // A named date with no visit of the service is one we don't have.
    expect(plan('2026-12-17T12:00:00-05:00', '2026-12-10', 'my December 10th visit').reason).toBe('no_visit_on_books');
    // The moved date must be named by a quote actually said.
    expect(plan('2026-12-17T12:00:00-05:00', '2026-12-24', 'my December 24th visit', { said: 'my next visit' }))
      .toMatchObject({ reason: 'reschedule_not_agreed', agreementReason: 'moved_appointment_ungrounded' });
    // December 24 is 7 days from December 17, inside the span; one moved to
    // October 1 is 84 days away, outside it.
    expect(plan('2026-10-01T12:00:00-04:00', '2026-12-24', 'my December 24th visit').reason).toBe('no_visit_on_books');
  });

  // The unresolved-catalog guard covers the single-program path too: an
  // orphaned in-span visit may be the one the named service really means.
  // Ahead of the span, too: an orphaned December visit may be the one the
  // caller is moving, and it can never be weighed against the others.
  test('an unresolved upcoming visit outside the span keeps the call in review', () => {
    const orphanDecember = visit({ id: 'orphan-dec', service_id: 'retired-program', catalog_service_name: null, scheduled_date: '2026-12-24' });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW, candidates: [visit(), orphanDecember] }).reason)
      .toBe('service_needs_review');
  });

  test('an unresolved in-span visit keeps even a single matched program in review', () => {
    const orphan = visit({ id: 'orphan', service_id: 'retired-program', catalog_service_name: null, scheduled_date: '2026-09-25' });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW, candidates: [visit(), orphan] }).reason)
      .toBe('service_needs_review');
  });

  // A repoint leaves service_type stale, so the label alone can name the
  // requested program while the row now belongs to a different one (r8 P1).
  test('a stale service label cannot stand in for the catalog identity', () => {
    // Both land as service_needs_review — nothing matched the request, so the
    // office gets the card rather than the automation guessing from the label.
    const repointed = visit({ service_id: 'mosquito-monthly', catalog_service_name: 'Monthly Mosquito Control Service' });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW, candidates: [repointed] }).reason)
      .toBe('service_needs_review');
    // A row whose catalog entry is gone matches nothing rather than the label.
    const orphaned = visit({ catalog_service_name: null });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW, candidates: [orphaned] }).reason)
      .toBe('service_needs_review');
    // The catalog name still carries the alias contract.
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit({ catalog_service_name: 'Quarterly Pest Control Service - 1 hour - $117' })] }).action).toBe('apply');
    // A row that lost its catalog row (ON DELETE SET NULL clears service_id,
    // the key snapshot survives) has no identity left to match, whatever its
    // label says, and one that lost the placeholder names no service.
    for (const snapshot of ['pest_general_quarterly', 'general_appointment']) {
      expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW,
        candidates: [visit({ service_id: null, catalog_service_name: null, service_key_snapshot: snapshot })] }).reason).toBe('service_needs_review');
    }
    // A row that never named a catalog service cannot have been repointed —
    // its free-text label is the only identity it has ever had, so it keeps
    // matching on that.
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit({ service_id: null, catalog_service_name: null })] }).action).toBe('apply');
  });

  // outbound-review-confirm.js classifies an AI office-review booking by
  // source + customer_confirmed, NOT by status: a row some writer already
  // moved off 'pending' is still unactivated, and moving it trips the
  // rebooker's lazy activation (review card, reminders, card funnel) for a
  // booking nobody vetted (r6 P1).
  test('an unactivated AI office-review booking is never moved automatically, whatever its status', () => {
    for (const source of ['voice_agent', 'ai_call_outbound_review']) {
      for (const status of ['pending', 'confirmed']) {
        expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW,
          candidates: [visit({ source_action: source, status, customer_confirmed: false })] }).reason).toBe('office_review_unconfirmed');
      }
      // Once the office activated it, it is an ordinary visit again.
      expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), now: NOW,
        candidates: [visit({ source_action: source, status: 'confirmed', customer_confirmed: true })] }).action).toBe('apply');
    }
  });

  test('a known service-name alias retains the same catalog identity', () => {
    expect(planRescheduleFromCall({ v2: v2({ service_request: { specific_service_name: 'Quarterly Pest Control' } }), call: call(), customer: customer(), now: NOW,
      candidates: [visit({ service_type: 'Quarterly Pest Control Service - 1 hour - $117' })] }).action).toBe('apply');
  });

  test.each(['2026-09-24T12:30:00-04:00', '2026-09-24T12:00:30-04:00', '2026-09-24T12:00:00.500-04:00'])('rejects off-hour instant %s', (confirmed_start_at) => {
    expect(planRescheduleFromCall({ v2: v2({ scheduling: { confirmed_start_at } }), call: call(), customer: customer(), candidates: [visit()], now: NOW }).reason).toBe('off_grid_start_time');
  });

  // The linker matches a caller on any of the five identity columns, so the
  // applier's own identity check must accept the same set (GH codex r5 P2).
  test.each(['secondary_phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'])(
    'a caller on file through %s is still the customer', (col) => {
      const cust = customer({ phone: '+15555550199', [col]: '(555) 555-0101' });
      expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: cust, candidates: [visit()], now: NOW }))
        .toMatchObject({ action: 'apply', visitId: VISIT_ID });
    });

  test('a number on no identity column is still refused', () => {
    const cust = customer({ phone: '+15555550199', service_contact2_phone: '+15555550198' });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: cust, candidates: [visit()], now: NOW }).reason)
      .toBe('caller_phone_not_on_file');
  });

  test.each(['outbound', 'outbound-api', 'outbound-dial'])(
    'an %s call is identified by the dialed party, not the Waves line', (direction) => {
      const outbound = call({ direction, from_phone: '+15555550100', to_phone: PHONE });
      expect(planRescheduleFromCall({ v2: v2(), call: outbound, customer: customer(), candidates: [visit()], now: NOW }))
        .toMatchObject({ action: 'apply', visitId: VISIT_ID });
    });

  test('inferred speaker labels cannot authorize a move', () => {
    expect(planWithLabelTrust({ v2: v2(), call: call(), customer: customer(), candidates: [visit()], now: NOW }).reason).toBe('untrusted_speaker_labels');
  });

  test('formatted domestic phones match, while invalid and international suffixes do not', () => {
    const args = { v2: v2(), call: call(), candidates: [visit()], now: NOW };
    expect(planRescheduleFromCall({ ...args, customer: customer({ phone: '(555) 555-0101' }) }).action).toBe('apply');
    expect(planRescheduleFromCall({ ...args, customer: customer({ phone: '+445555550101' }) }).reason).toBe('caller_phone_not_on_file');
  });

  // The automatic path moves only on the extraction's own judgement that the
  // caller accepted, grounded in its quotes word for word
  // (call-reschedule-agreement.js).
  test('the extraction\'s agreement must be judged and its quotes grounded in the call', () => {
    const args = { v2: v2(), call: call(), customer: customer(), candidates: [visit()], now: NOW };
    const notAgreed = (overrides, reason) => expect(planRescheduleFromCall({ ...args, ...overrides }))
      .toMatchObject({ reason: 'reschedule_not_agreed', agreementReason: reason });
    notAgreed({ v2: v2({ scheduling: { caller_accepted_slot: false } }) }, 'caller_did_not_accept');
    notAgreed({ v2: v2({ evidence: [] }) }, 'agent_commitment_ungrounded');
    notAgreed({ call: call({ transcription: `Caller: ${QUOTE}\nAgent: We will check.` }) }, 'agent_commitment_ungrounded');
    notAgreed({ call: call({ transcription: `Agent: ${QUOTE}\nCaller: Thanks, bye.` }) }, 'caller_acceptance_ungrounded');
    // The slot quoted must be the slot extracted.
    notAgreed({ v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T13:00:00-04:00' }, evidence: [
      { field_path: '/scheduling/agent_committed_booking', speaker: 'agent', quote: QUOTE },
      { field_path: '/scheduling/confirmed_start_at', speaker: 'agent', quote: QUOTE },
      { field_path: '/scheduling/caller_accepted_slot', speaker: 'caller', quote: ACCEPT },
    ] }) }, 'agreed_slot_ungrounded');
    expect(planRescheduleFromCall({ ...args, v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T12:00:00-05:00' } }) }).reason).toBe('inconsistent_start_offset');
  });

  test('a stated saved property scopes the visit; an unstated property on a multi-property account stays open', () => {
    const properties = [{ id: 'a', ...ADDRESS }, { id: 'b', ...ADDRESS, address_line1: '200 Example Street' }];
    const args = { v2: v2(), call: call(), customer: customer(), properties, candidates: [visit({ property_id: 'a' })], now: NOW };
    expect(planRescheduleFromCall(args).reason).toBe('property_needs_review');
    const stated = v2({ property: { service_address: { street_line_1: '200 Example Street', city: ADDRESS.city, postal_code: ADDRESS.zip } } });
    expect(planRescheduleFromCall({ ...args, v2: stated }).reason).toBe('no_visit_on_books');
    expect(planRescheduleFromCall({ ...args, v2: stated, candidates: [...args.candidates, visit({ id: 'b-visit', property_id: 'b' })] })).toMatchObject({ action: 'apply', visitId: 'b-visit' });
  });

  test('applies a same-day time move on the single matching visit, keeping the duration', () => {
    const plan = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit()], now: NOW });
    expect(plan).toMatchObject({
      action: 'apply', visitId: VISIT_ID, dateMove: false, newDate: '2026-09-24',
      newWindow: { start: '12:00', end: '13:00' },
      from: { date: '2026-09-24', start: '09:00', end: '10:00' },
    });
    expect(plan.interiorNote).toMatch(/interior/);
  });

  test('a date move within the span is a dateMove on that visit', () => {
    const plan = planRescheduleFromCall({
      v2: v2({ scheduling: { confirmed_start_at: '2026-09-25T10:00:00-04:00' } }),
      call: callFor('2026-09-25T10:00:00-04:00'), customer: customer(), candidates: [visit()], now: NOW,
    });
    expect(plan).toMatchObject({ action: 'apply', dateMove: true, newDate: '2026-09-25', newWindow: { start: '10:00', end: '11:00' } });
  });

  test('reports already_at_requested_time when the visit is where the caller asked', () => {
    const plan = planRescheduleFromCall({
      v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00' } }),
      call: callFor('2026-09-24T09:00:00-04:00'), customer: customer(), candidates: [visit()], now: NOW,
    });
    expect(plan.action).toBe('already_at_requested_time');
  });

  test.each([
    ['not_a_reschedule', { scheduling: { status: 'confirmed' } }],
    ['cancel_not_automated', { scheduling: { status: 'canceled' } }],
    ['agent_did_not_commit', { scheduling: { agent_committed_booking: false } }],
    ['no_confirmed_start', { scheduling: { confirmed_start_at: null } }],
    ['low_scheduling_confidence', { confidence: { scheduling_window: MIN_SCHEDULING_CONFIDENCE - 0.01 } }],
    ['caller_not_decision_maker', { caller: { decision_maker_present: false } }],
    ['do_not_contact_requested', { consent: { do_not_contact_request: true } }],
    ['spam', { meta: { is_spam: true } }],
    ['voicemail', { meta: { is_voicemail: true } }],
    ['confirmed_start_in_past', { scheduling: { confirmed_start_at: '2026-09-01T12:00:00-04:00' } }],
    ['off_grid_start_time', { scheduling: { confirmed_start_at: '2026-09-24T12:10:00-04:00' } }],
    ['unparseable_confirmed_start', { scheduling: { confirmed_start_at: 'noon-ish' } }],
  ])('skips with %s', (reason, overrides) => {
    const plan = planRescheduleFromCall({ v2: v2(overrides), call: call(), customer: customer(), candidates: [visit()], now: NOW });
    expect(plan).toEqual(expect.objectContaining({ action: 'skip', reason }));
  });

  test('skips when the pipeline already created an appointment from this call', () => {
    const plan = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit()], appointmentCreated: true, now: NOW });
    expect(plan.reason).toBe('pipeline_created_appointment');
  });

  test('identity: unmatched call or a number not on file stays a card', () => {
    expect(planRescheduleFromCall({ v2: v2(), call: call({ customer_id: null }), customer: customer(), candidates: [visit()], now: NOW }).reason).toBe('customer_not_matched');
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: null, candidates: [visit()], now: NOW }).reason).toBe('customer_not_matched');
    expect(planRescheduleFromCall({ v2: v2(), call: call({ from_phone: '+15555550199' }), customer: customer(), candidates: [visit()], now: NOW }).reason).toBe('caller_phone_not_on_file');
    // Outbound: the dialed party is the customer.
    const out = planRescheduleFromCall({ v2: v2(), call: call({ direction: 'outbound', from_phone: '+15555550100', to_phone: PHONE }), customer: customer(), candidates: [visit()], now: NOW });
    expect(out.action).toBe('apply');
  });

  test('visit selection: none, ambiguous (in span), grouped, dispatch-owned pending, a second upcoming visit', () => {
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [], now: NOW }).reason).toBe('no_visit_on_books');
    const two = planRescheduleFromCall({
      v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit(), visit({ id: '70000000-0000-4000-8000-000000000002', scheduled_date: '2026-09-30' })],
    });
    expect(two).toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, '70000000-0000-4000-8000-000000000002'] });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ visit_id: 'v1' })], now: NOW }).reason).toBe('grouped_visit');
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ source_action: 'ai_call_pipeline_followup' })], now: NOW }).reason).toBe('dispatch_owned_pending');
    // A same-program sibling months out still counts: the call names the new
    // slot, not which visit it replaces, so a second upcoming visit keeps it
    // in review.
    const farSibling = planRescheduleFromCall({
      v2: v2(), call: call({ transcription: RETIME_TRANSCRIPT }), customer: customer(), now: NOW,
      candidates: [visit(), visit({ id: '70000000-0000-4000-8000-000000000003', scheduled_date: '2026-12-17', window_start: '14:00:00', window_end: '15:00:00' })],
    });
    expect(farSibling).toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, '70000000-0000-4000-8000-000000000003'] });
  });

  // Only visits from today on are ones the call could mean: a quarterly
  // customer whose next visit is the only one ahead resolves on it.
  test('visits behind today do not make the one upcoming visit ambiguous', () => {
    const candidates = [
      visit({ id: 'q-past', scheduled_date: '2026-06-24' }),
      visit({ id: VISIT_ID, scheduled_date: '2026-09-24' }),
    ];
    expect(planRescheduleFromCall({ v2: v2(), call: call({ transcription: RETIME_TRANSCRIPT }), customer: customer(), candidates, now: NOW }))
      .toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('duration falls back to estimated_duration_minutes, then 60', () => {
    const p = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ window_end: null, estimated_duration_minutes: 90 })], now: NOW });
    expect(p.newWindow).toEqual({ start: '12:00', end: '13:30' });
    const q = planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ window_start: null, window_end: null })], now: NOW });
    expect(q.newWindow).toEqual({ start: '12:00', end: '13:00' });
  });
});

// ── applier against a mocked connection ─────────────────────────────────
function makeConn({ owned = true, prior = null, cust = customer(), visits = [visit()], properties = [], extraction = v2(), settledCall = {}, handled = false, moved = false, openCards = 1, remaining = 0, portalRequest = null, smsOffer = false } = {}) {
  const writes = { updates: [], inserts: [] };
  // An actionable offer carries the option payload reschedule-sms replies to.
  // `true` is the canonical one; an array lets a test supply raw rows (e.g. the
  // response-less audit row every ordinary move leaves behind).
  const offerRows = smsOffer === true
    ? [{ id: 'pending-offer', notes: JSON.stringify({ option1: { date: '2026-09-30', window: { start: '08:00', end: '09:00' } } }) }]
    : (Array.isArray(smsOffer) ? smsOffer : []);
  let openRequest = portalRequest;
  const builder = (table) => {
    const state = { table, where: [], whereIn: [], updateArg: null };
    const q = {
      where(...a) { state.where.push(a); return q; },
      whereIn(...a) { state.whereIn.push(a); return q; },
      whereNotIn(...a) { (state.whereNotIn ||= []).push(a); return q; },
      whereNull() { state.nulled = true; return q; },
      leftJoin() { return q; },
      whereRaw() { return q; },
      orderBy() { return q; },
      count() { state.counted = true; return q; },
      forUpdate() { return q; },
      forShare() { return q; },
      modify(fn) { fn(q); return q; },
      select() { return q; },
      update(arg) { state.updateArg = arg; writes.updates.push({ table, arg, where: state.where, whereIn: state.whereIn, whereNotIn: state.whereNotIn || [] }); return q; },
      returning() { return Promise.resolve(Array.from({ length: table === 'triage_items' ? openCards : 1 }, (_, i) => ({ id: `card-${i}` }))); },
      insert(row) { writes.inserts.push({ table, row }); return Promise.resolve([{ id: 'act-1' }]); },
      first() {
        if (table === 'call_log') return Promise.resolve(owned ? { ...callFor(extraction?.scheduling?.confirmed_start_at), processing_generation: 3, processing_token: null, v2_extraction_status: 'valid', ai_extraction_enriched: extraction, ...settledCall } : undefined);
        if (table === 'activity_log') return Promise.resolve(prior);
        if (table === 'customers') return Promise.resolve(cust);
        if (table === 'triage_items') return Promise.resolve(state.counted ? { n: remaining } : (handled ? { id: 'handled-card' } : undefined));
        // Only the newer-move fence uses .first() on this table; the offer
        // fence selects rows and filters them in JS (see `then`).
        if (table === 'reschedule_log') return Promise.resolve(moved ? { id: 'later-move' } : undefined);
        if (table === 'service_requests') return Promise.resolve(openRequest || undefined);
        if (table === 'scheduled_services') return Promise.resolve(visits[0]);
        return Promise.resolve(undefined);
      },
      then(resolve, reject) {
        if (table === 'customer_properties') return Promise.resolve(properties).then(resolve, reject);
        // The pending-offer fence: pending (whereNull customer_response) rows
        // for one visit inside the 7-day window.
        if (table === 'reschedule_log') return Promise.resolve(state.nulled ? offerRows : []).then(resolve, reject);
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
  // A request the customer files between the pre-apply check and the move.
  conn.setPortalRequest = (row) => { openRequest = row; };
  return conn;
}

describe('applyCallReschedule', () => {
  beforeEach(() => {
    AppointmentReminders.handleReschedule.mockClear().mockResolvedValue({});
    emitDispatchJobUpdate.mockClear().mockResolvedValue({});
    require('../routes/admin-dispatch').applySeriesMoveEffects.mockClear();
  });

  test('a service identity edited during the move cannot receive the stale call decision', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => opts.moveGuard({ trx: conn,
      service: { ...conn.visits[0], service_id: 'mosquito-monthly', service_type: 'Monthly Mosquito Control Service' } })) };
    expect(await applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).toMatchObject({ reason: 'changed_before_apply' });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('a recurring move finishes its durable effects with customer notification disabled', async () => {
    const conn = makeConn({ extraction: v2({ scheduling: { confirmed_start_at: '2026-09-25T10:00:00-04:00' } }) });
    const result = { success: true, seriesMoveId: 'series-1', notifyRequested: false, rescheduledOccurrences: [{ id: 'later', date: '2026-10-25', conflicted: true }] };
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] }); return result;
    }) };
    expect(await applyCallReschedule({ conn, call: callFor('2026-09-25T10:00:00-04:00'), now: NOW, rebooker })).toMatchObject({ outcome: 'applied' });
    expect(rebooker.reschedule.mock.calls[0][5]).toMatchObject({ sourceSurface: 'call_reschedule', notifyRequested: false });
    expect(require('../routes/admin-dispatch').applySeriesMoveEffects).toHaveBeenCalledWith({ result, serviceId: VISIT_ID,
      newDate: '2026-09-25', newWindow: { start: '10:00', end: '11:00' }, notify: false, actorId: null, reasonText: null });
  });

  test.each([null, 'another-customer'])('a finalized link edit to %s cannot use the stale customer', async (customer_id) => {
    const conn = makeConn({ settledCall: { customer_id } });
    const rebooker = { reschedule: jest.fn() };
    expect(await applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).toMatchObject({ outcome: 'skipped', reason: 'customer_link_changed' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test.each([{ handled: true }, { moved: true }])('a later staff decision is checked on the move transaction: %j', async (state) => {
    const conn = makeConn(state);
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => opts.moveGuard({ trx: conn, service: conn.visits[0] })) };
    expect(await applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).toMatchObject({ outcome: 'skipped', reason: 'handled_after_call' });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('a link edit after planning is caught before the move writes', async () => {
    const settledCall = {};
    const conn = makeConn({ settledCall });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      settledCall.customer_id = null;
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
    }) };
    expect(await applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).toMatchObject({ outcome: 'skipped', reason: 'changed_before_apply' });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('moves the visit through the rebooker, notes the interior request, logs, resolves cards, sends nothing', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    const result = await applyCallReschedule({ conn, call: call(), procGeneration: 3, now: NOW, rebooker });

    expect(result).toMatchObject({ outcome: 'applied', visitId: VISIT_ID, newDate: '2026-09-24', newWindow: { start: '12:00', end: '13:00' }, cardsResolved: 1 });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(1);
    const [id, date, win, reason, by, opts] = rebooker.reschedule.mock.calls[0];
    expect([id, date, win, reason, by]).toEqual([VISIT_ID, '2026-09-24', { start: '12:00', end: '13:00' }, RESCHEDULE_REASON_CODE, INITIATED_BY]);
    expect(opts).toMatchObject({ keepStatus: true, seriesPolicy: 'single', expect: { scheduled_date: '2026-09-24', window_start: '09:00:00', window_end: '10:00:00' } });
    expect(reason.length).toBeLessThanOrEqual(30);
    expect(by.length).toBeLessThanOrEqual(20);

    const noteUpdate = conn.writes.updates.find((u) => u.table === 'scheduled_services');
    expect(noteUpdate.arg.internal_notes.sql).toContain('concat_ws');
    expect(noteUpdate.arg.internal_notes.bindings[1]).toMatch(/^Call 2026-09-22: Caller requested that the interior/);

    const activity = conn.writes.inserts.find((i) => i.table === 'activity_log');
    expect(activity.row.action).toBe(ACTIVITY_ACTION);
    expect(activity.row.customer_id).toBe(CUSTOMER_ID);
    expect(JSON.parse(activity.row.metadata)).toMatchObject({ call_log_id: CALL_ID, scheduled_service_id: VISIT_ID, to: { date: '2026-09-24', start: '12:00', end: '13:00' } });

    const cardUpdate = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(cardUpdate.arg).toMatchObject({ status: 'resolved', resolution_source: 'auto' });
    expect(cardUpdate.whereIn[0]).toEqual(['reason_code', ['reschedule_or_cancel', 'existing_appointment_coordination']]);
    const reviewSync = conn.writes.updates.find((u) => u.table === 'call_log');
    expect(reviewSync.arg.review_status).toBe('resolved');
    // Nothing customer-facing is touched.
    expect(conn.writes.inserts.map((i) => i.table)).toEqual(['activity_log']);
  });

  test('a date move does not pin seriesPolicy single (owner cadence ruling applies)', async () => {
    const conn = makeConn({ extraction: v2({ scheduling: { confirmed_start_at: '2026-09-25T10:00:00-04:00' } }) });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    await applyCallReschedule({ conn, call: callFor('2026-09-25T10:00:00-04:00'), now: NOW, rebooker });
    expect(rebooker.reschedule.mock.calls[0][5]).not.toHaveProperty('seriesPolicy');
  });

  test('review_status stays open when other cards remain', async () => {
    const conn = makeConn({ remaining: 2 });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(conn.writes.updates.find((u) => u.table === 'call_log').arg.review_status).toBe('open');
  });

  test('superseded passes stand down and unproven prior applications preserve cards', async () => {
    const rebooker = { reschedule: jest.fn() };
    const lost = makeConn({ owned: false });
    expect(await applyCallReschedule({ conn: lost, call: call(), procGeneration: 2, now: NOW, rebooker })).toEqual({ outcome: 'skipped', reason: 'superseded_by_newer_pass' });
    const dup = makeConn({ prior: { id: 'act-0' } });
    expect(await applyCallReschedule({ conn: dup, call: call(), now: NOW, rebooker })).toMatchObject({ outcome: 'skipped', reason: 'prior_application_requires_review' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(lost.writes.updates).toHaveLength(0);
    expect(dup.writes.updates).toHaveLength(0);
    expect(dup.writes.inserts).toHaveLength(0);
  });

  test('only the same applied source and live destination can retry card closure', async () => {
    const conn = makeConn();
    const mover = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.beforeMove(conn); await opts.moveGuard({ trx: conn, service: conn.visits[0] });
    }) };
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker: mover });
    const prior = conn.writes.inserts.find((row) => row.table === 'activity_log').row;
    const landed = visit({ window_start: '12:00:00', window_end: '13:00:00' });
    const retry = makeConn({ prior, visits: [landed] });
    expect(await applyCallReschedule({ conn: retry, call: call(), now: NOW })).toMatchObject({ reason: 'already_applied', cardsResolved: 1 });
    for (const patch of [{ settledCall: { processing_generation: 4 } }, { settledCall: { transcription: 'Corrected source' } }, { visits: [visit()] }]) {
      const changed = makeConn({ prior, visits: [landed], ...patch });
      expect(await applyCallReschedule({ conn: changed, call: call(), now: NOW })).toMatchObject({ reason: 'prior_application_requires_review' });
      expect(changed.writes.updates).toHaveLength(0);
    }

    // priorApplicationStillMatchesLiveCall (Codex #4721 r2 P1 on
    // call-recording-processor.js's disposition-revision retry path): the
    // SAME fixtures above, checked directly — a generation-only difference
    // still matches (the exact degree of freedom a crash-then-retry needs),
    // but a changed source or a visit no longer at the recorded destination
    // does not, even though an activity row exists either way.
    expect(await priorApplicationStillMatchesLiveCall(retry, call())).toBe(true);
    expect(await priorApplicationStillMatchesLiveCall(makeConn({ prior, visits: [landed], settledCall: { processing_generation: 4 } }), call())).toBe(true);
    expect(await priorApplicationStillMatchesLiveCall(makeConn({ prior, visits: [landed], settledCall: { transcription: 'Corrected source' } }), call())).toBe(false);
    expect(await priorApplicationStillMatchesLiveCall(makeConn({ prior, visits: [visit()] }), call())).toBe(false);
    // A destination parked for rebook keeps its date/window but is off the
    // books — neither caller may treat it as proof (Codex #4721 r4 P2).
    const parked = { ...landed, status: 'rescheduled' };
    expect(await priorApplicationStillMatchesLiveCall(makeConn({ prior, visits: [parked] }), call())).toBe(false);
    expect(await applyCallReschedule({ conn: makeConn({ prior, visits: [parked] }), call: call(), now: NOW })).toMatchObject({ reason: 'prior_application_requires_review' });
    // No durable row at all for this call.
    expect(await priorApplicationStillMatchesLiveCall(makeConn(), call())).toBe(false);
  });

  test('a skip stamps the open card payload with the reason and leaves it open', async () => {
    const conn = makeConn({ visits: [] });
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'no_visit_on_books' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const stamp = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(stamp.arg.payload.bindings[0]).toMatch(/"skipped":"no_visit_on_books"/);
    expect(stamp.arg).not.toHaveProperty('status');
  });

  test('a non-reschedule call writes nothing at all', async () => {
    const conn = makeConn({ extraction: v2({ scheduling: { status: 'confirmed' } }) });
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker: { reschedule: jest.fn() } });
    expect(result.reason).toBe('not_a_reschedule');
    expect(conn.writes.updates).toHaveLength(0);
    expect(conn.writes.inserts).toHaveLength(0);
  });

  test('already at the requested time: no move, cards resolved as moot', async () => {
    const conn = makeConn({ extraction: v2({ scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00' } }) });
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: callFor('2026-09-24T09:00:00-04:00'), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'noop', reason: 'already_at_requested_time', cardsResolved: 1 });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  // A row parked at 'rescheduled' is OUT of dispatch until someone rebooks it
  // (routes/schedule.js legacy flip). Reviving one reaches into the card-hold
  // park and the AI office-review supersession rule, so it stays a card.
  test('a parked rescheduled row is never moved automatically', async () => {
    const conn = makeConn({ visits: [visit({ status: 'rescheduled' })] });
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'visit_parked_for_rebook', visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const stamp = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(stamp.arg.payload.bindings[0]).toMatch(/"skipped":"visit_parked_for_rebook"/);
  });

  test('a pending row still keeps its status', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(rebooker.reschedule.mock.calls[0][5].keepStatus).toBe(true);
  });

  // The customer's portal reschedule request is a staff-owned track with its
  // own preferred date, lifecycle and (legacy flow) parked card hold — the
  // automation stands down rather than resolving it from here (r6 P1).
  test('an open portal reschedule request for the visit stands the automation down', async () => {
    const conn = makeConn({ portalRequest: { id: 'req-1' } });
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'portal_request_open', visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const req = conn.writes.updates.find((u) => u.table === 'service_requests');
    expect(req).toBeUndefined();
    const stamp = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(stamp.arg.payload.bindings[0]).toMatch(/"skipped":"portal_request_open"/);
  });

  test('a portal request opened during the move is caught on the move transaction', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      conn.setPortalRequest({ id: 'req-2' });
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'handled_after_call' });
    expect(conn.writes.inserts).toHaveLength(0);
  });

  // SmartRebooker never touches appointment_reminders, so without this sync
  // the 72h/24h reminder keeps the OLD slot — the failure this service exists
  // to prevent (r8 P1). coverDueWindows stays unset: this path sends no text,
  // so covering the due window would suppress the only notice of the new time.
  test('a single move resyncs reminders, broadcasts to dispatch, and still sends nothing', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith(VISIT_ID, '2026-09-24T12:00', { sendNotification: false });
    expect(AppointmentReminders.handleReschedule.mock.calls[0][2]).not.toHaveProperty('coverDueWindows');
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: VISIT_ID, actorId: null });
    expect(conn.writes.inserts.map((i) => i.table)).toEqual(['activity_log']);
  });

  test('a series move leaves the fan-out to the shared durable pass', async () => {
    const conn = makeConn({ extraction: v2({ scheduling: { confirmed_start_at: '2026-09-25T10:00:00-04:00' } }) });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true, seriesMoveId: 'series-1' };
    }) };
    await applyCallReschedule({ conn, call: callFor('2026-09-25T10:00:00-04:00'), now: NOW, rebooker });
    expect(require('../routes/admin-dispatch').applySeriesMoveEffects).toHaveBeenCalled();
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  });

  // The anchor moved under either shape, and the public reschedule route
  // syncs this row ahead of the same series/single split.
  test.each([
    ['a single move', { success: true }, '2026-09-24T12:00:00-04:00', '2026-09-24', '12:00', '13:00'],
    ['a series move', { success: true, seriesMoveId: 'series-1' }, '2026-09-25T10:00:00-04:00', '2026-09-25', '10:00', '11:00'],
  ])("a /book visit's confirmation snapshot moves with it: %s", async (_label, result, startAt, date, start, end) => {
    const conn = makeConn({ visits: [visit({ self_booking_id: 'sb-1' })], extraction: v2({ scheduling: { confirmed_start_at: startAt } }) });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return result;
    }) };
    await applyCallReschedule({ conn, call: callFor(startAt), now: NOW, rebooker });
    const snap = conn.writes.updates.find((u) => u.table === 'self_booked_appointments');
    expect(snap.arg).toMatchObject({ date, start_time: start, end_time: end });
    expect(snap.where).toContainEqual([{ id: 'sb-1' }]);
  });

  test('a failed reminder sync does not undo a committed move', async () => {
    const conn = makeConn();
    AppointmentReminders.handleReschedule.mockRejectedValueOnce(new Error('reminders down'));
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(result.outcome).toBe('applied');
    expect(emitDispatchJobUpdate).toHaveBeenCalled();
  });

  // An unanswered reschedule-options text is a live offer reschedule-sms still
  // honors for 7 days; a later '1' would rebook onto the stale slot (r8 P1).
  test('an outstanding SMS reschedule offer stands the automation down', async () => {
    const conn = makeConn({ smsOffer: true });
    const rebooker = { reschedule: jest.fn() };
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'pending_sms_offer', visitId: VISIT_ID });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    const stamp = conn.writes.updates.find((u) => u.table === 'triage_items');
    expect(JSON.stringify(stamp.arg)).toContain('pending_sms_offer');
  });

  // Every rebooker move leaves a response-less reschedule_log audit row. Only
  // a row carrying the option payload is an answerable offer — treating the
  // audit rows as offers would stand this path down for a week after any
  // ordinary staff move.
  test('a response-less audit row from an ordinary move is not an offer', async () => {
    const conn = makeConn({ smsOffer: [{ id: 'audit-1', notes: null }, { id: 'audit-2', notes: '{"reason":"admin"}' }, { id: 'audit-3', notes: 'not json' }] });
    const rebooker = { reschedule: jest.fn(async (_id, _date, _win, _reason, _by, opts) => {
      await opts.moveGuard({ trx: conn, service: conn.visits[0] });
      return { success: true };
    }) };
    expect(await applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).toMatchObject({ outcome: 'applied' });
  });

  test('a rebooker refusal propagates (the processor step logs it non-blocking) and no activity row is written', async () => {
    const conn = makeConn();
    const rebooker = { reschedule: jest.fn().mockRejectedValue(Object.assign(new Error('slot taken'), { statusCode: 409 })) };
    await expect(applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).rejects.toThrow('slot taken');
    expect(conn.writes.inserts).toHaveLength(0);
  });
});
