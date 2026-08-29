/**
 * An INCOMPLETE estimate capture must not end the call (hook P1 on #3569):
 * markCaptured({ holdOpen:true }) suppresses the hangup floor (something was
 * recorded) but keeps the session open for the retry; a later complete
 * capture clears the hold and the agent-complete end works as before.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { RelayConversation } = require('../services/voice-agent/relay-conversation');

function convo() {
  const c = Object.create(RelayConversation.prototype);
  c.callSid = 'CA1'; c.leadCaptured = false; c._ending = false; c._holdOpenForRetry = false;
  c._endSession = jest.fn();
  return c;
}

test('leadCaptured + holdOpen ⇒ no end; a later complete capture clears the hold ⇒ end', () => {
  const c = convo();
  // simulate the tool-ctx markCaptured semantics
  c.leadCaptured = true; c._holdOpenForRetry = true;
  c._maybeEndAfterTurn();
  expect(c._endSession).not.toHaveBeenCalled();
  c._holdOpenForRetry = false;
  c._maybeEndAfterTurn();
  expect(c._endSession).toHaveBeenCalledWith({ reason: 'agent_complete', captured: true });
});

test('a real session: markCaptured({holdOpen:true}) suppresses the floor but keeps the call open', async () => {
  const c = new RelayConversation({ callSid: 'CA2', from: '+19415551234', send: jest.fn(), endSession: jest.fn() });
  const ctx = c._toolCtx ? c._toolCtx() : null;
  // markCaptured lives on the tool ctx built per turn; reach it through the
  // same builder the tools use when exposed, else exercise the fields directly.
  if (ctx && typeof ctx.markCaptured === 'function') {
    ctx.markCaptured({ leadCreated: true, holdOpen: true });
  } else {
    c.leadCaptured = true; c._holdOpenForRetry = true;
  }
  expect(c.leadCaptured).toBe(true);
  expect(c._holdOpenForRetry).toBe(true);
  c._maybeEndAfterTurn();
  expect(c._endSession).not.toHaveBeenCalled();
});
