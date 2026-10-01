// AEO tracker measures the consumer apps (DataForSEO LLM scrapers) and ranks
// Waves against every company an answer names. Fixtures are trimmed from the
// 2026-09-30 scraper responses; competitor business names are public, all
// other names are synthetic. Nothing here calls a real API.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ configured: true, request: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const db = require('../models/db');
const dataforseo = require('../services/seo/dataforseo');
const { LLMMentionProber, buildDashboard } = require('../services/seo/llm-mention-prober');
const scraper = require('../services/seo/llm-app-scraper');
const companies = require('../services/seo/llm-mention-companies');

const names = list => list.map(c => c.name);

const chatgptResponse = (overrides = {}) => ({
  status_code: 20000,
  tasks: [{
    status_code: 20000,
    cost: 0.004,
    result: [{
      keyword: 'Who is the best pest control company in Exampleville FL?',
      location_code: 2840,
      model: 'gpt-5-6',
      markdown: 'I would shortlist **Turner Pest Control** first.\n\n| Company | Signal |\n|---|---|\n| **Example Bug Control** | 4.9 stars |\n| **Waves Pest Control** | 4.9 stars |\n| **Prodigy Pest Solutions** | 4.8 stars |\n',
      sources: [{ type: 'chat_gpt_source', url: 'https://www.example-directory.test/pest?utm_source=chatgpt.com', title: 'Directory' }],
      search_results: [{ type: 'chatgpt_search_result', url: 'https://reviews.example.test/pest' }],
      brand_entities: [
        { type: 'chat_gpt_brand_entity', title: 'Turner Pest Control', category: 'local_business' },
        { type: 'chat_gpt_brand_entity', title: 'Example Bug Control', category: 'local_business' },
        { type: 'chat_gpt_brand_entity', title: 'Waves Pest Control', category: 'local_business' },
        { type: 'chat_gpt_brand_entity', title: 'Prodigy Pest Solutions', category: 'local_business' },
        { type: 'chat_gpt_brand_entity', title: 'Yelp', category: 'website' },
      ],
      items: [{ type: 'chat_gpt_text', markdown: 'ignored when result.markdown exists' }],
      ...overrides,
    }],
  }],
});

const GEMINI_MARKDOWN = [
  'Top providers serving the Exampleville area include:',
  '',
  '### 1. Best Local Favorites',
  '',
  '* **Arrow Environmental Services:** A long-time staple in Southwest Florida.',
  '* **Sample Termite & Pest Solutions[sampletermite.test](https://sampletermite.test/pest-control#:~:text=x)** – Serving the county.',
  '* **Waves Pest Control:** Locally owned.',
  '',
  '### 2. National brands',
  '',
  '* **Terminix & Orkin:** Large national companies.',
  '',
  '### How to choose:',
  '',
  '* **For Termites:** Ask about a repair guarantee.',
  '* **Core Offerings:** Fertilization and weed control.',
  '* Get quotes from two or three companies before deciding.',
].join('\n');

const geminiResponse = (overrides = {}) => ({
  status_code: 20000,
  tasks: [{
    status_code: 20000,
    cost: 0.004,
    result: [{
      keyword: 'best pest control Exampleville', location_code: 1015192, model: '3.5 Flash-Lite',
      markdown: GEMINI_MARKDOWN,
      sources: [{ type: 'gemini_source', url: 'https://www.arrowservices.com/branch-offices/exampleville/#:~:text=Pest%20Free', title: 'Arrow' },
        { type: 'gemini_source', url: 'https://www.wavespestcontrol.com/pest-control-exampleville-fl/', title: 'Waves' }],
      items: [{ type: 'gemini_text', markdown: 'first paragraph only' }],
      ...overrides,
    }],
  }],
});

let savedEnv;
beforeEach(() => { savedEnv = { ...process.env }; jest.clearAllMocks(); dataforseo.configured = true; });
afterEach(() => { process.env = savedEnv; });

