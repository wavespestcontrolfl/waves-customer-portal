// The call-intelligence admin endpoints: reads are staff-visible, every
// correction is admin-only, ids are validated before any query, and the
// customer relink stamps the override that the processor honours.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ processRecording: jest.fn(), quarantineCardRecording: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(() => Promise.resolve(true)) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/sms-operational-actions', () => ({
  smsCommitmentsEnabled: jest.fn(() => false), listSmsCommitments: jest.fn(async () => []), applySmsCommitmentUpdate: jest.fn(),
}));
jest.mock('../services/call-intelligence', () => ({ loadCallIntelligence: jest.fn() }));
jest.mock('../services/call-commitments', () => ({
  applyHumanUpdate: jest.fn(),
  addHumanCommitment: jest.fn(),
  listOpenCommitments: jest.fn(),
  refreshFulfillment: jest.fn(() => Promise.resolve({ fulfilled: 0 })),
  OVERDUE_IMPLICIT_DAYS: 3,
  OVERDUE_IMPLICIT_ESTIMATE_HOURS: 24,
}));

// `mock`-prefixed so the jest.mock factory may read it (it is read lazily,
// per request, never at factory time).
let mockRole = 'admin';
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; req.techRole = mockRole; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, res, next) => (mockRole === 'admin' ? next() : res.status(403).json({ error: 'Admin only' })),
}));

const express = require('express');
const db = require('../models/db');
const processor = require('../services/call-recording-processor');
const intelligence = require('../services/call-intelligence');
const { isEnabled } = require('../config/feature-gates');
const commitments = require('../services/call-commitments');
const router = require('../routes/admin-call-recordings');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/call-recordings', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

const CALL_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const COMMIT_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const SID = 'CA' + '4'.repeat(32);

// Minimal query recorder: `first()` answers from a queue, `update()` records
// its patch, `where` chains accumulate.
function mockDb(firstResults) {
  const queue = [...firstResults];
  const updates = [];
  db.mockImplementation((table) => {
    const b = {
      table,
      wheres: [],
      // A grouped where(fn) records its nested clauses too, so fence
      // assertions can see them.
      where(...a) { if (typeof a[0] === 'function') { a[0].call(b); return b; } b.wheres.push(a); return b; },
      whereNull() { return b; },
      whereIn() { return b; },
      whereNotIn(...a) { b.wheres.push(['notin', ...a]); return b; },
      whereNotExists() { return b; },
      whereNot(...a) { b.nots = [...(b.nots || []), a]; return b; },
      forUpdate() { b.locked = true; return b; },
      whereRaw(sql, bindings) { b.wheres.push(['raw', sql, bindings]); return b; },
      first: () => Promise.resolve(queue.shift() ?? null),
      update: (patch) => { updates.push({ table, patch, wheres: [...b.wheres] }); return Object.assign(Promise.resolve(1), { catch: () => Promise.resolve(1) }); },
      del: () => { updates.push({ table, patch: { __deleted: true }, wheres: [...b.wheres] }); return Object.assign(Promise.resolve(1), { catch: () => Promise.resolve(1) }); },
    };
    return b;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // The relink runs call_log + timeline in one transaction.
  db.transaction = jest.fn(async (fn) => fn(db));
  return updates;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'admin';
  isEnabled.mockReturnValue(true);
  require('../services/sms-operational-actions').smsCommitmentsEnabled.mockReturnValue(false);
});

describe('GET /calls/:id/intelligence', () => {
  test('rejects a non-UUID id before touching the database', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/not-a-uuid/intelligence`);
      expect(res.status).toBe(400);
      expect(intelligence.loadCallIntelligence).not.toHaveBeenCalled();
    });
  });
  test('returns the normalized object for staff', async () => {
    mockRole = 'tech';
    intelligence.loadCallIntelligence.mockResolvedValue({ call_id: CALL_ID, commitments: [] });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/intelligence`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.intelligence.call_id).toBe(CALL_ID);
      // The panel hides its write controls on these flags: commitments while
      // the gate is off, the admin-only corrections for non-admins.
      expect(body.features).toEqual({ commitments: true, admin: false });
    });
    isEnabled.mockReturnValue(false);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/intelligence`);
      expect((await res.json()).features).toEqual({ commitments: false, admin: false });
    });
  });
  test('404s when the call does not exist', async () => {
    intelligence.loadCallIntelligence.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/intelligence`);
      expect(res.status).toBe(404);
    });
  });
});

