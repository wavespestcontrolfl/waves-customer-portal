/**
 * AI Overview gap sweep (AI Overview pilot, PR 2).
 *
 * Finds every search a customer makes where Google shows an AI Overview and
 * Waves is not cited. A run collects candidate searches (Search Console
 * queries of the last 90 days, competitor-gap queries, managed questions),
 * stores each as a 'pending' row, then a 10-minute job takes the next chunk
 * and makes ONE mobile SERP call per row. Every attempt is stored, failures
 * included. rankGaps() lists the shown-and-not-cited searches, web citations
 * first, then by impressions.
 *
 * Cost is bounded two ways: a run has a max_cost_usd (a chunk stops once the
 * run's cost reaches it) and a run holds at most `max` candidates. Only one run
 * can be open at a time (partial unique index plus a check in startSweep).
 */
const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { parseSerp } = require('./aio-pinned-capture');
const { WAVES_RE } = require('./llm-mention-companies');
const { normalizeCity } = require('./llm-app-scraper');
const { isOwnedUrl } = require('./aeo-measurement');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const SERP_PATH = '/serp/google/organic/live/advanced';
const DEFAULT_MIN_IMPRESSIONS = 20;
const DEFAULT_MAX_CANDIDATES = 2500;
const DEFAULT_MAX_COST_USD = 10;
const DEFAULT_CHUNK_SIZE = 40;
const CHUNK_CONCURRENCY = 4;
const GSC_WINDOW_DAYS = 90;
const INSERT_BATCH = 500;

// "lat,lng" per service city; dataforseo.serpLocation adds the radius.
const CITY_COORDS = {
  Bradenton: '27.4989,-82.5748',
  Sarasota: '27.3364,-82.5307',
  'Lakewood Ranch': '27.4186,-82.4186',
  Parrish: '27.5743,-82.4276',
  Venice: '27.0998,-82.4543',
  'North Port': '27.0442,-82.2359',
  'Port Charlotte': '26.9762,-82.0909',
  Palmetto: '27.5214,-82.5723',
  Ellenton: '27.5200,-82.5290',
  Osprey: '27.1953,-82.4887',
  Nokomis: '27.1231,-82.4440',
  Englewood: '26.9620,-82.3526',
  'Myakka City': '27.3586,-82.1590',
  'Punta Gorda': '26.9298,-82.0454',
};
const DEFAULT_CITY = 'Lakewood Ranch';
const PALMETTO_PEST_RE = /\bpalmetto\s+(bug|roach|cockroach)/;
const PALMETTO_PEST_RE_G = /\bpalmetto\s+(bug|roach|cockroach)/g;
// Budget reserved for each call in flight, so concurrent workers cannot all
// launch past the cap before any cost comes back. Above the usual live
// advanced SERP + async AI Overview price.
const EST_CALL_COST_USD = 0.006;
const CITY_NAMES = Object.keys(CITY_COORDS);

const arr = (v) => (Array.isArray(v) ? v : []);
// pg turns a JS array into a Postgres array, which a jsonb column rejects.
const json = (v) => (v == null ? null : JSON.stringify(v));
const normQuery = (q) => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();

function cityFromLabel(raw) {
  // Same folding as the app scrapers ("Bradenton, FL", "LWR"), plus GSC's slugs.
  const key = normalizeCity(String(raw || '').replace(/[_-]+/g, ' '));
  if (!key) return null;
  return CITY_NAMES.find((c) => c.toLowerCase() === key) || null;
}

function cityFromQuery(query) {
  // Punctuation counts as a word break ("in Bradenton, Florida"). "Palmetto
  // bug/roach" is the pest, not Palmetto the city (same rule as geoBucket in
  // competitor-gap-miner.js).
  const q = ` ${normQuery(query).replace(/[^a-z0-9]+/g, ' ').replace(PALMETTO_PEST_RE_G, '$1')} `;
  return CITY_NAMES.find((c) => q.includes(` ${c.toLowerCase()} `)) || null;
}

function locationForCity(city) {
  return CITY_COORDS[city] || CITY_COORDS[DEFAULT_CITY];
}

