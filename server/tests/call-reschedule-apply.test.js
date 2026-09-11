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
const FRIDAY_QUOTE = 'We will see you on Friday September 25 at 10 AM.';
const MORNING_QUOTE = 'We will see you on Thursday September 24 at 9 AM.';

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
      confirmed_start_at: '2026-09-24T12:00:00-04:00',
    },
    property: { access_notes: 'Caller requested that the interior be serviced as well.' },
  };
  const merged = deepMerge(base, overrides);
  if (!Object.hasOwn(overrides, 'evidence')) merged.evidence = [{ field_path: '/scheduling/agent_committed_booking', speaker: 'agent',
    quote: merged.scheduling.confirmed_start_at === '2026-09-25T10:00:00-04:00' ? FRIDAY_QUOTE
      : merged.scheduling.confirmed_start_at === '2026-09-24T09:00:00-04:00' ? MORNING_QUOTE : QUOTE }];
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
  created_at: new Date('2026-09-22T19:07:24Z'), transcription: `Agent: ${QUOTE}\nAgent: ${FRIDAY_QUOTE}\nAgent: ${MORNING_QUOTE}\nCaller: Thank you.`, ...overrides,
});
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
  test('a different program near the destination cannot replace the requested service outside the span', () => {
    const args = { v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit({ scheduled_date: '2026-11-01' }), visit({ id: 'mosquito-visit', service_id: 'mosquito-monthly', service_type: 'Monthly Mosquito Control Service' })] };
    expect(planRescheduleFromCall(args).reason).toBe('no_visit_on_books');
    expect(planRescheduleFromCall({ ...args, candidates: [visit(), ...args.candidates.slice(1)] })).toMatchObject({ action: 'apply', visitId: VISIT_ID });
  });

  test('a coarse category or an ambiguous program name needs staff review', () => {
    const args = { v2: v2({ service_request: { specific_service_name: null } }), call: call(), customer: customer(), now: NOW, candidates: [visit()] };
    expect(planRescheduleFromCall(args).reason).toBe('service_needs_review');
    expect(planRescheduleFromCall({ ...args, v2: v2(), candidates: [visit(), visit({ id: 'other-program', service_id: 'different-program', scheduled_date: '2026-12-01' })] }).reason).toBe('service_needs_review');
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

  test('agent evidence must ground to the same slot and an affirmative agent turn', () => {
    const args = { v2: v2(), call: call(), customer: customer(), candidates: [visit()], now: NOW };
    expect(planRescheduleFromCall({ ...args, v2: v2({ evidence: [] }) }).reason).toBe('ungrounded_agent_commitment');
    expect(planRescheduleFromCall({ ...args, call: call({ transcription: `Caller: ${QUOTE}\nAgent: We will check.` }) }).reason).toBe('ungrounded_agent_commitment');
    expect(planRescheduleFromCall({ ...args, call: call({ transcription: `Caller: Can you come?\nAgent: If we have space. ${QUOTE}` }) }).reason).toBe('ungrounded_agent_commitment');
    expect(planRescheduleFromCall({ ...args, v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T13:00:00-04:00' } }) }).reason).toBe('ungrounded_agent_commitment');
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
      call: call(), customer: customer(), candidates: [visit()], now: NOW,
    });
    expect(plan).toMatchObject({ action: 'apply', dateMove: true, newDate: '2026-09-25', newWindow: { start: '10:00', end: '11:00' } });
  });

  test('reports already_at_requested_time when the visit is where the caller asked', () => {
    const plan = planRescheduleFromCall({
      v2: v2({ scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00' } }),
      call: call(), customer: customer(), candidates: [visit()], now: NOW,
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

  test('visit selection: none, ambiguous, grouped, dispatch-owned pending, far cadence sibling', () => {
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [], now: NOW }).reason).toBe('no_visit_on_books');
    const two = planRescheduleFromCall({
      v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit(), visit({ id: '70000000-0000-4000-8000-000000000002', scheduled_date: '2026-09-30' })],
    });
    expect(two).toMatchObject({ reason: 'ambiguous_visit', candidateIds: [VISIT_ID, '70000000-0000-4000-8000-000000000002'] });
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ visit_id: 'v1' })], now: NOW }).reason).toBe('grouped_visit');
    expect(planRescheduleFromCall({ v2: v2(), call: call(), customer: customer(), candidates: [visit({ source_action: 'ai_call_pipeline_followup' })], now: NOW }).reason).toBe('dispatch_owned_pending');
    // The agreed destination does not identify which quarterly occurrence the caller meant.
    const withSibling = planRescheduleFromCall({
      v2: v2(), call: call(), customer: customer(), now: NOW,
      candidates: [visit(), visit({ id: '70000000-0000-4000-8000-000000000003', scheduled_date: '2026-12-17', window_start: '14:00:00', window_end: '15:00:00' })],
    });
    expect(withSibling).toMatchObject({ action: 'skip', reason: 'ambiguous_visit', candidateIds: [VISIT_ID, '70000000-0000-4000-8000-000000000003'] });
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
        if (table === 'call_log') return Promise.resolve(owned ? { ...call(), processing_generation: 3, processing_token: null, v2_extraction_status: 'valid', ai_extraction_enriched: extraction, ...settledCall } : undefined);
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
    expect(await applyCallReschedule({ conn, call: call(), now: NOW, rebooker })).toMatchObject({ outcome: 'applied' });
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
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
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
    const result = await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
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
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
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
    await applyCallReschedule({ conn, call: call(), now: NOW, rebooker });
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