describe('GET /commitments/open — the Owed queue', () => {
  test('validates its filters before any query', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/admin/call-recordings/commitments/open?party=aliens`)).status).toBe(400);
      expect((await fetch(`${base}/admin/call-recordings/commitments/open?customer_id=nope`)).status).toBe(400);
      expect((await fetch(`${base}/admin/call-recordings/commitments/open?lead_id=nope`)).status).toBe(400);
    });
    expect(commitments.listOpenCommitments).not.toHaveBeenCalled();
  });

  test('staff can read the queue; filters pass through; kept promises are refreshed off the page before it is returned', async () => {
    mockRole = 'tech';
    const open = [{ id: 'c1', call_log_id: CALL_ID, kind: 'callback', status: 'open', overdue: true }, { id: 'c2', call_log_id: CALL_ID, kind: 'send_estimate', status: 'open', overdue: false }];
    // filtered page → unfiltered refresh candidates → filtered re-list
    commitments.listOpenCommitments.mockResolvedValueOnce(open).mockResolvedValueOnce(open).mockResolvedValueOnce([open[0]]);
    commitments.refreshFulfillment.mockResolvedValueOnce({ fulfilled: 1 });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/open?party=waves&customer_id=${CUSTOMER_ID}&hints=0&limit=50`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commitments).toEqual([open[0]]);
      expect(body.overdue_implicit_days).toBe(3);
      expect(body.enabled).toBe(true);
    });
    // limit + 1: the probe row behind has_more.
    expect(commitments.listOpenCommitments).toHaveBeenCalledWith(db, { party: 'waves', customerId: CUSTOMER_ID, leadId: null, limit: 51, offset: 0, includeHints: false });
    // hints=0: the refresh candidates come from the UNFILTERED page, so a
    // hint the facts no longer support gets cleared instead of hiding the
    // row for good.
    expect(commitments.listOpenCommitments).toHaveBeenCalledWith(db, { party: 'waves', customerId: CUSTOMER_ID, leadId: null, limit: 51, offset: 0, includeHints: true });
    expect(commitments.refreshFulfillment).toHaveBeenCalledWith(db, CALL_ID);
    expect(commitments.listOpenCommitments).toHaveBeenCalledTimes(3);
  });

  test('the queue is paged: a full page plus the probe row says has_more with the next offset; offset is validated (codex #3725 r17 P2)', async () => {
    const open = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, call_log_id: CALL_ID, kind: 'callback', status: 'open', overdue: false }));
    commitments.listOpenCommitments.mockResolvedValue(open);
    await withServer(async (base) => {
      expect((await fetch(`${base}/admin/call-recordings/commitments/open?offset=-1`)).status).toBe(400);
      expect((await fetch(`${base}/admin/call-recordings/commitments/open?offset=abc`)).status).toBe(400);
      const res = await fetch(`${base}/admin/call-recordings/commitments/open?limit=2&offset=4`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commitments.map((r) => r.id)).toEqual(['c0', 'c1']);
      expect(body.has_more).toBe(true);
      expect(body.next_offset).toBe(6);
      commitments.listOpenCommitments.mockResolvedValue(open.slice(0, 2));
      const last = await (await fetch(`${base}/admin/call-recordings/commitments/open?limit=2&offset=6`)).json();
      expect(last.commitments).toHaveLength(2);
      expect(last.has_more).toBe(false);
      expect(last.next_offset).toBeNull();
    });
    expect(commitments.listOpenCommitments).toHaveBeenCalledWith(db, expect.objectContaining({ limit: 3, offset: 4 }));
  });

  test('a page spanning more than 25 calls is verified in a ROTATING window, so every call is refreshed across reads (codex #3725 r16 P2)', async () => {
    const calls = Array.from({ length: 30 }, (_, i) => `0000000${String(i).padStart(1, '0')}-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
    const open = calls.map((id, i) => ({ id: `c${i}`, call_log_id: id, kind: 'callback', status: 'open', overdue: false }));
    commitments.listOpenCommitments.mockResolvedValue(open);
    await withServer(async (base) => {
      expect((await fetch(`${base}/admin/call-recordings/commitments/open`)).status).toBe(200);
      expect((await fetch(`${base}/admin/call-recordings/commitments/open`)).status).toBe(200);
    });
    const refreshed = commitments.refreshFulfillment.mock.calls.map((c) => c[1]);
    expect(refreshed).toHaveLength(50);
    expect(new Set(refreshed).size).toBe(30);
  });

  test('a refresh that only found or withdrew a "possibly kept" hint re-lists too, so the page shows what the refresh learned', async () => {
    const open = [{ id: 'c1', call_log_id: CALL_ID, kind: 'callback', status: 'open', overdue: false, fulfillment: null }];
    const hinted = [{ ...open[0], fulfillment: { strength: 'association' } }];
    commitments.listOpenCommitments.mockResolvedValueOnce(open).mockResolvedValueOnce(hinted);
    commitments.refreshFulfillment.mockResolvedValueOnce({ checked: 1, fulfilled: 0, hinted: 1, cleared: 0 });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/open`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commitments).toEqual(hinted);
      expect(body.overdue_implicit_estimate_hours).toBe(24);
    });
    expect(commitments.listOpenCommitments).toHaveBeenCalledTimes(2);
  });

  test('gate off: rows already recorded are still listed, but no fulfillment refresh runs (nothing is written)', async () => {
    isEnabled.mockReturnValue(false);
    const open = [{ id: 'c1', call_log_id: CALL_ID, kind: 'callback', status: 'open', overdue: true }];
    commitments.listOpenCommitments.mockResolvedValueOnce(open);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/open`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commitments).toEqual(open);
      expect(body.enabled).toBe(false);
    });
    expect(commitments.refreshFulfillment).not.toHaveBeenCalled();
    expect(commitments.listOpenCommitments).toHaveBeenCalledTimes(1);
  });
});

describe('commitment writes are staff-wide but fail closed when the gate is off', () => {
  test.each([
    ['PATCH', `/commitments/${COMMIT_ID}`, { action: 'confirm' }],
    ['POST', `/calls/${CALL_ID}/commitments`, { party: 'waves', kind: 'callback', description: 'x' }],
  ])('%s %s → 409 COMMITMENTS_DISABLED with the gate off, no service call', async (method, path, body) => {
    isEnabled.mockReturnValue(false);
    mockDb([]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('COMMITMENTS_DISABLED');
    });
    expect(commitments.applyHumanUpdate).not.toHaveBeenCalled();
    expect(commitments.addHumanCommitment).not.toHaveBeenCalled();
  });

  test('a technician receives the intelligence without billing outcomes (invoices, revenue) — admin-only everywhere else (codex gh-r11 P1)', async () => {
    mockRole = 'technician';
    require('../services/call-intelligence').loadCallIntelligence.mockImplementation(async () => ({ call_id: CALL_ID, outcomes: { lead: null, estimates: [], appointments: [], invoices: [{ id: 'inv-1', total: 250, status: 'paid', paid_at: 'T' }], revenue_cents: 25000, basis_note: '' } }));
    mockDb([]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/intelligence`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.features.admin).toBe(false);
      expect(body.intelligence.outcomes).toMatchObject({ invoices: [], revenue_cents: null, billing_hidden: true });
    });
    mockRole = 'admin';
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/intelligence`)).json();
      expect(body.intelligence.outcomes.invoices).toHaveLength(1);
      expect(body.intelligence.outcomes.revenue_cents).toBe(25000);
    });
  });

  test('a technician can settle a promise (staff-wide, like tagging a disposition)', async () => {
    mockRole = 'tech';
    mockDb([{ call_log_id: CALL_ID }]);
    commitments.applyHumanUpdate.mockResolvedValue({ id: COMMIT_ID, human_state: 'confirmed' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/${COMMIT_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
      expect(res.status).toBe(200);
    });
  });
});

describe('PUT /calls/:id/customer repairs an earlier customer_creation_failed', () => {
  test('the correction resolves that card in the same transaction and clears review when nothing else is open', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: null, twilio_call_sid: SID }, { id: CUSTOMER_ID }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(200);
    });
    const card = updates.find((u) => u.table === 'triage_items' && u.patch.status === 'resolved');
    expect(card).toBeDefined();
    expect(card.patch.resolution_note).toContain(CUSTOMER_ID);
    expect(updates.find((u) => u.table === 'call_log' && u.patch.review_status === null)).toBeDefined();
  });
});

describe('PUT /calls/:id/customer requires an explicit customer_id', () => {
  test('a body without customer_id is a 400, never an unlink', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: CUSTOMER_ID, twilio_call_sid: SID }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      expect(res.status).toBe(400);
    });
    expect(updates).toHaveLength(0);
  });
});

describe('customer relink and recording adoption stay admin-only', () => {
  test.each([
    ['PUT', `/calls/${CALL_ID}/customer`, { customer_id: CUSTOMER_ID }],
    ['POST', `/calls/${CALL_ID}/adopt-recording`, { recording_sid: 'RE' + '1'.repeat(32) }],
  ])('%s %s → 403 for a technician', async (method, path, body) => {
    mockRole = 'tech';
    mockDb([]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(403);
    });
    expect(commitments.applyHumanUpdate).not.toHaveBeenCalled();
    expect(commitments.addHumanCommitment).not.toHaveBeenCalled();
    expect(processor.processRecording).not.toHaveBeenCalled();
  });
});

describe('PATCH /commitments/:id', () => {
  test('passes the verdict and the reviewer through; service 4xx errors keep their status', async () => {
    mockDb([{ call_log_id: CALL_ID }, { call_log_id: CALL_ID }]);
    commitments.applyHumanUpdate.mockResolvedValue({ id: COMMIT_ID, human_state: 'confirmed' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/${COMMIT_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm', note: 'checked' }) });
      expect(res.status).toBe(200);
      expect(commitments.applyHumanUpdate).toHaveBeenCalledWith(db, COMMIT_ID, expect.objectContaining({ action: 'confirm', note: 'checked', reviewedBy: 'tech-1' }));
    });
    commitments.applyHumanUpdate.mockRejectedValue(Object.assign(new Error('Unknown commitment action: explode'), { status: 400 }));
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/${COMMIT_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'explode' }) });
      expect(res.status).toBe(400);
    });
  });
});

describe('customer-profile SMS commitments', () => {
  const sms = require('../services/sms-operational-actions');
  test('the SMS read requires one customer and preserves pagination', async () => {
    sms.smsCommitmentsEnabled.mockReturnValue(true);
    sms.listSmsCommitments.mockResolvedValue([{ id: 'one' }, { id: 'two' }, { id: 'next' }]);
    await withServer(async (base) => {
      expect((await fetch(`${base}/admin/call-recordings/commitments/sms`)).status).toBe(400);
      expect((await fetch(`${base}/admin/call-recordings/commitments/sms?customer_id=${CUSTOMER_ID}&offset=-1`)).status).toBe(400);
      const body = await (await fetch(`${base}/admin/call-recordings/commitments/sms?customer_id=${CUSTOMER_ID}&limit=2&offset=4`)).json();
      expect(body).toEqual({ commitments: [{ id: 'one' }, { id: 'two' }], enabled: true, has_more: true, next_offset: 6 });
      expect(sms.listSmsCommitments).toHaveBeenCalledWith(db, { customerId: CUSTOMER_ID, limit: 3, offset: 4 });
      expect(commitments.listOpenCommitments).not.toHaveBeenCalled();
    });
  });

  test('SMS closure uses its own gate and writer even when the call lane is disabled', async () => {
    isEnabled.mockReturnValue(false);
    sms.smsCommitmentsEnabled.mockReturnValue(true);
    mockDb([{ sms_log_id: CALL_ID }]);
    sms.applySmsCommitmentUpdate.mockResolvedValue({ id: COMMIT_ID, status: 'fulfilled' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/${COMMIT_ID}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fulfill', customer_id: CUSTOMER_ID }),
      });
      expect(res.status).toBe(200);
      expect(sms.applySmsCommitmentUpdate).toHaveBeenCalledWith(db, COMMIT_ID,
        expect.objectContaining({ customerId: CUSTOMER_ID, action: 'fulfill', reviewedBy: 'tech-1' }));
      expect(commitments.applyHumanUpdate).not.toHaveBeenCalled();
    });
  });

  test('call controls cannot bypass a disabled SMS lane or omit its profile scope', async () => {
    mockDb([{ sms_log_id: CALL_ID }, { sms_log_id: CALL_ID }]);
    sms.applySmsCommitmentUpdate.mockRejectedValue(Object.assign(new Error('SMS follow-up is disabled'), { status: 409 }));
    await withServer(async (base) => {
      const patch = (body) => fetch(`${base}/admin/call-recordings/commitments/${COMMIT_ID}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect((await patch({ action: 'fulfill' })).status).toBe(400);
      expect((await patch({ action: 'fulfill', customer_id: CUSTOMER_ID })).status).toBe(409);
      expect(commitments.applyHumanUpdate).not.toHaveBeenCalled();
    });
  });
});