const isWavesQuery = (q) => q.includes('waves');
// Google search operators are not customer searches, and DataForSEO bills them
// at 5x, past the per-call budget reservation.
// A search that looks like it holds a person's contact details is never sent to
// DataForSEO: an email, a run of 7+ digits (phone), or a house number followed by
// a street word. Search Console already hides rare queries; the route's
// impressions floor keeps one-off searches out as well.
const PERSONAL_RE = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /\d(?:[\s().-]*\d){6,}/,
  /\b\d{2,6}\s+(?:[a-z]+\s+){0,3}(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|pl|place|ter|terrace|trl|trail|pkwy|parkway|hwy|highway)\b/i,
];
const looksPersonal = (q) => PERSONAL_RE.some((re) => re.test(q));

const tokensOf = (q) => normQuery(q).split(/[^a-z0-9']+/).filter(Boolean);
/**
 * Customer and lead names, as last name -> set of first names. Built from our
 * own tables; nothing here leaves the database. A search holding both the first
 * and the last name of one person is never sent to DataForSEO.
 */
function buildNameIndex(people) {
  const index = new Map();
  for (const p of arr(people)) {
    const first = tokensOf(p.first_name)[0];
    const last = tokensOf(p.last_name).slice(-1)[0];
    if (!first || !last || first.length < 2 || last.length < 2) continue;
    if (!index.has(last)) index.set(last, new Set());
    index.get(last).add(first);
  }
  return index;
}
function namesAPerson(query, nameIndex) {
  if (!nameIndex || !nameIndex.size) return false;
  const tokens = new Set(tokensOf(query));
  for (const t of tokens) {
    const firsts = nameIndex.get(t);
    if (firsts) for (const f of firsts) if (f !== t && tokens.has(f)) return true;
  }
  return false;
}
const OPERATOR_RE = /(^|[^a-z0-9])-?(site|inurl|allinurl|intitle|allintitle|intext|allintext|filetype|ext|related|cache|link|info|define|before|after|source|map):/i;

// Sums a Search Console row into a candidate; position is impression-weighted.
function addGscNumbers(c, r, impressions) {
  c.impressions_90d = (c.impressions_90d || 0) + impressions;
  c.clicks_90d = (c.clicks_90d || 0) + (Number(r.clicks) || 0);
  const pos = Number(r.position);
  if (Number.isFinite(pos) && pos > 0) {
    c.gsc_position = ((c.gsc_position || 0) * c.posWeight + pos * impressions) / (c.posWeight + impressions);
    c.posWeight += impressions;
  }
}

/**
 * Pure merge of the three candidate sources into one deduped, capped list.
 * gscRows: {query, impressions, clicks, position, city_target, is_branded}
 * gapRows: {query, city}; managedRows: {query}
 * A gap or managed row is always included (it sorts after the GSC rows when
 * it has no impressions); the cap drops the lowest-impression GSC-only rows.
 */
function mergeCandidates({ gscRows = [], gapRows = [], managedRows = [], people = [], minImpressions = DEFAULT_MIN_IMPRESSIONS, max = DEFAULT_MAX_CANDIDATES } = {}) {
  const nameIndex = buildNameIndex(people);
  const byQuery = new Map();
  const touch = (query, source) => {
    const key = normQuery(query);
    if (!key || isWavesQuery(key) || OPERATOR_RE.test(key) || looksPersonal(key) || namesAPerson(key, nameIndex)) return null;
    let c = byQuery.get(key);
    if (!c) {
      c = { query: key, sources: [], cityLabels: [], impressions_90d: null, clicks_90d: null, gsc_position: null, posWeight: 0 };
      byQuery.set(key, c);
    }
    if (!c.sources.includes(source)) c.sources.push(source);
    return c;
  };

  for (const r of arr(gscRows)) {
    const impressions = Number(r.impressions) || 0;
    if (r.is_branded === true || impressions < minImpressions) continue;
    const c = touch(r.query, 'gsc');
    if (!c) continue;
    addGscNumbers(c, r, impressions);
    c.cityLabels.push(r.city_target);
  }
  for (const r of arr(gapRows)) {
    const c = touch(r.query, 'competitor_gap');
    if (c) c.cityLabels.push(r.city);
  }
  for (const r of arr(managedRows)) {
    // The entity cohort ('brand') asks about Waves itself, not a customer search.
    if (r.service === 'brand') continue;
    const c = touch(r.query, 'managed');
    if (c) c.cityLabels.push(r.city);
  }

  const all = [...byQuery.values()].map((c) => {
    // Search Console labels any "palmetto" query as the city; for the pest
    // ("palmetto bug/roach") that label is wrong, so it is ignored.
    const pestPalmetto = PALMETTO_PEST_RE.test(c.query);
    const city = c.cityLabels.map(cityFromLabel).filter((l) => !(pestPalmetto && l === 'Palmetto')).find(Boolean)
      || cityFromQuery(c.query) || null;
    return {
      query: c.query,
      sources: c.sources,
      city,
      location: locationForCity(city),
      impressions_90d: c.impressions_90d,
      clicks_90d: c.clicks_90d,
      gsc_position: c.gsc_position == null ? null : Math.round(c.gsc_position * 100) / 100,
    };
  });
  const byImpressions = (a, b) => (b.impressions_90d || 0) - (a.impressions_90d || 0) || a.query.localeCompare(b.query);
  const mandatory = all.filter((c) => c.sources.some((s) => s !== 'gsc')).sort(byImpressions);
  const optional = all.filter((c) => c.sources.every((s) => s === 'gsc')).sort(byImpressions);
  const keptMandatory = mandatory.slice(0, max);
  const kept = [...keptMandatory, ...optional.slice(0, Math.max(0, max - keptMandatory.length))];
  return kept.sort(byImpressions);
}

async function buildCandidates({ minImpressions = DEFAULT_MIN_IMPRESSIONS, max = DEFAULT_MAX_CANDIDATES } = {}) {
  const since = etDateString(addETDays(new Date(), -GSC_WINDOW_DAYS));
  // Every owned domain's Search Console rows count: a customer's search is the
  // same search whichever Waves site it landed on.
  const gscRows = await db('gsc_queries')
    .where('date', '>=', since)
    .whereRaw("lower(query) not like '%waves%'")
    .select(db.raw('lower(trim(query)) as query'))
    .sum('impressions as impressions')
    .sum('clicks as clicks')
    .select(db.raw('sum(position * impressions) / nullif(sum(impressions), 0) as position'))
    .select(db.raw('max(city_target) as city_target'))
    .select(db.raw('bool_or(coalesce(is_branded, false)) as is_branded'))
    .groupByRaw('lower(trim(query))')
    .havingRaw('sum(impressions) >= ?', [minImpressions])
    .havingRaw('not bool_or(coalesce(is_branded, false))')
    .orderByRaw('sum(impressions) desc');
  // No SQL limit: the cap applies in mergeCandidates after the operator,
  // contact-detail and name screens, so a screened row never takes a slot.

  const gapRows = await db('opportunity_queue')
    .where({ bucket: 'competitor_gap' })
    .whereIn('status', ['pending', 'pending_review'])
    .whereNotNull('query')
    .select('query', 'city');

  const managedRows = await db('seo_llm_mention_queries').where({ active: true }).select('query', 'city', 'service');

  const people = [
    ...await db('customers').whereNotNull('first_name').whereNotNull('last_name').select('first_name', 'last_name'),
    ...await db('leads').whereNotNull('first_name').whereNotNull('last_name').select('first_name', 'last_name'),
  ];

  return mergeCandidates({ gscRows, gapRows, managedRows, people, minImpressions, max });
}

function sourceCounts(candidates) {
  const counts = { gsc: 0, competitor_gap: 0, managed: 0, total: candidates.length };
  for (const c of candidates) for (const s of c.sources) counts[s] = (counts[s] || 0) + 1;
  return counts;
}

async function startSweep({ trigger = 'manual', maxCostUsd = DEFAULT_MAX_COST_USD, minImpressions = DEFAULT_MIN_IMPRESSIONS, max = DEFAULT_MAX_CANDIDATES } = {}) {
  if (trigger !== 'manual' && trigger !== 'monthly') throw new Error(`startSweep: trigger must be 'manual' or 'monthly', got ${trigger}`);
  const refuse = () => Object.assign(new Error('An AI Overview sweep is already open'), { code: 'AIO_SWEEP_OPEN' });
  if (await db('seo_aio_sweep_runs').where({ status: 'open' }).first('id')) throw refuse();

  const candidates = await buildCandidates({ minImpressions, max });
  const counts = sourceCounts(candidates);
  let run;
  try {
    run = await db.transaction(async (trx) => {
      const [created] = await trx('seo_aio_sweep_runs').insert({
        status: 'open',
        trigger,
        started_at: trx.fn.now(),
        planned: candidates.length,
        max_cost_usd: maxCostUsd,
        source_counts: json(counts),
      }).returning('*');
      for (let i = 0; i < candidates.length; i += INSERT_BATCH) {
        await trx('seo_aio_sweep_results').insert(candidates.slice(i, i + INSERT_BATCH).map((c) => ({
          run_id: created.id,
          query: c.query,
          sources: json(c.sources),
          city: c.city,
          location: c.location,
          impressions_90d: c.impressions_90d,
          clicks_90d: c.clicks_90d,
          gsc_position: c.gsc_position,
          status: 'pending',
        })));
      }
      return created;
    });
  } catch (err) {
    // Two starts at once: the partial unique index lets only one win.
    if (err && err.code === '23505') throw refuse();
    throw err;
  }
  logger.info(`[aio-sweep] run ${run.id} (${trigger}) started: ${JSON.stringify(counts)}, max $${maxCostUsd}`);
  return { run, planned: candidates.length, sourceCounts: counts };
}

// ── classification ────────────────────────────────────────────────────

function isMapCardUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'maps.app.goo.gl') return true;
  if (host === 'goo.gl' && u.pathname.startsWith('/maps')) return true;
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return /(^|\/)(maps|searchviewer|goto)(\/|$)/.test(u.pathname);
  return false;
}

