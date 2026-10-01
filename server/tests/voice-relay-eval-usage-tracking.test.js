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

  // PR #4946 review (r9): a round that REJECTS (stream timeout, abort,
  // provider error) may already have spent tokens no usage block reports —
  // it is counted as incomplete, and the run's summary says so.
  test('a rejected model round marks the usage incomplete instead of silently reading cheaper', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    script.push(
      say('This looks like a recording — I will let you go.', { input_tokens: 120, output_tokens: 18, cache_creation_input_tokens: 4200, cache_read_input_tokens: 0 }),
      new Error('stream timed out'),
    );
    const result = await replay.runScenario(scenario);
    expect(result.usage.rounds).toBe(1);
    expect(result.usage.incompleteRounds).toBeGreaterThanOrEqual(1);
    const summary = replay.summarize([result]);
    expect(summary.usage.incompleteRounds).toBe(result.usage.incompleteRounds);
    expect(summary.usage.complete).toBe(false);
    expect(replay.summaryLine(summary)).toMatch(/usage INCOMPLETE/);
  });

  // Codex r11 on #4946: a usage block whose counters do not parse ({} or
  // renamed fields) is not telemetry — the round is incomplete, never zeros.
  test('a malformed usage block marks the round incomplete instead of adding zeros', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    script.push(say('This looks like a recording.', {}), say('Take care.', { inputTokens: 40, outputTokens: 6 }));
    const result = await replay.runScenario(scenario);
    expect(result.usage.rounds).toBe(0);
    expect(result.usage.incompleteRounds).toBe(2);
    expect(replay.summarize([result]).usage.complete).toBe(false);
  });

  test.each([
    ['both cache counters missing', {}],
    ['cache read missing', { cache_creation_input_tokens: 0 }],
    ['cache write missing', { cache_read_input_tokens: 0 }],
    ['cache read renamed', { cache_creation_input_tokens: 0, cached_tokens: 30 }],
    ['cache write null', { cache_read_input_tokens: 0, cache_creation_input_tokens: null }],
  ])('%s stays incomplete through the real relay and benchmark summaries', async (_label, cache) => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    const usage = { input_tokens: 100, output_tokens: 10, ...cache };
    script.push(say('This looks like a recording.', usage), say('Take care.', usage));
    const result = await replay.runScenario(scenario);
    expect(result.modelRounds).toBe(2);
    expect(result.usage).toMatchObject({ rounds: 0, incompleteRounds: 2 });
    const summary = replay.summarize([result]);
    expect(summary.usage).toMatchObject({ complete: false, cacheHitRate: null });
    const { summarizeCondition } = require('../scripts/run-voice-relay-benchmark');
    const benchmark = summarizeCondition('partial-cache', [{
      condition: 'partial-cache', ranOk: true, inconclusive: false,
      result: { summary, attempts: [{ status: 'pass', summary }] },
    }]);
    expect(benchmark.usage).toMatchObject({ complete: false, rounds: 0, incompleteRounds: 2, cacheHitRate: null });
  });

  test('explicit zero input, output, and cache counters remain measured complete rounds', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    script.push(say('This looks like a recording.', usage), say('Take care.', usage));
    const result = await replay.runScenario(scenario);
    expect(result.usage).toMatchObject({ rounds: 2, incompleteRounds: 0, cacheReadRounds: 0 });
    expect(replay.summarize([result]).usage).toMatchObject({ complete: true, cacheHitRate: 0 });
  });

  test.each(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .flatMap((field) => [
      ['negative', -1], ['negative fraction', -0.5], ['fraction', 1.5],
      ['numeric string', '2'], ['boolean', true], ['array', [2]],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ].map(([label, value]) => [field, label, value])))('%s with a %s raw count stays incomplete through benchmark aggregation', async (field, _label, value) => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, [field]: value };
    script.push(say('This looks like a recording.', usage), say('Take care.', usage));
    const result = await replay.runScenario(scenario);
    expect(result.modelRounds).toBe(2);
    expect(result.usage).toMatchObject({
      rounds: 0, incompleteRounds: 2, cacheReadRounds: 0,
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0,
    });
    const summary = replay.summarize([result]);
    expect(summary.usage).toMatchObject({ complete: false, cacheHitRate: null });
    const { summarizeCondition } = require('../scripts/run-voice-relay-benchmark');
    const benchmark = summarizeCondition('invalid-count', [{
      condition: 'invalid-count', ranOk: true, inconclusive: false,
      result: { summary, attempts: [{ status: 'pass', summary }] },
    }]);
    expect(benchmark.usage).toMatchObject({
      complete: false, rounds: 0, incompleteRounds: 2, cacheReadRounds: 0, cacheHitRate: null,
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    });
  });

  test('a malformed round cannot reduce valid measured usage or inflate its cache-hit rate', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    script.push(
      say('This looks like a recording.', { input_tokens: 120, output_tokens: 18, cache_creation_input_tokens: 4200, cache_read_input_tokens: 0 }),
      say('Take care.', { input_tokens: -40, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: -4200 }),
    );
    const result = await replay.runScenario(scenario);
    expect(result.usage).toMatchObject({
      rounds: 1, incompleteRounds: 1, cacheReadRounds: 0,
      input_tokens: 120, output_tokens: 18, cached_input_tokens: 0, cache_write_tokens: 4200,
    });
    expect(replay.summarize([result]).usage).toMatchObject({ complete: false, cacheHitRate: 0 });
  });

  // Codex pre-push on #4946: successful rounds with no usage block at all make
  // the standalone eval summary incomplete too (same rule as the runner).
  test('successful rounds without a usage block mark the eval summary incomplete', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('robocall');
    script.push(say('This looks like a recording.'), say('Take care.'));
    const result = await replay.runScenario(scenario);
    const summary = replay.summarize([result]);
    expect(summary.modelRounds).toBeGreaterThan(0);
    expect(summary.usage.missingUsageRounds).toBe(summary.modelRounds);
    expect(summary.usage.complete).toBe(false);
    expect(replay.summaryLine(summary)).toMatch(/successful round\(s\) without complete usage/);
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
