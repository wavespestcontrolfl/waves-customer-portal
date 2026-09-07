jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ configured: false, request: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const db = require('../models/db');
const Anthropic = require('@anthropic-ai/sdk');
const dataforseo = require('../services/seo/dataforseo');
const { LLMMentionProber, buildDashboard } = require('../services/seo/llm-mention-prober');
const { summarizeObservations, isOwnedUrl, citationMatchesPage } = require('../services/seo/aeo-measurement');
const benchmark = require('../data/aeo-benchmark-v1.json');
const query = benchmark.questions[0].query;
const WAVES = 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/';
const OTHER = 'https://example.org/reference';
const measured = (extra = {}) => ({
  query, llm_platform: 'chatgpt', model_version: 'test-search', check_date: '2026-08-01',
  measurement_version: 2, answer_available: true, citations_complete: true,
  waves_mentioned: false, waves_cited_urls: [], ...extra,
});

let savedFetch;
let savedEnv;
beforeEach(() => {
  savedFetch = global.fetch;
  savedEnv = { ...process.env };
  global.fetch = jest.fn();
  jest.clearAllMocks();
});
afterEach(() => { global.fetch = savedFetch; process.env = savedEnv; });

test('source-only results, prose URLs, brand mentions and linked citations stay distinct', () => {
  const prober = new LLMMentionProber();
  expect(prober.parse({ text: 'Try a local operator.', sourceUrls: [WAVES] })).toMatchObject({ wavesMentioned: false, wavesCitedUrls: [], sourceUrls: [WAVES] });
  expect(prober.parse({ text: `Reference: ${WAVES}` })).toMatchObject({ wavesMentioned: false, wavesCitedUrls: [] });
  expect(prober.parse({ text: 'Waves Pest Control serves this area.' })).toMatchObject({ wavesMentioned: true, wavesCitedUrls: [] });
  expect(prober.parse({ text: 'Identify the pest first.', citedUrls: [WAVES, WAVES] })).toMatchObject({ wavesMentioned: false, wavesCitedUrls: [WAVES] });
});

test('URL ownership rejects misleading hosts, query strings and unsafe schemes', () => {
  expect(isOwnedUrl(WAVES)).toBe(true);
  for (const url of ['https://wavespestcontrol.com.evil.example/', 'https://example.org/?site=wavespestcontrol.com', 'javascript:alert(1)', 'https://user:password@wavespestcontrol.com/']) {
    expect(isOwnedUrl(url)).toBe(false);
  }
  expect(citationMatchesPage(`${WAVES}?utm_source=search#answer`, '/pest-control-sarasota-fl')).toBe(true);
  expect(citationMatchesPage(WAVES, '/pest-control-bradenton-fl/')).toBe(false);
});

test('rates exclude legacy, no-answer and unresolved evidence rather than recording misses', () => {
  const result = summarizeObservations([
    measured({ waves_mentioned: true }), measured({ waves_cited_urls: JSON.stringify([WAVES]) }),
    measured(), measured({ measurement_version: null, waves_mentioned: true, waves_cited_urls: [WAVES] }),
    measured({ answer_available: false }), measured({ citations_complete: false }),
  ]);
  expect(result).toEqual({ total: 6, measured: 3, mentioned: 1, cited: 1, mentionRate: 33, citationRate: 33, legacy: 1, noAnswer: 1, unresolved: 1 });
  expect(summarizeObservations([])).toMatchObject({ citationRate: null, mentionRate: null });
});

test('the backlink dashboard excludes legacy source-only rows from both rates', async () => {
  const monitor = require('../services/seo/backlink-monitor');
  const basic = jest.spyOn(monitor, 'getDashboard').mockResolvedValue({});
  const rows = [measured({ waves_mentioned: true }), measured({ waves_cited_urls: [WAVES] }),
    measured({ measurement_version: null, waves_mentioned: true, waves_cited_urls: [WAVES] })];
  db.mockImplementation(table => {
    const results = table === 'seo_llm_mentions' ? rows : [];
    const builder = { then: (resolve, reject) => Promise.resolve(results).then(resolve, reject), first: async () => ({ count: '0' }) };
    for (const method of ['where', 'whereRaw', 'orderBy', 'orderByRaw', 'limit', 'count']) builder[method] = () => builder;
    return builder;
  });
  try {
    expect((await monitor.getFullDashboard()).llmStats).toMatchObject({ total: 3, measured: 2, mentionRate: 50, citationRate: 50, legacy: 1 });
  } finally { basic.mockRestore(); }
});

