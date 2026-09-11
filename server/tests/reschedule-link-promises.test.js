jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/triage-auto-resolve', () => ({ resolveRescheduleCards: jest.fn(async () => 1) }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
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

test('a stated current date must match the candidate visit exactly', () => {
  const weekday = parseETDateTime('2030-01-08T09:00').toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const subject = { quote: `My appointment is ${weekday} at 9 AM.`, visit_date: '2030-01-08' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject } }).visit?.id).toBe('visit');
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-09' } } }).reason).toBe('discussed_visit_unavailable');
});

test('dispatch-owned pending and grouped visits stay in review', () => {
  expect(select({ candidates: [{ ...visit, visit_id: 'group' }] }).reason).toBe('visit_not_self_service');
  expect(select({ candidates: [{ ...visit, status: 'pending', source_action: 'ai_call_outbound_review' }] }).visit).toBeUndefined();
});

test('a missed appointment is still promised the link the page would honour', () => {
  // /reschedule/:token treats a pending or confirmed visit whose window has
  // passed as MISSED, not served, and still lets the customer pick a new time.
  // The call right after a missed visit is the one most likely to be promised
  // this link, so the worker reaches the page's own verdict.
  expect(select({ now: parseETDateTime('2030-01-08T11:00') }).visit?.id).toBe('visit');
  expect(select({ now: parseETDateTime('2030-02-01T09:00') }).visit?.id).toBe('visit');
  // Still inside the quoted two-hour arrival window: not missed, and eligible
  // for the same reason.
  expect(select({ now: parseETDateTime('2030-01-08T10:45') }).visit?.id).toBe('visit');
  // Terminal and live states are still refused, elapsed or not.
  for (const status of ['completed', 'cancelled', 'en_route', 'rescheduled']) {
    expect(select({ candidates: [{ ...visit, status }], now: parseETDateTime('2030-01-08T11:00') }).reason).toBe('visit_not_self_service');
  }
});

test('an emailed link is office work, not a silent SMS', () => {
  const emailed = 'I will email you a reschedule link for that appointment.';
  expect(select({ call: { ...call, transcription: `Agent: ${emailed}` },
    commitment: { ...commitment, evidence: [{ quote: emailed, speaker: 'agent' }] } }).reason).toBe('channel_unsupported');
  // An extracted channel the one SMS pipeline cannot keep parks the same way,
  // whatever the quote says.
  expect(select({ commitment: { ...commitment, channel: 'email' } }).reason).toBe('channel_unsupported');
  // "email or text" names a channel this worker can keep, and an absent or
  // unknown channel is the default.
  const either = 'I will email or text you a reschedule link for that appointment.';
  expect(select({ call: { ...call, transcription: `Agent: ${either}` },
    commitment: { ...commitment, evidence: [{ quote: either, speaker: 'agent' }] } }).visit?.id).toBe('visit');
  for (const channel of [undefined, null, '', 'sms', 'unknown']) {
    expect(select({ commitment: { ...commitment, channel } }).visit?.id).toBe('visit');
  }
});

test('a stated appointment date binds by exact match, not the new-booking slot rules', () => {
  const far = { ...visit, scheduled_date: '2030-09-20', window_start: '13:00', window_end: '15:00' };
  const subject = { quote: 'My September 20 appointment.', visit_date: '2030-09-20' };
  // Months out, no weekday word and no time word: all three were refused by
  // the new-booking slot validator even though the date matched exactly.
  expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` },
    commitment: { ...commitment, subject }, candidates: [far] }).visit?.id).toBe('visit');
  // A quote that contradicts the stated date still binds nothing.
  for (const spoken of ['My September 27 appointment.', 'My October 20 appointment.', 'My appointment on the 27th.']) {
    expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: ${spoken}` },
      commitment: { ...commitment, subject: { quote: spoken, visit_date: '2030-09-20' } }, candidates: [far] })
      .reason).toBe('discussed_visit_unavailable');
  }
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

