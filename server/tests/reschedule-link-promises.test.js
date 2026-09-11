jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/triage-auto-resolve', () => ({ resolveRescheduleCards: jest.fn(async () => 1) }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));
const db = require('../models/db');
const { resolveRescheduleCards } = require('../services/triage-auto-resolve');
const links = require('../services/reschedule-link-promises');
const { parseETDateTime } = require('../utils/datetime-et');
const { gates } = require('../config/feature-gates');
const now = new Date('2030-01-07T12:00:00Z');
const quote = 'I will text you a reschedule link for that appointment.';
const customer = { id: 'customer', phone: '+15555550100', active: true };
const visit = { id: 'visit', customer_id: customer.id, scheduled_date: '2030-01-08', window_start: '09:00', window_end: '10:30',
  status: 'confirmed', service_type: 'WaveGuard', reschedule_token: 'token', property_address: '100 Example Street', property_unit: 'Unit 2' };
const call = { customer_id: customer.id, direction: 'inbound', from_phone: customer.phone, created_at: now,
  v2_extraction_status: 'valid', ai_extraction_enriched: { meta: {} }, transcription: `Agent: ${quote}\nCaller: Thank you.` };
const commitment = { confidence: 0.95, evidence: [{ quote, speaker: 'agent' }] };
const select = (extra = {}) => links.selectDiscussedVisit({ commitment, call, customer, candidates: [visit], now, ...extra });
beforeEach(() => resolveRescheduleCards.mockClear());

test('an explicit promise with one available visit identifies it; multiple visits stay in review', () => {
  expect(select().visit?.id).toBe('visit');
  expect(select({ candidates: [visit, { ...visit, id: 'other' }] }).reason).toBe('ambiguous_visit');
});

test.each([undefined, NaN, 0.89])('invalid or low promise confidence stays in review: %s', confidence => {
  expect(select({ commitment: { ...commitment, confidence } }).reason).toBe('promise_needs_review');
});

test('a caller request, conditional promise, or later revocation cannot send', () => {
  expect(select({ call: { ...call, transcription: `Caller: ${quote}` } }).reason).toBe('promise_needs_review');
  expect(select({ call: { ...call, transcription: `Agent: If that works, ${quote}` } }).reason).toBe('promise_needs_review');
  expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: Do not send the link.` } }).reason).toBe('promise_needs_review');
});

test('outbound source variants retain full phone identity', () => {
  expect(select({ call: { ...call, direction: 'outbound-api', from_phone: '+15555550200', to_phone: customer.phone } }).visit?.id).toBe('visit');
  expect(select({ customer: { ...customer, phone: '+445555550100' } }).reason).toBe('customer_identity');
});

test('each subject field must occur in its own source quote, and units remain distinct', () => {
  const subject = { quote: 'The appointment at 100 Example Street Unit 2.', address: '100 Example Street Unit 2' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}\nCaller: WaveGuard is my other service.` };
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, service: 'WaveGuard' } } }).reason).toBe('subject_not_grounded');
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [visit, { ...visit, id: 'unit-3', property_unit: 'Unit 3' }] }).visit?.id).toBe('visit');
});

test('a stated current date must bind to the canonical quoted weekday and time', () => {
  const weekday = parseETDateTime('2030-01-08T09:00').toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const subject = { quote: `My appointment is ${weekday} at 9 AM.`, visit_date: '2030-01-08' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject } }).visit?.id).toBe('visit');
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-09' } } }).reason).toBe('discussed_visit_unavailable');
});

test('dispatch-owned pending, elapsed and grouped visits stay in review', () => {
  expect(select({ candidates: [{ ...visit, visit_id: 'group' }] }).reason).toBe('visit_not_self_service');
  expect(select({ candidates: [{ ...visit, status: 'pending', source_action: 'ai_call_outbound_review' }] }).visit).toBeUndefined();
  expect(select({ now: parseETDateTime('2030-01-08T11:00') }).reason).toBe('visit_elapsed');
});

