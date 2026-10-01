'use strict';

/**
 * Estimated LLM spend (GATE_LLM_COST_TRACKING, dark).
 *
 *   pullPrices()          copy OpenRouter's public per-token prices into
 *                         llm_model_prices (weekly; never hand-typed — owner
 *                         ruling 2026-09-03 in config/models.js)
 *   laneCosts(from, to)   estimated USD per switchboard lane over [from, to),
 *                         from the call ledger's token columns
 *   runLlmCostCheck()     daily: refresh prices when a week old, then raise
 *                         ONE admin item listing lanes whose spend yesterday
 *                         jumped well above their own recent average
 *
 * Every number is an ESTIMATE: tokens from the ledger (llm_dispatch_log,
 * GATE_LLM_CALL_LEDGER) times today's list price. Rows the ledger has no
 * usage for, and models the feed does not list, are counted as unpriced —
 * never guessed. Image, video, audio and embedding calls write no ledger
 * row, so they are not in these totals. Nothing here is customer-facing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { llmCostTrackingLive } = require('../config/feature-gates');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const PRICES = 'llm_model_prices';
const LEDGER = 'llm_dispatch_log';
const FEED_URL = 'https://openrouter.ai/api/v1/models';
const FEED_TIMEOUT_MS = 20000;
// A real feed lists hundreds of models; far fewer usable rows means the
// response changed shape, and writing it would blank good prices.
const MIN_FEED_ROWS = 20;
const PRICE_MAX_AGE_DAYS = 7;
// OpenRouter id prefix → the ledger's provider column.
const FEED_PROVIDERS = Object.freeze({ anthropic: 'anthropic', openai: 'openai', google: 'gemini' });
const LIVE_WORKLOAD = "(workload IS NULL OR workload = 'live')";
// Same rows the hub sums: per-call rows and per-turn session deltas.
const ROW_KINDS = ['call', 'session_turn'];

// Spend-spike rule: yesterday's estimated spend on a lane is at least
// MIN_USD AND at least MULTIPLIER × its average day over the 7 days before.
const ALERT_CATEGORY = 'llm_cost';
const KEY_PREFIX = 'llm-cost-spike:';
const LINK = '/admin/agents';
const BASELINE_DAYS = 7;
const MAX_LISTED = 8;
function positiveEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const alertMinUsd = () => positiveEnv('LLM_COST_ALERT_MIN_USD', 5);
const alertMultiplier = () => positiveEnv('LLM_COST_ALERT_MULTIPLIER', 3);

// ── Model ids ────────────────────────────────────────────────────────

/**
 * One key per model id, feed or ledger: lowercase, no provider prefix,
 * ":variant" or "-latest", dots as dashes. A trailing date stamp is KEPT:
 * a dated snapshot can be priced apart from its alias.
 *   "<vendor>/<family>-4.5"     → "<family>-4-5"
 *   "<family>-4-5-<yyyymmdd>"   → "<family>-4-5-<yyyymmdd>"
 */
function normalizeModelId(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  let s = id.trim().toLowerCase();
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.split(':')[0];
  s = s.replace(/\./g, '-');
  s = s.replace(/-latest$/, '');
  return s || null;
}

// The undated alias a dated key belongs to ("x-20251001" / "x-2025-10-01" → "x").
function aliasKeyOf(key) {
  return key.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

const samePrice = (a, b) => ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].every((k) => a[k] === b[k]);

/**
 * The price for a ledger model, or null (unpriced). Its own key first. A
 * dated model the feed does not list takes its undated alias's price only
 * while every snapshot the feed lists for that alias costs the same as the
 * alias: if any differs, which one this model bills as is unknown, so it is
 * unpriced. Anything else (a preview build, a renamed model) is unpriced —
 * never priced as a lookalike.
 */
function priceFor(prices, model) {
  const key = normalizeModelId(model);
  if (!key) return null;
  if (prices.has(key)) return prices.get(key);
  const alias = aliasKeyOf(key);
  if (alias === key || !prices.has(alias)) return null;
  const aliasPrice = prices.get(alias);
  for (const [k, p] of prices) {
    if (k !== alias && aliasKeyOf(k) === alias && !samePrice(p, aliasPrice)) return null;
  }
  return aliasPrice;
}

