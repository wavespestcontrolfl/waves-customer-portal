/**
 * Outbound call reason resolver (services/outbound-call-reason.js).
 *
 * Pins the owner-scoped ladder: quote-request auto-bridge by source →
 * callback of a specific inbound call (relatedCallId) → the more recent of
 * {inbound call, inbound text} inside the 48h lookback → generic. Spam /
 * robocall / wrong-number / vendor inbound calls never count as "returning
 * your call"; a probe failure falls back to generic rather than blocking.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-intent', () => ({ isSmsReaction: jest.fn((b) => /^(👍|❤️|Liked|Loved) ?/.test(String(b))) }));
jest.mock('../services/voice-agent/relay-protocol', () => ({
  whereNotSandboxCall: jest.fn((qb) => { qb.whereRaw('SANDBOX_EXCLUDED'); return qb; }),
}));

const db = require('../models/db');
const { whereNotSandboxCall } = require('../services/voice-agent/relay-protocol');
const {
  REASONS,
  LOOKBACK_MS,
  VISIT_IN_PROGRESS_WINDOW_MS,
  TEXT_SCAN_LIMIT,
  NON_SERVICE_NATURES,
  resolveOutboundCallReason,
  visitInProgress,
  nonServiceCaller,
  isSubstantiveText,
  _private,
} = require('../services/outbound-call-reason');

const T0 = new Date('2026-09-08T15:00:00Z');
const hoursAgo = (h) => new Date(T0.getTime() - h * 3600000);
const PHONE = '+19415550101';

// state.byTable: table → array of rows for first()/select(); queries record
// their where() args so the lookback and contact predicate can be asserted.
let state;
function installDb(byTable = {}) {
  state = { byTable, queries: [] };
  db.mockImplementation((table) => {
    const q = { table, wheres: [], raws: [] };
    state.queries.push(q);
    const b = {};
    b.where = jest.fn((...a) => { q.wheres.push(a); if (typeof a[0] === 'function') a[0].call(b); return b; });
    b.orWhere = jest.fn((...a) => { q.wheres.push(['OR', ...a]); return b; });
    b.whereRaw = jest.fn((...a) => { q.raws.push(a); return b; });
    b.orderBy = jest.fn(() => b);
    q.limits = [];
    b.limit = jest.fn((n) => { q.limits.push(n); return b; });
    const rowsFor = () => {
      const isQuoteBridge = table === 'call_log' && q.wheres.some((w) => w[0] === 'direction' && w[1] === 'outbound');
      if (isQuoteBridge) return state.byTable.quote_bridges || [];
      return state.byTable[table] || [];
    };
    b.whereIn = jest.fn((...a) => { q.wheres.push(['IN', ...a]); return b; });
    b.whereNull = jest.fn((...a) => { q.wheres.push(['NULL', ...a]); return b; });
    b.orWhereBetween = jest.fn((...a) => { q.wheres.push(['OR BETWEEN', ...a]); return b; });
    b.whereBetween = jest.fn((...a) => { q.wheres.push(['BETWEEN', ...a]); return b; });
    b.join = jest.fn((...a) => { q.wheres.push(['JOIN', ...a]); return b; });
    b.modify = jest.fn((fn) => { fn(b); return b; });
    b.select = jest.fn(async () => rowsFor());
    b.first = jest.fn(async () => rowsFor()[0]);
    return b;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installDb();
});

const call = (over = {}) => ({ id: 'cl-1', source: 'admin-click', customer_id: 'cust-1', metadata: null, created_at: T0, ...over });

describe('helpers', () => {
  test('last10 / callNature / parseMetadata', () => {
    expect(_private.last10('(941) 555-0101')).toBe('9415550101');
    expect(_private.last10('+19415550101')).toBe('9415550101');
    expect(_private.last10('12345')).toBeNull();
    expect(_private.callNature({ ai_extraction_enriched: { call_nature: ' New_Lead ' } })).toBe('new_lead');
    expect(_private.callNature({ ai_extraction_enriched: JSON.stringify({ call_nature: 'robocall' }) })).toBe('robocall');
    expect(_private.callNature({ ai_extraction_enriched: 'not json' })).toBe('');
    expect(_private.parseMetadata('{"relatedCallId":"x"}')).toEqual({ relatedCallId: 'x' });
    expect(_private.parseMetadata({ a: 1 })).toEqual({ a: 1 });
    expect(_private.parseMetadata('garbage')).toEqual({});
  });
});

describe('resolveOutboundCallReason', () => {
  test('lead-webhook auto-bridge → quote_request without touching the DB', async () => {
    const r = await resolveOutboundCallReason({ call: call({ source: 'lead-webhook-auto-bridge' }), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.QUOTE_REQUEST, evidence: { source: 'lead-webhook-auto-bridge' } });
    expect(db).not.toHaveBeenCalled();
  });

  test('relatedCallId pointing at a real inbound call → returning_call, no further probes', async () => {
    installDb({ call_log: [{ id: 'in-9', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'existing_customer_scheduling' } }] });
    const r = await resolveOutboundCallReason({ call: call({ source: 'admin-callback', metadata: { relatedCallId: 'in-9' } }), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.RETURNING_CALL, evidence: { related_call_id: 'in-9', at: hoursAgo(1) } });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].wheres[0]).toEqual([{ id: 'in-9', direction: 'inbound' }]);
  });

  test('relatedCallId to a spam-natured call is ignored and the lookback probes run', async () => {
    installDb({ call_log: [{ id: 'in-9', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'spam_solicitation' } }] });
    // The lookback probe returns the same spam row → filtered → no call; no text → generic.
    const r = await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'in-9' } }), phone: PHONE });
    expect(r.reason).toBe(REASONS.GENERIC);
    expect(state.queries.map((q) => q.table)).toEqual(['call_log', 'call_log', 'sms_log', 'leads', 'call_log']);
  });

  test('the literal "undefined" relatedCallId is not looked up', async () => {
    await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'undefined' } }), phone: PHONE });
    expect(state.queries.map((q) => q.table)).toEqual(['call_log', 'sms_log', 'leads', 'call_log']);
  });

  test('inbound call inside 48h, no text → returning_call', async () => {
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(5), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.RETURNING_CALL, evidence: { inbound_call_id: 'in-1', at: hoursAgo(5) } });
  });

  test('inbound text inside 48h, no call → saw_text', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.SAW_TEXT, evidence: { inbound_sms_id: 'sms-1', at: hoursAgo(1) } });
  });

  test('both inside 48h → the MORE RECENT wins (text newer)', async () => {
    installDb({
      call_log: [{ id: 'in-1', created_at: hoursAgo(5), ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.SAW_TEXT);
  });

  test('both inside 48h → the MORE RECENT wins (call newer, tie goes to the call)', async () => {
    installDb({
      call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('a spam/robocall/wrong-number/vendor inbound call is skipped in favour of the next real one', async () => {
    installDb({
      call_log: [
        { id: 'in-spam', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'robocall' } },
        { id: 'in-real', created_at: hoursAgo(3), ai_extraction_enriched: { call_nature: 'billing_question' } },
      ],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.evidence.inbound_call_id).toBe('in-real');
  });

  test('an unprocessed inbound call (no extraction yet) still counts', async () => {
    installDb({ call_log: [{ id: 'in-raw', created_at: hoursAgo(2), ai_extraction_enriched: null }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('lookback is 48h ending at the outbound call time; contact predicate uses customer_id OR the dialed last-10', async () => {
    await resolveOutboundCallReason({ call: call(), phone: '(941) 555-0101' });
    const [callQ, smsQ] = state.queries;
    for (const q of [callQ, smsQ]) {
      expect(q.wheres).toEqual(expect.arrayContaining([
        ['direction', 'inbound'],
        ['created_at', '<', T0],
        ['created_at', '>=', new Date(T0.getTime() - LOOKBACK_MS)],
        ['customer_id', 'cust-1'],
      ]));
      const orRaw = q.wheres.find((w) => w[0] === 'OR');
      expect(orRaw[1].__raw).toContain('from_phone');
      expect(orRaw[1].bindings).toEqual(['9415550101']);
    }
    expect(LOOKBACK_MS).toBe(48 * 3600000);
  });

  test('no customer and no usable phone → contact predicate is false, generic', async () => {
    const r = await resolveOutboundCallReason({ call: call({ customer_id: null }), phone: '' });
    expect(r.reason).toBe(REASONS.GENERIC);
    for (const q of state.queries) expect(q.raws).toContainEqual(['false']);
    expect(state.queries).toHaveLength(4);
  });

  test('phone-only contact (no customer) uses a plain where on the last-10', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1), message_body: 'Can you come look at the ants?' }] });
    const r = await resolveOutboundCallReason({ call: call({ customer_id: null }), phone: PHONE });
    expect(r.reason).toBe(REASONS.SAW_TEXT);
    expect(state.queries[1].wheres.some((w) => w[0] === 'OR')).toBe(false);
  });

  test('our own quote-form bridge to them inside 48h → quote_request (the follow-up call is about the quote)', async () => {
    installDb({ quote_bridges: [{ id: 'ab-1', created_at: hoursAgo(45) }] });
    const r = await resolveOutboundCallReason({ call: call({ source: 'admin-callback' }), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.QUOTE_REQUEST, evidence: { quote_bridge_call_id: 'ab-1', at: hoursAgo(45) } });
    const q = state.queries.find((x) => x.wheres.some((w) => w[0] === 'direction' && w[1] === 'outbound'));
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['IN', 'source', ['lead-webhook-auto-bridge']],
      ['created_at', '>=', new Date(T0.getTime() - LOOKBACK_MS)],
    ]));
    expect(q.wheres.find((w) => w[0] === 'OR')[1].__raw).toContain("metadata->>'leadPhone'");
  });

  test('a quote bridge loses to a MORE RECENT inbound call or text', async () => {
    installDb({
      quote_bridges: [{ id: 'ab-1', created_at: hoursAgo(40) }],
      call_log: [{ id: 'in-1', created_at: hoursAgo(7), ai_extraction_enriched: { call_nature: 'new_lead' } }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('a web quote-form lead inside 48h → quote_request even when the after-hours bridge never fired', async () => {
    installDb({ leads: [{ id: 'lead-1', created_at: hoursAgo(19) }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.QUOTE_REQUEST, evidence: { quote_lead_id: 'lead-1', at: hoursAgo(19) } });
    const q = state.queries.find((x) => x.table === 'leads');
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['NULL', 'deleted_at'],
      ['IN', 'first_contact_channel', ['form', 'website_quote']],
      ['created_at', '>=', new Date(T0.getTime() - LOOKBACK_MS)],
    ]));
    expect(q.wheres.find((w) => w[0] === 'OR')[1].__raw).toContain('phone');
  });

  test('one-word acknowledgements, reactions, empty MMS and reschedule replies do NOT count as "your text"', async () => {
    installDb({
      sms_log: [
        { id: 'ack', created_at: hoursAgo(1), message_body: 'Ok' },
        { id: 'menu', created_at: hoursAgo(2), message_body: '1', message_type: 'reschedule_reply' },
        { id: 'thanks', created_at: hoursAgo(3), message_body: 'Great! Thank you' },
        { id: 'react', created_at: hoursAgo(4), message_body: 'Liked "Adam is on the way"' },
        { id: 'empty', created_at: hoursAgo(5), message_body: '' },
        { id: 'real', created_at: hoursAgo(6), message_body: 'I thought you were coming Monday' },
      ],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.SAW_TEXT, evidence: { inbound_sms_id: 'real', at: hoursAgo(6) } });
  });

  test('isSubstantiveText', () => {
    for (const b of ['Ok', 'okay!', 'k', 'yes', 'Thanks', 'Great! Thank you', 'sounds good', '1', '', '   ', '👍', '5125']) {
      expect(isSubstantiveText({ message_body: b })).toBe(false);
    }
    expect(isSubstantiveText({ message_body: 'Can I call you later?' })).toBe(true);
    expect(isSubstantiveText({ message_body: 'Can I call you later?', message_type: 'reschedule_reply' })).toBe(false);
    expect(isSubstantiveText({ message_body: 'looking for a wdo on 12211 Violet Jasper Dr' })).toBe(true);
  });

  test('every call_log probe excludes voice-relay sandbox calls (dry-run scanner contract)', async () => {
    installDb({ call_log: [{ id: 'in-9', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'in-9' } }), phone: PHONE });
    installDb({});
    await resolveOutboundCallReason({ call: call(), phone: PHONE });
    await nonServiceCaller({ customerId: 'cust-1', phone: PHONE, relatedCallId: 'in-9', before: T0 });
    await nonServiceCaller({ customerId: 'cust-1', phone: PHONE, before: T0 });
    for (const q of state.queries.filter((x) => x.table === 'call_log')) {
      expect(q.raws).toContainEqual(['SANDBOX_EXCLUDED']);
    }
    expect(whereNotSandboxCall).toHaveBeenCalled();
  });

  test('the text probe scans deep enough that a run of acknowledgements cannot hide the real inquiry', async () => {
    expect(TEXT_SCAN_LIMIT).toBeGreaterThanOrEqual(25);
    await resolveOutboundCallReason({ call: call(), phone: PHONE });
    const smsQ = state.queries.find((x) => x.table === 'sms_log');
    expect(smsQ.limits).toEqual([TEXT_SCAN_LIMIT]);
  });

  test('nothing in the lookback → generic', async () => {
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.GENERIC, evidence: {} });
  });

  test('visitInProgress: TODAY\'s (ET) en_route/on_site visit, or an en_route/arrived stamp inside the last 3h; visit booked after the call never counts', async () => {
    installDb({ 'scheduled_services as ss': [{ id: 'v1' }] });
    await expect(visitInProgress({ customerId: 'cust-1', before: T0 })).resolves.toBe(true);
    const q = state.queries[0];
    expect(q.table).toBe('scheduled_services as ss');
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['ss.customer_id', 'cust-1'],
      ['ss.created_at', '<', T0],
      ['IN', 'ss.status', ['en_route', 'on_site']],
      ['OR BETWEEN', 'ss.en_route_at', [new Date(T0.getTime() - VISIT_IN_PROGRESS_WINDOW_MS), T0]],
      ['OR BETWEEN', 'ss.arrived_at', [new Date(T0.getTime() - VISIT_IN_PROGRESS_WINDOW_MS), T0]],
    ]));
    // The live-status branch is fenced to the call's ET calendar day — never an
    // adjacent day (codex r1 P1: yesterday's stale on_site row silenced today's text).
    expect(q.wheres).toContainEqual(['ss.scheduled_date', '2026-09-08']);
    expect(q.wheres.some((w) => w[0] === 'BETWEEN' && w[1] === 'ss.scheduled_date')).toBe(false);
    expect(q.wheres.some((w) => w[0] === 'JOIN')).toBe(false);
    expect(VISIT_IN_PROGRESS_WINDOW_MS).toBe(3 * 3600000);
    installDb({});
    await expect(visitInProgress({ customerId: 'cust-1', before: T0 })).resolves.toBe(false);
    await expect(visitInProgress({ customerId: null, phone: null, before: T0 })).resolves.toBe(false);
    expect(state.queries).toHaveLength(1);
  });

  test('visitInProgress: an en-route / arrived text WE sent that number inside 3h counts (no customer link, no visit stamp needed)', async () => {
    installDb({ sms_log: [{ id: 'sms-arrived' }] });
    await expect(visitInProgress({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    const q = state.queries.find((x) => x.table === 'sms_log');
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['direction', 'outbound'],
      ['IN', 'message_type', ['tech_en_route', 'tech_arrived']],
      ['created_at', '>=', new Date(T0.getTime() - VISIT_IN_PROGRESS_WINDOW_MS)],
      ['created_at', '<', T0],
    ]));
    expect(q.raws[0][0]).toContain('to_phone');
    expect(q.raws[0][1]).toEqual(['9415550101']);
  });

  test('visitInProgress with no linked customer matches the dialed number to a customer record', async () => {
    installDb({ 'scheduled_services as ss': [{ id: 'v1' }] });
    await expect(visitInProgress({ customerId: null, phone: '(941) 555-0101', before: T0 })).resolves.toBe(true);
    const q = state.queries[0];
    expect(q.wheres).toEqual(expect.arrayContaining([
      ['JOIN', 'customers as c', 'c.id', 'ss.customer_id'],
      ['NULL', 'c.deleted_at'],
    ]));
    expect(q.raws[0][0]).toContain('c.phone');
    expect(q.raws[0][1]).toEqual(['9415550101']);
  });

  test('nonServiceCaller: the call being returned (relatedCallId) has a non-service nature → true', async () => {
    expect([...NON_SERVICE_NATURES].sort()).toEqual(['job_applicant', 'other', 'robocall', 'spam_solicitation', 'vendor_or_partner', 'wrong_number']);
    installDb({ call_log: [{ id: 'in-9', ai_extraction_enriched: { call_nature: 'other' } }] });
    await expect(nonServiceCaller({ customerId: 'cust-1', phone: PHONE, relatedCallId: 'in-9', before: T0 })).resolves.toBe(true);
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0].wheres[0]).toEqual([{ id: 'in-9', direction: 'inbound' }]);
  });

  test('nonServiceCaller: no relatedCallId → the most recent inbound call inside 48h decides, whatever its nature', async () => {
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'job_applicant' } }] });
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(true);
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    installDb({ call_log: [{ id: 'in-raw', created_at: hoursAgo(1), ai_extraction_enriched: null }] });
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    installDb({});
    await expect(nonServiceCaller({ customerId: null, phone: PHONE, before: T0 })).resolves.toBe(false);
    await expect(nonServiceCaller({ customerId: null, phone: null, before: T0 })).resolves.toBe(false);
  });

  test('a probe failure falls back to generic instead of throwing', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.GENERIC, evidence: { error: 'ECONNREFUSED' } });
  });

  test('missing created_at resolves against now', async () => {
    const before = Date.now();
    await resolveOutboundCallReason({ call: call({ created_at: null }), phone: PHONE });
    const lt = state.queries[0].wheres.find((w) => w[1] === '<')[2];
    expect(lt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
