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
 *   AI Mode: POST /serp/google/ai_mode/live/advanced
 *            (city location_name; Google's AI Mode, a different feature
 *            from the AI Overview the organic SERP carries)
 *
 * Pure request/response shaping lives here so tests feed it fixtures; the
 * prober owns the network call (dataforseo.request) and the env switch.
 */

const logger = require('../logger');

const CHATGPT_PATH = '/ai_optimization/chat_gpt/llm_scraper/live/advanced';
const GEMINI_PATH = '/ai_optimization/gemini/llm_scraper/live/advanced';
const AI_MODE_PATH = '/serp/google/ai_mode/live/advanced';
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

// Managed city values arrive as typed ("Bradenton, FL", "LWR"): fold them to a
// lookup key before matching.
const CITY_ALIASES = { lwr: 'lakewood ranch', 'lakewood rch': 'lakewood ranch' };

function normalizeCity(value) {
  const key = String(value || '').toLowerCase()
    .replace(/[.]/g, ' ')
    .replace(/,?\s*(?:fl|florida)\s*$/, '')
    .replace(/\s+/g, ' ').trim();
  return CITY_ALIASES[key] || key;
}

// The city on the managed query row, else a city named in the question, else
// Sarasota. One rule for every engine that takes a city. An unknown non-empty
// city falls back (to the question, then Sarasota) with a warning.
function resolveCity(city, query) {
  const wanted = normalizeCity(city);
  if (GEMINI_CITY_LOCATIONS[wanted]) return wanted;
  if (wanted) logger.warn(`[llm-mentions] unknown city "${city}" for app-scraper location; falling back to the question text or Sarasota`);
  const text = String(query || '').toLowerCase();
  return Object.keys(GEMINI_CITY_LOCATIONS).find(name => text.includes(name)) || 'sarasota';
}

function geminiLocationCode(city, query) {
  return GEMINI_CITY_LOCATIONS[resolveCity(city, query)];
}

// AI Mode's SERP location. DataForSEO has no named location for Parrish (the
// 2026-09-30 check got a location error on it), but accepts its coordinate,
// so Parrish rides a coordinate; every other city is a named location.
const AI_MODE_CITY_NAMES = {
  sarasota: 'Sarasota', bradenton: 'Bradenton', venice: 'Venice', 'lakewood ranch': 'Lakewood Ranch',
};
const PARRISH_COORDINATE = '27.5870,-82.4248,10';

function aiModeLocation(city, query) {
  const key = resolveCity(city, query);
  if (key === 'parrish') return { location_coordinate: PARRISH_COORDINATE };
  return { location_name: `${AI_MODE_CITY_NAMES[key]},Florida,United States` };
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

function aiModeRequestBody(query, city) {
  return [{ keyword: query, language_code: 'en', ...aiModeLocation(city, query) }];
}

function chatGPTRequestBody(query) {
  return [{ keyword: query, location_code: US_LOCATION_CODE, language_code: 'en' }];
}

function geminiRequestBody(query, city) {
  return [{ keyword: query, location_code: geminiLocationCode(city, query), language_code: 'en' }];
}

module.exports = {
  CHATGPT_PATH, GEMINI_PATH, AI_MODE_PATH, US_LOCATION_CODE, GEMINI_CITY_LOCATIONS, DEFAULT_GEMINI_LOCATION,
  geminiLocationCode, aiModeLocation, normalizeCity, appScraperEnabled, parseChatGPTScraper, parseGeminiScraper,
  chatGPTRequestBody, geminiRequestBody, aiModeRequestBody,
};
