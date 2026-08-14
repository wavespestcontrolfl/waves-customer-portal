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
  const nonce = Date.now().toString(16).padStart(12, '0')
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

// FL §934.03 recorded-line disclosure + explicit AI disclosure, spoken by
// Twilio TTS before the first caller turn. Kept here so the TwiML Bin and any
// future in-app TwiML render the identical greeting. The agent introduces
// herself by name (VOICE_AGENT_NAME, default Sandy) but the recorded-line +
// automated-assistant disclosure is NOT dropped — the /voice backstop relies
// on this greeting BEING the §934.03 disclosure (see twilio-voice-webhook.js).
// VOICE_RELAY_GREETING overrides the whole line verbatim if the owner wants
// different copy.
const DEFAULT_WELCOME_GREETING =
  "Hi, this is Sandy at Waves Pest Control! Just so you know, this call may be " +
  "recorded, and you're speaking with our automated assistant. How can I help you today?";

// ⚠️ THE GREETING *IS* THE FL §934.03 DISCLOSURE. twilio-voice-webhook.js relies
// on this line carrying the recorded-line notice before the first caller turn —
// the whole consent posture of the relay leg rests on it. A verbatim
// VOICE_RELAY_GREETING override could therefore silently delete a legal
// disclosure with an env-var edit, so the override is VALIDATED: it must itself
// mention recording, and it must disclose the automated assistant. Anything
// short of that gets the missing half appended rather than being rejected —
// refusing would strand live calls on a bad env value.
// ⭐ AFFIRMATIVE, AND NOT NEGATED. A keyword test alone accepted the exact
// opposite of the disclosure it was guarding: "this call is not recorded;
// you're speaking with a human assistant" contains both keywords and would
// have passed verbatim, deleting BOTH required statements with an env edit.
// So the override must positively state that the call is/may be recorded and
// that the caller is speaking with an automated assistant — and any negation
// of either fails the check, which appends the canonical line rather than
// rejecting (refusing would strand live calls on a bad env value).
const RECORDING_DISCLOSURE_RE = /\b(?:is|are|may\s+be|might\s+be|will\s+be|being|gets?)\s+record(?:ed|ing)\b/i;
const AI_DISCLOSURE_RE = /\b(?:automated|virtual|AI|artificial)\b[^.!?]{0,30}\b(?:assistant|agent|receptionist)\b/i;
// "nothing here is recorded" and "don't worry, … recorded" are negations too —
// the list covers the denial words people actually reach for, not just "not".
const DISCLOSURE_NEGATION_RE = /\b(?:not|never|isn'?t|aren'?t|won'?t|don'?t|doesn'?t|nothing|none|no)\b[^.!?]{0,40}\b(?:record(?:ed|ing)|automated|virtual|AI|bot|human)\b/i;
// A positive claim to BE human needs no denial word to be false — "you're
// speaking with a human assistant" is the identity lie stated affirmatively,
// and it gets the same wholesale fallback as a negation.
const HUMAN_CLAIM_RE = /\b(?:speaking (?:with|to)|talking (?:with|to)|this is|i'?m|i am)\b[^.!?]{0,25}\bhuman\b/i;
const DISCLOSURE_SUFFIX = 'Just so you know, this call may be recorded, and you\'re speaking with our automated assistant.';

function defaultWelcomeGreeting() {
  const override = String(process.env.VOICE_RELAY_GREETING || '').trim();
  if (!override) return DEFAULT_WELCOME_GREETING.replace('Sandy', agentName());
  const negated = DISCLOSURE_NEGATION_RE.test(override) || HUMAN_CLAIM_RE.test(override);
  if (!negated
    && RECORDING_DISCLOSURE_RE.test(override)
    && AI_DISCLOSURE_RE.test(override)) return override;
  // ⭐ A FALSE DISCLOSURE IS DISCARDED, NOT PATCHED. Appending the canonical
  // line to "this call is not recorded, you're speaking with a human" would
  // make the caller hear both statements — a contradictory legal notice is no
  // notice at all. Negation ⇒ the override is thrown away entirely and the
  // canonical greeting speaks alone. Only a merely-INCOMPLETE override (no
  // negation, a half missing) keeps its copy with the missing half appended —
  // absent is fixable, false is not.
  if (negated) return DEFAULT_WELCOME_GREETING.replace('Sandy', agentName());
  return `${override.replace(/\s*$/, '')} ${DISCLOSURE_SUFFIX}`;
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
    // The welcomeGreeting IS the FL §934.03 recorded-line + automated-assistant
    // disclosure. ConversationRelay defaults welcomeGreetingInterruptible to
    // "any", so a caller who speaks immediately would cut the disclosure off
    // before consent — force it to play in full. Agent turns stay interruptible
    // (governed separately; not set here).
    'welcomeGreetingInterruptible="none"',
    `ttsProvider="${escapeXmlAttr(ttsProvider)}"`,
    `language="${escapeXmlAttr(language)}"`,
  ];
  if (voice) attrs.push(`voice="${escapeXmlAttr(voice)}"`);
  // <Connect action> lets Twilio hit a fallback URL when the relay session ends
  // or fails (e.g. a rejected upgrade or transient WS error) instead of
  // stranding the call — the live backstop points it at /relay-complete.
  const connectAttrs = action ? ` action="${escapeXmlAttr(action)}" method="POST"` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect${connectAttrs}>` +
    `<ConversationRelay ${attrs.join(' ')} />` +
    '</Connect></Response>'
  );
}

module.exports = {
  RELAY_WS_PATH,
  DEFAULT_WELCOME_GREETING,
  DISCLOSURE_SUFFIX,
  defaultWelcomeGreeting,
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
