/**
 * ConversationRelay tuning profiles — the ONLY place the <ConversationRelay>
 * STT / turn-taking / TTS-normalization attributes are chosen.
 *
 * Production selects a code-reviewed profile by id (`VOICE_RELAY_PROFILE`);
 * it never carries raw attribute JSON, so every live configuration is
 * reproducible, reviewable, and reversible with one env change (unset = no
 * attributes at all = the TwiML every production path rendered before this
 * module existed, byte for byte). Raw attribute JSON is accepted on the
 * sandbox route only (`VOICE_RELAY_SANDBOX_ATTRS`, cell code 99), where a
 * bake-off can try a combination no profile names yet.
 *
 * Every attribute is allowlisted and value-validated against Twilio's
 * documented <ConversationRelay> noun (fetched 2026-09-03). An unknown key
 * or a bad value rejects the WHOLE attribute set — a half-applied profile
 * would be a configuration nobody reviewed.
 *
 * `partialPrompts` stays false in every production profile: ConversationRelay
 * surfaces Flux partials only as `prompt {last:false}` frames (Deepgram's
 * eager-turn events are not exposed), and the relay loop drops those frames
 * by design. The one profile that enables it is sandbox-only and exists to
 * count partials, never to act on them.
 */

const logger = require('../logger');

const enumOf = (values) => (v) => values.includes(String(v));
const bool = enumOf(['true', 'false']);
const decimalIn = (min, max) => (v) => {
  const s = String(v);
  if (!/^\d+(\.\d+)?$/.test(s)) return false;
  const n = Number(s);
  return n >= min && n <= max;
};

const EVENT_VALUES = ['speaker-events', 'tokens-played'];

// key → value validator. Values are rendered as strings (XML attributes).
const RELAY_ATTR_VALIDATORS = Object.freeze({
  transcriptionProvider: enumOf(['Deepgram', 'Google']),
  speechModel: (v) => /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(String(v)),
  hints: (v) => typeof v === 'string' && v.length > 0 && v.length <= 2000 && !/[<>"&]/.test(v),
  eotThreshold: decimalIn(0.5, 0.9),
  partialPrompts: bool,
  interruptSensitivity: enumOf(['high', 'medium', 'low']),
  ignoreBackchannel: bool,
  speechTimeout: (v) => String(v) === 'auto' || (/^\d+$/.test(String(v)) && Number(v) >= 600 && Number(v) <= 5000),
  reportInputDuringAgentSpeech: enumOf(['none', 'dtmf', 'speech', 'any']),
  events: (v) => {
    const parts = String(v).trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => EVENT_VALUES.includes(p)) && new Set(parts).size === parts.length;
  },
  elevenlabsTextNormalization: enumOf(['on', 'auto', 'off']),
  deepgramSmartFormat: bool,
});

const RELAY_ATTR_KEYS = Object.freeze(Object.keys(RELAY_ATTR_VALIDATORS));

// `hints: 'default'` resolves to the shared vocabulary list at validation time.
const HINTS_DEFAULT = 'default';

// Every production profile subscribes to the speaker / tokens-played events:
// the per-turn telemetry (relay-conversation) reads what the caller actually
// heard and when from them, and without them the latency record is an
// application-side estimate only.
const EVENTS_ALL = 'speaker-events tokens-played';

const RELAY_PROFILES = Object.freeze({
  nova_baseline_v1: {
    attrs: { speechModel: 'nova-3-general', events: EVENTS_ALL },
  },
  nova_hints_v1: {
    attrs: { speechModel: 'nova-3-general', hints: HINTS_DEFAULT, events: EVENTS_ALL },
  },
  flux_balanced_v1: {
    attrs: { speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL },
  },
  flux_fast_v1: {
    attrs: { speechModel: 'flux', eotThreshold: '0.6', hints: HINTS_DEFAULT, events: EVENTS_ALL },
  },
  flux_noise_resistant_v1: {
    attrs: {
      speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      ignoreBackchannel: 'true', interruptSensitivity: 'medium',
    },
  },
  flux_reporting_v1: {
    attrs: {
      speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      reportInputDuringAgentSpeech: 'speech',
    },
  },
  flux_smartformat_off_v1: {
    attrs: {
      speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      deepgramSmartFormat: 'false',
    },
  },
  flux_tts_normalization_v1: {
    attrs: {
      speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      elevenlabsTextNormalization: 'on',
    },
  },
  // Sandbox only: counts Flux partial prompts (the loop still drops them).
  flux_partials_probe_v1: {
    attrs: { speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL, partialPrompts: 'true' },
    sandboxOnly: true,
  },
});

// Two-digit DTMF cell codes the sandbox route accepts (the audio runner sends
// them with `sendDigits`; a human caller waits three seconds and gets the
// production profile). '99' = raw VOICE_RELAY_SANDBOX_ATTRS.
const SANDBOX_CELLS = Object.freeze({
  '01': 'nova_baseline_v1',
  '02': 'nova_hints_v1',
  '03': 'flux_balanced_v1',
  '04': 'flux_fast_v1',
  '05': 'flux_noise_resistant_v1',
  '06': 'flux_reporting_v1',
  '07': 'flux_smartformat_off_v1',
  '08': 'flux_tts_normalization_v1',
  '09': 'flux_partials_probe_v1',
});
const SANDBOX_RAW_CELL = '99';

