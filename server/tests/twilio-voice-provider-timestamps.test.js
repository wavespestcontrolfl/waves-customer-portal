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

// codex #4919 finding D round-6 P1: reproduces the /call-status
// existing-row UPDATE path's write CONDITION directly (providerEndedAt &&
// status === CallStatus) against the router's own exported
// nextCallStatus/TERMINAL_CALL_STATUSES, so the "completed is absorbing"
// precedence this update must respect is proven against the real
// precedence function, not a re-implementation of it.
describe('the existing-row metadata write condition respects nextCallStatus precedence (codex #4919 finding D round-6 P1)', () => {
  const { nextCallStatus, TERMINAL_CALL_STATUSES, parseProviderTimestamp } = voiceRouter._test;

  function wouldWriteProviderEndedAt(existingStatus, CallStatus, Timestamp) {
    const providerEndedAt = TERMINAL_CALL_STATUSES.has(CallStatus) ? parseProviderTimestamp(Timestamp) : null;
    const status = nextCallStatus(existingStatus, CallStatus);
    return Boolean(providerEndedAt && status === CallStatus);
  }

  test('a LATE terminal callback for an ALREADY-completed call must NOT overwrite provider_ended_at — completed is absorbing', () => {
    expect(wouldWriteProviderEndedAt('completed', 'busy', 'Sat, 26 Sep 2026 20:00:00 +0000')).toBe(false);
    expect(wouldWriteProviderEndedAt('completed', 'no-answer', 'Sat, 26 Sep 2026 20:00:00 +0000')).toBe(false);
    expect(wouldWriteProviderEndedAt('completed', 'failed', 'Sat, 26 Sep 2026 20:00:00 +0000')).toBe(false);
  });

  test('completion arriving on a row a non-terminal event inserted DOES write it', () => {
    expect(wouldWriteProviderEndedAt('ringing', 'completed', 'Sat, 26 Sep 2026 18:05:00 +0000')).toBe(true);
    expect(wouldWriteProviderEndedAt('in-progress', 'completed', 'Sat, 26 Sep 2026 18:05:00 +0000')).toBe(true);
  });

  test('a genuine terminal-to-terminal advance (never completed) still writes it', () => {
    expect(wouldWriteProviderEndedAt('busy', 'no-answer', 'Sat, 26 Sep 2026 18:05:00 +0000')).toBe(true);
  });

  test('a non-terminal event never writes it, regardless of the existing status', () => {
    expect(wouldWriteProviderEndedAt('ringing', 'in-progress', 'Sat, 26 Sep 2026 18:05:00 +0000')).toBe(false);
    expect(wouldWriteProviderEndedAt('completed', 'in-progress', 'Sat, 26 Sep 2026 18:05:00 +0000')).toBe(false);
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
  // codex #4919 finding D round-5 P1: /call-status fires on EVERY lifecycle
  // event (ringing, in-progress, completed…), not just the last one — a
  // non-terminal event's own Timestamp is not the call's end and must never
  // be stamped as provider_ended_at.
  test('Timestamp is only read as provider_ended_at for a TERMINAL CallStatus, gated once ahead of both insert paths', () => {
    const destructureAt = processorSrc.indexOf(
      "const { CallSid, CallStatus, CallDuration, From, To, Direction, ErrorCode, ErrorMessage, Timestamp } = req.body;",
    );
    expect(destructureAt).toBeGreaterThan(-1);
    const parseAt = processorSrc.indexOf(
      "const providerEndedAt = TERMINAL_CALL_STATUSES.has(CallStatus) ? parseProviderTimestamp(Timestamp) : null;",
      destructureAt,
    );
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

  // codex #4919 finding D round-5 P1: a row this fallback inserted on an
  // EARLIER non-terminal event (no provider_ended_at stamped then, per the
  // gate above) must still get it once completion actually lands — on the
  // EXISTING-row update path, not just at insert time.
  test('the existing-row UPDATE path merges provider_ended_at into metadata via COALESCE, never a wholesale overwrite, and only when providerEndedAt is present AND accepted', () => {
    const handlerAt = processorSrc.indexOf(
      "const { CallSid, CallStatus, CallDuration, From, To, Direction, ErrorCode, ErrorMessage, Timestamp } = req.body;",
    );
    expect(handlerAt).toBeGreaterThan(-1);
    const existingAt = processorSrc.indexOf('if (existing) {', handlerAt);
    expect(existingAt).toBeGreaterThan(handlerAt);
    const returnAt = processorSrc.indexOf('return;', existingAt);
    expect(returnAt).toBeGreaterThan(existingAt);
    const section = processorSrc.slice(existingAt, returnAt);
    // codex #4919 finding D round-6 P1: gated on status === CallStatus too —
    // a late busy/failed/no-answer callback for an ALREADY-completed call
    // has nextCallStatus REJECT its status (the same "completed is
    // absorbing" precedence rule the status/duration fields above already
    // respect), and must not clobber the real completion's
    // provider_ended_at with this stale event's own, later Timestamp.
    expect(section).toContain("...(providerEndedAt && status === CallStatus ? {");
    expect(section).toContain("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
    expect(section).toContain('provider_ended_at: providerEndedAt');
    // status/duration_seconds/updated_at are unconditional; metadata is the
    // ONLY conditionally-spread key, so a non-terminal event's update never
    // touches metadata at all.
    expect(section).toMatch(/status,\s*\n\s*duration_seconds: duration,\s*\n\s*updated_at: new Date\(\),/);
  });
});