describe('PUT /calls/:id/customer', () => {
  test('stamps the override with who/when/previous, writes the link, and re-homes the voice message', async () => {
    const updates = mockDb([
      { id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }, // call
      { id: CUSTOMER_ID }, // customer exists
    ]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.override).toMatchObject({ customer_id: CUSTOMER_ID, previous_customer_id: 'old-customer', by: 'tech-1' });
    });
    const write = updates.find((u) => u.table === 'call_log');
    expect(write.patch.customer_id).toBe(CUSTOMER_ID);
    expect(write.patch.metadata.sql).toContain("'{customer_link_override}'");
    expect(JSON.parse(write.patch.metadata.bindings[0])).toMatchObject({ customer_id: CUSTOMER_ID, previous_customer_id: 'old-customer' });
    // The call's timeline entry moves with the link.
    const timeline = updates.find((u) => u.table === 'customer_interactions');
    expect(timeline.patch).toEqual({ customer_id: CUSTOMER_ID });
    expect(JSON.stringify(timeline.wheres)).toContain(CALL_ID);
    expect(require('../services/conversations').syncVoiceMessageForCall).toHaveBeenCalledWith(SID);
  });
  test('an unlink removes the call\'s derived timeline entry and reports a failed thread re-home instead of hiding it', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }]);
    require('../services/conversations').syncVoiceMessageForCall.mockRejectedValueOnce(new Error('thread busy'));
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: null }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.customer_id).toBeNull();
      expect(body.warnings).toEqual([expect.stringMatching(/voice_message_rehome_failed/)]);
    });
    const timeline = updates.find((u) => u.table === 'customer_interactions');
    expect(timeline.patch).toEqual({ __deleted: true });
  });

  test('a re-home that the helper reports as null (it catches its own errors) is a warning, not a silent success (codex #3764 gh-r2 P1)', async () => {
    mockDb([{ id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }]);
    require('../services/conversations').syncVoiceMessageForCall.mockResolvedValueOnce(null);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: null }) });
      expect(res.status).toBe(200);
      expect((await res.json()).warnings).toEqual([expect.stringMatching(/voice_message_rehome_failed: .*retry the unlink/)]);
    });
  });

  test('an unlink severs the durable lead links too — the lead stamp keys leave metadata and the lead no longer claims the call SID (codex #3736 gh-r9)', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: null }) });
      expect(res.status).toBe(200);
      expect((await res.json()).leads_unlinked).toBe(1);
    });
    const write = updates.find((u) => u.table === 'call_log');
    for (const k of ['lead_id', 'lead_prior_state', 'lead_written_state', 'lead_stamp_seq', 'lead_link_via']) expect(write.patch.metadata.sql).toContain(`- '${k}'`);
    const lead = updates.find((u) => u.table === 'leads');
    expect(lead.patch.twilio_call_sid).toBeNull();
    expect(JSON.stringify(lead.wheres)).toContain(SID);
  });

  test('linking a call with no keyed timeline entry creates one under the same conflict target the processor uses (codex #3764 gh-r1 P2)', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: null, twilio_call_sid: SID, direction: 'inbound', from_phone: '+19415550111', call_summary: 'Caller asked about ants.' }, { id: CUSTOMER_ID }]);
    const inner = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = inner(table);
      // No keyed row exists for this call: the move matches nothing.
      if (table === 'customer_interactions') b.update = (patch) => { updates.push({ table, patch }); return Promise.resolve(0); };
      return b;
    });
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings, rowCount: 1 }));
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ timeline_rows_moved: 0, timeline_rows_created: 1 });
    });
    const insert = db.raw.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO customer_interactions'));
    expect(insert[0]).toContain("ON CONFLICT ((metadata ->> 'call_log_id')) WHERE interaction_type = 'call'");
    expect(insert[1][0]).toBe(CUSTOMER_ID);
    expect(insert[1][2]).toBe('Caller asked about ants.');
    expect(JSON.parse(insert[1][3])).toMatchObject({ call_log_id: CALL_ID, twilio_call_sid: SID, linked_by_operator: true });
  });

  test('an unlink never creates a timeline entry', async () => {
    mockDb([{ id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: null }) });
      expect(res.status).toBe(200);
    });
    expect(db.raw.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO customer_interactions'))).toBeUndefined();
  });

  test('a relink to a person leaves the lead links alone', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: null, twilio_call_sid: SID }, { id: CUSTOMER_ID }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(200);
    });
    expect(updates.find((u) => u.table === 'call_log').patch.metadata.sql).not.toContain("'lead_id'");
    expect(updates.find((u) => u.table === 'leads')).toBeUndefined();
  });

  test('a relink that MOVES the call between two customers repoints the call-created lead to the new owner (codex #3764 r5 P1)', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }, { id: CUSTOMER_ID }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(200);
      expect((await res.json()).leads_reconciled).toBe(1);
    });
    const lead = updates.find((u) => u.table === 'leads');
    // The lead MOVES to the new owner (not severed): findReusableCallLead then
    // reuses it on reprocess instead of minting a duplicate. Scoped to the
    // PREVIOUS owner's lead for this call's SID; the SID claim and the call's
    // lead stamp are kept (the repointed row stays valid under both arms).
    expect(lead.patch.customer_id).toBe(CUSTOMER_ID);
    expect(lead.patch.twilio_call_sid).toBeUndefined();
    expect(JSON.stringify(lead.wheres)).toContain(SID);
    expect(JSON.stringify(lead.wheres)).toContain('old-customer');
    expect(updates.find((u) => u.table === 'call_log').patch.metadata.sql).not.toContain("- 'lead_id'");
  });

  test('a timeline move that fails rolls the relink back and surfaces as an error, never a half-applied success', async () => {
    mockDb([{ id: CALL_ID, customer_id: 'old-customer', twilio_call_sid: SID }, { id: CUSTOMER_ID }]);
    const inner = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = inner(table);
      if (table === 'customer_interactions') b.update = () => Promise.reject(new Error('timeline write failed'));
      return b;
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/timeline write failed/);
    });
    expect(require('../services/conversations').syncVoiceMessageForCall).not.toHaveBeenCalled();
  });

  test('refuses a relink while a pass holds the claim', async () => {
    const updates = mockDb([{ id: CALL_ID, customer_id: null, twilio_call_sid: SID }, { id: CUSTOMER_ID }]);
    // The conditional update matches no rows while processing_status = processing.
    db.mockImplementation((table) => {
      const b = { table, wheres: [], where() { return b; }, whereNull() { return b; }, whereIn() { return b; }, whereRaw() { return b; }, forUpdate() { return b; },
        first: () => Promise.resolve(table === 'customers' ? { id: CUSTOMER_ID } : { id: CALL_ID, customer_id: null, twilio_call_sid: SID }),
        update: (patch) => { updates.push({ table, patch }); return Promise.resolve(0); } };
      return b;
    });
    db.transaction = jest.fn(async (fn) => fn(db));
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe('already_processing');
    });
    expect(require('../services/conversations').syncVoiceMessageForCall).not.toHaveBeenCalled();
  });

  test('validates the target customer under its row lock INSIDE the relink transaction, customers before call_log (codex #3736 gh-r6 P2)', async () => {
    const seen = [];
    const updates = mockDb([{ id: CALL_ID, customer_id: null, twilio_call_sid: SID }, { id: CUSTOMER_ID }]);
    const base = db.getMockImplementation();
    db.mockImplementation((table) => { const b = base(table); seen.push(b); return b; });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(200);
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const customerRead = seen.find((b) => b.table === 'customers');
    expect(customerRead.locked).toBe(true);
    // Lock order: the customers read precedes the call_log write (the
    // first call_log builder is the pre-transaction read of the call).
    const callLogWrite = seen.filter((b) => b.table === 'call_log')[1];
    expect(seen.indexOf(customerRead)).toBeLessThan(seen.indexOf(callLogWrite));
  });

  test('refuses an unknown customer and a malformed id', async () => {
    mockDb([{ id: CALL_ID, customer_id: null, twilio_call_sid: SID }, null]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: CUSTOMER_ID }) });
      expect(res.status).toBe(404);
      const bad = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/customer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: 'nope' }) });
      expect(bad.status).toBe(400);
    });
  });
});

