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

const recovery = require('../services/voice-agent/relay-recovery');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');

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

  test('loadResumeState proves the hint from the row: reconnects > 0 ⇒ state; otherwise null; bounded and fail-soft', async () => {
    const { db } = primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: ants' }] } } });
    expect(await recovery.loadResumeState(db, 'CA-1')).toEqual({ reconnects: 1, segmentsText: 'Caller: ants', relayLeadId: 'L1' });
    primeDb({ firstRow: { metadata: JSON.stringify({ relay_segments: [{ generation: 1, text: 'x' }] }) } });
    expect(await recovery.loadResumeState(db, 'CA-1')).toBeNull(); // no reconnect stamp ⇒ a forged <Parameter resumed> proves nothing
    primeDb({ firstRow: null });
    expect(await recovery.loadResumeState(db, 'CA-1')).toBeNull();
    const { builder } = primeDb();
    builder.first = jest.fn(() => new Promise(() => {}));
    expect(await recovery.loadResumeState(db, 'CA-1', { timeoutMs: 20 })).toBeNull();
    expect(await recovery.loadResumeState(db, '')).toBeNull();
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
    expect(updates[0]).toEqual({ metadata: expect.objectContaining({ sql: expect.stringContaining("'relay_segments'") }), updated_at: expect.any(Date) });
    const seg = JSON.parse(updates[0].metadata.bindings[0])[0];
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

  test('a superseded socket still appends its segment, then skips every column write', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    const { updates } = primeDb();
    const convo = convoWithTurns();
    convo._callerVerified = true;
    convo._sessionSuperseded = jest.fn(async () => true);
    await convo.end('ws_close');
    expect(updates).toHaveLength(1);
    expect(updates[0].metadata.sql).toContain("'relay_segments'");
  });

  test('a resumed session: the hint is proven from the row, the earlier turns are seeded ONCE as played text, and the floor is skipped when a lead is linked', async () => {
    process.env.GATE_VOICE_RELAY_RECOVERY = 'true';
    primeDb({ firstRow: { metadata: { relay_reconnects: 1, relay_lead_id: 'L1', relay_segments: [{ generation: 1, text: 'Caller: my ants are back\nAgent: Sorry to hear that.' }] } } });
    const convo = new RelayConversation({ callSid: 'CA-res', sessionKey: 'nonce-2', sessionGeneration: 2, from: '+19415551234', send: jest.fn(), resumed: true });
    await convo._resumeReady;
    expect(convo._resume).toEqual({ reconnects: 1, segmentsText: 'Caller: my ants are back\nAgent: Sorry to hear that.', relayLeadId: 'L1' });
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
