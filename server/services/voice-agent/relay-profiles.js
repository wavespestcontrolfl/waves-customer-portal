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

const crypto = require('crypto');
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

// `hints: 'default'` resolves to the shared vocabulary list at validation time.
const HINTS_DEFAULT = 'default';

// Every production profile subscribes to the speaker / tokens-played events:
// the per-turn telemetry (relay-conversation) reads what the caller actually
// heard and when from them, and without them the latency record is an
// application-side estimate only.
const EVENTS_ALL = 'speaker-events tokens-played';

// ── Flux Multilingual (Sandy voice stack plan, Phase 0) ─────────────────────
// Deepgram released Flux Multilingual (10 languages, mid-call switching) GA
// 2026-04-29; Twilio's ConversationRelay supports it. Verified 2026-09-26
// directly against Twilio's own reference doc (raw HTML table + prose, not a
// third-party summary) — both values below are CONFIRMED, not guesses:
//
//   speechModel="flux"   — the SAME literal value as English Flux. Twilio's
//     own <ConversationRelay> noun abstracts Deepgram's two underlying model
//     ids (flux-general-en / flux-general-multi — Deepgram's own docs:
//     https://developers.deepgram.com/docs/flux/language-prompting) behind
//     one speechModel string; which one actually runs is selected by the
//     LANGUAGE setting below, not by a different speechModel value. Confirmed
//     by Twilio's own worked example (transcriptionProvider="Deepgram"
//     speechModel="flux" …) in
//     https://www.twilio.com/en-us/blog/developers/tutorials/integrations/deepgram-flux-twilio-conversation-relay
//     and by the changelog https://www.twilio.com/en-us/changelog/conversation-relay-now-supports-deepgram-flux---new-features
//   language="multi"     — the ConversationRelay-level switch that turns on
//     automatic language detection for STT AND TTS (setting the top-level
//     `language` attribute sets both `transcriptionLanguage` and
//     `ttsLanguage` — same reference doc, "Language settings" section:
//     "You can set the speech-to-text language in three ways… [1] The value
//     of the `language` attribute on the <ConversationRelay> noun"). Its own
//     "Automatic language detection" section: "you can specify `multi` as
//     the active STT language for the session" / "as the active TTS language
//     for the session", and "When using `speechModel`=`flux` with `multi`,
//     ConversationRelay will use the <Language> element (if declared) as a
//     language_hint to bias the model toward specific languages" (that
//     optional per-language bias element is NOT implemented here — this
//     profile relies on Flux Multilingual's own auto-detection, not a hint).
//     https://www.twilio.com/docs/voice/twiml/connect/conversationrelay#automatic-language-detection
//     https://www.twilio.com/docs/voice/twiml/connect/conversationrelay#setting-the-speech-to-text-language
//   Required alongside `multi`, straight from the same doc's warning:
//   transcriptionProvider must be Deepgram (every flux profile already sets
//   this) and ttsProvider must be ElevenLabs — already this codebase's
//   DEFAULT_TTS_PROVIDER (relay-protocol.js), so no override is needed here.
//
// What is NOT sandbox-call-confirmed: real transcription quality/latency,
// whether mid-call language switching behaves as documented, and the
// language_hint bias this profile skips — Phase 0 item 4 (a real sandbox
// call on (941) 241-2993) is what actually proves those, not this citation.
const FLUX_MULTILINGUAL_SPEECH_MODEL = 'flux';
const FLUX_MULTILINGUAL_LANGUAGE = 'multi';

