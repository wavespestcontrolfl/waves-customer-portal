/**
 * RelayConversation lifecycle — explicit end-of-call after capture.
 *
 * After the agent captures the lead and delivers its closing line, the relay
 * must proactively end the ConversationRelay session (send the end frame) so the
 * caller isn't left in silence until they hang up. These cover the decision
 * (_maybeEndAfterTurn) and that no new turn is started once the session is ending.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const db = require('../models/db');

describe('RelayConversation — explicit end after capture', () => {
  test('_maybeEndAfterTurn ends the session once, only after a lead is captured', () => {
    const endSession = jest.fn();
    const convo = new RelayConversation({ callSid: 'CA1', from: '+19415551234', send: jest.fn(), endSession });

    // No lead captured yet → do NOT end (caller is still mid-conversation).
    convo._maybeEndAfterTurn();
    expect(endSession).not.toHaveBeenCalled();
    expect(convo._ending).toBe(false);

    // Lead captured + agent finished its turn → end the session once.
    convo.leadCaptured = true;
    convo._maybeEndAfterTurn();
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ captured: true }));
    expect(convo._ending).toBe(true);

    // Idempotent — never send a second end frame.
    convo._maybeEndAfterTurn();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  test('no end frame when no endSession callback was provided (TwiML-Bin sandbox)', () => {
    const convo = new RelayConversation({ callSid: 'CA1', from: '+19415551234', send: jest.fn() });
    convo.leadCaptured = true;
    expect(() => convo._maybeEndAfterTurn()).not.toThrow();
    expect(convo._ending).toBe(false); // nothing to end through
  });

  test('a new caller prompt is ignored once the session is ending', () => {
    const convo = new RelayConversation({ callSid: 'CA1', from: '+19415551234', send: jest.fn(), endSession: jest.fn() });
    convo.leadCaptured = true;
    convo._maybeEndAfterTurn();
    const chainBefore = convo._chain;
    const ret = convo.handlePrompt('are you still there?');
    expect(ret).toBe(chainBefore); // early-returned the existing chain; no new turn queued
  });

  test('end() reconcile stamps ai_handled but yields to a relay-failure voicemail', async () => {
    // The /relay-complete failure path stamps call_outcome='voicemail'. end()
    // runs on every WS close and must NOT clobber that with 'ai_handled'. But the
    // handoff clears call_outcome to NULL before a SUCCESSFUL session, so the
    // guard must match NULL too (NULL <> 'voicemail' is NULL in SQL) — else
    // successful calls never finalize. Verify the guard is "NULL OR not voicemail".
    const update = jest.fn().mockResolvedValue(1);
    const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNot: jest.fn().mockReturnThis() };
    const builder = {
      update,
      where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
    };
    db.mockReturnValue(builder);

    const convo = new RelayConversation({ callSid: 'CA9', from: '+19415551234', send: jest.fn() });
    convo.leadCaptured = true; // skip the capture-floor lead write
    await convo.end('hangup');

    expect(db).toHaveBeenCalledWith('call_log');
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA9');
    // the guard callback ran whereNull('call_outcome') OR orWhereNot(...,'voicemail')
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(guardQ.orWhereNot).toHaveBeenCalledWith('call_outcome', 'voicemail');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', answered_by: 'ai_agent', call_outcome: 'ai_handled',
    }));
  });

  // ⭐ The recent-texts block is customer-AUTHORED SMS text. It rides the USER
  // role, never `system`, and is seeded exactly once, ahead of the caller's
  // first turn, as a user/assistant pair so roles still strictly alternate.
  test('recent-texts data turn is seeded into the USER role, once, before the caller turn', async () => {
    const convo = new RelayConversation({ callSid: 'CA5', from: '+19415551234', send: jest.fn() });
    convo._callerContext = {
      customer: { id: 'c-1', first_name: 'Pat' },
      tier: 'full',
      block: 'KNOWN CALLER ...',
      dataTurn: '<<<RECENT TEXTS DATA\nCustomer: the ants are back\nEND RECENT TEXTS DATA>>>',
    };
    convo.messages.push({ role: 'user', content: 'hi there' });
    // Drive only the seeding half of _runLoop (no Anthropic client in tests).
    await convo._runLoop().catch(() => {});

    expect(convo.messages[0]).toEqual({ role: 'user', content: convo._callerContext.dataTurn });
    expect(convo.messages[1].role).toBe('assistant');
    expect(convo.messages[2]).toEqual({ role: 'user', content: 'hi there' });
    // Roles alternate — the API rejects two consecutive same-role messages.
    for (let i = 1; i < convo.messages.length; i++) {
      expect(convo.messages[i].role).not.toBe(convo.messages[i - 1].role);
    }

    // Seeded ONCE, however many turns follow.
    await convo._runLoop().catch(() => {});
    expect(convo.messages.filter((m) => m.content === convo._callerContext.dataTurn)).toHaveLength(1);
  });

  // The tool ctx is rebuilt EVERY turn; the lookup budget must not be, or a
  // caller gets a fresh three lookups per turn.
  test('the lookup budget is SESSION-scoped, not per-turn', () => {
    const { LOOKUP_SESSION_BUDGET } = require('../services/voice-agent/relay-context');
    const convo = new RelayConversation({ callSid: 'CA6', from: '+19415551234', send: jest.fn() });
    const grants = [];
    for (let turn = 0; turn < LOOKUP_SESSION_BUDGET + 2; turn++) {
      grants.push(convo._buildToolCtx().consumeLookup()); // a NEW ctx each turn
    }
    expect(grants.filter(Boolean)).toHaveLength(LOOKUP_SESSION_BUDGET);
    expect(grants.slice(LOOKUP_SESSION_BUDGET)).toEqual([false, false]);
  });

  // Contact-slot recognition must never reach the ctx as 'full'.
  test('customerTier on the tool ctx mirrors the ANI match column, failing closed', () => {
    const convo = new RelayConversation({ callSid: 'CA7', from: '+19415551234', send: jest.fn() });
    expect(convo._buildToolCtx().customerTier).toBe('redacted'); // unknown caller
    convo._callerContext = { customer: { id: 'c-1' }, tier: 'redacted' };
    expect(convo._buildToolCtx().customerTier).toBe('redacted');
    convo._callerContext = { customer: { id: 'c-1' } }; // tier missing entirely
    expect(convo._buildToolCtx().customerTier).toBe('redacted');
    convo._callerContext = { customer: { id: 'c-1' }, tier: 'full' };
    expect(convo._buildToolCtx().customerTier).toBe('full');
  });
});