test('the strategy tool reports unavailable evidence as unknown instead of a citation miss', async () => {
  const monitor = require('../services/seo/backlink-monitor');
  const scan = jest.spyOn(monitor, 'checkLLMMentions').mockResolvedValue({});
  db.mockReturnValue({ orderBy: () => ({ limit: async () => [
    measured({ waves_cited_urls: [WAVES] }), measured({ measurement_version: null, waves_mentioned: true, waves_cited_urls: [WAVES] }),
  ] }) });
  try {
    const { executeBacklinkTool } = require('../services/seo/backlink-strategy-tools');
    const { checks } = await executeBacklinkTool('check_llm_mentions', {});
    expect(checks[0]).toMatchObject({ measurement_available: true, waves_mentioned: false, waves_cited: true, waves_cited_urls: [WAVES] });
    expect(checks[1]).toMatchObject({ measurement_available: false, waves_mentioned: null, waves_cited: null, waves_cited_urls: [] });
  } finally { scan.mockRestore(); }
});

test('the frozen benchmark excludes custom queries and does not blend provider model versions', () => {
  const rows = [measured({ waves_cited_urls: [WAVES] }), measured({ model_version: 'previous-search' }), measured({ query: 'custom question', waves_cited_urls: [WAVES] })];
  const dashboard = buildDashboard(rows, benchmark.questions);
  expect(dashboard.benchmark).toMatchObject({ questions: 40, activeQuestions: 40, observedQuestions: 1, measured: 2, citationRate: 50 });
  expect(dashboard.benchmark.byPlatform).toHaveLength(2);
  expect(dashboard.grid[0].target_cited).toBe(true);
  expect(dashboard.summary.measured).toBe(3);
});

test('Gemini attributes only supported chunks and ignores thinking text', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{
    content: { parts: [{ thought: true, text: 'Waves Pest Control' }, { text: 'Check the species first.' }] },
    groundingMetadata: {
      groundingChunks: [{ web: { uri: WAVES } }, { web: { uri: OTHER } }],
      groundingSupports: [{ segment: { text: 'Check the species first.' }, groundingChunkIndices: [1] }],
    },
  }] }) });
  const probe = await new LLMMentionProber().probeGemini(query);
  expect(probe).toMatchObject({ text: 'Check the species first.', citedUrls: [OTHER], sourceUrls: [WAVES, OTHER] });
});

test('Google redirect resolution never fetches a cited destination or forwards credentials', async () => {
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/test';
  global.fetch.mockResolvedValue({ status: 302, headers: new Headers({ location: WAVES }) });
  const prober = new LLMMentionProber();
  expect(await prober.resolveGoogleCitations([redirect])).toEqual({ citedUrls: [WAVES], complete: true });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(redirect, expect.objectContaining({ redirect: 'manual' }));
  expect(global.fetch.mock.calls[0][1].headers).toBeUndefined();
  global.fetch.mockRejectedValue(new Error('timeout'));
  expect(await prober.resolveGoogleCitations([redirect])).toEqual({ citedUrls: [], complete: false });
});

test('Perplexity search_results and unused citation entries cannot manufacture a citation', async () => {
  process.env.PERPLEXITY_API_KEY = 'test-key';
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({
    choices: [{ message: { content: 'Identify before treating.[2]' } }],
    citations: [WAVES, OTHER], search_results: [{ url: WAVES }],
  }) });
  const probe = await new LLMMentionProber().probePerplexity(query);
  expect(probe.citedUrls).toEqual([OTHER]);
  expect(new LLMMentionProber().parse(probe).wavesCitedUrls).toEqual([]);
});

test('OpenAI uses citation annotations rather than unrelated annotation URLs', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: {
    content: 'Identify first.', annotations: [{ type: 'search_result', url: WAVES }, { type: 'url_citation', url_citation: { url: OTHER } }],
  } }] }) });
  expect((await new LLMMentionProber().probeOpenAI(query)).citedUrls).toEqual([OTHER]);
});

test('Claude reads answer blocks and their citations when thinking leads', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  Anthropic.mockImplementation(() => ({ messages: { create: async () => ({ content: [
    { type: 'thinking', thinking: 'Waves Pest Control' },
    { type: 'text', text: 'Read this identification guide.', citations: [{ url: WAVES }] },
  ] }) } }));
  const result = await new LLMMentionProber().probeClaude(query);
  expect(new LLMMentionProber().parse(result)).toMatchObject({ wavesMentioned: false, wavesCitedUrls: [WAVES] });
});