test('an inactive account cannot be promised a link the reschedule page refuses', () => {
  for (const active of [false, null, undefined]) {
    expect(select({ customer: { ...customer, active } }).reason).toBe('customer_inactive');
  }
});

test('a bare "I will text you a link" needs rescheduling language or a grounded subject', () => {
  const generic = 'I will text you a link.';
  const bare = { ...commitment, evidence: [{ quote: generic, speaker: 'agent' }] };
  const source = { ...call, transcription: `Agent: ${generic}\nCaller: Thank you.` };
  expect(select({ call: source, commitment: bare }).reason).toBe('promise_needs_review');
  // A subject with a grounded quote but no date/service/address names no
  // appointment, so it cannot stand in for the missing language.
  expect(select({ call: source, commitment: { ...bare, subject: { quote: 'Thank you.' } } }).reason).toBe('promise_needs_review');
  // Either half is enough on its own.
  const subjectQuote = 'That is for my WaveGuard service.';
  expect(select({ call: { ...call, transcription: `Agent: ${generic}\nCaller: ${subjectQuote}` },
    commitment: { ...bare, subject: { quote: subjectQuote, service: 'WaveGuard' } } }).visit?.id).toBe('visit');
  for (const spoken of ['I will text you a link to pick a new time for your appointment.',
    'I will send you a link to move your appointment.', 'Let me text you a link to re-schedule that visit.']) {
    expect(select({ call: { ...call, transcription: `Agent: ${spoken}` },
      commitment: { ...commitment, evidence: [{ quote: spoken, speaker: 'agent' }] } }).visit?.id).toBe('visit');
  }
});

test('generic slot wording and first-booking wording are not a reschedule promise', () => {
  for (const spoken of ['I will text you a link to choose a time for your new service.',
    'I will text you a link to pick a new time.', 'I will text you a link to get you on the schedule.']) {
    expect(select({ call: { ...call, transcription: `Agent: ${spoken}` },
      commitment: { ...commitment, evidence: [{ quote: spoken, speaker: 'agent' }] } }).reason).toBe('promise_needs_review');
  }
});

test('an agent who takes the promise back later in the call stops the send', () => {
  const retracted = `${call.transcription}\nAgent: Actually I cannot send that link, the office will call you.`;
  expect(select({ call: { ...call, transcription: retracted } }).reason).toBe('promise_needs_review');
  // An ordinary later turn is not a retraction, and a retraction spoken
  // BEFORE the promise does not reach back over it.
  expect(select({ call: { ...call, transcription: `${call.transcription}\nAgent: You are all set, have a good day.` } }).visit?.id).toBe('visit');
  expect(select({ call: { ...call, transcription: `Agent: I cannot send that link yet.\nAgent: ${quote}` } }).visit?.id).toBe('visit');
});

// A knex stand-in that records the filters the reconciliation builds and the
// writes it makes. Only the shapes this module actually uses are modelled.
function fakeConn({ rows = [], selfServe = null } = {}) {
  const seen = { statusAllowlist: null, logFilters: [], updates: [] };
  const build = (table) => {
    const state = { eq: {}, ranges: [] };
    const b = {};
    const pass = (fn) => (...args) => { if (fn) fn(...args); return b; };
    Object.assign(b, {
      whereNotNull: pass(), orWhereNotNull: pass(), whereNot: pass(), orWhere: pass(), whereRaw: pass(),
      orderBy: pass(), limit: pass(),
      whereIn: pass((col, values) => { if (table === 'outbox_messages' && col === 'status') seen.statusAllowlist = values; }),
      where: pass((first, op, value) => {
        if (typeof first === 'function') first.call(b);
        else if (first && typeof first === 'object') Object.assign(state.eq, first);
        else state.ranges.push({ col: first, op, value });
      }),
      modify: (fn) => { fn(b); return b; },
      select: async () => (table === 'outbox_messages' ? rows : []),
      first: async () => {
        if (table === 'reschedule_log') { seen.logFilters.push({ eq: { ...state.eq }, ranges: [...state.ranges] }); return selfServe; }
        return null;
      },
      update: async (patch) => { seen.updates.push({ table, eq: { ...state.eq }, patch }); return 1; },
    });
    return b;
  };
  const conn = (table) => build(table);
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.transaction = async (fn) => fn(conn);
  return { conn, seen };
}

