/**
 * ConversationRelay wire protocol — single source of truth.
 *
 * Twilio's <Connect><ConversationRelay> handles STT + TTS on Twilio's side and
 * speaks to our WebSocket in JSON frames. This module isolates EVERY assumption
 * about that frame shape so the rest of the lane (conversation loop, server)
 * never hand-rolls the wire format. If a live call reveals the deployed
 * ConversationRelay version uses different field names, this is the ONLY file
 * to touch.
 *
 * ⚠️ FIRST-LIVE-CALL VERIFICATION (Phase 0 exit gate): confirm the inbound
 * `prompt` text field and the outbound `text`/`end` frames against the actual
 * ConversationRelay version on the account. Twilio docs across versions have
 * used both `voicePrompt` and `payload.text` for inbound text; parsePrompt()
 * below tolerates both. Outbound uses the documented `{type:'text', token,
 * last}` token-streaming shape.
 *
 * Inbound (Twilio → us):
 *   { type: 'setup',     callSid, sessionId, from, to, ...customParameters }
 *   { type: 'prompt',    voicePrompt: '<caller speech>', lang, last }
 *   { type: 'interrupt', ... }
 *   { type: 'dtmf',      digit }
 *   { type: 'error',     description }
 *
 * Outbound (us → Twilio):
 *   { type: 'text', token: '<to speak>', last: <bool> }
 *   { type: 'end',  handoffData: '<json string>' }
 */

const RELAY_WS_PATH = '/ws/voice-agent';

/**
 * Is the ConversationRelay WebSocket server enabled? Single source of truth for
 * the `VOICE_RELAY_ENABLED` flag — read by both `relay-server` (whether to
 * attach the ws endpoint) and the live `/voice` webhook (whether a configured
 * wss:// agent endpoint is actually reachable, so it never strands a call on a
 * relay that isn't listening).
 */
function isRelayEnabled() {
  return String(process.env.VOICE_RELAY_ENABLED || '').toLowerCase() === 'true';
}

/** Mask a phone number for logs — keep only the last 4 digits (PII hygiene). */
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

/**
 * ⭐ THE URL CARRIES A PER-CALL TOKEN, NEVER THE SECRET ITSELF.
 *
 * The upgrade used to be authorized by the raw `VOICE_RELAY_WS_SECRET` in a
 * `key` query param. That secret is REUSABLE and it is the ONE credential the
 * endpoint has, so everything that leaks a URL leaks the endpoint: Twilio logs
 * request URLs, and anyone holding it could open unlimited synthetic sessions,
 * spend Anthropic tokens and write leads into the database — with no call
 * involved at all.
 *
 * A token fixes that only if the URL stops carrying the minting key, which is
 * the whole point of the change: what leaks from a URL is what is IN the URL.
 * So the secret stays server-side (Railway env, and the Twilio Function env
 * that renders the sandbox TwiML) and the URL carries only
 *
 *     v1.<expiry-epoch-seconds>.<nonce>.<HMAC-SHA256(secret, "v1.<callSid>.<expiry>.<nonce>")>
 *
 * which is useless twice over: it is bound to ONE CallSid, and it dies minutes
 * after the call it was minted for. A captured URL buys an attacker a session
 * on a call that has already ended — which the one-time claim in relay-server
 * refuses anyway.
 *
 * ⭐ THE NONCE IS WHAT MAKES EVERY MINT UNIQUE. Without it the token was a pure
 * function of (CallSid, expiry-second): two renders for the SAME call inside
 * one second — a <Connect action> retry after a dropped socket is exactly that —
 * minted byte-identical tokens, and the first upgrade had already burned the
 * string, so the legitimate retry was refused at the door. Sixteen random hex
 * chars make each render its own one-time credential; the burn stays exact.
 */
const CALL_TOKEN_VERSION = 'v1';
// How long a minted token stays valid. The relay socket opens seconds after the
// TwiML renders; five minutes is slack for a slow answer, not a window.
const CALL_TOKEN_TTL_MS = 5 * 60 * 1000;

