/**
 * services/llm/anthropic-wire.js — request sizing that must survive an
 * Opus 5.5 flip: a max_tokens floor for models that think by default, and
 * the MODEL_ANTHROPIC_EFFORT pin for models that accept every effort level.
 * Patterns come from the real registry; a registry mocked without them must
 * leave requests unchanged (28 suites mock config/models).
 */
const MODELS = require('../config/models');
const { anthropicMaxTokens, anthropicEffortFor, anthropicEffortConfig, THINKING_FLOOR_TOKENS } = require('../services/llm/anthropic-wire');

describe('anthropicMaxTokens', () => {
  test('raises the cap to the floor on models that think by default (Opus 5+, Fable, Mythos)', () => {
    for (const model of ['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
      expect(anthropicMaxTokens(model, 200)).toBe(THINKING_FLOOR_TOKENS);
      expect(anthropicMaxTokens(model, 20000)).toBe(20000);
      expect(anthropicMaxTokens(model, undefined)).toBe(THINKING_FLOOR_TOKENS);
    }
  });

  test("leaves today's models unchanged — Opus 4.x, Sonnet (tuned against its own thinking), Haiku", () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-1', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'test-model', undefined]) {
      expect(anthropicMaxTokens(model, 200)).toBe(200);
      expect(anthropicMaxTokens(model, undefined)).toBeUndefined();
    }
  });

  test('the floor stays under the SDK non-streaming ceiling (~21k tokens without an explicit timeout)', () => {
    expect(THINKING_FLOOR_TOKENS).toBeLessThan(21000);
  });
});

describe('anthropicEffortFor / anthropicEffortConfig', () => {
  afterEach(() => { delete MODELS.ANTHROPIC_EFFORT; });

  test('unpinned → undefined / {} for every model', () => {
    expect(anthropicEffortFor('claude-opus-5-5')).toBeUndefined();
    expect(anthropicEffortConfig('claude-opus-5-5')).toEqual({});
  });

  test('pinned → only models that accept all five levels (Opus 4.7+, Sonnet 5+, Fable, Mythos)', () => {
    MODELS.ANTHROPIC_EFFORT = 'xhigh';
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
      expect(anthropicEffortFor(model)).toBe('xhigh');
      expect(anthropicEffortConfig(model)).toEqual({ output_config: { effort: 'xhigh' } });
    }
    // Opus 4.5 takes low/medium/high only, Opus 4.6 has no xhigh; Haiku 4.5,
    // pre-5 Sonnets and Opus 4 / 4.1 reject the field.
    for (const model of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'test-model']) {
      expect(anthropicEffortFor(model)).toBeUndefined();
      expect(anthropicEffortConfig(model)).toEqual({});
    }
  });

  test('spreads into a direct request next to model and max_tokens', () => {
    MODELS.ANTHROPIC_EFFORT = 'high';
    expect({ model: 'claude-opus-5-5', ...anthropicEffortConfig('claude-opus-5-5'), max_tokens: anthropicMaxTokens('claude-opus-5-5', 500) })
      .toEqual({ model: 'claude-opus-5-5', output_config: { effort: 'high' }, max_tokens: THINKING_FLOOR_TOKENS });
  });
});

describe('a registry mocked without the patterns', () => {
  test('passes every request through unchanged', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/models', () => ({ FLAGSHIP: 'test-model', ANTHROPIC_EFFORT: 'high' }));
      const wire = require('../services/llm/anthropic-wire');
      expect(wire.anthropicMaxTokens('claude-opus-5-5', 200)).toBe(200);
      expect(wire.anthropicEffortConfig('claude-opus-5-5')).toEqual({});
    });
  });
});
