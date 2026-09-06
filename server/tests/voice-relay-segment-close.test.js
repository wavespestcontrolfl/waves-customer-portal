const segmentStore = require('../services/voice-agent/relay-segments');
/** Close-time storage behavior, independent of reconnect rendering/hydration. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn(async () => ({ leadId: 'L-floor' })) }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || '').slice(-4) }));
// One file-level mock for the commitments write (relay-conversation requires it lazily — per-test doMocks
// would race the module cache); the gate answers true so the close-time pass runs in every case.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => undefined) }));
jest.mock('../services/call-commitments', () => ({ recordRelayCommitments: jest.fn(async () => ({ found: true, written: 1 })) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: null })) }));
const { RelayConversation } = require('../services/voice-agent/relay-conversation');

afterEach(() => { delete process.env.GATE_VOICE_RELAY_RECOVERY; delete process.env.GATE_VOICE_RELAY_TRANSFER; jest.clearAllMocks(); });

function primeDb({ firstRow = null, updateImpl, db = require('../models/db') } = {}) {
  const updates = [];
  const guardQ = { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis(), orWhereIn: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), orWhereRaw: jest.fn().mockReturnThis() };
  const builder = {
    update: updateImpl || jest.fn(async (patch) => { updates.push(patch); return 1; }),
    where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
    whereIn: jest.fn(() => builder),
    whereRaw: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    first: jest.fn(async () => firstRow),
    select: jest.fn(() => builder),
  };
  builder.clone = jest.fn(() => builder);
  builder.forUpdate = jest.fn(() => ({ first: jest.fn(async () => firstRow || { metadata: {} }) }));
  db.transaction = jest.fn(async (fn) => fn(db));
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { db, builder, updates, guardQ };
}

describe('the conversation side', () => {
  function convoWithTurns(over = {}) {
    const convo = new RelayConversation({ callSid: 'CA-rec', sessionKey: 'nonce-1', sessionGeneration: 1725500001000, from: '+19415551234', send: jest.fn(), ...over });
    convo.leadCaptured = true; // the floor is not under test unless stated
    convo._callerVerified = true; // held the claim — the proof the segment append requires
    convo._sessionSuperseded = jest.fn(async () => false); // owns the row unless a test says otherwise
    convo._recordTurn('caller', 'my ants are back');
    convo._recordTurn('agent', 'Sorry to hear that.');
    return convo;
  }

  test('gate on: end() appends this socket\'s segment FIRST (CallSid-fenced only), then the generation-fenced column write composes from all segments', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder, updates, guardQ } = primeDb();
    const convo = convoWithTurns();
    await convo.end('ws_close');
    // 1: the segment append — fenced on having HELD the claim (the current owner, or an older generation on a row a reconnect took over), never on the outcome
    expect(Object.keys(updates[0]).sort()).toEqual(['metadata', 'transcript_structured', 'transcription', 'transcription_provider', 'transcription_status', 'updated_at']);
    expect(guardQ.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_session_claim_owner') = ?", ['nonce-1']);
    expect(updates[0].metadata.bindings[1].sql).toContain("'relay_segments'"); // the append (both CASE branches)
    expect(updates[0].transcription.sql).toContain('transcription_provider = ?'); // recomposes only Sandy-owned columns
    const seg = JSON.parse(updates[0].metadata.bindings[1].bindings[0])[0];
    expect(seg).toEqual(expect.objectContaining({ generation: 1725500001000, session_key: 'nonce-1', reason: 'ws_close', turns: 2, lead_captured: true }));
    expect(seg.text).toContain('Caller: my ants are back');
    // 2: the reconcile — the transcript column is composed from the row's segments (COALESCE to this socket's text), fenced by generation
    const reconcile = updates[1];
    expect(reconcile.call_outcome).toBe('ai_handled');
    expect(reconcile.transcription.sql).toBe('COALESCE(?, ?)');
    expect(reconcile.transcription.bindings[0].sql).toContain("string_agg(seg->>'text'");
    expect(reconcile.transcription.bindings[1]).toContain('Caller: my ants are back');
    expect(JSON.parse(reconcile.transcription_metadata).segments).toEqual({ this_generation: 1725500001000, appended: true });
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) <= ?", [1725500001000]);
  });

  test('a silent claimed socket appends an empty durable close for the extraction barrier', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const convo = convoWithTurns();
    convo._transcript = [];
    const append = jest.spyOn(segmentStore, 'appendSegment').mockResolvedValueOnce(1);
    try {
      await convo.end('ws_close');
      expect(append).toHaveBeenCalledWith(expect.anything(), 'CA-rec', expect.objectContaining({
        session_key: 'nonce-1', text: '', turns: 0,
      }), { allowUnclaimed: false });
    } finally { append.mockRestore(); }
  });

  test('a resumed close refreshes its stale summary from the durable earlier leg', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ firstRow: { metadata: { relay_segments: [
      { generation: 1, session_key: 'old', text: 'Caller: insects in the garage' },
      { generation: 2, session_key: 'nonce-1', text: 'Caller: my ants are back' },
    ] } } });
    const convo = convoWithTurns();
    convo._resume = { callerTurns: [], segmentsText: '' };
    await convo.end('ws_close');
    const summaries = updates.filter((patch) => typeof patch.call_summary === 'string');
    expect(summaries.at(-1).call_summary).toContain('insects in the garage');
    expect(summaries.at(-1).call_summary).toContain('my ants are back');
  });

  test("an UNVERIFIED socket (never held the claim) appends no segment — its text lands only through today's owner-fenced reconcile (hook P1)", async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb();
    const convo = convoWithTurns();
    convo._callerVerified = false;
    await convo.end('ws_close');
    expect(updates.some((u) => u.metadata && String(u.metadata.sql).includes('relay_segments'))).toBe(false);
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: 'ai_handled' }));
    expect(typeof updates[0].transcription).toBe('string');
  });

  test('a call-token-authenticated unverified first leg preserves text after reconnect supersedes it', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb();
    const convo = convoWithTurns({ callTokenVerified: true });
    convo._callerVerified = false;
    expect(convo._callTokenVerified).toBe(true);
    convo._sessionSuperseded.mockResolvedValue(true);
    await convo.end('ws_close');
    const append = updates.find((patch) => JSON.stringify(patch.metadata).includes('relay_segments'));
    expect(append).toBeDefined();
    expect(JSON.stringify(append)).toContain('my ants are back');
    expect(convo._buildToolCtx().callerVerified).toBe(false);
    expect(convo._buildToolCtx().sessionKey).toBeNull();
  });

  test('an unconfirmed append never publishes an unscrubbed local/older-leg composite', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const update = jest.fn(async () => 0);
    primeDb({ updateImpl: update });
    await convoWithTurns().end('ws_close');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toEqual(expect.objectContaining({ call_outcome: 'ai_handled' }));
    expect(update.mock.calls[1][0]).not.toHaveProperty('transcription');
  });

  test('a never-reconnected append confirmed after the deadline still finalizes and records promises', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const row = { transcription: null, metadata: { relay_session_claim_owner: 'nonce-1' } };
    const { updates } = primeDb({ firstRow: row });
    let settle;
    const append = jest.spyOn(segmentStore, 'appendSegment').mockImplementationOnce(async (_db, _sid, segment) => {
      await new Promise((resolve) => { settle = resolve; });
      row.metadata.relay_segments = [segment];
      return 1;
    });
    const convo = convoWithTurns();
    convo._promises.set('send_estimate', { verdict: true, expectation: 'about_15_minutes', at: new Date() });
    const repair = jest.spyOn(convo, '_reconcileLateSegment');
    const { recordRelayCommitments } = require('../services/call-commitments');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const closing = convo.end('ws_close');
      await jest.advanceTimersByTimeAsync(10010);
      await closing;
      expect(updates.find((u) => u.call_outcome === 'ai_handled')).not.toHaveProperty('transcription');
      expect(recordRelayCommitments).not.toHaveBeenCalled();
      settle();
      await jest.advanceTimersByTimeAsync(0);
      await repair.mock.results[0].value;
      expect(updates.some((u) => u.transcription_status === 'completed' && u.transcription)).toBe(true);
      expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionKey: 'nonce-1', estimateQueued: true }));
    } finally { append.mockRestore(); jest.useRealTimers(); }
  });

  test('an append settling during the capture floor records commitments after the outcome is final', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const row = { call_outcome: null, transcription: null, metadata: { relay_session_claim_owner: 'nonce-1' } };
    primeDb({ firstRow: row, updateImpl: jest.fn(async (patch) => {
      if (patch.call_outcome) row.call_outcome = patch.call_outcome;
      return 1;
    }) });
    let settleAppend;
    const append = jest.spyOn(segmentStore, 'appendSegment').mockImplementationOnce(async (_db, _sid, segment) => {
      await new Promise((resolve) => { settleAppend = resolve; });
      row.metadata.relay_segments = [segment];
      return 1;
    });
    let finishFloor;
    const convo = convoWithTurns();
    convo._runCaptureFloor = jest.fn(() => new Promise((resolve) => { finishFloor = resolve; }));
    convo._promises.set('send_estimate', { verdict: true, expectation: 'about_15_minutes', at: new Date() });
    const owed = [];
    const { recordRelayCommitments } = require('../services/call-commitments');
    recordRelayCommitments.mockImplementation(async (_db, evidence) => {
      // Mirrors the separately PostgreSQL-tested durable eligibility guard.
      if (row.call_outcome === 'ai_handled') owed.push(evidence);
      return { found: owed.length, written: owed.length };
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const closing = convo.end('ws_close');
      await jest.advanceTimersByTimeAsync(10010);
      expect(convo._runCaptureFloor).toHaveBeenCalled();
      settleAppend();
      await jest.advanceTimersByTimeAsync(0);
      expect(owed).toEqual([]);
      finishFloor();
      await closing;
      await jest.advanceTimersByTimeAsync(0);
      expect(owed).toEqual([expect.objectContaining({ sessionKey: 'nonce-1', estimateQueued: true })]);
    } finally {
      append.mockRestore();
      recordRelayCommitments.mockImplementation(async () => ({ found: true, written: 1 }));
      jest.useRealTimers();
    }
  });

  test('gate off ⇒ no segment append and no generation fence (today\'s statements)', async () => {
    const { builder, updates } = primeDb();
    const convo = convoWithTurns();
    await convo.end('ws_close');
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: 'ai_handled' }));
    expect(typeof updates[0].transcription).toBe('string');
    expect(builder.whereRaw.mock.calls.some(([sql]) => String(sql).includes('relay_reconnect_ms'))).toBe(false);
  });

  test.each(['ai_transferred', 'voicemail'])('a silent resumed close records prior promises after the outcome becomes %s', async (callOutcome) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const row = { call_outcome: callOutcome, transcription: null, metadata: {
      relay_session_claim_owner: 'nonce-2', relay_reconnects: 1,
      relay_segments: [{ generation: 1, session_key: 'nonce-1', text: 'Agent: I will send you an estimate.',
        promises: [{ kind: 'send_estimate', verdict: true }] }],
    } };
    primeDb({ firstRow: row, updateImpl: jest.fn(async () => 0) });
    const convo = convoWithTurns({ sessionKey: 'nonce-2' });
    convo._transcript = [];
    convo._resume = { reconnects: 1, callerTurns: [] };
    const { recordRelayCommitments } = require('../services/call-commitments');
    await convo.end('ws_close');
    // The production writer reads the durable segments and eligibility under
    // its row lock even though this close has no transcript of its own.
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      callSid: 'CA-rec', sessionKey: 'nonce-2',
    }));
  });

  test('a superseded socket still appends its segment (recomposing a finalized call), resyncs the message row, then skips every column write', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { syncVoiceMessageForCall } = require('../services/conversations');
    const { updates } = primeDb();
    const convo = convoWithTurns();
    convo._callerVerified = true;
    convo._sessionSuperseded = jest.fn(async () => true);
    await convo.end('ws_close');
    expect(updates).toHaveLength(1);
    expect(updates[0].metadata.sql).toContain('jsonb_set(?, \'{relay_transcript,text}\'');
    expect(updates[0].transcription.sql).toContain('transcription_provider = ?');
    expect(syncVoiceMessageForCall).toHaveBeenCalledWith('CA-rec');
  });

  test.each([false, true])('late-segment inbox sync follows the duration repair and survives its failure (%s)', async (repairFails) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { syncVoiceMessageForCall } = require('../services/conversations');
    const row = {
      duration_seconds: 15,
      metadata: {
        relay_session_claim_owner: 'nonce-2',
        relay_segments: [{ started_at: '2026-01-01T12:00:00Z', ended_at: '2026-01-01T12:02:00Z' }],
      },
    };
    primeDb({ firstRow: row, updateImpl: jest.fn(async (patch) => {
      if (patch.duration_seconds) {
        if (repairFails) throw new Error('repair unavailable');
        row.duration_seconds = 120;
      }
      return 1;
    }) });
    const inboxDurations = [];
    syncVoiceMessageForCall.mockImplementationOnce(async () => { inboxDurations.push(row.duration_seconds); });
    const convo = convoWithTurns();
    convo._sessionSuperseded = jest.fn(async () => true);
    await convo.end('ws_close');
    expect(inboxDurations).toEqual([repairFails ? 15 : 120]);
  });

  test('a superseded socket whose late segment lands after the resumed socket\'s floor wrote a no-transcript lead refreshes THAT lead\'s summary from the whole call (compare-and-set on the placeholder) (hook r22 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { db, builder, updates, guardQ } = primeDb({ firstRow: { transcription: 'Caller: my ants are back', metadata: { relay_session_claim_owner: 'nonce-2', relay_reconnects: 1, relay_lead_id: 'L-linked', relay_segments: [{ generation: 1, text: 'Caller: my ants are back\nAgent: Sorry to hear that.' }, { generation: 2, text: 'Agent: Sorry, I lost you for a second.' }] } } });
    const convo = convoWithTurns();
    convo._sessionSuperseded = jest.fn(async () => true);
    await convo.end('ws_close');
    expect(db).toHaveBeenCalledWith('leads');
    // this call's lead: inserted by this call OR the persisted linkage (a reused lead keeps another call's twilio_call_sid — codex r3 P2)
    expect(guardQ.where).toHaveBeenCalledWith({ twilio_call_sid: 'CA-rec' });
    expect(guardQ.orWhere).toHaveBeenCalledWith({ id: 'L-linked' });
    expect(builder.where).toHaveBeenCalledWith('transcript_summary', 'like', '%No transcript captured.');
    const refresh = updates.find((u) => typeof u.transcript_summary === 'string');
    expect(refresh.transcript_summary).toBe('Inbound voice call (auto-captured on hangup). Caller said: my ants are back');
    // no caller lines on the row ⇒ nothing to refresh; sandbox ⇒ never
    primeDb({ firstRow: { transcription: 'Agent: hello', metadata: { relay_session_claim_owner: 'nonce-2', relay_segments: [{ generation: 1, text: 'Agent: hello' }] } } });
    expect(await convoWithTurns()._refreshFloorLeadSummary({ relay_segments: [{ generation: 1, text: 'Agent: hello' }] })).toBe(false);
    expect(await convoWithTurns({ sandbox: true })._refreshFloorLeadSummary({ relay_segments: [{ generation: 1, text: 'Caller: hi' }] })).toBe(false);
  });

});

  test('authenticated close registration does not wait for caller verification', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const register = jest.spyOn(segmentStore, 'registerSegmentSession').mockResolvedValueOnce(true);
    const append = jest.spyOn(segmentStore, 'appendSegment').mockResolvedValueOnce(1);
    try {
      const convo = new RelayConversation({ callSid: 'CA-silent', sessionKey: 'silent', callTokenVerified: true, send: jest.fn() });
      convo._callerVerified = false;
      convo._runCaptureFloor = jest.fn(async () => {});
      await convo.end('ws_close');
      expect(register).toHaveBeenCalledWith(expect.anything(), 'CA-silent', 'silent');
      expect(append).toHaveBeenCalledWith(expect.anything(), 'CA-silent', expect.objectContaining({ session_key: 'silent', text: '', turns: 0 }));
    } finally { register.mockRestore(); append.mockRestore(); }
  });
