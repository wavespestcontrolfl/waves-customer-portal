const segmentStore = require('../services/voice-agent/relay-segments');
/**
 * Sandy PR 2B — voice-session recovery (GATE_VOICE_RELAY_RECOVERY), the
 * module + the conversation side. The route side is
 * twilio-voice-relay-recovery.test.js.
 *
 * Gate off ⇒ nothing here runs: no segment append, no generation fence, no
 * resume seed — the close-time statements are
 * byte-identical to today (pinned by the existing conversation/transcript
 * suites, which run with the gate unset).
 */
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
// The CallSid/ANI claim the recovery gate runs on its own (context gate off): verified by default, like every convo below assumes.
jest.mock('../services/voice-agent/relay-context', () => ({
  ...jest.requireActual('../services/voice-agent/relay-context'),
  verifyRelaySession: jest.fn(async ({ onVerified }) => { if (typeof onVerified === 'function') onVerified(true); return { verified: true, attested: false }; }),
}));

const recovery = require('../services/voice-agent/relay-recovery');
const { verifyRelaySession } = require('../services/voice-agent/relay-context');
const UNVERIFIED = async ({ onVerified }) => { if (typeof onVerified === 'function') onVerified(false); return { verified: false }; };
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { recordRelayCommitments } = require('../services/call-commitments');

// A resumed leg that OWNS the row's claim (nonce-2) and verified — the only session prior context is released to.
const OWNED = { relay_session_claim_owner: 'nonce-2' };
function resumedConvo(over = {}) {
  const convo = new RelayConversation({ callSid: 'CA-res', sessionKey: 'nonce-2', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true, ...over });
  convo._callerVerified = true; // set before the load's microtask runs
  return convo;
}

afterEach(() => { delete process.env.GATE_VOICE_RELAY_RECOVERY; delete process.env.GATE_VOICE_RELAY_TRANSFER; jest.clearAllMocks(); });

function primeDb({ firstRow = null, updateImpl, db = require('../models/db') } = {}) {
  const updates = [];
  const guardQ = { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), orWhereRaw: jest.fn().mockReturnThis() };
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