// A knex stand-in that records the filters the worker builds and the writes it
// makes. Only the shapes this module actually uses are modelled; builders are
// thenable the way knex's are.
function fakeConn({ outbox = [], selfServe = null, cards = [], throwOn = null } = {}) {
  const seen = { statusAllowlist: null, logFilters: [], updates: [], inserts: [], resolved: [] };
  const openCards = () => cards.filter((card) => !seen.resolved.includes(card.id));
  const build = (table) => {
    const name = String(table).split(' ')[0];
    const state = { eq: {}, ranges: [] };
    const rows = () => (name === 'outbox_messages' ? outbox : name === 'triage_items' ? openCards() : []);
    const b = {};
    const pass = (fn) => (...args) => { if (fn) fn(...args); return b; };
    Object.assign(b, {
      whereNotNull: pass(), orWhereNotNull: pass(), whereNot: pass(), whereNotIn: pass(), orWhere: pass(), whereRaw: pass(),
      whereNull: pass(), join: pass(), leftJoin: pass(), orderBy: pass(), limit: pass(), forUpdate: pass(), forShare: pass(),
      onConflict: () => ({ ignore: async () => 1 }),
      whereIn: pass((col, values) => { if (name === 'outbox_messages' && col === 'status') seen.statusAllowlist = values; }),
      where: pass((first, op, value) => {
        if (typeof first === 'function') first.call(b);
        else if (first && typeof first === 'object') Object.assign(state.eq, first);
        else state.ranges.push({ col: first, op, value });
      }),
      modify: (fn) => { fn(b); return b; },
      then: (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject),
      select: pass(),   // knex returns the builder; awaiting it yields the rows
      first: async () => {
        if (name === 'outbox_messages') {
          if (throwOn && state.eq.id === throwOn) throw new Error('Promised-link delivery evidence is truncated');
          if (state.eq.id !== undefined) return outbox.find((row) => row.id === state.eq.id) || null;
          return outbox[0] || null;
        }
        if (name === 'reschedule_log') { seen.logFilters.push({ eq: { ...state.eq }, ranges: [...state.ranges] }); return selfServe; }
        if (name === 'triage_items') return openCards()[0] || null;
        return null;
      },
      insert: async (data) => { seen.inserts.push({ table: name, data }); return [1]; },
      update: async (patch) => {
        seen.updates.push({ table: name, eq: { ...state.eq }, patch });
        if (name === 'triage_items' && patch.status === 'resolved' && state.eq.id) seen.resolved.push(state.eq.id);
        return 1;
      },
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
  const none = fakeConn({ outbox: [sentRow], selfServe: null });
  expect(await links.resolveUsedLink(none.conn, 'visit')).toBe(0);
  expect(resolveRescheduleCards).not.toHaveBeenCalled();
  expect(none.seen.updates).toEqual([]);
  // The proof is a customer_self_serve reschedule_log row created after the
  // link went out — not the POST itself.
  expect(none.seen.logFilters[0].eq).toMatchObject({ scheduled_service_id: 'visit', initiated_by: 'customer_self_serve' });
  expect(none.seen.logFilters[0].ranges).toContainEqual({ col: 'created_at', op: '>=', value: sentRow.sent_at });

  const moved = fakeConn({ outbox: [sentRow], selfServe: { id: 'log' } });
  expect(await links.resolveUsedLink(moved.conn, 'visit')).toBe(1);
  expect(resolveRescheduleCards).toHaveBeenCalledWith(moved.conn, 'call', expect.any(String), 'visit');
  expect(moved.seen.updates).toEqual([expect.objectContaining({ table: 'outbox_messages', eq: { id: 'outbox' } })]);
});

test('a link used after the row was parked still closes its cards and the call', async () => {
  const parked = { ...sentRow, status: 'review' };
  const { conn, seen } = fakeConn({ outbox: [parked], selfServe: { id: 'log' }, cards: [{ id: 'card', payload: { reschedule_link_promise: { commitment_id: 'commitment', commitment_ids: ['commitment'] } } }] });
  expect(await links.reconcileUsedLinks(conn)).toBe(1);
  // Parked rows are inside the reconciliation allowlist (an attempt was made
  // even though the carrier receipt never arrived).
  expect(seen.statusAllowlist).toContain('review');
  expect(resolveRescheduleCards).toHaveBeenCalledWith(conn, 'call', expect.any(String), 'visit');
  // The promise's own exception card closes, and review_status resyncs.
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'triage_items', patch: expect.objectContaining({ status: 'resolved' }) }));
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ review_status: 'resolved' }) }));
});

const promiseRow = (id, commitmentId, extra = {}) => ({ id, status: 'pending', commitment_id: commitmentId,
  related_call_log_id: 'call', related_customer_id: 'customer', related_scheduled_service_id: 'visit', payload: {}, ...extra });

// Drive one sweep tick with the gate in shadow so nothing can reach a
// customer, and return what the tick did.
async function sweepWith(options) {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  const fake = fakeConn(options);
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
    return { ...fake, result: await links.sweep(fake.conn, { now }) };
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
}

test('one unprocessable row cannot starve the rest of the sweep', async () => {
  // matchingSend throws outright for a customer with more than 200 matching
  // link messages, and that row is by definition the oldest unchanged item —
  // an unguarded loop would abort every later promise and the used-link
  // reconciliation on every tick, forever.
  const { seen, result } = await sweepWith({ outbox: [promiseRow('boom', 'first'), promiseRow('ok', 'second')], throwOn: 'boom' });
  expect(result).toMatchObject({ processed: 2, failed: 1, reconciled: 0 });
  // The failing row parks for the office instead of retrying invisibly...
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'boom' },
    patch: expect.objectContaining({ status: 'review', last_error: 'worker_error' }) }));
  // ...the later row is still processed...
  expect(seen.updates.some((u) => u.table === 'outbox_messages' && u.eq.id === 'ok')).toBe(true);
  // ...and used-link reconciliation still runs for both rows.
  expect(seen.logFilters).toHaveLength(2);
});

