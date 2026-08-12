/**
 * Voice-relay WebSocket server — attaches a raw `ws` endpoint for Twilio
 * ConversationRelay alongside the existing Socket.io dispatch server.
 *
 * ── COEXISTENCE WITH SOCKET.IO (the one live-path-sensitive bit) ──────────
 * Socket.io (attachSockets, server/sockets/index.js) registers its own
 * 'upgrade' handler on the same httpServer and only acts on its own path
 * (/socket.io/...). We register a SECOND 'upgrade' listener that handles ONLY
 * `/ws/voice-agent` and returns silently for every other path, leaving those
 * upgrades for Socket.io exactly as before. Node fires all 'upgrade' listeners,
 * so the two coexist without either touching the other's sockets.
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────
 * No-op unless VOICE_RELAY_ENABLED=true (independent of the existing
 * GATE_VOICE_AI_AGENT, so Phase 0 can be tested without disturbing the
 * ElevenLabs capture path) AND ANTHROPIC_API_KEY is present. With the flag off
 * — the default everywhere — NOTHING is attached: no ws server, no upgrade
 * listener, and the dispatch sockets are byte-for-byte unaffected.
 *
 * Phase 0 wiring: the owner points the dead GA# sandbox number at a Twilio
 * TwiML Bin whose <Connect><ConversationRelay url="wss://<host>/ws/voice-agent">
 * targets this endpoint. See docs/conversationrelay-booking-plan.md.
 */

const logger = require('../logger');
const {
  RELAY_WS_PATH, parsePrompt, isRelayEnabled, maskPhone, verifyCallToken, CALL_TOKEN_TTL_MS,
} = require('./relay-protocol');

// VOICE_RELAY_ENABLED check lives in relay-protocol (single source of truth,
// shared with the /voice webhook). Re-exported here under the name index.js uses.
const isEnabled = isRelayEnabled;

// True only after attachVoiceRelay has fully wired the ws endpoint (every
// prerequisite met). The /voice webhook consults THIS — not the raw env flag —
// so it never hands a live call to a relay that did not actually attach.
let attached = false;
function isRelayAttached() {
  return attached;
}

// DoS backstops for the authenticated ws (defense-in-depth should the shared
// key ever leak): cap inbound frame size, drop a session that has gone fully
// silent too long, and hard-cap a single call's duration. ConversationRelay
// frames are tiny JSON, so these never bite a real call.
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const WS_IDLE_MS = 2 * 60 * 1000;        // no inbound frame for 2 min → drop
const WS_MAX_SESSION_MS = 15 * 60 * 1000; // hard cap on a single call

// ⭐ ONE SESSION PER MINTED TOKEN.
//
// The token proves the URL was minted for a specific CallSid by something
// holding the secret; the burn below is what stops the SAME url being replayed
// for its few remaining minutes of life. It is deliberately an in-process store
// and that scope is the honest one: this burn covers the token, and a token is
// single-call and expires on its own, so the worst a cross-instance replay can
// buy is one duplicate session on a call that is still ringing — which the
// CallSid claim in relay-context (a shared `call_log` burn, the authoritative
// one-session guarantee for a caller's identity and context) then refuses.
// Entries are dropped once the token they cover cannot be valid any more, so
// this never grows without bound.
const burnedCallTokens = new Map(); // token -> epoch ms after which it is moot

function burnCallToken(token, now = Date.now()) {
  for (const [t, expiresAt] of burnedCallTokens) {
    if (expiresAt <= now) burnedCallTokens.delete(t);
  }
  if (burnedCallTokens.has(token)) return false; // already used — replay
  burnedCallTokens.set(token, now + CALL_TOKEN_TTL_MS + 60 * 1000);
  return true;
}

/**
 * @param {import('http').Server} httpServer
 * @returns {import('ws').WebSocketServer|null}
 */
