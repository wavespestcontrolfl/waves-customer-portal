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

const db = require('../models/db');
const {
  REASONS,
  LOOKBACK_MS,
  QUOTE_BRIDGE_LOOKBACK_MS,
  resolveOutboundCallReason,
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
    b.limit = jest.fn(() => b);
    const rowsFor = () => {
      const isQuoteBridge = q.wheres.some((w) => w[0] === 'direction' && w[1] === 'outbound');
      if (isQuoteBridge) return state.byTable.quote_bridges || [];
      return state.byTable[table] || [];
    };
    b.whereIn = jest.fn((...a) => { q.wheres.push(['IN', ...a]); return b; });
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
    expect(state.queries.map((q) => q.table)).toEqual(['call_log', 'call_log', 'sms_log', 'call_log']);
  });

  test('the literal "undefined" relatedCallId is not looked up', async () => {
    await resolveOutboundCallReason({ call: call({ metadata: { relatedCallId: 'undefined' } }), phone: PHONE });
    expect(state.queries.map((q) => q.table)).toEqual(['call_log', 'sms_log', 'call_log']);
  });

  test('inbound call inside 48h, no text → returning_call', async () => {
    installDb({ call_log: [{ id: 'in-1', created_at: hoursAgo(5), ai_extraction_enriched: { call_nature: 'new_lead' } }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.RETURNING_CALL, evidence: { inbound_call_id: 'in-1', at: hoursAgo(5) } });
  });

  test('inbound text inside 48h, no call → saw_text', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1) }] });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.SAW_TEXT, evidence: { inbound_sms_id: 'sms-1', at: hoursAgo(1) } });
  });

  test('both inside 48h → the MORE RECENT wins (text newer)', async () => {
    installDb({
      call_log: [{ id: 'in-1', created_at: hoursAgo(5), ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 'sms-1', created_at: hoursAgo(1) }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.SAW_TEXT);
  });

  test('both inside 48h → the MORE RECENT wins (call newer, tie goes to the call)', async () => {
    installDb({
      call_log: [{ id: 'in-1', created_at: hoursAgo(1), ai_extraction_enriched: { call_nature: 'new_lead' } }],
      sms_log: [{ id: 'sms-1', created_at: hoursAgo(1) }],
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
    for (const q of state.queries) expect(q.raws).toEqual([['false']]);
  });

  test('phone-only contact (no customer) uses a plain where on the last-10', async () => {
    installDb({ sms_log: [{ id: 'sms-1', created_at: hoursAgo(1) }] });
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
      ['created_at', '>=', new Date(T0.getTime() - QUOTE_BRIDGE_LOOKBACK_MS)],
    ]));
    expect(q.wheres.find((w) => w[0] === 'OR')[1].__raw).toContain("metadata->>'leadPhone'");
    expect(QUOTE_BRIDGE_LOOKBACK_MS).toBe(48 * 3600000);
  });

  test('a quote bridge loses to a MORE RECENT inbound call or text', async () => {
    installDb({
      quote_bridges: [{ id: 'ab-1', created_at: hoursAgo(40) }],
      call_log: [{ id: 'in-1', created_at: hoursAgo(7), ai_extraction_enriched: { call_nature: 'new_lead' } }],
    });
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r.reason).toBe(REASONS.RETURNING_CALL);
  });

  test('nothing in the lookback → generic', async () => {
    const r = await resolveOutboundCallReason({ call: call(), phone: PHONE });
    expect(r).toEqual({ reason: REASONS.GENERIC, evidence: {} });
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