// ── Price feed ───────────────────────────────────────────────────────

// Feed prices are strings of USD per token; stored per million tokens.
function perMillion(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * 1e6).toFixed(6));
}

/** Feed JSON → price rows (pure). Unknown providers, variants and unpriced models are dropped. */
function parseFeed(body, fetchedAt) {
  const rows = new Map();
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    const id = typeof m?.id === 'string' ? m.id : '';
    const provider = FEED_PROVIDERS[id.split('/')[0]];
    // ":free" / ":thinking" variants are not what the APIs bill
    if (!provider || id.includes(':')) continue;
    const key = normalizeModelId(id);
    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    if (!key || input == null || output == null) continue;
    const row = {
      model_key: key,
      provider,
      source: 'openrouter',
      source_model_id: id.slice(0, 200),
      input_per_mtok: input,
      output_per_mtok: output,
      cache_read_per_mtok: perMillion(m.pricing?.input_cache_read),
      cache_write_per_mtok: perMillion(m.pricing?.input_cache_write),
      reasoning_per_mtok: perMillion(m.pricing?.internal_reasoning),
      fetched_at: fetchedAt,
    };
    // Two ids can still share a key ("x" and "x-latest"): keep the shorter.
    const existing = rows.get(key);
    if (!existing || id.length < existing.source_model_id.length) rows.set(key, row);
  }
  return [...rows.values()];
}