describe('relay-recovery module', () => {
  test('the gate is exact `true`, read at call time', () => {
    expect(recovery.isRecoveryGateOn()).toBe(false);
    process.env.GATE_VOICE_RELAY_RECOVERY = 'TRUE';
    expect(recovery.isRecoveryGateOn()).toBe(false);
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    expect(recovery.isRecoveryGateOn()).toBe(true);
  });

  test('claimReconnect is ONE fenced UPDATE: never-reconnected + live/ai_handled rows only; restores the live shape; stamps the generation fence', async () => {
    const { db, builder, guardQ, updates } = primeDb();
    await recovery.claimReconnect(db, { callSid: 'CA-1', nowMs: 1725500000000 });
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA-1');
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnects')::int, 0) < ?", [recovery.RECONNECT_LIMIT]);
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(guardQ.orWhere).toHaveBeenCalledWith('call_outcome', 'ai_handled'); // voicemail / ai_transferred / relay_failed are never resumed
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: null, status: 'in-progress', answered_by: 'ai_agent' }));
    expect(updates[0].metadata.sql).toContain("'relay_reconnects', COALESCE((metadata->>'relay_reconnects')::int, 0) + 1, 'relay_reconnect_ms', ?::bigint");
    expect(updates[0].metadata.bindings).toEqual([1725500000000]);
  });

  test('undoLateReconnect puts back only the claim it made (fenced on its own reconnect_ms, a NULL outcome, and no claim at/after the stamp — a resumed socket that claimed is never put back, hook r21 P1)', async () => {
    const { db, builder, updates } = primeDb();
    await recovery.undoLateReconnect(db, { callSid: 'CA-1', nowMs: 42 });
    expect(builder.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_reconnect_ms')::bigint = ?", [42]);
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?", [42]);
    expect(builder.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: 'voicemail', answered_by: 'voicemail', status: 'completed' }));
  });

  test('reissueReconnect moves the stamp forward in ONE fenced UPDATE: prior stamp, no claim at/after it, outcome still NULL — never a compensated row, never a live resumed leg (codex r2 P1 / hook r21 P1)', async () => {
    const { db, builder, updates } = primeDb();
    expect(await recovery.reissueReconnect(db, { callSid: 'CA-1', priorMs: 777, nowMs: 900 })).toBe(1);
    expect(builder.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_reconnect_ms')::bigint = ?", [777]);
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?", [777]);
    expect(builder.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(updates[0].metadata.sql).toContain("jsonb_build_object('relay_reconnect_ms', ?::bigint)");
    expect(updates[0].metadata.sql).not.toContain('relay_reconnects'); // the reconnect COUNT is untouched — still the one reconnect
    expect(updates[0].metadata.bindings).toEqual([900]);
    expect(Object.keys(updates[0]).sort()).toEqual(['metadata', 'updated_at']);
  });

  test('segments: append never overwrites; composition orders by generation with the [Reconnected] separator; the fence is ≤ generation', () => {
    const { db } = primeDb();
    const seg = segmentStore.buildSegment({ generation: 7, sessionKey: 'k', reason: 'ws_close', text: 'Caller: hi', turns: 1, latency: { turns: 1 }, versions: { model: 'm' }, leadCaptured: true });
    expect(seg).toEqual(expect.objectContaining({ generation: 7, session_key: 'k', reason: 'ws_close', text: 'Caller: hi', turns: 1, lead_captured: true }));
    const append = segmentStore.appendSegmentSql(db, seg);
    expect(append.sql).toBe("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_segments', COALESCE(metadata->'relay_segments', '[]'::jsonb) || ?::jsonb)");
    expect(JSON.parse(append.bindings[0])).toEqual([seg]);
    const compose = segmentStore.composeSegmentsSql(db);
    expect(compose.sql).toContain("string_agg(seg->>'text', ? ORDER BY (seg->>'generation')::bigint, COALESCE(seg->>'session_key', '') COLLATE \"C\", ord)");
    expect(compose.bindings).toEqual([segmentStore.SEGMENT_SEPARATOR]);
    expect(segmentStore.segmentsText([{ generation: 2, text: 'second' }, { generation: 1, text: 'first' }, { generation: 3, text: '' }])).toBe(`first${segmentStore.SEGMENT_SEPARATOR}second`);
    const q = { whereRaw: jest.fn().mockReturnThis() };
    segmentStore.closeFenceSql(q, 99, 'nonce-1');
    expect(q.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) <= ?", [99]);
  });

  test('appendSegmentPatch: the append also recomposes Sandy-owned columns and the stash — a late old segment refreshes a call the resumed socket already finalized (hook P1)', () => {
    const { db } = primeDb();
    const seg = segmentStore.buildSegment({ generation: 1, text: 'Caller: first leg' });
    const patch = segmentStore.appendSegmentPatch(db, seg);
    expect(patch.transcription.sql).toContain("WHEN transcription_provider = ? AND COALESCE(transcription, '') <> '' AND ? IS NOT NULL THEN ?");
    expect(patch.transcription.sql).toMatch(/ELSE transcription\s+END$/);
    expect(patch.transcription.bindings[0]).toBe('conversation_relay'); // a recording's transcript is never touched
    expect(patch.transcription.bindings[1].sql).toContain("COALESCE(metadata->'relay_segments', '[]'::jsonb) || ?::jsonb"); // unioned with THIS segment
    expect(patch.metadata.sql).toBe("CASE WHEN (metadata->'relay_transcript') IS NOT NULL AND ? IS NOT NULL THEN jsonb_set(?, '{relay_transcript,text}', to_jsonb(?::text), false) ELSE ? END");
    expect(patch.metadata.bindings[1].sql).toContain("'relay_segments'"); // the append rides both branches
    expect(patch.metadata.bindings[3].sql).toContain("'relay_segments'");
  });

  test('appendSegmentPatch fills an EMPTY column only on a row that RECONNECTED — a failed claim\'s voicemail row keeps its columns for the recording (hook r28 P1)', () => {
    const { db } = primeDb();
    const patch = segmentStore.appendSegmentPatch(db, segmentStore.buildSegment({ generation: 1, text: 'x' }));
    const fill = "(COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND COALESCE((metadata->>'relay_reconnects')::int, 0) > 0)";
    expect(patch.transcription.sql).toContain(fill);
    expect(patch.transcription_provider.sql).toContain(fill);
    expect(patch.transcription_status.sql).toContain(fill);
  });

  test('appendSegmentPatch refreshes the AI portion of a processor composite and preserves the recorded portion (hook P1)', () => {
    const { db } = primeDb();
    const patch = segmentStore.appendSegmentPatch(db, segmentStore.buildSegment({ generation: 1, text: 'Caller: first leg' }));
    expect(patch.transcription.sql).toMatch(/WHEN transcription LIKE '\[AI segment\]%' AND transcription ~ \? AND \? IS NOT NULL\s+THEN '\[AI segment\]' \|\| E'\\n' \|\| \? \|\| substring\(transcription from \?\)/);
    expect(patch.transcription.bindings[5]).toBe('\\n\\n\\[(?:Staff|Voicemail) segment\\]\\n[\\s\\S]*$'); // non-capturing: substring(from) returns the whole match
    expect(patch.transcription.bindings[8]).toBe(patch.transcription.bindings[5]);
    // …and an EMPTY unowned column (the resumed socket closed silently first) is filled and claimed
    const fill = "(COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND COALESCE((metadata->>'relay_reconnects')::int, 0) > 0)";
    expect(patch.transcription.sql).toContain(`WHEN ${fill} AND ? IS NOT NULL THEN ?`);
    expect(patch.transcription_provider.sql).toBe(`CASE WHEN ${fill} AND ? IS NOT NULL THEN ? ELSE transcription_provider END`);
    expect(patch.transcription_provider.bindings[1]).toBe('conversation_relay');
    expect(patch.transcription_status.sql).toContain("THEN 'completed' ELSE transcription_status END");
    // …and a RECORDING-only transcript on a reconnected row gets the AI segment ahead of it; the structured form is cleared (hook P1)
    expect(patch.transcription.sql).toContain("E' segment]' || E'\\n' || transcription");
    expect(patch.transcript_structured.sql).toContain('THEN NULL ELSE transcript_structured END');
  });

  test('loadResumeState proves the hint from the row: reconnects > 0 ⇒ state; otherwise null; bounded and fail-soft', async () => {
    const { db } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: ants' }] } } });
    expect(await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'other-nonce' })).toBeNull(); // not this socket's claim ⇒ nothing (hook P0)
    expect(await recovery.loadResumeState(db, 'CA-1')).toBeNull(); // no key ⇒ nothing
    expect(await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' })).toEqual({ reconnects: 1, reconnectMs: null, segmentsText: 'Caller: ants', relayLeadId: 'L1', reserviceFiled: false, noLeadCreated: false, leadCaptured: false, lookupsUsed: 0, lookupRefs: [], lookupResults: [], slotRefs: [], startedAtMs: null, holdOpen: false, estimateFields: null, modelFailures: 0, toolFailures: 0, promises: [], callerTurns: ['ants'] });
    primeDb({ firstRow: { metadata: JSON.stringify({ ...OWNED, relay_segments: [{ generation: 1, text: 'x' }] }) } });
    expect(await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' })).toBeNull(); // no reconnect stamp ⇒ a forged <Parameter resumed> proves nothing
    primeDb({ firstRow: null });
    expect(await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' })).toBeNull();
    const { builder } = primeDb();
    builder.first = jest.fn(() => new Promise(() => {}));
    expect(await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2', timeoutMs: 20 })).toBeNull();
    expect(await recovery.loadResumeState(db, '', { sessionKey: 'nonce-2' })).toBeNull();
  });

  test('a segment keeps everything the transcript store keeps; only the resume SEED is capped (tail) (hook P1)', async () => {
    const { MAX_TRANSCRIPT_CHARS } = require('../services/voice-agent/relay-transcript');
    const long = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 10);
    expect(segmentStore.buildSegment({ generation: 1, text: long }).text).toHaveLength(MAX_TRANSCRIPT_CHARS);
    const { db } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_reconnect_ms: 5, relay_segments: [{ generation: 1, text: 'a'.repeat(recovery.RESUME_SEED_MAX_CHARS + 50) }] } } });
    const state = await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' });
    expect(state.segmentsText).toHaveLength(recovery.RESUME_SEED_MAX_CHARS + 3);
    expect(state.segmentsText.startsWith('[…]')).toBe(true);
    expect(state.reconnectMs).toBe(5);
    expect(await recovery.readReconnectState(db, 'CA-1')).toEqual({ reconnects: 1, reconnectMs: 5, claimGen: 0, profile: null, transferClaimed: false });
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_profile_id: 'flux_fast_v1', relay_attrs: { speechModel: 'flux' } } } });
    expect((await recovery.readReconnectState(db, 'CA-1')).profile).toEqual({ relayProfileId: 'flux_fast_v1', relayAttrs: { speechModel: 'flux' } });
  });

  test('promises ride the segment and are restored (latest per kind) with their expectation and timestamp; caller turns are extracted (hook P1)', async () => {
    const at = new Date('2026-09-05T02:00:00.000Z');
    const seg = segmentStore.buildSegment({ generation: 1, text: 'Caller: ants\nAgent: I will send an estimate.\nCaller: thanks', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at }] });
    expect(seg.promises).toEqual([{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }]);
    const { db } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [
      { generation: 2, text: 'Caller: later', promises: [{ kind: 'send_estimate', verdict: false, expectation: null, at: '2026-09-05T02:05:00.000Z' }] },
      seg,
    ] } } });
    const state = await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' });
    expect(state.promises).toEqual([{ kind: 'send_estimate', verdict: false, expectation: null, at: '2026-09-05T02:05:00.000Z' }]); // generation 2 wins
    expect(state.callerTurns).toEqual(['ants', 'thanks', 'later']);
  });

  test('an incomplete estimate capture rides the segment (hold + the fields given) and is restored from the LATEST leg, fields accumulated across legs (codex r2 P1)', async () => {
    const seg = segmentStore.buildSegment({ generation: 1, text: 'Caller: ants', holdOpen: true, estimateFields: { first_name: 'Ann', email: '  ', address_line1: null, city: 'Venice ' } });
    expect(seg.hold_open).toBe(true);
    expect(seg.estimate_fields).toEqual({ first_name: 'Ann', city: 'Venice' });
    expect(segmentStore.buildSegment({ generation: 1, text: 'x' })).toEqual(expect.objectContaining({ hold_open: false, estimate_fields: null }));
    const { db } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [
      { generation: 2, text: 'Caller: later', hold_open: true, estimate_fields: { email: 'ann@example.com', city: 'Sarasota' } },
      seg,
    ] } } });
    const state = await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' });
    expect(state.holdOpen).toBe(true);
    expect(state.estimateFields).toEqual({ first_name: 'Ann', city: 'Sarasota', email: 'ann@example.com' }); // generation 2 wins per field
    // a later COMPLETE capture cleared the hold
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [seg, { generation: 2, text: 'Caller: later', hold_open: false }] } } });
    expect((await recovery.loadResumeState(db, 'CA-1', { sessionKey: 'nonce-2' })).holdOpen).toBe(false);
    // readReconnectState carries the current claim owner's generation
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500 } } });
    expect(await recovery.readReconnectState(db, 'CA-1')).toEqual({ reconnects: 1, reconnectMs: 777, claimGen: 500, profile: null, transferClaimed: false });
  });

});

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

  test("an UNVERIFIED socket (never held the claim) appends no segment — its text lands only through today's owner-fenced reconcile (hook P1)", async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb();
    verifyRelaySession.mockImplementationOnce(UNVERIFIED);
    const convo = convoWithTurns();
    convo._callerVerified = false;
    await convo.end('ws_close');
    expect(updates.some((u) => u.metadata && String(u.metadata.sql).includes('relay_segments'))).toBe(false);
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: 'ai_handled' }));
    expect(typeof updates[0].transcription).toBe('string');
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

  test('gate off ⇒ no segment append and no generation fence (today\'s statements)', async () => {
    const { builder, updates } = primeDb();
    const convo = convoWithTurns();
    await convo.end('ws_close');
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: 'ai_handled' }));
    expect(typeof updates[0].transcription).toBe('string');
    expect(builder.whereRaw.mock.calls.some(([sql]) => String(sql).includes('relay_reconnect_ms'))).toBe(false);
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

  test('a resumed socket the caller never spoke on still composes the earlier segment(s) onto the columns at its close (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates, builder } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: first leg' }] }, transcription: 'Caller: first leg' } });
    const convo = resumedConvo({ callSid: 'CA-silent', sessionGeneration: 2 });
    convo.leadCaptured = true;
    await convo._resumeReady;
    await convo.end('ws_close'); // no turns ⇒ no segment append, no local transcriptUpdate
    const reconcile = updates.find((u) => u.call_outcome === 'ai_handled');
    expect(reconcile.transcription.sql).toBe('COALESCE(?, transcription)');
    expect(reconcile.transcription.bindings[0].sql).toContain("string_agg(seg->>'text'");
    expect(reconcile.transcription_provider.sql).toBe('CASE WHEN ? IS NOT NULL THEN ? ELSE transcription_provider END');
    expect(reconcile.transcription_provider.bindings[1]).toBe('conversation_relay');
    expect(builder.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) <= ?", [2]);
    // …and the commitments pass reads the persisted composed transcript
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transcript: 'Caller: first leg', sessionKey: 'nonce-2' }));
  });

  test('a resumed session restores the earlier legs\' promises (this leg\'s own supersede) and its capture floor summarises the WHOLE call (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen\nAgent: I can help.', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }] }] } } });
    const convo = resumedConvo({ callSid: 'CA-prom' });
    await convo._resumeReady;
    expect(convo._promises.get('send_estimate')).toEqual({ verdict: true, expectation: 'about_15_minutes', at: new Date('2026-09-05T02:00:00.000Z') });
    await convo._runCaptureFloor('ws_close'); // hung up right after the reconnect: no local turns
    expect(createLeadFromExtraction).toHaveBeenCalledWith(expect.objectContaining({ call_summary: expect.stringContaining('Caller said: my ants are back in the kitchen') }), expect.anything());
    // …and the segment this leg appends carries the promise on
    const { updates } = primeDb();
    convo.leadCaptured = true;
    convo._recordTurn('caller', 'ok');
    await convo.end('ws_close');
    expect(JSON.parse(updates[0].metadata.bindings[1].bindings[0])[0].promises).toEqual([{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }]);
  });

  test('end() awaits the bounded resume read: a hangup before the first word still gets the earlier legs\' caller context on the floor (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen' }] } } });
    let settle;
    const row = { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen' }] } };
    let reads = 0;
    builder.first = jest.fn(() => (++reads === 1 ? new Promise((r) => { settle = r; }) : Promise.resolve(row))); // the resume read is still pending when the socket closes; later reads (claim owner, refresh) answer
    const convo = resumedConvo({ callSid: 'CA-early' });
    const closing = convo.end('ws_close');
    await new Promise((r) => setImmediate(r)); // the load starts after the claim settles (a microtask later)
    settle(row);
    await closing;
    expect(createLeadFromExtraction).toHaveBeenCalledWith(expect.objectContaining({ call_summary: expect.stringContaining('Caller said: my ants are back in the kitchen') }), expect.anything());
  });

  test('a re-service filed on an earlier leg survives the reconnect: no lead capture, reserviceFiled reported, and the flag rides this leg\'s segment (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: come back please', reservice_filed: true, no_lead_created: true }] } } });
    const convo = resumedConvo({ callSid: 'CA-rs', sessionGeneration: 2 });
    await convo._resumeReady;
    expect(convo._reserviceFiled).toBe(true);
    expect(convo._noLeadCreated).toBe(true);
    expect(convo.leadCaptured).toBe(true);
    convo._recordTurn('caller', 'thanks');
    await convo.end('ws_close');
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    const seg = JSON.parse(updates[0].metadata.bindings[1].bindings[0])[0];
    expect(seg).toEqual(expect.objectContaining({ reservice_filed: true, no_lead_created: true, lead_captured: false }));
    const reconcile = updates.find((u) => u.call_outcome === 'ai_handled');
    expect(JSON.parse(reconcile.transcription_metadata).reservice_filed).toBe(true);
  });

  test('at close, a snapshot that missed the old socket\'s segment is refreshed once before the floor (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1 } } }); // proven, segment not yet appended
    const convo = resumedConvo({ callSid: 'CA-refresh' });
    await convo._resumeReady;
    expect(convo._resume.segmentsText).toBe('');
    builder.first = jest.fn(async () => ({ metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen' }] } })); // landed meanwhile
    await convo.end('ws_close'); // no turns on this leg, no turn-time reload
    expect(createLeadFromExtraction).toHaveBeenCalledWith(expect.objectContaining({ call_summary: expect.stringContaining('Caller said: my ants are back in the kitchen') }), expect.anything());
  });

  test('a reconnected call that fell to VOICEMAIL (second failure, transfer unavailable) stashes its composed transcript and the processor composes from it (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { composeRelaySegment } = require('../services/voice-agent/relay-transfer');
    expect(composeRelaySegment({ metadata: { ...OWNED, relay_reconnects: 1, relay_transcript: { text: 'Caller: first\n\n[Reconnected]\nCaller: second' } }, call_outcome: 'voicemail' })).toEqual(expect.objectContaining({ text: '[AI segment]\nCaller: first\n\n[Reconnected]\nCaller: second' }));
    expect(composeRelaySegment({ metadata: { relay_transcript: { text: 'x' } }, call_outcome: 'voicemail' })).toBeNull(); // no transfer, no reconnect ⇒ today's overwrite
    // the SEGMENTS are the third source: a resumed leg that failed before any turn wrote no stash and the swap cleared the columns
    expect(composeRelaySegment({ metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 2, text: 'Caller: second' }, { generation: 1, text: 'Caller: first' }] }, transcription: null, transcription_provider: null, call_outcome: 'voicemail' }))
      .toEqual({ text: '[AI segment]\nCaller: first\n\n[Reconnected]\nCaller: second', metadata: { provider: 'conversation_relay' } });
    // …and the processor's in-UPDATE composition guard (relayPending) engages on a reconnected row too (hook P1)
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('relayPending = (transferred && !segment) || reconnected;'); // every write of a reconnected call composes from the row's current state
    expect(src).toContain('const recorded = recordedSegmentText || patch.transcription;'); // …around the RECORDED text, never an in-memory composite
    // the close: reconcile 0 (voicemail is terminal), terminal salvage 0, metadata-only stash 1 — on the reconnect marker, no transfer needed
    const { updates, builder } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: first' }] } }, updateImpl: jest.fn(async (patch) => { updates.push(patch); return updates.length === 4 ? 1 : (updates.length === 1 ? 1 : 0); }) });
    const convo = resumedConvo({ callSid: 'CA-vm2', sessionGeneration: 2 });
    convo.leadCaptured = true;
    await convo._resumeReady;
    convo._recordTurn('caller', 'second');
    await convo.end('ws_close');
    expect(builder.whereRaw).toHaveBeenCalledWith("((metadata->'relay_handoff') IS NOT NULL OR COALESCE((metadata->>'relay_reconnects')::int, 0) > 0)");
    expect(updates[3].metadata.sql).toContain("jsonb_build_object('relay_transcript', jsonb_build_object('text', ?, 'metadata', ?::jsonb))");
  });

  test('an initial resume read that TIMED OUT is retried on the next turn (owner + verification checks intact) (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb();
    const row = { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my ants are back' }] } };
    let reads = 0;
    builder.first = jest.fn(() => (++reads === 1 ? new Promise(() => {}) : Promise.resolve(row))); // the first read never answers
    jest.useFakeTimers();
    const convo = resumedConvo({ callSid: 'CA-to' });
    await jest.advanceTimersByTimeAsync(2100); // past the 2s bound
    jest.useRealTimers();
    await convo._resumeReady;
    expect(convo._resume).toBeNull();
    await convo._runLoop('hello again').catch(() => {});
    expect(convo._resume).toEqual(expect.objectContaining({ segmentsText: 'Caller: my ants are back', relayLeadId: 'L1' }));
    expect(convo.leadCaptured).toBe(true);
    expect(convo.messages.some((m) => typeof m.content === 'string' && m.content.includes('Caller: my ants are back'))).toBe(true);
  });

  test('the kill switch flipped after the reconnect rendered: neither the turn-time nor the close-time reload runs (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1 } } });
    const convo = resumedConvo({ callSid: 'CA-kill' });
    await convo._resumeReady;
    delete process.env.GATE_VOICE_RELAY_RECOVERY; // unset = the live kill
    builder.first = jest.fn(async () => ({ metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my ants are back' }] } }));
    await convo._runLoop('hello').catch(() => {});
    expect(convo._resumeReloads || 0).toBe(0);
    expect(convo.messages.some((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'))).toBe(false);
    convo.leadCaptured = true;
    await convo.end('ws_close');
    expect(convo._resume.segmentsText).toBe('');
  });


  test('failure streak restoration follows same-generation session nonce order', async () => {
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [
      { generation: 2, session_key: 'nonce-a', model_failures: 2, tool_failures: 2 },
      { generation: 2, session_key: 'nonce-z', model_failures: 0, tool_failures: 1 },
    ] } } });
    expect(await recovery.loadResumeState(require('../models/db'), 'CA-tie', { sessionKey: 'nonce-2' }))
      .toMatchObject({ modelFailures: 0, toolFailures: 1 });
  });

  test('the provider-failure streak continues across the reconnect (codex r1 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    expect(segmentStore.buildSegment({ generation: 1, text: 'x', modelFailures: 1, toolFailures: 0 })).toEqual(expect.objectContaining({ model_failures: 1, tool_failures: 0 }));
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: hi', model_failures: 1, tool_failures: 1 }] } } });
    const convo = resumedConvo({ callSid: 'CA-streak' });
    await convo._resumeReady;
    expect(convo._modelFailures).toBe(1);
    expect(convo._toolFailures).toBe(1);
  });

  test('a proven prior lead restores the capture state (lead_captured true; the session may end when the caller is done) (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1' } } });
    const convo = resumedConvo({ callSid: 'CA-lead' });
    await convo._resumeReady;
    expect(convo.leadCaptured).toBe(true);
    expect(convo._buildToolCtx().leadId()).toBe('L1'); // the booking card after the reconnect links THIS call's lead (hook r36 P1)
    const own = resumedConvo({ callSid: 'CA-lead-own' });
    own._leadId = 'L-mine';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1' } } });
    own._applyResumeState({ reconnects: 1, relayLeadId: 'L1', promises: [], callerTurns: [] });
    expect(own._leadId).toBe('L-mine'); // a lead this leg captured itself is kept
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1 } } });
    const none = resumedConvo({ callSid: 'CA-nolead' });
    await none._resumeReady;
    expect(none.leadCaptured).toBe(false);
  });

  test('a segment preserves the captured lead id when its metadata linkage stamp was lost', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { buildSegment } = require('../services/voice-agent/relay-segments');
    const segment = buildSegment({ generation: 1, sessionKey: 'nonce-1', leadCaptured: true, leadId: 'L-durable', text: 'Caller: ants' });
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [segment] } } });
    const convo = resumedConvo({ callSid: 'CA-lead-fallback' });
    await convo._resumeReady;
    expect(convo.leadCaptured).toBe(true);
    expect(convo._buildToolCtx().leadId()).toBe('L-durable');
  });

  test('unverified turns do not consume resume retries before verification completes', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: earlier context' }] } } });
    verifyRelaySession.mockImplementationOnce(UNVERIFIED);
    const convo = new RelayConversation({ callSid: 'CA-delayed', sessionKey: 'nonce-2', from: '+19415551234', send: jest.fn(), resumed: true });
    await convo._resumeReady;
    for (const text of ['hello', 'hello again', 'still here']) await convo._runLoop(text).catch(() => {});
    expect(convo._resumeReloads || 0).toBe(0);
    convo._callerVerified = true;
    await convo._runLoop('continue').catch(() => {});
    expect(convo._resume.segmentsText).toContain('earlier context');
  });

  test('a no-lead customer capture on the earlier leg is restored as CAPTURED: the floor stays down and the session may end when the caller is done (codex r2 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: hi', no_lead_created: true }] } } });
    const convo = resumedConvo({ callSid: 'CA-nolead-cust' });
    await convo._resumeReady;
    expect(convo.leadCaptured).toBe(true);
    expect(convo._noLeadCreated).toBe(true);
  });

  test('an incomplete estimate capture HOLDS the resumed leg open with the fields already given; this leg\'s complete capture clears it (codex r2 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: hi', hold_open: true, estimate_fields: { first_name: 'Ann', address_line1: '1 Main St' } }] } } });
    const endSession = jest.fn();
    const convo = resumedConvo({ callSid: 'CA-hold', endSession });
    convo._estimateFields = { first_name: 'Anne' }; // this leg's own answer wins
    await convo._resumeReady;
    expect(convo.leadCaptured).toBe(true);
    expect(convo._holdOpenForRetry).toBe(true);
    expect(convo._estimateFields).toEqual({ first_name: 'Anne', address_line1: '1 Main St' });
    convo._maybeEndAfterTurn();
    expect(endSession).not.toHaveBeenCalled(); // Sandy is still asking for the missing email
    const ctx = convo._buildToolCtx();
    expect(ctx.getEstimateFields()).toEqual({ first_name: 'Anne', address_line1: '1 Main St' });
    ctx.markCaptured({ leadCreated: true, holdOpen: false });
    convo._applyResumeState({ ...convo._resume }); // a reload after this leg captured must not re-arm the hold
    expect(convo._holdOpenForRetry).toBe(false);
    convo._maybeEndAfterTurn();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  test('the call\'s START rides the segment and the resumed leg restores the earliest one, so duration_seconds covers the whole call (hook r25 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const t0 = Date.now() - 600000; // the first leg began 10 minutes ago
    expect(segmentStore.buildSegment({ generation: 1, text: 'x', startedAt: t0 }).started_at).toBe(new Date(t0).toISOString());
    expect(segmentStore.buildSegment({ generation: 1, text: 'x' }).started_at).toBeNull();
    const { updates } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: hi', started_at: new Date(t0).toISOString() }, { generation: 0, text: 'Caller: earlier', started_at: 'not-a-date' }] } } });
    const convo = resumedConvo({ callSid: 'CA-dur' });
    convo._sessionSuperseded = jest.fn(async () => false);
    await convo._resumeReady;
    expect(convo._resume.startedAtMs).toBe(t0);
    expect(convo._startedAt).toBe(t0);
    convo._recordTurn('caller', 'still here');
    await convo.end('ws_close');
    const reconcile = updates.find((u) => u.call_outcome === 'ai_handled');
    expect(reconcile.duration_seconds.bindings[0]).toBeGreaterThanOrEqual(600);
    const append = updates.find((u) => u.metadata?.bindings?.[1]?.bindings);
    const seg = JSON.parse(append.metadata.bindings[1].bindings[0])[0];
    expect(seg.started_at).toBe(new Date(t0).toISOString()); // this leg's segment carries the CALL's start forward
  });

  test('customer-book lookups already spent ride the segment and the resumed leg continues the per-call budget (codex r4 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    expect(segmentStore.buildSegment({ generation: 1, text: 'x', lookupsUsed: 2 }).lookups_used).toBe(2);
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: hi', lookups_used: 3 }] } } });
    const convo = resumedConvo({ callSid: 'CA-lookups' });
    await convo._resumeReady;
    expect(convo._resume.lookupsUsed).toBe(3);
    expect(convo._priorLookupsUsed).toBe(3);
    expect(convo._buildToolCtx().consumeLookup()).toBe(false); // the budget is exhausted for THIS call
  });

  test('a resumed socket gets only what is left of the call\'s hard duration cap (codex r4 P2)', () => {
    const { resumedSessionBudgetMs, WS_MAX_SESSION_MS, WS_RESUMED_MIN_SESSION_MS } = require('../services/voice-agent/relay-server');
    const now = Date.now();
    expect(resumedSessionBudgetMs(null)).toBe(WS_MAX_SESSION_MS);
    expect(resumedSessionBudgetMs({ created_at: new Date(now - 10 * 60 * 1000), metadata: {} }, { now })).toBe(WS_MAX_SESSION_MS); // never reconnected ⇒ the full cap
    expect(resumedSessionBudgetMs({ created_at: new Date(now - 10 * 60 * 1000), metadata: JSON.stringify({ relay_reconnects: 1 }) }, { now })).toBe(5 * 60 * 1000);
    expect(resumedSessionBudgetMs({ created_at: new Date(now - 20 * 60 * 1000), metadata: { relay_reconnects: 1 } }, { now })).toBe(WS_RESUMED_MIN_SESSION_MS);
    expect(resumedSessionBudgetMs({ created_at: null, metadata: { relay_reconnects: 1 } }, { now })).toBe(WS_MAX_SESSION_MS);
  });

  test('the turn cap is re-judged after resume hydration: a slow resume read that restores 40 earlier turns ends the call before any model round (codex r5 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: Array.from({ length: 40 }, (_, i) => `Caller: turn ${i}`).join('\n') }] } } });
    const endSession = jest.fn();
    const convo = resumedConvo({ callSid: 'CA-cap-late', endSession });
    // handlePrompt admitted the turn while the read was pending (prior count unknown)
    convo._priorCallerTurns = 0;
    convo._userTurns.push('one more');
    await convo._runLoop('one more').catch(() => {});
    expect(convo._priorCallerTurns).toBe(40);
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'turn_cap' }));
    expect(convo.messages.some((m) => m.role === 'user' && String(m.content).includes('one more'))).toBe(false); // no model round
  });

  test('a route-initiated second-failure transfer (ai_transferred stamped before the resumed close) still records the restored promises from the salvage — judged from the durable outcome, not the local latch (codex r5 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({
      firstRow: { transcription: 'Caller: my ants are back', metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }] }] } },
      updateImpl: jest.fn(async (patch) => { updates.push(patch); return patch.call_outcome === 'ai_handled' ? 0 : 1; }), // the reconcile is fenced out by the transfer outcome; the salvage lands
    });
    const convo = resumedConvo({ callSid: 'CA-route-xfer' });
    convo._sessionSuperseded = jest.fn(async () => false);
    await convo._resumeReady;
    convo._recordTurn('caller', 'still here');
    expect(convo._transferRequested).toBeFalsy();
    recordRelayCommitments.mockClear();
    await convo.end('ws_close');
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callSid: 'CA-route-xfer', estimateQueued: true, estimateExpectation: 'about_15_minutes' }));
    // Eligibility is enforced by the durable writer, including sandbox outcomes.
    const sandbox = resumedConvo({ callSid: 'CA-route-sb', sandbox: true });
    sandbox._sessionSuperseded = jest.fn(async () => false);
    await sandbox._resumeReady;
    sandbox._recordTurn('caller', 'x');
    recordRelayCommitments.mockClear();
    await sandbox.end('ws_close');
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callSid: 'CA-route-sb' }));
  });

  test('a late segment rebuilds a deterministic (or missing) call_summary from the whole call\'s caller lines; a model-written summary is left alone (codex r5 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates, guardQ } = primeDb({ firstRow: { transcription: 'Caller: my ants are back', metadata: { relay_session_claim_owner: 'nonce-2', relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my ants are back' }, { generation: 2, text: 'Caller: thanks' }] } } });
    const convo = convoWithTurns();
    convo._sessionSuperseded = jest.fn(async () => true);
    await convo.end('ws_close');
    const refresh = updates.find((u) => typeof u.call_summary === 'string');
    expect(refresh.call_summary).toBe('AI phone assistant handled this call. Caller said: my ants are back | thanks');
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_summary');
    expect(guardQ.orWhereRaw).toHaveBeenCalledWith("transcription_metadata->>'summary_source' = ?", ['deterministic']);
    expect(await convoWithTurns()._refreshCallSummary({ relay_segments: [{ generation: 1, text: 'Agent: only me' }] })).toBe(false);
  });

  test.each(['capture_lead', 'request_reservice'])('a failed earlier %s does not permanently suppress the replacement floor', async (tool) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    // Older persisted snapshots may still contain this field. The takeover
    // won the row lock, so an older write either committed evidence or cannot
    // commit anymore. A missing artifact is eligible for the owning floor.
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: ants', writes_in_flight: [tool] }] } } });
    const convo = resumedConvo();
    await convo._resumeReady;
    await convo._runCaptureFloor('ws_close');
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    expect(createLeadFromExtraction.mock.calls[0][1].sessionKey).toBe('nonce-2');
    expect(convo.leadCaptured).toBe(true);
  });

  test.each([{ relay_reservice_filed: true }, { relay_lead_id: 'L-committed' }])('a prior commit suppresses the replacement floor before the old segment catches up: %j', async (evidence) => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, ...evidence, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: ants', lead_captured: false, reservice_filed: false }] } } });
    const convo = resumedConvo();
    await convo._resumeReady;
    await convo._runCaptureFloor('ws_close');
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    expect(convo.leadCaptured).toBe(true);
  });

  test('lookup references remain usable after the lookup budget was exhausted on the earlier leg', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const segment = segmentStore.buildSegment({ generation: 1, lookupsUsed: 3, lookupRefs: [['C1-1', 'customer-1']], text: 'Caller: thanks' });
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [segment] } } });
    const convo = resumedConvo();
    await convo._resumeReady;
    const ctx = convo._buildToolCtx();
    expect(ctx.consumeLookup()).toBe(false);
    expect(ctx.resolveLookupRef('C1-1')).toBe('customer-1');
    expect(ctx.rememberLookup({ id: 'customer-1' })).toBe('C1-1');
  });

  test('offered slots and their search context survive the closing segment and owner-verified resume', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb();
    const first = convoWithTurns();
    const slot = { date: '2026-01-02', start_time: '14:00' };
    const context = { lat: 27.4, lng: -82.5, duration: 90, timeOfDay: 'afternoon', expandOpenDays: true };
    const ref = first._buildToolCtx().rememberSlot(slot, context);
    first._sessionSuperseded = jest.fn(async () => true);
    await first.end('ws_close');
    const segment = JSON.parse(updates[0].metadata.bindings[1].bindings[0])[0];
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [segment] } } });
    const resumed = resumedConvo();
    await resumed._resumeReady;
    const ctx = resumed._buildToolCtx();
    expect(ctx.resolveSlotRef(ref)).toEqual({ date: slot.date, startMinutes: 840, ...context });
    expect(ctx.rememberSlot(slot, context)).toBe(ref);
    const fresh = ctx.rememberSlot({ ...slot, start_time: '15:00' }, context);
    expect(fresh).not.toBe(ref);
    expect(ctx.resolveSlotRef(ref).startMinutes).toBe(840);
    expect(ctx.resolveSlotRef(fresh).startMinutes).toBe(900);
  });

  test('a late slot registry cannot alias current offers or undo a newer re-offer context', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const convo = resumedConvo();
    await convo._resumeReady;
    const ctx = convo._buildToolCtx();
    const slot = { date: '2026-01-02', start_time: '14:00' };
    const context = { date: slot.date, startMinutes: 840, lat: 27.4, lng: -82.5, duration: 60, timeOfDay: 'any', expandOpenDays: true };
    const fresh = ctx.rememberSlot({ ...slot, start_time: '15:00' }, context);
    const state = { slotRefs: [['S1-1', context]] };
    convo._applyResumeState(state);
    expect(ctx.resolveSlotRef(fresh).startMinutes).toBe(900);
    expect(ctx.resolveSlotRef('S1-1')).toEqual(context);
    expect(ctx.rememberSlot(slot, { ...context, timeOfDay: 'afternoon' })).toBe('S1-1');
    convo._applyResumeState(state);
    expect(ctx.resolveSlotRef('S1-1').timeOfDay).toBe('afternoon');
    expect(ctx.rememberSlot({ ...slot, start_time: '15:00' }, context)).toBe(fresh);
  });

  test('slot restoration follows segment generation, accepts legacy refs, and skips malformed entries', async () => {
    const context = { date: '2026-01-02', startMinutes: 840 };
    const { db } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [
      { generation: 2, slot_refs: [['S1', { ...context, timeOfDay: 'afternoon' }]] },
      { generation: 1, slot_refs: [['S1', { ...context, timeOfDay: 'any' }], null, ['bad', null], ['bad', {}]] },
      { generation: 0 },
    ] } } });
    const state = await recovery.loadResumeState(db, 'CA-res', { sessionKey: 'nonce-2' });
    expect(state.slotRefs).toEqual([['S1', { ...context, timeOfDay: 'afternoon' }]]);
    expect(await recovery.loadResumeState(db, 'CA-res', { sessionKey: 'foreign-owner' })).toBeNull();
  });

  test('a delayed resume read preserves locally consumed lookups and does not spend while history is unknown', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const convo = resumedConvo();
    await convo._resumeReady;
    const ctx = convo._buildToolCtx();
    expect(ctx.consumeLookup()).toBe(false); // no prior segment yet
    // A previously consumed local lookup must survive later hydration.
    convo._lookupsUsed = 1;
    convo._applyResumeState({ callerTurns: [], segmentsText: 'Caller: earlier', lookupsUsed: 2 });
    expect(ctx.consumeLookup()).toBe(false);
    convo._applyResumeState({ callerTurns: [], segmentsText: 'Caller: earlier', lookupsUsed: 2 });
    expect(convo._lookupsUsed + convo._priorLookupsUsed).toBe(3); // reload is idempotent
  });

  test('a late earlier lookup map cannot alias a reference already issued on this leg', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const convo = resumedConvo();
    await convo._resumeReady;
    const ctx = convo._buildToolCtx();
    const fresh = ctx.rememberLookup({ id: 'customer-2' });
    convo._applyResumeState({ callerTurns: [], lookupRefs: [['C1-1', 'customer-1']] });
    expect(ctx.resolveLookupRef(fresh)).toBe('customer-2');
    expect(ctx.resolveLookupRef('C1-1')).toBe('customer-1');
  });

  test('a lead captured on an earlier leg whose relay_lead_id stamp did not land is still restored as captured (segment lead_captured) (codex r3 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: hi', lead_captured: true }] } } });
    const convo = resumedConvo({ callSid: 'CA-seglead' });
    await convo._resumeReady;
    expect(convo._resume.leadCaptured).toBe(true);
    expect(convo.leadCaptured).toBe(true);
  });

  test('late inherited failures add to this leg once and model success leaves tool failures intact', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1 } } });
    const convo = resumedConvo({ callSid: 'CA-late-streak' });
    await convo._resumeReady;
    convo._modelFailures = 1;
    convo._toolFailures = 1;
    const late = { ...convo._resume, modelFailures: 1, toolFailures: 1 };
    convo._applyResumeState(late);
    convo._applyResumeState(late);
    expect(convo._modelFailures).toBe(2);
    expect(convo._toolFailures).toBe(2);

    const fresh = resumedConvo({ callSid: 'CA-independent-streak' });
    await fresh._resumeReady;
    fresh._clearedFailures.model = true;
    fresh._applyResumeState(late);
    expect(fresh._modelFailures).toBe(0);
    expect(fresh._toolFailures).toBe(1);
  });

  test('a late reload never resurrects a failure streak this leg already cleared; the earlier legs\' caller turns count toward the call turn cap (codex r3 P2 ×2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1 } } });
    const convo = resumedConvo({ callSid: 'CA-streak' });
    await convo._resumeReady;
    const late = { ...convo._resume, modelFailures: 1, toolFailures: 1, callerTurns: Array.from({ length: 39 }, (_, i) => `turn ${i}`) };
    convo._applyResumeState(late); // before any round on this leg ⇒ the streak carries over
    expect(convo._modelFailures).toBe(1);
    convo._clearedFailures = { model: true, tool: true }; // successful rounds cleared both providers
    convo._modelFailures = 0; convo._toolFailures = 0;
    convo._applyResumeState(late);
    expect(convo._modelFailures).toBe(0);
    expect(convo._toolFailures).toBe(0);
    // 39 earlier caller turns + this one ⇒ the cap (40) ends the call
    expect(convo._priorCallerTurns).toBe(39);
    const endSession = jest.fn();
    convo._endSession = endSession;
    convo._userTurns.push('x');
    await convo.handlePrompt("one more");
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'turn_cap' }));
  });

  test('a reconnected call\'s summary covers the WHOLE call: this leg with turns composes the earlier caller lines ahead of its own; a silent resumed socket writes the row-only summary (codex r3 P2)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    let { updates } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back\nAgent: Sorry to hear that.' }] } } });
    let convo = resumedConvo({ callSid: 'CA-sum' });
    convo._sessionSuperseded = jest.fn(async () => false);
    await convo._resumeReady;
    convo._recordTurn('caller', 'thanks');
    convo._recordTurn('agent', 'Bye.');
    await convo.end('ws_close');
    let reconcile = updates.find((u) => u.call_outcome === 'ai_handled');
    expect(reconcile.call_summary).toContain('Caller said: my ants are back | thanks');
    // silent resumed socket ⇒ the row-only composition carries the summary too
    ({ updates } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back' }] } } }));
    convo = resumedConvo({ callSid: 'CA-sum2' });
    convo._sessionSuperseded = jest.fn(async () => false);
    await convo.end('ws_close');
    reconcile = updates.find((u) => u.call_outcome === 'ai_handled');
    expect(reconcile.call_summary).toContain('Caller said: my ants are back');
    expect(reconcile.transcription.sql).toBe('COALESCE(?, transcription)');
  });

  test('the capture floor stamps the exact call→lead linkage (relay_lead_id) on the call row (codex r3 P2)', async () => {
    const { updates } = primeDb();
    const convo = new RelayConversation({ callSid: 'CA-floor', sessionKey: 'nonce-1', from: '+19415551234', send: jest.fn() });
    convo._callerVerified = true;
    convo._recordTurn('caller', 'hello');
    await convo._runCaptureFloor('ws_close');
    expect(createLeadFromExtraction).toHaveBeenCalled();
    const stamp = updates.find((u) => u.metadata && String(u.metadata.bindings?.[0] || '').includes('relay_lead_id'));
    expect(stamp).toBeTruthy();
    expect(JSON.parse(stamp.metadata.bindings[0])).toEqual({ relay_lead_id: 'L-floor' });
  });

  test('context gate OFF + recovery gate ON: the session still runs the CallSid/ANI claim on its own and publishes the verdict (codex r2 P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    primeDb();
    const convo = new RelayConversation({ callSid: 'CA-claim', sessionKey: 'nonce-9', sessionGeneration: 9, from: '+19415551234', send: jest.fn() });
    await convo._contextReady;
    expect(verifyRelaySession).toHaveBeenCalledWith(expect.objectContaining({ callSid: 'CA-claim', from: '+19415551234', sessionKey: 'nonce-9', sessionGeneration: 9 }));
    expect(convo._callerVerified).toBe(true);
    expect(convo._callerContext).toBeNull(); // no account context is built
    verifyRelaySession.mockClear();
    delete process.env.GATE_VOICE_RELAY_RECOVERY;
    const off = new RelayConversation({ callSid: 'CA-off2', sessionKey: 'nonce-9', from: '+19415551234', send: jest.fn() });
    expect(off._contextReady).toBeNull();
    expect(verifyRelaySession).not.toHaveBeenCalled();
  });

  test('a superseded socket whose late segment recomposed the call runs the commitments pass on the PERSISTED transcript under the CURRENT owner (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { transcription: 'Caller: first\n\n[Reconnected]\nCaller: second', metadata: { relay_session_claim_owner: 'nonce-NEW', relay_segments: [
      { generation: 1, text: 'Caller: first', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }] },
      { generation: 2, text: 'Caller: second', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'by_tomorrow', at: '2026-09-05T02:09:00.000Z' }] },
    ] } } });
    const convo = convoWithTurns({ sessionKey: 'nonce-OLD', sessionGeneration: 1 });
    convo._promises.set('send_estimate', { verdict: true, expectation: 'about_15_minutes', at: new Date('2026-09-05T02:00:00.000Z') }); // this superseded socket's OWN (older) promise
    convo._callerVerified = true;
    convo._sessionSuperseded = jest.fn(async () => true);
    await convo.end('ws_close');
    // …submitted with the ROW's latest promise (the resumed leg's), never this socket's older one (hook P1)
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transcript: 'Caller: first\n\n[Reconnected]\nCaller: second', sessionKey: 'nonce-NEW', estimateExpectation: 'by_tomorrow', estimatePromisedAt: '2026-09-05T02:09:00.000Z' }));
  });

  test('commitments on a reconnected call read the PERSISTED composed transcript under the owner fence (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ firstRow: { transcription: 'Caller: first leg\n\n[Reconnected]\nCaller: my ants are back' } });
    const convo = convoWithTurns({ sessionGeneration: 2 });
    await convo.end('ws_close');
    expect(builder.first).toHaveBeenCalledWith('transcription');
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transcript: 'Caller: first leg\n\n[Reconnected]\nCaller: my ants are back' }));
  });

  test('a resumed session: the hint is proven from the row, the earlier turns are seeded ONCE as played text, and the floor is skipped when a lead is linked', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my ants are back\nAgent: Sorry to hear that.' }] } } });
    const convo = resumedConvo({ callSid: 'CA-res', sessionGeneration: 2 });
    await convo._resumeReady;
    expect(convo._resume).toEqual({ reconnects: 1, reconnectMs: null, segmentsText: 'Caller: my ants are back\nAgent: Sorry to hear that.', relayLeadId: 'L1', reserviceFiled: false, noLeadCreated: false, leadCaptured: false, lookupsUsed: 0, lookupRefs: [], lookupResults: [], slotRefs: [], startedAtMs: null, holdOpen: false, estimateFields: null, modelFailures: 0, toolFailures: 0, promises: [], callerTurns: ['my ants are back'] });
    await convo._runLoop('where were we').catch(() => {}); // no Anthropic client in tests: the seeding half runs
    const seeded = convo.messages.filter((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call, before the line dropped'));
    expect(seeded).toHaveLength(1);
    expect(seeded[0].content).toContain('Caller: my ants are back');
    await convo._runLoop('and another thing').catch(() => {});
    expect(convo.messages.filter((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'))).toHaveLength(1);
    // The floor: a linked lead is kept, not overwritten by a floor write for this segment alone.
    await convo._runCaptureFloor('ws_close');
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('the resumed model can select a restored reference after the lookup budget is spent', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const result = 'Found one matching account: Fixture in Test City (customer_ref: C1-1). Confirm details they state; do not recite account details.';
    let Convo;
    let isolatedDb;
    let calls = 0;
    const stream = jest.fn((request) => ({ finalMessage: async () => {
      calls += 1;
      if (calls > 1) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I can help with that account.' }] };
      const seed = request.messages.find((m) => typeof m.content === 'string' && m.content.includes('Previously issued account lookup'));
      expect(seed.content).toContain('Fixture in Test City');
      expect(seed.content).not.toContain('internal-customer-id');
      const ref = seed.content.match(/customer_ref: ([A-Z0-9-]+)/)[1];
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'restored-read', name: 'get_account_overview', input: { customer_ref: ref } }] };
    } }));
    jest.isolateModules(() => {
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { return { messages: { stream } }; });
      Convo = require('../services/voice-agent/relay-conversation').RelayConversation;
      isolatedDb = require('../models/db');
    });
    try {
      const segment = segmentStore.buildSegment({ generation: 1, text: 'Caller: help with that account', lookupsUsed: 3, lookupRefs: [['C1-1', 'internal-customer-id']], lookupResults: [result] });
      primeDb({ db: isolatedDb, firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [segment] } } });
      const convo = new Convo({ callSid: 'CA-model-resume', sessionKey: 'nonce-2', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true });
      convo._callerVerified = true;
      await convo._resumeReady;
      convo._sessionSuperseded = jest.fn(async () => false);
      const execute = jest.fn(async (name, input, ctx) => {
        expect(name).toBe('get_account_overview');
        expect(ctx.consumeLookup()).toBe(false);
        expect(ctx.resolveLookupRef(input.customer_ref)).toBe('internal-customer-id');
        return 'Redacted account overview.';
      });
      convo._executeToolBounded = execute;
      await convo._runLoop('please continue');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(2);
    } finally { jest.dontMock('@anthropic-ai/sdk'); }
  });

  test('the resumed model can accept a prior spoken time using its seeded slot reference', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    let Convo;
    let isolatedDb;
    let calls = 0;
    const context = { date: '2026-01-02', startMinutes: 840, lat: 27.4, lng: -82.5, duration: 90, timeOfDay: 'afternoon', expandOpenDays: true };
    const stream = jest.fn((request) => ({ finalMessage: async () => {
      calls += 1;
      if (calls > 1) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The team will confirm your requested time.' }] };
      const seed = request.messages.find((m) => typeof m.content === 'string' && m.content.includes('Previously offered times'));
      expect(seed.content).toContain('Friday January 2 at 2 PM (slot_ref: S1-1)');
      expect(seed.content).not.toMatch(/27\.4|-82\.5|startMinutes|expandOpenDays/);
      const ref = seed.content.match(/slot_ref: ([A-Z0-9-]+)/)[1];
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'restored-booking', name: 'request_booking', input: { slot_ref: ref } }] };
    } }));
    jest.isolateModules(() => {
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { return { messages: { stream } }; });
      Convo = require('../services/voice-agent/relay-conversation').RelayConversation;
      isolatedDb = require('../models/db');
    });
    try {
      const segment = segmentStore.buildSegment({ generation: 1, text: 'Agent: I can offer Friday at two.\nTool: find_slots', slotRefs: [['S1-1', context]] });
      primeDb({ db: isolatedDb, firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_segments: [segment] } } });
      const convo = new Convo({ callSid: 'CA-model-slots', sessionKey: 'nonce-2', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true });
      convo._callerVerified = true;
      await convo._resumeReady;
      convo._sessionSuperseded = jest.fn(async () => false);
      const execute = jest.fn(async (name, input, ctx) => {
        expect(name).toBe('request_booking');
        expect(ctx.resolveSlotRef(input.slot_ref)).toEqual(context);
        return 'The team will confirm the requested time.';
      });
      convo._executeToolBounded = execute;
      await convo._runLoop('Yes, Friday at two works');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(2);
    } finally { jest.dontMock('@anthropic-ai/sdk'); }
  });

  test('a reconnect that read the row BEFORE the old socket appended its segment reloads on the next turns and seeds when it lands (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1 } } }); // proven, but no segment yet
    const convo = resumedConvo({ callSid: 'CA-race' });
    await convo._resumeReady;
    expect(convo._resume).toEqual({ reconnects: 1, reconnectMs: null, segmentsText: '', relayLeadId: null, reserviceFiled: false, noLeadCreated: false, leadCaptured: false, lookupsUsed: 0, lookupRefs: [], lookupResults: [], slotRefs: [], startedAtMs: null, holdOpen: false, estimateFields: null, modelFailures: 0, toolFailures: 0, promises: [], callerTurns: [] });
    await convo._runLoop('hello').catch(() => {});
    expect(convo.messages.some((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'))).toBe(false);
    builder.first = jest.fn(async () => ({ metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L9', relay_segments: [{ generation: 1, text: 'Caller: my ants are back', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }] }] } })); // the old socket's append landed
    await convo._runLoop('where were we').catch(() => {});
    const seeded = convo.messages.filter((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'));
    expect(seeded).toHaveLength(1);
    expect(seeded[0].content).toContain('Caller: my ants are back');
    // …and the reload restores the same state the constructor's load would (lead, promises) (hook P1)
    expect(convo.leadCaptured).toBe(true);
    expect(convo._promises.get('send_estimate')).toEqual({ verdict: true, expectation: 'about_15_minutes', at: new Date('2026-09-05T02:00:00.000Z') });
    // bounded: after RESUME_RELOAD_ATTEMPTS turns without a segment it stops re-reading
    const again = resumedConvo({ callSid: 'CA-race2' });
    builder.first = jest.fn(async () => ({ metadata: { ...OWNED, relay_reconnects: 1 } }));
    await again._resumeReady;
    for (const t of ['a', 'b', 'c', 'd', 'e']) await again._runLoop(t).catch(() => {});
    expect(again._resumeReloads).toBe(3); // three turn-time reloads, then it stops (the claim-owner reads a verified session makes are separate)
  });

  test('after a reconnect, the transfer SALVAGE and the metadata-only STASH carry the whole call (composed), not the resumed socket alone (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ updateImpl: jest.fn(async (patch) => { updates.push(patch); return updates.length === 2 ? 0 : 1; }) }); // append 1, reconcile 0 (terminal), salvage 1
    const convo = convoWithTurns({ sessionGeneration: 2 });
    convo._transferRequested = true;
    await convo.end('transfer');
    const salvage = updates[2];
    expect(salvage.transcription.sql).toBe('COALESCE(?, ?)'); // composed from relay_segments
    expect(salvage.metadata.sql).toContain("jsonb_build_object('relay_transcript', jsonb_build_object('text', ?, 'metadata', ?::jsonb))");
    expect(salvage.metadata.bindings[0].sql).toBe('COALESCE(?, ?)');
    // …and the metadata-only stash (voicemail won the close, or the processor already wrote the columns)
    const { updates: u2 } = primeDb({ updateImpl: jest.fn(async (patch) => { u2.push(patch); return u2.length === 4 ? 1 : (u2.length === 1 ? 1 : 0); }) });
    const c2 = convoWithTurns({ sessionGeneration: 2 });
    c2._transferRequested = true;
    await c2.end('transfer');
    const stash = u2[3];
    expect(stash.metadata.sql).toContain("jsonb_build_object('relay_transcript', jsonb_build_object('text', ?, 'metadata', ?::jsonb))");
    expect(stash.transcription.bindings[0].sql).toBe("'[AI segment]' || E'\\n' || ?"); // the prepend text is composed too
  });

  test('an UNVERIFIED or non-owning session with a `resumed` hint receives NO prior context (hook P0)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { ...OWNED, relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my account details' }] } } });
    verifyRelaySession.mockImplementationOnce(UNVERIFIED);
    const unverified = new RelayConversation({ callSid: 'CA-unv', sessionKey: 'nonce-2', from: '+19415551234', send: jest.fn(), resumed: true }); // never verified ⇒ never claimed
    await unverified._resumeReady;
    expect(unverified._resume).toBeNull();
    expect(unverified.leadCaptured).toBe(false);
    const foreign = resumedConvo({ callSid: 'CA-for', sessionKey: 'nonce-STRANGER' }); // verified, but not the row's claim owner
    await foreign._resumeReady;
    expect(foreign._resume).toBeNull();
    const noKey = new RelayConversation({ callSid: 'CA-nokey', from: '+19415551234', send: jest.fn(), resumed: true });
    expect(noKey._resumeReady).toBeNull();
  });

  test('a forged `resumed` hint (row has no reconnect stamp) seeds nothing and the floor runs as usual; gate off loads nothing', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { relay_segments: [{ generation: 1, text: 'x' }] } } });
    const convo = resumedConvo({ callSid: 'CA-forge' });
    await convo._resumeReady;
    expect(convo._resume).toBeNull();
    await convo._runLoop('hi').catch(() => {});
    expect(convo.messages.some((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'))).toBe(false);
    delete process.env.GATE_VOICE_RELAY_RECOVERY;
    const off = resumedConvo({ callSid: 'CA-off' });
    expect(off._resumeReady).toBeNull();
  });

});

