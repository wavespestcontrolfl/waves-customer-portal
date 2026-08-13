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
 *   - one session per token, claimed in SHARED storage (a per-process Map was
 *     not a claim: another instance, or a restart, would take the replay);
 *   - the authenticated CallSid — not the unverified setup frame's — is the one
 *     the session runs as;
 *   - and the path scoping that lets Socket.io keep its own upgrades, asserted
 *     by the socket being left completely untouched.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockHandleUpgrade = jest.fn();
const mockWssHandlers = {};
jest.mock('ws', () => ({
  WebSocketServer: jest.fn().mockImplementation(() => ({
    handleUpgrade: mockHandleUpgrade,
    on: jest.fn((event, handler) => { mockWssHandlers[event] = handler; }),
    emit: jest.fn(),
  })),
}));
jest.mock('../services/voice-agent/relay-conversation', () => ({ RelayConversation: jest.fn() }));

// The burn is a real INSERT … ON CONFLICT DO NOTHING against
// voice_relay_token_burns: the FIRST insert of a hash returns a row, every
// replay returns none. This fake keeps exactly that contract, so what is under
// test is the door's behaviour rather than knex.
const mockBurned = new Set();
let mockBurnFails = false;
jest.mock('../models/db', () => jest.fn(() => ({
  insert: (row) => ({
    onConflict: () => ({
      ignore: () => ({
        returning: () => {
          if (mockBurnFails) return Promise.reject(new Error('db down'));
          if (mockBurned.has(row.token_hash)) return Promise.resolve([]);
          mockBurned.add(row.token_hash);
          return Promise.resolve([{ token_hash: row.token_hash }]);
        },
      }),
    }),
  }),
  where: () => ({ del: () => Promise.resolve(0) }),
})));

const { EventEmitter } = require('events');
const { attachVoiceRelay } = require('../services/voice-agent/relay-server');
const { mintCallToken, CALL_TOKEN_TTL_MS } = require('../services/voice-agent/relay-protocol');

const handleUpgrade = mockHandleUpgrade;
const SECRET = 'test-ws-secret-value';
const CALL_SID = 'CA-upgrade-1';

function attach() {
  const httpServer = new EventEmitter();
  attachVoiceRelay(httpServer);
  return httpServer;
}

// The burn is a DB round trip, so the upgrade resolves asynchronously.
async function upgrade(httpServer, url) {
  const socket = { destroy: jest.fn() };
  httpServer.emit('upgrade', { url }, socket, Buffer.alloc(0));
  await new Promise((r) => setImmediate(r));
  return socket;
}

