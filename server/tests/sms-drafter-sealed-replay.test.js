/**
 * Drafter sealed-replay seams — the three behaviors the sealed exam leans on:
 *   1. factsBlock override: a frozen snapshot replaces the live-context
 *      build EVERYWHERE (prompt + verifier), so replay is drift-free.
 *   2. routeOverride pins ONE provider with the cross-provider fallback
 *      disabled — provider A's exam can never be silently answered by B.
 *   3. fetchVoiceExemplars excludes sealed human replies — the drafter never
 *      studies from the exam's answer key, live or replay.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const llmCall = require('../services/llm/call');
const MODELS = require('../config/models');
const {
  generateGroundedDraft,
  buildUserPrompt,
  buildUserPromptFromFacts,
  buildFactsBlock,
  fetchVoiceExemplars,
} = require('../services/sms-shadow-drafter');

const CTX = {
  summary: 'Dana — Quarterly Pest, Venice',
  smsHistory: [],
  flags: [],
  upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19' }],
};

const DRAFT_JSON = JSON.stringify({ reply: 'Happy to check on that for you!', intended_actions: [], missing_info: null });

// A scripted Anthropic client for the verifier hop (createDeepMessage), which
// stays on Anthropic regardless of the drafting leg.
function makeVerifierClient() {
  return {
    messages: {
      create: () => Promise.resolve({ content: [{ text: JSON.stringify({ supported: true, violations: [] }) }] }),
    },
  };
}

beforeEach(() => {
  llmCall.dispatchWithFallback.mockReset();
  llmCall.dispatchWithFallback.mockResolvedValue({ ok: true, text: DRAFT_JSON, model: 'pinned-model' });
});

describe('factsBlock override — frozen replay', () => {
  test('the preset block reaches the prompt verbatim and the live context is never consulted', async () => {
    const frozen = 'CUSTOMER: FROZEN SNAPSHOT — balance $0, visit Thursday';
    const r = await generateGroundedDraft({
      client: makeVerifierClient(),
      inboundMessage: 'when are you coming?',
      intent: { intent: 'general' },
      schedulingIntent: false,
      factsBlock: frozen,
      routeOverride: { provider: MODELS.PROVIDER.ANTHROPIC, model: 'test-model' },
      // no context at all — a frozen replay must not need one
    });
    expect(r.parsed.reply).toMatch(/Happy to check/);
    const payload = llmCall.dispatchWithFallback.mock.calls[0][1];
    expect(payload.text).toContain(frozen);
  });

  test('without a preset block the live context builds the facts as before', async () => {
    await generateGroundedDraft({
      client: makeVerifierClient(),
      context: CTX,
      inboundMessage: 'hi',
      intent: { intent: 'general' },
      schedulingIntent: false,
      routeOverride: { provider: MODELS.PROVIDER.ANTHROPIC, model: 'test-model' },
    });
    const payload = llmCall.dispatchWithFallback.mock.calls[0][1];
    expect(payload.text).toContain('Dana — Quarterly Pest, Venice');
  });

  test('buildUserPrompt is exactly buildUserPromptFromFacts over the built block', () => {
    expect(buildUserPrompt(CTX, 'msg', { intent: 'general' }, false, ''))
      .toBe(buildUserPromptFromFacts(buildFactsBlock(CTX), 'msg', { intent: 'general' }, false, ''));
  });
});

describe('routeOverride — pinned single-provider leg', () => {
  test('pinned: the dispatch policy carries NO fallback', async () => {
    const route = { provider: MODELS.PROVIDER.OPENAI, model: 'exam-model' };
    await generateGroundedDraft({
      client: makeVerifierClient(),
      inboundMessage: 'hi',
      intent: { intent: 'general' },
      factsBlock: 'FACTS',
      routeOverride: route,
    });
    const policy = llmCall.dispatchWithFallback.mock.calls[0][0];
    expect(policy.primary).toBe(route);
    expect(policy).not.toHaveProperty('fallback');
  });

  test('unpinned live drafting keeps the cross-provider fallback', async () => {
    await generateGroundedDraft({
      client: makeVerifierClient(),
      context: CTX,
      inboundMessage: 'hi',
      intent: { intent: 'general' },
    });
    const policy = llmCall.dispatchWithFallback.mock.calls[0][0];
    expect(policy.fallback).toBeTruthy();
    expect(policy.fallback.provider).not.toBe(policy.primary.provider);
  });

  test('a revise pass stays on the pinned route', async () => {
    // First verify flags a violation, second passes — forces one revision.
    const verdicts = [
      { supported: false, violations: ['invents a time'] },
      { supported: true, violations: [] },
    ];
    const client = {
      messages: {
        create: () => Promise.resolve({ content: [{ text: JSON.stringify(verdicts.shift()) }] }),
      },
    };
    const route = { provider: MODELS.PROVIDER.ANTHROPIC, model: 'exam-model' };
    const r = await generateGroundedDraft({
      client,
      inboundMessage: 'hi',
      intent: { intent: 'general' },
      factsBlock: 'FACTS',
      routeOverride: route,
    });
    expect(r.passes).toBe(2);
    expect(llmCall.dispatchWithFallback).toHaveBeenCalledTimes(2); // draft + revise
    for (const call of llmCall.dispatchWithFallback.mock.calls) {
      expect(call[0].primary).toBe(route);
      expect(call[0]).not.toHaveProperty('fallback');
    }
  });
});

describe('fetchVoiceExemplars — sealed holdout exclusion', () => {
  function makeCorpusDb(rows = []) {
    const calls = [];
    const subqueries = [];
    const makeBuilder = (table) => {
      const b = { _table: table };
      const rec = (name) => (...args) => {
        calls.push([name, args, table]);
        if (name === 'whereNotIn') subqueries.push(args[1]);
        return b;
      };
      for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
        'orderBy', 'limit', 'select']) b[m] = rec(m);
      b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return b;
    };
    const dbi = (table) => makeBuilder(table);
    dbi.calls = calls;
    dbi.subqueries = subqueries;
    return dbi;
  }

  test('the corpus query excludes replies frozen into sms_sealed_eval_items', async () => {
    const dbi = makeCorpusDb([{ inbound_text: 'hi', reply_text: 'hello!' }]);
    const out = await fetchVoiceExemplars({ intent: 'general', dbi });
    expect(out).toHaveLength(1);
    const notIn = dbi.calls.find(([m, args]) => m === 'whereNotIn' && args[0] === 'source_id');
    expect(notIn).toBeTruthy();
    // The exclusion subquery reads the sealed-items table.
    expect(dbi.subqueries[0]._table).toBe('sms_sealed_eval_items');
  });

  test('an exclusion-query error fails safe to no exemplars (drafting never blocks on the corpus)', async () => {
    const dbi = () => { throw new Error('relation does not exist'); };
    const out = await fetchVoiceExemplars({ intent: 'general', dbi });
    expect(out).toEqual([]);
  });
});
