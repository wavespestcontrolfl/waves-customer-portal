// The operator-correction admin endpoints: every correction is admin-only,
// ids are validated before any query, the customer relink stamps the
// override that the processor honours, and recording adoption keeps the
// PAN-quarantine invariant.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({ processRecording: jest.fn(), quarantineCardRecording: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(() => Promise.resolve(true)) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
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
const { isEnabled } = require('../config/feature-gates');
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
      whereNotExists() { return b; },
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
    expect(processor.processRecording).not.toHaveBeenCalled();
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
    expect(swap.patch).toMatchObject({ recording_sid: PARKED, recording_url: 'https://api.twilio.com/x/RE2.mp3', recording_duration_seconds: 80, transcription_status: 'pending', processing_status: null, transcription: null, transcript_structured: null, transcription_provider: null, ai_extraction: null, ai_extraction_enriched: null, call_summary: null, lead_synopsis: null });
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
    expect(updates.find((u) => u.table === 'triage_items').patch.status).toBe('resolved');
    // The pass is fenced to the chosen recording: a callback that replaces
    // it before the claim makes the pass refuse instead of processing audio
    // the operator never chose.
    expect(processor.processRecording).toHaveBeenCalledWith(SID, { force: true, operator: true, expectedRecordingSid: PARKED });
  });

  test('a recording that a newer callback replaced before the pass claimed it is reported (409 recording_changed) and its card stays open (codex #3736 gh-r6)', async () => {
    const NEWER = 'RE' + '4'.repeat(32);
    const updates = mockDb([call()]);
    processor.processRecording.mockResolvedValue({ success: false, skipped: true, reason: 'recording_changed', current_recording_sid: NEWER });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/call-recordings/calls/${CALL_ID}/adopt-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_sid: PARKED }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: 'recording_changed', adopted: PARKED, current_recording_sid: NEWER });
    });
    expect(updates.find((u) => u.table === 'triage_items')).toBeUndefined();
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
    const card = updates.find((u) => u.table === 'triage_items');
    expect(card.patch.status).toBeUndefined();
    expect(JSON.parse(card.patch.payload.bindings[0])).toMatchObject({ recording_sid: OTHER, parked_because: 'write_contended', kept_recording_sid: PARKED, remaining_for_review: 1 });
  });

  test('a review-card update that fails is reported as a warning on the successful adoption, never swallowed', async () => {
    mockDb([call()]);
    processor.processRecording.mockResolvedValue({ success: true, callSid: SID });
    const realImpl = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = realImpl(table);
      if (table === 'triage_items') b.update = () => Promise.reject(new Error('deadlock detected'));
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
      expect(updates.find((u) => u.table === 'triage_items')).toBeUndefined();
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