describe('ws upgrade — per-call token, never a reusable secret', () => {
  let httpServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBurned.clear();
    mockBurnFails = false;
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

  test('a token minted for this CallSid is accepted', async () => {
    const t = mintCallToken(CALL_SID);
    const socket = await upgrade(httpServer, `/ws/voice-agent?callSid=${CALL_SID}&t=${t}`);
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  // ⭐ THE OLD CREDENTIAL IS NOT A CREDENTIAL. Holding the secret is exactly the
  // position a leak puts an attacker in, and it must buy nothing at the door.
  test('the raw shared secret is refused — as `key`, and as the token itself', async () => {
    for (const url of [
      `/ws/voice-agent?key=${SECRET}`,
      `/ws/voice-agent?callSid=${CALL_SID}&key=${SECRET}`,
      `/ws/voice-agent?callSid=${CALL_SID}&t=${SECRET}`,
    ]) {
      const socket = await upgrade(httpServer, url);
      expect(socket.destroy).toHaveBeenCalled();
    }
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  test('missing token, missing CallSid, or a token bound to another call is refused', async () => {
    const t = mintCallToken(CALL_SID);
    for (const url of [
      '/ws/voice-agent',
      `/ws/voice-agent?callSid=${CALL_SID}`,
      `/ws/voice-agent?t=${t}`,
      `/ws/voice-agent?callSid=CA-someone-else&t=${t}`,
      `/ws/voice-agent?callSid=${CALL_SID}&t=v1.99999999999.${'0'.repeat(32)}`,
    ]) {
      const socket = await upgrade(httpServer, url);
      expect(socket.destroy).toHaveBeenCalled();
    }
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  test('an expired token is refused even with the right CallSid', async () => {
    const stale = mintCallToken(CALL_SID, { now: Date.now() - CALL_TOKEN_TTL_MS - 5000 });
    const socket = await upgrade(httpServer, `/ws/voice-agent?callSid=${CALL_SID}&t=${stale}`);
    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  // ⭐ ONE SESSION PER TOKEN, AND THE CLAIM IS SHARED. Within its few live
  // minutes the URL still verifies, so the burn is what stops a captured URL
  // being replayed while the call it was minted for is still ringing — and it
  // has to hold for a SECOND process, which is why it is a row and not a Map.
  test('the same token cannot open a second session — even in a fresh process', async () => {
    const t = mintCallToken('CA-replay-1');
    const first = await upgrade(httpServer, `/ws/voice-agent?callSid=CA-replay-1&t=${t}`);
    const second = await upgrade(httpServer, `/ws/voice-agent?callSid=CA-replay-1&t=${t}`);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(second.destroy).toHaveBeenCalled();
    expect(handleUpgrade).toHaveBeenCalledTimes(1);

    // A second instance with no in-memory state at all (the case a Map got
    // wrong): same shared store, so the replay is still refused.
    const otherInstance = attach();
    const onOtherInstance = await upgrade(otherInstance, `/ws/voice-agent?callSid=CA-replay-1&t=${t}`);
    expect(onOtherInstance.destroy).toHaveBeenCalled();
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
  });

  test('an unprovable claim fails CLOSED — a DB error refuses the upgrade', async () => {
    mockBurnFails = true;
    const t = mintCallToken('CA-db-down');
    const socket = await upgrade(httpServer, `/ws/voice-agent?callSid=CA-db-down&t=${t}`);
    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  // ⭐ SOCKET.IO COEXISTENCE. For any other path this listener must not touch
  // the socket at all — not destroy it, not upgrade it — or dispatch's realtime
  // connection dies the moment the relay attaches.
  test('a non-relay path is left entirely alone (socket untouched)', async () => {
    const socket = await upgrade(httpServer, '/socket.io/?EIO=4&transport=websocket');
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  test('a malformed request URL is left for other listeners, never destroyed', async () => {
    const socket = await upgrade(httpServer, undefined);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  // ⭐ THE AUTHENTICATED CallSid RIDES WITH THE SOCKET. Verifying the token
  // against call A and then letting the setup frame declare call B would make
  // the whole check ornamental: every downstream verification and claim would
  // aim at B.
  test('the accepted upgrade carries the authenticated CallSid, not the frame\'s', async () => {
    const t = mintCallToken('CA-bind-1');
    await upgrade(httpServer, `/ws/voice-agent?callSid=CA-bind-1&t=${t}`);
    const [req] = handleUpgrade.mock.calls[0];
    expect(req.authenticatedCallSid).toBe('CA-bind-1');
  });
});

// ⭐ THE SETUP FRAME DOES NOT GET TO NAME THE CALL. The frame is unverified
// input arriving after the door; if it could rename the session, a valid token
// for call A would authenticate a session claiming call B and every downstream
// check — call_log verification, the session claim, the transcript write —
// would be aimed at B.
describe('setup frame — bound to the authenticated CallSid', () => {
  const { RelayConversation } = require('../services/voice-agent/relay-conversation');

  function connect(authenticatedCallSid) {
    const listeners = {};
    const ws = {
      readyState: 1,
      OPEN: 1,
      on: jest.fn((event, handler) => { listeners[event] = handler; }),
      send: jest.fn(),
      terminate: jest.fn(),
    };
    mockWssHandlers.connection(ws, { authenticatedCallSid });
    return {
      ws,
      setup: (frame) => listeners.message(Buffer.from(JSON.stringify({ type: 'setup', ...frame }))),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockBurned.clear();
    process.env.VOICE_RELAY_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.VOICE_RELAY_WS_SECRET = SECRET;
    attach();
  });

  afterEach(() => {
    delete process.env.VOICE_RELAY_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.VOICE_RELAY_WS_SECRET;
  });

  test('a matching frame starts the session as the AUTHENTICATED call', () => {
    const { setup } = connect('CA-authed');
    setup({ callSid: 'CA-authed', from: '+19415550142' });
    expect(RelayConversation).toHaveBeenCalledTimes(1);
    expect(RelayConversation.mock.calls[0][0].callSid).toBe('CA-authed');
  });

  test('a frame naming ANOTHER call is refused — session terminated, none started', () => {
    const { ws, setup } = connect('CA-authed');
    setup({ callSid: 'CA-somebody-elses', from: '+19415550142' });
    expect(RelayConversation).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalled();
  });

  test('a frame with no CallSid runs as the authenticated call, never as null', () => {
    const { setup } = connect('CA-authed');
    setup({ from: '+19415550142' });
    expect(RelayConversation.mock.calls[0][0].callSid).toBe('CA-authed');
  });

  test('a socket with no authenticated CallSid starts nothing at all', () => {
    const { ws, setup } = connect(null);
    setup({ callSid: 'CA-anything', from: '+19415550142' });
    expect(RelayConversation).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalled();
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
