// AI Overview gap sweep: candidate merge, run lifecycle, one mobile call per row,
// every outcome stored, budget stop, gap ranking. Synthetic data only.
const mockState = { runs: [], results: [], gsc: [], gap: [], managed: [], queries: [], ids: 0, insertError: null, failResultUpdates: 0 };

function mockMatches(row, wheres) {
  return wheres.every((w) => Object.entries(w).every(([k, v]) => row[k] === v));
}

function mockApplyUpdate(row, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.raw === 'attempted + 1') row[k] = (row[k] || 0) + 1;
    else if (v && v.raw === 'cost_usd + ?') row[k] = Number(row[k] || 0) + Number(v.bindings[0]);
    else row[k] = v === 'NOW' ? new Date(0) : v;
  }
}

function mockExec(q) {
  mockState.queries.push(q);
  if (q.table === 'gsc_queries') return mockState.gsc;
  if (q.table === 'opportunity_queue') return mockState.gap;
  if (q.table === 'seo_llm_mention_queries') return mockState.managed;
  const rows = q.table === 'seo_aio_sweep_runs' ? mockState.runs : mockState.results;
  if (q.insert) {
    if (mockState.insertError) throw mockState.insertError;
    const list = Array.isArray(q.insert) ? q.insert : [q.insert];
    const made = list.map((r) => {
      const base = q.table === 'seo_aio_sweep_runs'
        ? { id: `run-${(mockState.ids += 1)}`, attempted: 0, cost_usd: 0 }
        : { id: `res-${(mockState.ids += 1)}`, status: 'pending' };
      const row = { ...base, ...r };
      rows.push(row);
      return row;
    });
    return q.returning ? made : made.length;
  }
  let hit = rows.filter((r) => mockMatches(r, q.wheres) && q.whereIns.every(([c, vals]) => vals.includes(r[c]))
    && (!q.staleOnly || !(r.captured_at instanceof Date) || r.captured_at < new Date(Date.now() - 30 * 60 * 1000)));
  if (q.update) {
    if (q.table === 'seo_aio_sweep_results' && q.update.status !== 'running' && mockState.failResultUpdates > 0) {
      mockState.failResultUpdates -= 1;
      throw new Error('write failed');
    }
    hit.forEach((r) => mockApplyUpdate(r, q.update));
    return q.returning ? hit : hit.length;
  }
  if (q.count) {
    if (q.groupBy.length) {
      const groups = new Map();
      for (const r of hit) {
        const key = q.groupBy.map((c) => r[c]).join('|');
        const g = groups.get(key) || { ...Object.fromEntries(q.groupBy.map((c) => [c, r[c]])), n: 0 };
        g.n += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    }
    return q.first ? { n: hit.length } : [{ n: hit.length }];
  }
  if (q.orderRaw && q.orderRaw.startsWith('impressions_90d desc')) hit = [...hit].sort((a, b) => (b.impressions_90d || 0) - (a.impressions_90d || 0));
  if (q.limit) hit = hit.slice(0, q.limit);
  return q.first ? hit[0] : hit;
}

jest.mock('../models/db', () => {
  const make = (table) => {
    const q = { table, wheres: [], whereIns: [], groupBy: [], limit: null, first: false, count: false, update: null, insert: null, returning: false, orderRaw: null, rawWheres: [] };
    const b = {
      where: (...a) => {
        if (typeof a[0] === 'object') q.wheres.push(a[0]);
        // recoverInterrupted: captured_at < now() - 30 minutes; a row with no date counts as stale.
        else if (a[0] === 'captured_at' && a[1] === '<') q.staleOnly = true;
        return b;
      },
      whereIn: (c, v) => { q.whereIns.push([c, v]); return b; },
      whereNotNull: () => b,
      whereRaw: (s) => { q.rawWheres.push(s); return b; },
      select: () => b,
      sum: () => b,
      havingRaw: () => b,
      groupByRaw: () => b,
      groupBy: (...c) => { q.groupBy = c; return b; },
      orderBy: () => b,
      orderByRaw: (s) => { q.orderRaw = s; return b; },
      limit: (n) => { q.limit = n; return b; },
      first: () => { q.first = true; return b; },
      count: () => { q.count = true; return b; },
      update: (p) => { q.update = p; return b; },
      insert: (r) => { q.insert = r; return b; },
      returning: () => { q.returning = true; return b; },
      then: (resolve, reject) => { try { resolve(mockExec(q)); } catch (e) { reject(e); } },
    };
    return b;
  };
  const db = jest.fn(make);
  db.raw = (sql, bindings) => ({ raw: sql, bindings });
  db.fn = { now: () => 'NOW' };
  db.transaction = async (fn) => fn(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({
  request: jest.fn(),
  serpLocation: jest.requireActual('../services/seo/dataforseo').serpLocation,
}));

const dataforseo = require('../services/seo/dataforseo');
const sweep = require('../services/seo/aio-gap-sweep');

const wavesUrl = 'https://www.wavespestcontrol.com/pest-control-bradenton-fl/';
const element = (urls, text = 'Use a licensed pest control company.') => ({ type: 'ai_overview_element', text, references: urls.map((url) => ({ url })) });
const aioItem = (elements, refs = [], markdown = 'Overview text about ants.') => ({ type: 'ai_overview', markdown, items: elements, references: refs.map((url) => ({ url, title: 't', domain: 'd' })) });
const organic = (urls) => urls.map((url, i) => ({ type: 'organic', rank_absolute: i + 1, rank_group: i + 1, url, domain: 'x', title: `R${i}` }));
const serp = (items, over = {}) => ({ tasks: [{ status_code: 20000, cost: 0.004, result: [{ check_url: 'https://google.example/search?q=x', items }], ...over }] });

const openRun = (over = {}) => {
  const run = { id: 'run-open', status: 'open', trigger: 'manual', planned: 0, attempted: 0, cost_usd: 0, max_cost_usd: 10, ...over };
  mockState.runs.push(run);
  return run;
};
const pendingRow = (query, over = {}) => {
  const row = { id: `row-${query}`, run_id: 'run-open', query, status: 'pending', location: '27.4186,-82.4186', impressions_90d: 100, ...over };
  mockState.results.push(row);
  return row;
};
const rowOf = (query) => mockState.results.find((r) => r.query === query);

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { runs: [], results: [], gsc: [], gap: [], managed: [], queries: [], ids: 0, insertError: null, failResultUpdates: 0 });
});

