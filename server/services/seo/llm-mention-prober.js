/**
 * LLM Mention Prober — answer-engine visibility tracking (AEO).
 *
 * For each managed query, asks the major answer engines a real prospect-style
 * question and records whether Waves Pest Control shows up, where it ranks
 * among competitors, which of our pages get cited, and the sentiment.
 *
 * Coverage (hybrid, per owner decision 2026-05-30):
 *   - ChatGPT  → OpenAI search-grounded model (live web)        [OPENAI_API_KEY]
 *   - Gemini   → Google google_search grounding tool (live web) [GEMINI_API_KEY]
 *   - Claude   → Anthropic web_search tool (live web)           [ANTHROPIC_API_KEY]
 *   - Google AI Overview → DataForSEO SERP AI overview          [DATAFORSEO_*]
 *   - Perplexity → Sonar search-grounded model (live web)       [PERPLEXITY_API_KEY]
 *
 * A platform whose key/gate is missing is skipped silently — the run degrades
 * to whatever providers are configured rather than failing.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const MODELS = require('../../config/models');
const { stripThinkingBlocks } = require('../llm/deep');
const benchmark = require('../../data/aeo-benchmark-v1.json');
const {
  MEASUREMENT_VERSION, observationDate, asJsonArray, cleanUrls, isOwnedUrl,
  isMeasuredAnswer, ownedCitations, citationMatchesPage, summarizeObservations,
} = require('./aeo-measurement');
const { scoreEntityAnswer, isEntityQuestion, buildEntityDashboard } = require('./aeo-entity-facts');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// Trend/share-of-voice window. Fetch by date range rather than a fixed row cap
// so a busy query set (≈queries × platforms rows/day) can't truncate history.
const TREND_DAYS = 30;
const { isEnabled } = require('../../config/feature-gates');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* SDK absent in some envs */ }

// ── Detection constants ──────────────────────────────────────────────────────
// A source URL alone is not a brand mention in the answer.
const WAVES_RE = /\bwaves\s+(?:pest\s+control|lawn(?:\s+care)?)\b/i;

const COMPETITORS = [
  'turner pest', 'hoskins', 'orkin', 'terminix', 'truly nolen',
  'hometeam', 'arrow environmental', 'nozzle nolen', 'massey services',
];
const URL_RE = /https?:\/\/[^\s)<>\]"']+/gi;

// Cost guard — hard ceiling on probes per run regardless of query × platform math.
const configuredProbeCap = Number(process.env.LLM_MENTIONS_MAX_PROBES || 200);
const MAX_PROBES_PER_RUN = Number.isSafeInteger(configuredProbeCap) && configuredProbeCap >= 0 ? configuredProbeCap : 200;

function observationGroups(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, observations]) => ({ key, ...summarizeObservations(observations) }));
}