describe('ChatGPT scraper response parsing', () => {
  test('answer text, cited URLs, brand entities, model label and cost come from the scraper result', () => {
    const probe = scraper.parseChatGPTScraper(chatgptResponse());
    expect(probe.text).toMatch(/^I would shortlist \*\*Turner Pest Control\*\*/);
    expect(probe.citedUrls).toEqual(['https://www.example-directory.test/pest?utm_source=chatgpt.com']);
    expect(probe.sourceUrls).toEqual(['https://reviews.example.test/pest']);
    expect(probe.entities.map(e => e.title)).toEqual(['Turner Pest Control', 'Example Bug Control', 'Waves Pest Control', 'Prodigy Pest Solutions', 'Yelp']);
    expect(probe).toMatchObject({ model: 'dataforseo:chatgpt_app:gpt-5-6', grounded: true, answerAvailable: true, citationsComplete: true, costUsd: 0.004 });
  });

  test('falls back to item markdown, item entities and item sources when the result carries none', () => {
    const probe = scraper.parseChatGPTScraper(chatgptResponse({
      markdown: null, sources: null, brand_entities: null,
      items: [
        { type: 'chat_gpt_text', markdown: 'First part. ', sources: [{ url: 'https://a.example.test/' }], brand_entities: [{ title: 'Example Bug Control', category: 'local_business' }] },
        { type: 'chat_gpt_table', markdown: 'second part', sources: null, brand_entities: [{ title: 'Pest Patrol', category: 'local_business' }] },
      ],
    }));
    expect(probe.text).toBe('First part. \n\nsecond part');
    expect(probe.citedUrls).toEqual(['https://a.example.test/']);
    expect(probe.entities.map(e => e.title)).toEqual(['Example Bug Control', 'Pest Patrol']);
  });

  test('a preamble-only scrape (no sources, no entities, short) is not an answer', () => {
    const probe = scraper.parseChatGPTScraper(chatgptResponse({
      markdown: 'I’ll compare well-reviewed pest-control companies serving Exampleville.',
      sources: null, search_results: null, brand_entities: null, items: [],
    }));
    expect(probe.answerAvailable).toBe(false);
    expect(probe.model).toBe('dataforseo:chatgpt_app:gpt-5-6');
  });

  test('a task error or empty result is not an observation', () => {
    expect(scraper.parseChatGPTScraper(null)).toBeNull();
    expect(scraper.parseChatGPTScraper({ tasks: [{ status_code: 40501, status_message: 'Invalid Field', result: null }] })).toBeNull();
    expect(scraper.parseChatGPTScraper({ tasks: [{ status_code: 20000, result: [] }] })).toBeNull();
  });

  test('a missing model still yields a distinguishable app label', () => {
    expect(scraper.parseChatGPTScraper(chatgptResponse({ model: null })).model).toBe('dataforseo:chatgpt_app');
  });
});

describe('Gemini scraper response parsing', () => {
  test('answer text, cited URLs and the model as reported', () => {
    const probe = scraper.parseGeminiScraper(geminiResponse());
    expect(probe.text).toBe(GEMINI_MARKDOWN);
    expect(probe.citedUrls).toHaveLength(2);
    expect(probe).toMatchObject({ model: 'dataforseo:gemini_app:3.5 Flash-Lite', entities: null, answerAvailable: true, costUsd: 0.004 });
  });

  test('empty text is no answer; a failed task is not an observation', () => {
    expect(scraper.parseGeminiScraper(geminiResponse({ markdown: '', items: [] })).answerAvailable).toBe(false);
    expect(scraper.parseGeminiScraper({ tasks: [{ status_code: 50000, result: null }] })).toBeNull();
  });
});

describe('request shaping', () => {
  test('ChatGPT is US-level only; Gemini uses the question city, then the question text, then Sarasota', () => {
    expect(scraper.chatGPTRequestBody('q')).toEqual([{ keyword: 'q', location_code: 2840, language_code: 'en' }]);
    expect(scraper.geminiRequestBody('q', 'Venice')[0]).toMatchObject({ location_code: 1015223, language_code: 'en' });
    expect(scraper.geminiRequestBody('best lawn care in Lakewood Ranch FL', null)[0].location_code).toBe(9196651);
    expect(scraper.geminiRequestBody('best pest control in Bradenton', 'Bradenton')[0].location_code).toBe(1014963);
    expect(scraper.geminiLocationCode(null, 'best pest control in Southwest Florida')).toBe(1015192);
    expect(scraper.geminiLocationCode('Unknownville', 'q')).toBe(1015192);
  });

  test('the env switch is on by default with DataForSEO credentials and off for false/0/off/no', () => {
    expect(scraper.appScraperEnabled(undefined, true)).toBe(true);
    expect(scraper.appScraperEnabled('true', true)).toBe(true);
    for (const off of ['false', 'FALSE', '0', 'off', 'no']) expect(scraper.appScraperEnabled(off, true)).toBe(false);
    expect(scraper.appScraperEnabled(undefined, false)).toBe(false);
  });
});

