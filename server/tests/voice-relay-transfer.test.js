/**
 * Sandy PR 2A — human handoff (GATE_VOICE_RELAY_TRANSFER).
 *
 * The tool exists only while the gate is on AND the office is open (null =
 * closed), re-checked inside executeTool; the packet is server state; a
 * packet write failure still transfers and rings the no-context bell once;
 * the whisper is ≤20 words and sanitized; the AI segment survives the
 * staff-leg recording; ai_transferred is terminal and bell-handled.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || '').slice(-4) }));

const { notifyAdmin: triggerNotification } = require('../services/notification-service');
const transfer = require('../services/voice-agent/relay-transfer');
const { activeTools, executeTool } = require('../services/voice-agent/relay-tools');
const { RelayConversation, buildBasePrompt } = require('../services/voice-agent/relay-conversation');
const { RELAY_TERMINAL_OUTCOMES } = require('../services/voice-agent/relay-protocol');
const { missedCallEligible } = require('../services/missed-call-bell');

const names = (tools) => tools.map((t) => t.name);

afterEach(() => { delete process.env.GATE_VOICE_RELAY_TRANSFER; jest.clearAllMocks(); });

describe('registration — gate on AND office open', () => {
  test('gate off ⇒ absent whatever the office state; the tool set is byte-identical to today', () => {
    expect(names(activeTools({ officeOpen: true }))).not.toContain('transfer_to_office');
    expect(activeTools({ officeOpen: true })).toEqual(activeTools());
  });
  test.each([[false], [null], [undefined]])('gate on but office %s ⇒ absent (unknown counts as closed)', (officeOpen) => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    expect(names(activeTools({ officeOpen }))).not.toContain('transfer_to_office');
  });
  test('gate on + office open ⇒ registered, with or without the context tools', () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    expect(names(activeTools({ officeOpen: true }))).toContain('transfer_to_office');
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    expect(names(activeTools({ officeOpen: true }))).toContain('transfer_to_office');
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  });
  test('the prompt addendum follows the office state; gate off ⇒ byte-identical', () => {
    const before = buildBasePrompt(false, null, { officeOpen: true });
    expect(before).toBe(buildBasePrompt(false));
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    expect(buildBasePrompt(false, null, { officeOpen: true })).toContain('TRANSFER TO A PERSON (transfer_to_office)');
    expect(buildBasePrompt(false, null, { officeOpen: false })).toContain('WHEN THEY ASK FOR A PERSON (office closed)');
    // Unknown hours (lookup failed / timed out): no transfer, and NO claim that the office is closed (codex r5 P2).
    const unknown = buildBasePrompt(false, null, { officeOpen: null });
    expect(unknown).toContain('WHEN THEY ASK FOR A PERSON (office hours unknown)');
    expect(unknown).not.toContain('office closed');
    expect(unknown).not.toContain('transfer_to_office');
    expect(unknown).toContain('Do NOT say the office is open or closed');
  });
});

function ctxFor(over = {}) {
  const writes = [];
  return {
    writes,
    ctx: {
      callSid: 'CA-tx-1',
      officeOpenNow: () => true,
      say: jest.fn(),
      endForTransfer: jest.fn(),
      transferRequested: jest.fn(() => false),
      markTransferRequested: jest.fn(),
      handoffFacts: () => ({ verificationTier: 'full', from: '+19415551234', language: null, factsCollected: { first_name: 'Pat', zip: '34205' }, tools: [{ name: 'get_account_overview', ok: true }, { name: 'get_invoice_history', ok: false }], commitments: [{ kind: 'estimate', verdict: true, expectation: 'about_15_minutes' }], turnCount: 4 }),
      writeHandoff: jest.fn(async (packet) => { writes.push(packet); return 1; }),
      ...over,
    },
  };
}

describe('executeTool transfer_to_office', () => {
  test('refuses when the gate is off or the office is closed/unknown — offers the callback instead', async () => {
    const { ctx } = ctxFor();
    // Gate off mid-call (the frozen tool list still carries the tool): refused WITHOUT a word about the hours (codex r6 P2).
    const gateOff = await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, ctx);
    expect(gateOff).toMatch(/not available on this call.*capture_lead/s);
    expect(gateOff).not.toMatch(/office is closed/);
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx: closed } = ctxFor({ officeOpenNow: () => false });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, closed)).toMatch(/office is closed/);
    expect(closed.endForTransfer).not.toHaveBeenCalled();
    const { ctx: unknown } = ctxFor({ officeOpenNow: () => null });
    const unknownOut = await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, unknown);
    expect(unknownOut).toMatch(/do not say the office is open or closed/);
    expect(unknownOut).not.toMatch(/office is closed/);
    expect(unknown.endForTransfer).not.toHaveBeenCalled();
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
  });

  test('the packet is server state; the model\'s verification claim is ignored; then speak + end with reason transfer', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx, writes } = ctxFor();
    const out = await executeTool('transfer_to_office', {
      intent: 'billing dispute', summary: 'Says the June invoice charged twice and wants a refund today, very upset about it all', caller_name: 'Pat <script>Doe', unresolved_question: 'refund timing', verification_tier: 'full',
    }, ctx);
    expect(out).toMatch(/do not say anything else/i);
    expect(writes).toHaveLength(1);
    const p = writes[0];
    expect(p).toMatchObject({ verification_tier: 'full', from: '+19415551234', intent: 'billing dispute', caller_name: 'Pat scriptDoe', turn_count: 4, misunderstanding_count: null, context_available: true });
    expect(p.summary.split(' ')).toHaveLength(16); // ≤20 words, kept whole here
    expect(p.tools).toEqual([{ name: 'get_account_overview', ok: true }, { name: 'get_invoice_history', ok: false }]);
    expect(p.facts_collected).toEqual({ first_name: 'Pat', zip: '34205' });
    expect(p.commitments[0]).toMatchObject({ kind: 'estimate', verdict: true });
    expect(ctx.say).toHaveBeenCalledWith(expect.stringMatching(/connect you with a Waves team member/));
    expect(ctx.endForTransfer).toHaveBeenCalledTimes(1);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a long summary is clamped to twenty words', () => {
    const p = transfer.buildHandoffPacket({ intent: 'x', summary: Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ') }, {});
    expect(p.summary.split(' ')).toHaveLength(20);
    expect(p.verification_tier).toBe('unverified');
  });

  test('both writes unconfirmed (storage down) ⇒ ABORT with the callback offer, no bell', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx } = ctxFor({ writeHandoff: jest.fn().mockRejectedValue(new Error('pool down')) });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx)).toMatch(/could not be started/);
    expect(ctx.writeHandoff).toHaveBeenCalledTimes(2);
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('full write failed, fallback REJECTED (0 rows — ownership lost meanwhile) ⇒ ABORT', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx } = ctxFor({ writeHandoff: jest.fn().mockRejectedValueOnce(new Error('pool down')).mockResolvedValueOnce(0) });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx)).toMatch(/could not be started/);
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
  });

  test('packet write failure with a CONFIRMED no-context stamp ⇒ the transfer proceeds and the bell fires ONCE', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const writeHandoff = jest.fn().mockRejectedValueOnce(new Error('pool down')).mockResolvedValueOnce(1);
    const { ctx } = ctxFor({ writeHandoff });
    await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, ctx);
    expect(writeHandoff).toHaveBeenCalledTimes(2);
    expect(writeHandoff.mock.calls[1][0]).toMatchObject({ context_available: false, summary: null, tools: [] });
    await new Promise((r) => setImmediate(r)); // the bell is detached
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification).toHaveBeenCalledWith('alert', 'Sandy transfer without context', expect.stringContaining('ask the caller to recap'), expect.objectContaining({ dedupeKey: 'sandy_transfer_no_context:CA-tx-1', bell: true, link: '/admin/communications#tab=calls' }));
    expect(ctx.say).toHaveBeenCalled();
    expect(ctx.endForTransfer).toHaveBeenCalledTimes(1);
  });

  test('a 0-row packet write (owner fence / terminal guard refused) ABORTS the transfer — a stale socket never ends the call or rings staff', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx } = ctxFor({ writeHandoff: jest.fn(async () => 0) });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx)).toMatch(/could not be started.*Do NOT try again/s);
    expect(ctx.writeHandoff).toHaveBeenCalledTimes(1);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(ctx.say).not.toHaveBeenCalled();
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
  });

  test('the gate is exact `true` — TRUE / 1 / on stay closed', () => {
    for (const v of ['TRUE', 'True', '1', 'on']) {
      process.env.GATE_VOICE_RELAY_TRANSFER = v;
      expect(transfer.isTransferGateOn()).toBe(false);
    }
  });

  test('a sandbox session transfers (its own row) but never rings the bell', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx } = ctxFor({ sandbox: true, writeHandoff: jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(1) });
    await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(ctx.endForTransfer).toHaveBeenCalledTimes(1);
  });

  test('one transfer per call — a second call is a no-op', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const { ctx } = ctxFor({ transferRequested: () => true });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx)).toMatch(/already in progress/);
    expect(ctx.writeHandoff).not.toHaveBeenCalled();
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
  });
});

describe('the session side (relay-conversation tool ctx)', () => {
  test('handoffFacts is server state; endForTransfer ends once with reason transfer; the latch is per call', () => {
    const endSession = jest.fn();
    const convo = new RelayConversation({ callSid: 'CA-ctx', from: '+19415551234', language: 'es-US', send: jest.fn(), endSession });
    convo._userTurns.push('a', 'b');
    convo._toolOutcomes.push({ name: 'get_pricing', ok: true });
    convo._estimateFields = { first_name: 'Pat' };
    const ctx = convo._buildToolCtx();
    expect(ctx.handoffFacts()).toMatchObject({ verificationTier: 'unverified', from: '+19415551234', language: 'es-US', factsCollected: { first_name: 'Pat' }, tools: [{ name: 'get_pricing', ok: true }], turnCount: 2 });
    convo._callerVerified = true;
    convo._callerContext = { tier: 'full' };
    expect(ctx.handoffFacts().verificationTier).toBe('full');
    expect(ctx.transferRequested()).toBe(false);
    ctx.markTransferRequested();
    expect(ctx.transferRequested()).toBe(true);
    ctx.endForTransfer();
    ctx.endForTransfer();
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'transfer' }));
    expect(convo._ending).toBe(true);
  });

  test('writeHandoff rides the owner fence and never overwrites a terminal outcome — unless the row already carries THIS attempt (codex r2 P1)', async () => {
    const db = require('../models/db');
    const termQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis() };
    const attemptQ = { where: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis() };
    const guardQ = { where: jest.fn((fn) => { fn(termQ); return guardQ; }), orWhere: jest.fn((fn) => { fn(attemptQ); return guardQ; }) };
    const update = jest.fn(async () => [{ context_available: 'true' }]);
    const builder = { update, where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }), whereRaw: jest.fn(() => builder) };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const convo = new RelayConversation({ callSid: 'CA-w', sessionKey: 'nonce-1', from: '+19415551234', send: jest.fn() });
    const res = await convo._buildToolCtx().writeHandoff({ intent: 'x', context_available: true, attempt: 'att-1' });
    expect(res).toEqual({ rows: 1, contextAvailable: true });
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA-w');
    expect(termQ.orWhereNotIn).toHaveBeenCalledWith('call_outcome', ['voicemail', 'relay_failed', 'ai_transferred', 'ai_handled']); // one transfer per CallSid, enforced by the row — and never a CLOSED call (a queued write executing after the hangup)
    // …OR the row is STILL ai_transferred and holds this attempt's packet (a timed-out write that landed):
    // matched, left as-is — a later voicemail outcome is never flipped back (hook P1).
    expect(attemptQ.where).toHaveBeenCalledWith('call_outcome', 'ai_transferred');
    expect(attemptQ.whereRaw).toHaveBeenCalledWith(expect.stringContaining("relay_handoff'->>'attempt'"), ['att-1']);
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), ['nonce-1']);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ call_outcome: 'ai_transferred' }), expect.any(Array));
    const meta = update.mock.calls[0][0].metadata;
    expect(meta.sql).toMatch(/^CASE WHEN .*attempt.* THEN metadata ELSE/);
    expect(meta.bindings[0]).toBe('att-1');
    expect(meta.bindings[1]).toContain('"relay_handoff"');
  });

  test('every packet carries a fresh attempt nonce and the carrier attestation beside the tier (codex r2 P1s)', () => {
    const a = transfer.buildHandoffPacket({ intent: 'x' }, { verificationTier: 'full', callerAttested: true });
    const b = transfer.buildHandoffPacket({ intent: 'x' }, { verificationTier: 'full' });
    expect(a.attempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.attempt).not.toBe(b.attempt);
    expect(a.caller_attested).toBe(true);
    expect(b.caller_attested).toBe(false);
    const convo = new RelayConversation({ callSid: 'CA-att', from: '+19415551234', send: jest.fn() });
    convo._callerVerified = true;
    convo._callerContext = { tier: 'full', attested: true };
    expect(convo._buildToolCtx().handoffFacts()).toMatchObject({ verificationTier: 'full', callerAttested: true });
    convo._callerContext = { tier: 'full' };
    expect(convo._buildToolCtx().handoffFacts().callerAttested).toBe(false);
  });

  test('ai_transferred is terminal for the socket reconcile and handled for the missed-call bell', () => {
    expect(RELAY_TERMINAL_OUTCOMES).toContain('ai_transferred');
    const base = { direction: 'inbound', customer_id: 'c1', answered_by: 'missed', status: 'no-answer', metadata: null };
    expect(missedCallEligible(base)).toBe(true);
    expect(missedCallEligible({ ...base, call_outcome: 'ai_transferred' })).toBe(false);
  });
});

describe('codex r1 follow-ups', () => {
  test('office hours load when the transfer gate is on even with the context gate off (P1)', () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    const off = new RelayConversation({ callSid: 'CA-oh-0', from: '+19415551234', send: jest.fn() });
    expect(off._officeHoursReady).toBeNull();
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const on = new RelayConversation({ callSid: 'CA-oh-1', from: '+19415551234', send: jest.fn() });
    expect(on._officeHoursReady).not.toBeNull();
  });

  test('a caught tool failure is recorded as ok:false (P2)', async () => {
    const ctx = { callSid: 'CA-tf' };
    const out = await executeTool('find_slots', { when: 'tomorrow' }, ctx); // the booking engine is not mocked here ⇒ throws ⇒ caught
    expect(out).toMatch(/Could not look up appointment times/);
    expect(ctx.toolFailed).toBe(true);
  });

  test('the no-context bell is registered as a TECH-VISIBLE trigger key and written deduped per CallSid', () => {
    const { listTriggers, TRIGGER_REGISTRY } = require('../services/notification-triggers');
    expect(listTriggers().some((t) => t.key === 'sandy_transfer_no_context')).toBe(true);
    expect((TRIGGER_REGISTRY || {}).sandy_transfer_no_context?.techVisible).toBe(true);
  });
});

describe('codex r2 follow-ups', () => {
  test('a timed-out full write that LANDED is reconciled by the fallback: transfer proceeds WITH context, no bell (P1)', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const writeHandoff = jest.fn().mockRejectedValueOnce(new Error('pool stalled')).mockResolvedValueOnce({ rows: 1, contextAvailable: true });
    const { ctx } = ctxFor({ writeHandoff });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, ctx)).toMatch(/Transferring the caller/);
    expect(writeHandoff).toHaveBeenCalledTimes(2);
    expect(writeHandoff.mock.calls[1][0].attempt).toBe(writeHandoff.mock.calls[0][0].attempt); // the same nonce — the fallback recognizes its own packet
    await new Promise((r) => setImmediate(r));
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(ctx.endForTransfer).toHaveBeenCalledTimes(1);
  });

  test('a transfer mid-round skips the remaining tools in the SAME response and starts no further model round (P2)', async () => {
    let IsolatedConvo;
    const stream = jest.fn(() => ({
      finalMessage: async () => ({
        content: [
          { type: 'tool_use', id: 't1', name: 'transfer_to_office', input: { intent: 'x' } },
          { type: 'tool_use', id: 't2', name: 'capture_lead', input: { name: 'Pat' } },
        ],
        stop_reason: 'tool_use',
      }),
    }));
    const executeToolMock = jest.fn(async (name, input, ctx) => { if (name === 'transfer_to_office') ctx.endForTransfer(); return 'ok'; });
    jest.isolateModules(() => {
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { return { messages: { stream } }; });
      jest.doMock('../services/voice-agent/relay-tools', () => ({ TOOLS: [], CONTEXT_TOOLS: [], activeTools: () => [], executeTool: executeToolMock }));
      IsolatedConvo = require('../services/voice-agent/relay-conversation').RelayConversation;
    });
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-mid', from: '+19415551234', send: jest.fn(), endSession });
    await convo._runLoop('transfer me').catch(() => {});
    expect(stream).toHaveBeenCalledTimes(1);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock.mock.calls[0][0]).toBe('transfer_to_office');
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'transfer' }));
    const last = convo.messages[convo.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content.map((r) => r.tool_use_id)).toEqual(['t1', 't2']); // the history stays well-formed
    expect(last.content[1].content).toMatch(/Not run/);
  });

  test('a transferred row\'s salvaged transcript still records Sandy\'s commitments; a relay_failed salvage does not (P2)', async () => {
    const db = require('../models/db');
    const calls = [];
    const builder = {
      where: jest.fn(() => builder), whereIn: jest.fn(() => builder), whereNull: jest.fn(() => builder), orWhereNotIn: jest.fn(() => builder),
      whereRaw: jest.fn(() => builder), whereNotIn: jest.fn(() => builder), first: jest.fn(async () => null), select: jest.fn(() => builder),
      update: jest.fn(async (patch) => { calls.push(patch); return calls.length === 1 ? 0 : 1; }), // reconcile: 0 rows (terminal); salvage: 1
    };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => undefined) }));
    const recordRelayCommitments = jest.fn(async () => ({ found: true, written: 1 }));
    jest.doMock('../services/call-commitments', () => ({ recordRelayCommitments }));
    for (const [transferRequested, expectedCalls] of [[true, 1], [false, 0]]) {
      calls.length = 0; recordRelayCommitments.mockClear();
      const convo = new RelayConversation({ callSid: 'CA-sal', sessionKey: 'nonce-s', from: '+19415551234', send: jest.fn() });
      convo._transferRequested = transferRequested;
      convo.leadCaptured = true; // the capture floor is not under test
      convo._recordTurn('user', 'I want to cancel');
      convo._recordTurn('agent', 'Someone will call you back today.');
      await convo.end('transfer');
      expect(recordRelayCommitments).toHaveBeenCalledTimes(expectedCalls);
    }
    jest.dontMock('../config/feature-gates');
    jest.dontMock('../services/call-commitments');
  });
});

describe('pre-push hook round 9', () => {
  test('a card number in the model\'s summary never reaches the packet or the whisper (P0)', () => {
    const packet = transfer.buildHandoffPacket({ intent: 'pay by card 4111 1111 1111 1111 please', summary: 'card 4242424242424242 exp 12/28', unresolved_question: 'charge 5555 5555 5555 4444 now', caller_name: 'Pat 4111 1111 1111 1111' }, { verificationTier: 'full' });
    expect(packet.caller_name).not.toMatch(/\d(?:[ -]?\d){11,}/); // hook round 11 P0: the name field is model text too
    const PAN = /\d(?:[ -]?\d){11,}/; // the scrubber keeps "card ending 4242" — only the full number must be gone
    for (const field of ['intent', 'summary', 'unresolved_question']) {
      expect(packet[field]).not.toMatch(PAN);
      expect(packet[field]).toMatch(/card ending/);
    }
    expect(transfer.transferWhisper({ ...packet, context_available: true })).not.toMatch(PAN);
    expect(transfer.transferWhisper({ ...packet, context_available: true })).toMatch(/Sandy transfer/);
  });

  test('both writes time out ⇒ abort; a timed-out UPDATE that lands LATER is reverted (P1)', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    jest.useFakeTimers();
    let settleFull;
    const full = new Promise((r) => { settleFull = r; });
    const writeHandoff = jest.fn().mockReturnValueOnce(full).mockReturnValueOnce(new Promise(() => {}));
    const revertHandoff = jest.fn(async () => 1);
    const { ctx } = ctxFor({ writeHandoff, revertHandoff });
    const p = executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx);
    await jest.advanceTimersByTimeAsync(4000 + 1500 + 10);
    expect(await p).toMatch(/could not be started/);
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
    expect(revertHandoff).not.toHaveBeenCalled();
    settleFull({ rows: 1, contextAvailable: true }); // the pool recovered — the stamp landed after the abort
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(revertHandoff).toHaveBeenCalledWith(writeHandoff.mock.calls[0][0].attempt);
  });

  test('revertHandoffPacket undoes only THIS attempt on an un-rung ai_transferred row; the tool ctx wires it', async () => {
    const db = require('../models/db');
    const update = jest.fn(async () => 1);
    const builder = { update, where: jest.fn(() => builder), whereRaw: jest.fn(() => builder) };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const convo = new RelayConversation({ callSid: 'CA-rv', sessionKey: 'nonce-1', from: '+19415551234', send: jest.fn() });
    expect(await convo._buildToolCtx().revertHandoff('att-9')).toBe(1);
    expect(builder.where).toHaveBeenCalledWith('call_outcome', 'ai_transferred');
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining("relay_handoff'->>'attempt'"), ['att-9']);
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_transfer_ring_at'));
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), ['nonce-1']);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ call_outcome: expect.objectContaining({ sql: expect.stringMatching(/CASE WHEN status = 'completed' THEN 'ai_handled' ELSE NULL END/) }), metadata: expect.objectContaining({ sql: "metadata - 'relay_handoff'" }) }));
  });

  test('the recording processor gates the RECORDED segment of a composite against the recording length, never the AI segment too (P1)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('recordedSegmentText = text; // the hallucination guard below measures THIS against the recording, never the composite');
    expect(src).toContain('const gateText = recordedSegmentText || transcription;');
    expect(src).toContain('let fallbackImplausible = transcription && isImplausibleTranscript(gateText, recordingSeconds);');
    // Every fallback path composes through the same closure and reads only the recorded part (hook round 11 P1).
    expect(src.match(/transcription = await composeRelay\(transcription, transcriptionProvenance\);/g)).toHaveLength(3);
    expect(src).toContain("const fresh = await db('call_log').where({ id: call.id }).first('metadata', 'call_outcome', 'transcription', 'transcription_provider', 'transcription_metadata');"); // composed from the CURRENT row, not the claim snapshot
    // …and when the stash had NOT landed at compose time on a transfer-marked row, every transcript write composes INSIDE the UPDATE
    // from the row's metadata and reads the written value back (a stash landing between the read and the write is still composed).
    expect(src.includes('relayPending = transferred;')).toBe(true); // …and on every write of a reconnected call (PR 2B)
    expect(src.match(/await writeTranscript\(/g)).toHaveLength(4); // primary, both fallbacks, and the relay-only rejection write
    expect(src).toMatch(/CASE WHEN \? IS NOT NULL THEN '\[AI segment\]' \|\| E'\\\\n' \|\| \? \|\| .*\|\| \?::text ELSE \?::text END/); // the relay text = the stash, else the segments (PR 2B), composed inside the UPDATE
    expect(src.includes("COALESCE(NULLIF(metadata->'relay_transcript'->>'text', ''), ?, CASE WHEN transcription_provider = ? THEN NULLIF(transcription, '') END)")).toBe(true);
    expect(src).toContain("}, ['transcription']);");
    expect(src).toContain("const freshRecorded = recordedFallbackOf(freshCall);");
    expect(src).toContain("} else if (recordedFallbackOf(call)) {");
    expect(src).toContain("if (row.transcription_provider === RELAY_TRANSCRIPTION_PROVIDER) return null;");
    expect(src).toContain('return isUsableFallback(recorded) ? recorded : null;'); // a rejected recorded leg (the sentinel) is no fallback either
    // A hallucinated RECORDED leg on a transferred call rejects that segment only: the AI segment stays, and the
    // whole-call rejection (voicemail sentinel, triage dismissal, CallSid-keyed lead retirement) never runs (hook P1).
    const relayOnlyAt = src.indexOf('const relayState = recordedRejected ? await currentRelayState() : null;'); // decided on the CURRENT row, not the claim snapshot
    const wholeCallAt = src.indexOf('if (fallbackImplausible || (!transcription && primaryTranscriptRejected)) {');
    expect(relayOnlyAt).toBeGreaterThan(0);
    expect(relayOnlyAt).toBeLessThan(wholeCallAt);
    const site = src.slice(relayOnlyAt, wholeCallAt);
    expect(site).toContain("if (!wroteRelayOnly) return abandonToPeer('the relay-only transcript write');");
    expect(site).toContain('relayPending = true;'); // a still-pending AI text — or any reconnected call — is composed inside this UPDATE (PR 2B)
    expect(site).toContain('recordedSegmentText = null; // the write composes around the BARE sentinel, never the rejected text');
    expect(site).toContain('transcription = TRANSCRIPTION_REJECTED_SENTINEL;'); // …onto the BARE sentinel — the header is added exactly once by composition
    expect(site).toContain('fallbackImplausible = false;');
    expect(site).toContain('primaryTranscriptRejected = false;');
    expect(site).toContain('recorded_segment_rejected');
    expect(site).toContain('if (relayOnly || (relayState && relayState.transferred)) {'); // transfer evidence without relay text yet ⇒ still never the whole-call rejection
  });

  test('recordedPartOfComposite: the relay\'s own transcript and a bare AI segment are not recording transcripts; a stored composite yields its recorded part', () => {
    const { recordedPartOfComposite } = require('../services/call-recording-processor')._test;
    expect(recordedPartOfComposite('Hello, this is Sandy.')).toBe('Hello, this is Sandy.');
    expect(recordedPartOfComposite('[AI segment]\nSandy: hi\nCaller: transfer me')).toBeNull();
    expect(recordedPartOfComposite('[AI segment]\nSandy: hi\n\n[Staff segment]\nAdam: Waves, this is Adam.')).toBe('Adam: Waves, this is Adam.');
    expect(recordedPartOfComposite('[AI segment]\nSandy: hi\n\n[Voicemail segment]\nPlease call me back.')).toBe('Please call me back.');
    expect(recordedPartOfComposite('')).toBeNull();
  });

  test('voicemail won the close race: the AI segment is stashed metadata-only on the transfer-marked voicemail row (P1)', async () => {
    const db = require('../models/db');
    const updates = [];
    const builder = {
      where: jest.fn(() => builder), whereIn: jest.fn(() => builder), whereNull: jest.fn(() => builder), orWhereNotIn: jest.fn(() => builder),
      whereRaw: jest.fn(() => builder), whereNotIn: jest.fn(() => builder), first: jest.fn(async () => null), select: jest.fn(() => builder),
      update: jest.fn(async (patch) => { updates.push(patch); return updates.length === 3 ? 1 : 0; }), // reconcile 0, terminal salvage 0, voicemail stash 1
    };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const convo = new RelayConversation({ callSid: 'CA-vm', sessionKey: 'nonce-v', from: '+19415551234', send: jest.fn() });
    convo._transferRequested = true;
    convo.leadCaptured = true;
    convo._recordTurn('user', 'transfer me');
    convo._recordTurn('agent', 'Transferring you now.');
    await convo.end('transfer');
    expect(updates).toHaveLength(3);
    expect(builder.whereIn).toHaveBeenCalledWith('call_outcome', ['voicemail', 'ai_transferred']); // …or a transferred row whose recording was already processed
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining("relay_handoff') IS NOT NULL"));
    // The column salvage itself only takes an ai_transferred row whose columns are still Sandy's (provider NULL / conversation_relay).
    const src = require('fs').readFileSync(require.resolve('../services/voice-agent/relay-conversation'), 'utf8');
    expect(builder.whereRaw).toHaveBeenCalledWith("(call_outcome = 'relay_failed' OR transcription_provider IS NULL OR transcription_provider = ?)", ['conversation_relay']);
    // The recording owns the columns — unless the processor already wrote the recorded leg ALONE (it read the row
    // before this stash): then the AI segment is prepended in the same statement (codex r6 P1); a composite / empty
    // column / Sandy's own transcript is left as it is.
    expect(updates[2].transcription.sql).toMatch(/^CASE WHEN \(transcription IS NOT NULL AND transcription <> '' AND transcription NOT LIKE '\[AI segment\]%' AND transcription_provider IS DISTINCT FROM 'conversation_relay'\) THEN \? \|\| E'\\n\\n\[' \|\| CASE WHEN call_outcome = 'voicemail' THEN 'Voicemail' ELSE 'Staff' END \|\| E' segment\]\\n' \|\| transcription ELSE transcription END$/);
    expect(updates[2].transcription.bindings[0]).toMatch(/^\[AI segment\]\n/);
    expect(updates[2].transcript_structured.sql).toMatch(/THEN NULL ELSE transcript_structured END$/);
    expect(updates[2].metadata.bindings[0]).toContain('"relay_transcript"');
    const logger = require('../services/logger');
    expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('transcript NOT persisted'));
  });
});

describe('codex r3 follow-ups', () => {
  test('the caller hung up while the packet write was in flight ⇒ the stamp is reverted and the transfer aborts without an end frame (P1)', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    let ended = false;
    const writeHandoff = jest.fn(async () => { ended = true; return { rows: 1, contextAvailable: true }; }); // the socket closes mid-write
    let reverted = false;
    const revertHandoff = jest.fn(async () => { await new Promise((r) => setTimeout(r, 20)); reverted = true; return 1; });
    const { ctx } = ctxFor({ writeHandoff, revertHandoff, sessionEnded: () => ended });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx)).toMatch(/call has ended/);
    expect(reverted).toBe(true); // AWAITED: end()'s reconcile (which resumes when the tool returns) sees the reverted row
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(revertHandoff).toHaveBeenCalledWith(writeHandoff.mock.calls[0][0].attempt);
    expect(ctx.say).not.toHaveBeenCalled();
    expect(ctx.endForTransfer).not.toHaveBeenCalled();
    // Full write timed out, fallback confirmed, THEN the hangup: the pending full write is cleaned up when it lands too.
    jest.useFakeTimers();
    let settleFull; const full = new Promise((r) => { settleFull = r; });
    let ended2 = false;
    const wh2 = jest.fn().mockReturnValueOnce(full).mockImplementationOnce(async () => { ended2 = true; return { rows: 1, contextAvailable: false }; });
    const rv2 = jest.fn(async () => 1);
    const { ctx: ctx2 } = ctxFor({ writeHandoff: wh2, revertHandoff: rv2, sessionEnded: () => ended2 });
    const p2 = executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx2);
    await jest.advanceTimersByTimeAsync(4010);
    expect(await p2).toMatch(/call has ended/);
    await jest.advanceTimersByTimeAsync(0);
    expect(triggerNotification).not.toHaveBeenCalled(); // the no-context stamp landed, but the transfer was abandoned ⇒ no bell (codex r4 P2)
    settleFull({ rows: 1, contextAvailable: true });
    await jest.advanceTimersByTimeAsync(0);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(rv2).toHaveBeenCalledTimes(2); // the current stamp, then the late full write
    expect(ctx2.endForTransfer).not.toHaveBeenCalled();
    const convo = new RelayConversation({ callSid: 'CA-se', from: '+19415551234', send: jest.fn() });
    const tctx = convo._buildToolCtx();
    expect(tctx.sessionEnded()).toBe(false);
    convo.ended = true;
    expect(tctx.sessionEnded()).toBe(true);
  });
});

describe('codex r5 follow-ups', () => {
  test('the end frame was NOT sent (socket closing / send threw) ⇒ the stamp is reverted and the tool refuses; endForTransfer reports it (P1)', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const revertHandoff = jest.fn(async () => 1);
    const { ctx } = ctxFor({ endForTransfer: jest.fn(() => false), revertHandoff });
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx)).toMatch(/could not be started/);
    expect(revertHandoff).toHaveBeenCalledWith(ctx.writeHandoff.mock.calls[0][0].attempt);
    await new Promise((r) => setImmediate(r));
    expect(triggerNotification).not.toHaveBeenCalled();
    // The session side: endSession false ⇒ not ending, returns false; a reporting-nothing endSession counts as sent.
    const closing = new RelayConversation({ callSid: 'CA-cl', from: '+19415551234', send: jest.fn(), endSession: jest.fn(() => false) });
    expect(closing._buildToolCtx().endForTransfer()).toBe(false);
    expect(closing._ending).toBe(false);
    const ok = new RelayConversation({ callSid: 'CA-ok', from: '+19415551234', send: jest.fn(), endSession: jest.fn() });
    expect(ok._buildToolCtx().endForTransfer()).toBe(true);
    expect(ok._ending).toBe(true);
    expect(ok._buildToolCtx().endForTransfer()).toBe(false); // once
  });

  test('writeHandoffPacket refuses a call /call-status already closed (status terminal, outcome NULL) (P1)', async () => {
    const db = require('../models/db');
    const termQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis() };
    const attemptQ = { where: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis() };
    const guardQ = { where: jest.fn((fn) => { fn(termQ); return guardQ; }), orWhere: jest.fn((fn) => { fn(attemptQ); return guardQ; }) };
    const builder = { update: jest.fn(async () => []), where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }), whereRaw: jest.fn(() => builder) };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    await transfer.writeHandoffPacket(db, { callSid: 'CA-st', packet: { attempt: 'a' }, terminal: ['voicemail'] });
    expect(builder.whereRaw).toHaveBeenCalledWith("(status IS NULL OR status NOT IN ('completed', 'failed', 'busy', 'no-answer', 'canceled'))");
  });

  test('the CSR coach is skipped when the recorded leg was rejected (P1)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('const csrTranscript = recordedPartOfComposite(transcription) || transcription;');
    expect(src).toContain("if (csrTranscript && csrTranscript.length > 50 && csrTranscript !== TRANSCRIPTION_REJECTED_SENTINEL) {"); // the length gate reads the HUMAN leg (codex r6 P1)
    expect(src).toContain('transcript: csrTranscript,');
  });
});

describe('whisper + AI segment', () => {
  test('≤20 words, sanitized, from the packet only', () => {
    const w = transfer.transferWhisper({ context_available: true, caller_name: 'Pat "Doe" <b>', intent: 'cancel service', unresolved_question: 'refund for June and the extra visit last week please' });
    expect(w.split(' ').length).toBeLessThanOrEqual(20);
    expect(w).toMatch(/^Sandy transfer from Pat Doe b: cancel service; refund/);
    expect(w).not.toMatch(/[<>"]/);
    expect(w.endsWith('.')).toBe(true);
  });
  test('falls back to the screen name, then to an unknown number', () => {
    expect(transfer.transferWhisper({ context_available: true, intent: 'wants a person' }, 'Sam Roe')).toBe('Sandy transfer from Sam Roe: wants a person.');
    expect(transfer.transferWhisper({ context_available: true, intent: 'wants a person' })).toBe('Sandy transfer from an unknown number: wants a person.');
  });
  test('no context ⇒ the generic line', () => {
    const generic = 'Sandy transfer. The caller requested assistance; the summary was unavailable.';
    expect(transfer.transferWhisper({ context_available: false, intent: 'x' })).toBe(generic);
    expect(transfer.transferWhisper(null)).toBe(generic);
  });
  test('composeRelaySegment keeps the relay transcript for any row carrying the persisted packet — including the no-answer voicemail fallback', () => {
    const row = { call_outcome: 'ai_transferred', metadata: JSON.stringify({ relay_handoff: { context_available: true } }), transcription_provider: 'conversation_relay', transcription: 'Caller: hi\nSandy: hello', transcription_metadata: JSON.stringify({ provider: 'conversation_relay', latency: { p50: 1 } }) };
    expect(transfer.composeRelaySegment(row)).toEqual({ text: '[AI segment]\nCaller: hi\nSandy: hello', metadata: { provider: 'conversation_relay', latency: { p50: 1 } } });
    expect(transfer.composeRelaySegment({ ...row, call_outcome: 'voicemail' })).not.toBeNull(); // nobody pressed 1 ⇒ voicemail, AI segment survives
    expect(transfer.composeRelaySegment({ ...row, metadata: { relay_handoff: { context_available: false } } })).not.toBeNull();
    expect(transfer.composeRelaySegment({ ...row, metadata: {} })).toBeNull(); // an ordinary relay call: the processor path is unchanged
    expect(transfer.composeRelaySegment({ ...row, metadata: { relay_transfer_ring_at: '2026-09-05T00:00:00Z' } })).not.toBeNull(); // both packet writes failed, the ring claim still marks the transfer
    // The recording-status swap cleared the transcript columns: the metadata copy end() stashed still rebuilds the segment (P1).
    const swapped = { call_outcome: 'voicemail', transcription: null, transcription_provider: null, transcription_metadata: null, metadata: { relay_handoff: { context_available: true }, relay_transcript: { text: 'Caller: hi\nSandy: hello', metadata: { provider: 'conversation_relay' } } } };
    expect(transfer.composeRelaySegment(swapped)).toEqual({ text: '[AI segment]\nCaller: hi\nSandy: hello', metadata: { provider: 'conversation_relay' } });
    expect(transfer.composeRelaySegment({ ...row, transcription_provider: 'openai' })).toBeNull();
    expect(transfer.composeRelaySegment({ ...row, transcription: '' })).toBeNull();
  });

  test('the packet + fallback deadlines fit strictly inside the 8s write-tool budget (a hung pool settles as an abort, not a late end frame)', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    jest.useFakeTimers();
    const never = () => new Promise(() => {});
    const { ctx } = ctxFor({ writeHandoff: jest.fn(never) });
    const p = executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, ctx);
    await jest.advanceTimersByTimeAsync(7000);
    const out = await p;
    jest.useRealTimers();
    expect(out).toMatch(/could not be started/);
    expect(ctx.endForTransfer).not.toHaveBeenCalled(); // settled before the outer 8s deadline, and nothing ended the call
    // Worst case with the abandoned-transfer revert: full write hangs (4s), fallback confirms, the socket has closed, the revert hangs (1.5s) ⇒ still < 8s.
    jest.useFakeTimers();
    let ended = false;
    const wh = jest.fn().mockImplementationOnce(never).mockImplementationOnce(async () => { ended = true; return 1; });
    const { ctx: c2 } = ctxFor({ writeHandoff: wh, revertHandoff: jest.fn(never), sessionEnded: () => ended });
    const p2 = executeTool('transfer_to_office', { intent: 'cancel', summary: 'x' }, c2);
    await jest.advanceTimersByTimeAsync(7000);
    expect(await p2).toMatch(/call has ended/);
    jest.useRealTimers();
    expect(c2.endForTransfer).not.toHaveBeenCalled();
  });
});

// Exercise the production reader closure without starting the recording
// pipeline's external transcription/notification work.
describe('recording rejection needs evidence beyond a reconnect attempt', () => {
  test.each([
    [{ relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 500 }, false],
    [{ relay_reconnects: 1 }, false],
    [{ relay_reconnects: 1, relay_reconnect_ms: 777, relay_session_claim_gen: 900 }, true],
    [{ relay_reconnects: 1, relay_transcript: { text: 'Caller: Please help with pests.' } }, true],
    [{ relay_handoff: { intent: 'office' } }, true],
  ])('metadata %j enables the rejection exception: %s', async (metadata, expected) => {
    const source = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const start = source.indexOf('const currentRelayState = async () => {');
    const end = source.indexOf('\n    };', start) + '\n    };'.length;
    const call = { id: 'call-evidence', call_outcome: 'voicemail', metadata };
    const db = () => ({ where: () => ({ first: async () => call }) });
    const state = await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return currentRelayState(); })()`, {
      call, db, composeRelaySegment: transfer.composeRelaySegment,
    });
    expect(state.transferred).toBe(expected);
  });
});
