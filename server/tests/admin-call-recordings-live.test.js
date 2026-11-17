// GET /api/admin/call-recordings/live: the calls being transcribed right now, for the
// Communications "Live call" panel. Admin-only, read-only, shaped and bounded.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({}));
jest.mock('../utils/known-caller-phone', () => ({ findKnownCallerCustomer: jest.fn() }));
const mockAssist = { refreshAssistIfDue: jest.fn(() => new Promise(() => {})), assistForPanel: jest.fn(() => null) };
jest.mock('../services/live-call-assist', () => mockAssist);
const mockGates = { isEnabled: jest.fn(() => true) };
jest.mock('../config/feature-gates', () => mockGates);
const mockHold = { isEnabled: jest.fn(() => false), holdForPanel: jest.fn(() => null), requestHold: jest.fn() };
jest.mock('../services/call-hold', () => mockHold);

let mockRole = 'admin';
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; req.techRole = mockRole; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, res, next) => (mockRole === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })),
}));

const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { findKnownCallerCustomer } = require('../utils/known-caller-phone');
const router = require('../routes/admin-call-recordings');

function withServer(fn) {
  const app = express();
  app.use('/admin/call-recordings', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

const SID_A = `CA${'a'.repeat(32)}`;
const SID_B = `CA${'b'.repeat(32)}`;

// Records the call_log query (filters, limit) and answers per table.
function mockDb({ calls = [], utterances = {}, linked = null, callLogError = null }) {
  const seen = { callLog: null, utteranceSids: [] };
  db.mockImplementation((table) => {
    const b = { wheres: [], raws: [] };
    const self = () => b;
    Object.assign(b, {
      where(...a) { b.wheres.push(a); return b; },
      whereRaw(sql, bindings) { b.raws.push(sql); if (bindings) b.bindings = bindings; return b; },
      whereNull: self, orderBy: self, select: self,
      limit(n) { b.max = n; return b; },
      first() { return Promise.resolve(linked); },
      then(resolve, reject) {
        if (table === 'call_log') {
          seen.callLog = b;
          return (callLogError ? Promise.reject(callLogError) : Promise.resolve(calls)).then(resolve, reject);
        }
        const sid = b.wheres.find((w) => w[0] === 'call_sid')?.[1];
        seen.utteranceSids.push(sid);
        // Stored newest first, as the route asks for it.
        return Promise.resolve((utterances[sid] || []).slice(0, b.max)).then(resolve, reject);
      },
    });
    return b;
  });
  return seen;
}

const row = (n, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  twilio_call_sid: n === 1 ? SID_A : SID_B,
  customer_id: null,
  from_phone: '+19415550101',
  metadata: {
    live_transcription: { live_at: '2026-11-17T15:00:00.000Z' },
    forward_acceptance: { accepted: true, csr_name: 'Pat Example', answered_by_number: '+19415550102' },
  },
  ...extra,
});
const utt = (i, speaker = 'caller') => ({ speaker, text: `line ${i}`, spoken_at: `2026-11-17T15:00:${String(i).padStart(2, '0')}.000Z` });

beforeEach(() => { jest.clearAllMocks(); mockAssist.assistForPanel.mockReturnValue(null); mockRole = 'admin'; findKnownCallerCustomer.mockResolvedValue(null); mockGates.isEnabled.mockImplementation(() => true); });

beforeEach(() => {
  mockHold.isEnabled.mockReset().mockReturnValue(false);
  mockHold.holdForPanel.mockReset().mockReturnValue(null);
  mockHold.requestHold.mockReset();
});

describe('the Hold button (GATE_CALL_HOLD)', () => {
  const ID = row(1).id;
  const postHold = (base, id = ID) => fetch(`${base}/admin/call-recordings/live/${id}/hold`, { method: 'POST' });

  test("GET /live, gate on: each call carries the hold view of its own conference_path", async () => {
    mockHold.isEnabled.mockReturnValue(true);
    const view = { can_hold: true, on_hold: false, since: null };
    mockHold.holdForPanel.mockReturnValue(view);
    const cp = { accepted_leg_sid: SID_B };
    mockDb({ calls: [row(1, { metadata: { ...row(1).metadata, conference_path: cp } })], utterances: { [SID_A]: [] } });
    await withServer(async (base) => {
      const { calls } = await (await fetch(`${base}/admin/call-recordings/live`)).json();
      expect(calls[0].hold).toEqual(view);
    });
    expect(mockHold.holdForPanel).toHaveBeenCalledWith(cp);
  });

  test('GET /live, gate off: hold is null on every call and no view is read', async () => {
    mockHold.holdForPanel.mockReturnValue({ can_hold: true, on_hold: false, since: null });
    mockDb({ calls: [row(1), row(2)], utterances: {} });
    await withServer(async (base) => {
      const { calls } = await (await fetch(`${base}/admin/call-recordings/live`)).json();
      expect(calls.map((c) => c.hold)).toEqual([null, null]);
    });
    expect(mockHold.holdForPanel).not.toHaveBeenCalled();
  });

  test('POST: a technician login is refused before any query or move', async () => {
    mockRole = 'technician';
    mockHold.isEnabled.mockReturnValue(true);
    mockDb({ linked: { twilio_call_sid: SID_A } });
    await withServer(async (base) => { expect((await postHold(base)).status).toBe(403); });
    expect(db).not.toHaveBeenCalled();
    expect(mockHold.requestHold).not.toHaveBeenCalled();
  });

  test('POST: a call id that is not a UUID is 400; gate off is 409 unavailable; neither reads or moves anything', async () => {
    mockDb({ linked: { twilio_call_sid: SID_A } });
    await withServer(async (base) => {
      mockHold.isEnabled.mockReturnValue(true);
      expect((await postHold(base, 'not-a-uuid')).status).toBe(400);
      mockHold.isEnabled.mockReturnValue(false);
      const off = await postHold(base);
      expect(off.status).toBe(409);
      expect(await off.json()).toEqual({ result: 'unavailable' });
    });
    expect(db).not.toHaveBeenCalled();
    expect(mockHold.requestHold).not.toHaveBeenCalled();
  });

  test('POST: an unknown call is 404 and nothing is moved', async () => {
    mockHold.isEnabled.mockReturnValue(true);
    mockDb({ linked: null });
    await withServer(async (base) => { expect((await postHold(base)).status).toBe(404); });
    expect(mockHold.requestHold).not.toHaveBeenCalled();
  });

  test("POST: the call's own SID is asked for a button hold, and each answer maps to its status", async () => {
    mockHold.isEnabled.mockReturnValue(true);
    mockDb({ linked: { twilio_call_sid: SID_A } });
    await withServer(async (base) => {
      for (const [result, status] of [['requested', 200], ['on_hold', 200], ['unavailable', 409], ['failed', 502]]) {
        mockHold.requestHold.mockResolvedValueOnce(result);
        const res = await postHold(base);
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ result });
      }
    });
    expect(mockHold.requestHold).toHaveBeenCalledTimes(4);
    expect(mockHold.requestHold.mock.calls.every((c) => c[0] === SID_A && c[1].by === 'button')).toBe(true);
  });

  test('POST: a database error answers 500 through the router error path', async () => {
    mockHold.isEnabled.mockReturnValue(true);
    db.mockImplementation(() => ({ where() { return this; }, first: () => Promise.reject(new Error('db down')) }));
    await withServer(async (base) => { expect((await postHold(base)).status).toBe(500); });
    expect(mockHold.requestHold).not.toHaveBeenCalled();
  });
});