describe('prober wiring', () => {
  test('default: ChatGPT and Gemini are the DataForSEO app scrapers, even with API keys set', async () => {
    process.env.OPENAI_API_KEY = 'k'; process.env.GEMINI_API_KEY = 'k'; delete process.env.LLM_MENTIONS_APP_SCRAPER;
    global.fetch = jest.fn();
    dataforseo.request.mockResolvedValue(chatgptResponse());
    const prober = new LLMMentionProber();
    const probe = await prober.providers.chatgpt('who is best in Exampleville');
    expect(probe.model).toBe('dataforseo:chatgpt_app:gpt-5-6');
    expect(dataforseo.request).toHaveBeenCalledWith(scraper.CHATGPT_PATH, [{ keyword: 'who is best in Exampleville', location_code: 2840, language_code: 'en' }]);
    expect(global.fetch).not.toHaveBeenCalled();

    dataforseo.request.mockResolvedValue(geminiResponse());
    const gemini = await prober.providers.gemini('best pest control', { city: 'Venice' });
    expect(gemini.model).toBe('dataforseo:gemini_app:3.5 Flash-Lite');
    expect(dataforseo.request).toHaveBeenLastCalledWith(scraper.GEMINI_PATH, [{ keyword: 'best pest control', location_code: 1015223, language_code: 'en' }]);
  });

  test('LLM_MENTIONS_APP_SCRAPER=false falls back to the API probes (and only those with keys)', async () => {
    process.env.LLM_MENTIONS_APP_SCRAPER = 'false';
    process.env.OPENAI_API_KEY = 'k'; delete process.env.GEMINI_API_KEY;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ model: 'gpt-5-search-api-test', choices: [{ message: { content: 'Inspect first.' } }] }) });
    const prober = new LLMMentionProber();
    expect(Object.keys(prober.providers)).toEqual(expect.arrayContaining(['chatgpt', 'google_ai_overview']));
    expect(prober.providers.gemini).toBeUndefined();
    expect((await prober.providers.chatgpt('q')).model).toBe('gpt-5-search-api-test');
    expect(dataforseo.request).not.toHaveBeenCalled();
  });

  test('without DataForSEO credentials the scrapers are not used even when the env is unset', () => {
    dataforseo.configured = false;
    process.env.OPENAI_API_KEY = 'k'; delete process.env.GEMINI_API_KEY; delete process.env.LLM_MENTIONS_APP_SCRAPER;
    global.fetch = jest.fn();
    const providers = new LLMMentionProber().providers;
    expect(providers.gemini).toBeUndefined();
    expect(providers.chatgpt).toBeDefined();
    expect(providers.google_ai_overview).toBeUndefined();
  });

  test('a gate-off, request error or task error is "not measured" (null), never an observation', async () => {
    const prober = new LLMMentionProber();
    dataforseo.request.mockResolvedValueOnce(null);
    expect(await prober.probeChatGPTApp('q')).toBeNull();
    dataforseo.request.mockResolvedValueOnce({ tasks: [{ status_code: 40202, status_message: 'rate', result: null }] });
    expect(await prober.probeGeminiApp('q', { city: 'Sarasota' })).toBeNull();
    dataforseo.request.mockRejectedValueOnce(new Error('network'));
    expect(await prober.probeChatGPTApp('q')).toBeNull();
  });

  test('runDaily records the app model, companies_named and rank_method, and totals scraper cost', async () => {
    const prober = new LLMMentionProber();
    jest.spyOn(prober, 'getQueries').mockResolvedValue([{ query: 'best pest control Exampleville', city: 'Sarasota' }]);
    dataforseo.request.mockResolvedValue(chatgptResponse());
    Object.defineProperty(prober, 'providers', { value: { chatgpt: q => prober.probeChatGPTApp(q) } });
    jest.spyOn(prober, 'classifySentiment').mockResolvedValue('positive');
    const inserted = [];
    db.mockReturnValue({
      where: () => ({ select: async () => [] }),
      insert: row => { inserted.push(row); return { onConflict: () => ({ ignore: async () => ({ rowCount: 1 }) }) }; },
    });
    await prober.runDaily();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ llm_platform: 'chatgpt', model_version: 'dataforseo:chatgpt_app:gpt-5-6', rank_method: 'all_named_v2', rank_position: 3, waves_mentioned: true });
    expect(names(JSON.parse(inserted[0].companies_named))).toEqual(['Turner Pest Control', 'Example Bug Control', 'Waves Pest Control', 'Prodigy Pest Solutions']);
  });
});

