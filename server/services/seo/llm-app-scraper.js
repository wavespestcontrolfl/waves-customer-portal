/**
 * Consumer-app answers via DataForSEO's LLM scrapers (AEO tracker).
 *
 * The API probes (gpt-5-search-api, gemini-2.5-flash) run older models than
 * the ChatGPT and Gemini apps people actually use: a 2026-09-30 check found
 * Gemini named Waves 5/7 through the API and 2/7 in the app. These scrapers
 * return what the apps show, at about $0.004 per request.
 *
 *   ChatGPT: POST /ai_optimization/chat_gpt/llm_scraper/live/advanced
 *            (US-level only: location_code 2840)
 *   Gemini:  POST /ai_optimization/gemini/llm_scraper/live/advanced
 *            (city location_code)
 *
 * Pure request/response shaping lives here so tests feed it fixtures; the
 * prober owns the network call (dataforseo.request) and the env switch.
 */

const CHATGPT_PATH = '/ai_optimization/chat_gpt/llm_scraper/live/advanced';
const GEMINI_PATH = '/ai_optimization/gemini/llm_scraper/live/advanced';
const US_LOCATION_CODE = 2840;

// DataForSEO Gemini llm_scraper location codes (its /locations listing).
// Parrish is not in the listing; Bradenton is the nearest served market.
const GEMINI_CITY_LOCATIONS = {
  sarasota: 1015192,
  bradenton: 1014963,
  venice: 1015223,
  'lakewood ranch': 9196651,
  parrish: 1014963,
};
const DEFAULT_GEMINI_LOCATION = GEMINI_CITY_LOCATIONS.sarasota;

/** City on the managed query row, else a city named in the question, else Sarasota. */
function geminiLocationCode(city, query) {
  const wanted = String(city || '').trim().toLowerCase();
  if (GEMINI_CITY_LOCATIONS[wanted]) return GEMINI_CITY_LOCATIONS[wanted];
  const text = String(query || '').toLowerCase();
  const named = Object.keys(GEMINI_CITY_LOCATIONS).find(name => text.includes(name));
  return named ? GEMINI_CITY_LOCATIONS[named] : DEFAULT_GEMINI_LOCATION;
}

/**
 * LLM_MENTIONS_APP_SCRAPER: default ON whenever DataForSEO credentials exist;
 * `false` (also 0/off/no) falls back to the direct API probes.
 */
function appScraperEnabled(env, dataforseoConfigured) {
  if (!dataforseoConfigured) return false;
  return !/^(?:false|0|off|no|disabled?)$/i.test(String(env ?? '').trim());
}

function urlsOf(list) {
  return (Array.isArray(list) ? list : []).map(entry => entry?.url).filter(u => typeof u === 'string' && u);
}

function taskResult(data) {
  const task = data?.tasks?.[0];
  if (!task || task.status_code !== 20000) return { task, result: null };
  return { task, result: Array.isArray(task.result) ? task.result[0] || null : null };
}

function labelModel(kind, model) {
  const clean = String(model || '').replace(/\s+/g, ' ').trim();
  return clean ? `dataforseo:${kind}:${clean}` : `dataforseo:${kind}`;
}

function answerText(result) {
  if (typeof result.markdown === 'string' && result.markdown.trim()) return result.markdown;
  return (Array.isArray(result.items) ? result.items : [])
    .map(item => (typeof item?.markdown === 'string' ? item.markdown : ''))
    .filter(Boolean).join('\n\n');
}

// ChatGPT sometimes returns only its opening line ("I'll compare ...") when the
// scrape snapshot lands before the answer renders. That is a missed scrape, not
// an answer that omits Waves, so it must not enter the rates as a miss.
const PREAMBLE_MAX_CHARS = 400;

/**
 * Parse a ChatGPT llm_scraper response into the prober's probe shape, or null
 * when the task did not succeed (nothing was measured, so nothing is recorded).
 */
function parseChatGPTScraper(data) {
  const { task, result } = taskResult(data);
  if (!result) return null;
  const text = answerText(result);
  const items = Array.isArray(result.items) ? result.items : [];
  const entities = Array.isArray(result.brand_entities) && result.brand_entities.length
    ? result.brand_entities
    : items.flatMap(item => (Array.isArray(item?.brand_entities) ? item.brand_entities : []));
  const topSources = urlsOf(result.sources);
  const sources = topSources.length ? topSources : items.flatMap(item => urlsOf(item?.sources));
  const rendered = sources.length > 0 || entities.length > 0;
  return {
    text,
    citedUrls: sources,
    sourceUrls: urlsOf(result.search_results),
    entities: entities.map(e => ({ title: e?.title, category: e?.category })).filter(e => e.title),
    model: labelModel('chatgpt_app', result.model),
    grounded: true,
    answerAvailable: !!text.trim() && (rendered || text.trim().length > PREAMBLE_MAX_CHARS),
    citationsComplete: true,
    costUsd: Number(task?.cost) || 0,
  };
}

/** Parse a Gemini llm_scraper response (no brand entities: names come from the text). */
function parseGeminiScraper(data) {
  const { task, result } = taskResult(data);
  if (!result) return null;
  const text = answerText(result);
  return {
    text,
    citedUrls: urlsOf(result.sources),
    sourceUrls: [],
    entities: null,
    model: labelModel('gemini_app', result.model),
    grounded: true,
    answerAvailable: !!text.trim(),
    citationsComplete: true,
    costUsd: Number(task?.cost) || 0,
  };
}

function chatGPTRequestBody(query) {
  return [{ keyword: query, location_code: US_LOCATION_CODE, language_code: 'en' }];
}

function geminiRequestBody(query, city) {
  return [{ keyword: query, location_code: geminiLocationCode(city, query), language_code: 'en' }];
}

module.exports = {
  CHATGPT_PATH, GEMINI_PATH, US_LOCATION_CODE, GEMINI_CITY_LOCATIONS, DEFAULT_GEMINI_LOCATION,
  geminiLocationCode, appScraperEnabled, parseChatGPTScraper, parseGeminiScraper,
  chatGPTRequestBody, geminiRequestBody,
};