const sentRow = { id: 'outbox', status: 'sent', commitment_id: 'commitment', related_call_log_id: 'call',
  related_scheduled_service_id: 'visit', sent_at: new Date('2030-01-07T12:00:00Z') };

test('a replay that moved nothing closes no cards; a real self-serve move does', async () => {
  const none = fakeConn({ rows: [sentRow], selfServe: null });
  expect(await links.resolveUsedLink(none.conn, 'visit')).toBe(0);
  expect(resolveRescheduleCards).not.toHaveBeenCalled();
  expect(none.seen.updates).toEqual([]);
  // The proof is a customer_self_serve reschedule_log row created after the
  // link went out — not the POST itself.
  expect(none.seen.logFilters[0].eq).toMatchObject({ scheduled_service_id: 'visit', initiated_by: 'customer_self_serve' });
  expect(none.seen.logFilters[0].ranges).toContainEqual({ col: 'created_at', op: '>=', value: sentRow.sent_at });

  const moved = fakeConn({ rows: [sentRow], selfServe: { id: 'log' } });
  expect(await links.resolveUsedLink(moved.conn, 'visit')).toBe(1);
  expect(resolveRescheduleCards).toHaveBeenCalledWith(moved.conn, 'call', expect.any(String), 'visit');
  expect(moved.seen.updates).toEqual([expect.objectContaining({ table: 'outbox_messages', eq: { id: 'outbox' } })]);
});

test('a link used after the row was parked still closes its cards and the call', async () => {
  const parked = { ...sentRow, status: 'review' };
  const { conn, seen } = fakeConn({ rows: [parked], selfServe: { id: 'log' } });
  expect(await links.reconcileUsedLinks(conn)).toBe(1);
  // Parked rows are inside the reconciliation allowlist (an attempt was made
  // even though the carrier receipt never arrived).
  expect(seen.statusAllowlist).toContain('review');
  expect(resolveRescheduleCards).toHaveBeenCalledWith(conn, 'call', expect.any(String), 'visit');
  // The promise's own exception card closes, and review_status resyncs.
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'triage_items', patch: expect.objectContaining({ status: 'resolved' }) }));
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ review_status: 'resolved' }) }));
});

test('a busy send interlock is a retryable block, and the gate off is a pass-through', async () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  const priorClient = db.client;
  const core = jest.fn(async () => ({ sent: true }));
  const input = { customerId: 'customer', body: 'x', metadata: { followThroughCommitmentId: 'commitment' } };
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
    const connection = { query: jest.fn(async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); }) };
    db.client = { acquireRawConnection: jest.fn(async () => connection), destroyRawConnection: jest.fn(async () => {}) };
    // No provider attempt was made, so this is a retry — never an unknown
    // provider outcome for the office.
    expect(await links.withSendLock(input, core)).toMatchObject({ sent: false, blocked: true, retryable: true, code: 'LINK_LOCK_BUSY' });
    expect(core).not.toHaveBeenCalled();
    expect(db.client.destroyRawConnection).toHaveBeenCalledWith(connection);

    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
    expect(await links.withSendLock(input, core)).toEqual({ sent: true });
    expect(core).toHaveBeenCalledWith(input);
    expect(db.client.acquireRawConnection).toHaveBeenCalledTimes(1);
  } finally {
    if (priorClient === undefined) delete db.client; else db.client = priorClient;
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});

test('the commitment gate and explicit shadow/true modes are required', () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    for (const value of ['', 'false', 'on']) { process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = value; expect(links.mode()).toBe('off'); }
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow'; expect(links.mode()).toBe('shadow');
    gates.callCommitments = false; expect(links.mode()).toBe('off');
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});