describe('mergeCandidates', () => {
  const gsc = (query, impressions, over = {}) => ({ query, impressions, clicks: 1, position: 8, city_target: null, is_branded: false, ...over });

  test('dedupes on normalized text, merges sources, sums impressions, weights position', () => {
    const out = sweep.mergeCandidates({
      gscRows: [gsc('Ant Control  Exampleville', 100, { position: 10 }), gsc('ant control exampleville', 300, { position: 6 })],
      gapRows: [{ query: ' ANT control exampleville ', city: null }],
      managedRows: [{ query: 'ant control exampleville' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ query: 'ant control exampleville', sources: ['gsc', 'competitor_gap', 'managed'], impressions_90d: 400, clicks_90d: 2, gsc_position: 7 });
  });

  test('drops branded rows, queries containing waves, and GSC rows under the floor', () => {
    const out = sweep.mergeCandidates({
      gscRows: [gsc('exampleville ants', 50), gsc('acme brand', 500, { is_branded: true }), gsc('waves pest reviews', 500), gsc('rare query', 5)],
      gapRows: [{ query: 'Waves of Exampleville', city: null }],
      minImpressions: 20,
    });
    expect(out.map((c) => c.query)).toEqual(['exampleville ants']);
  });

  test('city comes from city_target, then the opportunity city, then the query text, else null with the default coordinate', () => {
    const out = sweep.mergeCandidates({
      gscRows: [gsc('a one', 90, { city_target: 'north_port' }), gsc('a two in sarasota', 80), gsc('a three', 70, { city_target: 'local_intent' })],
      gapRows: [{ query: 'a four', city: 'Venice' }, { query: 'a five near punta gorda', city: null }],
    });
    const by = Object.fromEntries(out.map((c) => [c.query, c]));
    expect(by['a one']).toMatchObject({ city: 'North Port', location: sweep.CITY_COORDS['North Port'] });
    expect(by['a two in sarasota']).toMatchObject({ city: 'Sarasota', location: sweep.CITY_COORDS.Sarasota });
    expect(by['a three']).toMatchObject({ city: null, location: sweep.CITY_COORDS[sweep.DEFAULT_CITY] });
    expect(by['a four']).toMatchObject({ city: 'Venice' });
    expect(by['a five near punta gorda']).toMatchObject({ city: 'Punta Gorda' });
  });

  test('orders by impressions; gap and managed rows with none come last but are always kept under the cap', () => {
    const out = sweep.mergeCandidates({
      gscRows: [gsc('low', 25), gsc('high', 900), gsc('mid', 400)],
      gapRows: [{ query: 'gap only', city: null }],
      managedRows: [{ query: 'managed only' }],
      max: 3,
    });
    // cap 3: the two mandatory rows stay, one GSC row (the highest) fills the rest.
    expect(out.map((c) => c.query)).toEqual(['high', 'gap only', 'managed only']);
  });

  test('a search holding a customer or lead first and last name is never a candidate', () => {
    const out = sweep.mergeCandidates({
      gscRows: [
        { query: 'jordan exampleton pest control', impressions: 90 },
        { query: 'exampleton termite treatment', impressions: 80 },
        { query: 'brown patch lawn fungus', impressions: 70 },
      ],
      people: [{ first_name: 'Jordan', last_name: 'Exampleton' }, { first_name: 'Casey', last_name: 'Brown' }],
    });
    expect(out.map((c) => c.query)).toEqual(['exampleton termite treatment', 'brown patch lawn fungus']);
  });

  test('managed city values in typed formats map to their city', () => {
    const out = sweep.mergeCandidates({ managedRows: [{ query: 'who sprays near me', city: 'LWR' }, { query: 'ant help', city: 'Bradenton, FL' }] });
    expect(Object.fromEntries(out.map((c) => [c.query, c.city]))).toEqual({ 'who sprays near me': 'Lakewood Ranch', 'ant help': 'Bradenton' });
  });

  test('a Search Console Palmetto label is ignored for the palmetto bug', () => {
    const out = sweep.mergeCandidates({ gscRows: [{ query: 'palmetto bugs vs cockroaches', impressions: 90, city_target: 'palmetto' }] });
    expect(out[0].city).toBeNull();
  });

  test('the cap counts only rows that pass the screens', () => {
    const out = sweep.mergeCandidates({ max: 1, gscRows: [{ query: 'site:rival.example pests', impressions: 90 }, { query: 'ant control', impressions: 80 }] });
    expect(out.map((c) => c.query)).toEqual(['ant control']);
  });

  test('searches that look like contact details are never candidates', () => {
    const out = sweep.mergeCandidates({ gscRows: [
      { query: 'pest control call 941 555 0100', impressions: 90 },
      { query: 'someone@example.test termite', impressions: 90 },
      { query: '1234 example oak st ants', impressions: 90 },
      { query: 'ant control 2 visits a year', impressions: 90 },
    ] });
    expect(out.map((c) => c.query)).toEqual(['ant control 2 visits a year']);
  });

  test('an operator after punctuation is still an operator', () => {
    const out = sweep.mergeCandidates({ gscRows: [{ query: '(site:rival.example) pest control', impressions: 90 }, { query: 'pest control', impressions: 80 }] });
    expect(out.map((c) => c.query)).toEqual(['pest control']);
  });

  test('searches with a Google operator (5x DataForSEO price) are left out', () => {
    const out = sweep.mergeCandidates({ gscRows: [
      { query: 'site:example.test pest control', impressions: 90 },
      { query: 'termite inurl:bait', impressions: 80 },
      { query: 'inanchor:pest control', impressions: 75 },
      { query: 'id:12345', impressions: 74 },
      { query: 'termite bait stations', impressions: 70 },
    ] });
    expect(out.map((c) => c.query)).toEqual(['termite bait stations']);
  });

  test('"palmetto bugs" is the pest, not the city of Palmetto', () => {
    const out = sweep.mergeCandidates({ gapRows: [{ query: 'palmetto bugs vs cockroaches' }, { query: 'pest control palmetto fl' }] });
    expect(out.find((c) => c.query.startsWith('palmetto bugs')).city).toBeNull();
    expect(out.find((c) => c.query.startsWith('pest control')).city).toBe('Palmetto');
  });

  test('managed brand rows (the entity cohort) are left out', () => {
    const out = sweep.mergeCandidates({ managedRows: [{ query: 'owner name pest control exampleville', service: 'brand' }, { query: 'ant control exampleville', service: 'pest control' }] });
    expect(out.map((c) => c.query)).toEqual(['ant control exampleville']);
  });

  test('a city followed by punctuation is found, and a managed row keeps its stored city', () => {
    const out = sweep.mergeCandidates({
      gscRows: [{ query: 'best pest control company in Bradenton, Florida', impressions: 50 }],
      managedRows: [{ query: 'who sprays near the ranch?', city: 'Parrish' }],
    });
    expect(out.find((c) => c.query.startsWith('best')).city).toBe('Bradenton');
    expect(out.find((c) => c.query.startsWith('who')).city).toBe('Parrish');
  });

  test('cap drops the lowest-impression GSC rows first', () => {
    const rows = Array.from({ length: 10 }, (_, i) => gsc(`q${i}`, 100 + i));
    const out = sweep.mergeCandidates({ gscRows: rows, max: 4 });
    expect(out.map((c) => c.query)).toEqual(['q9', 'q8', 'q7', 'q6']);
  });
});

test('buildCandidates reads the three sources and merges them', async () => {
  mockState.gsc = [{ query: 'ants in exampleville', impressions: '60', clicks: '2', position: '9.5', city_target: null, is_branded: false }];
  mockState.gap = [{ query: 'roach control', city: 'Bradenton' }];
  mockState.managed = [{ query: 'who is the best pest company' }];
  const out = await sweep.buildCandidates({});
  expect(out.map((c) => [c.query, c.sources])).toEqual([
    ['ants in exampleville', ['gsc']],
    ['roach control', ['competitor_gap']],
    ['who is the best pest company', ['managed']],
  ]);
  const gapQuery = mockState.queries.find((q) => q.table === 'opportunity_queue');
  expect(gapQuery.wheres).toContainEqual({ bucket: 'competitor_gap' });
  expect(gapQuery.whereIns).toContainEqual(['status', ['pending', 'pending_review']]);
  expect(mockState.queries.find((q) => q.table === 'seo_llm_mention_queries').wheres).toContainEqual({ active: true });
});

describe('startSweep', () => {
  test('inserts the run and every candidate as a pending row', async () => {
    mockState.gsc = [{ query: 'ants in exampleville', impressions: 60, clicks: 1, position: 9, city_target: null, is_branded: false }];
    mockState.managed = [{ query: 'managed question' }];
    const out = await sweep.startSweep({ trigger: 'monthly', maxCostUsd: 5 });
    expect(out.planned).toBe(2);
    expect(mockState.runs).toHaveLength(1);
    expect(mockState.runs[0]).toMatchObject({ status: 'open', trigger: 'monthly', planned: 2, max_cost_usd: 5 });
    expect(JSON.parse(mockState.runs[0].source_counts)).toMatchObject({ gsc: 1, managed: 1, total: 2 });
    expect(mockState.results.map((r) => [r.query, r.status, r.run_id])).toEqual([
      ['ants in exampleville', 'pending', mockState.runs[0].id],
      ['managed question', 'pending', mockState.runs[0].id],
    ]);
    expect(JSON.parse(mockState.results[0].sources)).toEqual(['gsc']);
  });

  test('refuses a second open run and inserts nothing', async () => {
    openRun();
    await expect(sweep.startSweep({})).rejects.toMatchObject({ code: 'AIO_SWEEP_OPEN' });
    expect(mockState.runs).toHaveLength(1);
    expect(mockState.results).toHaveLength(0);
  });

  test('a lost race on the one-open-run index also reads as already open', async () => {
    mockState.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(sweep.startSweep({})).rejects.toMatchObject({ code: 'AIO_SWEEP_OPEN' });
  });
});

describe('processSweepChunk', () => {
  test('no open run: no call', async () => {
    const out = await sweep.processSweepChunk();
    expect(out.runId).toBeNull();
    expect(dataforseo.request).not.toHaveBeenCalled();
  });

  test('a failed request books one call estimate, so failures cannot run past the cap', async () => {
    openRun({ max_cost_usd: 0.02 });
    for (let i = 0; i < 10; i += 1) pendingRow(`q${i}`, { impressions_90d: 100 - i });
    dataforseo.request.mockResolvedValue(null);
    await sweep.processSweepChunk({ chunkSize: 10 });
    expect(dataforseo.request.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mockState.runs[0].cost_usd).toBeLessThanOrEqual(0.02);
  });

  test('a run with nothing left finishes as done even when its cost leaves no room', async () => {
    openRun({ cost_usd: 10, max_cost_usd: 10 });
    mockState.results.push({ id: 'r1', run_id: 'run-open', query: 'q', status: 'none' });
    const out = await sweep.processSweepChunk();
    expect(out.status).toBe('done');
    expect(mockState.runs[0].status).toBe('done');
  });

  test('storing a result twice moves the row and the ledger only once', async () => {
    openRun();
    mockState.results.push({ id: 'r1', run_id: 'run-open', query: 'q', status: 'running' });
    await sweep._storeResult('run-open', 'r1', { status: 'shown' }, 0.004);
    await sweep._storeResult('run-open', 'r1', { status: 'request_error' }, 0.004);
    expect(mockState.results[0].status).toBe('shown');
    expect(mockState.runs[0]).toMatchObject({ attempted: 1, cost_usd: 0.004 });
  });

  test('the claim requires the run to still be open in the same statement', async () => {
    openRun();
    pendingRow('q');
    dataforseo.request.mockResolvedValue(serp([]));
    await sweep.processSweepChunk();
    const claim = mockState.queries.find((x) => x.table === 'seo_aio_sweep_results' && x.update && x.update.status === 'running');
    expect(claim.rawWheres.join(' ')).toMatch(/exists \(select 1 from seo_aio_sweep_runs r where r\.id = \? and r\.status = 'open'\)/);
  });

  test('a fresh running row pauses the chunk: no new paid call', async () => {
    openRun();
    mockState.results.push({ id: 'r1', run_id: 'run-open', query: 'busy', status: 'running', captured_at: new Date() });
    pendingRow('next');
    await sweep.processSweepChunk();
    expect(dataforseo.request).not.toHaveBeenCalled();
  });

  test('cancelling settles running rows and books their estimate', async () => {
    openRun();
    mockState.results.push({ id: 'r1', run_id: 'run-open', query: 'busy', status: 'running' });
    const out = await sweep.cancelSweep('run-open');
    expect(out.status).toBe('cancelled');
    expect(mockState.results[0]).toMatchObject({ status: 'request_error' });
    expect(mockState.runs[0]).toMatchObject({ attempted: 1, cost_usd: 0.006 });
  });

  test('a row is claimed as running before its paid call', async () => {
    openRun();
    pendingRow('q');
    let statusDuringCall = null;
    dataforseo.request.mockImplementation(async () => { statusDuringCall = rowOf('q').status; return serp([]); });
    await sweep.processSweepChunk();
    expect(statusDuringCall).toBe('running');
    expect(rowOf('q').status).toBe('none');
  });

  test('each sweep call is a single attempt (a retry can be a second billed task)', async () => {
    openRun();
    pendingRow('q');
    dataforseo.request.mockResolvedValue(serp([]));
    await sweep.processSweepChunk();
    expect(dataforseo.request.mock.calls[0][2]).toBe(1);
  });

  test('one mobile call per row with the row location; every status is stored; run closes as done', async () => {
    openRun();
    pendingRow('shown query', { location: '27.0442,-82.2359' });
    pendingRow('none query');
    pendingRow('task error query');
    pendingRow('request error query');
    pendingRow('thrown query');
    dataforseo.request.mockImplementation(async (_path, body) => {
      const kw = body[0].keyword;
      if (kw === 'shown query') return serp([aioItem([element(['https://rival.example/ants'])]), ...organic(['https://rival.example/'])]);
      if (kw === 'none query') return serp(organic(['https://rival.example/']));
      if (kw === 'task error query') return { tasks: [{ status_code: 40501, status_message: 'Invalid Field', cost: 0.002 }] };
      if (kw === 'request error query') return null;
      throw new Error('socket hang up');
    });

    const out = await sweep.processSweepChunk({ chunkSize: 10 });

    expect(dataforseo.request).toHaveBeenCalledTimes(5);
    const shownBody = dataforseo.request.mock.calls.find((c) => c[1][0].keyword === 'shown query')[1][0];
    expect(shownBody).toMatchObject({ device: 'mobile', os: 'ios', language_name: 'English', load_async_ai_overview: true, location_coordinate: '27.0442,-82.2359,200' });
    expect(dataforseo.request.mock.calls[0][0]).toBe('/serp/google/organic/live/advanced');

    expect(rowOf('shown query')).toMatchObject({ status: 'shown', aio_shown: true, waves_cited: false, citation_kind: 'web' });
    expect(rowOf('none query')).toMatchObject({ status: 'none', aio_shown: false, waves_cited: false });
    expect(rowOf('task error query')).toMatchObject({ status: 'task_error', cost_usd: 0.002 });
    expect(rowOf('task error query').error).toMatch(/40501/);
    expect(rowOf('request error query')).toMatchObject({ status: 'request_error' });
    expect(rowOf('thrown query')).toMatchObject({ status: 'request_error', error: 'socket hang up' });
    for (const r of mockState.results) expect(r.captured_at).toBeDefined();

    expect(out).toMatchObject({ processed: 5, shown: 1, none: 1, errors: 3, status: 'done' });
    expect(mockState.runs[0]).toMatchObject({ status: 'done', attempted: 5 });
    expect(mockState.runs[0].cost_usd).toBeCloseTo(0.004 + 0.004 + 0.002 + 0.006, 6); // the null request books one estimate
    expect(mockState.runs[0].finished_at).toBeDefined();
  });

  test('takes at most chunkSize rows, highest impressions first, and leaves the run open', async () => {
    openRun();
    pendingRow('small', { impressions_90d: 10 });
    pendingRow('big', { impressions_90d: 900 });
    pendingRow('medium', { impressions_90d: 200 });
    dataforseo.request.mockResolvedValue(serp([]));
    const out = await sweep.processSweepChunk({ chunkSize: 2 });
    expect(out).toMatchObject({ processed: 2, status: 'open' });
    expect(rowOf('big').status).toBe('none');
    expect(rowOf('medium').status).toBe('none');
    expect(rowOf('small').status).toBe('pending');
    expect(mockState.runs[0].status).toBe('open');
  });

  test('citation_kind: web, map_cards and mixed', async () => {
    openRun();
    for (const q of ['web', 'maps', 'mixed', 'bare']) pendingRow(q);
    const mapUrl = 'https://www.google.com/maps/place/Example+Co';
    const items = {
      web: [aioItem([element(['https://rival.example/a', 'https://other.example/b'])])],
      maps: [aioItem([element([mapUrl, 'https://maps.app.goo.gl/abc', 'https://www.google.com/search/searchviewer?x=1', 'https://www.google.com/goto?url=1'])])],
      mixed: [aioItem([element([mapUrl]), element(['https://rival.example/a'])])],
      bare: [aioItem([{ type: 'ai_overview_element', text: 'No links here' }])],
    };
    dataforseo.request.mockImplementation(async (_p, body) => serp(items[body[0].keyword]));
    await sweep.processSweepChunk({ chunkSize: 10 });
    expect(rowOf('web').citation_kind).toBe('web');
    expect(rowOf('maps').citation_kind).toBe('map_cards');
    expect(rowOf('mixed').citation_kind).toBe('mixed');
    expect(rowOf('bare').citation_kind).toBeNull();
  });

  test('waves_cited counts element URLs only; a Waves URL in the references is waves_in_references; naming and organic rank', async () => {
    openRun();
    for (const q of ['element cite', 'reference only', 'named only', 'sound waves']) pendingRow(q);
    dataforseo.request.mockImplementation(async (_p, body) => {
      const kw = body[0].keyword;
      if (kw === 'element cite') return serp([aioItem([element([wavesUrl])], [wavesUrl], 'Waves Pest Control is a local option.'), ...organic(['https://rival.example/', wavesUrl])]);
      if (kw === 'reference only') return serp([aioItem([element(['https://rival.example/a'])], [wavesUrl], 'Ants are common.'), ...organic(['https://rival.example/'])]);
      if (kw === 'sound waves') return serp([aioItem([element(['https://rival.example/a'])], [], 'Ultrasonic sound waves may repel rodents.')]);
      return serp([aioItem([element(['https://rival.example/a'])], [], 'Locals like Waves Pest Control for ants.')]);
    });
    await sweep.processSweepChunk({ chunkSize: 10 });
    expect(rowOf('element cite')).toMatchObject({ waves_cited: true, waves_in_references: true, waves_named: true, waves_organic_rank: 2 });
    expect(rowOf('reference only')).toMatchObject({ waves_cited: false, waves_in_references: true, waves_named: false, waves_organic_rank: null });
    expect(rowOf('named only')).toMatchObject({ waves_cited: false, waves_in_references: false, waves_named: true });
    expect(rowOf('sound waves')).toMatchObject({ waves_named: false });
  });

  test('stores jsonb columns as JSON strings, not arrays', async () => {
    openRun();
    pendingRow('q');
    dataforseo.request.mockResolvedValue(serp([aioItem([element(['https://rival.example/a'])], ['https://rival.example/a']), ...organic(['https://rival.example/'])]));
    await sweep.processSweepChunk();
    for (const col of ['elements', 'aio_references', 'organic_top', 'paa', 'local_pack']) expect(typeof rowOf('q')[col]).toBe('string');
  });

  test('a run already at its cost cap stops as stopped_budget and makes no call', async () => {
    openRun({ cost_usd: 10, max_cost_usd: 10 });
    pendingRow('q');
    const out = await sweep.processSweepChunk();
    expect(dataforseo.request).not.toHaveBeenCalled();
    expect(out.status).toBe('stopped_budget');
    expect(mockState.runs[0].status).toBe('stopped_budget');
    expect(rowOf('q').status).toBe('pending');
  });

  test('the cap is checked while the chunk runs: it stops taking rows once the cost reaches it', async () => {
    openRun({ max_cost_usd: 0.01 });
    for (let i = 0; i < 12; i += 1) pendingRow(`q${i}`, { impressions_90d: 100 - i });
    dataforseo.request.mockResolvedValue(serp([], { cost: 0.006 }));
    const out = await sweep.processSweepChunk({ chunkSize: 12 });
    expect(out.processed).toBeLessThan(12);
    // Concurrent workers reserve a call's cost before launching, so the booked cost stays under the cap.
    expect(mockState.runs[0].cost_usd).toBeLessThanOrEqual(0.01);
    expect(out.status).toBe('stopped_budget');
    expect(mockState.runs[0].status).toBe('stopped_budget');
    expect(mockState.results.filter((r) => r.status === 'pending').length).toBeGreaterThan(0);
  });

  test('a run cancelled during the chunk stays cancelled', async () => {
    const run = openRun();
    pendingRow('q');
    dataforseo.request.mockImplementation(async () => { run.status = 'cancelled'; return serp([]); });
    const out = await sweep.processSweepChunk();
    expect(run.status).toBe('cancelled');
    expect(out.status).toBe('open');
  });

  test('a cancel mid-chunk stops new paid calls; only the call in flight finishes', async () => {
    const run = openRun();
    for (let i = 0; i < 10; i += 1) pendingRow(`q${i}`, { impressions_90d: 100 - i });
    dataforseo.request.mockImplementation(async () => { run.status = 'cancelled'; return serp([]); });
    await sweep.processSweepChunk({ chunkSize: 10 });
    expect(dataforseo.request.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mockState.results.filter((r) => r.status === 'pending').length).toBeGreaterThanOrEqual(6);
  });

  test('a failed result write still takes the row out of pending and books its cost', async () => {
    openRun();
    pendingRow('q');
    mockState.failResultUpdates = 1;
    dataforseo.request.mockResolvedValue(serp([]));
    await sweep.processSweepChunk();
    expect(rowOf('q')).toMatchObject({ status: 'request_error', error: 'result could not be stored', cost_usd: 0.004 });
    expect(mockState.runs[0]).toMatchObject({ attempted: 1, cost_usd: 0.004 });
  });

  test('when the fallback write also fails, the chunk stops making calls', async () => {
    openRun();
    for (let i = 0; i < 10; i += 1) pendingRow(`q${i}`, { impressions_90d: 100 - i });
    mockState.failResultUpdates = 1000;
    dataforseo.request.mockResolvedValue(serp([]));
    await sweep.processSweepChunk({ chunkSize: 10 });
    expect(dataforseo.request.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mockState.runs[0].status).toBe('open');
  });

  test('an aborted chunk near the cap leaves the run open for recovery', async () => {
    openRun({ max_cost_usd: 1.01 });
    for (let i = 0; i < 3; i += 1) pendingRow(`q${i}`, { impressions_90d: 100 - i });
    mockState.failResultUpdates = 1000;
    dataforseo.request.mockResolvedValue(serp([], { cost: 1 }));
    await sweep.processSweepChunk({ chunkSize: 3 });
    expect(mockState.runs[0].status).toBe('open');
  });

  test('a failure log names the row id, never the search text', async () => {
    const logger = require('../services/logger');
    openRun();
    pendingRow('call 941 555 0100 about ants', { id: 'res-x' });
    dataforseo.request.mockRejectedValue(new Error('boom'));
    await sweep.processSweepChunk();
    const logged = logger.error.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('res-x');
    expect(logged).not.toContain('941 555 0100');
  });
});

describe('rankGaps', () => {
  test('asks for shown rows without a Waves citation, web first then impressions, with counts', async () => {
    mockState.runs.push({ id: 'run-1', status: 'done' });
    const add = (query, status, waves_cited) => mockState.results.push({ id: query, run_id: 'run-1', query, status, waves_cited });
    add('gap web', 'shown', false);
    add('gap maps', 'shown', false);
    add('cited', 'shown', true);
    add('no overview', 'none', false);
    add('failed', 'task_error', null);
    const out = await sweep.rankGaps('run-1', { limit: 50 });

    const gapQuery = mockState.queries.find((q) => q.limit === 50);
    expect(gapQuery.wheres).toContainEqual({ run_id: 'run-1', status: 'shown', waves_cited: false });
    expect(gapQuery.orderRaw).toMatch(/^case citation_kind when 'web' then 0 .* impressions_90d desc/);
    expect(out.gaps.map((g) => g.query)).toEqual(['gap web', 'gap maps']);
    expect(out.summary).toMatchObject({ byStatus: { shown: 3, none: 1, task_error: 1 }, shown: 3, cited: 1, gaps: 2 });
    expect(out.run.id).toBe('run-1');
  });
});

describe('cancelSweep and listRuns', () => {
  test('cancels only an open run', async () => {
    openRun();
    expect(await sweep.cancelSweep('run-open')).toMatchObject({ status: 'cancelled' });
    expect(await sweep.cancelSweep('run-open')).toBeNull();
  });

  test('listRuns adds counts by status per run', async () => {
    mockState.runs.push({ id: 'r1' }, { id: 'r2' });
    mockState.results.push({ run_id: 'r1', status: 'shown' }, { run_id: 'r1', status: 'shown' }, { run_id: 'r1', status: 'none' }, { run_id: 'r2', status: 'pending' });
    const runs = await sweep.listRuns();
    expect(runs.find((r) => r.id === 'r1').counts).toEqual({ shown: 2, none: 1 });
    expect(runs.find((r) => r.id === 'r2').counts).toEqual({ pending: 1 });
  });
});
