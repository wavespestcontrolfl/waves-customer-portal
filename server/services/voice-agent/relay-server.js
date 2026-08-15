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

// ⭐ ONE SESSION PER MINTED TOKEN — AND THE CLAIM LIVES IN SHARED STORAGE.
//
// The token proves the URL was minted for a specific CallSid by something
// holding the secret; this burn is what stops the SAME url being replayed for
// its few remaining minutes of life. It was a per-process Map first, which is
// not a claim at all in the shape this deploys: a second Railway instance, or
// the same one after a restart, has an empty Map and would happily accept the
// replay — and a replayed socket spends Anthropic tokens and writes leads. The
// shared CallSid claim in relay-context does NOT cover this: it only decides
// whether the session gets account context, so a replay it refuses still
// reaches capture_lead.
//
// So the burn is a single INSERT … ON CONFLICT DO NOTHING against
// voice_relay_token_burns — one statement, so the "is it burned" test and the
// write cannot be interleaved by a racing socket. Exactly one racer gets a row
// back; every replay gets none. The token is HASHED at rest: it is short-lived,
// but it is still a credential and this table is durable.
//
// Fails CLOSED: any error means the claim is unproven, which is treated as
// already-burned. A DB outage therefore drops relay calls to the <Connect
// action> voicemail fallback — the same place a relay outage sends them.
// The burn's own deadline. A stalled pool otherwise leaves the upgrade PENDING
// until Knex's own timeout — the caller stuck in silence, neither accepted nor
// rejected, and the <Connect action> voicemail fallback unable to fire. Short
// and fail-closed: past the deadline the socket is destroyed, Twilio takes the
// call to the fallback, and nobody waits on a database that is not answering.
const TOKEN_BURN_DEADLINE_MS = 2500;