function buildDashboard(rows, queries) {
  const questionMap = new Map(benchmark.questions.map(q => [q.query, q]));
  const managed = new Map(queries.map(q => [q.query, q]));
  const latest = new Map();
  // Input is newest first. Keep different provider model versions separate so
  // an env swap cannot silently become a before/after content improvement.
  for (const row of rows) {
    const key = `${row.query}::${row.llm_platform}::${row.model_version}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const grid = [...latest.values()].map(row => ({
    ...row,
    waves_cited_urls: ownedCitations(row),
    measured: isMeasuredAnswer(row),
    benchmark_id: questionMap.get(row.query)?.id || null,
    target_cited: ownedCitations(row).some(url => citationMatchesPage(url, questionMap.get(row.query)?.target_path)),
    city: managed.get(row.query)?.city || questionMap.get(row.query)?.city || 'SWFL',
    intent: questionMap.get(row.query)?.intent || (isEntityQuestion(row.query) ? 'entity' : 'custom'),
  }));
  const fixed = grid.filter(row => row.benchmark_id);
  const pageCites = new Map();
  const competitors = new Map();
  for (const row of rows) {
    for (const url of ownedCitations(row)) pageCites.set(url, (pageCites.get(url) || 0) + 1);
  }
  for (const row of grid.filter(isMeasuredAnswer)) {
    for (const competitor of asJsonArray(row.competitors_mentioned)) {
      if (competitor?.name) competitors.set(competitor.name, (competitors.get(competitor.name) || 0) + 1);
    }
  }
  const byPlatform = observationGroups(grid, row => `${row.llm_platform} · ${row.model_version || 'legacy'}`);
  return {
    summary: {
      ...summarizeObservations(grid),
      queriesTracked: new Set(grid.map(row => row.query)).size,
      platforms: [...new Set(grid.map(row => row.llm_platform))],
    },
    benchmark: {
      version: benchmark.version,
      questions: benchmark.questions.length,
      activeQuestions: benchmark.questions.filter(q => managed.has(q.query)).length,
      observedQuestions: new Set(fixed.filter(isMeasuredAnswer).map(row => row.query)).size,
      ...summarizeObservations(fixed),
      byPlatform: observationGroups(fixed, row => `${row.llm_platform} · ${row.model_version || 'legacy'}`),
      byCity: observationGroups(fixed, row => row.city),
      byIntent: observationGroups(fixed, row => row.intent),
    },
    // What the engines say ABOUT Waves (owner-approved facts vs forbidden
    // claims). Separate cohort; never blended into the citation benchmark.
    entity: buildEntityDashboard(grid, queries),
    byPlatform,
    trend: observationGroups(rows.filter(row => questionMap.has(row.query)), row => `${observationDate(row.check_date)} · ${row.llm_platform} · ${row.model_version || 'legacy'}`),
    grid,
    citedPages: [...pageCites].map(([url, count]) => ({ url, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    competitors: [...competitors].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}

class LLMMentionProber {
  /** The managed list is authoritative, including an intentionally empty list. */
  async getQueries() {
    return db('seo_llm_mention_queries').where('active', true).orderBy('created_at', 'asc');
  }

  // ── Per-provider probes. Each returns { text, citedUrls, model, grounded } or null. ──

  async probeOpenAI(query) {
    if (!process.env.OPENAI_API_KEY) return null;
    // The retired 4o search preview returns 404. Keep the dedicated Chat
    // Completions search workload and record its reported model separately.
    const model = process.env.OPENAI_MENTIONS_MODEL || 'gpt-5-search-api';
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          web_search_options: {},
          messages: [{ role: 'user', content: query }],
        }),
      });
      if (!res.ok) { logger.warn(`[llm-mentions] OpenAI ${res.status} for "${query}"`); return null; }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || '';
      const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
      const citedUrls = annotations
        .filter(a => a?.type === 'url_citation')
        .map(a => a?.url_citation?.url || a?.url)
        .filter(Boolean);
      return { text, citedUrls, model: data.model || model, grounded: true, answerAvailable: !msg.refusal && !!text.trim() };
    } catch (err) {
      logger.warn(`[llm-mentions] OpenAI probe failed: ${err.message}`);
      return null;
    }
  }

  async probeGemini(query) {
    if (!process.env.GEMINI_API_KEY) return null;
    // Preserve the configured benchmark model across comparable runs.
    const model = process.env.GEMINI_MENTIONS_MODEL || 'gemini-2.5-flash';
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: {} }], // live grounding
        }),
      });
      if (!res.ok) { logger.warn(`[llm-mentions] Gemini ${res.status} for "${query}"`); return null; }
      const data = await res.json();
      const cand = data?.candidates?.[0] || {};
      const text = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('\n');
      const chunks = cand.groundingMetadata?.groundingChunks || [];
      // A grounding chunk is a search source. Only a support tying it to an
      // answer segment makes it a citation (generateContent response contract).
      const supports = cand.groundingMetadata?.groundingSupports || [];
      const indexes = supports.flatMap(s => s.segment?.text || s.segment?.endIndex > s.segment?.startIndex
        ? (s.groundingChunkIndices || []) : []);
      const attributed = indexes.filter(Number.isInteger).map(i => chunks[i]?.web?.uri).filter(Boolean);
      const sourceUrls = cleanUrls(chunks.map(c => c?.web?.uri));
      const { citedUrls, complete } = await this.resolveGoogleCitations(attributed);
      return { text, citedUrls, sourceUrls, citationsComplete: complete, model: data.modelVersion || model, grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] Gemini probe failed: ${err.message}`);
      return null;
    }
  }

  async probeClaude(query) {
    if (!process.env.ANTHROPIC_API_KEY || !Anthropic) return null;
    const model = process.env.MODEL_MENTIONS || MODELS.WORKHORSE;
    try {
      // maxRetries: 0 — same rule as the #1408 lookup clients: an SDK retry
      // re-runs the whole web_search budget (max_uses), so the default of 2
      // could fan one probe out to 3x the searches on a transient 429/5xx.
      // The probe already degrades to null on error.
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 60000 });
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      });
      const blocks = resp.content || [];
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const citedUrls = [];
      for (const b of blocks.filter(block => block.type === 'text')) {
        for (const c of (b.citations || [])) {
          if (c.url) citedUrls.push(c.url);
        }
      }
      return { text, citedUrls, model: resp.model || model, grounded: true, answerAvailable: resp.stop_reason !== 'refusal' && !!text.trim() };
    } catch (err) {
      logger.warn(`[llm-mentions] Claude probe failed: ${err.message}`);
      return null;
    }
  }

  async probeGoogleAIOverview(query) {
    try {
      // AI Overviews arrive as an `ai_overview` item inside the ORGANIC SERP
      // response — there is no /serp/google/ai_overview/ endpoint. The old
      // path 404'd at the task level ("Invalid Path", status 40402) on every
      // probe since 2026-05-30, and those errors were recorded as legitimate
      // "no overview" observations (the 0/1092 finding, purged by migration
      // 20260729020000). load_async_ai_overview makes DataForSEO wait for the
      // async-loaded overview content instead of returning a stub.
      const data = await dataforseo.request('/serp/google/organic/live/advanced', [{
        keyword: query,
        location_name: 'Bradenton,Florida,United States',
        language_name: 'English',
        load_async_ai_overview: true,
      }]);
      // null = not attempted (unconfigured / gate off / request error) → caller
      // skips, no cost, retries next run.
      if (data == null) return null;
      const task = data?.tasks?.[0];
      // Task-level error (bad path/params/quota) is NOT an observation — the
      // lookup didn't measure the SERP, so recording it would poison the
      // share-of-voice series exactly like the Invalid Path incident did.
      if (task?.status_code !== 20000) {
        logger.warn(`[llm-mentions] AI Overview task error ${task?.status_code} (${task?.status_message}) for "${query}"`);
        return null;
      }
      // A successful SERP with no ai_overview item is a real paid observation:
      // Google showed no overview for this query. It must be recorded so
      // idempotency fires — otherwise the same paid miss re-runs every day,
      // blowing past MAX_PROBES_PER_RUN.
      const items = task?.result?.[0]?.items || [];
      const aio = items.find(i => i.type === 'ai_overview');
      if (!aio) return { text: '', citedUrls: [], model: 'dataforseo:ai_overview', grounded: true };
      // Never scan a serialized result object as prose: source titles/URLs can
      // name Waves even when the actual overview does not.
      const text = aio.markdown || (aio.items || []).map(item => item.text || '').join('\n');
      // Top-level references are pages that MAY have been used. Only links
      // and references attached to a textual answer element prove usage.
      const elements = asJsonArray(aio.items).filter(item => item.type === 'ai_overview_element' && (item.text || item.markdown));
      const citedUrls = elements.flatMap(item => [...asJsonArray(item.references), ...asJsonArray(item.links)]).map(r => r?.url).filter(Boolean);
      const sourceUrls = asJsonArray(aio.references).map(r => r?.url).filter(Boolean);
      return { text, citedUrls, sourceUrls, citationsComplete: citedUrls.length > 0 || sourceUrls.length === 0,
        model: 'dataforseo:ai_overview', grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] AI Overview probe failed: ${err.message}`);
      return null;
    }
  }

  async probePerplexity(query) {
    if (!process.env.PERPLEXITY_API_KEY) return null;
    // Keep Sonar API observations separate from the consumer interface.
    const model = process.env.PERPLEXITY_MENTIONS_MODEL || 'sonar';
    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(60000),
        headers: {
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: query }],
        }),
      });
      if (!res.ok) { logger.warn(`[llm-mentions] Perplexity ${res.status} for "${query}"`); return null; }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      // Sonar's [n] markers address the citation array. Unused search results
      // and unused entries in that array are not attached to the answer.
      const citations = asJsonArray(data.citations);
      const used = [...text.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1]) - 1);
      const citedUrls = used.map(index => citations[index]).filter(Boolean);
      const sourceUrls = [...citations, ...asJsonArray(data.search_results).map(r => r?.url)];
      return { text, citedUrls, sourceUrls, model: data.model || model, grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] Perplexity probe failed: ${err.message}`);
      return null;
    }
  }

  async resolveGoogleCitations(urls) {
    const citedUrls = [];
    let complete = true;
    for (const value of cleanUrls(urls)) {
      const url = new URL(value);
      if (url.hostname !== 'vertexaisearch.cloud.google.com') {
        citedUrls.push(value);
        continue;
      }
      // Follow only the provider's known redirect endpoint, with no forwarded
      // credentials and no request to the destination. Unresolved attribution
      // is excluded from citation rates rather than recorded as a Waves miss.
      if (url.protocol !== 'https:' || !url.pathname.startsWith('/grounding-api-redirect/')) {
        complete = false;
        continue;
      }
      try {
        const res = await fetch(value, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const [destination] = cleanUrls([res.headers.get('location')]);
        if (res.body) await res.body.cancel();
        if (res.status >= 300 && res.status < 400 && destination
          && new URL(destination).hostname !== url.hostname) citedUrls.push(destination);
        else complete = false;
      } catch { complete = false; }
    }
    return { citedUrls, complete };
  }

  /** Map platform key → probe fn. */
  get providers() {
    const providers = {};
    if (process.env.OPENAI_API_KEY) providers.chatgpt = q => this.probeOpenAI(q);
    if (process.env.GEMINI_API_KEY) providers.gemini = q => this.probeGemini(q);
    if (process.env.ANTHROPIC_API_KEY && Anthropic) providers.claude = q => this.probeClaude(q);
    if (dataforseo.configured) providers.google_ai_overview = q => this.probeGoogleAIOverview(q);
    if (process.env.PERPLEXITY_API_KEY) providers.perplexity = q => this.probePerplexity(q);
    return providers;
  }

  /** Deterministic parse of a probe result into a mention row payload. */
  parse(probe) {
    const text = probe.text || '';
    const prose = text.replace(URL_RE, url => ' '.repeat(url.length));
    const lower = prose.toLowerCase();

    // Only provider-attributed citations count. Bare URLs in generated prose
    // and the broader source pool remain evidence, not citation successes.
    const citedUrls = cleanUrls(probe.citedUrls);
    const wavesCitedUrls = citedUrls.filter(isOwnedUrl);

    const brandInText = WAVES_RE.test(prose);
    const wavesMentioned = brandInText;

    // Brand ordering → rank position of first Waves reference among brands.
    const positions = [];
    const wavesIdx = lower.search(WAVES_RE);
    if (wavesIdx >= 0) positions.push({ name: 'waves', idx: wavesIdx });
    const competitors = [];
    for (const c of COMPETITORS) {
      const idx = lower.indexOf(c);
      if (idx >= 0) { competitors.push({ name: c, context: text.substring(idx, idx + 120) }); positions.push({ name: c, idx }); }
    }
    positions.sort((a, b) => a.idx - b.idx);
    const rankPosition = brandInText
      ? positions.findIndex(p => p.name === 'waves') + 1
      : null;

    return {
      wavesMentioned,
      mentionContext: brandInText ? text.substring(Math.max(0, wavesIdx - 60), wavesIdx + 240) : null,
      competitors,
      rankPosition: rankPosition && rankPosition > 0 ? rankPosition : null,
      citedUrls,
      wavesCitedUrls,
      sourceUrls: cleanUrls(probe.sourceUrls),
      answerAvailable: probe.answerAvailable ?? !!text.trim(),
      citationsComplete: probe.citationsComplete !== false,
    };
  }

  /** Light LLM sentiment pass, only when Waves is actually mentioned. */
  async classifySentiment(context) {
    if (!context || !process.env.ANTHROPIC_API_KEY || !Anthropic) return 'neutral';
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: MODELS.FAST,
        max_tokens: 8,
        messages: [{
          role: 'user',
          content: `An AI answer mentioned "Waves Pest Control" like this:\n"""${context}"""\nReply with ONE word — positive, neutral, or negative — for how it portrays Waves.`,
        }],
      });
  // Thinking-block guard: WORKHORSE/FAST resolve to a model that can lead
  // with a thinking block (no .text) on larger inputs, which made a blind
  // content[0] read return '' — see event-ingestion.js for the incident.
      const word = (stripThinkingBlocks(resp).content?.[0]?.text || '').toLowerCase().trim();
      return ['positive', 'negative', 'neutral'].find(s => word.includes(s)) || 'neutral';
    } catch {
      return 'neutral';
    }
  }

  /**
   * Run one probe pass across all managed queries × configured platforms.
   * Idempotent: skips any (query, platform) already recorded for today.
   */
  async runDaily() {
    if (!isEnabled('seoIntelligence')) {
      logger.info('[llm-mentions] seoIntelligence gate off — skipping');
      return { skipped: true };
    }

    const batchId = crypto.randomUUID();
    const checkDate = etDateString();
    const queries = await this.getQueries();
    const providers = this.providers;
    const platforms = Object.keys(providers);

    // Advance one attempt window each ET calendar day, including failed pairs.
    // Successful-observation timestamps cannot rotate failures: enough broken
    // pairs would remain perpetually oldest and monopolize the run ceiling.
    const pairs = queries.flatMap(qrow => platforms.map(platform => ({ qrow, platform, key: `${qrow.query}::${platform}` })))
      .sort((a, b) => a.key.localeCompare(b.key));
    const dayOrdinal = Math.floor(Date.parse(`${checkDate}T00:00:00Z`) / 86400000);
    const offset = pairs.length ? (dayOrdinal * MAX_PROBES_PER_RUN) % pairs.length : 0;
    const pending = [...pairs.slice(offset), ...pairs.slice(0, offset)];

    // Today's already-recorded (query, platform) pairs → idempotency set.
    const existing = await db('seo_llm_mentions')
      .where('check_date', checkDate)
      .select('query', 'llm_platform');
    const done = new Set(existing.map(r => `${r.query}::${r.llm_platform}`));

    let attempted = 0, probed = 0, inserted = 0, wavesHits = 0;
    for (const { qrow, platform } of pending) {
      if (attempted >= MAX_PROBES_PER_RUN) {
        logger.warn(`[llm-mentions] Hit MAX_PROBES_PER_RUN (${MAX_PROBES_PER_RUN}); stopping early`);
        break;
      }
      if (done.has(`${qrow.query}::${platform}`)) continue;

      attempted++; // a failed request may still have incurred provider cost
      const probe = await providers[platform](qrow.query);
      if (!probe) continue;
      probed++;

      const parsed = this.parse(probe);
      const sentiment = parsed.wavesMentioned
        ? await this.classifySentiment(parsed.mentionContext)
        : 'neutral';
      // Deterministic fact score for entity-cohort questions; null elsewhere.
      const entityFacts = parsed.answerAvailable ? scoreEntityAnswer(qrow.query, probe.text) : null;
      if (parsed.wavesMentioned) wavesHits++;

      // onConflict ignore is the race backstop: two overlapping runs (e.g.
      // scheduler on multiple pods + an admin scan) both build `done` before
      // either insert, so the unique (query, llm_platform, check_date) index
      // is what actually prevents duplicate same-day observations.
      const ins = await db('seo_llm_mentions').insert({
        query_id: qrow.id || null,
        batch_id: batchId,
        llm_platform: platform,
        query: qrow.query,
        response_raw: (probe.text || '').substring(0, 8000),
        mention_context: parsed.mentionContext,
        waves_mentioned: parsed.wavesMentioned,
        competitors_mentioned: JSON.stringify(parsed.competitors),
        cited_urls: JSON.stringify(parsed.citedUrls),
        waves_cited_urls: JSON.stringify(parsed.wavesCitedUrls),
        source_urls: JSON.stringify(parsed.sourceUrls),
        measurement_version: MEASUREMENT_VERSION,
        answer_available: parsed.answerAvailable,
        citations_complete: parsed.citationsComplete,
        rank_position: parsed.rankPosition,
        entity_facts: entityFacts ? JSON.stringify(entityFacts) : null,
        sentiment,
        model_version: probe.model,
        grounded: !!probe.grounded,
        check_date: checkDate,
      }).onConflict(['query', 'llm_platform', 'check_date']).ignore();
      if (ins.rowCount !== 0) inserted++;
    }

    logger.info(`[llm-mentions] batch ${batchId}: ${probed} probed, ${inserted} recorded, ${wavesHits} Waves hits`);
    return { batchId, attempted, probed, inserted, wavesHits };
  }

  /**
   * Mention and linked-citation rates use answered, attributable V2 probes.
   * Legacy, no-answer and unresolved-source observations remain visible but
   * never become citation misses. API probes are not consumer UI measurements.
   */
  async getDashboard() {
    const since = etDateString(addETDays(new Date(), -(TREND_DAYS - 1)));
    const rows = await db('seo_llm_mentions')
      .where('check_date', '>=', since)
      .orderBy('check_date', 'desc');
    const queries = await this.getQueries();
    return buildDashboard(rows.filter(row => queries.some(q => q.query === row.query)), queries);
  }
}

module.exports = new LLMMentionProber();
module.exports.LLMMentionProber = LLMMentionProber;
module.exports.buildDashboard = buildDashboard;