describe('GET /admin/call-recordings/live: assist (GATE_CALL_LIVE_ASSIST)', () => {
  test('gate on: each call carries its assist and a refresh starts without the response waiting for it', async () => {
    findKnownCallerCustomer.mockResolvedValue({ id: 'cust-1', first_name: 'Casey', last_name: 'Sample' });
    const panel = { intent: 'Wants pest control', price: 'Standard pest control pricing: $99', times: 'Tuesday at 9 AM', at: '2026-11-17T15:01:00.000Z' };
    mockAssist.assistForPanel.mockReturnValue(panel);
    // The refresh never settles: a response that awaited it would hang.
    mockAssist.refreshAssistIfDue.mockImplementation(() => new Promise(() => {}));
    mockDb({ calls: [row(1)], utterances: { [SID_A]: [utt(1)] } });
    await withServer(async (base) => {
      const { calls } = await (await fetch(`${base}/admin/call-recordings/live`)).json();
      expect(calls[0].assist).toEqual(panel);
    });
    expect(mockAssist.refreshAssistIfDue).toHaveBeenCalledTimes(1);
    expect(mockAssist.refreshAssistIfDue.mock.calls[0][0].twilio_call_sid).toBe(SID_A);
    expect(mockAssist.refreshAssistIfDue.mock.calls[0][1]).toEqual({ customerId: 'cust-1' });
  });

  test('a refresh that rejects still lets the response through with the calls, and the log carries no SID or message', async () => {
    mockAssist.refreshAssistIfDue.mockImplementationOnce(() => Promise.reject(Object.assign(new Error(`boom ${SID_A} Casey Sample`), { code: 'EBOOM' })));
    mockDb({ calls: [row(1)], utterances: { [SID_A]: [utt(1)] } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/live`);
      expect(res.status).toBe(200);
      const { calls } = await res.json();
      expect(calls).toHaveLength(1);
      expect(calls[0].lines).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockAssist.refreshAssistIfDue).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = logger.warn.mock.calls[0].join(' ');
    expect(logged).toContain('EBOOM');
    expect(logged).not.toContain(SID_A);
    expect(logged).not.toMatch(/boom|Casey|Sample/);
  });

  test('gate off: assist is null on every call and nothing is refreshed', async () => {
    mockGates.isEnabled.mockImplementation((gate) => gate !== 'callLiveAssist');
    mockAssist.assistForPanel.mockReturnValue({ intent: 'should not show' });
    mockDb({ calls: [row(1), row(2)], utterances: {} });
    await withServer(async (base) => {
      const { calls } = await (await fetch(`${base}/admin/call-recordings/live`)).json();
      expect(calls.map((c) => c.assist)).toEqual([null, null]);
    });
    expect(mockAssist.refreshAssistIfDue).not.toHaveBeenCalled();
    expect(mockAssist.assistForPanel).not.toHaveBeenCalled();
  });
});

describe('GET /admin/call-recordings/live', () => {
  test('a technician login is refused before any query', async () => {
    mockRole = 'technician';
    mockDb({ calls: [row(1)] });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/live`);
      expect(res.status).toBe(403);
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('an admin gets the live call with its customer, agent and lines in spoken order', async () => {
    findKnownCallerCustomer.mockResolvedValue({ id: 'cust-1', first_name: 'Casey', last_name: 'Sample' });
    const newestFirst = [3, 2, 1].map((i) => utt(i, i === 2 ? 'staff' : 'caller'));
    const seen = mockDb({ calls: [row(1)], utterances: { [SID_A]: newestFirst } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/live`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calls).toEqual([{
        id: row(1).id,
        started_at: '2026-11-17T15:00:00.000Z',
        caller_phone: '+19415550101',
        customer: { id: 'cust-1', name: 'Casey Sample' },
        answered_by: 'Pat Example',
        assist: null,
        hold: null,
        lines: [
          { speaker: 'caller', text: 'line 1', at: '2026-11-17T15:00:01.000Z' },
          { speaker: 'staff', text: 'line 2', at: '2026-11-17T15:00:02.000Z' },
          { speaker: 'caller', text: 'line 3', at: '2026-11-17T15:00:03.000Z' },
        ],
      }]);
    });
    expect(seen.utteranceSids).toEqual([SID_A]);
  });

  test('the call row link wins over the phone lookup; no match and no agent answer null', async () => {
    mockDb({
      calls: [row(1, { customer_id: 'cust-9' }), row(2, { metadata: { live_transcription: { live_at: '2026-11-17T15:01:00.000Z' } } })],
      linked: { id: 'cust-9', first_name: 'Jo', last_name: null },
    });
    await withServer(async (base) => {
      const { calls } = await (await fetch(`${base}/admin/call-recordings/live`)).json();
      expect(calls[0].customer).toEqual({ id: 'cust-9', name: 'Jo' });
      // Second row has no customer_id: falls to the phone lookup, which finds nobody.
      expect(calls[1].customer).toBeNull();
      expect(calls[1].answered_by).toBeNull();
      expect(calls[1].lines).toEqual([]);
    });
  });

  test('asks for the last 2 hours, live and not stopped, 5 at most, 15 lines each', async () => {
    const seen = mockDb({ calls: [row(1)], utterances: { [SID_A]: [] } });
    const before = Date.now();
    await withServer(async (base) => { await fetch(`${base}/admin/call-recordings/live`); });
    const q = seen.callLog;
    const [col, op, since] = q.wheres.find((w) => w[0] === 'created_at');
    expect([col, op]).toEqual(['created_at', '>=']);
    expect(Math.abs((before - since.getTime()) - 2 * 60 * 60 * 1000)).toBeLessThan(5000);
    expect(q.raws.some((s) => /live_at'\) IS NOT NULL/.test(s))).toBe(true);
    expect(q.raws.some((s) => /stopped_at'\) IS NULL/.test(s))).toBe(true);
    expect(q.max).toBe(5);
  });

  test('a call with a final status is left out, even when its stopped event was lost', async () => {
    const seen = mockDb({ calls: [], utterances: {} });
    await withServer(async (base) => { await fetch(`${base}/admin/call-recordings/live`); });
    const statusRaw = seen.callLog.raws.find((s) => /status IS NULL OR status NOT IN/.test(s));
    expect(statusRaw).toBeTruthy();
    expect(seen.callLog.bindings).toEqual(expect.arrayContaining(['completed', 'busy', 'failed', 'no-answer', 'canceled']));
  });

  test('live text off: answers enabled false with no query', async () => {
    mockGates.isEnabled.mockImplementation((gate) => gate !== 'liveCallTranscription');
    const seen = mockDb({ calls: [row(1)] });
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/admin/call-recordings/live`)).json()).toEqual({ enabled: false, calls: [] });
    });
    expect(seen.callLog).toBeNull();
  });

  test('keeps only the last 15 lines of a long call', async () => {
    const many = Array.from({ length: 30 }, (_, i) => utt(30 - i));
    mockDb({ calls: [row(1)], utterances: { [SID_A]: many } });
    await withServer(async (base) => {
      const { calls } = await (await fetch(`${base}/admin/call-recordings/live`)).json();
      expect(calls[0].lines).toHaveLength(15);
      expect(calls[0].lines[14].text).toBe('line 30');
      expect(calls[0].lines[0].text).toBe('line 16');
    });
  });

  test('no live call answers an empty list', async () => {
    mockDb({ calls: [] });
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/admin/call-recordings/live`)).json()).toEqual({ enabled: true, calls: [] });
    });
  });

  test('a database error answers 500 through the router error path', async () => {
    mockDb({ callLogError: new Error('db down') });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/live`);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('db down');
    });
  });
});
