/**
 * AI Overview pinned captures (AI Overview pilot, PR 1).
 *
 * The daily prober (llm-mention-prober.js) records one AI Overview observation
 * per query per day, URLs only. A query an admin pins (pin_daily) is also
 * captured here, twice a day (am / pm), once on desktop and once on mobile,
 * with the full overview text, the cited elements, the references, the organic
 * top 10, People Also Ask and the local pack. Every attempt is stored, failures
 * included, so a gap in the series is visible rather than silent.
 *
 * Dark by default: with no pinned query this makes no DataForSEO call. Cost is
 * bounded by MAX_PINNED_CALLS_PER_PASS.
 */
const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { isOwnedUrl } = require('./aeo-measurement');
const { etDateString } = require('../../utils/datetime-et');

const SERP_PATH = '/serp/google/organic/live/advanced';
const DEFAULT_LOCATION = 'Bradenton,Florida,United States';
const DEVICES = ['desktop', 'mobile'];
const MAX_PINNED_CALLS_PER_PASS = 12;
const ORGANIC_TOP_N = 10;

// DataForSEO's organic SERP takes location_coordinate as "lat,lng,radius" with
// radius 199..199999 (docs example 200); dataforseo.serpLocation's default 20
// is below that, so these calls set the radius themselves. Mobile os is "ios".
const SERP_RADIUS = 200;
const SERP_RADIUS_MIN = 199;
const SERP_RADIUS_MAX = 199999;
function serpPoint(location) {
  const m = String(location || '').trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?$/);
  if (!m) return { location_name: location };
  // A stored radius inside the accepted range is kept; a missing or
  // out-of-range one gets the default.
  const r = Number(m[3]);
  const radius = r >= SERP_RADIUS_MIN && r <= SERP_RADIUS_MAX ? m[3] : SERP_RADIUS;
  return { location_coordinate: `${m[1]},${m[2]},${radius}` };
}
const osFor = (device) => (device === 'desktop' ? 'macos' : 'ios');

const arr = (v) => (Array.isArray(v) ? v : []);
// pg turns a JS array into a Postgres array, which a jsonb column rejects.
const json = (v) => (v == null ? null : JSON.stringify(v));

function parseSerp(items) {
  const list = arr(items);
  // An overview can also arrive inside the knowledge panel, as a
  // knowledge_graph_ai_overview_item with the same element children.
  const aio = list.find((i) => i?.type === 'ai_overview')
    || list.filter((i) => i?.type === 'knowledge_graph').flatMap((i) => arr(i.items)).find((i) => i?.type === 'knowledge_graph_ai_overview_item')
    || list.find((i) => i?.type === 'knowledge_graph_ai_overview_item')
    || null;

  const organicTop = list
    .filter((i) => i?.type === 'organic')
    .slice(0, ORGANIC_TOP_N)
    .map((i) => ({ rank_absolute: i.rank_absolute ?? null, rank_group: i.rank_group ?? null, url: i.url || null, domain: i.domain || null, title: i.title || null }));

  const paa = list
    .filter((i) => i?.type === 'people_also_ask')
    .flatMap((i) => arr(i.items))
    .map((q) => q?.title)
    .filter(Boolean);

  // A local_pack item is a wrapper; its businesses are in .items (see
  // extractLocalPack in serp-profiler.js).
  const localPack = list
    .filter((i) => i?.type === 'local_pack')
    .flatMap((i) => arr(i.items))
    .map((b) => ({ title: b?.title || null, domain: b?.domain || null, rating: b?.rating?.value ?? null, review_count: b?.rating?.votes_count ?? null, rank_group: b?.rank_group ?? null }));

  if (!aio) return { aio: null, organicTop, paa, localPack };

  // Every answer part can carry citations: plain, table, video and expanded
  // elements, and the components nested in an expanded element.
  const parts = [];
  const walk = (list) => {
    for (const e of arr(list)) {
      if (/^ai_overview_\w*(element|component)$/.test(e?.type || '')) parts.push(e);
      walk(e?.items);
      walk(e?.components);
    }
  };
  walk(aio.items);
  const elements = parts
    .map((e) => ({
      title: e.title || null,
      text: e.text || e.markdown || '',
      // Sources can also be images; a video element cites its video in its own url field.
      urls: [...arr(e.references), ...arr(e.links), ...arr(e.images), ...(e.type === 'ai_overview_video_element' ? [e] : [])].map((r) => r?.url).filter(Boolean),
    }))
    .filter((e) => e.text || e.urls.length);
  const references = arr(aio.references).map((r) => ({
    url: r?.url || null, title: r?.title || null, domain: r?.domain || null, text: r?.text || r?.snippet || null,
  }));
  // Without a top-level markdown, the answer is every part's text, nested
  // components included.
  const markdown = aio.markdown || parts.map((e) => e?.text || e?.markdown || '').filter(Boolean).join('\n');
  // Only URLs attached to an answer element prove a citation; top-level
  // references are pages Google MAY have used (same contract as
  // googleAnswerProbe in llm-mention-prober.js).
  const wavesCited = elements.flatMap((e) => e.urls).some((u) => u && isOwnedUrl(u));

  return { aio, organicTop, paa, localPack, elements, references, markdown, wavesCited };
}

