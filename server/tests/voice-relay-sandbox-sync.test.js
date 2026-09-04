/**
 * A voice-agent sandbox call (call_log.source='voice_relay_sandbox') is a
 * test record: the unified-message sync must return before it opens a
 * transaction, so no inbox thread and no message row ever exist for it.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const state = { row: null };
  const first = jest.fn(() => Promise.resolve(state.row));
  const fn = jest.fn(() => ({ where: jest.fn(() => ({ first })) }));
  fn.transaction = jest.fn(() => { throw new Error('must not open a transaction for a sandbox row'); });
  fn.__state = state;
  fn.__first = first;
  return fn;
});

const db = require('../models/db');
const { syncVoiceMessageForCall } = require('../services/conversations');
const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

test('syncVoiceMessageForCall returns null for a sandbox row — the row is read, no transaction opens', async () => {
  db.__state.row = { twilio_call_sid: 'CA-sb-12', source: VOICE_RELAY_SANDBOX_SOURCE, direction: 'inbound' };
  await expect(syncVoiceMessageForCall('CA-sb-12')).resolves.toBeNull();
  expect(db.__first).toHaveBeenCalledTimes(1);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('a production row still reaches the transaction (the guard is source-specific)', async () => {
  db.__state.row = { twilio_call_sid: 'CA-prod-12', source: null, direction: 'inbound' };
  // The throwing transaction mock is caught by the sync's own try/catch and
  // surfaces as null — what matters is that the transaction WAS attempted.
  await syncVoiceMessageForCall('CA-prod-12');
  expect(db.transaction).toHaveBeenCalledTimes(1);
});