// Every shipped profile names a Deepgram model (Nova / Flux), so every one
// sets the provider — ConversationRelay's default is Google, and a Deepgram
// speechModel on the Google provider cannot deliver the advertised recognizer.
const RELAY_PROFILES = Object.freeze({
  nova_baseline_v1: {
    attrs: { transcriptionProvider: 'Deepgram', speechModel: 'nova-3-general', events: EVENTS_ALL },
  },
  nova_hints_v1: {
    attrs: { transcriptionProvider: 'Deepgram', speechModel: 'nova-3-general', hints: HINTS_DEFAULT, events: EVENTS_ALL },
  },
  flux_balanced_v1: {
    attrs: { transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL },
  },
  flux_fast_v1: {
    attrs: { transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.6', hints: HINTS_DEFAULT, events: EVENTS_ALL },
  },
  flux_noise_resistant_v1: {
    attrs: {
      transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      ignoreBackchannel: 'true', interruptSensitivity: 'medium',
    },
  },
  flux_reporting_v1: {
    attrs: {
      transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      reportInputDuringAgentSpeech: 'speech',
    },
  },
  flux_smartformat_off_v1: {
    attrs: {
      transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      deepgramSmartFormat: 'false',
    },
  },
  flux_tts_normalization_v1: {
    attrs: {
      transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL,
      elevenlabsTextNormalization: 'on',
    },
  },
  // Sandbox only: counts Flux partial prompts (the loop still drops them).
  flux_partials_probe_v1: {
    attrs: { transcriptionProvider: 'Deepgram', speechModel: 'flux', eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL, partialPrompts: 'true' },
    sandboxOnly: true,
  },
  // Sandbox only (Sandy voice stack plan, Phase 0): Flux Multilingual —
  // speechModel is the same "flux" every other Flux profile uses; `language`
  // (sibling of `attrs`, never a rendered tuning attribute — see
  // RESERVED_RELAY_ATTRS in relay-protocol.js) is what actually selects the
  // multilingual model, per the citations above FLUX_MULTILINGUAL_LANGUAGE.
  // ttsProvider is not overridden: DEFAULT_TTS_PROVIDER is already
  // 'ElevenLabs', which `language: 'multi'` requires. Not yet confirmed by an
  // actual sandbox call — dial the cell below to verify before trusting it
  // for a real Spanish caller.
  flux_multilingual_es_v1: {
    attrs: { transcriptionProvider: 'Deepgram', speechModel: FLUX_MULTILINGUAL_SPEECH_MODEL, eotThreshold: '0.8', hints: HINTS_DEFAULT, events: EVENTS_ALL },
    language: FLUX_MULTILINGUAL_LANGUAGE,
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
  '10': 'flux_multilingual_es_v1',
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
    // Own keys only: `toString` / `constructor` resolve to inherited functions
    // and would validate as truthy (codex r14 P2 on #3852).
    const validator = Object.prototype.hasOwnProperty.call(RELAY_ATTR_VALIDATORS, key) ? RELAY_ATTR_VALIDATORS[key] : null;
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

// A profile's own `language` field (sibling of `attrs`, never a rendered
// tuning attribute — RESERVED_RELAY_ATTRS in relay-protocol.js excludes
// `language` from the attrs allowlist on purpose) is allowlisted here just
// as strictly: today only Flux Multilingual's `multi` needs it.
const PROFILE_LANGUAGE_VALUES = new Set([FLUX_MULTILINGUAL_LANGUAGE]);

/** Resolve a profile id to `{ id, attrs, sandboxOnly, language? }`, or null. */
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
  if (profile.language !== undefined && !PROFILE_LANGUAGE_VALUES.has(profile.language)) {
    logger.error(`[relay-profiles] profile "${key}" is invalid: unknown language "${profile.language}"`);
    return null;
  }
  return {
    id: key,
    attrs: checked.attrs,
    sandboxOnly: profile.sandboxOnly === true,
    ...(profile.language !== undefined ? { language: profile.language } : {}),
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
function activeRelayTwiMLOptions({ language = null } = {}) {
  const profile = activeRelayProfile();
  if (!profile) return {};
  // Deepgram Flux is English-only: a leg rendered in another language (the
  // Spanish vestibule's es-US relay) gets NO tuning — and no profile stamp,
  // so the row attributes what actually produced the call — rather than a
  // recognizer that cannot transcribe it (codex r10 P1 on #3852).
  if (language && !ENGLISH_RE.test(language) && !profileSupportsLanguage(profile, language)) {
    warnOnce(`lang:${profile.id}:${language}`, `[relay-profiles] ${profile.id} is English-only — Spanish leg (${language}) runs untuned`);
    return {};
  }
  return { relayAttrs: profile.attrs, relayProfileId: profile.id };
}

const ENGLISH_RE = /^en(?:[-_]|$)/i;
function profileSupportsLanguage(profile, language) {
  if (ENGLISH_RE.test(language)) return true;
  // A plain "flux" profile (speechModel="flux", no `language` override) is
  // the ENGLISH-only Flux model — Twilio selects Deepgram's multilingual
  // model by the session's own `language`/`transcriptionLanguage` setting,
  // not by a different speechModel string (see FLUX_MULTILINGUAL_LANGUAGE's
  // citations above), so a profile that already carries
  // `language: 'multi'` genuinely supports any non-English caller and is
  // never dropped here — unlike a same-speechModel profile with no language
  // override, which stays English-only.
  if (profile.language === FLUX_MULTILINGUAL_LANGUAGE) return true;
  return String(profile.attrs.speechModel || '').toLowerCase() !== 'flux';
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
    // The stamp names the attribute map, not just the cell: two cell-99 runs
    // on different raw attrs must be attributable from their rows.
    const canonical = JSON.stringify(Object.keys(checked.attrs).sort().map((k) => [k, checked.attrs[k]]));
    return { relayAttrs: checked.attrs, relayProfileId: `sandbox_raw_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)}` };
  }
  const id = SANDBOX_CELLS[key];
  const profile = id ? resolveRelayProfile(id) : null;
  if (!profile) return null;
  // A profile's `language` (Flux Multilingual's `multi` — see
  // FLUX_MULTILINGUAL_LANGUAGE above) rides alongside relayAttrs/
  // relayProfileId: sandboxRelayXml spreads this object straight into
  // buildRelayTwiML's options, whose own `language` param this overrides —
  // every other cell carries no `language` key and leaves that param at its
  // default, byte-identical to before this profile existed.
  return {
    relayAttrs: profile.attrs,
    relayProfileId: profile.id,
    ...(profile.language !== undefined ? { language: profile.language } : {}),
  };
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
  RELAY_PROFILES,
  SANDBOX_CELLS,
  SANDBOX_RAW_CELL,
  validateRelayAttrs,
  resolveRelayProfile,
  activeRelayProfile,
  activeRelayTwiMLOptions,
  profileSupportsLanguage,
  resolveSandboxCell,
  parseTtsVoice,
  FLUX_MULTILINGUAL_SPEECH_MODEL,
  FLUX_MULTILINGUAL_LANGUAGE,
};
