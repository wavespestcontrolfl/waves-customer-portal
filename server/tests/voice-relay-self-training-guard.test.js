/**
 * SELF-TRAINING LOOP GUARD — the AI phone agent's own speech must never be
 * mined as if a human had said it.
 *
 * relay-transcript.js writes the pipeline's `Agent:` / `Caller:` line labels
 * onto `call_log.transcription`, which is exactly what every downstream miner
 * uses to decide a transcript is a real two-sided human conversation
 * (`hasAgentCallerLabels`). Left alone, that closes three loops:
 *
 *   1. sms-voice-corpus-miner → voice_corpus_examples → voice-profile-distiller
 *      → the APPROVED profile is injected back into the agent's own system
 *      prompt (relay-conversation composeSystemPrompt). Sandy learns to sound
 *      like Sandy, and the human brand voice drifts toward the model's.
 *   2. call-research-miner → research chunks presented as things real callers
 *      said.
 *   3. content/customer-insights-miner → the content engine treats generated
 *      agent dialogue as CUSTOMER insight and writes public copy from it.
 *
 * The discriminator is `transcription_provider = 'conversation_relay'`, which
 * the relay already stamps (relay-transcript.TRANSCRIPTION_PROVIDER) — no new
 * column, no new mechanism.
 *
 * NULL-SAFETY IS THE TRAP: the column post-dates most rows, so a bare
 * `whereNot('transcription_provider', 'conversation_relay')` renders
 * `NOT (col = ...)`, which evaluates UNKNOWN on NULL and would silently drop
 * EVERY legacy human call from all three corpora. Each assertion below pins the
 * NULL-safe form.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { TRANSCRIPTION_PROVIDER } = require('../services/voice-agent/relay-transcript');

// The exact value the relay stamps — if this ever changes, every exclusion
// below is silently defeated, so pin it here too.
test('the relay stamps the discriminator all three miners filter on', () => {
  expect(TRANSCRIPTION_PROVIDER).toBe('conversation_relay');
});

describe('1. brand-voice corpus (sms-voice-corpus-miner)', () => {
  const { eligibleCallTranscriptsQuery } = require('../services/sms-voice-corpus-miner');

  test('excludes conversation_relay transcripts, NULL-safely', () => {
    const { sql, bindings } = eligibleCallTranscriptsQuery({ since: new Date('2026-08-01T00:00:00Z') }).toSQL();
    expect(sql).toContain('"transcription_provider" is null or not "transcription_provider" =');
    expect(bindings).toContain('conversation_relay');
    // A bare NOT-equals would drop every legacy row (provider IS NULL).
    expect(sql).not.toMatch(/and not "transcription_provider" = \?\s*(and|$)/);
  });

  test('an AI-agent transcript passes every OTHER filter — the exclusion is the only thing stopping it', () => {
    const { hasAgentCallerLabels } = require('../services/sms-voice-corpus-miner');
    const relayTranscript = 'Caller: my ants are back\nAgent: I can get someone out to you.';
    expect(hasAgentCallerLabels(relayTranscript)).toBe(true);
  });
});

describe('2. call research (call-research-miner)', () => {
  const { eligibleCallsQuery } = require('../services/call-research-miner');

  test('excludes conversation_relay transcripts, NULL-safely', () => {
    const { sql, bindings } = eligibleCallsQuery().toSQL();
    expect(sql).toContain('"transcription_provider" is null or not "transcription_provider" =');
    expect(bindings).toContain('conversation_relay');
  });

  test('the exclusion survives the bake-off path too (onlyUnmined: false)', () => {
    const { sql } = eligibleCallsQuery({ onlyUnmined: false }).toSQL();
    expect(sql).toContain('"transcription_provider" is null or not "transcription_provider" =');
  });
});

describe('3. content insights (content/customer-insights-miner)', () => {
  const { gateCallRecord } = require('../services/content/customer-insights-miner')._internals;
  const base = {
    call_recording_consent_disclaimer_played: true,
    call_outcome: 'booked',
    transcription: 'Caller: my ants are back\nAgent: I can get someone out to you.',
  };

  test('an AI-agent call is refused, with its own run-summary reason', () => {
    const gate = gateCallRecord({ ...base, transcription_provider: 'conversation_relay' }, { consentColumnPresent: true });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('ai_agent_call');
  });

  test('a human call is still admitted, whether the provider is NULL or a real transcriber', () => {
    expect(gateCallRecord({ ...base, transcription_provider: null }, { consentColumnPresent: true }).ok).toBe(true);
    expect(gateCallRecord({ ...base, transcription_provider: 'twilio_builtin' }, { consentColumnPresent: true }).ok).toBe(true);
    // Legacy rows predate the column entirely.
    expect(gateCallRecord(base, { consentColumnPresent: true }).ok).toBe(true);
  });
});
