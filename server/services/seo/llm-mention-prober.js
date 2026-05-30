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
 *   - Perplexity → DEFERRED until PERPLEXITY_API_KEY is provisioned.
 *
 * A platform whose key/gate is missing is skipped silently — the run degrades
 * to whatever providers are configured rather than failing.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const MODELS = require('../../config/models');
const twilioNumbers = require('../../config/twilio-numbers');
const { etDateString } = require('../../utils/datetime-et');
const { isEnabled } = require('../../config/feature-gates');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* SDK absent in some envs */ }

// ── Detection constants ──────────────────────────────────────────────────────
// Brand mention in prose — covers both the pest and lawn sides of the business
// (Waves Pest Control / Waves Lawn Care) plus their primary domains.
const WAVES_RE = /waves\s+(pest|lawn)|wavespestcontrol|waveslawncare/i;
// Every owned domain counts as a Waves citation — the hub plus the spoke fleet
// (bradentonflpestcontrol.com, sarasotaflpestcontrol.com, …) — sourced from the
// tracking-domain config so it stays in sync as domains are added/removed.
const OWNED_DOMAINS = Array.from(new Set([
  'wavespestcontrol.com',
  ...(twilioNumbers.domainTracking || []).map(d => d.domain),
  ...(twilioNumbers.lawnDomainTracking || []).map(d => d.domain),
].filter(Boolean).map(d => String(d).toLowerCase())));

// Owned-domain match on the URL *hostname* with exact-host-or-subdomain
// boundaries — never a substring of the full URL, so `?source=wavespestcontrol.com`
// and superdomains like `wavespestcontrol.com.evil.example` are not counted.
function isOwnedUrl(u) {
  let host;
  try { host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return OWNED_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}

const COMPETITORS = [
  'turner pest', 'hoskins', 'orkin', 'terminix', 'truly nolen',
  'hometeam', 'arrow environmental', 'nozzle nolen', 'massey services',
];
const URL_RE = /https?:\/\/[^\s)<>\]"']+/gi;

// pg returns jsonb columns already parsed as JS arrays/objects, but legacy rows
// (and string inserts) may still be strings — normalize either shape to an array.
function asJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') { try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

// Cost guard — hard ceiling on probes per run regardless of query × platform math.
const MAX_PROBES_PER_RUN = Number(process.env.LLM_MENTIONS_MAX_PROBES || 200);

class LLMMentionProber {
  /** Managed query list; falls back to a minimal default set if table empty. */
  async getQueries() {
    let rows = [];
    try {
      rows = await db('seo_llm_mention_queries').where('active', true).orderBy('created_at', 'asc');
    } catch { /* table may not exist pre-migration */ }
    if (rows.length) return rows;
    return [
      { id: null, query: 'best pest control bradenton florida', city: 'Bradenton', service: 'pest control' },
      { id: null, query: 'pest control sarasota fl reviews', city: 'Sarasota', service: 'pest control' },
      { id: null, query: 'lawn care service lakewood ranch', city: 'Lakewood Ranch', service: 'lawn care' },
      { id: null, query: 'termite inspection bradenton', city: 'Bradenton', service: 'termite' },
      { id: null, query: 'mosquito control southwest florida', city: null, service: 'mosquito' },
    ];
  }

  // ── Per-provider probes. Each returns { text, citedUrls, model, grounded } or null. ──