describe('POST /calls/:id/adopt-recording', () => {
  const PARKED = 'RE' + '2'.repeat(32);
  const CURRENT = 'RE' + '1'.repeat(32);
  const call = () => ({
    id: CALL_ID, twilio_call_sid: SID, recording_sid: CURRENT, recording_url: 'https://api.twilio.com/x/RE1.mp3', recording_duration_seconds: 12,
    processing_status: 'processed',
    metadata: { additional_recordings: [{ recording_sid: PARKED, recording_url: 'https://api.twilio.com/x/RE2.mp3', recording_duration_seconds: 80, received_at: 'T', parked_because: 'processing_status_processed' }] },
  });

  test('swaps the parked recording in, keeps the old one parked, resolves the card, and force-reprocesses', async () => {
    const updates = mockDb([call()]);
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(200);
      expect((await res.json()).adopted).toBe(PARKED);
    });
    const swap = updates.find((u) => u.table === 'call_log');
    // The row leaves "processed": its transcript/extraction describe the old
    // audio, and NULL puts it back in the sweep if the immediate pass defers.
    expect(swap.patch).toMatchObject({ recording_sid: PARKED, recording_url: 'https://api.twilio.com/x/RE2.mp3', recording_duration_seconds: 80, transcription_status: 'pending', processing_status: null, transcription: null, transcript_structured: null, transcription_provider: null, ai_extraction: null, ai_extraction_enriched: null, call_summary: null, lead_synopsis: null, ai_validation: null, ai_address_validation: null, disposition: null });
    // Rewritten against the current array: the chosen SID is removed in SQL,
    // the replaced recording appended.
    expect(swap.patch.metadata.sql).toContain("WHERE e ->> 'recording_sid' <> ?");
    expect(swap.patch.metadata.bindings[0]).toBe(PARKED);
    expect(JSON.parse(swap.patch.metadata.bindings[1])).toEqual([expect.objectContaining({ recording_sid: CURRENT, parked_because: 'replaced_by_operator' })]);
    // Fenced to the row this request read: the recording being replaced and
    // the parked entry being adopted must both still be there.
    const fenceClauses = swap.wheres.map((w) => JSON.stringify(w));
    expect(fenceClauses.some((w) => w.includes('"recording_sid"') && w.includes(CURRENT))).toBe(true);
    expect(fenceClauses.some((w) => w.includes('additional_recordings') && w.includes(PARKED))).toBe(true);
    const cardWrites = updates.filter((u) => u.table === 'triage_items');
    const reviewCard = cardWrites.find((u) => JSON.stringify(u.wheres).includes('"reason_code":"additional_recording"'));
    expect(reviewCard.patch.status).toBe('resolved');
    // The OLD audio's other review cards are retired in the swap's own
    // transaction, with a note naming both recordings (r10 P1).
    const retired = cardWrites.find((u) => JSON.stringify(u.wheres).includes('notin'));
    expect(retired.patch).toMatchObject({ status: 'resolved', resolution_note: expect.stringContaining(PARKED) });
    expect(retired.patch.resolution_note).toContain(CURRENT);
    // The owed dispatch-blocking question and the email-review cards survive the swap (codex r3 + r4 P1) — the shared kept list.
    expect(retired.wheres).toContainEqual(['notin', 'reason_code', require('../services/call-routing-gates').SUPERSEDE_KEPT_REASON_CODES]);
    expect(require('../services/call-routing-gates').SUPERSEDE_KEPT_REASON_CODES).toEqual(expect.arrayContaining(['additional_recording', 'missing_unit_number', 'email_unverified', 'email_invalid', 'email_bounce_reverify']));
    expect(db.transaction).toHaveBeenCalled();
    // The pass is fenced to the chosen recording: a callback that replaces
    // it before the claim makes the pass refuse instead of processing audio
    // the operator never chose.
    expect(processor.processRecording).toHaveBeenCalledWith(SID, { force: true, operator: true, expectedRecordingSid: PARKED });
    // The pre-swap completed state rides on the adopted_recording stamp, so
    // EVERY pass over the adopted audio (immediate or the sweep's retry)
    // applies the lead first-contact clamp (codex r2 + r4 P2).
    expect(JSON.parse(swap.patch.metadata.bindings[2])).toMatchObject({ recording_sid: PARKED, previous_recording_sid: CURRENT, previous_processing_status: 'processed' });
    // The call's review flag follows its cards: the last card settled with
    // nothing else open clears review_status (codex #3764 gh-r1 P2).
    const flag = updates.find((u) => u.table === 'call_log' && u.patch.review_status === null);
    expect(flag).toBeDefined();
  });

  test('a legacy URL-only current recording (no SID) is kept as the replaced entry, never dropped (codex r4 P1)', async () => {
    const row = call();
    row.recording_sid = null;
    const updates = mockDb([row]);
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(200);
    });
    const swap = updates.find((u) => u.table === 'call_log');
    expect(JSON.parse(swap.patch.metadata.bindings[1])).toEqual([expect.objectContaining({ recording_sid: null, recording_url: 'https://api.twilio.com/x/RE1.mp3', parked_because: 'replaced_by_operator' })]);
  });

  test('a pass that throws after the committed swap reports adopted-and-queued, never a 500 (codex #3764 gh-r1 P2)', async () => {
    const updates = mockDb([call()]);
    processor.processRecording.mockRejectedValue(new Error('provider down'));
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: false, adopted: PARKED, queued: true, result: { threw: true, error: 'provider down' } });
    });
    // The swap stands; the review card is left open for the sweep's pass.
    expect(updates.find((u) => u.table === 'call_log').patch.recording_sid).toBe(PARKED);
    expect(updates.find((u) => u.table === 'triage_items' && JSON.stringify(u.wheres).includes('"reason_code":"additional_recording"'))).toBeUndefined();
  });

  test('a recording that a newer callback replaced before the pass claimed it is reported (409 recording_changed) and its card stays open (codex #3736 gh-r6)', async () => {
    const NEWER = 'RE' + '4'.repeat(32);
    const updates = mockDb([call()]);
    processor.processRecording.mockResolvedValue({ success: false, skipped: true, reason: 'recording_changed', current_recording_sid: NEWER });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'recording_changed', adopted: PARKED, current_recording_sid: NEWER, remaining_for_review: 0 });
    });
    // The chosen recording can no longer be acted on (it left the parked
    // list with the swap): the card is settled, not left pointing at it.
    const card = updates.find((u) => u.table === 'triage_items' && JSON.stringify(u.wheres).includes('"reason_code":"additional_recording"'));
    expect(card.patch.status).toBe('resolved');
    expect(card.patch.resolution_note).toContain(NEWER);
  });

  test('adopting over a rejected-transcript voicemail row clears the voicemail stamps the discarded audio produced', async () => {
    const updates = mockDb([call()]);
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    await withServer(async (base) => {
      await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
    });
    const swap = updates.find((u) => u.table === 'call_log');
    expect(swap.patch.answered_by.sql).toBe("CASE WHEN transcription_status = 'rejected' AND answered_by = 'voicemail' THEN NULL ELSE answered_by END");
    expect(swap.patch.call_outcome.sql).toBe("CASE WHEN transcription_status = 'rejected' AND call_outcome = 'voicemail' THEN NULL ELSE call_outcome END");
  });

  test('with another callback-parked recording still waiting, the card stays open and is retargeted to it', async () => {
    const OTHER = 'RE' + '3'.repeat(32);
    const row = call();
    row.metadata.additional_recordings.push({ recording_sid: OTHER, recording_url: 'https://api.twilio.com/x/RE3.mp3', recording_duration_seconds: 20, received_at: 'T2', parked_because: 'write_contended' });
    // The post-swap re-read: the chosen entry gone, OTHER and the replaced one present.
    const afterSwap = { metadata: { additional_recordings: [
      { recording_sid: OTHER, recording_url: 'https://api.twilio.com/x/RE3.mp3', parked_because: 'write_contended' },
      { recording_sid: CURRENT, recording_url: 'https://api.twilio.com/x/RE1.mp3', parked_because: 'replaced_by_operator' },
    ] } };
    const updates = mockDb([row, afterSwap]);
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ adopted: PARKED, remaining_for_review: 1 });
    });
    const card = updates.find((u) => u.table === 'triage_items' && JSON.stringify(u.wheres).includes('"reason_code":"additional_recording"'));
    expect(card.patch.status).toBeUndefined();
    expect(JSON.parse(card.patch.payload.bindings[0])).toMatchObject({ recording_sid: OTHER, parked_because: 'write_contended', kept_recording_sid: PARKED, remaining_for_review: 1 });
  });

  test('the review card is settled under the call row lock — list read and card write in one transaction (codex #3736 gh-r10 P2)', async () => {
    const seen = [];
    const updates = mockDb([call()]);
    const base = db.getMockImplementation();
    db.mockImplementation((table) => { const b = base(table); seen.push(b); return b; });
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(200);
    });
    // Two transactions: the swap (+ card retirement) and the settle.
    expect(db.transaction).toHaveBeenCalledTimes(2);
    const lockedReads = seen.filter((b) => b.table === 'call_log' && b.locked);
    expect(lockedReads).toHaveLength(1);
    expect(updates.some((u) => u.table === 'triage_items' && JSON.stringify(u.wheres).includes('"reason_code":"additional_recording"'))).toBe(true);
  });

  test('a review-card update that fails is reported as a warning on the successful adoption, never swallowed', async () => {
    mockDb([call()]);
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    const realImpl = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = realImpl(table);
      // Only the review-card settle fails; the swap's own card retirement
      // (scoped by whereNot) is untouched.
      if (table === 'triage_items') {
        const realUpdate = b.update;
        b.update = (patch) => (JSON.stringify(b.wheres).includes('"reason_code":"additional_recording"') ? Promise.reject(new Error('deadlock detected')) : realUpdate(patch));
      }
      return b;
    });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, adopted: PARKED });
      expect(body.warning).toMatch(/review card could not be updated/);
    });
  });

  test('a deferred or failed reprocess keeps the review card open and reports the call as queued, never as done', async () => {
    for (const outcome of [
      { success: false, skipped: true, reason: 'recording_not_ready' },
      { success: false, skipped: true, reason: 'terminal_write_ownership_lost' },
    ]) {
      const updates = mockDb([call()]);
      processor.processRecording.mockResolvedValue(outcome);
      await withServer(async (base) => {
        const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ success: false, queued: true, adopted: PARKED });
      });
      expect(updates.find((u) => u.table === 'call_log').patch.processing_status).toBeNull();
      // The old audio's other cards are retired with the swap; the
      // additional_recording review card itself is left open.
      expect(updates.find((u) => u.table === 'triage_items' && JSON.stringify(u.wheres).includes('"reason_code":"additional_recording"'))).toBeUndefined();
    }
  });

  test('a PAN-quarantined call never gets a parked recording re-attached: every parked recording is deleted at Twilio and the swap is refused', async () => {
    const OTHER = 'RE' + '3'.repeat(32);
    const row = { ...call(), transcription_metadata: JSON.stringify({ pan_detected: true }) };
    row.metadata.additional_recordings.push({ recording_sid: OTHER, recording_url: 'https://api.twilio.com/x/RE3.mp3', parked_because: 'write_contended' });
    const updates = mockDb([row]);
    processor.quarantineCardRecording.mockResolvedValue({ quarantined: true, twilioDeleted: true, parked: { deleted: 2, pending: 0 } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(409);
      // Current recording + two parked ones.
      expect(await res.json()).toMatchObject({ reason: 'pan_quarantined', deleted: 3, delete_pending: 0 });
    });
    expect(updates.find((u) => u.table === 'call_log')).toBeUndefined();
    // One helper call with the call's CURRENT recording as the primary; the
    // helper sweeps every parked recording (PARKED and OTHER) itself.
    expect(processor.quarantineCardRecording).toHaveBeenCalledTimes(1);
    expect(processor.quarantineCardRecording).toHaveBeenCalledWith(expect.objectContaining({ id: CALL_ID, recording_sid: CURRENT }), { source: 'adopt_recording_post_quarantine' });
    expect(processor.processRecording).not.toHaveBeenCalled();
  });

  test('the quarantine is run on the row as it is NOW, not on this request\'s snapshot', async () => {
    const NEWER = 'RE' + '4'.repeat(32);
    // Queue: the snapshot this request read, then the fresh row another operator changed under it.
    mockDb([{ ...call(), transcription_metadata: JSON.stringify({ pan_detected: true }) }, { ...call(), recording_sid: NEWER, recording_url: 'https://api.twilio.com/x/RE4.mp3' }]);
    processor.quarantineCardRecording.mockResolvedValue({ quarantined: true, twilioDeleted: true, parked: { deleted: 1, pending: 0 } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(409);
    });
    expect(processor.quarantineCardRecording).toHaveBeenCalledWith(expect.objectContaining({ recording_sid: NEWER }), { source: 'adopt_recording_post_quarantine' });
  });

  test('a parked delete that fails at Twilio is reported as still pending, never as deleted', async () => {
    mockDb([{ ...call(), transcription_metadata: JSON.stringify({ pan_detected: true }) }]);
    processor.quarantineCardRecording.mockResolvedValue({ quarantined: true, twilioDeleted: true, parked: { deleted: 0, pending: 1 } });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(409);
      const body = await res.json();
      // Current recording deleted, the parked one still owed.
      expect(body).toMatchObject({ reason: 'pan_quarantined', deleted: 1, delete_pending: 1 });
      expect(body.error).toMatch(/retried by the recovery sweep/);
    });
  });

  test('the swap itself carries the quarantine predicate, so a stamp landing after the read refuses it', async () => {
    const updates = mockDb([call()]);
    await withServer(async (base) => {
      processor.processRecording.mockResolvedValue({ success: true });
      await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
    });
    const swap = updates.find((u) => u.table === 'call_log');
    expect(JSON.stringify(swap.wheres)).toContain("pan_detected') IS DISTINCT FROM 'true'");
  });

  test('refuses while a pass holds the claim, and refuses a recording that is not parked', async () => {
    mockDb([{ ...call(), processing_status: 'processing' }]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(409);
    });
    mockDb([call()]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: 'RE' + '9'.repeat(32) }) });
      expect(res.status).toBe(404);
    });
    expect(processor.processRecording).not.toHaveBeenCalled();
  });
});