async function captureOne(queryRow, device, pass) {
  const location = queryRow.pin_location || DEFAULT_LOCATION;
  const base = { query_id: queryRow.id, query: queryRow.query, pass, device, location };
  const data = await dataforseo.request(SERP_PATH, [{
    keyword: queryRow.query,
    ...serpPoint(location),
    language_name: 'English',
    device,
    os: osFor(device),
    load_async_ai_overview: true,
  }]);

  if (data == null) return { ...base, status: 'request_error' };

  const task = data.tasks?.[0];
  const cost = Number(task?.cost) || 0;
  if (task?.status_code !== 20000) {
    logger.warn(`[aio-capture] task error ${task?.status_code} (${task?.status_message}) for "${queryRow.query}" ${device}`);
    return { ...base, status: 'task_error', cost_usd: cost, raw_item: json({ status_code: task?.status_code ?? null, status_message: task?.status_message ?? null }) };
  }

  const result = task.result?.[0] || {};
  const parsed = parseSerp(result.items);
  const row = {
    ...base,
    check_url: result.check_url || null,
    se_datetime: result.datetime || null,
    cost_usd: cost,
    organic_top: json(parsed.organicTop),
    paa: json(parsed.paa),
    local_pack: json(parsed.localPack),
  };
  if (!parsed.aio) return { ...row, status: 'none', waves_cited: false };
  return {
    ...row,
    status: 'shown',
    answer_markdown: parsed.markdown,
    elements: json(parsed.elements),
    aio_references: json(parsed.references),
    raw_item: json(parsed.aio),
    waves_cited: parsed.wavesCited,
  };
}

async function runPinnedCaptures({ pass = 'am' } = {}) {
  const summary = { pinned: 0, attempted: 0, shown: 0, none: 0, errors: 0, costUsd: 0 };
  if (pass !== 'am' && pass !== 'pm') throw new Error(`runPinnedCaptures: pass must be 'am' or 'pm', got ${pass}`);

  const today = etDateString();
  const queries = await db('seo_llm_mention_queries')
    .where({ active: true, pin_daily: true })
    .where(function activePin() { this.whereNull('pin_until').orWhere('pin_until', '>=', today); })
    .orderBy('created_at', 'asc');
  summary.pinned = queries.length;
  if (!queries.length) return summary;

  // When more pins exist than one pass can take, rotate the starting pin by
  // pass number so every pin is captured over time instead of the oldest
  // pins taking every pass.
  const perPass = Math.floor(MAX_PINNED_CALLS_PER_PASS / DEVICES.length);
  let ordered = queries;
  if (queries.length > perPass) {
    const passNumber = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400000) * 2 + (pass === 'pm' ? 1 : 0);
    const start = (passNumber * perPass) % queries.length;
    ordered = [...queries.slice(start), ...queries.slice(0, start)];
  }

  outer:
  for (const queryRow of ordered) {
    for (const device of DEVICES) {
      if (summary.attempted >= MAX_PINNED_CALLS_PER_PASS) {
        logger.warn(`[aio-capture] hit the ${MAX_PINNED_CALLS_PER_PASS}-call cap on the ${pass} pass; remaining pinned queries skipped`);
        break outer;
      }
      summary.attempted += 1;
      try {
        const row = await captureOne(queryRow, device, pass);
        await db('seo_aio_captures').insert(row);
        summary.costUsd += Number(row.cost_usd) || 0;
        if (row.status === 'shown') summary.shown += 1;
        else if (row.status === 'none') summary.none += 1;
        else summary.errors += 1;
      } catch (err) {
        summary.errors += 1;
        logger.error(`[aio-capture] "${queryRow.query}" ${device} failed: ${err.message}`);
      }
    }
  }
  logger.info(`[aio-capture] ${pass} pass: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { runPinnedCaptures, parseSerp, serpPoint, osFor, MAX_PINNED_CALLS_PER_PASS, DEFAULT_LOCATION };
