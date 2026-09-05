/**
 * Sandy PR 2B — voice-session recovery (GATE_VOICE_RELAY_RECOVERY), the
 * module + the conversation side. The route side is
 * twilio-voice-relay-recovery.test.js.
 *
 * Gate off ⇒ nothing here runs: no segment append, no generation fence, no
 * resume seed, no provider-failure handoff — the close-time statements are
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

const recovery = require('../services/voice-agent/relay-recovery');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { recordRelayCommitments } = require('../services/call-commitments');

afterEach(() => { delete process.env.GATE_VOICE_RELAY_RECOVERY; delete process.env.GATE_VOICE_RELAY_TRANSFER; jest.clearAllMocks(); });

function primeDb({ firstRow = null, updateImpl } = {}) {
  const db = require('../models/db');
  const updates = [];
  const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis(), orWhere: jest.fn().mockReturnThis() };
  const builder = {
    update: updateImpl || jest.fn(async (patch) => { updates.push(patch); return 1; }),
    where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
    whereIn: jest.fn(() => builder),
    whereRaw: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    first: jest.fn(async () => firstRow),
    select: jest.fn(() => builder),
  };
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

  test('undoLateReconnect puts back only the claim it made (fenced on its own reconnect_ms and a NULL outcome)', async () => {
    const { db, builder, updates } = primeDb();
    await recovery.undoLateReconnect(db, { callSid: 'CA-1', nowMs: 42 });
    expect(builder.whereRaw).toHaveBeenCalledWith("(metadata->>'relay_reconnect_ms')::bigint = ?", [42]);
    expect(builder.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(updates[0]).toEqual(expect.objectContaining({ call_outcome: 'voicemail', answered_by: 'voicemail', status: 'completed' }));
  });

  test('segments: append never overwrites; composition orders by generation with the [Reconnected] separator; the fence is ≤ generation', () => {
    const { db } = primeDb();
    const seg = recovery.buildSegment({ generation: 7, sessionKey: 'k', reason: 'ws_close', text: 'Caller: hi', turns: 1, latency: { turns: 1 }, versions: { model: 'm' }, leadCaptured: true });
    expect(seg).toEqual(expect.objectContaining({ generation: 7, session_key: 'k', reason: 'ws_close', text: 'Caller: hi', turns: 1, lead_captured: true }));
    const append = recovery.appendSegmentSql(db, seg);
    expect(append.sql).toBe("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_segments', COALESCE(metadata->'relay_segments', '[]'::jsonb) || ?::jsonb)");
    expect(JSON.parse(append.bindings[0])).toEqual([seg]);
    const compose = recovery.composeSegmentsSql(db);
    expect(compose.sql).toContain("string_agg(seg->>'text', ? ORDER BY (seg->>'generation')::bigint, ord)");
    expect(compose.bindings).toEqual([recovery.SEGMENT_SEPARATOR]);
    expect(recovery.segmentsText([{ generation: 2, text: 'second' }, { generation: 1, text: 'first' }, { generation: 3, text: '' }])).toBe(`first${recovery.SEGMENT_SEPARATOR}second`);
    const q = { whereRaw: jest.fn().mockReturnThis() };
    recovery.generationFenceSql(q, 99);
    expect(q.whereRaw).toHaveBeenCalledWith("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) <= ?", [99]);
  });

  test('appendSegmentPatch: the append also recomposes Sandy-owned columns and the stash — a late old segment refreshes a call the resumed socket already finalized (hook P1)', () => {
    const { db } = primeDb();
    const seg = recovery.buildSegment({ generation: 1, text: 'Caller: first leg' });
    const patch = recovery.appendSegmentPatch(db, seg);
    expect(patch.transcription.sql).toContain("WHEN transcription_provider = ? AND COALESCE(transcription, '') <> '' AND ? IS NOT NULL THEN ?");
    expect(patch.transcription.sql).toMatch(/ELSE transcription\s+END$/);
    expect(patch.transcription.bindings[0]).toBe('conversation_relay'); // a recording's transcript is never touched
    expect(patch.transcription.bindings[1].sql).toContain("COALESCE(metadata->'relay_segments', '[]'::jsonb) || ?::jsonb"); // unioned with THIS segment
    expect(patch.metadata.sql).toBe("CASE WHEN (metadata->'relay_transcript') IS NOT NULL AND ? IS NOT NULL THEN jsonb_set(?, '{relay_transcript,text}', to_jsonb(?::text), false) ELSE ? END");
    expect(patch.metadata.bindings[1].sql).toContain("'relay_segments'"); // the append rides both branches
    expect(patch.metadata.bindings[3].sql).toContain("'relay_segments'");
  });

  test('appendSegmentPatch refreshes the AI portion of a processor composite and preserves the recorded portion (hook P1)', () => {
    const { db } = primeDb();
    const patch = recovery.appendSegmentPatch(db, recovery.buildSegment({ generation: 1, text: 'Caller: first leg' }));
    expect(patch.transcription.sql).toMatch(/WHEN transcription LIKE '\[AI segment\]%' AND transcription ~ \? AND \? IS NOT NULL\s+THEN '\[AI segment\]' \|\| E'\\n' \|\| \? \|\| substring\(transcription from \?\)/);
    expect(patch.transcription.bindings[5]).toBe('\\n\\n\\[(?:Staff|Voicemail) segment\\]\\n[\\s\\S]*$'); // non-capturing: substring(from) returns the whole match
    expect(patch.transcription.bindings[8]).toBe(patch.transcription.bindings[5]);
    // …and an EMPTY unowned column (the resumed socket closed silently first) is filled and claimed
    expect(patch.transcription.sql).toContain("WHEN COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND ? IS NOT NULL THEN ?");
    expect(patch.transcription_provider.sql).toBe("CASE WHEN COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND ? IS NOT NULL THEN ? ELSE transcription_provider END");
    expect(patch.transcription_provider.bindings[1]).toBe('conversation_relay');
    expect(patch.transcription_status.sql).toContain("THEN 'completed' ELSE transcription_status END");
  });

  test('loadResumeState proves the hint from the row: reconnects > 0 ⇒ state; otherwise null; bounded and fail-soft', async () => {
    const { db } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: ants' }] } } });
    expect(await recovery.loadResumeState(db, 'CA-1')).toEqual({ reconnects: 1, reconnectMs: null, segmentsText: 'Caller: ants', relayLeadId: 'L1', reserviceFiled: false, noLeadCreated: false, promises: [], callerTurns: ['ants'] });
    primeDb({ firstRow: { metadata: JSON.stringify({ relay_segments: [{ generation: 1, text: 'x' }] }) } });
    expect(await recovery.loadResumeState(db, 'CA-1')).toBeNull(); // no reconnect stamp ⇒ a forged <Parameter resumed> proves nothing
    primeDb({ firstRow: null });
    expect(await recovery.loadResumeState(db, 'CA-1')).toBeNull();
    const { builder } = primeDb();
    builder.first = jest.fn(() => new Promise(() => {}));
    expect(await recovery.loadResumeState(db, 'CA-1', { timeoutMs: 20 })).toBeNull();
    expect(await recovery.loadResumeState(db, '')).toBeNull();
  });

  test('a segment keeps everything the transcript store keeps; only the resume SEED is capped (tail) (hook P1)', async () => {
    const { MAX_TRANSCRIPT_CHARS } = require('../services/voice-agent/relay-transcript');
    const long = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 10);
    expect(recovery.buildSegment({ generation: 1, text: long }).text).toHaveLength(MAX_TRANSCRIPT_CHARS);
    const { db } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_reconnect_ms: 5, relay_segments: [{ generation: 1, text: 'a'.repeat(recovery.RESUME_SEED_MAX_CHARS + 50) }] } } });
    const state = await recovery.loadResumeState(db, 'CA-1');
    expect(state.segmentsText).toHaveLength(recovery.RESUME_SEED_MAX_CHARS + 3);
    expect(state.segmentsText.startsWith('[…]')).toBe(true);
    expect(state.reconnectMs).toBe(5);
    expect(await recovery.readReconnectState(db, 'CA-1')).toEqual({ reconnects: 1, reconnectMs: 5 });
  });

  test('promises ride the segment and are restored (latest per kind) with their expectation and timestamp; caller turns are extracted (hook P1)', async () => {
    const at = new Date('2026-09-05T02:00:00.000Z');
    const seg = recovery.buildSegment({ generation: 1, text: 'Caller: ants\nAgent: I will send an estimate.\nCaller: thanks', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at }] });
    expect(seg.promises).toEqual([{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }]);
    const { db } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_segments: [
      { generation: 2, text: 'Caller: later', promises: [{ kind: 'send_estimate', verdict: false, expectation: null, at: '2026-09-05T02:05:00.000Z' }] },
      seg,
    ] } } });
    const state = await recovery.loadResumeState(db, 'CA-1');
    expect(state.promises).toEqual([{ kind: 'send_estimate', verdict: false, expectation: null, at: '2026-09-05T02:05:00.000Z' }]); // generation 2 wins
    expect(state.callerTurns).toEqual(['ants', 'thanks', 'later']);
  });

  test('providerFailurePolicy hands off at the limit on either counter', () => {
    expect(recovery.providerFailurePolicy({ modelFailures: 1, toolFailures: 1 })).toBeNull();
    expect(recovery.providerFailurePolicy({ modelFailures: 2 })).toBe('handoff');
    expect(recovery.providerFailurePolicy({ toolFailures: 2 })).toBe('handoff');
    expect(recovery.providerFailurePolicy()).toBeNull();
  });
});

describe('the conversation side', () => {
  function convoWithTurns(over = {}) {
    const convo = new RelayConversation({ callSid: 'CA-rec', sessionKey: 'nonce-1', sessionGeneration: 1725500001000, from: '+19415551234', send: jest.fn(), ...over });
    convo.leadCaptured = true; // the floor is not under test unless stated
    convo._recordTurn('caller', 'my ants are back');
    convo._recordTurn('agent', 'Sorry to hear that.');
    return convo;
  }

  test('gate on: end() appends this socket\'s segment FIRST (CallSid-fenced only), then the generation-fenced column write composes from all segments', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder, updates } = primeDb();
    const convo = convoWithTurns();
    await convo.end('ws_close');
    // 1: the segment append — metadata only, no columns, no owner/generation fence on it
    expect(Object.keys(updates[0]).sort()).toEqual(['metadata', 'transcription', 'transcription_provider', 'transcription_status', 'updated_at']); // no outcome / status / owner fence on the append
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

  test('gate on, the append did not land (no row) ⇒ the column write carries this socket\'s plain text, no composition', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ updateImpl: jest.fn(async (patch) => { updates.push(patch); return updates.length === 1 ? 0 : 1; }) });
    const convo = convoWithTurns();
    await convo.end('ws_close');
    expect(typeof updates[1].transcription).toBe('string');
    expect(JSON.parse(updates[1].transcription_metadata).segments).toBeUndefined();
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

  test('a resumed socket the caller never spoke on still composes the earlier segment(s) onto the columns at its close (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates, builder } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: first leg' }] }, transcription: 'Caller: first leg' } });
    const convo = new RelayConversation({ callSid: 'CA-silent', sessionKey: 'nonce-2', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true });
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
    primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen\nAgent: I can help.', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }] }] } } });
    const convo = new RelayConversation({ callSid: 'CA-prom', from: '+19415551234', send: jest.fn(), resumed: true });
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
    const { builder } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen' }] } } });
    let settle;
    builder.first = jest.fn(() => new Promise((r) => { settle = r; })); // the resume read is still pending when the socket closes
    const convo = new RelayConversation({ callSid: 'CA-early', from: '+19415551234', send: jest.fn(), resumed: true });
    const closing = convo.end('ws_close');
    settle({ metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: my ants are back in the kitchen' }] } });
    await closing;
    expect(createLeadFromExtraction).toHaveBeenCalledWith(expect.objectContaining({ call_summary: expect.stringContaining('Caller said: my ants are back in the kitchen') }), expect.anything());
  });

  test('a re-service filed on an earlier leg survives the reconnect: no lead capture, reserviceFiled reported, and the flag rides this leg\'s segment (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_segments: [{ generation: 1, text: 'Caller: come back please', reservice_filed: true, no_lead_created: true }] } } });
    const convo = new RelayConversation({ callSid: 'CA-rs', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true });
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

  test('a proven prior lead restores the capture state (lead_captured true; the session may end when the caller is done) (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_lead_id: 'L1' } } });
    const convo = new RelayConversation({ callSid: 'CA-lead', from: '+19415551234', send: jest.fn(), resumed: true });
    await convo._resumeReady;
    expect(convo.leadCaptured).toBe(true);
    primeDb({ firstRow: { metadata: { relay_reconnects: 1 } } });
    const none = new RelayConversation({ callSid: 'CA-nolead', from: '+19415551234', send: jest.fn(), resumed: true });
    await none._resumeReady;
    expect(none.leadCaptured).toBe(false);
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
    expect(recordRelayCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transcript: 'Caller: first\n\n[Reconnected]\nCaller: second', sessionKey: 'nonce-NEW', estimateExpectation: 'by_tomorrow', estimatePromisedAt: new Date('2026-09-05T02:09:00.000Z') }));
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
    primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my ants are back\nAgent: Sorry to hear that.' }] } } });
    const convo = new RelayConversation({ callSid: 'CA-res', sessionKey: 'nonce-2', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true });
    await convo._resumeReady;
    expect(convo._resume).toEqual({ reconnects: 1, reconnectMs: null, segmentsText: 'Caller: my ants are back\nAgent: Sorry to hear that.', relayLeadId: 'L1', reserviceFiled: false, noLeadCreated: false, promises: [], callerTurns: ['my ants are back'] });
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

  test('a reconnect that read the row BEFORE the old socket appended its segment reloads on the next turns and seeds when it lands (hook P1)', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { builder } = primeDb({ firstRow: { metadata: { relay_reconnects: 1 } } }); // proven, but no segment yet
    const convo = new RelayConversation({ callSid: 'CA-race', from: '+19415551234', send: jest.fn(), resumed: true });
    await convo._resumeReady;
    expect(convo._resume).toEqual({ reconnects: 1, reconnectMs: null, segmentsText: '', relayLeadId: null, reserviceFiled: false, noLeadCreated: false, promises: [], callerTurns: [] });
    await convo._runLoop('hello').catch(() => {});
    expect(convo.messages.some((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'))).toBe(false);
    builder.first = jest.fn(async () => ({ metadata: { relay_reconnects: 1, relay_lead_id: 'L9', relay_segments: [{ generation: 1, text: 'Caller: my ants are back', promises: [{ kind: 'send_estimate', verdict: true, expectation: 'about_15_minutes', at: '2026-09-05T02:00:00.000Z' }] }] } })); // the old socket's append landed
    await convo._runLoop('where were we').catch(() => {});
    const seeded = convo.messages.filter((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'));
    expect(seeded).toHaveLength(1);
    expect(seeded[0].content).toContain('Caller: my ants are back');
    // …and the reload restores the same state the constructor's load would (lead, promises) (hook P1)
    expect(convo.leadCaptured).toBe(true);
    expect(convo._promises.get('send_estimate')).toEqual({ verdict: true, expectation: 'about_15_minutes', at: new Date('2026-09-05T02:00:00.000Z') });
    // bounded: after RESUME_RELOAD_ATTEMPTS turns without a segment it stops re-reading
    const again = new RelayConversation({ callSid: 'CA-race2', from: '+19415551234', send: jest.fn(), resumed: true });
    builder.first = jest.fn(async () => ({ metadata: { relay_reconnects: 1 } }));
    await again._resumeReady;
    for (const t of ['a', 'b', 'c', 'd', 'e']) await again._runLoop(t).catch(() => {});
    expect(builder.first.mock.calls.length).toBeLessThanOrEqual(1 + 3);
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

  test('a forged `resumed` hint (row has no reconnect stamp) seeds nothing and the floor runs as usual; gate off loads nothing', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { relay_segments: [{ generation: 1, text: 'x' }] } } });
    const convo = new RelayConversation({ callSid: 'CA-forge', from: '+19415551234', send: jest.fn(), resumed: true });
    await convo._resumeReady;
    expect(convo._resume).toBeNull();
    await convo._runLoop('hi').catch(() => {});
    expect(convo.messages.some((m) => typeof m.content === 'string' && m.content.includes('[Earlier in this call'))).toBe(false);
    delete process.env.GATE_VOICE_RELAY_RECOVERY;
    const off = new RelayConversation({ callSid: 'CA-off', from: '+19415551234', send: jest.fn(), resumed: true });
    expect(off._resumeReady).toBeNull();
  });

  describe('provider-failure handoff', () => {
    function isolated({ streamImpl, executeToolImpl }) {
      let Convo;
      let leadWriter;
      jest.resetModules(); // relay-conversation requires relay-tools lazily — a cached instance from an earlier case must not win
      jest.isolateModules(() => {
        jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { return { messages: { stream: streamImpl } }; });
        jest.doMock('../services/voice-agent/relay-tools', () => ({ TOOLS: [], CONTEXT_TOOLS: [], activeTools: () => [], executeTool: executeToolImpl }));
        Convo = require('../services/voice-agent/relay-conversation').RelayConversation;
        leadWriter = require('../services/lead-from-extraction').createLeadFromExtraction; // the isolated registry's mock
      });
      return { Convo, leadWriter };
    }

    test('the second consecutive model failure hands off: office open ⇒ transfer_to_office runs (2A ends the leg); no re-prompt copy', async () => {
      process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
      process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
      primeDb();
      const stream = jest.fn(() => ({ finalMessage: async () => { throw new Error('upstream 500'); } }));
      const executeTool = jest.fn(async (name, input, ctx) => { ctx.endForTransfer(); return 'Transferring the caller to the office now.'; });
      const { Convo } = isolated({ streamImpl: stream, executeToolImpl: executeTool });
      const send = jest.fn();
      const endSession = jest.fn();
      const convo = new Convo({ callSid: 'CA-pf', from: '+19415551234', send, endSession });
      convo._officeHours = { open: true };
      convo._buildToolCtx = ((orig) => function () { const c = orig.call(this); c.officeOpenNow = () => true; return c; })(convo._buildToolCtx);
      await convo._runLoop('first').catch(() => {});
      expect(convo._modelFailures).toBe(1);
      expect(executeTool).not.toHaveBeenCalled();
      await convo._runLoop('second').catch(() => {});
      expect(executeTool).toHaveBeenCalledWith('transfer_to_office', expect.objectContaining({ intent: 'system trouble' }), expect.anything());
      const spoken = send.mock.calls.map(([t]) => String(t)).join(' | ');
      expect(spoken).toMatch(/connect you with the office/);
      expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'transfer' }));
      expect(convo._handoffForFailure).toBe(true);
    });

    test('…office closed ⇒ the callback close: capture floor + a clean end (reason provider_failure); once per call', async () => {
      process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
      primeDb();
      const stream = jest.fn(() => ({ finalMessage: async () => { throw new Error('upstream 500'); } }));
      const executeTool = jest.fn();
      const { Convo, leadWriter } = isolated({ streamImpl: stream, executeToolImpl: executeTool });
      const send = jest.fn();
      const endSession = jest.fn();
      const convo = new Convo({ callSid: 'CA-pf2', from: '+19415551234', send, endSession });
      await convo._runLoop('first').catch(() => {});
      await convo._runLoop('second').catch(() => {});
      expect(executeTool).not.toHaveBeenCalled();
      expect(send.mock.calls.map(([t]) => String(t)).join(' | ')).toMatch(/call you back as soon as possible/);
      expect(leadWriter).toHaveBeenCalledTimes(1);
      expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'provider_failure' }));
      expect(convo._ending).toBe(true);
    });

    test('a successful round resets the model streak; gate off ⇒ the streak counts but nothing hands off', async () => {
      let n = 0;
      const stream = jest.fn(() => ({ finalMessage: async () => { n += 1; if (n === 2) return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; throw new Error('boom'); } }));
      const { Convo } = isolated({ streamImpl: stream, executeToolImpl: jest.fn() });
      const endSession = jest.fn();
      const convo = new Convo({ callSid: 'CA-pf3', from: '+19415551234', send: jest.fn(), endSession });
      await convo._runLoop('a').catch(() => {});
      expect(convo._modelFailures).toBe(1);
      await convo._runLoop('b').catch(() => {});
      expect(convo._modelFailures).toBe(0);
      await convo._runLoop('c').catch(() => {});
      await convo._runLoop('d').catch(() => {});
      expect(convo._modelFailures).toBe(2);
      expect(endSession).not.toHaveBeenCalled(); // gate off: today's re-prompt loop
    });

    test('a second failed TOOL in one call hands off too', async () => {
      process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
      primeDb();
      const stream = jest.fn(() => ({ finalMessage: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'find_slots', input: {} }], stop_reason: 'tool_use' }) }));
      const executeTool = jest.fn(async (name, input, ctx) => { ctx.toolFailed = true; return 'Could not look that up.'; });
      const { Convo } = isolated({ streamImpl: stream, executeToolImpl: executeTool });
      const endSession = jest.fn();
      const convo = new Convo({ callSid: 'CA-pf4', from: '+19415551234', send: jest.fn(), endSession });
      await convo._runLoop('book me').catch(() => {});
      expect(convo._toolFailures).toBeGreaterThanOrEqual(2);
      expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'provider_failure' }));
    });
  });
});
