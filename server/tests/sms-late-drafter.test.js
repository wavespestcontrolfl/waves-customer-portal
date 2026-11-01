/**
 * services/sms-late-drafter.js: the texting AI's shadow drafter run a few minutes late from the
 * owner's Mac. Pins the webhook filter it must reproduce, dedup, oldest-first and limit, the
 * kill switch, the silence guard (including the non-production suggest-mode default), the
 * overrides handed to draftShadowReply, the lock, and that no log line carries message text.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sms-shadow-drafter', () => ({ draftShadowReply: jest.fn() }));
jest.mock('../services/estimate-conversion-agent', () => ({
  classifyCustomerSmsTriageIntent: jest.fn((body) => ({ intent: 'GENERAL', confidence: 0.5, echoed: body.length })),
}));

const knex = require('knex');
const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { draftShadowReply } = require('../services/sms-shadow-drafter');
const { classifyCustomerSmsTriageIntent } = require('../services/estimate-conversion-agent');
const lateDrafter = require('../services/sms-late-drafter');

const { draftPendingInbound, silenceRefusal, isAiNumber } = lateDrafter;
const { candidateQuery, RUN_LOCK_KEY } = lateDrafter._internals;

const LOCATION_LINE = Object.values(TWILIO_NUMBERS.locations)[0].number;
const TRACKING_LINE = TWILIO_NUMBERS.domainTracking[0].number;
const AI_LINE = '+18559260203';
const NOW = new Date('2026-11-01T15:00:00Z');

const BODY_MARKER = 'MESSAGE-TEXT-MARKER';

let priorGates;
let priorEnv;

// The egress guard wraps whatever global fetch exists when its first scope opens, so stub it first.
const stubFetch = jest.fn(async () => ({ ok: true }));
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = stubFetch; });
afterAll(() => { globalThis.fetch = originalFetch; });

function inboundRow(over = {}) {
  return {
    id: 'sms-1', customer_id: 'cust-1', message_body: `${BODY_MARKER} Do you treat for ants?`,
    from_phone: '+19415550101', to_phone: LOCATION_LINE, created_at: new Date('2026-11-01T14:40:00Z'),
    metadata: { source: 'location', media: [] }, ...over,
  };
}

// A fake knex handle: the candidate query resolves `rows` and records its builder calls;
// message_drafts answers the per-row dedup read from `drafted`.
function fakeDbi({ rows = [], drafted = new Set(), client } = {}) {
  const queries = [];
  const dbi = jest.fn((table) => {
    if (table === 'message_drafts') {
      return { where: ({ sms_log_id: id }) => ({ first: async () => (drafted.has(id) ? { id: 'existing' } : undefined) }) };
    }
    const calls = [];
    queries.push({ table, calls });
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(rows).then(res, rej);
        return (...args) => { calls.push([prop, args]); return chain; };
      },
    });
    return chain;
  });
  dbi.raw = (sql) => ({ raw: sql });
  dbi.queries = queries;
  if (client) dbi.client = client;
  return dbi;
}

const customerFor = (id = 'cust-1') => ({ id, first_name: 'Pat', city: 'Bradenton' });
const findCustomerOk = jest.fn(async () => customerFor());

beforeEach(() => {
  jest.clearAllMocks();
  stubFetch.mockClear();
  priorGates = { smsSuggestMode: featureGates.gates.smsSuggestMode, smsAutoSend: featureGates.gates.smsAutoSend, smsShadowDrafts: featureGates.gates.smsShadowDrafts };
  priorEnv = { mac: process.env.GATE_SMS_MAC_DRAFTS, unanswered: process.env.GATE_SMS_UNANSWERED_REPLY };
  process.env.GATE_SMS_MAC_DRAFTS = 'true';
  delete process.env.GATE_SMS_UNANSWERED_REPLY;
  // The silent baseline a production Mac job runs in: suggest mode and auto-send off.
  featureGates.gates.smsSuggestMode = false;
  featureGates.gates.smsAutoSend = false;
  featureGates.gates.smsShadowDrafts = false;
  draftShadowReply.mockImplementation(async ({ smsLogId }) => `draft-for-${smsLogId}`);
  findCustomerOk.mockImplementation(async () => customerFor());
});

afterEach(() => {
  featureGates.gates.smsSuggestMode = priorGates.smsSuggestMode;
  featureGates.gates.smsAutoSend = priorGates.smsAutoSend;
  featureGates.gates.smsShadowDrafts = priorGates.smsShadowDrafts;
  for (const [key, name] of [['mac', 'GATE_SMS_MAC_DRAFTS'], ['unanswered', 'GATE_SMS_UNANSWERED_REPLY']]) {
    if (priorEnv[key] === undefined) delete process.env[name];
    else process.env[name] = priorEnv[key];
  }
});

const run = (dbi, over = {}) => draftPendingInbound({ dbi, findCustomer: findCustomerOk, now: NOW, ...over });

describe('kill switch', () => {
  test('GATE_SMS_MAC_DRAFTS unset or not exactly true: { skipped: gate_off } and nothing else runs', async () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'on']) {
      if (value === undefined) delete process.env.GATE_SMS_MAC_DRAFTS;
      else process.env.GATE_SMS_MAC_DRAFTS = value;
      const dbi = fakeDbi({ rows: [inboundRow()] });
      expect(await run(dbi)).toEqual({ skipped: 'gate_off' });
      expect(dbi).not.toHaveBeenCalled();
      expect(draftShadowReply).not.toHaveBeenCalled();
    }
  });

  test('the reader is strict and read at call time', () => {
    process.env.GATE_SMS_MAC_DRAFTS = 'true';
    expect(featureGates.smsMacDraftsLive()).toBe(true);
    process.env.GATE_SMS_MAC_DRAFTS = 'yes';
    expect(featureGates.smsMacDraftsLive()).toBe(false);
  });

  test('turning the gate off mid-run stops before the next draft', async () => {
    draftShadowReply.mockImplementationOnce(async () => { process.env.GATE_SMS_MAC_DRAFTS = 'false'; return 'draft-1'; });
    const rows = [inboundRow({ id: 'sms-1' }), inboundRow({ id: 'sms-2' })];
    const result = await run(fakeDbi({ rows }));
    expect(draftShadowReply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ drafted: 1, stopped: 'gate_off' });
  });
});

describe('silence guard', () => {
  test('outside production suggest mode defaults ON (feature-gates.js), and the guard catches it', async () => {
    // The real default, before this suite's silent baseline: jest runs with NODE_ENV=test.
    expect(priorGates.smsSuggestMode).toBe(true);
    featureGates.gates.smsSuggestMode = priorGates.smsSuggestMode;
    const dbi = fakeDbi({ rows: [inboundRow()] });
    expect(await run(dbi)).toEqual({ refused: 'suggest_mode_on' });
    expect(dbi).not.toHaveBeenCalled();
    expect(draftShadowReply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refused: suggest_mode_on'));
  });

  test('auto-send on refuses', async () => {
    featureGates.gates.smsAutoSend = true;
    expect(await run(fakeDbi({ rows: [inboundRow()] }))).toEqual({ refused: 'auto_send_on' });
    expect(draftShadowReply).not.toHaveBeenCalled();
  });

  test('the unanswered-reply stamp live refuses', async () => {
    process.env.GATE_SMS_UNANSWERED_REPLY = 'true';
    expect(await run(fakeDbi({ rows: [inboundRow()] }))).toEqual({ refused: 'unanswered_reply_on' });
    expect(draftShadowReply).not.toHaveBeenCalled();
  });

  test('suggest mode is checked first, then auto-send, then the stamp', () => {
    featureGates.gates.smsSuggestMode = true;
    featureGates.gates.smsAutoSend = true;
    process.env.GATE_SMS_UNANSWERED_REPLY = 'true';
    expect(silenceRefusal()).toBe('suggest_mode_on');
    featureGates.gates.smsSuggestMode = false;
    expect(silenceRefusal()).toBe('auto_send_on');
    featureGates.gates.smsAutoSend = false;
    expect(silenceRefusal()).toBe('unanswered_reply_on');
    delete process.env.GATE_SMS_UNANSWERED_REPLY;
    expect(silenceRefusal()).toBeNull();
  });

  test('live drafting on refuses: the two drafters never run together', async () => {
    featureGates.gates.smsShadowDrafts = true;
    const dbi = fakeDbi({ rows: [inboundRow()] });
    expect(await run(dbi)).toEqual({ refused: 'live_drafting_on' });
    expect(dbi).not.toHaveBeenCalled();
    expect(draftShadowReply).not.toHaveBeenCalled();
  });

  test('live drafting switched on mid-run stops the run before the next draft', async () => {
    draftShadowReply.mockImplementationOnce(async () => { featureGates.gates.smsShadowDrafts = true; return 'draft-1'; });
    const result = await run(fakeDbi({ rows: [inboundRow({ id: 'sms-1' }), inboundRow({ id: 'sms-2' })] }));
    expect(draftShadowReply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ drafted: 1, stopped: 'live_drafting_on' });
  });

  test('suggest mode switched on mid-run stops the run before the next draft', async () => {
    draftShadowReply.mockImplementationOnce(async () => { featureGates.gates.smsSuggestMode = true; return 'draft-1'; });
    const result = await run(fakeDbi({ rows: [inboundRow({ id: 'sms-1' }), inboundRow({ id: 'sms-2' })] }));
    expect(draftShadowReply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ drafted: 1, stopped: 'suggest_mode_on' });
  });
});

describe('candidate selection (the SQL half of the webhook filter)', () => {
  const pg = knex({ client: 'pg' });
  const windowStart = new Date('2026-11-01T14:00:00Z');
  const cutoff = new Date('2026-11-01T14:59:00Z');
  const compiled = candidateQuery(Object.assign((t) => pg(t), { raw: (s) => pg.raw(s) }), { windowStart, cutoff, fetchLimit: 50 }).toSQL();
  const sql = compiled.sql;

  test('inbound texts linked to a customer, inside the window, at least minAge old', () => {
    expect(sql).toContain('"s"."direction" = ?');
    expect(sql).toContain('"s"."customer_id" is not null');
    expect(sql).toContain('"s"."created_at" >= ?');
    expect(sql).toContain('"s"."created_at" <= ?');
    expect(compiled.bindings).toEqual(expect.arrayContaining(['inbound', windowStart, cutoff]));
  });

  test('the destination-line filter runs in SQL before the page limit: location lines only, never the AI line', () => {
    expect(sql).toContain(`RIGHT(REGEXP_REPLACE(COALESCE(s.to_phone, ''), '[^0-9]', '', 'g'), 10) = ANY(?)`);
    // the line filter precedes the limit, so a burst of texts to other lines cannot fill the page
    expect(sql.indexOf('REGEXP_REPLACE')).toBeLessThan(sql.indexOf('limit'));
    const lines = lateDrafter._internals.draftableLineLast10s();
    expect(compiled.bindings).toContainEqual(lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).not.toContain('8559260203');
    expect(lines.every((d) => /^\d{10}$/.test(d))).toBe(true);
  });

  test('a body must be present; opt keywords, reactions, consumed reschedule and lead replies are out; an enforced spam verdict is out', () => {
    expect(sql).toContain("NULLIF(TRIM(s.message_body), '') IS NOT NULL");
    expect(sql).toContain("COALESCE(s.message_type, '') <> ALL(?)");
    const { PREHANDLED_INBOUND_TYPES } = require('../services/sms-shadow-backfill');
    expect(PREHANDLED_INBOUND_TYPES).toEqual(expect.arrayContaining(['opt_out', 'opt_in', 'sms_reaction', 'reschedule_reply', 'lead_intake']));
    expect(compiled.bindings).toContainEqual(PREHANDLED_INBOUND_TYPES);
    expect(sql).toContain("COALESCE(s.metadata->'spam_verdict'->>'enforced', 'false') != 'true'");
  });

  test('a text that already has any draft is excluded in SQL (dedup)', () => {
    expect(sql).toMatch(/not exists \(select 1 from "message_drafts" as "md" where md\.sms_log_id = s\.id\)/);
  });

  test('oldest first, bounded', () => {
    expect(sql).toMatch(/order by "s"\."created_at" asc, "s"\."id" asc limit \?/);
    expect(compiled.bindings[compiled.bindings.length - 1]).toBe(50);
  });

  test('draftPendingInbound derives the window and cutoff from now, windowMinutes and minAgeSeconds, and over-fetches for the JS filters', async () => {
    const dbi = fakeDbi({ rows: [] });
    await run(dbi, { windowMinutes: 30, minAgeSeconds: 120, limit: 4 });
    const calls = dbi.queries[0].calls;
    const where = (col, op) => calls.find(([m, a]) => m === 'where' && a[0] === col && a[1] === op)?.[1][2];
    expect(where('s.created_at', '>=')).toEqual(new Date(NOW.getTime() - 30 * 60000));
    expect(where('s.created_at', '<=')).toEqual(new Date(NOW.getTime() - 120 * 1000));
    expect(calls.find(([m]) => m === 'limit')[1][0]).toBe(20);
  });
});

describe('the rest of the webhook filter, per candidate', () => {
  const draftedIds = async (rows, over = {}) => {
    const result = await run(fakeDbi({ rows, ...over }));
    return { result, ids: draftShadowReply.mock.calls.map(([a]) => a.smsLogId) };
  };

  test('a plain text to a staffed location line from a matched customer is drafted', async () => {
    const { result, ids } = await draftedIds([inboundRow()]);
    expect(ids).toEqual(['sms-1']);
    expect(result).toMatchObject({ drafted: 1, skipped: 0, failed: 0, examined: 1 });
  });

  test.each([
    ['a reaction', inboundRow({ message_body: 'Liked “See you Tuesday”' }), 'reaction'],
    ['a blank body', inboundRow({ message_body: '   ' }), 'no_body'],
    ['the AI assistant line', inboundRow({ to_phone: AI_LINE }), 'ai_number'],
    ['the AI line written without the plus', inboundRow({ to_phone: '8559260203' }), 'ai_number'],
    ['a tracking line', inboundRow({ to_phone: TRACKING_LINE }), 'not_location_line'],
    ['an unmanaged number', inboundRow({ to_phone: '+15005550006' }), 'not_location_line'],
  ])('skips %s', async (_label, row, reason) => {
    const { result, ids } = await draftedIds([row]);
    expect(ids).toEqual([]);
    expect(result).toMatchObject({ drafted: 0, skipped: 1, skippedReasons: { [reason]: 1 } });
  });

  test('skips a sender the webhook would not match to one customer, and one that now matches a different customer', async () => {
    findCustomerOk.mockResolvedValueOnce(null);
    const unmatched = await draftedIds([inboundRow()]);
    expect(unmatched.result.skippedReasons).toEqual({ no_customer: 1 });
    findCustomerOk.mockResolvedValueOnce(customerFor('someone-else'));
    const changed = await draftedIds([inboundRow({ id: 'sms-2' })]);
    expect(changed.result.skippedReasons).toEqual({ customer_changed: 1 });
    expect(draftShadowReply).not.toHaveBeenCalled();
  });

  test('uses the webhook sender match with the text sender phone', async () => {
    await draftedIds([inboundRow({ from_phone: '+19415550177' })]);
    expect(findCustomerOk).toHaveBeenCalledWith('+19415550177');
  });

  test('the AI line check ignores formatting', () => {
    expect(isAiNumber('+1 (855) 926-0203')).toBe(true);
    expect(isAiNumber(LOCATION_LINE)).toBe(false);
    expect(isAiNumber(null)).toBe(false);
  });
});

describe('dedup', () => {
  test('a text that got a draft after the candidate read (a slow live draft, an overlapping run) is skipped, not drafted twice', async () => {
    const result = await run(fakeDbi({ rows: [inboundRow({ id: 'sms-1' }), inboundRow({ id: 'sms-2' })], drafted: new Set(['sms-1']) }));
    expect(draftShadowReply.mock.calls.map(([a]) => a.smsLogId)).toEqual(['sms-2']);
    expect(result).toMatchObject({ drafted: 1, skipped: 1, skippedReasons: { already_drafted: 1 } });
  });
});

describe('order and limit', () => {
  const rows = ['sms-1', 'sms-2', 'sms-3', 'sms-4'].map((id, i) => inboundRow({ id, created_at: new Date(Date.UTC(2026, 10, 1, 14, 10 + i)) }));

  test('drafts in the order the query returns (oldest first), at most `limit` per call', async () => {
    const result = await run(fakeDbi({ rows }), { limit: 2 });
    expect(draftShadowReply.mock.calls.map(([a]) => a.smsLogId)).toEqual(['sms-1', 'sms-2']);
    expect(result).toMatchObject({ drafted: 2, examined: 4 });
  });

  test('rows skipped by a filter do not use up the limit', async () => {
    const mixed = [inboundRow({ id: 'sms-r', message_body: 'Loved "Thanks so much"' }), inboundRow({ id: 'sms-a' }), inboundRow({ id: 'sms-b' })];
    const result = await run(fakeDbi({ rows: mixed }), { limit: 2 });
    expect(draftShadowReply.mock.calls.map(([a]) => a.smsLogId)).toEqual(['sms-a', 'sms-b']);
    expect(result).toMatchObject({ drafted: 2, skipped: 1 });
  });

  test('a draft that stores nothing counts as failed and uses up the limit; a throw is contained', async () => {
    draftShadowReply.mockResolvedValueOnce(null).mockRejectedValueOnce(Object.assign(new Error(`bound value ${BODY_MARKER}`), { code: '23505' }));
    const result = await run(fakeDbi({ rows }), { limit: 3 });
    expect(result).toMatchObject({ drafted: 1, failed: 2 });
    expect(draftShadowReply).toHaveBeenCalledTimes(3);
  });

  test('limit is clamped to a sane range', async () => {
    const dbi = fakeDbi({ rows: [] });
    await run(dbi, { limit: 100000 });
    expect(dbi.queries[0].calls.find(([m]) => m === 'limit')[1][0]).toBe(100);
    await run(fakeDbi({ rows }), { limit: -5 });
    expect(draftShadowReply).toHaveBeenCalledTimes(1);
  });
});

describe('the call into the shadow drafter', () => {
  test('same arguments as the webhook plus the late overrides: source mac_late, asOf = the inbound instant, live ETA off', async () => {
    const created = new Date('2026-11-01T14:43:21.500Z');
    const row = inboundRow({ message_body: 'Can you come Tuesday?', created_at: created, metadata: JSON.stringify({ media: [{ url: 'https://example.test/a.jpg' }] }) });
    await run(fakeDbi({ rows: [row] }));
    expect(classifyCustomerSmsTriageIntent).toHaveBeenCalledWith('Can you come Tuesday?', { customer: customerFor() });
    expect(draftShadowReply).toHaveBeenCalledTimes(1);
    const args = draftShadowReply.mock.calls[0][0];
    expect(args).toEqual({
      inboundMessage: 'Can you come Tuesday?',
      fromPhone: '+19415550101',
      customer: customerFor(),
      smsLogId: 'sms-1',
      intent: classifyCustomerSmsTriageIntent.mock.results[0].value,
      schedulingIntent: true,
      source: 'mac_late',
      hasMedia: true,
      asOf: created,
      liveEta: false,
    });
    expect(args.asOf).toBeInstanceOf(Date);
    expect(args.asOf.getTime()).toBe(created.getTime());
  });

  test('a text with no media and no scheduling words is not flagged either way', async () => {
    await run(fakeDbi({ rows: [inboundRow({ message_body: 'Do you treat for ants?' })] }));
    expect(draftShadowReply.mock.calls[0][0]).toMatchObject({ schedulingIntent: false, hasMedia: false });
  });

  test('a creation time that arrives as a string still becomes a Date', async () => {
    await run(fakeDbi({ rows: [inboundRow({ created_at: '2026-11-01T14:40:00.000Z' })] }));
    expect(draftShadowReply.mock.calls[0][0].asOf).toEqual(new Date('2026-11-01T14:40:00.000Z'));
  });
});

describe('external calls', () => {
  test('a paid host reached from the drafting path is refused and reported by host; a model host is not', async () => {
    let refusalCode;
    draftShadowReply.mockImplementationOnce(async () => {
      await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=x').catch((err) => { refusalCode = err.code; });
      await fetch('https://api.anthropic.com/v1/messages');
      return 'draft-1';
    });
    const result = await run(fakeDbi({ rows: [inboundRow()] }));
    expect(refusalCode).toBe('LATE_DRAFT_EGRESS_BLOCKED');
    expect(result).toMatchObject({ drafted: 1, blockedExternal: { 'maps.googleapis.com': 1 } });
    expect(stubFetch).toHaveBeenCalledTimes(1);
    expect(stubFetch.mock.calls[0][0]).toContain('api.anthropic.com');
  });

  test('a clean run reports no blockedExternal key', async () => {
    expect(await run(fakeDbi({ rows: [inboundRow()] }))).not.toHaveProperty('blockedExternal');
  });
});

describe('run lock', () => {
  function lockClient({ acquired }) {
    const conn = { query: jest.fn(async (sql) => ({ rows: [{ ok: /try_advisory_lock/.test(sql) ? acquired : true }] })) };
    return { conn, client: { acquireConnection: jest.fn(async () => conn), releaseConnection: jest.fn() } };
  }

  test('another run holds the lock: { skipped: locked }, no candidate read, connection released', async () => {
    const { conn, client } = lockClient({ acquired: false });
    const dbi = fakeDbi({ rows: [inboundRow()], client });
    expect(await run(dbi)).toEqual({ skipped: 'locked' });
    expect(dbi).not.toHaveBeenCalled();
    expect(draftShadowReply).not.toHaveBeenCalled();
    expect(client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('lock held for the run, then released and the connection returned', async () => {
    const { conn, client } = lockClient({ acquired: true });
    const result = await run(fakeDbi({ rows: [inboundRow()], client }));
    expect(result).toMatchObject({ drafted: 1 });
    expect(conn.query).toHaveBeenNthCalledWith(1, 'SELECT pg_try_advisory_lock($1) AS ok', [RUN_LOCK_KEY]);
    expect(conn.query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1)', [RUN_LOCK_KEY]);
    expect(client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('the lock is released even when the batch throws', async () => {
    const { conn, client } = lockClient({ acquired: true });
    const dbi = fakeDbi({ rows: [], client });
    dbi.mockImplementation(() => { throw new Error('candidate read down'); });
    await expect(run(dbi)).rejects.toThrow('candidate read down');
    expect(conn.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [RUN_LOCK_KEY]);
    expect(client.releaseConnection).toHaveBeenCalledWith(conn);
  });

  test('a lock error skips the run instead of drafting unlocked', async () => {
    const client = { acquireConnection: jest.fn(async () => { throw new Error('pool exhausted'); }), releaseConnection: jest.fn() };
    expect(await run(fakeDbi({ rows: [inboundRow()], client }))).toEqual({ skipped: 'lock_error' });
    expect(draftShadowReply).not.toHaveBeenCalled();
  });
});

describe('logging', () => {
  test('no log line carries message text, a phone number or an error message', async () => {
    draftShadowReply
      .mockResolvedValueOnce('draft-1')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(Object.assign(new Error(`insert failed for ${BODY_MARKER} +19415550101`), { code: '22P02' }));
    const rows = ['sms-1', 'sms-2', 'sms-3'].map((id) => inboundRow({ id }));
    await run(fakeDbi({ rows }));
    const lines = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => c.join(' '));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(BODY_MARKER);
      expect(line).not.toContain('9415550101');
      expect(line).not.toContain('insert failed');
    }
    expect(lines.join('\n')).toContain('22P02');
  });
});