describe('provider failure tracking', () => {
    function isolated({ streamImpl, executeToolImpl }) {
      let Convo;
      let leadWriter;
      let dbIso;
      jest.resetModules(); // relay-conversation requires relay-tools lazily — a cached instance from an earlier case must not win
      jest.isolateModules(() => {
        jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { return { messages: { stream: streamImpl } }; });
        jest.doMock('../services/voice-agent/relay-tools', () => ({ TOOLS: [], CONTEXT_TOOLS: [], activeTools: () => [], executeTool: executeToolImpl }));
        Convo = require('../services/voice-agent/relay-conversation').RelayConversation;
        leadWriter = require('../services/lead-from-extraction').createLeadFromExtraction; // the isolated registry's mocks
        dbIso = require('../models/db');
      });
      return { Convo, leadWriter, dbIso };
    }


  test('a timed-out tool cannot mark a later successful invocation failed; copied getters stay live', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    let failFirst;
    let finishSecond;
    let secondCtx;
    const firstDone = new Promise((resolve) => { failFirst = resolve; });
    const secondDone = new Promise((resolve) => { finishSecond = resolve; });
    const stream = jest.fn()
      .mockReturnValueOnce({ finalMessage: async () => ({ stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'get_services_catalog', input: {} },
        { type: 'tool_use', id: 't2', name: 'find_slots', input: {} },
      ] }) })
      .mockReturnValue({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here are the options.' }] }) });
    const executeTool = jest.fn(async (name, _input, ctx) => {
      if (name === 'get_services_catalog') {
        await firstDone;
        ctx.toolFailed = true;
        return 'Catalog unavailable.';
      }
      secondCtx = ctx;
      await secondDone;
      return 'An available slot.';
    });
    const { Convo, dbIso } = isolated({ streamImpl: stream, executeToolImpl: executeTool });
    primeDb({ db: dbIso });
    const endSession = jest.fn();
    const convo = new Convo({ callSid: 'CA-overlap-fixture', from: '+19415551234', send: jest.fn(), endSession });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const pending = convo._runLoop('what is available');
      await jest.advanceTimersByTimeAsync(3010);
      expect(executeTool).toHaveBeenCalledTimes(2);
      expect(convo._toolFailures).toBe(1);
      failFirst();
      await jest.advanceTimersByTimeAsync(0);
      expect(secondCtx.toolFailed).toBe(false);
      convo._callerContext = { tier: 'full', customer: { id: 'customer-fixture' } };
      expect(secondCtx.customerTier).toBe('full');
      expect(secondCtx.customerId).toBe('customer-fixture');
      finishSecond();
      await pending;
      expect(convo._toolOutcomes).toEqual([
        { name: 'get_services_catalog', ok: false }, { name: 'find_slots', ok: true },
      ]);
      expect(convo._toolFailures).toBe(0);
      expect(endSession).not.toHaveBeenCalled();
    } finally { failFirst(); finishSecond(); jest.useRealTimers(); }
  });

  test('a successful model round clears only model failures', async () => {
    const stream = jest.fn()
      .mockReturnValueOnce({ finalMessage: async () => { throw new Error('provider unavailable'); } })
      .mockReturnValue({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Please continue.' }] }) });
    const { Convo, dbIso } = isolated({ streamImpl: stream, executeToolImpl: jest.fn() });
    primeDb({ db: dbIso });
    const convo = new Convo({ callSid: 'CA-model-fixture', from: '+19415551234', send: jest.fn() });
    convo._toolFailures = 1;
    await convo._runLoop('first');
    expect(convo._modelFailures).toBe(1);
    await convo._runLoop('second');
    expect(convo._modelFailures).toBe(0);
    expect(convo._toolFailures).toBe(1);
  });
});

