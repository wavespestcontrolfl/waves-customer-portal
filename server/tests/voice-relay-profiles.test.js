/**
 * Relay profiles — the ONLY chooser of <ConversationRelay> tuning attributes.
 * Production selects a code-reviewed profile by id; an unknown id, a
 * sandbox-only profile, or any bad attribute renders NOTHING (byte-identical
 * TwiML), never a half-applied set.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  RELAY_PROFILES, SANDBOX_CELLS, validateRelayAttrs, resolveRelayProfile,
  activeRelayProfile, activeRelayTwiMLOptions, resolveSandboxCell, parseTtsVoice,
} = require('../services/voice-agent/relay-profiles');
const { STT_HINTS } = require('../config/transcription-vocabulary');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_PROFILE;
  delete process.env.VOICE_RELAY_SANDBOX_ATTRS;
});

describe('validateRelayAttrs — allowlisted keys, validated values, all-or-nothing', () => {
  test('a valid set comes back as strings with hints:"default" resolved to the shared vocabulary', () => {
    const out = validateRelayAttrs({ speechModel: 'flux', eotThreshold: 0.7, partialPrompts: false, hints: 'default', events: 'speaker-events tokens-played' });
    expect(out.ok).toBe(true);
    expect(out.attrs).toEqual({
      speechModel: 'flux', eotThreshold: '0.7', partialPrompts: 'false',
      hints: STT_HINTS.join(','), events: 'speaker-events tokens-played',
    });
    expect(out.attrs.hints).toContain('WaveGuard');
    expect(out.attrs.hints).toContain('Myakka');
  });

  test('one unknown key rejects the WHOLE set', () => {
    const out = validateRelayAttrs({ speechModel: 'flux', url: 'wss://evil.example/ws' });
    expect(out.ok).toBe(false);
    expect(out.attrs).toBeUndefined();
    expect(out.error).toMatch(/unknown attribute "url"/);
  });

  test.each([
    ['eotThreshold', '0.95'],
    ['eotThreshold', 'abc'],
    ['interruptSensitivity', 'extreme'],
    ['speechTimeout', '100'],
    ['speechTimeout', '9000'],
    ['events', 'speaker-events bogus'],
    ['events', 'speaker-events speaker-events'],
    ['elevenlabsTextNormalization', 'yes'],
    ['transcriptionProvider', 'Whisper'],
    ['hints', 'a"b'],
    ['speechModel', 'nova 3'],
  ])('a bad value for %s rejects the whole set', (key, value) => {
    const out = validateRelayAttrs({ speechModel: 'flux', [key]: value });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(new RegExp(`"${key}"`));
  });

  test('speechTimeout accepts auto and the documented range', () => {
    expect(validateRelayAttrs({ speechTimeout: 'auto' }).ok).toBe(true);
    expect(validateRelayAttrs({ speechTimeout: '600' }).ok).toBe(true);
    expect(validateRelayAttrs({ speechTimeout: 5000 }).attrs.speechTimeout).toBe('5000');
  });

  test('non-objects are rejected', () => {
    expect(validateRelayAttrs(null).ok).toBe(false);
    expect(validateRelayAttrs(['speechModel']).ok).toBe(false);
    expect(validateRelayAttrs('flux').ok).toBe(false);
  });
});

describe('the shipped profiles', () => {
  test('every profile validates and subscribes to the telemetry events', () => {
    for (const id of Object.keys(RELAY_PROFILES)) {
      const profile = resolveRelayProfile(id);
      expect(profile).not.toBeNull();
      expect(profile.id).toBe(id);
      expect(profile.attrs.events).toBe('speaker-events tokens-played');
      expect(['block', 'clause']).toContain(profile.renderer);
    }
  });

  test('partialPrompts is off in every production profile — the loop drops partials by design', () => {
    for (const id of Object.keys(RELAY_PROFILES)) {
      const profile = resolveRelayProfile(id);
      if (!profile.sandboxOnly) expect(profile.attrs.partialPrompts).toBeUndefined();
    }
    expect(resolveRelayProfile('flux_partials_probe_v1')).toMatchObject({ sandboxOnly: true, attrs: { partialPrompts: 'true' } });
  });

  test('every sandbox cell code maps to a real profile', () => {
    for (const [code, id] of Object.entries(SANDBOX_CELLS)) {
      expect(code).toMatch(/^\d{2}$/);
      expect(resolveRelayProfile(id)).not.toBeNull();
    }
  });

  test('an unknown id resolves to null', () => {
    expect(resolveRelayProfile('flux_v9')).toBeNull();
    expect(resolveRelayProfile('')).toBeNull();
    expect(resolveRelayProfile('constructor')).toBeNull();
  });
});

describe('activeRelayProfile — VOICE_RELAY_PROFILE, fail closed', () => {
  test('unset ⇒ null and no TwiML options (byte-identical relay)', () => {
    expect(activeRelayProfile()).toBeNull();
    expect(activeRelayTwiMLOptions()).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a known profile ⇒ its attrs + id', () => {
    process.env.VOICE_RELAY_PROFILE = 'flux_balanced_v1';
    expect(activeRelayTwiMLOptions()).toEqual({
      relayAttrs: expect.objectContaining({ speechModel: 'flux', eotThreshold: '0.8' }),
      relayProfileId: 'flux_balanced_v1',
    });
  });

  test('an unknown id ⇒ null, warned ONCE', () => {
    process.env.VOICE_RELAY_PROFILE = 'no_such_profile_zz';
    expect(activeRelayProfile()).toBeNull();
    expect(activeRelayProfile()).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/not a known profile/);
  });

  test('a sandbox-only profile is refused in production', () => {
    process.env.VOICE_RELAY_PROFILE = 'flux_partials_probe_v1';
    expect(activeRelayProfile()).toBeNull();
    expect(logger.warn.mock.calls[0][0]).toMatch(/sandbox-only/);
  });
});

describe('resolveSandboxCell — the two-digit DTMF selector', () => {
  test('a known code ⇒ that profile, sandbox-only ones included', () => {
    expect(resolveSandboxCell('03')).toEqual({ relayAttrs: expect.objectContaining({ speechModel: 'flux' }), relayProfileId: 'flux_balanced_v1' });
    expect(resolveSandboxCell('09').relayProfileId).toBe('flux_partials_probe_v1');
  });

  test('99 ⇒ raw VOICE_RELAY_SANDBOX_ATTRS when valid, null (warned) when not', () => {
    process.env.VOICE_RELAY_SANDBOX_ATTRS = JSON.stringify({ speechModel: 'nova-2-general', ignoreBackchannel: true });
    expect(resolveSandboxCell('99')).toEqual({ relayAttrs: { speechModel: 'nova-2-general', ignoreBackchannel: 'true' }, relayProfileId: 'sandbox_raw' });
    process.env.VOICE_RELAY_SANDBOX_ATTRS = JSON.stringify({ url: 'wss://evil.example' });
    expect(resolveSandboxCell('99')).toBeNull();
    expect(logger.warn.mock.calls[0][0]).toMatch(/VOICE_RELAY_SANDBOX_ATTRS rejected/);
    process.env.VOICE_RELAY_SANDBOX_ATTRS = 'not json';
    expect(resolveSandboxCell('99')).toBeNull();
    delete process.env.VOICE_RELAY_SANDBOX_ATTRS;
    expect(resolveSandboxCell('99')).toBeNull();
  });

  test('anything else ⇒ null (the route falls back to the production profile)', () => {
    expect(resolveSandboxCell('')).toBeNull();
    expect(resolveSandboxCell('42')).toBeNull();
    expect(resolveSandboxCell('*')).toBeNull();
    expect(resolveSandboxCell(undefined)).toBeNull();
  });
});

describe('parseTtsVoice — the ElevenLabs voice attribute format', () => {
  test('bare id, id+model, id+model+settings', () => {
    expect(parseTtsVoice('21m00Tcm4TlvDq8ikWAM')).toEqual({ voiceId: '21m00Tcm4TlvDq8ikWAM', ttsModel: null, ttsSettings: null });
    expect(parseTtsVoice('21m00Tcm4TlvDq8ikWAM-flash_v2_5')).toEqual({ voiceId: '21m00Tcm4TlvDq8ikWAM', ttsModel: 'flash_v2_5', ttsSettings: null });
    expect(parseTtsVoice('NYC9WEgkq1u4jiqBseQ9-turbo_v2_5-0.8_0.8_0.6')).toEqual({ voiceId: 'NYC9WEgkq1u4jiqBseQ9', ttsModel: 'turbo_v2_5', ttsSettings: '0.8_0.8_0.6' });
  });
  test('non-ElevenLabs voices (hyphenated ids) are kept whole; empty ⇒ nulls', () => {
    expect(parseTtsVoice('en-US-Neural2-A', 'Google')).toEqual({ voiceId: 'en-US-Neural2-A', ttsModel: null, ttsSettings: null });
    expect(parseTtsVoice('')).toEqual({ voiceId: null, ttsModel: null, ttsSettings: null });
  });
});