/**
 * Validate an attribute map against the allowlist. Returns
 * `{ ok: true, attrs }` with every value a string and `hints: 'default'`
 * resolved, or `{ ok: false, error }` — never a partial set.
 */
function validateRelayAttrs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'attrs must be an object' };
  }
  const attrs = {};
  for (const [key, raw] of Object.entries(input)) {
    const validator = RELAY_ATTR_VALIDATORS[key];
    if (!validator) return { ok: false, error: `unknown attribute "${key}"` };
    let value = raw;
    if (key === 'hints' && value === HINTS_DEFAULT) {
      value = require('../../config/transcription-vocabulary').sttHintsCsv();
    }
    if (typeof value === 'boolean' || typeof value === 'number') value = String(value);
    if (typeof value !== 'string' || !validator(value)) {
      return { ok: false, error: `invalid value for "${key}"` };
    }
    attrs[key] = value;
  }
  return { ok: true, attrs };
}

/** Resolve a profile id to `{ id, attrs, sandboxOnly }`, or null. */
function resolveRelayProfile(id) {
  const key = String(id || '').trim();
  const profile = Object.prototype.hasOwnProperty.call(RELAY_PROFILES, key) ? RELAY_PROFILES[key] : null;
  if (!profile) return null;
  const checked = validateRelayAttrs(profile.attrs);
  if (!checked.ok) {
    // A profile that fails its own validator is a code bug, not an env
    // problem — surface it loudly and render nothing.
    logger.error(`[relay-profiles] profile "${key}" is invalid: ${checked.error}`);
    return null;
  }
  return {
    id: key,
    attrs: checked.attrs,
    sandboxOnly: profile.sandboxOnly === true,
  };
}

// Warn ONCE per distinct bad env value (read at call time, so a fix lands on
// restart without a code change; a bad value must not spam every call).
const warnedValues = new Set();
function warnOnce(value, message) {
  if (warnedValues.has(value)) return;
  warnedValues.add(value);
  logger.warn(message);
}

/**
 * The production profile: `VOICE_RELAY_PROFILE`. Unset ⇒ null (no
 * attributes, byte-identical TwiML). Unknown id or a sandbox-only profile ⇒
 * one warning, then null — fail closed to the untuned relay.
 */
function activeRelayProfile() {
  const id = String(process.env.VOICE_RELAY_PROFILE || '').trim();
  if (!id) return null;
  const profile = resolveRelayProfile(id);
  if (!profile) {
    warnOnce(`unknown:${id}`, `[relay-profiles] VOICE_RELAY_PROFILE="${id}" is not a known profile — rendering the relay with no tuning attributes`);
    return null;
  }
  if (profile.sandboxOnly) {
    warnOnce(`sandbox:${id}`, `[relay-profiles] VOICE_RELAY_PROFILE="${id}" is sandbox-only — rendering the relay with no tuning attributes`);
    return null;
  }
  return profile;
}

/**
 * The buildRelayTwiML options every production relay call site spreads in:
 * `{ relayAttrs, relayProfileId }` for the active profile, `{}` otherwise.
 */
function activeRelayTwiMLOptions() {
  const profile = activeRelayProfile();
  return profile ? { relayAttrs: profile.attrs, relayProfileId: profile.id } : {};
}

/**
 * Sandbox cell selection. A known code ⇒ that profile (sandbox-only profiles
 * allowed here); '99' ⇒ raw `VOICE_RELAY_SANDBOX_ATTRS` (invalid ⇒ null with
 * a warning); anything else ⇒ null (the route falls back to the production
 * profile).
 */
function resolveSandboxCell(code) {
  const key = String(code || '').trim();
  if (key === SANDBOX_RAW_CELL) {
    const raw = String(process.env.VOICE_RELAY_SANDBOX_ATTRS || '').trim();
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const checked = parsed ? validateRelayAttrs(parsed) : { ok: false, error: 'not JSON' };
    if (!checked.ok) {
      warnOnce(`raw:${raw}`, `[relay-profiles] VOICE_RELAY_SANDBOX_ATTRS rejected: ${checked.error}`);
      return null;
    }
    return { relayAttrs: checked.attrs, relayProfileId: 'sandbox_raw' };
  }
  const id = SANDBOX_CELLS[key];
  const profile = id ? resolveRelayProfile(id) : null;
  return profile ? { relayAttrs: profile.attrs, relayProfileId: profile.id } : null;
}

/**
 * Split an ElevenLabs `voice` attribute into its parts. Twilio's format is
 * `<voiceId>-<model>-<speed>_<stability>_<similarity>`; a bare id has no
 * model and no settings. Non-ElevenLabs voices (Google/Amazon ids contain
 * hyphens) are returned whole.
 */
function parseTtsVoice(voice, ttsProvider = 'ElevenLabs') {
  const value = String(voice || '').trim();
  if (!value) return { voiceId: null, ttsModel: null, ttsSettings: null };
  if (String(ttsProvider).toLowerCase() !== 'elevenlabs') return { voiceId: value, ttsModel: null, ttsSettings: null };
  const [voiceId, ttsModel = null, ttsSettings = null] = value.split('-');
  return { voiceId: voiceId || null, ttsModel, ttsSettings };
}

module.exports = {
  RELAY_ATTR_KEYS,
  RELAY_PROFILES,
  SANDBOX_CELLS,
  SANDBOX_RAW_CELL,
  validateRelayAttrs,
  resolveRelayProfile,
  activeRelayProfile,
  activeRelayTwiMLOptions,
  resolveSandboxCell,
  parseTtsVoice,
};