describe('socket completion registration and bounded ownership reads', () => {
  test('a silent authenticated socket registers and closes even without caller identity', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb();
    const register = jest.spyOn(segmentStore, 'registerSegmentSession').mockResolvedValueOnce(true);
    const append = jest.spyOn(segmentStore, 'appendSegment').mockResolvedValueOnce(1);
    try {
      const convo = new RelayConversation({ callSid: 'CA-silent', sessionKey: 'silent', callTokenVerified: true, send: jest.fn() });
      await convo._contextReady;
      convo._callerVerified = false;
      convo._runCaptureFloor = jest.fn(async () => {});
      expect(register).toHaveBeenCalledWith(expect.anything(), 'CA-silent', 'silent');
      await convo.end('ws_close');
      expect(append).toHaveBeenCalledWith(expect.anything(), 'CA-silent', expect.objectContaining({
        session_key: 'silent', text: '', turns: 0,
      }), { allowUnclaimed: true });
    } finally { register.mockRestore(); append.mockRestore(); }
  });

  test.each(['registration', 'ownership'])('a stalled %s read fails closed within the turn deadline', async (stage) => {
    jest.useFakeTimers();
    const context = require('../services/voice-agent/relay-context');
    const owner = jest.spyOn(context, 'relaySessionClaimOwner').mockReturnValue(new Promise(() => {}));
    try {
      const convo = Object.assign(Object.create(RelayConversation.prototype), {
        callSid: 'CA-bound', sessionKey: 'first', _callerVerified: true,
        _segmentRegistration: stage === 'registration' ? new Promise(() => {}) : null,
      });
      const verdict = convo._sessionSuperseded();
      await jest.advanceTimersByTimeAsync(2001);
      expect(await verdict).toBe(true);
    } finally { owner.mockRestore(); jest.useRealTimers(); }
  });
});
