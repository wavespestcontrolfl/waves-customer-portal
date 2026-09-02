// The call-intelligence admin endpoints: reads are staff-visible, every
// correction is admin-only, ids are validated before any query, and the
// customer relink stamps the override that the processor honours.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ processRecording: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(() => Promise.resolve(true)) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-intelligence', () => ({ loadCallIntelligence: jest.fn() }));
jest.mock('../services/call-commitments', () => ({
  applyHumanUpdate: jest.fn(),
  addHumanCommitment: jest.fn(),
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

  test('a technician can settle a promise (staff-wide, like tagging a disposition)', async () => {
    mockRole = 'tech';
    commitments.applyHumanUpdate.mockResolvedValue({ id: COMMIT_ID, human_state: 'confirmed' });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/commitments/${COMMIT_ID}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
      expect(res.status).toBe(200);
    });
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
      const b = { table, wheres: [], where() { return b; }, whereNull() { return b; }, whereIn() { return b; }, whereRaw() { return b; },
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
    expect(swap.patch).toMatchObject({ recording_sid: PARKED, recording_url: 'https://api.twilio.com/x/RE2.mp3', recording_duration_seconds: 80, transcription_status: 'pending', processing_status: null });
    const remaining = JSON.parse(swap.patch.metadata.bindings[0]);
    expect(remaining).toEqual([expect.objectContaining({ recording_sid: CURRENT, parked_because: 'replaced_by_operator' })]);
    // Fenced to the row this request read: the recording being replaced and
    // the parked entry being adopted must both still be there.
    const fenceClauses = swap.wheres.map((w) => JSON.stringify(w));
    expect(fenceClauses.some((w) => w.includes('"recording_sid"') && w.includes(CURRENT))).toBe(true);
    expect(fenceClauses.some((w) => w.includes('additional_recordings') && w.includes(PARKED))).toBe(true);
    expect(updates.find((u) => u.table === 'triage_items').patch.status).toBe('resolved');
    expect(processor.processRecording).toHaveBeenCalledWith(SID, { force: true, operator: true });
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
      expect(updates.find((u) => u.table === 'triage_items')).toBeUndefined();
    }
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