test('no Google overview is a recorded no-answer, and task errors are not observations', async () => {
  dataforseo.request.mockResolvedValue({ tasks: [{ status_code: 20000, result: [{ items: [] }] }] });
  const prober = new LLMMentionProber();
  expect(prober.parse(await prober.probeGoogleAIOverview(query)).answerAvailable).toBe(false);
  dataforseo.request.mockResolvedValue({ tasks: [{ status_code: 40501 }] });
  expect(await prober.probeGoogleAIOverview(query)).toBeNull();
});

test('an overview source pool is neither answer prose nor an attached citation', async () => {
  dataforseo.request.mockResolvedValue({ tasks: [{ status_code: 20000, result: [{ items: [{
    type: 'ai_overview', items: [{ type: 'ai_overview_element', text: 'Inspect the property first.', references: [{ url: OTHER }] }], references: [{ title: 'Waves Pest Control', url: WAVES }],
  }] }] }] });
  const prober = new LLMMentionProber();
  expect(prober.parse(await prober.probeGoogleAIOverview(query))).toMatchObject({ wavesMentioned: false, wavesCitedUrls: [], citedUrls: [OTHER], sourceUrls: [WAVES] });
});

test('an overview needs element attribution when only a possible source pool is returned', async () => {
  const prober = new LLMMentionProber();
  const answer = { type: 'ai_overview', markdown: 'Inspect first.', references: [{ url: WAVES }] };
  dataforseo.request.mockResolvedValue({ tasks: [{ status_code: 20000, result: [{ items: [answer] }] }] });
  expect(prober.parse(await prober.probeGoogleAIOverview(query))).toMatchObject({ answerAvailable: true, citationsComplete: false, wavesCitedUrls: [] });
  answer.items = [{ type: 'ai_overview_element', text: 'Inspect first.', references: [{ url: WAVES }] }];
  expect(prober.parse(await prober.probeGoogleAIOverview(query))).toMatchObject({ citationsComplete: true, wavesCitedUrls: [WAVES] });
});

test('failed provider calls consume the attempt cap', async () => {
  const prober = new LLMMentionProber();
  jest.spyOn(prober, 'getQueries').mockResolvedValue(Array.from({ length: 220 }, (_, i) => ({ query: `benchmark ${i}` })));
  const probe = jest.fn().mockResolvedValue(null);
  Object.defineProperty(prober, 'providers', { value: { chatgpt: probe } });
  db.mockReturnValue({ select: () => ({ max: () => ({ groupBy: async () => [] }) }), where: () => ({ select: async () => [] }) });
  expect(await prober.runDaily()).toMatchObject({ attempted: 200, probed: 0, inserted: 0 });
  expect(probe).toHaveBeenCalledTimes(200);
});

test('probe rotation orders driver Date values chronologically and honors same-day dedupe', async () => {
  const prober = new LLMMentionProber();
  jest.spyOn(prober, 'getQueries').mockResolvedValue([{ query: 'newer' }, { query: 'older' }, { query: 'done today' }]);
  const probe = jest.fn().mockResolvedValue(null);
  Object.defineProperty(prober, 'providers', { value: { chatgpt: probe } });
  db.mockReturnValue({
    select: () => ({ max: () => ({ groupBy: async () => [{ query: 'newer', llm_platform: 'chatgpt', last_checked: new Date('2026-09-04T00:00:00Z') }, { query: 'older', llm_platform: 'chatgpt', last_checked: new Date('2026-08-01T00:00:00Z') }] }) }),
    where: () => ({ select: async () => [{ query: 'done today', llm_platform: 'chatgpt' }] }),
  });
  await prober.runDaily();
  expect(probe.mock.calls.map(args => args[0])).toEqual(['older', 'newer']);
});

test('disabling all managed queries does not reactivate fallback probes', async () => {
  db.mockReturnValue({ where: () => ({ orderBy: async () => [] }) });
  expect(await new LLMMentionProber().getQueries()).toEqual([]);
});

test('a partially observed question schedules its missing engine before repeating a measured engine', async () => {
  const prober = new LLMMentionProber();
  jest.spyOn(prober, 'getQueries').mockResolvedValue([{ query: 'one question' }]);
  const calls = [];
  Object.defineProperty(prober, 'providers', { value: {
    chatgpt: async () => { calls.push('chatgpt'); return null; },
    gemini: async () => { calls.push('gemini'); return null; },
  } });
  db.mockReturnValue({
    select: () => ({ max: () => ({ groupBy: async () => [{ query: 'one question', llm_platform: 'chatgpt', last_checked: '2026-08-01' }] }) }),
    where: () => ({ select: async () => [] }),
  });
  await prober.runDaily();
  expect(calls).toEqual(['gemini', 'chatgpt']);
});
