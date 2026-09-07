/**
 * Where a Waves Twilio number must route — the ONE definition shared by
 *   scripts/twilio/audit-inbound-routing.js   (voice-URL drift by mode, the
 *                                              Studio rollback contract),
 *   scripts/twilio/set-inbound-voice-url.js   (the URL it writes), and
 *   ops/agents/twilio-number-audit.js         (the full per-number contract).
 *
 * Two modes exist because docs/twilio-studio-flow-contract.md keeps the Studio
 * Flow as the documented rollback target: `app` is production, `studio` is the
 * rollback state. Only the voice URL differs between them; every other routing
 * field (fallback, status callback, SMS, and the App/trunk overrides that would
 * silently replace the URLs) is the same for a production line and lives in
 * APP_ROUTING.
 */

const FLOW_SID = process.env.TWILIO_INBOUND_FLOW_SID || 'FW5fdc2e44700c6e786ed27de94e0cbace';
const APP_VOICE_URL =
  process.env.TWILIO_EXPECTED_APP_VOICE_URL ||
  'https://waves-customer-portal-production.up.railway.app/api/webhooks/twilio/voice';
const VOICE_FALLBACK_URL =
  process.env.TWILIO_EXPECTED_VOICE_FALLBACK_URL || 'https://images-2066.twil.io/voice-fallback.xml';
const PORTAL_ORIGIN = new URL(APP_VOICE_URL).origin;

function studioVoiceUrl(accountSid) {
  return `https://webhooks.twilio.com/v1/Accounts/${accountSid}/Flows/${FLOW_SID}`;
}

// The audit matches Studio by path substring: Twilio renders the account SID
// into the URL and the audit never prints it.
function expectedVoiceUrl(mode) {
  return mode === 'app' ? APP_VOICE_URL : `/Flows/${FLOW_SID}`;
}

function voiceUrlMatches(url, mode) {
  if (mode === 'app') return String(url || '') === APP_VOICE_URL;
  return String(url || '').includes(`/Flows/${FLOW_SID}`);
}

// Every IncomingPhoneNumber field Twilio consults when a call or text arrives.
// The portal's status callbacks and SMS handler are POST-only; the voice
// fallback is a static twil.io asset fetched with GET; an Application SID or
// trunk overrides the URLs, so a production line must have none; a line
// switched to fax receive mode never reaches the voice URL at all.
const APP_ROUTING = Object.freeze({
  voiceUrl: APP_VOICE_URL,
  voiceMethod: 'POST',
  voiceReceiveMode: 'voice',
  voiceFallbackUrl: VOICE_FALLBACK_URL,
  voiceFallbackMethod: 'GET',
  statusCallback: `${PORTAL_ORIGIN}/api/webhooks/twilio/call-status`,
  statusCallbackMethod: 'POST',
  smsUrl: `${PORTAL_ORIGIN}/api/webhooks/twilio/sms`,
  smsMethod: 'POST',
  smsFallbackUrl: '',
  smsFallbackMethod: 'POST',
  voiceApplicationSid: '',
  smsApplicationSid: '',
  trunkSid: '',
});

// The SMS half of the contract. When a Messaging Service has
// useInboundWebhookOnNumber=false, ITS inbound/fallback URL + method replace these
// four fields for every number in its pool, so the service is checked against
// exactly this subset.
const SMS_ROUTING = Object.freeze({
  smsUrl: APP_ROUTING.smsUrl,
  smsMethod: APP_ROUTING.smsMethod,
  smsFallbackUrl: APP_ROUTING.smsFallbackUrl,
  smsFallbackMethod: APP_ROUTING.smsFallbackMethod,
});

// The relay sandbox line (VOICE_RELAY_SANDBOX_NUMBER) is the one owned number
// that deliberately routes elsewhere: POST /relay-sandbox on the same portal.
// It keeps the canonical status callback — /call-status owns the completed
// status and duration of every call_log row, sandbox rows included.
const SANDBOX_ROUTING = Object.freeze({
  voiceUrl: `${PORTAL_ORIGIN}/api/webhooks/twilio/relay-sandbox`,
  voiceMethod: 'POST',
  voiceReceiveMode: 'voice',
  voiceApplicationSid: '',
  trunkSid: '',
  statusCallback: APP_ROUTING.statusCallback,
  statusCallbackMethod: APP_ROUTING.statusCallbackMethod,
});

// Names of the contract's fields whose value on `resource` differs — exact
// string comparison, so an http:// URL never passes for the https:// contract.
// `resource` is an IncomingPhoneNumber (APP_ROUTING, SANDBOX_ROUTING) or a
// Messaging Service's effective inbound fields (SMS_ROUTING).
function routingDrift(resource, contract = APP_ROUTING) {
  return Object.keys(contract).filter((field) => String(resource[field] == null ? '' : resource[field]) !== contract[field]);
}

module.exports = {
  FLOW_SID,
  APP_VOICE_URL,
  APP_ROUTING,
  SMS_ROUTING,
  SANDBOX_ROUTING,
  studioVoiceUrl,
  expectedVoiceUrl,
  voiceUrlMatches,
  routingDrift,
};
