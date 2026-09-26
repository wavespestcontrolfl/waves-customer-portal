/**
 * Codex #4919 finding D: the /call-status and /recording-status FALLBACK
 * inserts (created_at is callback-RECEIPT time on these rows, not the
 * call's actual clock — see server/utils/call-timeline.js) now also stamp
 * the PROVIDER's own instant into metadata.provider_started_at /
 * provider_ended_at, so call-timeline.js can read the real one instead of
 * backing it out of duration_seconds.
 *
 * A full functional run through the recovery/fallback insert transactions
 * (advisory locks, a mocked Twilio SDK client, multiple DB round-trips) is
 * impractical to mock end-to-end — this suite's own established pattern for
 * these branches (call-shadow-callback-hold-arming.test.js,
 * admin-call-recordings-process-conflict.test.js) pins the write STRUCTURALLY
 * via the source text, plus a direct unit test of the exported parsing
 * helper.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
  syncVoiceMessageForCall: jest.fn(() => Promise.resolve()),
}));
jest.mock('../models/db', () => jest.fn());

const voiceRouter = require('../routes/twilio-voice-webhook');
const processorSrc = require('fs').readFileSync(require.resolve('../routes/twilio-voice-webhook'), 'utf8');

describe('parseProviderTimestamp — defensive parsing, invalid/missing omitted', () => {
  const { parseProviderTimestamp } = voiceRouter._test;

  test('a Twilio RFC-2822 Timestamp string parses to ISO', () => {
    expect(parseProviderTimestamp('Sat, 26 Sep 2026 18:05:00 +0000')).toBe('2026-09-26T18:05:00.000Z');
  });

  test('a Twilio Call resource Date property (startTime/endTime) parses to ISO', () => {
    expect(parseProviderTimestamp(new Date('2026-09-26T18:05:00Z'))).toBe('2026-09-26T18:05:00.000Z');
  });

  test('missing/empty/invalid values are omitted (null), never thrown', () => {
    expect(parseProviderTimestamp(undefined)).toBeNull();
    expect(parseProviderTimestamp(null)).toBeNull();
    expect(parseProviderTimestamp('')).toBeNull();
    expect(parseProviderTimestamp('not-a-date')).toBeNull();
  });
});

describe('/recording-status recovery insert writes provider_started_at/provider_ended_at (codex #4919 finding D)', () => {
  test('provider_started_at/provider_ended_at are computed from the fetched Call resource, with RecordingStartTime as a start hint ONLY when that fetch failed', () => {
    const anchor = "const twilioCall = (!requestFrom || !requestTo) ? await fetchTwilioCall(primaryCallSid) : null;";
    const anchorAt = processorSrc.indexOf(anchor);
    expect(anchorAt).toBeGreaterThan(-1);
    const insertAt = processorSrc.indexOf('await trx(\'call_log\').insert({', anchorAt);
    expect(insertAt).toBeGreaterThan(anchorAt);
    const section = processorSrc.slice(anchorAt, insertAt + 1200);
    expect(section).toContain('const providerStartedAt = parseProviderTimestamp(twilioCall?.startTime)');
    // RecordingStartTime is a start hint ONLY when the Call fetch failed
    // (no twilioCall at all) — never overriding a successfully fetched
    // startTime.
    expect(section).toContain("(!twilioCall ? parseProviderTimestamp(RecordingStartTime) : null)");
    expect(section).toContain('const providerEndedAt = parseProviderTimestamp(twilioCall?.endTime);');
    expect(section).toContain('provider_started_at: providerStartedAt');
    expect(section).toContain('provider_ended_at: providerEndedAt');
  });

  test('RecordingStartTime is destructured from the /recording-status webhook body', () => {
    expect(processorSrc).toContain(
      "const { CallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus, RecordingStartTime } = req.body;",
    );
  });
});

describe('/call-status fallback inserts write provider_ended_at from Twilio\'s Timestamp param (codex #4919 finding D)', () => {
  test('Timestamp is destructured and parsed once, ahead of both insert paths', () => {
    const destructureAt = processorSrc.indexOf(
      "const { CallSid, CallStatus, CallDuration, From, To, Direction, ErrorCode, ErrorMessage, Timestamp } = req.body;",
    );
    expect(destructureAt).toBeGreaterThan(-1);
    const parseAt = processorSrc.indexOf('const providerEndedAt = parseProviderTimestamp(Timestamp);', destructureAt);
    expect(parseAt).toBeGreaterThan(destructureAt);
  });

  test('the sandbox fallback insert includes provider_ended_at when present', () => {
    // Scoped to the /call-status handler itself (its own Timestamp
    // destructure), not the unrelated earlier VOICE_RELAY_SANDBOX_SOURCE
    // insert in a different handler.
    const handlerAt = processorSrc.indexOf(
      "const { CallSid, CallStatus, CallDuration, From, To, Direction, ErrorCode, ErrorMessage, Timestamp } = req.body;",
    );
    expect(handlerAt).toBeGreaterThan(-1);
    const sandboxAt = processorSrc.indexOf('source: VOICE_RELAY_SANDBOX_SOURCE,', handlerAt);
    expect(sandboxAt).toBeGreaterThan(handlerAt);
    const section = processorSrc.slice(sandboxAt, sandboxAt + 300);
    expect(section).toContain('relay_sandbox: true');
    expect(section).toContain("...(providerEndedAt ? { provider_ended_at: providerEndedAt } : {})");
  });

  test('the regular inbound fallback insert includes provider_ended_at when present', () => {
    // Anchored AFTER the sandbox insert's own return (`const customer = From`
    // starts the regular fallback path immediately below it), so this does
    // not accidentally re-match the sandbox insert's own provider_ended_at.
    const afterSandboxAt = processorSrc.indexOf('const customer = From');
    expect(afterSandboxAt).toBeGreaterThan(-1);
    const fallbackMetaAt = processorSrc.indexOf("source: 'status_callback',", afterSandboxAt);
    expect(fallbackMetaAt).toBeGreaterThan(afterSandboxAt);
    const section = processorSrc.slice(fallbackMetaAt, fallbackMetaAt + 120);
    expect(section).toContain("...(providerEndedAt ? { provider_ended_at: providerEndedAt } : {})");
    // The recordTouchpoint metadata just below (a DIFFERENT object, plain
    // JS not stringified) is deliberately NOT asserted here — it is not a
    // call_log row and out of this finding's scope.
  });
});