test('one call-level card speaks for every promise parked against the call', async () => {
  const card = { id: 'card', payload: { reschedule_link_promise: { commitment_id: 'first', commitment_ids: ['first'], reason: 'delivery_failed' } } };
  const { seen } = await sweepWith({ outbox: [promiseRow('boom', 'second')], throwOn: 'boom', cards: [card] });
  // A second parked promise joins the existing card rather than vanishing
  // behind the first one's id.
  const merged = seen.updates.find((u) => u.table === 'triage_items');
  expect(merged.patch.payload.reschedule_link_promise.commitment_ids).toEqual(['first', 'second']);
  expect(merged.patch.status).toBeUndefined();
  expect(seen.inserts.filter((i) => i.table === 'triage_items')).toHaveLength(0);
});

test('settling one promise leaves the card open for the promise still parked', async () => {
  const card = { id: 'card', payload: { reschedule_link_promise: { commitment_id: 'first', commitment_ids: ['first', 'second'] } } };
  const parked = { id: 'outbox', status: 'review', commitment_id: 'first', related_call_log_id: 'call',
    related_scheduled_service_id: 'visit', sent_at: new Date('2030-01-07T12:00:00Z') };
  const { conn, seen } = fakeConn({ outbox: [parked], selfServe: { id: 'log' }, cards: [card] });
  expect(await links.reconcileUsedLinks(conn)).toBe(1);
  const patched = seen.updates.find((u) => u.table === 'triage_items');
  expect(patched.patch.payload.reschedule_link_promise.commitment_ids).toEqual(['second']);
  expect(patched.patch.status).toBeUndefined();
  // The call stays in review while the second promise is still parked.
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ review_status: 'open' }) }));
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

// Run one send with the gate live and the module-level db answering from a
// fake, restoring both afterwards.
async function withLiveGate({ outbox = [], client }, fn) {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  const priorClient = db.client;
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
    db.client = client;
    db.mockImplementation(fakeConn({ outbox }).conn);
    return await fn();
  } finally {
    db.mockReset();
    if (priorClient === undefined) delete db.client; else db.client = priorClient;
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
}

const fakeInterlock = () => {
  const handlers = {};
  const connection = { query: jest.fn(async () => ({})), on: jest.fn((event, fn) => { handlers[event] = fn; }) };
  const client = { acquireRawConnection: jest.fn(async () => connection), destroyRawConnection: jest.fn(async () => {}) };
  return { handlers, connection, client };
};

test('an operator text only pays for the interlock when a promised link is live', async () => {
  const core = jest.fn(async () => ({ sent: true }));
  const admin = { customerId: 'customer', body: 'On our way.', metadata: { adminUserId: 'admin' } };

  // With the gate on, EVERY staff text reaches withSendLock. A customer with
  // no live promise must never pay for an unpooled connection or an advisory
  // lock — one cheap pooled lookup decides.
  const quiet = fakeInterlock();
  expect(await withLiveGate({ outbox: [], client: quiet.client }, () => links.withSendLock(admin, core))).toEqual({ sent: true });
  expect(quiet.client.acquireRawConnection).not.toHaveBeenCalled();
  expect(core).toHaveBeenCalledWith(admin);

  // A promise still waiting for the sweep does serialize.
  const live = fakeInterlock();
  expect(await withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client: live.client },
    () => links.withSendLock(admin, core))).toEqual({ sent: true });
  expect(live.client.acquireRawConnection).toHaveBeenCalledTimes(1);
  expect(live.connection.query).toHaveBeenCalledWith(expect.stringContaining('statement_timeout'));
  expect(live.client.destroyRawConnection).toHaveBeenCalledWith(live.connection);
});

test('an interlock that dies mid-send blocks at the provider boundary', async () => {
  const { handlers, client } = fakeInterlock();
  const input = { customerId: 'customer', body: 'x', metadata: { adminUserId: 'admin' }, preProviderCheck: async () => ({ ok: true }) };
  let healthy, afterLoss;
  await withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client }, () => links.withSendLock(input, async (locked) => {
    healthy = await locked.preProviderCheck({});
    // The unpooled connection dies while the provider call is being prepared.
    handlers.error(new Error('connection terminated unexpectedly'));
    afterLoss = await locked.preProviderCheck({});
    return { sent: true };
  }));
  expect(healthy).toEqual({ ok: true });
  // Reading knex's private __knex__disposed returned undefined here on any
  // other pool build, and the send went to the provider anyway.
  expect(afterLoss).toMatchObject({ ok: false, code: 'LINK_LOCK_LOST' });
});

test('an interlock connection that never arrives does not block an admin send', async () => {
  const core = jest.fn(async () => ({ sent: true }));
  const client = { acquireRawConnection: jest.fn(() => new Promise(() => {})), destroyRawConnection: jest.fn(async () => {}) };
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const admin = { customerId: 'customer', body: 'On our way.', metadata: { adminUserId: 'admin' } };
    const sending = withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client }, () => links.withSendLock(admin, core));
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(6000);
    expect(await sending).toEqual({ sent: true });
    expect(core).toHaveBeenCalledWith(admin);
  } finally {
    jest.useRealTimers();
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
