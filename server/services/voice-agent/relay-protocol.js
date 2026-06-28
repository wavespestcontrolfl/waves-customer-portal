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
 * Append the shared-secret `key` that authenticates the ConversationRelay
 * WebSocket upgrade (validated in relay-server before handleUpgrade). Returns
 * the URL unchanged when no secret is configured or a key is already present.
 */
function appendWsKey(wsUrl, secret = process.env.VOICE_RELAY_WS_SECRET) {
  if (!secret) return wsUrl;
  try {
    const u = new URL(wsUrl);
    u.searchParams.set('key', secret); // overwrite any stale key with the CURRENT secret
    return u.toString();
  } catch {
    // Unparseable/relative — naive append, only if no key is already present.
    if (/[?&]key=/.test(wsUrl)) return wsUrl;
    return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(secret)}`;
  }
}

// FL §934.03 recorded-line disclosure + explicit AI disclosure, spoken by
// Twilio TTS before the first caller turn. Kept here so the TwiML Bin and any
// future in-app TwiML render the identical greeting.
const DEFAULT_WELCOME_GREETING =
  "Thanks for calling Waves Pest Control. Just so you know, this call may be " +
  "recorded, and you're speaking with our automated assistant. How can I help you today?";

const DEFAULT_TTS_PROVIDER = 'ElevenLabs'; // matches the existing Waves voice-agent stack
const DEFAULT_LANGUAGE = 'en-US';

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
  welcomeGreeting = DEFAULT_WELCOME_GREETING,
  ttsProvider = DEFAULT_TTS_PROVIDER,
  language = DEFAULT_LANGUAGE,
  voice, // optional provider-specific voice id
  action, // optional <Connect action> URL — Twilio POSTs here when the session ends/fails
  wsSecret = process.env.VOICE_RELAY_WS_SECRET,
} = {}) {
  if (!wsUrl) throw new Error('buildRelayTwiML: wsUrl is required');
  // Authenticate the upgrade: the shared-secret `key` is validated in
  // relay-server before handleUpgrade (the ws endpoint is otherwise public).
  const authedUrl = appendWsKey(wsUrl, wsSecret);
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
  DEFAULT_TTS_PROVIDER,
  DEFAULT_LANGUAGE,
  isRelayEnabled,
  maskPhone,
  appendWsKey,
  parsePrompt,
  textFrame,
  endFrame,
  buildRelayTwiML,
  escapeXmlAttr,
};