describe('companies_named extraction', () => {
  test('brand entities lead: non-company entities are dropped, order follows the text, Waves is placed', () => {
    const probe = scraper.parseChatGPTScraper(chatgptResponse());
    const list = companies.buildCompaniesNamed(probe.text, { entities: probe.entities });
    expect(names(list)).toEqual(['Turner Pest Control', 'Example Bug Control', 'Waves Pest Control', 'Prodigy Pest Solutions']);
    expect(companies.rankAmong(list)).toBe(3);
  });

  test('entities missing from the text keep their order after those found, and a Waves hit absent from the entities is added', () => {
    const list = companies.buildCompaniesNamed('Waves Pest Control is nearby. Also Example Bug Control.', {
      entities: [{ title: 'Example Bug Control', category: 'local_business' }, { title: 'Offstage Pest Co', category: 'local_business' }],
    });
    expect(names(list)).toEqual(['Waves Pest Control', 'Example Bug Control', 'Offstage Pest Co']);
  });

  test('plain text: leading names of bulleted items, bold names, domain-glued Maps links; labels and advice are not companies', () => {
    const list = companies.buildCompaniesNamed(GEMINI_MARKDOWN);
    expect(names(list)).toEqual([
      'Arrow Environmental Services', 'Sample Termite & Pest Solutions', 'Waves Pest Control', 'Terminix', 'Orkin',
    ]);
    expect(companies.rankAmong(list)).toBe(3);
  });

  test('numbered lists, plain-dash separators and markdown links are read as names', () => {
    const text = [
      '1. Example Bug Control - family owned since 1999.',
      '2. [Sample Lawn and Pest Control](https://sample.test/) has great reviews.',
      '3. Waves Pest Control: quarterly plans.',
      'Get a quote from a few companies.',
    ].join('\n');
    expect(names(companies.buildCompaniesNamed(text))).toEqual(['Example Bug Control', 'Sample Lawn and Pest Control', 'Waves Pest Control']);
  });

  test('known rivals are included by text position even when no list syntax names them, and de-duplicated', () => {
    const list = companies.buildCompaniesNamed('Many people choose Orkin, though Massey Services and Orkin both cover it. Westfall\'s too, and Waves Pest Control.');
    expect(names(list)).toEqual(['Orkin', 'Massey Services', "Westfall's", 'Waves Pest Control']);
  });

  test('the new local rivals are in the known list, ordinary English is not', () => {
    for (const rival of ['all u need', 'prodigy pest', 'paragon pest', 'farrow', 'good news pest', 'acme', 'westfall', 'keller']) {
      expect(companies.COMPETITORS).toContain(rival);
    }
    for (const old of ['turner pest', 'hoskins', 'orkin', 'terminix', 'truly nolen', 'hometeam', 'arrow environmental', 'nozzle nolen', 'massey services']) {
      expect(companies.COMPETITORS).toContain(old);
    }
    expect(names(companies.buildCompaniesNamed('The good news is a paragon of prodigy.'))).toEqual([]);
  });

  test('looksLikeCompany is conservative', () => {
    for (const ok of ['Example Bug Control', 'PestArmor', 'Nuisance Wildlife Removal Inc.', 'Lawn Doctor of Example County', 'Terminix']) {
      expect(companies.looksLikeCompany(ok)).toBe(true);
    }
    for (const no of ['For Termites', 'Core Offerings', 'Pest Control', 'Termite Control Plans', 'Pest Control in Exampleville',
      'Get quotes from two or three companies before deciding', 'Provides mosquito treatments and recurring pest programs.', 'Best Local Favorites']) {
      expect(companies.looksLikeCompany(no)).toBe(false);
    }
  });
});