function attachVoiceRelay(httpServer) {
  if (!isEnabled()) {
    logger.info('[voice-relay] disabled (VOICE_RELAY_ENABLED!=true) — not attaching ws endpoint');
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('[voice-relay] ANTHROPIC_API_KEY missing — refusing to attach (fail-closed)');
    return null;
  }
  if (!process.env.VOICE_RELAY_WS_SECRET) {
    logger.warn('[voice-relay] VOICE_RELAY_WS_SECRET missing — refusing to attach (fail-closed; the ws endpoint would be unauthenticated)');
    return null;
  }

  let WebSocketServer;
  let RelayConversation;
  let textFrame;
  let endFrame;
  try {
    ({ WebSocketServer } = require('ws'));
    ({ RelayConversation } = require('./relay-conversation'));
    ({ textFrame, endFrame } = require('./relay-protocol'));
  } catch (e) {
    logger.error(`[voice-relay] dependency load failed — not attaching: ${e.message}`);
    return null;
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  // Path-scoped upgrade routing. Returning without touching `socket` for
  // non-matching paths is what lets Socket.io's own 'upgrade' listener handle
  // /socket.io/ upgrades exactly as it does today.
  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch {
      return; // malformed — leave it for other listeners / Node default
    }
    if (url.pathname !== RELAY_WS_PATH) return; // NOT ours — do not touch the socket
    // Authenticate BEFORE accepting the upgrade — this endpoint can spend
    // Anthropic tokens and write leads, so an unauthenticated client is a P0.
    //
    // ⭐ AND A REUSABLE CREDENTIAL IS NOT AUTHENTICATION HERE. This used to
    // accept the raw VOICE_RELAY_WS_SECRET as a `key` query param: one static
    // string, in a URL, that Twilio writes to its logs — so anyone who ever saw
    // one URL could open unlimited sessions forever, burn Anthropic tokens and
    // write leads, with no call behind any of it. The URL now carries a token
    // minted for ONE CallSid that expires in minutes (relay-protocol), the
    // secret itself never leaves the server, and each token opens exactly one
    // session. A captured URL is then worth a single replay attempt against a
    // call that has already hung up.
    const callSid = String(url.searchParams.get('callSid') || '').trim();
    const token = String(url.searchParams.get('t') || '');
    if (!callSid || !verifyCallToken(token, callSid)) {
      logger.warn('[voice-relay] rejected ws upgrade: missing/invalid per-call token');
      try { socket.destroy(); } catch { /* socket already gone */ }
      return;
    }
    if (!burnCallToken(token)) {
      logger.warn(`[voice-relay] rejected ws upgrade: token already used callSid=${callSid}`);
      try { socket.destroy(); } catch { /* socket already gone */ }
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let convo = null;

    // Idle + max-duration backstops. All cleanup funnels through teardown()
    // (idempotent) so a leaked-key client can't pin an open socket — and keep
    // the model loop alive — indefinitely. The idle timer resets on every
    // inbound frame; ws.terminate() re-fires 'close', which the guard absorbs.
    let idleTimer = null;
    let sessionTimer = null;
    let torn = false;
    const teardown = (reason) => {
      if (torn) return;
      torn = true;
      clearTimeout(idleTimer);
      clearTimeout(sessionTimer);
      if (convo) convo.end(reason).catch(() => {});
      try { ws.terminate(); } catch { /* already closed */ }
    };
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.warn('[voice-relay] idle timeout — terminating ws');
        teardown('ws_idle_timeout');
      }, WS_IDLE_MS);
      idleTimer.unref?.(); // never let the backstop keep the process alive
    };
    sessionTimer = setTimeout(() => {
      logger.warn('[voice-relay] max session duration — terminating ws');
      teardown('ws_max_session');
    }, WS_MAX_SESSION_MS);
    sessionTimer.unref?.();
    bumpIdle();

    const send = (text) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(textFrame(text, true));
        } catch (e) {
          logger.error(`[voice-relay] ws send failed: ${e.message}`);
        }
      }
    };

    // End the ConversationRelay session (agent finished + lead captured) so the
    // caller isn't left in silence. Twilio closes the call after the end frame.
    const endSession = (handoffData) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(endFrame(handoffData));
        } catch (e) {
          logger.error(`[voice-relay] end frame send failed: ${e.message}`);
        }
      }
    };

    ws.on('message', (raw) => {
      bumpIdle();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore non-JSON
      }
      switch (msg && msg.type) {
        case 'setup': {
          // ⭐ ONE SETUP PER SOCKET. A second setup frame used to REPLACE the
          // live conversation: both instances then raced the atomic CallSid
          // claim, so the retained one could be the instance that LOST
          // verification (a stranger's session for a recognised caller), while
          // the orphaned winner never persisted its transcript and never ran
          // its capture floor — the call's whole record lost to a duplicate
          // frame. Frame handling on this endpoint is security-critical
          // (AGENTS.md); a duplicate is ignored, not honoured.
          if (convo) {
            logger.warn(`[voice-relay] duplicate setup frame IGNORED on an established session callSid=${convo.callSid}`);
            return;
          }
          const p = msg.customParameters || {};
          convo = new RelayConversation({
            callSid: msg.callSid || p.callSid || null,
            from: msg.from || p.from || null,
            to: msg.to || p.to || null,
            language: msg.lang || p.lang || null,
            send,
            endSession,
          });
          logger.info(`[voice-relay] session setup callSid=${convo.callSid} from=${convo.from ? maskPhone(convo.from) : 'n/a'}`);
          break;
        }
        case 'prompt': {
          if (!convo) return;
          // Ignore interim/partial STT frames — only act on the FINAL prompt, so
          // the agent never responds to (or runs tools on) a half-spoken phrase
          // and then re-processes the completed utterance.
          if (msg.last === false) break;
          const text = parsePrompt(msg);
          if (text) convo.handlePrompt(text);
          break;
        }
        case 'interrupt': {
          if (convo) convo.interrupt();
          break;
        }
        case 'error': {
          // Never log the description verbatim: Twilio can echo the offending
          // frame back in it, and our outbound frames carry the assistant's
          // (PII-bearing) replies. Log only that an error arrived + its length.
          const len = typeof msg.description === 'string' ? msg.description.length : 0;
          logger.warn(`[voice-relay] relay error frame received (description withheld, ${len} chars)`);
          break;
        }
        // 'dtmf' and others: ignored in Phase 0
        default:
          break;
      }
    });

    ws.on('close', () => teardown('ws_close'));
    ws.on('error', (e) => {
      logger.error(`[voice-relay] ws error: ${e.message}`);
    });
  });

  logger.info(`[voice-relay] attached ws endpoint at ${RELAY_WS_PATH} (model-driven capture, Phase 0)`);
  attached = true;
  return wss;
}

module.exports = { attachVoiceRelay, isEnabled, isRelayAttached };