function callTokenMac(callSid, expSec, nonce, secret) {
  return require('crypto')
    .createHmac('sha256', String(secret))
    .update(`${CALL_TOKEN_VERSION}.${String(callSid)}.${expSec}.${nonce}`)
    .digest('hex')
    .slice(0, 32); // 128 bits — plenty against forgery, short enough for a URL
}

/**
 * Mint the per-call upgrade token. Returns '' when no secret is configured, so
 * a misconfigured deploy renders a URL the server will REFUSE rather than one
 * it will silently accept.
 */
function mintCallToken(callSid, { secret = process.env.VOICE_RELAY_WS_SECRET, now = Date.now(), ttlMs = CALL_TOKEN_TTL_MS } = {}) {
  const sid = String(callSid || '').trim();
  if (!secret || !sid) return '';
  const expSec = Math.floor((now + ttlMs) / 1000);
  // The nonce carries its own MINT ORDER: a 12-hex millisecond prefix plus
  // 4 random hex. The session-claim takeover needs a durable total ordering
  // of mints (the expiry's one-second resolution ties on same-second
  // retries), and an opaque random nonce cannot say which token is newer —
  // this one can, at millisecond resolution, with the random suffix as a
  // deterministic lexicographic tie-break. Still 16 hex, still MAC-covered,
  // still burn-table-compatible; sandbox-minted pure-random nonces order
  // arbitrarily but the sandbox path never claims a call_log row at all.
  // `now` (the injectable mint clock), never a second Date.now() — the exp
  // and the generation must agree on when this token was minted.
  //
  // KNOWN TRADE, deliberately accepted: this is wall-clock ordering with a
  // random lexicographic tie-break, not a cross-pod monotonic sequence (that
  // would need a DB-assigned generation and an async mint on the live /voice
  // path). Pod clock skew or an unlucky same-millisecond tie can order a
  // legitimate reconnect BELOW the stale claim — the cost is bounded and
  // non-fatal BY CONSTRUCTION: a refused claim leaves the session UNVERIFIED,
  // and unverified sessions are exempt from every supersession fence
  // (relay-conversation _sessionSuperseded and the write-fence key are both
  // verified-only), so the mis-ordered reconnect keeps capture-only service
  // instead of being terminated. A delayed old socket that HELD the claim is
  // verified and stays strictly fenced.
  const nonce = now.toString(16).padStart(12, '0')
    + require('crypto').randomBytes(2).toString('hex');
  return `${CALL_TOKEN_VERSION}.${expSec}.${nonce}.${callTokenMac(sid, expSec, nonce, secret)}`;
}

/**
 * Verify a per-call token against the CallSid it must be bound to. Constant-time
 * MAC compare; fails closed on every malformed shape.
 *
 * The expiry is checked in BOTH directions. A far-future `exp` is as much a red
 * flag as a stale one — it would be a token minted to live forever — so anything
 * beyond the TTL the minter is allowed to grant is refused, which keeps the
 * lifetime a property of this code rather than of whoever rendered the URL.
 */
function verifyCallToken(token, callSid, { secret = process.env.VOICE_RELAY_WS_SECRET, now = Date.now(), maxTtlMs = CALL_TOKEN_TTL_MS } = {}) {
  const sid = String(callSid || '').trim();
  if (!secret || !sid) return false;
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== CALL_TOKEN_VERSION) return false;
  const expSec = Number(parts[1]);
  if (!Number.isSafeInteger(expSec)) return false;
  // The nonce is opaque but bounded: it feeds the MAC input and a burn-table
  // hash, so an attacker must not get to choose an arbitrarily long string.
  const nonce = String(parts[2]);
  if (!/^[0-9a-f]{16}$/.test(nonce)) return false;
  const expMs = expSec * 1000;
  if (expMs <= now) return false; // expired
  // Allow a minute of clock skew between the renderer and this process on top
  // of the grant the minter is permitted.
  if (expMs > now + maxTtlMs + 60 * 1000) return false;
  const expected = callTokenMac(sid, expSec, nonce, secret);
  const crypto = require('crypto');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts[3]));
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}