async function burnCallToken(token, callSid) {
  const tokenHash = require('crypto').createHash('sha256').update(String(token)).digest('hex');
  try {
    const db = require('../../models/db');
    // ⭐ MATERIALIZED ONCE. A Knex QueryBuilder is a THENABLE, and every
    // `.then()` on it starts a fresh query — racing the builder and then
    // touching it again in cleanup issued TWO inserts per upgrade (and, after
    // a timeout, a brand-new query while the stalled one still held its pool
    // slot). One Promise.resolve() executes it exactly once; the race and the
    // late-loser catch both hold that same promise.
    const burnPromise = Promise.resolve(db('voice_relay_token_burns')
      .insert({ token_hash: tokenHash, call_sid: String(callSid).slice(0, 64), burned_at: new Date() })
      .onConflict('token_hash')
      .ignore()
      .returning('token_hash'));
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`token burn exceeded ${TOKEN_BURN_DEADLINE_MS}ms`)),
        TOKEN_BURN_DEADLINE_MS,
      );
      deadlineTimer.unref?.();
    });
    let rows;
    try {
      rows = await Promise.race([burnPromise, deadline]);
    } finally {
      clearTimeout(deadlineTimer);
      // A late loser must never surface as unhandled (the write may still
      // land after the deadline — the burn row is then simply present for
      // the retry, which is correct). Same promise, no re-execution.
      burnPromise.catch(() => {});
    }
    if (!rows || rows.length === 0) return false; // replay — somebody already has it
    // Opportunistic sweep of rows no token can still be valid for. Detached:
    // the caller is already through the door and must never wait on cleanup.
    db('voice_relay_token_burns')
      .where('burned_at', '<', new Date(Date.now() - (CALL_TOKEN_TTL_MS + 60 * 60 * 1000)))
      .del()
      .catch(() => {});
    return true;
  } catch (e) {
    logger.warn(`[voice-relay] token burn failed — refusing the upgrade (fail-closed): ${e.message}`);
    return false;
  }
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
    // The burn is a DB round trip, so the upgrade completes asynchronously. The
    // socket is not handed to `ws` until it wins the claim; a loser (or an
    // error) is destroyed exactly as an unauthenticated one is.
    (async () => {
      // The authenticated call's SOURCE is resolved FIRST, before any frame
      // exists (gh prb-r11) and BEFORE the burn (gh prb-r19): the burn is
      // irreversible, so a transient read failure after it would consume the
      // one-use credential and drop an otherwise valid call — read-then-burn
      // lets Twilio's retry of the same URL succeed once the DB recovers.
      // An unreadable source still rejects (fail closed, the burn's
      // envelope); the read is idempotent so the ordering is safe.
      let collectionsCall = false;
      try {
        const db = require('../../models/db');
        const row = await db('call_log')
          .where({ twilio_call_sid: callSid })
          .first('source');
        collectionsCall = Boolean(row && row.source === 'collections_voice');
      } catch (e) {
        logger.warn(`[voice-relay] rejected ws upgrade: source resolution failed callSid=${callSid}: ${e.message}`);
        try { socket.destroy(); } catch { /* socket already gone */ }
        return;
      }
      const won = await burnCallToken(token, callSid);
      if (!won) {
        logger.warn(`[voice-relay] rejected ws upgrade: token already used callSid=${callSid}`);
        try { socket.destroy(); } catch { /* socket already gone */ }
        return;
      }
      req.authenticatedCollectionsCall = collectionsCall;
      // ⭐ THE AUTHENTICATED CallSid RIDES WITH THE SOCKET. The token was
      // verified against THIS CallSid, and the setup frame that follows is
      // unverified input: honouring the frame's own callSid would let a valid
      // token for call A authenticate a session claiming call B, and every
      // downstream check (call_log verification, the session claim, the
      // transcript write) would then be aimed at B.
      req.authenticatedCallSid = callSid;
      // The token's nonce doubles as the SESSION KEY for the CallSid claim: a
      // legitimate ConversationRelay retry renders fresh TwiML and mints a
      // NEW token, and that fresh nonce is what lets the reconnect reclaim
      // the live CallSid — while a duplicate setup frame on the SAME socket
      // (same nonce) still cannot claim twice.
      req.relaySessionKey = String(token).split('.')[2] || null;
      // The nonce's 12-hex millisecond prefix IS the mint generation (see
      // mintCallToken): millisecond-resolution ordering so a takeover can
      // require the claimant to be provably newer — a delayed old socket
      // cannot steal the claim back, and same-millisecond mints break ties
      // deterministically on the nonce's lexicographic order.
      req.relaySessionGeneration = parseInt(String(req.relaySessionKey || '').slice(0, 12), 16) || null;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    })().catch(() => {
      try { socket.destroy(); } catch { /* socket already gone */ }
    });
  });

  wss.on('connection', (ws, req) => {
    let convo = null;
    // The CallSid the upgrade token was verified against — the only CallSid this
    // socket is allowed to be. Absent only if something bypassed the upgrade
    // path, which the setup handler treats as unauthenticated.
    const authenticatedCallSid = (req && req.authenticatedCallSid) || null;
    // Resolved at UPGRADE time from the call_log row (gh prb-r11) — the
    // routing truth for the setup frame, never the frame's own label.
    const authenticatedCollectionsCall = Boolean(req && req.authenticatedCollectionsCall);
    const relaySessionKey = (req && req.relaySessionKey) || null;
    const relaySessionGeneration = (req && req.relaySessionGeneration) || null;

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
          // ⭐ THE FRAME DOES NOT GET TO NAME THE CALL. The upgrade token was
          // verified against one CallSid; a setup frame naming a different one
          // is either Twilio contradicting its own URL or somebody replaying a
          // token they hold against an account they do not. Either way the
          // session dies rather than proceeding under the frame's claim.
          const framedCallSid = msg.callSid || p.callSid || null;
          if (!authenticatedCallSid || (framedCallSid && framedCallSid !== authenticatedCallSid)) {
            logger.warn('[voice-relay] setup frame CallSid does not match the authenticated upgrade — terminating');
            teardown('setup_callsid_mismatch');
            return;
          }
          // Collections session mode (PR B): the outbound late-payment leg's
          // TwiML labels itself via a <Parameter>. The label is UNVERIFIED
          // frame input, so CollectionsConversation re-proves it server-side
          // against the call_log row for the AUTHENTICATED CallSid before
          // acting on anything — a mislabeled or forged frame gets a fixed
          // polite close, never a session. Without the label (every inbound
          // call today) this branch is untouched, byte-identical.
          // Routing = the frame label OR the upgrade-time source proof (gh
          // prb-r11): a collections call with a stripped label still routes
          // here; a forged label on a non-collections call routes here and
          // dies on CollectionsConversation's own server-side re-proof.
          if (p.session_mode === 'collections' || authenticatedCollectionsCall) {
            try {
              const { CollectionsConversation } = require('../collections/outbound-voice/collections-conversation');
              convo = new CollectionsConversation({
                callSid: authenticatedCallSid,
                from: msg.from || p.from || null,
                to: msg.to || p.to || null,
                send,
                endSession,
              });
            } catch (e) {
              logger.error(`[voice-relay] collections session load failed — terminating: ${e.message}`);
              teardown('collections_session_load_failed');
              return;
            }
            logger.info(`[voice-relay] collections session setup callSid=${convo.callSid}`);
            break;
          }
          convo = new RelayConversation({
            // ALWAYS the authenticated one — never the frame's.
            callSid: authenticatedCallSid,
            sessionKey: relaySessionKey,
            sessionGeneration: relaySessionGeneration,
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
        case 'dtmf': {
          // Only sessions that define handleDtmf act on digits (the
          // collections escape hatch: press 0 = human). RelayConversation
          // defines none, so the inbound path stays byte-identical.
          if (convo && typeof convo.handleDtmf === 'function') {
            convo.handleDtmf(msg.digit != null ? msg.digit : (msg.dtmf && msg.dtmf.digit));
          }
          break;
        }
        // others: ignored in Phase 0
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
