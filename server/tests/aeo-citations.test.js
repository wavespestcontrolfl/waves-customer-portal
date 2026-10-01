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
afterEach(() => { global.fetch = savedFetch; process.env = savedEnv; jest.useRealTimers(); });

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
  expect(result).toEqual({ total: 6, measured: 3, mentioned: 1, cited: 1, recommended: 0, unclassified: 1, mentionRate: 33, citationRate: 33, recommendedRate: 0, legacy: 1, noAnswer: 1, unresolved: 1 });
  expect(summarizeObservations([])).toMatchObject({ citationRate: null, mentionRate: null });
});

test('the backlink dashboard measures the full cohort while limiting its detail list', async () => {
  const monitor = require('../services/seo/backlink-monitor');
  const basic = jest.spyOn(monitor, 'getDashboard').mockResolvedValue({});
  const rows = Array.from({ length: 25 }, (_, i) => measured({ query: `question ${i}`, waves_mentioned: i === 0, waves_cited_urls: i >= 20 ? [WAVES] : [] }));
  rows.push(measured({ query: 'legacy question', measurement_version: null, waves_mentioned: true, waves_cited_urls: [WAVES] }));
  db.mockImplementation(table => {
    const results = ['seo_llm_mentions', 'seo_llm_mention_queries'].includes(table) ? rows : [];
    const builder = { then: (resolve, reject) => Promise.resolve(results).then(resolve, reject), first: async () => ({ count: '0' }) };
    for (const method of ['where', 'whereRaw', 'orderBy', 'orderByRaw', 'limit', 'count']) builder[method] = () => builder;
    return builder;
  });
  try {
    const result = await monitor.getFullDashboard();
    expect(result.llmMentions).toHaveLength(20);
    expect(result.llmStats).toMatchObject({ total: 26, measured: 25, mentionRate: 4, citationRate: 20, legacy: 1 });
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

test('the strategy tool lists every company a new answer named as competitors, in its old {name, context} shape', async () => {
  const monitor = require('../services/seo/backlink-monitor');
  const scan = jest.spyOn(monitor, 'checkLLMMentions').mockResolvedValue({});
  db.mockReturnValue({ orderBy: () => ({ limit: async () => [
    measured({ companies_named: JSON.stringify([{ name: 'Example Bug Control' }, { name: 'Waves Pest Control' }, { name: 'Orkin' }]),
      competitors_mentioned: JSON.stringify([{ name: 'orkin', context: 'then Orkin follows' }]) }),
    measured({ companies_named: null, competitors_mentioned: JSON.stringify([{ name: 'turner pest', context: 'Turner Pest' }]) }),
  ] }) });
  try {
    const { executeBacklinkTool } = require('../services/seo/backlink-strategy-tools');
    const { checks } = await executeBacklinkTool('check_llm_mentions', {});
    expect(checks[0].competitors_mentioned).toEqual([
      { name: 'Example Bug Control', context: null }, { name: 'Orkin', context: 'then Orkin follows' },
    ]);
    expect(checks[1].competitors_mentioned).toEqual([{ name: 'Turner Pest Control', context: 'Turner Pest' }]);
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

test('recommended counts a mentioned, positively-sentimented, top-3-ranked answer; missing counts unobserved question x engine pairs', () => {
  const question2 = benchmark.questions[1].query;
  const rows = [
    // Q1 on chatgpt: mentioned + positive + rank 1 -> recommended.
    measured({ waves_mentioned: true, sentiment: 'positive', rank_position: 1 }),
    // Q1 on gemini: mentioned but negative sentiment -> not recommended.
    measured({ llm_platform: 'gemini', waves_mentioned: true, sentiment: 'negative', rank_position: 1 }),
    // Q2 on chatgpt: mentioned + positive but rank 4 (outside top 3) -> not recommended.
    measured({ query: question2, waves_mentioned: true, sentiment: 'positive', rank_position: 4 }),
  ];
  const dashboard = buildDashboard(rows, benchmark.questions);
  // 40 active questions x 2 configured engines (chatgpt, gemini) = 80 expected
  // pairs; observed pairs are Q1::chatgpt, Q1::gemini, Q2::chatgpt = 3.
  expect(dashboard.benchmark).toMatchObject({
    activeQuestions: 40, measured: 3, recommended: 1, recommendedRate: 33,
    expectedObservations: 80, missing: 77,
  });
  expect(dashboard.summary).toMatchObject({ measured: 3, recommended: 1 });
});

// Codex r4 on #5123: a mentioned answer whose sentiment was never classified
// (NULL) is neither recommended nor a miss — it leaves the denominator.
test('a mentioned answer with unclassified sentiment is excluded from the recommended rate and counted', () => {
  const result = summarizeObservations([
    measured({ waves_mentioned: true, sentiment: 'positive', sentiment_status: 'classified', rank_position: 1 }),
    measured({ waves_mentioned: true, sentiment: null, sentiment_status: 'unclassified', rank_position: 1 }),
    measured({ sentiment: 'neutral' }),
  ]);
  expect(result).toMatchObject({ measured: 3, mentioned: 2, recommended: 1, unclassified: 1, recommendedRate: 50, mentionRate: 67 });
  expect(summarizeObservations([measured({ waves_mentioned: true, sentiment: null, sentiment_status: 'unclassified' })])).toMatchObject({ unclassified: 1, recommendedRate: null });
});

// Codex r5 on #5123: rows written before sentiment_status existed stored
// 'neutral' on any failure, so an old mentioned 'neutral' is not trusted as
// a verdict; old positive/negative labels were real classifications.
test('a pre-status mentioned neutral is unclassified; pre-status positive/negative and new classified neutral count', () => {
  const result = summarizeObservations([
    measured({ waves_mentioned: true, sentiment: 'neutral', rank_position: 1 }), // old row: ambiguous
    measured({ waves_mentioned: true, sentiment: 'positive', rank_position: 2 }), // old row: real label
    measured({ waves_mentioned: true, sentiment: 'negative', rank_position: 1 }), // old row: real label
    measured({ waves_mentioned: true, sentiment: 'neutral', sentiment_status: 'classified', rank_position: 1 }), // new real neutral
  ]);
  expect(result).toMatchObject({ measured: 4, recommended: 1, unclassified: 1, recommendedRate: 33 });
});

// Codex r4 on #5123: a provider's model change leaves two cohort rows on one
// question x engine pair. The rates keep the cohorts apart; coverage
// classifies each pair once, by its newest observation, so it partitions the
// expected pairs.
test('coverage partitions the expected pairs by each pair\'s newest observation across model cohorts', () => {
  const [q1, q2] = benchmark.questions.map(q => q.query);
  const managed = [{ query: q1, active: true }, { query: q2, active: true }];
  const rows = [ // newest first, as getDashboard orders them
    measured({ model_version: 'new-search', check_date: '2026-08-02' }),
    measured({ model_version: 'old-search', check_date: '2026-08-01', answer_available: false }),
    measured({ llm_platform: 'gemini', check_date: '2026-08-01', citations_complete: false }),
    measured({ query: q2, llm_platform: 'perplexity' }), // perplexity is not configured
  ];
  const dashboard = buildDashboard(rows, managed, { configuredPlatforms: ['chatgpt', 'gemini'] });
  const { coverage } = dashboard.benchmark;
  expect(coverage).toEqual({ expected: 4, measured: 1, noAnswer: 0, legacy: 0, unresolved: 1, missing: 2 });
  expect(coverage.measured + coverage.noAnswer + coverage.legacy + coverage.unresolved + coverage.missing).toBe(coverage.expected);
  // The rates still count each model cohort separately — never blended.
  expect(dashboard.benchmark).toMatchObject({ measured: 2, noAnswer: 1, unresolved: 1 });
});

test('missing never goes negative when every expected pair is observed', () => {
  const oneQuestion = [{ query: benchmark.questions[0].query, active: true }];
  const rows = [measured()];
  const dashboard = buildDashboard(rows, oneQuestion);
  expect(dashboard.benchmark).toMatchObject({ activeQuestions: 1, expectedObservations: 1, missing: 0 });
});

test('a deactivated question\'s historical observation cannot shrink the active cohort\'s missing count', () => {
  const [q1, q2, q3] = benchmark.questions.map(q => q.query);
  const managed = [{ query: q1, active: true }, { query: q3, active: true }]; // q2 is deactivated
  const rows = [measured({ query: q2 })]; // only a (deactivated) q2 observation exists
  const dashboard = buildDashboard(rows, managed);
  // Both active questions (q1, q3) x 1 engine are unobserved — q2's leftover
  // observation must not count toward either of them.
  expect(dashboard.benchmark).toMatchObject({ activeQuestions: 2, expectedObservations: 2, missing: 2 });
});

// Codex r1 (PR #5123): the engine denominator is the configured provider set.
// runDaily skips null probes, so an engine that is newly enabled or failing
// for the whole window has no rows — deriving engines from rows would turn a
// total outage into apparent full coverage.
test('a configured engine with no observations in the window counts as missing', () => {
  const oneQuestion = [{ query: benchmark.questions[0].query, active: true }];
  const rows = [measured()]; // chatgpt only; perplexity configured but produced nothing
  const dashboard = buildDashboard(rows, oneQuestion, { configuredPlatforms: ['chatgpt', 'perplexity'] });
  expect(dashboard.benchmark).toMatchObject({ expectedObservations: 2, missing: 1 });
  expect(dashboard.summary.configuredPlatforms).toEqual(['chatgpt', 'perplexity']);
  expect(dashboard.summary.platforms).toEqual(['chatgpt']);
});

test('a no-answer observation is reported as noAnswer, not missing', () => {
  const oneQuestion = [{ query: benchmark.questions[0].query, active: true }];
  const rows = [measured({ answer_available: false })];
  const dashboard = buildDashboard(rows, oneQuestion, { configuredPlatforms: ['chatgpt'] });
  expect(dashboard.benchmark).toMatchObject({ expectedObservations: 1, missing: 0, noAnswer: 1 });
});

test('a removed engine\'s leftover rows cannot offset a configured engine\'s gap', () => {
  const oneQuestion = [{ query: benchmark.questions[0].query, active: true }];
  const rows = [measured({ llm_platform: 'gemini' })]; // gemini no longer configured
  const dashboard = buildDashboard(rows, oneQuestion, { configuredPlatforms: ['chatgpt'] });
  expect(dashboard.benchmark).toMatchObject({ expectedObservations: 1, missing: 1 });
});

test('an explicitly EMPTY configured provider set stays empty — never repopulated from history', () => {
  const oneQuestion = [{ query: benchmark.questions[0].query, active: true }];
  const rows = [measured()]; // historical chatgpt rows exist, but nothing is configured now
  const dashboard = buildDashboard(rows, oneQuestion, { configuredPlatforms: [] });
  expect(dashboard.benchmark).toMatchObject({ expectedObservations: 0, missing: 0 });
  expect(dashboard.summary.configuredPlatforms).toEqual([]);
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
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-5-search-api', web_search_options: {} });
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
  answer.items = [{ type: 'ai_overview_element', text: 'Inspect first.' }];
  expect(prober.parse(await prober.probeGoogleAIOverview(query))).toMatchObject({ answerAvailable: true, citationsComplete: false, wavesCitedUrls: [] });
  answer.items = [{ type: 'ai_overview_element', text: 'Inspect first.', references: [{ url: WAVES }] }];
  expect(prober.parse(await prober.probeGoogleAIOverview(query))).toMatchObject({ citationsComplete: true, wavesCitedUrls: [WAVES] });
});

test('failed provider calls consume the attempt cap', async () => {
  const prober = new LLMMentionProber();
  jest.spyOn(prober, 'getQueries').mockResolvedValue(Array.from({ length: 260 }, (_, i) => ({ query: `benchmark ${i}` })));
  const probe = jest.fn().mockResolvedValue(null);
  Object.defineProperty(prober, 'providers', { value: { chatgpt: probe } });
  db.mockReturnValue({ select: () => ({ max: () => ({ groupBy: async () => [] }) }), where: () => ({ select: async () => [] }) });
  expect(await prober.runDaily()).toMatchObject({ attempted: 240, probed: 0, inserted: 0 });
  expect(probe).toHaveBeenCalledTimes(240);
});

test('probe rotation honors same-day dedupe', async () => {
  const prober = new LLMMentionProber();
  jest.spyOn(prober, 'getQueries').mockResolvedValue([{ query: 'newer' }, { query: 'older' }, { query: 'done today' }]);
  const probe = jest.fn().mockResolvedValue(null);
  Object.defineProperty(prober, 'providers', { value: { chatgpt: probe } });
  db.mockReturnValue({
    where: () => ({ select: async () => [{ query: 'done today', llm_platform: 'chatgpt' }] }),
  });
  await prober.runDaily();
  expect(probe.mock.calls.map(args => args[0]).sort()).toEqual(['newer', 'older']);
});

// Codex r5 on #5123: each mentioned row records whether its sentiment was
// actually classified; an unmentioned row carries no status.
test('runDaily stores sentiment_status: classified, unclassified (NULL sentiment), or none when Waves is absent', async () => {
  const prober = new LLMMentionProber();
  jest.spyOn(prober, 'getQueries').mockResolvedValue([{ query: 'q-classified' }, { query: 'q-failed' }, { query: 'q-absent' }]);
  const answers = {
    'q-classified': 'Waves Pest Control is a strong local choice.',
    'q-failed': 'Waves Pest Control also serves this area.',
    'q-absent': 'Inspect first.',
  };
  Object.defineProperty(prober, 'providers', { value: { chatgpt: async question => ({ text: answers[question], model: 'test' }) } });
  jest.spyOn(prober, 'classifySentiment').mockImplementation(async context => (/strong/.test(context) ? 'positive' : null));
  const inserted = [];
  db.mockReturnValue({
    where: () => ({ select: async () => [] }),
    insert: row => { inserted.push(row); return { onConflict: () => ({ ignore: async () => ({ rowCount: 1 }) }) }; },
  });
  await prober.runDaily();
  const byQuery = Object.fromEntries(inserted.map(row => [row.query, row]));
  expect(byQuery['q-classified']).toMatchObject({ sentiment: 'positive', sentiment_status: 'classified' });
  expect(byQuery['q-failed']).toMatchObject({ sentiment: null, sentiment_status: 'unclassified' });
  expect(byQuery['q-absent']).toMatchObject({ sentiment: 'neutral', sentiment_status: null });
});

test('disabling all managed queries does not reactivate fallback probes', async () => {
  db.mockReturnValue({ where: () => ({ orderBy: async () => [] }) });
  expect(await new LLMMentionProber().getQueries()).toEqual([]);
});

test('four failing engines cannot permanently starve a healthy engine under the run cap', async () => {
  jest.useFakeTimers();
  const prober = new LLMMentionProber();
  const queries = Array.from({ length: 60 }, (_, i) => ({ query: `question ${i}` }));
  jest.spyOn(prober, 'getQueries').mockResolvedValue(queries);
  const healthyQuestions = new Set();
  const failed = jest.fn().mockResolvedValue(null);
  Object.defineProperty(prober, 'providers', { value: {
    chatgpt: failed, gemini: failed, claude: failed, google_ai_overview: failed,
    perplexity: async question => { healthyQuestions.add(question); return { text: 'Inspect first.', model: 'test' }; },
  } });
  db.mockReturnValue({
    where: () => ({ select: async () => [] }),
    insert: () => ({ onConflict: () => ({ ignore: async () => ({ rowCount: 1 }) }) }),
  });
  for (const day of ['2030-01-01T12:00:00Z', '2030-01-02T12:00:00Z']) {
    jest.setSystemTime(new Date(day));
    expect((await prober.runDaily()).attempted).toBe(240);
  }
  expect(healthyQuestions.size).toBe(60);
});