async function pullPrices({ conn = db, fetchImpl = fetch, now = new Date() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  let body;
  try {
    const res = await fetchImpl(FEED_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`price feed answered ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const rows = parseFeed(body, now);
  if (rows.length < MIN_FEED_ROWS) throw new Error(`price feed listed only ${rows.length} usable models; kept the stored prices`);
  await conn(PRICES).insert(rows).onConflict('model_key').merge();
  return { models: rows.length };
}

const num = (v) => (v == null ? null : Number(v));

async function loadPrices(conn = db) {
  const rows = await conn(PRICES).select('model_key', 'input_per_mtok', 'output_per_mtok', 'cache_read_per_mtok', 'cache_write_per_mtok', 'reasoning_per_mtok', 'fetched_at');
  const map = new Map();
  let oldest = null;
  for (const r of rows) {
    map.set(r.model_key, {
      input: num(r.input_per_mtok),
      output: num(r.output_per_mtok),
      cacheRead: num(r.cache_read_per_mtok),
      cacheWrite: num(r.cache_write_per_mtok),
      reasoning: num(r.reasoning_per_mtok),
    });
    const at = new Date(r.fetched_at);
    if (!oldest || at < oldest) oldest = at;
  }
  return { map, oldestFetchedAt: oldest };
}

// ── Cost ─────────────────────────────────────────────────────────────

/**
 * Estimated USD for summed token counts on one provider + price (pure).
 * Providers disagree on what the counts contain (llm-dispatch-metrics
 * extractUsage):
 *   anthropic  input EXCLUDES cache reads and writes, which are reported beside it
 *   openai     input INCLUDES cached tokens; output INCLUDES reasoning
 *   gemini     input INCLUDES cached tokens; thoughts are billed beside output
 * A missing cache / reasoning rate bills at the plain input / output rate
 * (an overestimate, never an underestimate). Unknown provider → null.
 */
function costUsd(provider, t, p) {
  if (!p) return null;
  const n = (v) => Math.max(0, Number(v) || 0);
  const input = n(t.input_tokens);
  const cached = n(t.cached_input_tokens);
  const cacheWrite = n(t.cache_write_tokens);
  const output = n(t.output_tokens);
  const reasoning = n(t.reasoning_tokens);
  const cacheRead = p.cacheRead ?? p.input;
  let perMillion;
  if (provider === 'anthropic') {
    perMillion = input * p.input + cached * cacheRead + cacheWrite * (p.cacheWrite ?? p.input) + output * p.output;
  } else if (provider === 'openai') {
    perMillion = Math.max(0, input - cached) * p.input + cached * cacheRead + output * p.output;
  } else if (provider === 'gemini') {
    perMillion = Math.max(0, input - cached) * p.input + cached * cacheRead + output * p.output + reasoning * (p.reasoning ?? p.output);
  } else {
    return null;
  }
  return perMillion / 1e6;
}

// Token sums per lane × provider × model over [from, to). `usage_unknown`
// counts rows whose usage was never captured (null counters).
function laneModelRows(from, to, conn = db) {
  return conn(LEDGER)
    .whereIn('row_kind', ROW_KINDS)
    .whereNotNull('lane_id')
    .whereRaw(LIVE_WORKLOAD)
    .where('created_at', '>=', from)
    .andWhere('created_at', '<', to)
    .groupByRaw('lane_id, provider, COALESCE(served_model, requested_model)')
    .select(
      'lane_id',
      'provider',
      conn.raw('COALESCE(served_model, requested_model) AS model'),
      conn.raw('COUNT(*)::int AS calls'),
      conn.raw('COUNT(*) FILTER (WHERE input_tokens IS NULL)::int AS usage_unknown'),
      conn.raw('COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens'),
      conn.raw('COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens'),
      conn.raw('COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens'),
      conn.raw('COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens'),
      conn.raw('COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens'),
    );
}

/**
 * Fold lane × model rows into per-lane estimates (pure):
 * Map(laneId → { usd, unpricedCalls }). unpricedCalls = calls with no usage,
 * plus every call on a model the price table does not list.
 */
function foldLaneCosts(rows, prices) {
  const out = new Map();
  for (const r of rows) {
    const lane = out.get(r.lane_id) || { usd: 0, unpricedCalls: 0 };
    const calls = Number(r.calls) || 0;
    const unknown = Number(r.usage_unknown) || 0;
    const cost = costUsd(r.provider, r, priceFor(prices, r.model));
    if (cost == null) lane.unpricedCalls += calls;
    else {
      lane.usd += cost;
      lane.unpricedCalls += unknown;
    }
    out.set(r.lane_id, lane);
  }
  return out;
}

/** Estimated spend per lane over [from, to), plus how old the oldest price is. */
async function laneCosts(from, to, { conn = db } = {}) {
  const [rows, prices] = await Promise.all([laneModelRows(from, to, conn), loadPrices(conn)]);
  return { byLane: foldLaneCosts(rows, prices.map), pricesFetchedAt: prices.oldestFetchedAt, priced: prices.map.size > 0 };
}

// ── Daily spend check ────────────────────────────────────────────────

const etMidnight = (date) => parseETDateTime(`${etDateString(date)}T00:00`);
const usd = (v) => `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;

/**
 * Lanes whose spend on `day` cleared the spike rule against their average
 * day over the baseline (pure). A lane with no baseline spend at all is a
 * spike once it clears the minimum.
 */
function findSpikes(dayByLane, baselineByLane, { minUsd = alertMinUsd(), multiplier = alertMultiplier(), baselineDays = BASELINE_DAYS } = {}) {
  const spikes = [];
  for (const [laneId, day] of dayByLane) {
    const avg = (baselineByLane.get(laneId)?.usd || 0) / baselineDays;
    if (day.usd >= minUsd && day.usd >= multiplier * avg) spikes.push({ laneId, usd: day.usd, avgUsd: avg });
  }
  return spikes.sort((a, b) => b.usd - a.usd);
}

async function closeSpikeItems(conn, now, reason, keep = null) {
  const episodes = require('./admin-alert-episodes');
  const keys = (await episodes.openAdminAlertKeys(conn, KEY_PREFIX)).filter((k) => k !== keep);
  if (!keys.length) return 0;
  return Number(await episodes.closeAdminAlertKeys(conn, keys, reason, {
    now,
    resolution: reason === 'spend_normal' ? 'AI spend is back to its usual level' : 'Replaced by a newer spend check',
  })) || 0;
}

async function refreshPricesIfStale({ conn, fetchImpl, now }) {
  const newest = await conn(PRICES).max('fetched_at as at').first();
  const at = newest?.at ? new Date(newest.at) : null;
  if (at && now.getTime() - at.getTime() < PRICE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return { refreshed: false };
  try {
    return { refreshed: true, ...(await pullPrices({ conn, fetchImpl, now })) };
  } catch (err) {
    // Stored prices (if any) stay in use; with none at all the check cannot run.
    if (!at) throw err;
    logger.warn(`[llm-cost] price refresh failed, using prices from ${at.toISOString()}: ${err.message}`);
    return { refreshed: false, error: err.message };
  }
}

async function runLlmCostCheck({ now = new Date(), conn = db, fetchImpl = fetch } = {}) {
  if (!llmCostTrackingLive()) return { ran: false, reason: 'gate_off' };
  const prices = await refreshPricesIfStale({ conn, fetchImpl, now });

  const todayStart = etMidnight(now);
  const dayStart = etMidnight(addETDays(now, -1));
  const baselineStart = etMidnight(addETDays(now, -(1 + BASELINE_DAYS)));
  const [day, baseline] = await Promise.all([
    laneCosts(dayStart, todayStart, { conn }),
    laneCosts(baselineStart, dayStart, { conn }),
  ]);
  const spikes = findSpikes(day.byLane, baseline.byLane);
  if (!spikes.length) {
    await closeSpikeItems(conn, now, 'spend_normal').catch((err) => logger.warn(`[llm-cost] spike item close failed: ${err.message}`));
    return { ran: true, raised: false, spikes: 0, prices };
  }

  const names = new Map(require('./model-switchboard').getSwitchboard().lanes.map((l) => [l.id, l.name]));
  const nameOf = (id) => names.get(id) || id;
  const dayLabel = etDateString(addETDays(now, -1));
  const top = spikes[0];
  const detail = [
    `Estimated AI spend on ${dayLabel} (ET) per lane, against that lane's average day over the ${BASELINE_DAYS} days before. A lane is listed at ${usd(alertMinUsd())} or more and at least ${alertMultiplier()}x its average. Estimates use OpenRouter list prices and the call ledger's token counts; image, audio and embedding calls are not included.`,
    ...spikes.slice(0, MAX_LISTED).map((s) => `${nameOf(s.laneId)}: ${usd(s.usd)} vs ${usd(s.avgUsd)}/day`),
    ...(spikes.length > MAX_LISTED ? [`and ${spikes.length - MAX_LISTED} more`] : []),
    `Lanes: ${LINK}`,
  ].join('\n');

  const dedupeKey = `${KEY_PREFIX}${dayLabel}`;
  const alert = await require('./admin-alert-compose').raiseAdminAlert(ALERT_CATEGORY, {
    area: 'System',
    action: spikes.length === 1 ? 'check AI spend on one lane' : `check AI spend on ${spikes.length} lanes`,
    // the why is capped at 110 characters; a long lane name gives way first
    why: `${nameOf(top.laneId).slice(0, 48)} cost ${usd(top.usd)} yesterday vs ${usd(top.avgUsd)} on an average day`,
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: 'llm-cost-spike' },
    doneWhen: 'spend_reviewed',
    who: 'person',
  }, {
    detail,
    dedupeKey,
    refreshOnDedupe: true,
    metadata: { lane: 'llm_cost', day: dayLabel, spikes: spikes.map((s) => ({ laneId: s.laneId, usd: Number(s.usd.toFixed(4)), avgUsd: Number(s.avgUsd.toFixed(4)) })) },
  });
  if (!alert) {
    logger.warn('[llm-cost] spend spike item was not persisted');
    return { ran: true, raised: false, reason: 'alert_not_persisted', spikes: spikes.length, prices };
  }
  await closeSpikeItems(conn, now, 'superseded', dedupeKey).catch((err) => logger.warn(`[llm-cost] spike item close failed: ${err.message}`));
  return { ran: true, raised: true, spikes: spikes.length, dedupeKey, prices };
}

module.exports = {
  pullPrices,
  loadPrices,
  laneCosts,
  runLlmCostCheck,
  // exported for tests
  normalizeModelId,
  parseFeed,
  priceFor,
  costUsd,
  foldLaneCosts,
  findSpikes,
  laneModelRows,
  ALERT_CATEGORY,
  KEY_PREFIX,
  FEED_URL,
  MIN_FEED_ROWS,
};
