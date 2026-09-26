jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const db = require('../models/db');
const { dispatchWithFallback } = require('../services/llm/call');
const generator = require('../services/seo/seo-action-generator');

// Fluent query-builder stub: every chain method returns itself; `then` resolves
// the awaited result, `update` resolves independently (mirrors knex).
function makeQuery(result, updateSpy) {
  const q = {
    where: jest.fn(() => q),
    whereIn: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    limit: jest.fn(() => q),
    select: jest.fn(() => q),
    sum: jest.fn(() => q),
    groupBy: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    update: updateSpy || jest.fn(() => Promise.resolve(1)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('SeoActionGenerator.generateAIDrafts — validate hook rejects blank title/meta (Codex #4884)', () => {
  const action = { id: 'act-1', url: 'https://wavespestcontrol.com/bradenton-pest-control', detail: '{}' };

  function wireDb(updateSpy) {
    db.mockImplementation((table) => {
      if (table === 'seo_actions') return makeQuery([action], updateSpy);
      if (table === 'gsc_query_page_map') return makeQuery([]);
      throw new Error(`unexpected table ${table}`);
    });
  }

  test('blank title/meta_description → validate rejects, draft dispatch fails, no ai_draft written', async () => {
    const updateSpy = jest.fn(() => Promise.resolve(1));
    wireDb(updateSpy);
    // Both routes reject via the caller's validate hook (blank strings) → all_providers_failed.
    dispatchWithFallback.mockImplementation(async (policy, payload, opts) => {
      const result = { ok: true, json: { title: '', meta_description: '' }, model: 'test-model' };
      const rejection = opts && typeof opts.validate === 'function' ? opts.validate(result) : null;
      if (rejection) return { ok: false, reason: rejection };
      return result;
    });

    const res = await generator.generateAIDrafts(['act-1']);

    expect(res.drafts_generated).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('non-string title (object) → validate rejects, no ai_draft written', async () => {
    const updateSpy = jest.fn(() => Promise.resolve(1));
    wireDb(updateSpy);
    dispatchWithFallback.mockImplementation(async (policy, payload, opts) => {
      const result = { ok: true, json: { title: { unexpected: true }, meta_description: 'A real Bradenton pest control meta description that reads fine.' }, model: 'test-model' };
      const rejection = opts && typeof opts.validate === 'function' ? opts.validate(result) : null;
      if (rejection) return { ok: false, reason: rejection };
      return result;
    });

    const res = await generator.generateAIDrafts(['act-1']);

    expect(res.drafts_generated).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('a slightly-long (but non-empty) title/meta is NOT rejected — length ranges are guidance, not enforced', async () => {
    const updateSpy = jest.fn(() => Promise.resolve(1));
    wireDb(updateSpy);
    const longTitle = 'A'.repeat(90); // well outside the prompt's 50-60 char guidance
    dispatchWithFallback.mockImplementation(async (policy, payload, opts) => {
      const result = { ok: true, json: { title: longTitle, meta_description: 'short meta' }, model: 'test-model' };
      const rejection = opts && typeof opts.validate === 'function' ? opts.validate(result) : null;
      if (rejection) return { ok: false, reason: rejection };
      return result;
    });

    const res = await generator.generateAIDrafts(['act-1']);

    expect(res.drafts_generated).toBe(1);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      ai_draft: JSON.stringify({ title: longTitle, meta_description: 'short meta' }),
    }));
  });

  test('a usable non-blank title/meta is accepted and stored', async () => {
    const updateSpy = jest.fn(() => Promise.resolve(1));
    wireDb(updateSpy);
    const json = { title: 'Bradenton Pest Control | Fast, Local Service', meta_description: 'Same-week pest control in Bradenton FL. Local techs, honest pricing, guaranteed results. Call today.' };
    dispatchWithFallback.mockImplementation(async (policy, payload, opts) => {
      const result = { ok: true, json, model: 'test-model' };
      const rejection = opts && typeof opts.validate === 'function' ? opts.validate(result) : null;
      if (rejection) return { ok: false, reason: rejection };
      return result;
    });

    const res = await generator.generateAIDrafts(['act-1']);

    expect(res.drafts_generated).toBe(1);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ ai_draft: JSON.stringify(json) }));
  });
});
