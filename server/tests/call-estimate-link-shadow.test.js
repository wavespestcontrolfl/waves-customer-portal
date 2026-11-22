/**
 * The record-only check for the after-call estimate text (services/call-estimate-link-shadow.js).
 *
 * Pins: every staging outcome; every decide stop, each one winning over all the stops after it;
 * the `would_send` record; the pinned estimate never being re-picked; a read that throws leaving the
 * row pending and then `undecided_after_24h`; a lost decide writing nothing; and that the module has
 * no way to send or mint anything. The raw SQL (jsonb filter, conditional UPDATE) is proved against
 * a real Postgres in call-estimate-link-shadow-postgres.test.js.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false) }));
// call-booking-link-text loads these at require time; the shadow job only needs its timing helpers.
jest.mock('../services/lead-consultation-link', () => ({ buildLeadConsultationSmsLine: jest.fn(), isUsPhone: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-auto-send', () => ({ isRealProviderSend: jest.fn(), isAmbiguousProviderOutcome: jest.fn() }));
jest.mock('../services/outbound-call-reason', () => ({
  hasPriorContact: jest.fn(),
  nanpStoredPhoneClause: jest.requireActual('../services/outbound-call-reason').nanpStoredPhoneClause,
}));
jest.mock('../services/call-booking-link-text', () => ({
  ...jest.requireActual('../services/call-booking-link-text'),
  bookedSinceCall: jest.fn(),
  visitStampedWithCall: jest.fn(),
}));
jest.mock('../services/estimate-follow-up', () => ({ hasRepliedSince: jest.fn() }));
jest.mock('../routes/estimate-public', () => ({ isEstimateCustomerViewable: jest.fn(), ESTIMATE_TOKEN_RE: /^[A-Za-z0-9_-]{15,64}$/ }));
jest.mock('../services/call-phone-yes-accept', () => ({ openEstimatesOf: jest.fn(), otherEstimateOpenAt: jest.fn() }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberHeld: jest.fn() }));
jest.mock('../utils/estimate-claim-sql', () => ({ callSideBlockForEstimateData: jest.fn() }));
jest.mock('../services/pricing-authority-gate', () => ({ estimateDeliverableUnderGate: jest.fn() }));
jest.mock('../services/messaging/policy', () => ({ resolvePolicy: jest.fn(() => ({ requireConsent: 'transactional' })) }));
jest.mock('../services/messaging/validators/consent', () => ({ loadContactState: jest.fn(), checkConsentForPurpose: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ loadSuppressionState: jest.fn(), checkSuppression: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const { bookedSinceCall, visitStampedWithCall } = require('../services/call-booking-link-text');
const { hasRepliedSince } = require('../services/estimate-follow-up');
const { openEstimatesOf, otherEstimateOpenAt } = require('../services/call-phone-yes-accept');
const { disclaimedNumberHeld } = require('../services/disclaimed-number-holds');
const { isEstimateCustomerViewable } = require('../routes/estimate-public');
const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
const { estimateDeliverableUnderGate } = require('../services/pricing-authority-gate');
const { loadContactState, checkConsentForPurpose } = require('../services/messaging/validators/consent');
const { loadSuppressionState, checkSuppression } = require('../services/messaging/validators/suppression');
const { CUSTOMER_ANSWERED_SQL } = require('../services/estimate-call-list');
const shadow = require('../services/call-estimate-link-shadow');

const KEY = 'call_estimate_link_shadow';
const NOW = new Date('2026-11-20T17:30:00.000Z'); // 12:30 ET
const CALL_START = new Date('2026-11-20T15:00:00.000Z'); // 10:00 ET, 120 s long: ends 15:02, send_at 17:02Z
const SEND_AT = '2026-11-20T17:02:00.000Z';
const HOUR = 60 * 60 * 1000;

// A knex stand-in: every builder method records its call and returns the builder; a function given to
// where() runs against the same recorder. `rows` answers an awaited builder, `first` answers .first(),
// `update` answers a write; each is a function of the recorded calls.
function fakeConn({ rows = {}, first = {}, update = () => 1 } = {}) {
  const queries = [];
  const written = [];
  const conn = jest.fn((table) => {
    const calls = [];
    queries.push({ table, calls });
    const builder = new Proxy({}, {
      get(_target, method) {
        if (method === 'then') return (resolve, reject) => Promise.resolve().then(() => rows[table]?.(calls) || []).then(resolve, reject);
        if (method === 'first') return async (...cols) => { calls.push(['first', ...cols]); return first[table]?.(calls); };
        if (method === 'update') return async (patch) => { calls.push(['update', patch]); return update(table, calls); };
        return (...args) => {
          calls.push([method, ...args]);
          if (method !== 'modify' && typeof args[0] === 'function') args[0].call(builder, builder);
          if (method === 'modify') args[0](builder);
          return builder;
        };
      },
    });
    return builder;
  });
  conn.raw = jest.fn((sql, bindings) => {
    if (/^COALESCE\(metadata/.test(sql)) written.push(JSON.parse(bindings[0])[KEY]);
    return 'RAW';
  });
  conn.written = written;
  conn.queried = (table) => queries.filter((q) => q.table === table);
  return conn;
}

const has = (calls, method, ...args) => calls.some((c) => c[0] === method && args.every((a, i) => JSON.stringify(c[i + 1]) === JSON.stringify(a)));

const baseCall = (over = {}) => ({
  id: 'call-1', customer_id: 'cust-1', direction: 'inbound', source: null, bridged_at: null, duration_seconds: 120,
  recording_duration_seconds: 0, created_at: CALL_START, updated_at_key: '2026-11-20 15:05:00.123456+00',
  processing_token: null, v2_extraction_status: 'valid', metadata: {}, estimate_answer: 'accepted', ...over,
});
const baseEstimate = (over = {}) => ({
  id: 'est-1', customer_id: 'cust-1', status: 'sent', archived_at: null, sent_at: new Date('2026-11-19T15:00:00.000Z'),
  expires_at: null, last_follow_up_at: null, customer_phone: '(941) 555-0123', estimate_data: {}, token: 'tok_AbCdEfGhIjKlMnOp1', ...over,
});

// ---- staging ---------------------------------------------------------------------------------------

// The first real handoff of the pinned estimate: before the call began.
const BEFORE_CALL = '2026-11-19T15:00:00.000Z';
const candidate = (id = 'est-1', handoffAt = BEFORE_CALL) => ({ id, handoff_at: handoffAt });

// `pin` = what the phone-yes card's openEstimatesOf answers (with each row's first-handoff time);
// `otherOpen` = what its otherEstimateOpenAt answers (another estimate open AT the call).
function stageWorld({ call = baseCall(), pin = [candidate()], otherOpen = false, update } = {}) {
  openEstimatesOf.mockResolvedValue(pin);
  otherEstimateOpenAt.mockResolvedValue(otherOpen);
  return fakeConn({ rows: { call_log: () => [call] }, update });
}

describe('stage: one record per yes-family call', () => {
  test('the scan filters in SQL on the stored path with bound values, and carries no extraction body', async () => {
    const conn = stageWorld({ call: baseCall() });
    await shadow.stage(conn, { now: NOW });
    const scan = conn.queried('call_log')[0].calls;
    expect(has(scan, 'where', 'v2_extraction_status', 'valid')).toBe(true);
    expect(has(scan, 'whereNull', 'processing_token')).toBe(true);
    expect(has(scan, 'whereRaw', 'metadata->:key IS NULL', { key: KEY })).toBe(true);
    expect(has(scan, 'whereRaw', "(ai_extraction_enriched->'service_request'->>'estimate_response') = ANY(?)", [['accepted', 'accepted_with_condition']])).toBe(true);
    expect(scan.some((c) => c[0] === 'select' && c.includes('ai_extraction_enriched'))).toBe(false);
  });

  test('updated_at is read as text, so a microsecond value the Date type would drop still matches at claim time', async () => {
    const conn = stageWorld();
    await shadow.stage(conn, { now: NOW });
    expect(conn.raw).toHaveBeenCalledWith('updated_at::text AS updated_at_key');
    const claim = conn.queried('call_log').find((q) => q.calls.some((c) => c[0] === 'update')).calls;
    expect(has(claim, 'whereRaw', 'updated_at::text = ?', ['2026-11-20 15:05:00.123456+00'])).toBe(true);
    expect(claim.some((c) => c[0] === 'where' && c[1] === 'updated_at')).toBe(false);
  });

  test('one open sent estimate: pending, pinned, with the answer, the send time and the staging time', async () => {
    const conn = stageWorld({ call: baseCall({ estimate_answer: 'accepted_with_condition' }) });
    expect(await shadow.stage(conn, { now: NOW })).toEqual({ staged: 1, ineligible: 0 });
    expect(conn.written).toEqual([{
      status: 'pending', estimate_id: 'est-1', answer: 'accepted_with_condition', send_at: SEND_AT, staged_at: NOW.toISOString(),
    }]);
  });

  test('the estimate rule is read through the phone-yes helpers: open today with a first handoff, and nothing else open AT the call', async () => {
    const conn = stageWorld();
    await shadow.stage(conn, { now: NOW });
    expect(openEstimatesOf).toHaveBeenCalledWith(conn, 'cust-1', NOW);
    expect(otherEstimateOpenAt).toHaveBeenCalledWith(conn, { customerId: 'cust-1', cardIds: ['est-1'], callLogId: 'call-1' });
  });

  test.each([
    ['no customer row on the call', { call: baseCall({ customer_id: null }) }, 'no_customer'],
    ['no open estimate', { pin: [] }, 'no_open_estimate'],
    ['two open estimates', { pin: [candidate('est-1'), candidate('est-2')] }, 'several_open_estimates'],
    ['another estimate was open at the call (accepted or archived since)', { otherOpen: true }, 'several_open_estimates'],
    ['the first handoff came after the call began (a resend moved sent_at, the first delivery did not)', { pin: [candidate('est-1', '2026-11-20T16:00:00.000Z')] }, 'no_open_estimate'],
    ['an estimate never delivered (every send held back or failed, never opened)', { pin: [candidate('est-1', null)] }, 'no_open_estimate'],
    ['a send time already over an hour past', { call: baseCall({ created_at: new Date(NOW.getTime() - 5 * HOUR) }) }, 'stale_at_staging'],
    ['no readable call time', { call: baseCall({ created_at: null }), pin: [candidate('est-1', '1960-01-01T00:00:00.000Z')] }, 'no_call_end_time'],
  ])('%s: skipped, terminal, with its reason', async (_label, world, reason) => {
    const conn = stageWorld(world);
    const out = await shadow.stage(conn, { now: NOW });
    expect(out).toEqual({ staged: 0, ineligible: 1 });
    expect(conn.written).toEqual([{ status: 'skipped', reason, answer: 'accepted', staged_at: NOW.toISOString() }]);
  });

  test('no customer: no estimate is read', async () => {
    const conn = stageWorld({ call: baseCall({ customer_id: null }) });
    await shadow.stage(conn, { now: NOW });
    expect(openEstimatesOf).not.toHaveBeenCalled();
    expect(otherEstimateOpenAt).not.toHaveBeenCalled();
  });

  test('a never-delivered estimate beside a delivered one does not make the call "several"', async () => {
    const conn = stageWorld({ pin: [candidate('est-1'), candidate('est-2', null)] });
    expect(await shadow.stage(conn, { now: NOW })).toEqual({ staged: 1, ineligible: 0 });
    expect(conn.written[0].estimate_id).toBe('est-1');
  });

  test('a delivered estimate with a first handoff exactly at the call start counts, a legacy row too (handoff = sent_at)', async () => {
    const conn = stageWorld({ pin: [candidate('est-1', CALL_START.toISOString())] });
    expect(await shadow.stage(conn, { now: NOW })).toEqual({ staged: 1, ineligible: 0 });
  });

  test('the write is a claim: it re-checks what the scan filtered on, and a lost claim counts nothing', async () => {
    const conn = stageWorld({ update: () => 0 });
    expect(await shadow.stage(conn, { now: NOW })).toEqual({ staged: 0, ineligible: 0 });
    const claim = conn.queried('call_log').find((q) => q.calls.some((c) => c[0] === 'update')).calls;
    expect(has(claim, 'where', { id: 'call-1' })).toBe(true);
    expect(has(claim, 'whereNull', 'processing_token')).toBe(true);
    expect(has(claim, 'where', 'v2_extraction_status', 'valid')).toBe(true);
    expect(has(claim, 'whereRaw', 'metadata->:key IS NULL', { key: KEY })).toBe(true);
    // The write leaves updated_at alone.
    expect(JSON.stringify(claim.find((c) => c[0] === 'update'))).not.toContain('updated_at');
  });

  test('one call that fails to stage does not stop the next one, and the log carries the call id and code only', async () => {
    const conn = fakeConn({ rows: { call_log: () => [baseCall({ id: 'call-bad' }), baseCall({ id: 'call-ok' })] } });
    otherEstimateOpenAt.mockResolvedValue(false);
    openEstimatesOf.mockRejectedValueOnce(Object.assign(new Error('secret row text'), { code: '57014' })).mockResolvedValue([candidate()]);
    expect(await shadow.stage(conn, { now: NOW })).toEqual({ staged: 1, ineligible: 0 });
    const warned = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(warned).toContain('call-bad');
    expect(warned).toContain('57014');
    expect(warned).not.toContain('secret row text');
  });

  test('the stage result has no field named skipped (the scheduler reads that as "no lock")', async () => {
    const out = await shadow.stage(stageWorld(), { now: NOW });
    expect(Object.keys(out)).not.toContain('skipped');
  });
});

// ---- decide ----------------------------------------------------------------------------------------

const PENDING = { status: 'pending', estimate_id: 'est-1', answer: 'accepted', send_at: SEND_AT, staged_at: '2026-11-20T15:20:00.000Z' };

// One world the decide tests bend: the rows the fake answers, plus the mocked helpers.
function decideWorld(over = {}) {
  const world = {
    call: baseCall({ metadata: { [KEY]: PENDING } }),
    estimate: baseEstimate(),
    customer: { id: 'cust-1', phone: '+19415550123', deleted_at: null },
    openRows: [candidate()],
    sms: null,
    answeredCall: null,
    due: [{ id: 'call-1', metadata: { [KEY]: PENDING } }],
    updateCount: 1,
    ...over,
  };
  world.conn = fakeConn({
    rows: {
      call_log: (calls) => (calls.some((c) => c[0] === 'orderByRaw') ? world.due : []),
    },
    first: {
      call_log: (calls) => (calls.some((c) => c[0] === 'whereRaw' && c[1] === CUSTOMER_ANSWERED_SQL) ? world.answeredCall : world.call),
      estimates: () => world.estimate,
      customers: () => world.customer,
      sms_log: () => world.sms,
    },
    update: () => world.updateCount,
  });
  openEstimatesOf.mockImplementation(async () => world.openRows);
  return world;
}

function clearMocks() {
  jest.clearAllMocks();
  bookedSinceCall.mockResolvedValue(false);
  visitStampedWithCall.mockResolvedValue(false);
  hasRepliedSince.mockResolvedValue(false);
  isEstimateCustomerViewable.mockReturnValue(true);
  callSideBlockForEstimateData.mockResolvedValue(null);
  estimateDeliverableUnderGate.mockResolvedValue(true);
  disclaimedNumberHeld.mockResolvedValue(false);
  otherEstimateOpenAt.mockResolvedValue(false);
  loadContactState.mockResolvedValue({ prefs: {} });
  loadSuppressionState.mockImplementation(async (_input, state) => ({ ...state, suppressionLoaded: true }));
  checkSuppression.mockResolvedValue({ ok: true });
  checkConsentForPurpose.mockResolvedValue({ ok: true });
}
beforeEach(clearMocks);

// Each stop: how to make it apply. The order of this table is the order the module must answer in.
const STOPS = [
  ['answer_changed', (w) => { w.call = { ...w.call, estimate_answer: 'declined' }; }],
  ['customer_changed', (w) => { w.call = { ...w.call, customer_id: 'cust-2' }; }],
  ['estimate_accepted', (w) => { w.estimate = { ...w.estimate, status: 'accepted' }; }],
  ['estimate_closed', (w) => { w.estimate = { ...w.estimate, archived_at: new Date('2026-11-20T16:00:00.000Z') }; }],
  ['estimate_expired', (w) => { w.estimate = { ...w.estimate, expires_at: new Date('2026-11-20T17:00:00.000Z') }; }],
  ['several_open_estimates', (w) => { w.openRows = [candidate('est-1'), candidate('est-9', '2026-11-20T16:30:00.000Z')]; }],
  ['booked', () => { bookedSinceCall.mockResolvedValue(true); }],
  ['contact_since_call', (w) => { w.sms = { id: 'sms-1' }; }],
  ['customer_replied_since_call', () => { hasRepliedSince.mockResolvedValue(true); }],
  ['no_textable_phone', (w) => { w.customer = { id: 'cust-1', phone: null, deleted_at: null }; }],
  ['number_on_hold', () => { disclaimedNumberHeld.mockResolvedValue(true); }],
  ['sms_opted_out', () => { checkSuppression.mockResolvedValue({ ok: false, code: 'SUPPRESSED_OPT_OUT' }); }],
  ['link_not_viewable', () => { isEstimateCustomerViewable.mockReturnValue(false); }],
  ['pricing_not_verified', () => { estimateDeliverableUnderGate.mockResolvedValue(false); }],
];

const decided = (world) => world.conn.written[0];

describe('decide: the first stop that applies is recorded', () => {
  test('nothing applies: would_send, terminal, carrying the pinned estimate, the answer and both times', async () => {
    const world = decideWorld();
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 1, wouldSend: 1 });
    expect(decided(world)).toEqual({
      status: 'would_send', estimate_id: 'est-1', answer: 'accepted', send_at: SEND_AT, staged_at: PENDING.staged_at, decided_at: NOW.toISOString(),
    });
  });

  test.each(STOPS.map((stop, index) => [stop[0], index]))('%s wins over every stop after it', async (reason, index) => {
    const world = decideWorld();
    for (const [, apply] of STOPS.slice(index)) apply(world);
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 1, wouldSend: 0 });
    expect(decided(world)).toMatchObject({ status: 'skipped', reason, estimate_id: 'est-1', answer: 'accepted', send_at: SEND_AT, decided_at: NOW.toISOString() });
  });

  test.each(STOPS.map((stop) => [stop[0]]))('%s alone (every other check clear) is recorded as that reason', async (reason) => {
    const world = decideWorld();
    STOPS.find((stop) => stop[0] === reason)[1](world);
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).reason).toBe(reason);
  });

  test('a closed estimate is also one that is gone, or no longer sent or viewed', async () => {
    for (const estimate of [null, baseEstimate({ status: 'declined' }), baseEstimate({ status: 'expired' })]) {
      const world = decideWorld({ estimate });
      await shadow.decide(world.conn, { now: NOW });
      expect(decided(world).reason).toBe('estimate_closed');
    }
  });

  test('the several-estimates count reads open estimates today, counts one sent after the call, and ignores one never delivered', async () => {
    const world = decideWorld({ openRows: [candidate(), candidate('est-9', null)] });
    await shadow.decide(world.conn, { now: NOW });
    expect(openEstimatesOf).toHaveBeenCalledWith(world.conn, 'cust-1', NOW);
    expect(decided(world).status).toBe('would_send');
  });

  test.each([
    ['text', (w) => { w.sms = { id: 'sms-1' }; }],
    ['call', (w) => { w.answeredCall = { id: 'call-9' }; }],
    ['follow_up', (w) => { w.estimate = baseEstimate({ last_follow_up_at: new Date('2026-11-20T16:00:00.000Z') }); }],
    ['resent', (w) => { w.estimate = baseEstimate({ estimate_data: { deliveryState: { firstDeliveredAt: BEFORE_CALL, lastDeliveredAt: '2026-11-20T16:00:00.000Z' } } }); }],
  ])('contact since the call (%s) is recorded with its kind', async (contact, apply) => {
    const world = decideWorld();
    apply(world);
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world)).toMatchObject({ status: 'skipped', reason: 'contact_since_call', contact });
  });

  test('contact is judged from the call END, and an undelivered text does not count', async () => {
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    const texts = world.conn.queried('sms_log')[0].calls;
    expect(has(texts, 'where', 'sms_log.created_at', '>', new Date('2026-11-20T15:02:00.000Z'))).toBe(true);
    expect(has(texts, 'whereNotIn', 'sms_log.status', ['failed', 'undelivered', 'blocked'])).toBe(true);
    expect(hasRepliedSince.mock.calls[0][1]).toEqual(new Date('2026-11-20T15:02:00.000Z'));
    expect(hasRepliedSince.mock.calls[0][2]).toEqual({ throwOnError: true });
  });

  test.each([
    ['a stamped row whose sent_at moved after the call but whose last real handoff did not (a held or failed send)',
      baseEstimate({ sent_at: new Date('2026-11-20T16:00:00.000Z'), estimate_data: { deliveryState: { firstDeliveredAt: BEFORE_CALL, lastDeliveredAt: BEFORE_CALL } } }), 'would_send'],
    ['a stamped row with no real handoff at all, opened before the call', baseEstimate({ sent_at: new Date('2026-11-20T16:00:00.000Z'), estimate_data: { deliveryState: {} } }), 'would_send'],
    ['a legacy row (no delivery stamp) sent before the call', baseEstimate({ estimate_data: {} }), 'would_send'],
    ['a legacy row (no delivery stamp) whose sent_at moved after the call ended: a resend, the only evidence there is',
      baseEstimate({ sent_at: new Date('2026-11-20T16:00:00.000Z'), estimate_data: {} }), 'resent'],
    ['a stamp stored as a JSON string', baseEstimate({ estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: BEFORE_CALL, lastDeliveredAt: '2026-11-20T16:00:00.000Z' } }) }), 'resent'],
  ])('resent is read from the delivery stamp: %s', async (_label, estimate, expected) => {
    const world = decideWorld({ estimate });
    await shadow.decide(world.conn, { now: NOW });
    const out = decided(world);
    expect(out.status === 'would_send' ? 'would_send' : out.contact).toBe(expected);
  });

  test('an estimate sent BEFORE the call end is not "sent again"', async () => {
    const world = decideWorld({ estimate: baseEstimate({ sent_at: new Date('2026-11-20T14:00:00.000Z') }) });
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).status).toBe('would_send');
  });

  test('booked is judged from the call start with the customer\'s saved phone, and a visit stamped with the call counts', async () => {
    const world = decideWorld();
    visitStampedWithCall.mockResolvedValue(true);
    await shadow.decide(world.conn, { now: NOW });
    expect(bookedSinceCall).toHaveBeenCalledWith(world.conn, 'cust-1', CALL_START, '+19415550123');
    expect(visitStampedWithCall).toHaveBeenCalledWith(world.conn, 'call-1');
    expect(decided(world).reason).toBe('booked');
  });

  test('a saved phone the office send refuses (impossible US area code) or a deleted customer is no_textable_phone', async () => {
    for (const customer of [{ id: 'cust-1', phone: '+19415550123', deleted_at: new Date() }, { id: 'cust-1', phone: '(041) 555-0123', deleted_at: null }, null]) {
      const world = decideWorld({ customer });
      await shadow.decide(world.conn, { now: NOW });
      expect(decided(world).reason).toBe('no_textable_phone');
    }
  });

  test('answer_changed carries the answer now: the call was read again and is no longer a yes (or no longer valid)', async () => {
    for (const [change, answerNow] of [
      [{ estimate_answer: 'declined' }, 'declined'], [{ estimate_answer: null }, null], [{ estimate_answer: 'undecided' }, 'undecided'],
      [{ v2_extraction_status: 'pending' }, 'accepted'],
    ]) {
      const world = decideWorld();
      world.call = { ...world.call, ...change };
      await shadow.decide(world.conn, { now: NOW });
      expect(decided(world)).toMatchObject({ status: 'skipped', reason: 'answer_changed', answer: 'accepted', answer_now: answerNow });
    }
  });

  test('a yes that became the other yes is still a yes', async () => {
    const world = decideWorld();
    world.call = { ...world.call, estimate_answer: 'accepted_with_condition' };
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).status).toBe('would_send');
  });

  test('customer_changed: the call has no customer now, or another one than the pinned estimate belongs to', async () => {
    for (const customerId of [null, 'cust-2']) {
      const world = decideWorld();
      world.call = { ...world.call, customer_id: customerId };
      await shadow.decide(world.conn, { now: NOW });
      expect(decided(world).reason).toBe('customer_changed');
    }
  });

  test('a call mid-reprocess is left pending: nothing written, the retry policy applies', async () => {
    const world = decideWorld();
    world.call = { ...world.call, processing_token: 'tok-1' };
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    expect(world.conn.written).toHaveLength(0);
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toContain('call_reprocessing');
    const late = new Date(new Date(SEND_AT).getTime() + shadow.UNDECIDED_GIVE_UP_MS + 60 * 1000);
    await shadow.decide(world.conn, { now: late });
    expect(decided(world)).toMatchObject({ reason: 'undecided_after_24h' });
  });

  test('the fresh call read asks for the extraction status, the reprocess token and the stored answer', async () => {
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    const read = world.conn.queried('call_log').find((q) => q.calls.some((c) => c[0] === 'first')).calls.find((c) => c[0] === 'first');
    expect(read).toEqual(expect.arrayContaining(['v2_extraction_status', 'processing_token']));
    expect(world.conn.raw).toHaveBeenCalledWith("ai_extraction_enriched->'service_request'->>'estimate_response' AS estimate_answer");
  });

  test('number_on_hold reads the destination-number hold for the saved phone, and is not an opt-out', async () => {
    disclaimedNumberHeld.mockResolvedValue(true);
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).reason).toBe('number_on_hold');
    expect(disclaimedNumberHeld).toHaveBeenCalledWith('+19415550123', world.conn);
    expect(checkSuppression).not.toHaveBeenCalled();
  });

  test('a failed hold lookup leaves the row pending', async () => {
    disclaimedNumberHeld.mockRejectedValue(Object.assign(new Error('x'), { code: '57014' }));
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    expect(world.conn.written).toHaveLength(0);
  });

  test.each([[undefined], [null], [''], ['short'], ['has space in token 1234'], ['x'.repeat(65)]])('a missing or malformed token (%p) is link_not_viewable', async (token) => {
    const world = decideWorld({ estimate: baseEstimate({ token }) });
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).reason).toBe('link_not_viewable');
    expect(callSideBlockForEstimateData).not.toHaveBeenCalled();
  });

  test('call_verdict_unavailable is not an answer: the row stays pending, then gives up after 24 hours', async () => {
    callSideBlockForEstimateData.mockResolvedValue('call_verdict_unavailable');
    const world = decideWorld();
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    expect(world.conn.written).toHaveLength(0);
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toContain('call_verdict_unavailable');
    const late = new Date(new Date(SEND_AT).getTime() + shadow.UNDECIDED_GIVE_UP_MS + 60 * 1000);
    await shadow.decide(world.conn, { now: late });
    expect(decided(world)).toMatchObject({ reason: 'undecided_after_24h' });
  });

  test('the consent read uses the send pipeline validators with no send: a refusal by consent counts as opted out', async () => {
    checkConsentForPurpose.mockResolvedValue({ ok: false, code: 'SMS_DISABLED' });
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).reason).toBe('sms_opted_out');
    expect(loadContactState.mock.calls[0][0]).toMatchObject({ audience: 'customer', channel: 'sms', customerId: 'cust-1' });
    expect(loadContactState.mock.calls[0][0].appointmentId).toBeUndefined();
  });

  test('the public-link verdict: the call-side block also stops it, and the block is read from the estimate data', async () => {
    callSideBlockForEstimateData.mockResolvedValue('call_reprocessed');
    const world = decideWorld({ estimate: baseEstimate({ estimate_data: JSON.stringify({ estimatorEngine: { callLogId: 'call-1' } }) }) });
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).reason).toBe('link_not_viewable');
    expect(callSideBlockForEstimateData).toHaveBeenCalledWith(world.conn, { estimatorEngine: { callLogId: 'call-1' } }, { estimateStatus: 'sent' });
  });

  test('the estimate is the pinned one: the decide reads it by the staged id and never searches for another', async () => {
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    const reads = world.conn.queried('estimates').filter((q) => q.calls.some((c) => c[0] === 'first'));
    expect(reads).toHaveLength(1);
    expect(has(reads[0].calls, 'where', { id: 'est-1' })).toBe(true);
    expect(decided(world).estimate_id).toBe('est-1');
  });

  test('the write is conditional on the same pending row, and a lost write counts nothing', async () => {
    const world = decideWorld({ updateCount: 0 });
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    const write = world.conn.queried('call_log').find((q) => q.calls.some((c) => c[0] === 'update')).calls;
    expect(has(write, 'whereRaw', "metadata->:key->>'status' = 'pending' AND metadata->:key->>'send_at' = :sendAt", { key: KEY, sendAt: SEND_AT })).toBe(true);
    expect(JSON.stringify(write.find((c) => c[0] === 'update'))).not.toContain('updated_at');
  });

  test('a row that is no longer pending in the list is left alone', async () => {
    const world = decideWorld({ due: [{ id: 'call-1', metadata: { [KEY]: { ...PENDING, status: 'would_send' } } }] });
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    expect(world.conn.written).toHaveLength(0);
  });

  test('nothing due: nothing read, nothing written (a second sweep changes nothing)', async () => {
    const world = decideWorld({ due: [] });
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    expect(world.conn.written).toHaveLength(0);
    expect(world.conn.queried('estimates')).toHaveLength(0);
  });

  test('the stored record holds ids, the answer, codes and times only: no phone, name, link or token', async () => {
    const world = decideWorld({ sms: { id: 'sms-1' } });
    await shadow.decide(world.conn, { now: NOW });
    const text = JSON.stringify(decided(world));
    expect(text).not.toMatch(/555|Dana|http|token/i);
  });
});

describe('decide: a read that throws', () => {
  test('leaves the row pending (nothing written) and logs the call id and code, never the message', async () => {
    hasRepliedSince.mockRejectedValue(Object.assign(new Error('Dana 555-0123 row text'), { code: 'ECONNRESET' }));
    const world = decideWorld();
    expect(await shadow.decide(world.conn, { now: NOW })).toEqual({ decided: 0, wouldSend: 0 });
    expect(world.conn.written).toHaveLength(0);
    const warned = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(warned).toContain('call-1');
    expect(warned).toContain('ECONNRESET');
    expect(warned).not.toContain('Dana');
  });

  test('an unreadable do-not-text list is not an answer: the row stays pending', async () => {
    loadSuppressionState.mockImplementation(async (_input, state) => state);
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    expect(world.conn.written).toHaveLength(0);
  });

  test('an unreadable consent record is not an answer either', async () => {
    checkConsentForPurpose.mockResolvedValue({ ok: false, code: 'CONSENT_LOOKUP_FAILED' });
    const world = decideWorld();
    await shadow.decide(world.conn, { now: NOW });
    expect(world.conn.written).toHaveLength(0);
  });

  test('a stop BEFORE the failing read is still recorded (the failing read is never reached)', async () => {
    hasRepliedSince.mockRejectedValue(new Error('down'));
    const world = decideWorld({ estimate: baseEstimate({ status: 'accepted' }) });
    await shadow.decide(world.conn, { now: NOW });
    expect(decided(world).reason).toBe('estimate_accepted');
  });

  test('24 hours past the send time: undecided_after_24h, terminal', async () => {
    hasRepliedSince.mockRejectedValue(new Error('down'));
    const world = decideWorld();
    const late = new Date(new Date(SEND_AT).getTime() + shadow.UNDECIDED_GIVE_UP_MS + 60 * 1000);
    expect(await shadow.decide(world.conn, { now: late })).toEqual({ decided: 1, wouldSend: 0 });
    expect(decided(world)).toMatchObject({ status: 'skipped', reason: 'undecided_after_24h', estimate_id: 'est-1', send_at: SEND_AT });
  });

  test('just inside 24 hours it is still retried', async () => {
    hasRepliedSince.mockRejectedValue(new Error('down'));
    const world = decideWorld();
    const early = new Date(new Date(SEND_AT).getTime() + shadow.UNDECIDED_GIVE_UP_MS - 60 * 1000);
    await shadow.decide(world.conn, { now: early });
    expect(world.conn.written).toHaveLength(0);
  });
});

describe('sweep', () => {
  test('stages then decides, returns counts only, and logs one line of counts', async () => {
    const world = decideWorld();
    const out = await shadow.sweep(world.conn, { now: NOW });
    expect(Object.keys(out).sort()).toEqual(['decided', 'ineligible', 'staged', 'wouldSend']);
    expect(Object.keys(out)).not.toContain('skipped');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/staged=\d+ ineligible=\d+ decided=\d+ wouldSend=\d+$/);
  });

  test('a sweep that did nothing logs nothing', async () => {
    const conn = fakeConn();
    expect(await shadow.sweep(conn, { now: NOW })).toEqual({ staged: 0, ineligible: 0, decided: 0, wouldSend: 0 });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('record-only: the module cannot send or mint', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-estimate-link-shadow.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test.each([
    'sendCustomerMessage', 'send-customer-message', 'sms-auto-send', 'shortenOrPassthrough', 'short-code', 'sendSms', 'sendEmail',
    'sendgrid', 'twilio', 'resend', 'nodemailer', 'activity_log', 'notifyAdmin',
  ])('does not mention %s', (name) => {
    expect(code.toLowerCase()).not.toContain(name.toLowerCase());
  });

  test('has no mint helper and no insert', () => {
    expect(code).not.toMatch(/\bmint\w*\s*\(/i);
    expect(code).not.toMatch(/\.insert\(/);
    expect(code).not.toMatch(/\.del\(|\.delete\(/);
  });

  test('writes only call_log, and only through the one metadata key', () => {
    const writes = [...code.matchAll(/conn\('(\w+)'\)[^;]{0,600}?\.update\(/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    expect(new Set(writes)).toEqual(new Set(['call_log']));
    expect(code).toContain("const METADATA_KEY = 'call_estimate_link_shadow';");
  });
});

describe('scheduler wiring', () => {
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');

  test('a 5-minute tick runs the sweep under its own exclusive lock name', () => {
    const at = scheduler.indexOf("runExclusive('call-estimate-link-shadow'");
    expect(at).toBeGreaterThan(-1);
    const tickStart = scheduler.lastIndexOf('cron.schedule(', at);
    expect(scheduler.slice(tickStart, tickStart + 40)).toContain("'0 */5 * * * *'");
    expect(scheduler.slice(at, at + 140)).toContain("require('./call-estimate-link-shadow').sweep()");
  });

  test('the module is loaded inside the tick, not at boot (it keeps no boot-time anchor)', () => {
    expect(scheduler).not.toMatch(/^const \w+ = require\('\.\/call-estimate-link-shadow'\);/m);
  });

  test('a skipped tick writes the job-health rows, like the booking-link tick', () => {
    const at = scheduler.indexOf("runExclusive('call-estimate-link-shadow'");
    const body = scheduler.slice(at, at + 900);
    expect(body).toContain("recordJobStart('call-estimate-link-shadow')");
    expect(body).toContain("recordJobEnd('call-estimate-link-shadow'");
  });
});
