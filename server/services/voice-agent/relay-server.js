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
const { RELAY_WS_PATH, parsePrompt, isRelayEnabled } = require('./relay-protocol');

// VOICE_RELAY_ENABLED check lives in relay-protocol (single source of truth,
// shared with the /voice webhook). Re-exported here under the name index.js uses.
const isEnabled = isRelayEnabled;

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

  let WebSocketServer;
  let RelayConversation;
  let textFrame;
  try {
    ({ WebSocketServer } = require('ws'));
    ({ RelayConversation } = require('./relay-conversation'));
    ({ textFrame } = require('./relay-protocol'));
  } catch (e) {
    logger.error(`[voice-relay] dependency load failed — not attaching: ${e.message}`);
    return null;
  }

  const wss = new WebSocketServer({ noServer: true });

  // Path-scoped upgrade routing. Returning without touching `socket` for
  // non-matching paths is what lets Socket.io's own 'upgrade' listener handle
  // /socket.io/ upgrades exactly as it does today.
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://internal').pathname;
    } catch {
      return; // malformed — leave it for other listeners / Node default
    }
    if (pathname !== RELAY_WS_PATH) return; // NOT ours — do not touch the socket
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let convo = null;

    const send = (text) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(textFrame(text, true));
        } catch (e) {
          logger.error(`[voice-relay] ws send failed: ${e.message}`);
        }
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore non-JSON
      }
      switch (msg && msg.type) {
        case 'setup': {
          const p = msg.customParameters || {};
          convo = new RelayConversation({
            callSid: msg.callSid || p.callSid || null,
            from: msg.from || p.from || null,
            to: msg.to || p.to || null,
            language: msg.lang || p.lang || null,
            send,
          });
          logger.info(`[voice-relay] session setup callSid=${convo.callSid} from=${convo.from || 'n/a'}`);
          break;
        }
        case 'prompt': {
          if (!convo) return;
          const text = parsePrompt(msg);
          if (text) convo.handlePrompt(text);
          break;
        }
        case 'interrupt': {
          if (convo) convo.interrupt();
          break;
        }
        case 'error': {
          logger.warn(`[voice-relay] relay error frame: ${msg.description || JSON.stringify(msg)}`);
          break;
        }
        // 'dtmf' and others: ignored in Phase 0
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (convo) convo.end('ws_close').catch(() => {});
    });
    ws.on('error', (e) => {
      logger.error(`[voice-relay] ws error: ${e.message}`);
    });
  });

  logger.info(`[voice-relay] attached ws endpoint at ${RELAY_WS_PATH} (model-driven capture, Phase 0)`);
  return wss;
}

module.exports = { attachVoiceRelay, isEnabled };