/**
 * Put the per-call credentials on the WebSocket URL: the CallSid the session
 * claims to be, and the token that proves the URL was minted by something
 * holding the secret for THAT CallSid. Any pre-existing `key`/`callSid`/`t`
 * params are dropped — a stale raw secret must never survive into a rendered
 * URL. Returns the URL unchanged when there is nothing to mint with, so the
 * server's refusal (not a silent downgrade) is what surfaces the misconfig.
 */
function appendCallAuth(wsUrl, { callSid, secret = process.env.VOICE_RELAY_WS_SECRET, now = Date.now() } = {}) {
  // ⭐ SANITIZE FIRST, MINT SECOND. The operator-supplied endpoint URL can still
  // carry the RETIRED `?key=<secret>` from before the per-call token — and the
  // old early return handed it back verbatim whenever there was nothing to mint
  // with (no CallSid, no secret), re-emitting the one credential this design
  // exists to keep out of URLs. The owned params are stripped unconditionally;
  // a mint failure then renders a URL with NO credentials, which the server
  // refuses — a visible misconfig, never a leaked secret.
  const stripOwned = (url) => {
    try {
      const u = new URL(url);
      u.searchParams.delete('key');
      u.searchParams.delete('callSid');
      u.searchParams.delete('t');
      return u.toString();
    } catch {
      return String(url || '').replace(/([?&])(key|callSid|t)=[^&]*/g, '$1').replace(/[?&]+$/, '');
    }
  };
  const clean = stripOwned(wsUrl);
  const token = mintCallToken(callSid, { secret, now });
  if (!token) return clean;
  const sid = String(callSid).trim();
  try {
    const u = new URL(clean);
    u.searchParams.set('callSid', sid);
    u.searchParams.set('t', token);
    return u.toString();
  } catch {
    return `${clean}${clean.includes('?') ? '&' : '?'}callSid=${encodeURIComponent(sid)}&t=${encodeURIComponent(token)}`;
  }
}

// The agent's spoken name (persona parity with the relay system prompt —
// relay-conversation reads the same env). Read at call time, not module load.
function agentName() {
  return String(process.env.VOICE_AGENT_NAME || '').trim() || 'Sandy';
}

// The relay greeting is Sandy's OPENER, not a legal notice (owner ruling
// 2026-08-28): the recorded-line disclosure is carried by the greeting MP3
// that plays BEFORE the relay on every production path (/voice staff-ring,
// AI-answers-first — which now plays the MP3 too — and inside the language
// vestibule). Nothing here mentions recording or AI. The identity rule stands
// in the prompt instead: she never claims to be human, and answers honestly
// when asked. VOICE_RELAY_GREETING overrides the line verbatim; the ONE guard
// left is that an override may not CLAIM to be human — an identity lie is
// discarded wholesale (refusing would strand live calls on a bad env value).
const DEFAULT_WELCOME_GREETING = 'Waves, this is Sandy. How can I help you {dayPart}?';

// ET day-part for the greeting: morning until noon, afternoon until 5 PM,
// evening after — the same clock every other spoken-time rule uses.
function greetingDayPart(now = new Date()) {
  const { etParts } = require('../../utils/datetime-et');
  const hour = Number(etParts(now).hour);
  if (!Number.isFinite(hour)) return 'today';
  if (hour < 12) return 'this morning';
  if (hour < 17) return 'this afternoon';
  return 'this evening';
}

