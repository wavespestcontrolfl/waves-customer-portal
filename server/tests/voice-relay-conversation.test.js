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
});