function citationKindOf(elements) {
  const urls = arr(elements).flatMap((e) => arr(e.urls)).filter(Boolean);
  if (!urls.length) return null;
  const maps = urls.filter(isMapCardUrl).length;
  if (maps === 0) return 'web';
  return maps === urls.length ? 'map_cards' : 'mixed';
}

async function sweepOne(row) {
  // One attempt: a retry after a dropped connection can be a second billed task.
  const data = await dataforseo.request(SERP_PATH, [{
    keyword: row.query,
    ...dataforseo.serpLocation(row.location || locationForCity(DEFAULT_CITY)),
    language_name: 'English',
    device: 'mobile',
    os: 'iOS',
    load_async_ai_overview: true,
  }], 1);
  if (data == null) return { status: 'request_error', error: 'DataForSEO request failed', aio_shown: null };

  const task = data.tasks?.[0];
  const cost = Number(task?.cost) || 0;
  if (task?.status_code !== 20000) {
    return { status: 'task_error', cost_usd: cost, aio_shown: null, error: `${task?.status_code ?? 'no status'}: ${task?.status_message ?? 'no task'}` };
  }

  const result = task.result?.[0] || {};
  const parsed = parseSerp(result.items);
  const wavesRank = parsed.organicTop.find((o) => o.url && isOwnedUrl(o.url));
  const base = {
    cost_usd: cost,
    check_url: result.check_url || null,
    organic_top: json(parsed.organicTop),
    paa: json(parsed.paa),
    local_pack: json(parsed.localPack),
    waves_organic_rank: wavesRank ? (wavesRank.rank_group ?? wavesRank.rank_absolute ?? null) : null,
  };
  if (!parsed.aio) return { ...base, status: 'none', aio_shown: false, waves_cited: false };
  return {
    ...base,
    status: 'shown',
    aio_shown: true,
    citation_kind: citationKindOf(parsed.elements),
    waves_cited: parsed.wavesCited,
    waves_in_references: arr(parsed.references).some((r) => r.url && isOwnedUrl(r.url)),
    waves_named: WAVES_RE.test(parsed.markdown || ''),
    answer_markdown: parsed.markdown,
    elements: json(parsed.elements),
    aio_references: json(parsed.references),
  };
}