// A positive claim to BE human is the identity lie — stated with or without a
// denial word — and gets the canonical greeting instead.
const HUMAN_CLAIM_RE = /\b(?:speaking (?:with|to)|talking (?:with|to)|this is|i'?m|i am)\b[^.!?]{0,25}\b(?:a )?(?:real )?(?:human|person|live agent|live person)\b/i;
const HUMAN_CLAIM_ES_RE = /\b(?:habla|hablando|est[áa]\s+hablando|soy)\b[^.!?]{0,25}\b(?:humano|humana|persona\s+real|una\s+persona)\b/i;

// ── Spanish session (GATE_VOICE_SPANISH_MENU) ──────────────────────────────
// A press-2 caller may have cut the English greeting MP3 short, so the
// Spanish opener keeps a one-clause recorded-line notice; no AI mention.
const SPANISH_LANGUAGE = 'es-US';
const DEFAULT_WELCOME_GREETING_ES = 'Waves, habla Sandy. Esta llamada puede ser grabada. ¿En qué puedo ayudarle hoy?';
const RECORDING_DISCLOSURE_ES_RE = /\b(?:puede|podr[ií]a|va a|ser[áa]|est[áa] siendo|es|est[áa])\s+(?:ser\s+)?grabad[ao]s?\b/i;
const RECORDING_NEGATION_ES_RE = /\b(?:no|nunca|jam[áa]s|nada|ning[uú]n[ao]?)\b[^.!?]{0,40}\b(?:grabad[ao]s?|grabando|graba)\b/i;
const RECORDING_SUFFIX_ES = 'Esta llamada puede ser grabada.';

function spanishWelcomeGreeting() {
  const canonical = DEFAULT_WELCOME_GREETING_ES.replace('Sandy', agentName());
  const override = String(process.env.VOICE_RELAY_GREETING_ES || '').trim();
  if (!override) return canonical;
  if (HUMAN_CLAIM_ES_RE.test(override) || RECORDING_NEGATION_ES_RE.test(override)) return canonical;
  if (RECORDING_DISCLOSURE_ES_RE.test(override)) return override;
  return `${override.replace(/\s*$/, '')} ${RECORDING_SUFFIX_ES}`;
}

function defaultWelcomeGreeting(now = new Date()) {
  const canonical = DEFAULT_WELCOME_GREETING.replace('Sandy', agentName()).replace('{dayPart}', greetingDayPart(now));
  const override = String(process.env.VOICE_RELAY_GREETING || '').trim();
  if (!override) return canonical;
  if (HUMAN_CLAIM_RE.test(override)) return canonical;
  return override;
}

const DEFAULT_TTS_PROVIDER = 'ElevenLabs'; // matches the existing Waves voice-agent stack
const DEFAULT_LANGUAGE = 'en-US';

// Provider-specific voice id for the agent's TTS — the Sandy voice by default
// (owner ruling 2026-08-11: voice id 21m00Tcm4TlvDq8ikWAM, name parity with
// the sandbox), overridable via VOICE_RELAY_TTS_VOICE. Read at call time (not
// module load) so an env change takes effect on restart even if this module
// was required before the var existed in the environment.
const DEFAULT_TTS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
function defaultTtsVoice() {
  return String(process.env.VOICE_RELAY_TTS_VOICE || '').trim() || DEFAULT_TTS_VOICE_ID;
}

/** Pull the caller's transcribed text out of an inbound `prompt` frame, tolerant of field-name drift. */
function parsePrompt(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const text =
    msg.voicePrompt != null ? msg.voicePrompt
    : msg.payload && msg.payload.text != null ? msg.payload.text
    : msg.text != null ? msg.text
    : '';
  return String(text || '').trim();
}

/** Build an outbound `text` frame (a chunk of speech for Twilio to synthesize). */
function textFrame(token, last = true) {
  return JSON.stringify({ type: 'text', token: String(token == null ? '' : token), last: !!last });
}

/** Build an outbound `end` frame, terminating the session with optional structured handoff data. */
function endFrame(handoffData) {
  return JSON.stringify({
    type: 'end',
    handoffData: JSON.stringify(handoffData && typeof handoffData === 'object' ? handoffData : {}),
  });
}

function escapeXmlAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render the <Connect><ConversationRelay> TwiML that points a Twilio number at
 * our WebSocket. Hand-built XML (no SDK noun helper) so it works regardless of
 * the installed twilio library version. For Phase 0 the owner pastes this into
 * a Twilio TwiML Bin wired ONLY to the dead GA# sandbox number.
 */
function buildRelayTwiML({
  wsUrl,
  callSid, // the call this TwiML is answering — binds the upgrade token to it
  welcomeGreeting = defaultWelcomeGreeting(),
  ttsProvider = DEFAULT_TTS_PROVIDER,
  language = DEFAULT_LANGUAGE,
  voice = defaultTtsVoice(), // provider-specific voice id (env VOICE_RELAY_TTS_VOICE)
  action, // optional <Connect action> URL — Twilio POSTs here when the session ends/fails
  wsSecret = process.env.VOICE_RELAY_WS_SECRET,
  // Optional { name: value } map rendered as <Parameter> children — Twilio
  // echoes them back verbatim in the setup frame's customParameters, which is
  // how a purpose-built leg (the collections outbound relay) labels its
  // session mode. ABSENT (every existing caller) renders the exact
  // self-closing element as before — byte-identical, pinned by tests. The
  // values are hints only: relay-server treats every setup-frame field as
  // unverified input, so the session mode is re-proven server-side against
  // the call_log row for the AUTHENTICATED CallSid before anything acts on it.
  parameters = null,
} = {}) {
  if (!wsUrl) throw new Error('buildRelayTwiML: wsUrl is required');
  // Authenticate the upgrade with a token minted for THIS CallSid — validated
  // in relay-server before handleUpgrade (the ws endpoint is otherwise public).
  // A render without a CallSid produces a URL with no credentials, which the
  // server refuses: a live call must never be handed a session it did not earn,
  // and refusing at the door is what makes the missing SID visible.
  const authedUrl = appendCallAuth(wsUrl, { callSid, secret: wsSecret });
  const attrs = [
    `url="${escapeXmlAttr(authedUrl)}"`,
    `welcomeGreeting="${escapeXmlAttr(welcomeGreeting)}"`,
    // The opener plays in full (ConversationRelay defaults to interruptible);
    // it is one short sentence, and a Spanish opener carries the recorded-line
    // clause. Agent turns stay interruptible (governed separately; not set here).
    'welcomeGreetingInterruptible="none"',
    `ttsProvider="${escapeXmlAttr(ttsProvider)}"`,
    `language="${escapeXmlAttr(language)}"`,
  ];
  if (voice) attrs.push(`voice="${escapeXmlAttr(voice)}"`);
  // <Connect action> lets Twilio hit a fallback URL when the relay session ends
  // or fails (e.g. a rejected upgrade or transient WS error) instead of
  // stranding the call — the live backstop points it at /relay-complete.
  const connectAttrs = action ? ` action="${escapeXmlAttr(action)}" method="POST"` : '';
  const paramEntries = parameters && typeof parameters === 'object'
    ? Object.entries(parameters).filter(([k, v]) => k && v != null)
    : [];
  const relayElement = paramEntries.length
    ? `<ConversationRelay ${attrs.join(' ')}>`
      + paramEntries
        .map(([k, v]) => `<Parameter name="${escapeXmlAttr(k)}" value="${escapeXmlAttr(v)}" />`)
        .join('')
      + '</ConversationRelay>'
    : `<ConversationRelay ${attrs.join(' ')} />`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect${connectAttrs}>` +
    relayElement +
    '</Connect></Response>'
  );
}

module.exports = {
  RELAY_WS_PATH,
  DEFAULT_WELCOME_GREETING,
  defaultWelcomeGreeting,
  greetingDayPart,
  SPANISH_LANGUAGE,
  DEFAULT_WELCOME_GREETING_ES,
  spanishWelcomeGreeting,
  agentName,
  DEFAULT_TTS_PROVIDER,
  DEFAULT_LANGUAGE,
  DEFAULT_TTS_VOICE_ID,
  defaultTtsVoice,
  isRelayEnabled,
  maskPhone,
  appendCallAuth,
  mintCallToken,
  verifyCallToken,
  CALL_TOKEN_TTL_MS,
  parsePrompt,
  textFrame,
  endFrame,
  buildRelayTwiML,
  escapeXmlAttr,
};
