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

  test('managed city values are normalised: ", FL", case, aliases; an unknown non-empty city warns and falls back', () => {
    const logger = require('../services/logger');
    expect(scraper.normalizeCity('  Bradenton, FL ')).toBe('bradenton');
    expect(scraper.normalizeCity('Lakewood Ranch, Florida')).toBe('lakewood ranch');
    expect(scraper.normalizeCity('LWR')).toBe('lakewood ranch');
    expect(scraper.geminiLocationCode('VENICE, fl', 'q')).toBe(1015223);
    expect(scraper.geminiLocationCode('LWR', 'q')).toBe(9196651);
    expect(scraper.aiModeRequestBody('q', 'Lakewood Ranch, FL')[0].location_name).toBe('Lakewood Ranch,Florida,United States');
    expect(scraper.aiModeRequestBody('q', 'parrish, FL')[0].location_coordinate).toBe('27.5870,-82.4248,10');
    expect(logger.warn).not.toHaveBeenCalled();
    // Unknown city: the question text wins over Sarasota, and it warns.
    expect(scraper.geminiLocationCode('North Port, FL', 'best pest control in Venice')).toBe(1015223);
    expect(scraper.geminiLocationCode('North Port', 'best pest control')).toBe(1015192);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // Empty city: no warning.
    logger.warn.mockClear();
    expect(scraper.geminiLocationCode('', 'q')).toBe(1015192);
    expect(logger.warn).not.toHaveBeenCalled();
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
    expect(parsed).toMatchObject({ rankPosition: 3, rankMethod: 'all_named_text_v2', wavesMentioned: true });
    expect(parsed.competitors.map(c => c.name)).toEqual(['orkin']);
  });

  test('not named means no rank; a URL alone is not a mention', () => {
    const parsed = new LLMMentionProber().parse({ text: '**Example Bug Control** is good. https://www.wavespestcontrol.com/x', citedUrls: ['https://www.wavespestcontrol.com/x'] });
    expect(parsed).toMatchObject({ wavesMentioned: false, rankPosition: null });
    expect(parsed.wavesCitedUrls).toHaveLength(1);
  });

  test('plain-prose names count: "Example Bug Control is first. Waves Pest Control is second." ranks Waves 2nd', () => {
    const parsed = new LLMMentionProber().parse({ text: 'Example Bug Control is first. Waves Pest Control is second.' });
    expect(names(parsed.companiesNamed)).toEqual(['Example Bug Control', 'Waves Pest Control']);
    expect(parsed).toMatchObject({ rankPosition: 2, rankMethod: 'all_named_text_v2' });
  });

  test('prose names: sentence starters, service phrases, labels and table headers are not companies; a known rival keeps its leading word', () => {
    const text = [
      'Pest control in Exampleville is seasonal. Also Sample Lawn Care Inc. handles turf, and All U Need Pest Control covers ants.',
      'However Termite Treatment Costs In Florida vary. Call Waves Pest Control for a quote.',
      '| Company | Current local signal |',
    ].join('\n');
    expect(names(companies.buildCompaniesNamed(text))).toEqual(['Sample Lawn Care Inc.', 'All U Need', 'Waves Pest Control']);
    // Names never run across a line break: a bold label on the next line is not part of the name.
    expect(names(companies.buildCompaniesNamed('**Example Bug Control**\n**Why** it ranks'))).toEqual(['Example Bug Control']);
    // The same company named twice, once in full and once short.
    expect(names(companies.buildCompaniesNamed('Mosquito Joe of Exampleville is open. Mosquito Joe helps.'))).toEqual(['Mosquito Joe of Exampleville']);
  });

  test('rank honesty: provider entities give all_named_v2; text-only gives all_named_text_v2 with a conservative upper-bound rank', () => {
    const entities = [{ title: 'Example Bug Control', category: 'local_business' }, { title: 'Waves Pest Control', category: 'local_business' }];
    expect(companies.rankFor('Example Bug Control then Waves Pest Control.', { entities })).toMatchObject({ rankMethod: 'all_named_v2', rankPosition: 2 });
    expect(companies.rankFor('Example Bug Control then Waves Pest Control.')).toMatchObject({ rankMethod: 'all_named_text_v2', rankPosition: 2 });
    // Nothing brand-like precedes Waves, so the bound is 1; text that never names Waves has no rank.
    expect(companies.rankFor('Go with Waves Pest Control, they are good.')).toMatchObject({ rankMethod: 'all_named_text_v2', rankPosition: 1 });
    expect(new LLMMentionProber().parse({ text: 'Inspect first.' })).toMatchObject({ wavesMentioned: false, rankPosition: null });
    // An unusable entity list falls back to the text path.
    expect(companies.rankFor('Waves Pest Control', { entities: [{ title: 'Yelp', category: 'website' }] })).toMatchObject({ rankMethod: 'all_named_text_v2' });
  });

  test('text rank is an upper bound: brands the strict list misses still push Waves down (TruGreen / Weed Man example gives 4)', () => {
    const text = 'TruGreen is first. Weed Man is second. Massey Services is third. Waves Pest Control is fourth.';
    expect(companies.textRankBound(text)).toBe(4);
    expect(new LLMMentionProber().parse({ text })).toMatchObject({ rankPosition: 4, rankMethod: 'all_named_text_v2' });
    // companies_named stays the stricter list (competitor counts).
    expect(names(companies.buildCompaniesNamed(text))).not.toContain('TruGreen');
  });

  test('the bound excludes places, platforms, sentence-start function words and generic labels', () => {
    const text = 'However, Pest Control in Sarasota, Florida and Southwest Florida varies. Yelp, Google, Angi, BBB, Nextdoor, Facebook and Reddit rate it. Top picks: Example Bug Control. Go with Waves Pest Control.';
    expect(companies.textRankBound(text)).toBe(2);
    // A place beside a service word is still a company name; a bare place is not.
    expect(companies.textRankBound('Bradenton is lovely. Sarasota Pest Control is first. Waves Pest Control is second.')).toBe(2);
    expect(companies.textRankBound('Bradenton is lovely. Waves Pest Control is first.')).toBe(1);
  });

  test('the bound never ranks Waves higher than the true rank on the existing fixtures', () => {
    const fixtures = [
      { text: scraper.parseChatGPTScraper(chatgptResponse()).text, entities: scraper.parseChatGPTScraper(chatgptResponse()).entities, truth: 3 },
      { text: GEMINI_MARKDOWN, entities: null, truth: 3 },
      { text: aiModeResponse().tasks[0].result[0].items[0].markdown, entities: null, truth: 3 },
      { text: '**Example Bug Control** and **Sample Pest Solutions** lead. **Waves Pest Control** follows, then Orkin.', entities: null, truth: 3 },
      { text: 'Example Bug Control is first. Waves Pest Control is second.', entities: null, truth: 2 },
    ];
    for (const { text, entities, truth } of fixtures) {
      expect(companies.textRankBound(text)).toBeGreaterThanOrEqual(truth);
      expect(companies.rankFor(text, { entities: null }).rankPosition).toBeGreaterThanOrEqual(truth);
      expect(companies.rankFor(text, { entities }).rankPosition).toBeGreaterThanOrEqual(truth);
    }
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

const aiModeResponse = (overrides = {}) => ({
  status_code: 20000,
  tasks: [{
    status_code: 20000,
    cost: 0.004,
    result: [{
      keyword: 'best pest control Exampleville', type: 'ai_mode', location_code: 1015192,
      items: [{
        type: 'ai_overview',
        markdown: 'Top-rated options include:\n\n---\n\n![](https://api.dataforseo.com/cdn/i/x:8)\nProdigy Pest Solutions 4.8 (1.4K)  \nPest control service  \n\n---\nExample Bug Control 4.9 (85)  \nPest control service  \n\nWaves Pest Control 5.0 (48)  \nPest control service',
        items: [
          { type: 'ai_overview_element', text: 'Top-rated options include:', markdown: 'Top-rated options include:', links: null, references: null },
          { type: 'ai_overview_element', text: 'Example Bug Control 4.9 (85)', markdown: 'Example Bug Control 4.9 (85)', links: [{ type: 'link_element', url: 'https://bugcontrol.example.test/' }], references: null },
        ],
        references: [{ type: 'ai_overview_reference', url: 'https://www.wavespestcontrol.com/pest-control-exampleville-fl/' }],
      }],
      ...overrides,
    }],
  }],
});

describe('Google AI Mode probe', () => {
  test('request: city location_name from the row, then the question; Parrish rides its coordinate; default Sarasota', () => {
    expect(scraper.aiModeRequestBody('q', 'Venice')).toEqual([{ keyword: 'q', language_code: 'en', location_name: 'Venice,Florida,United States' }]);
    expect(scraper.aiModeRequestBody('best lawn care in Lakewood Ranch FL', null)[0].location_name).toBe('Lakewood Ranch,Florida,United States');
    expect(scraper.aiModeRequestBody('who serves Parrish FL', null)[0]).toEqual({ keyword: 'who serves Parrish FL', language_code: 'en', location_coordinate: '27.5870,-82.4248,10' });
    expect(scraper.aiModeRequestBody('best pest control in Southwest Florida', null)[0].location_name).toBe('Sarasota,Florida,United States');
    expect(scraper.AI_MODE_PATH).toBe('/serp/google/ai_mode/live/advanced');
  });

  test('parses the answer text, linked citations, sources and the model label', async () => {
    dataforseo.request.mockResolvedValue(aiModeResponse());
    const probe = await new LLMMentionProber().probeGoogleAIMode('best pest control Exampleville', { city: 'Sarasota' });
    expect(dataforseo.request).toHaveBeenCalledWith('/serp/google/ai_mode/live/advanced',
      [{ keyword: 'best pest control Exampleville', language_code: 'en', location_name: 'Sarasota,Florida,United States' }]);
    expect(probe).toMatchObject({
      model: 'dataforseo:google_ai_mode', grounded: true, citedUrls: ['https://bugcontrol.example.test/'],
      sourceUrls: ['https://www.wavespestcontrol.com/pest-control-exampleville-fl/'], citationsComplete: true, costUsd: 0.004,
    });
    const parsed = new LLMMentionProber().parse(probe);
    expect(names(parsed.companiesNamed)).toEqual(['Prodigy Pest Solutions', 'Example Bug Control', 'Waves Pest Control']);
    expect(parsed).toMatchObject({ rankPosition: 4, rankMethod: 'all_named_text_v2', wavesMentioned: true, answerAvailable: true });
  });

  test('no answer item is an empty observation; a request or task error is null (no row)', async () => {
    const prober = new LLMMentionProber();
    dataforseo.request.mockResolvedValueOnce(aiModeResponse({ items: [] }));
    expect(await prober.probeGoogleAIMode('q')).toMatchObject({ text: '', model: 'dataforseo:google_ai_mode' });
    dataforseo.request.mockResolvedValueOnce(null);
    expect(await prober.probeGoogleAIMode('q')).toBeNull();
    dataforseo.request.mockResolvedValueOnce({ tasks: [{ status_code: 40501, status_message: 'Invalid Field', result: null }] });
    expect(await prober.probeGoogleAIMode('q')).toBeNull();
    dataforseo.request.mockRejectedValueOnce(new Error('network'));
    expect(await prober.probeGoogleAIMode('q')).toBeNull();
  });

  test('registered next to AI Overview when configured; follows the LLM_MENTIONS_APP_SCRAPER switch; absent without credentials', () => {
    delete process.env.LLM_MENTIONS_APP_SCRAPER;
    let keys = Object.keys(new LLMMentionProber().providers);
    expect(keys).toEqual(expect.arrayContaining(['google_ai_overview', 'google_ai_mode']));
    process.env.LLM_MENTIONS_APP_SCRAPER = 'false';
    keys = Object.keys(new LLMMentionProber().providers);
    expect(keys).toContain('google_ai_overview');
    expect(keys).not.toContain('google_ai_mode');
    delete process.env.LLM_MENTIONS_APP_SCRAPER;
    dataforseo.configured = false;
    keys = Object.keys(new LLMMentionProber().providers);
    expect(keys).not.toContain('google_ai_mode');
    expect(keys).not.toContain('google_ai_overview');
  });

  test('the AI Overview probe keeps its own platform and model label', async () => {
    dataforseo.request.mockResolvedValue({ tasks: [{ status_code: 20000, result: [{ items: [{ type: 'ai_overview', markdown: 'Inspect first.' }] }] }] });
    expect(await new LLMMentionProber().probeGoogleAIOverview('q')).toMatchObject({ model: 'dataforseo:ai_overview' });
  });

  test('runDaily writes the row under platform google_ai_mode with all_named_v2, and the dashboard counts it as a configured engine', async () => {
    const prober = new LLMMentionProber();
    const queries = [{ query: 'best pest control Exampleville', city: 'Sarasota' }];
    jest.spyOn(prober, 'getQueries').mockResolvedValue(queries);
    dataforseo.request.mockResolvedValue(aiModeResponse());
    Object.defineProperty(prober, 'providers', { value: { google_ai_mode: (q, row) => prober.probeGoogleAIMode(q, row) } });
    jest.spyOn(prober, 'classifySentiment').mockResolvedValue('positive');
    const inserted = [];
    db.mockReturnValue({
      where: () => ({ select: async () => [] }),
      insert: row => { inserted.push(row); return { onConflict: () => ({ ignore: async () => ({ rowCount: 1 }) }) }; },
    });
    await prober.runDaily();
    expect(inserted[0]).toMatchObject({ llm_platform: 'google_ai_mode', model_version: 'dataforseo:google_ai_mode', rank_method: 'all_named_text_v2', rank_position: 4, answer_available: true });

    const dashboard = buildDashboard([{ ...inserted[0], measurement_version: 2, check_date: '2026-10-01', waves_cited_urls: '[]' }], queries,
      { configuredPlatforms: ['chatgpt', 'google_ai_overview', 'google_ai_mode'] });
    expect(dashboard.summary).toMatchObject({ platforms: ['google_ai_mode'], configuredPlatforms: ['chatgpt', 'google_ai_overview', 'google_ai_mode'] });
    expect(dashboard.byPlatform.map(g => g.key)).toEqual(['google_ai_mode · dataforseo:google_ai_mode']);
  });
});

describe('rivalsOf', () => {
  test('companies_named when present, else competitors_mentioned; canonicalised, Waves excluded, de-duplicated', () => {
    expect(companies.rivalsOf({ companies_named: JSON.stringify([{ name: 'Waves Pest Control' }, { name: 'Example Bug Control' }, { name: 'turner pest' }, { name: 'Turner Pest Control' }]) }))
      .toEqual(['Example Bug Control', 'Turner Pest Control']);
    expect(companies.rivalsOf({ companies_named: null, competitors_mentioned: [{ name: 'orkin' }, { name: 'ORKIN' }] })).toEqual(['Orkin']);
    expect(companies.rivalsOf({ companies_named: [], competitors_mentioned: [{ name: 'orkin' }] })).toEqual([]);
    expect(companies.rivalsOf({})).toEqual([]);
  });

  test('rivalEntries keeps a known-list hit\'s stored context', () => {
    expect(companies.rivalEntries({ companies_named: [{ name: 'Orkin' }, { name: 'Example Bug Control' }], competitors_mentioned: [{ name: 'orkin', context: 'Orkin is national' }] }))
      .toEqual([{ name: 'Orkin', context: 'Orkin is national' }, { name: 'Example Bug Control', context: null }]);
  });
});

describe('benchmark pairs run first under the probe cap', () => {
  const benchmark = require('../data/aeo-benchmark-v1.json');

  // Codex r3 on #5491: 40 questions x 6 platforms fill 240 exactly, so the
  // ceiling holds a reserve that only ancillary pairs can use.
  test('every benchmark pair is attempted daily and ancillary pairs rotate through the reserve', async () => {
    jest.useFakeTimers();
    try {
      const platforms = ['chatgpt', 'gemini', 'claude', 'google_ai_overview', 'google_ai_mode', 'perplexity'];
      const extra = Array.from({ length: 50 }, (_, i) => ({ query: `ancillary question ${i}` }));
      const ancillarySeen = new Set();
      for (const day of ['2030-01-01T12:00:00Z', '2030-01-02T12:00:00Z', '2030-01-03T12:00:00Z', '2030-01-04T12:00:00Z', '2030-01-05T12:00:00Z']) {
        jest.setSystemTime(new Date(day));
        const prober = new LLMMentionProber();
        jest.spyOn(prober, 'getQueries').mockResolvedValue([...extra, ...benchmark.questions.map(q => ({ query: q.query }))]);
        const attempted = new Set();
        const probes = Object.fromEntries(platforms.map(p => [p, async q => { attempted.add(`${q}::${p}`); return null; }]));
        Object.defineProperty(prober, 'providers', { value: probes });
        db.mockReturnValue({ where: () => ({ select: async () => [] }) });
        expect((await prober.runDaily()).attempted).toBe(300);
        for (const q of benchmark.questions) for (const p of platforms) expect(attempted.has(`${q.query}::${p}`)).toBe(true);
        const ancillary = [...attempted].filter(k => k.startsWith('ancillary'));
        expect(ancillary).toHaveLength(60);
        ancillary.forEach(k => ancillarySeen.add(k));
      }
      expect(ancillarySeen.size).toBe(300);
    } finally { jest.useRealTimers(); }
  });
});

describe('dashboard headline counts the current surface once', () => {
  const benchmark = require('../data/aeo-benchmark-v1.json');
  const query = benchmark.questions[0].query;
  const q2 = benchmark.questions[1].query;
  const row = (extra = {}) => ({
    query, llm_platform: 'chatgpt', model_version: 'gpt-5-search-api-test', check_date: '2026-10-01',
    measurement_version: 2, answer_available: true, citations_complete: true, waves_mentioned: false,
    waves_cited_urls: [], ...extra,
  });
  // Newest first, as getDashboard orders them: new app rows, then 30-day-old API rows.
  const history = () => [
    row({ model_version: 'dataforseo:chatgpt_app:gpt-5-6', waves_mentioned: true, check_date: '2026-10-02' }),
    row({ llm_platform: 'gemini', model_version: 'dataforseo:gemini_app:3.5', check_date: '2026-10-02' }),
    row({ model_version: 'gpt-5-search-api-test', check_date: '2026-10-01' }),
    row({ model_version: 'gpt-5-search-api-old', check_date: '2026-09-25', waves_mentioned: true }),
    row({ llm_platform: 'gemini', model_version: 'gemini-2.5-flash', check_date: '2026-10-01', waves_mentioned: true }),
    row({ query: q2, model_version: 'gpt-5-search-api-test', check_date: '2026-10-01' }),
  ];
  const managed = [{ query }, { query: q2 }];

  test('app is current: API rows of the same question and platform are left out of the headline, kept in byPlatform', () => {
    const dashboard = buildDashboard(history(), managed, { configuredPlatforms: ['chatgpt', 'gemini'], currentSurfaces: { chatgpt: 'app', gemini: 'app' } });
    // Q1: one chatgpt app row + one gemini app row. The API-only Q2 row is not a current-surface observation.
    expect(dashboard.summary).toMatchObject({ measured: 2, mentioned: 1 });
    expect(dashboard.benchmark).toMatchObject({ measured: 2, mentioned: 1, observedQuestions: 1 });
    expect(dashboard.benchmark.coverage).toMatchObject({ expected: 4, measured: 2, missing: 2 });
    expect(dashboard.benchmark.byPlatform.map(g => g.key).sort()).toEqual([
      'chatgpt · dataforseo:chatgpt_app:gpt-5-6', 'chatgpt · gpt-5-search-api-old', 'chatgpt · gpt-5-search-api-test',
      'gemini · dataforseo:gemini_app:3.5', 'gemini · gemini-2.5-flash',
    ]);
    expect(dashboard.grid.length).toBeGreaterThan(dashboard.summary.measured);
  });

  test('api is current: only the newest API row per question and platform counts, never one per model', () => {
    const dashboard = buildDashboard(history(), managed, { configuredPlatforms: ['chatgpt', 'gemini'], currentSurfaces: { chatgpt: 'api', gemini: 'api' } });
    // chatgpt Q1 (newest API row), chatgpt Q2, gemini Q1.
    expect(dashboard.summary).toMatchObject({ measured: 3, mentioned: 1 });
    expect(dashboard.benchmark.coverage).toMatchObject({ measured: 3 });
  });

  test('no surface info keeps the per-model cohorts exactly as before', () => {
    const dashboard = buildDashboard(history(), managed, { configuredPlatforms: ['chatgpt', 'gemini'] });
    expect(dashboard.summary.measured).toBe(6);
  });

  test('currentSurfaces follows LLM_MENTIONS_APP_SCRAPER and DataForSEO credentials', () => {
    const saved = process.env.LLM_MENTIONS_APP_SCRAPER;
    try {
      delete process.env.LLM_MENTIONS_APP_SCRAPER;
      expect(new LLMMentionProber().currentSurfaces).toEqual({ chatgpt: 'app', gemini: 'app' });
      process.env.LLM_MENTIONS_APP_SCRAPER = 'false';
      expect(new LLMMentionProber().currentSurfaces).toEqual({ chatgpt: 'api', gemini: 'api' });
    } finally { if (saved === undefined) delete process.env.LLM_MENTIONS_APP_SCRAPER; else process.env.LLM_MENTIONS_APP_SCRAPER = saved; }
  });
});
