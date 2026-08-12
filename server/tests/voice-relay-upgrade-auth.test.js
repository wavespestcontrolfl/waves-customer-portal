/**
 * Voice-relay WebSocket UPGRADE AUTH.
 *
 * The /ws/voice-agent endpoint is public: it spends Anthropic tokens and writes
 * leads, so what it accepts at the door is the whole security boundary. It used
 * to accept the raw VOICE_RELAY_WS_SECRET as a reusable `key` query param —
 * one static string, in a URL, that Twilio writes to its own logs — which made
 * every leaked URL a permanent key to unlimited synthetic sessions.
 *
 * These tests pin what replaced it:
 *   - a token minted for ONE CallSid, verified before handleUpgrade;
 *   - the raw secret is never accepted, in any param;
 *   - one session per token (replay of a live URL is refused);
 *   - and the path scoping that lets Socket.io keep its own upgrades — asserted
 *     by the socket being left completely untouched, which is the only thing
 *     that makes coexistence safe.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockHandleUpgrade = jest.fn();
jest.mock('ws', () => ({
  WebSocketServer: jest.fn().mockImplementation(() => ({
    handleUpgrade: mockHandleUpgrade,
    on: jest.fn(),
    emit: jest.fn(),
  })),
}));
const handleUpgrade = mockHandleUpgrade;
jest.mock('../services/voice-agent/relay-conversation', () => ({ RelayConversation: jest.fn() }));

const { EventEmitter } = require('events');
const { attachVoiceRelay } = require('../services/voice-agent/relay-server');
const { mintCallToken, CALL_TOKEN_TTL_MS } = require('../services/voice-agent/relay-protocol');

const SECRET = 'test-ws-secret-value';
const CALL_SID = 'CA-upgrade-1';

function attach() {
  const httpServer = new EventEmitter();
  attachVoiceRelay(httpServer);
  return httpServer;
}

function upgrade(httpServer, url) {
  const socket = { destroy: jest.fn() };
  httpServer.emit('upgrade', { url }, socket, Buffer.alloc(0));
  return socket;
}

describe('ws upgrade — per-call token, never a reusable secret', () => {
  let httpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VOICE_RELAY_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.VOICE_RELAY_WS_SECRET = SECRET;
    httpServer = attach();
  });

  afterEach(() => {
    delete process.env.VOICE_RELAY_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VOICE_RELAY_WS_SECRET;
  });

  test('a token minted for this CallSid is accepted', () => {
    const t = mintCallToken(CALL_SID);
    const socket = upgrade(httpServer, `/ws/voice-agent?callSid=${CALL_SID}&t=${t}`);
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  // ⭐ THE OLD CREDENTIAL IS NOT A CREDENTIAL. Holding the secret is exactly the
  // position the leak puts an attacker in, and it must buy nothing at the door.
  test('the raw shared secret is refused — as `key`, and as the token itself', () => {
    for (const url of [
      `/ws/voice-agent?key=${SECRET}`,
      `/ws/voice-agent?callSid=${CALL_SID}&key=${SECRET}`,
      `/ws/voice-agent?callSid=${CALL_SID}&t=${SECRET}`,
    ]) {
      const socket = upgrade(httpServer, url);
      expect(socket.destroy).toHaveBeenCalled();
    }
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  test('missing token, missing CallSid, or a token bound to another call is refused', () => {
    const t = mintCallToken(CALL_SID);
    for (const url of [
      '/ws/voice-agent',
      `/ws/voice-agent?callSid=${CALL_SID}`,
      `/ws/voice-agent?t=${t}`,
      `/ws/voice-agent?callSid=CA-someone-else&t=${t}`,
      `/ws/voice-agent?callSid=${CALL_SID}&t=v1.99999999999.${'0'.repeat(32)}`,
    ]) {
      const socket = upgrade(httpServer, url);
      expect(socket.destroy).toHaveBeenCalled();
    }
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  test('an expired token is refused even with the right CallSid', () => {
    const stale = mintCallToken(CALL_SID, { now: Date.now() - CALL_TOKEN_TTL_MS - 5000 });
    const socket = upgrade(httpServer, `/ws/voice-agent?callSid=${CALL_SID}&t=${stale}`);
    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  // ⭐ ONE SESSION PER TOKEN. Within its few live minutes the URL is still valid,
  // so the burn is what stops a captured URL being replayed while the call it
  // was minted for is still ringing.
  test('the same token cannot open a second session', () => {
    const t = mintCallToken('CA-replay-1');
    const first = upgrade(httpServer, `/ws/voice-agent?callSid=CA-replay-1&t=${t}`);
    const second = upgrade(httpServer, `/ws/voice-agent?callSid=CA-replay-1&t=${t}`);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.destroy).toHaveBeenCalled();
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
  });

  // ⭐ SOCKET.IO COEXISTENCE. For any other path this listener must not touch
  // the socket at all — not destroy it, not upgrade it — or dispatch's realtime
  // connection dies the moment the relay attaches.
  test('a non-relay path is left entirely alone (socket untouched)', () => {
    const socket = upgrade(httpServer, '/socket.io/?EIO=4&transport=websocket');
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  test('a malformed request URL is left for other listeners, never destroyed', () => {
    const socket = upgrade(httpServer, undefined);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });
});

describe('ws upgrade — fail-closed attach', () => {
  afterEach(() => {
    delete process.env.VOICE_RELAY_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VOICE_RELAY_WS_SECRET;
  });

  test('no secret ⇒ no endpoint at all (an unauthenticated relay must never attach)', () => {
    jest.clearAllMocks();
    process.env.VOICE_RELAY_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    delete process.env.VOICE_RELAY_WS_SECRET;
    const httpServer = new EventEmitter();
    expect(attachVoiceRelay(httpServer)).toBeNull();
    expect(httpServer.listenerCount('upgrade')).toBe(0);
  });
});