// Closes the run only while it is still open (an admin cancel wins a race).
// Returns the number of runs closed.
/**
 * Rows left 'running' by a crash or deploy: the call may have been billed, so
 * each is settled as request_error and books one call's estimated cost.
 */
async function recoverInterrupted(runId) {
  const stale = await db('seo_aio_sweep_results')
    .where({ run_id: runId, status: 'running' })
    .where('captured_at', '<', db.raw("now() - interval '30 minutes'"))
    .select('id');
  for (const r of stale) {
    await storeResult(runId, r.id, { status: 'request_error', error: 'interrupted after the paid call started', captured_at: db.fn.now() }, EST_CALL_COST_USD);
  }
  return stale.length;
}

async function runStillOpen(runId) {
  return Boolean(await db('seo_aio_sweep_runs').where({ id: runId, status: 'open' }).first());
}

async function storeResult(runId, rowId, patch, cost) {
  await db.transaction(async (trx) => {
    await trx('seo_aio_sweep_results').where({ id: rowId }).update(patch);
    await trx('seo_aio_sweep_runs').where({ id: runId }).update({
      attempted: trx.raw('attempted + 1'),
      cost_usd: trx.raw('cost_usd + ?', [cost]),
    });
  });
}

async function finishRun(runId, status) {
  return db('seo_aio_sweep_runs').where({ id: runId, status: 'open' }).update({ status, finished_at: db.fn.now() });
}