  async probeOpenAI(query) {
    if (!process.env.OPENAI_API_KEY) return null;
    // Search-preview models return live-web answers + url citation annotations,
    // approximating what a consumer sees in ChatGPT rather than training recall.
    const model = process.env.OPENAI_MENTIONS_MODEL || 'gpt-4o-search-preview';
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: query }],
        }),
      });
      if (!res.ok) { logger.warn(`[llm-mentions] OpenAI ${res.status} for "${query}"`); return null; }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      const text = msg.content || '';
      const annotations = Array.isArray(msg.annotations) ? msg.annotations : [];
      const citedUrls = annotations
        .map(a => a?.url_citation?.url || a?.url)
        .filter(Boolean);
      return { text, citedUrls, model, grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] OpenAI probe failed: ${err.message}`);
      return null;
    }
  }

  async probeGemini(query) {
    if (!process.env.GEMINI_API_KEY) return null;
    const model = process.env.GEMINI_MENTIONS_MODEL || 'gemini-2.0-flash';
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: {} }], // live grounding
        }),
      });
      if (!res.ok) { logger.warn(`[llm-mentions] Gemini ${res.status} for "${query}"`); return null; }
      const data = await res.json();
      const cand = data?.candidates?.[0] || {};
      const text = (cand.content?.parts || []).map(p => p.text || '').join('\n');
      const chunks = cand.groundingMetadata?.groundingChunks || [];
      const citedUrls = chunks.map(c => c?.web?.uri).filter(Boolean);
      return { text, citedUrls, model, grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] Gemini probe failed: ${err.message}`);
      return null;
    }
  }

  async probeClaude(query) {
    if (!process.env.ANTHROPIC_API_KEY || !Anthropic) return null;
    const model = process.env.MODEL_MENTIONS || MODELS.WORKHORSE;
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      });
      const blocks = resp.content || [];
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const citedUrls = [];
      for (const b of blocks) {
        for (const c of (b.citations || [])) {
          if (c.url) citedUrls.push(c.url);
        }
      }
      return { text, citedUrls, model, grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] Claude probe failed: ${err.message}`);
      return null;
    }
  }

  async probeGoogleAIOverview(query) {
    try {
      const data = await dataforseo.request('/serp/google/ai_overview/live/advanced', [{
        keyword: query,
        location_name: 'Bradenton,Florida,United States',
        language_name: 'English',
      }]);
      const items = data?.tasks?.[0]?.result?.[0]?.items || [];
      const aio = items.find(i => i.type === 'ai_overview');
      if (!aio) return null;
      const text = JSON.stringify(aio);
      const citedUrls = (aio.references || aio.items || [])
        .map(r => r?.url)
        .filter(Boolean);
      return { text, citedUrls, model: 'dataforseo:ai_overview', grounded: true };
    } catch (err) {
      logger.warn(`[llm-mentions] AI Overview probe failed: ${err.message}`);
      return null;
    }
  }

  /** Map platform key → probe fn. */
  get providers() {
    return {
      chatgpt: q => this.probeOpenAI(q),
      gemini: q => this.probeGemini(q),
      claude: q => this.probeClaude(q),
      google_ai_overview: q => this.probeGoogleAIOverview(q),
    };
  }

  /** Deterministic parse of a probe result into a mention row payload. */
  parse(probe) {
    const text = probe.text || '';
    const lower = text.toLowerCase();

    // Citations: union of provider-native + URLs parsed from prose.
    const inlineUrls = (text.match(URL_RE) || []).map(u => u.replace(/[.,)]+$/, ''));
    const citedUrls = Array.from(new Set([...(probe.citedUrls || []), ...inlineUrls]));
    const wavesCitedUrls = citedUrls.filter(isOwnedUrl);

    // Mentioned if the brand shows up in prose OR any owned domain is cited —
    // the latter covers lawn/spoke visibility even when the prose names no brand.
    const brandInText = WAVES_RE.test(text);
    const wavesMentioned = brandInText || wavesCitedUrls.length > 0;

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
      const word = (resp.content?.[0]?.text || '').toLowerCase().trim();
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
    const platforms = Object.keys(this.providers);

    // Today's already-recorded (query, platform) pairs → idempotency set.
    const existing = await db('seo_llm_mentions')
      .where('check_date', checkDate)
      .select('query', 'llm_platform');
    const done = new Set(existing.map(r => `${r.query}::${r.llm_platform}`));

    let probed = 0, inserted = 0, wavesHits = 0;
    for (const qrow of queries) {
      for (const platform of platforms) {
        if (probed >= MAX_PROBES_PER_RUN) {
          logger.warn(`[llm-mentions] Hit MAX_PROBES_PER_RUN (${MAX_PROBES_PER_RUN}); stopping early`);
          break;
        }
        if (done.has(`${qrow.query}::${platform}`)) continue;

        const probe = await this.providers[platform](qrow.query);
        probed++;
        if (!probe) continue; // provider unconfigured or errored — leave the slot for a retry next run

        const parsed = this.parse(probe);
        const sentiment = parsed.wavesMentioned
          ? await this.classifySentiment(parsed.mentionContext)
          : 'neutral';
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
          rank_position: parsed.rankPosition,
          sentiment,
          model_version: probe.model,
          grounded: !!probe.grounded,
          check_date: checkDate,
        }).onConflict(['query', 'llm_platform', 'check_date']).ignore();
        if (ins.rowCount !== 0) inserted++;
      }
      if (probed >= MAX_PROBES_PER_RUN) break;
    }

    logger.info(`[llm-mentions] batch ${batchId}: ${probed} probed, ${inserted} recorded, ${wavesHits} Waves hits`);
    return { batchId, probed, inserted, wavesHits };
  }

  /**
   * Dashboard payload: share-of-voice over time, latest per query × platform,
   * competitor presence, and which Waves pages get cited.
   */
  async getDashboard() {
    const rows = await db('seo_llm_mentions')
      .orderBy('check_date', 'desc')
      .limit(500);

    // Latest row per (query, platform) for the current-state grid.
    const latest = new Map();
    for (const r of rows) {
      const key = `${r.query}::${r.llm_platform}`;
      if (!latest.has(key)) latest.set(key, r);
    }
    const grid = Array.from(latest.values());

    const byPlatform = {};
    for (const r of grid) {
      const p = (byPlatform[r.llm_platform] ||= { platform: r.llm_platform, total: 0, mentioned: 0 });
      p.total++;
      if (r.waves_mentioned) p.mentioned++;
    }
    for (const p of Object.values(byPlatform)) {
      p.shareOfVoice = p.total ? Math.round((p.mentioned / p.total) * 100) : 0;
    }

    // Share-of-voice trend by check_date.
    const trendMap = new Map();
    for (const r of rows) {
      const d = String(r.check_date).slice(0, 10);
      const t = trendMap.get(d) || { date: d, total: 0, mentioned: 0 };
      t.total++; if (r.waves_mentioned) t.mentioned++;
      trendMap.set(d, t);
    }
    const trend = Array.from(trendMap.values())
      .map(t => ({ ...t, shareOfVoice: t.total ? Math.round((t.mentioned / t.total) * 100) : 0 }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    // Which Waves pages get cited (across the recent window).
    const pageCites = {};
    for (const r of rows) {
      for (const u of asJsonArray(r.waves_cited_urls)) pageCites[u] = (pageCites[u] || 0) + 1;
    }
    const citedPages = Object.entries(pageCites)
      .map(([url, count]) => ({ url, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    // Competitor presence across the grid.
    const compCount = {};
    for (const r of grid) {
      for (const c of asJsonArray(r.competitors_mentioned)) compCount[c.name] = (compCount[c.name] || 0) + 1;
    }
    const competitors = Object.entries(compCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      summary: {
        queriesTracked: new Set(grid.map(r => r.query)).size,
        platforms: Object.keys(byPlatform),
        overallShareOfVoice: grid.length
          ? Math.round((grid.filter(r => r.waves_mentioned).length / grid.length) * 100)
          : 0,
      },
      byPlatform: Object.values(byPlatform),
      trend,
      grid,
      citedPages,
      competitors,
    };
  }
}

module.exports = new LLMMentionProber();
module.exports.LLMMentionProber = LLMMentionProber;
