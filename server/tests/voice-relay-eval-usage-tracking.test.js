/**
 * Sandy benchmark — cache-hit logging (this PR). Proves the real thing, not
 * just that nothing broke: per-round Anthropic `usage` (input/output/cache
 * read/cache creation tokens) threads from the relay's own `finalMessage()`
 * through voice-relay-replay.js's `installHarness` patch into both a single
 * scenario's `record.usage` and the run's `summary.usage`, including the
 * `cacheHitRate` computed from real rounds — never the old always-"unknown"
 * `cacheHypothesis` guess.
 *
 * Same real-harness pattern as voice-relay-eval-new-scenario-checks.test.js:
 * the ACTUAL fixture scenario runs through the real RelayConversation loop
 * with a scripted (never live) model.
 */

jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db called'); });
  fn.raw = jest.fn(() => { throw new Error('db.raw called'); });
  fn.transaction = jest.fn(() => { throw new Error('db.transaction called'); });
  fn.destroy = jest.fn();
  fn.fn = { now: () => 'now()' };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(async () => { throw new Error('capture floor called'); }),
  stampCustomerPreferredLanguage: jest.fn(async () => false),
}));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-profile-distiller', () => ({ MAX_PROFILE_CHARS: 4000, getApprovedVoiceProfile: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || 'none') }));

const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'voice-relay-eval', 'scenarios.json');

let script;
function mockSdk() {
  jest.doMock('@anthropic-ai/sdk', () => {
    class Messages {
      stream() {
        const next = script.shift();
        if (next && next.throwSync) throw next.throwSync;
        return {
          on() {},
          finalMessage: async () => {
            if (!next) throw new Error('script exhausted');
            if (next instanceof Error) throw next;
            return next;
          },
        };
      }
    }
    return function AnthropicMock() { return { messages: new Messages() }; };
  });
}

const say = (text, usage) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', ...(usage ? { usage } : {}) });

function loadScenario(id) {
  const replay = require('../services/eval/voice-relay-replay');
  const scenario = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`fixture scenario not found: ${id}`);
  return { replay, scenario };
}

beforeEach(() => { jest.resetModules(); script = []; });

describe('voice relay eval — per-round Anthropic usage threading (cache-hit logging)', () => {
  test('a scenario with a cache-read round on one turn and none on the other reports real per-round totals and a real cacheHitRate — never "unknown"', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');

    // Turn 1: a cache MISS (a cache write, no cache read — first turn, cold
    // prefix). Turn 2: a cache HIT (a cache read, no new write).
    script.push(
      say('This looks like a recording — I will let you go.', {
        input_tokens: 120, output_tokens: 18, cache_creation_input_tokens: 4200, cache_read_input_tokens: 0,
      }),
      say('Take care.', {
        input_tokens: 40, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 4200,
      }),
    );
    const result = await replay.runScenario(scenario);

    expect(result.error).toBeUndefined();
    // Per-scenario record: both rounds counted, only the second carried a
    // cache read.
    expect(result.usage).toBeTruthy();
    expect(result.usage.rounds).toBe(2);
    expect(result.usage.cacheReadRounds).toBe(1);
    expect(result.usage.input_tokens).toBe(160);
    expect(result.usage.output_tokens).toBe(24);
    expect(result.usage.cache_write_tokens).toBe(4200);
    expect(result.usage.cached_input_tokens).toBe(4200);

    // Run-level summary sums the same fields and computes a REAL cache-hit
    // rate — 1 of 2 rounds — never the old always-"unknown" cacheHypothesis
    // guess, and never left undefined.
    const { summaryLine, summarize } = replay;
    const summary = summarize([result]);
    expect(summary.usage.rounds).toBe(2);
    expect(summary.usage.cacheReadRounds).toBe(1);
    expect(summary.usage.cacheHitRate).toBeCloseTo(0.5);
    expect(summaryLine(summary)).toMatch(/cacheHitRate=50\.0%/);
    expect(summaryLine(summary)).toMatch(/cacheRead=4200/);
  });

  test('a scripted message with no usage block at all (most of this harness\'s own tests) contributes nothing and never divides by zero', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    script.push(say('This looks like a recording.'), say('Take care.'));
    const result = await replay.runScenario(scenario);

    expect(result.error).toBeUndefined();
    expect(result.usage.rounds).toBe(0);
    expect(result.usage.cacheReadRounds).toBe(0);
    expect(result.usage.input_tokens).toBe(0);

    const summary = replay.summarize([result]);
    expect(summary.usage.rounds).toBe(0);
    // null, never 0 or NaN — no evidence either way, not a confirmed zero.
    expect(summary.usage.cacheHitRate).toBeNull();
    expect(replay.summaryLine(summary)).not.toMatch(/cacheHitRate/);
  });
});