/**
 * One chunk of the open run. Never throws for a row failure: the error is
 * recorded on that row. Returns a summary ({runId: null} with no open run).
 */
async function processSweepChunk({ chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const summary = { runId: null, processed: 0, shown: 0, none: 0, errors: 0, costUsd: 0, status: null };
  const run = await db('seo_aio_sweep_runs').where({ status: 'open' }).first();
  if (!run) return summary;
  summary.runId = run.id;
  summary.status = 'open';

  const maxCost = run.max_cost_usd == null ? Infinity : Number(run.max_cost_usd);
  const recovered = await recoverInterrupted(run.id);
  let runCost = (Number(run.cost_usd) || 0) + recovered * EST_CALL_COST_USD;
  if (runCost + EST_CALL_COST_USD > maxCost) {
    if (await finishRun(run.id, 'stopped_budget')) {
      logger.warn(`[aio-sweep] run ${run.id} stopped: $${runCost} leaves no room for another call under the $${maxCost} cap`);
      summary.status = 'stopped_budget';
    }
    return summary;
  }

  const rows = await db('seo_aio_sweep_results')
    .where({ run_id: run.id, status: 'pending' })
    .orderByRaw('impressions_90d desc nulls last, query asc')
    .limit(chunkSize);

  let next = 0;
  let aborted = false;
  let inFlight = 0;
  const worker = async () => {
    // Reserve this call's estimated cost before taking a row: the run's booked
    // cost plus every call in flight plus this one must stay under the cap.
    while (!aborted && next < rows.length && runCost + (inFlight + 1) * EST_CALL_COST_USD <= maxCost) {
      const row = rows[next];
      next += 1;
      inFlight += 1;
      // A cancel (or a budget stop) mid-chunk must stop new paid calls; the
      // row is claimed first so concurrent workers never share an index.
      if (!(await runStillOpen(run.id))) { inFlight -= 1; break; }
      // Durable claim before the paid call: a crash after DataForSEO accepts
      // the task leaves the row 'running', never 'pending', so it is not paid
      // for twice (recoverInterrupted settles it on a later tick).
      const claimed = await db('seo_aio_sweep_results').where({ id: row.id, status: 'pending' })
        .update({ status: 'running', captured_at: db.fn.now() });
      if (!claimed) { inFlight -= 1; continue; }
      let update;
      try {
        update = await sweepOne(row);
      } catch (err) {
        // Log the row id only: a Search Console query can hold a name or a phone number.
        logger.error(`[aio-sweep] result ${row.id} failed: ${err.message}`);
        update = { status: 'request_error', error: String(err.message || err).slice(0, 500), aio_shown: null };
      }
      const cost = Number(update.cost_usd) || 0;
      runCost += cost;
      inFlight -= 1;
      summary.costUsd += cost;
      summary.processed += 1;
      if (update.status === 'shown') summary.shown += 1;
      else if (update.status === 'none') summary.none += 1;
      else summary.errors += 1;
      // The result and the run's cost move together. If the full write fails,
      // a minimal one still takes the row out of 'pending' and books the cost,
      // so the row is never paid for twice and the cap stays true.
      try {
        await storeResult(run.id, row.id, { ...update, captured_at: db.fn.now() }, cost);
      } catch (err) {
        logger.error(`[aio-sweep] could not store result ${row.id}: ${err.message}`);
        try {
          await storeResult(run.id, row.id, { status: 'request_error', error: 'result could not be stored', captured_at: db.fn.now() }, cost);
        } catch (err2) {
          // The paid call is not booked and the row is still pending: stop the
          // chunk so no more calls run on a ledger that cannot be written.
          aborted = true;
          logger.error(`[aio-sweep] could not mark result ${row.id}, chunk stopped: ${err2.message}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, rows.length) }, worker));

  // A 'running' row (a crash mid-call, settled after 30 minutes) keeps the run open.
  const remaining = await db('seo_aio_sweep_results').where({ run_id: run.id }).whereIn('status', ['pending', 'running']).count({ n: '*' }).first();
  if (!Number(remaining?.n)) {
    if (await finishRun(run.id, 'done')) summary.status = 'done';
  } else if (runCost + EST_CALL_COST_USD > maxCost) {
    if (await finishRun(run.id, 'stopped_budget')) {
      logger.warn(`[aio-sweep] run ${run.id} stopped: $${runCost.toFixed(4)} leaves no room under the $${maxCost} cap; ${remaining.n} rows pending`);
      summary.status = 'stopped_budget';
    }
  }
  logger.info(`[aio-sweep] run ${run.id} chunk: ${JSON.stringify(summary)}`);
  return summary;
}

async function cancelSweep(runId) {
  const [row] = await db('seo_aio_sweep_runs').where({ id: runId, status: 'open' })
    .update({ status: 'cancelled', finished_at: db.fn.now() }).returning('*');
  return row || null;
}

async function listRuns({ limit = 20 } = {}) {
  const runs = await db('seo_aio_sweep_runs').orderBy('created_at', 'desc').limit(limit);
  if (!runs.length) return [];
  const counts = await db('seo_aio_sweep_results')
    .whereIn('run_id', runs.map((r) => r.id))
    .select('run_id', 'status')
    .count({ n: '*' })
    .groupBy('run_id', 'status');
  return runs.map((r) => ({
    ...r,
    counts: Object.fromEntries(counts.filter((c) => c.run_id === r.id).map((c) => [c.status, Number(c.n)])),
  }));
}

const GAP_COLUMNS = ['id', 'query', 'sources', 'city', 'location', 'impressions_90d', 'clicks_90d', 'gsc_position',
  'citation_kind', 'waves_in_references', 'waves_named', 'waves_organic_rank', 'answer_markdown', 'elements', 'aio_references',
  'organic_top', 'check_url', 'captured_at'];

/** Shown overviews that do not cite Waves: web citations first, then impressions. */
async function rankGaps(runId, { limit = 200 } = {}) {
  const run = await db('seo_aio_sweep_runs').where({ id: runId }).first();
  const statusCounts = await db('seo_aio_sweep_results').where({ run_id: runId }).select('status').count({ n: '*' }).groupBy('status');
  const byStatus = Object.fromEntries(statusCounts.map((c) => [c.status, Number(c.n)]));
  const gaps = await db('seo_aio_sweep_results')
    .where({ run_id: runId, status: 'shown', waves_cited: false })
    .select(GAP_COLUMNS)
    .orderByRaw("case citation_kind when 'web' then 0 when 'mixed' then 1 when 'map_cards' then 2 else 3 end, impressions_90d desc nulls last, query asc")
    .limit(limit);
  const shown = byStatus.shown || 0;
  const citedRow = await db('seo_aio_sweep_results').where({ run_id: runId, status: 'shown', waves_cited: true }).count({ n: '*' }).first();
  const cited = Number(citedRow?.n) || 0;
  return {
    run: run || null,
    summary: { byStatus, shown, cited, gaps: Math.max(0, shown - cited), gapsReturned: gaps.length },
    gaps,
  };
}

module.exports = {
  buildCandidates, mergeCandidates, startSweep, processSweepChunk, rankGaps, cancelSweep, listRuns,
  citationKindOf, isMapCardUrl, cityFromQuery, CITY_COORDS, DEFAULT_CITY,
};
