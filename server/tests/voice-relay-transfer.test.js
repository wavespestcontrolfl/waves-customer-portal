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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || '').slice(-4) }));

const { triggerNotification } = require('../services/notification-triggers');
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
    expect(buildBasePrompt(false, null, { officeOpen: null })).toContain('office closed');
    expect(buildBasePrompt(false, null, { officeOpen: null })).not.toContain('transfer_to_office');
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
    expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, ctx)).toMatch(/office is closed.*capture_lead/s);
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    for (const officeOpen of [false, null]) {
      const { ctx: c } = ctxFor({ officeOpenNow: () => officeOpen });
      expect(await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, c)).toMatch(/office is closed/);
      expect(c.endForTransfer).not.toHaveBeenCalled();
    }
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

  test('packet write failure ⇒ the transfer still proceeds, a no-context stamp is attempted, and the bell fires ONCE', async () => {
    process.env.GATE_VOICE_RELAY_TRANSFER = 'true';
    const writeHandoff = jest.fn().mockRejectedValueOnce(new Error('pool down')).mockResolvedValueOnce(1);
    const { ctx } = ctxFor({ writeHandoff });
    await executeTool('transfer_to_office', { intent: 'cancel', summary: 'wants out' }, ctx);
    expect(writeHandoff).toHaveBeenCalledTimes(2);
    expect(writeHandoff.mock.calls[1][0]).toMatchObject({ context_available: false, summary: null, tools: [] });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification).toHaveBeenCalledWith('sandy_transfer_no_context', expect.objectContaining({ callSid: 'CA-tx-1' }));
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

  test('writeHandoff rides the owner fence and never overwrites a terminal outcome', async () => {
    const db = require('../models/db');
    const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis() };
    const update = jest.fn(async () => 1);
    const builder = { update, where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }), whereRaw: jest.fn(() => builder) };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const convo = new RelayConversation({ callSid: 'CA-w', sessionKey: 'nonce-1', from: '+19415551234', send: jest.fn() });
    const rows = await convo._buildToolCtx().writeHandoff({ intent: 'x', context_available: true });
    expect(rows).toBe(1);
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA-w');
    expect(guardQ.orWhereNotIn).toHaveBeenCalledWith('call_outcome', ['voicemail', 'relay_failed']); // ai_transferred itself may be re-stamped
    expect(builder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('relay_session_claim_owner'), ['nonce-1']);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ call_outcome: 'ai_transferred' }));
    expect(update.mock.calls[0][0].metadata.bindings[0]).toContain('"relay_handoff"');
  });

  test('ai_transferred is terminal for the socket reconcile and handled for the missed-call bell', () => {
    expect(RELAY_TERMINAL_OUTCOMES).toContain('ai_transferred');
    const base = { direction: 'inbound', customer_id: 'c1', answered_by: 'missed', status: 'no-answer', metadata: null };
    expect(missedCallEligible(base)).toBe(true);
    expect(missedCallEligible({ ...base, call_outcome: 'ai_transferred' })).toBe(false);
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
  test('composeRelaySegment keeps the relay transcript ahead of the staff leg only for a transferred relay row', () => {
    const row = { call_outcome: 'ai_transferred', transcription_provider: 'conversation_relay', transcription: 'Caller: hi\nSandy: hello', transcription_metadata: JSON.stringify({ provider: 'conversation_relay', latency: { p50: 1 } }) };
    expect(transfer.composeRelaySegment(row)).toEqual({ text: '[AI segment]\nCaller: hi\nSandy: hello', metadata: { provider: 'conversation_relay', latency: { p50: 1 } } });
    expect(transfer.composeRelaySegment({ ...row, call_outcome: 'ai_handled' })).toBeNull();
    expect(transfer.composeRelaySegment({ ...row, transcription_provider: 'openai' })).toBeNull();
    expect(transfer.composeRelaySegment({ ...row, transcription: '' })).toBeNull();
  });
});