describe('rank computation', () => {
  test('rank is Waves\' position among every company named, not among the known list only', () => {
    const prober = new LLMMentionProber();
    const text = '**Example Bug Control** and **Sample Pest Solutions** lead. **Waves Pest Control** follows, then Orkin.';
    const parsed = prober.parse({ text });
    // The old known-list rank would have been 1 (Orkin is the only listed name, and it comes later).
    expect(names(parsed.companiesNamed)).toEqual(['Example Bug Control', 'Sample Pest Solutions', 'Waves Pest Control', 'Orkin']);
    expect(parsed).toMatchObject({ rankPosition: 3, rankMethod: 'all_named_v2', wavesMentioned: true });
    expect(parsed.competitors.map(c => c.name)).toEqual(['orkin']);
  });

  test('not named means no rank; a URL alone is not a mention', () => {
    const parsed = new LLMMentionProber().parse({ text: '**Example Bug Control** is good. https://www.wavespestcontrol.com/x', citedUrls: ['https://www.wavespestcontrol.com/x'] });
    expect(parsed).toMatchObject({ wavesMentioned: false, rankPosition: null });
    expect(parsed.wavesCitedUrls).toHaveLength(1);
  });

  test('rankAmong accepts plain names and returns null when Waves is absent', () => {
    expect(companies.rankAmong([{ name: 'A Pest' }, { name: 'Waves Pest Control' }])).toBe(2);
    expect(companies.rankAmong([{ name: 'A Pest' }])).toBeNull();
    expect(companies.rankAmong(null)).toBeNull();
  });
});

describe('dashboard handling', () => {
  const query = 'best pest control in Exampleville';
  const row = (extra = {}) => ({
    query, llm_platform: 'chatgpt', model_version: 'm', check_date: '2026-10-01',
    measurement_version: 2, answer_available: true, citations_complete: true, waves_mentioned: false,
    waves_cited_urls: [], ...extra,
  });

  test('competitor counts come from companies_named when present and fall back to competitors_mentioned for old rows, merged by company', () => {
    const rows = [
      row({ model_version: 'dataforseo:chatgpt_app:gpt-5-6', rank_method: 'all_named_v2', companies_named: JSON.stringify([{ name: 'Example Bug Control' }, { name: 'Waves Pest Control' }, { name: 'Turner Pest Control' }]), competitors_mentioned: '[]' }),
      row({ llm_platform: 'gemini', rank_method: 'all_named_v2', companies_named: [{ name: 'Example Bug Control' }, { name: 'Prodigy Pest Solutions' }], competitors_mentioned: '[]' }),
      row({ llm_platform: 'claude', rank_method: null, companies_named: null, competitors_mentioned: JSON.stringify([{ name: 'turner pest' }, { name: 'orkin' }]) }),
    ];
    const { competitors } = buildDashboard(rows, [{ query }]);
    expect(Object.fromEntries(competitors.map(c => [c.name, c.count]))).toEqual({
      'Turner Pest Control': 2, 'Example Bug Control': 2, 'Prodigy Pest Solutions': 1, Orkin: 1,
    });
    expect(competitors.every(c => typeof c.count === 'number' && typeof c.name === 'string')).toBe(true);
  });

  test('rows say which rank method they use: NULL reads as known_list_v1, groups list the methods they mix', () => {
    const rows = [
      row({ rank_method: 'all_named_v2' }),
      row({ llm_platform: 'gemini' }),
    ];
    const dashboard = buildDashboard(rows, [{ query }]);
    expect(dashboard.grid.map(r => r.rank_method).sort()).toEqual(['all_named_v2', 'known_list_v1']);
    expect(dashboard.summary.rankMethods).toEqual(['all_named_v2', 'known_list_v1']);
    expect(dashboard.byPlatform.map(g => g.rankMethods)).toEqual([['all_named_v2'], ['known_list_v1']]);
  });
});
