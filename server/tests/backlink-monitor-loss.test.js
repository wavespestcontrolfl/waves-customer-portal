jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ getBacklinks: jest.fn() }));

const db = require('../models/db');
const dataforseo = require('../services/seo/dataforseo');
const BacklinkMonitor = require('../services/seo/backlink-monitor');

// Minimal chainable knex stand-in: every builder method returns the builder,
// terminal ops resolve through the per-table handler with the collected state.
function makeDb(handlers) {
  const log = [];
  db.mockImplementation((table) => {
    const state = { table, wheres: [], ins: [], notIns: [], nulls: [], raws: [], select: null, op: null, payload: null };
    const done = (op, payload) => {
      state.op = op; state.payload = payload; log.push(state);
      const h = handlers[table];
      if (!h) throw new Error(`Unexpected table ${table}`);
      return Promise.resolve(h(op, state));
    };
    const b = {
      where: jest.fn((...a) => { if (typeof a[0] === 'function') a[0](b); else state.wheres.push(a); return b; }),
      whereIn: jest.fn((col, vals) => { state.ins.push([col, vals]); return b; }),
      whereNull: jest.fn((c) => { state.nulls.push(c); return b; }), orWhere: jest.fn(() => b),
      whereNotIn: jest.fn((col, vals) => { state.notIns.push([col, vals]); return b; }),
      whereRaw: jest.fn((sql, bind) => { state.raws.push([sql, bind]); return b; }),
      raw: jest.fn((sql, bind) => ({ __raw: sql, bind })),
      orderBy: jest.fn(() => b), orderByRaw: jest.fn(() => b), limit: jest.fn(() => b),
      select: jest.fn((...cols) => { state.select = cols; return done('select'); }),
      first: jest.fn((...cols) => { state.select = cols; return done('first'); }),
      insert: jest.fn((p) => { const pr = done('insert', p); pr.returning = jest.fn(() => pr); pr.onConflict = jest.fn(() => ({ ignore: jest.fn(() => pr) })); return pr; }),
      update: jest.fn((p) => done('update', p)),
      increment: jest.fn((col, n) => done('increment', { col, n })),
    };
    return b;
  });
  db.raw = jest.fn((sql, bind) => ({ __raw: sql, bind }));
  // transaction: run the body against the same mocked db; a throwing body propagates (rollback semantics)
  db.transaction = jest.fn(async (fn) => fn(db));
  return log;
}
const passthrough = (_name, fn) => fn();

const activeRow = (over = {}) => ({
  id: 'bl-1', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x',
  source_domain: 'www.blog.example', domain_rating: 45, anchor_text: 'Waves Pest Control',
  miss_count: 0, is_dofollow: true, severity: 'clean', link_type: null, ...over,
});

function scanWith({ items = [], total = items.length, active = [], existingByUrl = {}, stillActiveDomain = false, owed = [] } = {}) {
  dataforseo.getBacklinks.mockResolvedValue({ tasks: [{ result: [{ items, total_count: total }] }] });
  const events = [], updates = [], increments = [], inserts = [], prospectOps = [];
  makeDb({
    seo_backlinks: (op, st) => {
      if (op === 'select') return st.nulls.includes('recovery_queued_at') ? owed : active;
      if (op === 'first') {
        // per-link upsert lookup: where(source_url).where(target_url)
        const url = st.wheres.find(w => w[0] === 'source_url')?.[1];
        if (url) return existingByUrl[url] || null;
        // domain-level "still active?" probe
        return stillActiveDomain ? { id: 'other' } : null;
      }
      if (op === 'update') { updates.push({ ids: st.wheres.find(w => w[0] === 'id')?.[1], patch: st.payload }); return 1; }
      if (op === 'increment') { increments.push({ ids: st.ins[0]?.[1] || st.wheres.find(w => w[0] === 'id')?.[1], ...st.payload }); return 1; }
      if (op === 'insert') { inserts.push(st.payload); return [1]; }
      throw new Error(`unexpected op ${op}`);
    },
    seo_backlink_events: (op, st) => { events.push(st.payload); return [1]; },
    seo_link_prospects: (op, st) => { prospectOps.push({ op, wheres: st.wheres, raws: st.raws, payload: st.payload }); return op === 'update' ? 1 : []; },
  });
  return { events, updates, increments, inserts, prospectOps };
}

describe('BacklinkMonitor verified loss detection', () => {
  beforeEach(() => { db.mockReset(); dataforseo.getBacklinks.mockReset(); });

  test('fetch is no longer dofollow-only; a valid EMPTY result is a complete scan, a missing result aborts', async () => {
    const { increments } = scanWith({ items: [], total: 0, active: [activeRow()] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanned: 0, scanComplete: true, missed: 1, lostCount: 0 }));
    expect(increments).toEqual([{ ids: ['bl-1'], col: 'miss_count', n: 1 }]);
    expect(dataforseo.getBacklinks).toHaveBeenCalledWith('wavespestcontrol.com', 1000, { dofollowOnly: false });

    dataforseo.getBacklinks.mockResolvedValue({ tasks: [{ result: [null] }] });
    await expect(BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() })).resolves.toEqual({ scanned: 0, scanComplete: false });
  });

  test('pages past 1000 by offset until total_count is reached', async () => {
    const mk = (i) => ({ url_from: `https://s${i}.example/a`, url_to: 'https://wavespestcontrol.com/', domain_from: `s${i}.example`, domain_from_rank: 1, dofollow: true });
    const page1 = Array.from({ length: 1000 }, (_, i) => mk(i));
    const page2 = [mk(1000), mk(1001)];
    dataforseo.getBacklinks.mockImplementation(async (_t, _l, { searchAfterToken }) => ({ tasks: [{ result: [{ items: searchAfterToken ? page2 : page1, total_count: 1002, search_after_token: searchAfterToken ? null : 'tok-1' }] }] }));
    makeDb({ seo_backlinks: (op) => (op === 'select' ? [] : op === 'first' ? null : [1]) });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanned: 1002, scanComplete: true }));
    expect(dataforseo.getBacklinks).toHaveBeenCalledTimes(2);
    // search_after_token, never offset (DataForSEO caps offsets at 20,000)
    expect(dataforseo.getBacklinks).toHaveBeenLastCalledWith('wavespestcontrol.com', 1000, { dofollowOnly: false, searchAfterToken: 'tok-1' });

    // a page that omits the token before total_count is reached → incomplete, loss detection skipped
    dataforseo.getBacklinks.mockImplementation(async () => ({ tasks: [{ result: [{ items: page1, total_count: 1002 }] }] }));
    const r2 = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r2).toEqual(expect.objectContaining({ scanned: 1000, scanComplete: false }));
  });

  test('scan is single-flight through the cron advisory lock', async () => {
    const exclusive = jest.fn(async () => ({ skipped: true, reason: 'lease_held' }));
    await expect(BacklinkMonitor.scan({ exclusive })).resolves.toEqual({ skipped: true, reason: 'lease_held' });
    expect(exclusive).toHaveBeenCalledWith('backlink-scan', expect.any(Function), { recordHealth: false });
    expect(dataforseo.getBacklinks).not.toHaveBeenCalled();
  });

  test('snapshot:true snapshots only after a complete scan, inside the exclusive section', async () => {
    const order = [];
    const exclusive = jest.fn(async (_n, fn) => { order.push('lock'); const r = await fn(); order.push('unlock'); return r; });
    const spy = jest.spyOn(BacklinkMonitor, 'takeSnapshot').mockImplementation(async () => { order.push('snapshot'); });
    scanWith({ items: [], total: 0, active: [] });
    await BacklinkMonitor.scan({ exclusive, snapshot: true, crawlFn: jest.fn() });
    expect(order).toEqual(['lock', 'snapshot', 'unlock']);

    // partial scan (API said 1500 but only 1000 came back on a short page) → no snapshot
    spy.mockClear();
    dataforseo.getBacklinks.mockResolvedValueOnce({ tasks: [{ result: [{ items: [], total_count: 1500 }] }] });
    const r = await BacklinkMonitor.scan({ exclusive, snapshot: true, crawlFn: jest.fn() });
    expect(r.scanComplete).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('first miss only increments miss_count — nothing is marked lost', async () => {
    const crawl = jest.fn();
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const { updates, increments, events } = scanWith({ items: [seen], active: [activeRow()] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl });
    expect(r).toEqual(expect.objectContaining({ scanComplete: true, missed: 1, lostCount: 0 }));
    expect(increments).toEqual([{ ids: ['bl-1'], col: 'miss_count', n: 1 }]);
    expect(updates.filter(u => u.patch.status === 'lost')).toHaveLength(0);
    expect(crawl).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  test('second miss + crawl finds no link → lost with reason, event, domain-level alert and recovery', async () => {
    const crawl = jest.fn(async () => ({ found: false, status: 200 }));
    const recovery = jest.fn(async () => ({ queued: 1 }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const { updates, events } = scanWith({ items: [seen], active: [activeRow({ miss_count: 1 })] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl, recoveryFn: recovery, now: new Date('2026-08-30T07:30:00Z') });

    // crawl gets the target WITHOUT the query string so utm-tagged links still match
    expect(crawl).toHaveBeenCalledWith('https://blog.example/post', 'https://wavespestcontrol.com/pest-control-sarasota-fl/', { exact: true });
    const lost = updates.find(u => u.patch.status === 'lost');
    expect(lost.ids).toBe('bl-1');
    expect(lost.patch).toEqual(expect.objectContaining({ lost_reason: 'link_removed', miss_count: 2 }));
    expect(lost.patch.lost_at).toEqual(new Date('2026-08-30T07:30:00Z'));
    expect(events).toEqual([expect.objectContaining({ backlink_id: 'bl-1', event_type: 'lost' })]);
    expect(r).toEqual(expect.objectContaining({ lostCount: 1, lostDomains: 1, highValueLost: 1, recoveryQueued: 1 }));
    expect(recovery).toHaveBeenCalledWith([expect.objectContaining({ domain: 'blog.example', lost_reason: 'link_removed', domain_rating: 45, alertable: true })]);
    // recovery reported a terminal outcome → the row is stamped so it is not swept again
    expect(updates.find(u => u.patch.recovery_queued_at)).toBeUndefined(); // stamp goes through whereIn, captured below
  });

  test('recovery stamping: terminal outcomes stamp recovery_queued_at, errors are left for the next scan', async () => {
    const crawl = jest.fn(async () => ({ found: false, status: 200 }));
    const recovery = jest.fn(async (losses) => ({ queued: 0, results: losses.map(l => ({ domain: l.domain, outcome: l.domain === 'flaky.example' ? 'error' : 'skipped' })) }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const log = [];
    const active = [activeRow({ miss_count: 1 }), activeRow({ id: 'bl-2', source_url: 'https://flaky.example/p', source_domain: 'flaky.example', miss_count: 1 })];
    const { increments } = scanWith({ items: [seen], active });
    // capture whereIn-based updates (stamps)
    const origImpl = db.getMockImplementation();
    db.mockImplementation((table) => { const b = origImpl(table); const u = b.update; b.update = jest.fn((p) => { log.push({ table, ins: b.whereIn.mock.calls.map(c => c[1]).flat(), patch: p }); return u(p); }); return b; });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl, recoveryFn: recovery, now: new Date('2026-08-30T07:30:00Z') });
    const stamps = log.filter(l => l.patch.recovery_queued_at);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].ins).toEqual(['bl-1']); // blog.example settled; flaky.example errored → not stamped
    expect(stamps[0].patch.recovery_queued_at).toEqual(new Date('2026-08-30T07:30:00Z'));
    expect(increments).toEqual([]);
  });

  test('a loss on a domain that still links us is deferred (not stamped) and aggregated when the last link goes', async () => {
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const stamps = [];
    const wrap = () => { const impl = db.getMockImplementation(); db.mockImplementation((table) => { const b = impl(table); const u = b.update; b.update = jest.fn((p) => { if (p.recovery_queued_at) stamps.push(b.whereIn.mock.calls.map(c => c[1]).flat()); return u(p); }); return b; }); };

    // week 1: editorial A verified lost, sibling B still active → A deferred, no alert, no stamp
    const A = activeRow({ id: 'A', source_url: 'https://dom.example/resources', source_domain: 'dom.example', miss_count: 1 });
    scanWith({ items: [seen], active: [A], stillActiveDomain: true }); wrap();
    const recovery = jest.fn(async () => ({ queued: 0, results: [] }));
    const r1 = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: async () => ({ found: false, status: 404 }), recoveryFn: recovery });
    expect(r1).toEqual(expect.objectContaining({ lostCount: 1, lostDomains: 0, highValueLost: 0 }));
    expect(recovery).not.toHaveBeenCalled();
    expect(stamps).toEqual([]);

    // week 3: B (a directory page, unreachable) goes too; A comes back via the owed sweep and represents the domain
    const owedA = { id: 'A', source_url: 'https://dom.example/resources', target_url: A.target_url, source_domain: 'dom.example', domain_rating: 45, anchor_text: null, severity: 'clean', link_type: null, lost_reason: 'page_gone' };
    const B = activeRow({ id: 'B', source_url: 'https://dom.example/directory/x', source_domain: 'dom.example', miss_count: 3 });
    scanWith({ items: [seen], active: [B], owed: [owedA] }); wrap();
    const recovery2 = jest.fn(async (losses) => ({ queued: 1, results: losses.map(l => ({ domain: l.domain, outcome: 'queued' })) }));
    const r2 = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: async () => ({ found: false, error: 'ETIMEDOUT' }), recoveryFn: recovery2 });
    expect(r2).toEqual(expect.objectContaining({ lostCount: 1, lostDomains: 1, highValueLost: 1, recoveryQueued: 1 }));
    expect(recovery2).toHaveBeenCalledWith([expect.objectContaining({ domain: 'dom.example', backlink_id: 'A', lost_reason: 'page_gone', alertable: true })]);
    expect(stamps.flat().sort()).toEqual(['A', 'B']); // both rows settled with the domain
  });

  test('earlier verified losses still owed a recovery evaluation are swept into this scan', async () => {
    const recovery = jest.fn(async (losses) => ({ queued: losses.length, results: losses.map(l => ({ domain: l.domain, outcome: 'queued' })) }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const owed = [{ id: 'old-1', source_url: 'https://old.example/res', target_url: 'https://wavespestcontrol.com/', source_domain: 'old.example', domain_rating: 60, anchor_text: null, severity: 'clean', link_type: null, lost_reason: 'page_gone' }];
    scanWith({ items: [seen], active: [], owed });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery });
    expect(r).toEqual(expect.objectContaining({ lostCount: 0, lostDomains: 1, highValueLost: 1, recoveryQueued: 1 }));
    expect(recovery).toHaveBeenCalledWith([expect.objectContaining({ domain: 'old.example', backlink_id: 'old-1', lost_reason: 'page_gone', alertable: true })]);
  });

  test('a 2xx bot-challenge or non-HTML body is unverified, never link_removed', async () => {
    const link = { source_url: 'https://x.example/p', target_url: 'https://wavespestcontrol.com/', miss_count: 1 };
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 200, unverifiable: 'challenge' }) })).resolves.toEqual({ outcome: 'unverified', status: 200, error: 'challenge_page' });
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 200, unverifiable: 'non_html' }) })).resolves.toEqual({ outcome: 'unverified', status: 200, error: 'non_html_page' });
  });

  test('a state change and its ledger row are written in one transaction; a failed event insert rolls the flip back', async () => {
    const crawl = jest.fn(async () => ({ found: false, status: 200 }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const { updates } = scanWith({ items: [seen], active: [activeRow({ miss_count: 1 })] });
    const impl = db.getMockImplementation();
    db.mockImplementation((table) => { if (table === 'seo_backlink_events') throw new Error('events table down'); return impl(table); });
    await expect(BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl, recoveryFn: jest.fn() })).rejects.toThrow('events table down');
    expect(db.transaction).toHaveBeenCalled();
    // inside the (rolled-back) transaction the update ran, but nothing was committed without its event
    expect(updates.filter(u => u.patch.status === 'lost')).toHaveLength(1);
  });

  test('crawl still finds the link → survives (index churn), counter reset, no loss', async () => {
    const crawl = jest.fn(async () => ({ found: true, isDofollow: true, status: 200 }));
    const recovery = jest.fn();
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const { updates, events } = scanWith({ items: [seen], active: [activeRow({ miss_count: 1 })] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl, recoveryFn: recovery });
    expect(r).toEqual(expect.objectContaining({ lostCount: 0, verifiedLive: 1 }));
    expect(updates.find(u => u.ids === 'bl-1').patch).toEqual(expect.objectContaining({ miss_count: 0 }));
    expect(updates.filter(u => u.patch.status === 'lost')).toHaveLength(0);
    expect(events).toEqual([expect.objectContaining({ event_type: 'verify_survived' })]);
    expect(recovery).not.toHaveBeenCalled();
  });

  test('crawl finds the link but nofollow → rel_changed event, not a loss', async () => {
    const crawl = jest.fn(async () => ({ found: true, isDofollow: false, status: 200 }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const { updates, events } = scanWith({ items: [seen], active: [activeRow({ miss_count: 1 })] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl });
    expect(r).toEqual(expect.objectContaining({ lostCount: 0, relChanges: 1 }));
    expect(updates.find(u => u.ids === 'bl-1').patch).toEqual(expect.objectContaining({ is_dofollow: false, miss_count: 0 }));
    expect(events.map(e => e.event_type)).toEqual(['rel_changed', 'verify_survived']);
  });

  test('DataForSEO reporting a dofollow→nofollow flip records an event and keeps the row active', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x', domain_from: 'www.blog.example', domain_from_rank: 45, dofollow: false };
    const existing = { id: 'bl-1', status: 'active', is_dofollow: true };
    const { updates, events } = scanWith({ items: [seen], active: [activeRow()], existingByUrl: { [seen.url_from]: existing } });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ relChanges: 1, lostCount: 0, missed: 0 }));
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'active', is_dofollow: false, miss_count: 0 }));
    expect(events).toEqual([expect.objectContaining({ event_type: 'rel_changed', detail: JSON.stringify({ from: 'dofollow', to: 'nofollow', source: 'dataforseo' }) })]);
  });

  test('a lost row that reappears is recovered (lost_at/lost_reason cleared, event recorded) and its recovery prospect closed as live', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x', domain_from: 'www.blog.example', domain_from_rank: 45, dofollow: true };
    const existing = { id: 'bl-9', status: 'lost', is_dofollow: true, lost_reason: 'link_removed' };
    const { updates, events, prospectOps } = scanWith({ items: [seen], active: [], existingByUrl: { [seen.url_from]: existing } });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ recovered: 1 }));
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'active', lost_at: null, lost_reason: null, miss_count: 0 }));
    expect(events).toEqual([expect.objectContaining({ backlink_id: 'bl-9', event_type: 'recovered' })]);
    // the un-pitched lost_recovery prospect for this link is resolved, not left for the drafter
    const resolve = prospectOps.find(o => o.op === 'update');
    expect(resolve.wheres[0][0]).toEqual({ target_domain: 'blog.example', status: 'prospect' });
    expect(resolve.raws[0][0]).toMatch(/lost_recovery/);
    expect(resolve.payload).toEqual(expect.objectContaining({ status: 'live', live_url: 'https://blog.example/post', backlink_id: 'bl-9', outreach_status: 'none' }));
  });

  test('if the recovery prospect cannot be resolved, the row stays lost for the next scan to retry', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const existing = { id: 'bl-9', status: 'lost', is_dofollow: true, lost_reason: 'link_removed' };
    const { updates, events } = scanWith({ items: [seen], active: [], existingByUrl: { [seen.url_from]: existing } });
    const impl = db.getMockImplementation();
    db.mockImplementation((table) => { if (table === 'seo_link_prospects') throw new Error('prospects db down'); return impl(table); });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ recovered: 0, unresolvedRecoveries: 1, scanned: 1 }));
    expect(updates.filter(u => u.ids === 'bl-9')).toHaveLength(0); // no lost→active flip
    expect(events).toHaveLength(0);
  });

  test('pages until total_count regardless of page count (no 5-page freeze)', async () => {
    const mk = (i) => ({ url_from: `https://s${i}.example/a`, url_to: 'https://wavespestcontrol.com/', domain_from: `s${i}.example`, domain_from_rank: 1, dofollow: true });
    const all = Array.from({ length: 14 }, (_, i) => mk(i));
    dataforseo.getBacklinks.mockImplementation(async (_t, limit, { searchAfterToken }) => { const offset = Number(searchAfterToken || 0); return { tasks: [{ result: [{ items: all.slice(offset, offset + limit), total_count: 14, search_after_token: String(offset + limit) }] }] }; });
    makeDb({ seo_backlinks: (op) => (op === 'select' ? [] : op === 'first' ? null : [1]) });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), pageSize: 2 });
    expect(r).toEqual(expect.objectContaining({ scanned: 14, scanComplete: true }));
    expect(dataforseo.getBacklinks).toHaveBeenCalledTimes(7);
  });

  test('domain survival only counts scan-tracked rows (GSC-export rows are excluded)', async () => {
    let survivalQuery = null;
    makeDb({ seo_backlinks: (op, st) => { if (op === 'first') { survivalQuery = st; return null; } return []; } });
    const out = await BacklinkMonitor.domainLevelLosses([
      { id: 'a', source_domain: 'good.example', source_url: 'https://good.example/resources', domain_rating: 40, severity: 'clean', lost_reason: 'page_gone' },
    ]);
    expect(out[0].alertable).toBe(true);
    // the builder passed to where(fn) exposes whereNull/orWhere — the mock records calls on the same builder
    expect(survivalQuery).not.toBeNull();
    expect(db.mock.results.at(-1).value.whereNull).toHaveBeenCalledWith('discovery_source');
    expect(db.mock.results.at(-1).value.orWhere).toHaveBeenCalledWith('discovery_source', 'dataforseo');
  });

  test('domain-level rollup: directory / low-DR / owned / still-linking domains are not alertable', async () => {
    makeDb({ seo_backlinks: (op) => (op === 'first' ? null : []) });
    const out = await BacklinkMonitor.domainLevelLosses([
      { id: 'own', source_domain: 'www.veniceflpestcontrol.com', source_url: 'https://www.veniceflpestcontrol.com/rainy-season/', domain_rating: 45, severity: 'clean', lost_reason: 'page_gone' },
      { id: 'a', source_domain: 'www.good.example', source_url: 'https://good.example/resources', domain_rating: 40, severity: 'clean', lost_reason: 'page_gone' },
      { id: 'b', source_domain: 'dir.example', source_url: 'https://dir.example/directory/pest', domain_rating: 60, severity: 'clean', lost_reason: 'link_removed' },
      { id: 'c', source_domain: 'small.example', source_url: 'https://small.example/x', domain_rating: 12, severity: 'clean', lost_reason: 'link_removed' },
      { id: 'd', source_domain: 'flaky.example', source_url: 'https://flaky.example/x', domain_rating: 70, severity: 'clean', lost_reason: 'unreachable' },
      { id: 'e', source_domain: 'spam.example', source_url: 'https://spam.example/x', domain_rating: 70, severity: 'critical', lost_reason: 'link_removed' },
    ]);
    expect(out.map(d => [d.domain, d.alertable])).toEqual([
      ['veniceflpestcontrol.com', false], ['good.example', true], ['dir.example', false], ['small.example', false], ['flaky.example', false], ['spam.example', false],
    ]);

    // several rows from one domain: the ALERTABLE row represents the domain, not the first/rotated one
    makeDb({ seo_backlinks: (op) => (op === 'first' ? null : []) });
    const multi = await BacklinkMonitor.domainLevelLosses([
      { id: 'r1', source_domain: 'multi.example', source_url: 'https://multi.example/directory/pest', domain_rating: 50, severity: 'clean', lost_reason: 'link_removed' },
      { id: 'r2', source_domain: 'multi.example', source_url: 'https://multi.example/x', domain_rating: 50, severity: 'clean', lost_reason: 'unreachable' },
      { id: 'r3', source_domain: 'multi.example', source_url: 'https://multi.example/resources', domain_rating: 50, severity: 'clean', lost_reason: 'page_gone' },
    ]);
    expect(multi).toEqual([expect.objectContaining({ domain: 'multi.example', backlink_id: 'r3', link_type: 'resource', alertable: true })]);

    makeDb({ seo_backlinks: (op) => (op === 'first' ? { id: 'still' } : []) });
    const still = await BacklinkMonitor.domainLevelLosses([
      { id: 'a', source_domain: 'good.example', source_url: 'https://good.example/p2', domain_rating: 40, severity: 'clean', lost_reason: 'page_gone' },
    ]);
    expect(still).toEqual([expect.objectContaining({ domain: 'good.example', stillLinking: true, alertable: false })]); // another page still links → not a domain loss, row deferred
  });

  test('verifyLoss maps HTTP outcomes to reasons and gives unreachable hosts a longer window', async () => {
    const link = { source_url: 'https://x.example/p', target_url: 'https://wavespestcontrol.com/', miss_count: 1 };
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 404 }) })).resolves.toEqual({ outcome: 'lost', reason: 'page_gone', status: 404 });
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 200 }) })).resolves.toEqual({ outcome: 'lost', reason: 'link_removed', status: 200 });
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 410 }) })).resolves.toEqual({ outcome: 'lost', reason: 'page_gone', status: 410 });
    // a 2xx whose body was cut short cannot prove the link is gone
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 200, truncated: true }) })).resolves.toEqual({ outcome: 'unverified', status: 200, error: 'truncated_body' });
    // bot blocks, throttling and outages prove nothing
    for (const status of [403, 429, 500, 503]) {
      await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status }) })).resolves.toEqual({ outcome: 'unverified', status, error: `http_${status}` });
    }
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, status: 0, blocked: true, error: 'blocked_host' }) })).resolves.toEqual({ outcome: 'unverified', status: null, error: 'blocked_host' });
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: false, error: 'ECONNREFUSED' }) })).resolves.toEqual({ outcome: 'unverified', status: null, error: 'ECONNREFUSED' });
    await expect(BacklinkMonitor.verifyLoss({ ...link, miss_count: 3 }, { crawlFn: async () => { throw new Error('timeout'); } })).resolves.toEqual({ outcome: 'lost', reason: 'unreachable', status: null, error: 'timeout' });
    await expect(BacklinkMonitor.verifyLoss(link, { crawlFn: async () => ({ found: true, isDofollow: false, status: 200 }) })).resolves.toEqual({ outcome: 'live', isDofollow: false, status: 200 });
  });
});

describe('lost-link recovery', () => {
  const recovery = require('../services/seo/lost-link-recovery');
  beforeEach(() => db.mockReset());

  const loss = { domain: 'blog.example', backlink_id: 'bl-1', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x', domain_rating: 45, anchor_text: 'Waves Pest Control', link_type: 'editorial', lost_reason: 'link_removed', alertable: true };

  test('queues a high-priority lost_recovery prospect with the scorer contact', async () => {
    const inserts = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return null; if (op === 'insert') { inserts.push(st.payload); return [1]; } } });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'resource', score: 80, tier: 1, relevance_0_100: 70, lead_value_tier: 1, is_local_swfl: true, contact: { contact_email: 'ed@blog.example', contact_url: null }, gate: { ok: true, lane: 'outreach' } }]) };
    const r = await recovery.queueLostDomains([loss], { scorer });
    expect(r).toEqual(expect.objectContaining({ queued: 1, skipped: 0 }));
    expect(inserts[0]).toEqual(expect.objectContaining({
      target_domain: 'blog.example', target_page: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
      link_type: 'resource', priority: 'high', source: 'lost_recovery', source_ref: 'bl-1', owner: 'backlink_monitor',
      contact_email: 'ed@blog.example', domain_rating: 45, anchor_planned: 'Waves Pest Control',
    }));
    expect(JSON.parse(inserts[0].quality_signals)).toEqual(expect.objectContaining({ lost_recovery: true, lost_reason: 'link_removed' }));
  });

  test('skips in-flight / rejected board rows and domains the scorer classifies as signup-lane', async () => {
    const inserts = [];
    const rows = { 'dup.example': { id: 'p', status: 'prospect' }, 'no.example': { id: 'r', status: 'rejected' } };
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return rows[st.wheres[0][0].target_domain] || null; if (op === 'insert') { inserts.push(st.payload); return [1]; } } });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'directory', gate: { ok: true, lane: 'signup' } }]) };
    const r = await recovery.queueLostDomains([{ ...loss, domain: 'dup.example' }, { ...loss, domain: 'no.example' }, { ...loss, domain: 'dir.example' }], { scorer });
    expect(r.queued).toBe(0);
    expect(r.skipped).toBe(3);
    expect(inserts).toHaveLength(0);
    expect(scorer.scoreCandidates).toHaveBeenCalledTimes(1); // board hits never spend a scoring call
  });

  test('a prospect the outbound verifier moved to lost is REOPENED, not duplicated', async () => {
    const updates = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return { id: 'p-lost', status: 'lost', notes: 'placed via signup', link_type: 'resource' }; if (op === 'update') { updates.push({ where: st.wheres[0][0], patch: st.payload }); return 1; } if (op === 'insert') throw new Error('must not insert'); } });
    const scorer = { scoreCandidates: jest.fn() };
    const r = await recovery.queueLostDomains([loss], { scorer });
    expect(r).toEqual({ queued: 1, skipped: 0, reasons: [{ domain: 'blog.example', reason: 'reopened lost prospect' }], results: [{ domain: 'blog.example', backlink_id: 'bl-1', outcome: 'queued' }] });
    expect(updates[0].where).toEqual({ id: 'p-lost', status: 'lost' }); // conditional reopen
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'prospect', priority: 'high', claimed_at: null, attempts: 0, outreach_status: 'none', outreach_send_token: null, outreach_sent_at: null }));
    expect(updates[0].patch).not.toHaveProperty('outreach_attempted_at'); // kept — feeds the trailing-24h send cap
    expect(updates[0].patch.quality_signals.__raw).toMatch(/prior_outreach_sent_at/); // prior send preserved, not erased
    expect(updates[0].patch.quality_signals.__raw).toMatch(/prior_attempts/); // retry budget restarts, history kept
    expect(updates[0].patch.notes).toMatch(/^placed via signup\nLost-link recovery/);
    expect(scorer.scoreCandidates).not.toHaveBeenCalled();
  });

  test('a concurrent insert of the same (domain, page) is ignored, counted as a skip, and does not abort the batch', async () => {
    const inserts = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return null; if (op === 'insert') { inserts.push(st.payload); return inserts.length === 1 ? [] : [{ id: 'new-row' }]; } } });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'resource', gate: { ok: true, lane: 'outreach' }, contact: { contact_email: 'a@b.example' } }]) };
    const r = await recovery.queueLostDomains([{ ...loss, domain: 'race.example' }, { ...loss, domain: 'ok.example' }], { scorer });
    expect(r).toEqual(expect.objectContaining({ queued: 1, skipped: 1 }));
    // pg semantics: returning('id') is chained after ignore() so a landed row is never mistaken for a conflict
    const lastInsert = db.mock.results.filter(x => x.value && x.value.insert).at(-1).value;
    expect(lastInsert.insert.mock.results[0].value.onConflict).toHaveBeenCalledWith(['target_domain', 'target_page']);
    expect(lastInsert.insert.mock.results[0].value.returning).toHaveBeenCalledWith('id');
    expect(r.reasons).toEqual([{ domain: 'race.example', reason: 'already on board (concurrent insert)' }]);
  });

  test('a throwing row does not abort the rest of the batch', async () => {
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') { if (st.wheres[0][0].target_domain === 'boom.example') throw new Error('db down'); return null; } if (op === 'insert') return [1]; } });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'resource', gate: { ok: true, lane: 'outreach' } }]) };
    const r = await recovery.queueLostDomains([{ ...loss, domain: 'boom.example' }, { ...loss, domain: 'fine.example' }], { scorer });
    expect(r.queued).toBe(1);
    expect(r.reasons).toEqual([{ domain: 'boom.example', reason: 'error: db down' }]);
    expect(r.results.map(x => x.outcome)).toEqual(['error', 'queued']);
  });

  test('a lost signup-lane placement (citation) is not reopened into the outreach board', async () => {
    const updates = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return { id: 'p-cit', status: 'lost', notes: null, link_type: 'citation' }; if (op === 'update') { updates.push(st.payload); return 1; } if (op === 'insert') throw new Error('must not insert'); } });
    const r = await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn() } });
    expect(r).toEqual({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'lost citation placement — signup lane, not reopened' }], results: [{ domain: 'blog.example', backlink_id: 'bl-1', outcome: 'skipped' }] });
    expect(updates).toHaveLength(0);
  });

  test('resolveRecoveredLink closes only un-pitched recovery prospects for that exact page', async () => {
    const ops = [];
    makeDb({ seo_link_prospects: (op, st) => { ops.push({ op, wheres: st.wheres, ins: st.ins, nulls: st.nulls, raws: st.raws, payload: st.payload }); return 2; } });
    const r = await recovery.resolveRecoveredLink({ id: 'bl-1', source_url: 'https://blog.example/post', source_domain: 'www.blog.example', target_url: 'https://wavespestcontrol.com/x/?u=1' }, new Date('2026-09-06T08:00:00Z'));
    expect(r).toEqual({ resolved: 2 });
    expect(ops[0].wheres[0][0]).toEqual({ target_domain: 'blog.example', status: 'prospect' });
    expect(ops[0].ins[0]).toEqual(['target_page', expect.arrayContaining(['https://wavespestcontrol.com/x/', 'https://www.wavespestcontrol.com/x', 'https://www.wavespestcontrol.com/x/'])]);
    // only unsent rows: none/drafted and outreach_sent_at IS NULL — sending/sent are left for reconciliation
    expect(ops[0].raws.map(r => r[0]).join(' ')).toMatch(/outreach_status.*'none', 'drafted'/);
    expect(ops[0].nulls).toContain('outreach_sent_at');
    expect(ops[0].payload).toEqual(expect.objectContaining({ status: 'live', backlink_id: 'bl-1' }));
    expect(ops[0].payload.first_live_at.__raw).toBe('COALESCE(first_live_at, ?)'); // original first-live history preserved
    expect(ops[0].payload.notes.bind[0]).toMatch(/closed 2026-09-06:/); // 08:00Z = 04:00 ET → same ET day; ET date, not UTC
  });

  test('a reopened row with a null/unclaimable link_type gets a worker-claimable outreach type', async () => {
    const updates = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return { id: 'p-null', status: 'lost', notes: null, link_type: null }; if (op === 'update') { updates.push(st.payload); return 1; } } });
    await recovery.queueLostDomains([{ ...loss, link_type: 'editorial' }], { scorer: { scoreCandidates: jest.fn() } });
    expect(updates[0].link_type).toBe('editorial');
    updates.length = 0;
    await recovery.queueLostDomains([{ ...loss, link_type: 'unknown' }], { scorer: { scoreCandidates: jest.fn() } });
    expect(updates[0].link_type).toBe('resource');
  });

  test('board lookup matches every spelling of the target page; canonical insert form', () => {
    const { targetPageOf, targetPageVariants } = recovery._test;
    expect(targetPageOf('https://www.wavespestcontrol.com/x?utm=1#f')).toBe('https://www.wavespestcontrol.com/x/');
    expect(targetPageOf('http://wavespestcontrol.com')).toBe('https://wavespestcontrol.com/');
    expect(targetPageVariants('https://wavespestcontrol.com/x/')).toEqual(expect.arrayContaining([
      'https://wavespestcontrol.com/x', 'https://wavespestcontrol.com/x/', 'https://www.wavespestcontrol.com/x', 'https://www.wavespestcontrol.com/x/',
    ]));
    expect(targetPageVariants('https://www.wavespestcontrol.com/?ref=x')).toContain('https://wavespestcontrol.com/');
  });

  test('reopen is conditional on the row still being lost (0-row update = skip)', async () => {
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return { id: 'p-lost', status: 'lost', notes: null, link_type: 'resource' }; if (op === 'update') { expect(st.wheres[0][0]).toEqual({ id: 'p-lost', status: 'lost' }); return 0; } } });
    const r = await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn() } });
    expect(r).toEqual(expect.objectContaining({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'board row no longer lost (restored concurrently)' }] }));
  });

  test('fail-soft fallback link_type is coerced to a worker-claimable type', async () => {
    const inserts = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return null; if (op === 'insert') { inserts.push(st.payload); return [1]; } } });
    const scorer = { scoreCandidates: jest.fn(async () => { throw new Error('down'); }), CLAIMABLE_LINK_TYPES: new Set(['editorial', 'resource']) };
    await recovery.queueLostDomains([{ ...loss, link_type: 'unknown' }], { scorer });
    expect(inserts[0].link_type).toBe('resource');
  });

  test('applies the same contactability gate as create_link_prospects', async () => {
    const inserts = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return null; if (op === 'insert') { inserts.push(st.payload); return [1]; } } });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'editorial', gate: { ok: false, lane: 'outreach', reason: 'no contact path' } }]) };
    const r = await recovery.queueLostDomains([loss], { scorer });
    expect(r).toEqual({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'no contact path' }], results: [{ domain: 'blog.example', backlink_id: 'bl-1', outcome: 'skipped' }] });
    expect(inserts).toHaveLength(0);
  });

  test('scorer failure is fail-soft: the row is still queued with what the monitor knows', async () => {
    const inserts = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return null; if (op === 'insert') { inserts.push(st.payload); return [1]; } } });
    const scorer = { scoreCandidates: jest.fn(async () => { throw new Error('anthropic down'); }) };
    const r = await recovery.queueLostDomains([loss], { scorer });
    expect(r.queued).toBe(1);
    expect(inserts[0]).toEqual(expect.objectContaining({ link_type: 'editorial', contact_email: null, score: null }));
  });
});

describe('crawlForLink goes through the SSRF-pinned fetcher', () => {
  const verifier = require('../services/seo/link-prospect-verifier');

  test('classifyPageBody flags interstitials and non-HTML; crawlForLink reports them as unverifiable', async () => {
    expect(verifier.classifyPageBody('<html><title>Just a moment...</title><div id="cf-chl-widget"></div></html>', 'text/html')).toBe('challenge');
    expect(verifier.classifyPageBody('%PDF-1.4 binary', 'application/pdf')).toBe('non_html');
    expect(verifier.classifyPageBody('{"ok":true}', 'application/json')).toBe('non_html');
    expect(verifier.classifyPageBody('<html><body><p>Hi</p><a href="https://wavespestcontrol.com/">w</a></body></html>', 'text/html; charset=utf-8')).toBe('html');
    // a real page that merely mentions "access denied" in copy but links us still parses
    expect(verifier.classifyPageBody('<html><body>access denied stories <a href="https://wavespestcontrol.com/">w</a></body></html>', null)).toBe('html');
    const fetchPageFn = jest.fn(async () => ({ status: 200, html: '<html><title>Attention Required! | Cloudflare</title></html>', blocked: false, truncated: false, contentType: 'text/html', error: null }));
    await expect(verifier.crawlForLink('https://blog.example/p', 'https://wavespestcontrol.com/', { fetchPageFn }))
      .resolves.toEqual({ found: false, status: 200, blocked: false, truncated: false, unverifiable: 'challenge', error: null });
  });

  test('href parsing covers unquoted, single-quoted, protocol-relative and entity-encoded links', () => {
    const t = 'https://wavespestcontrol.com/pest-control-sarasota-fl/';
    expect(verifier.findLinkInHtml('<a href=https://wavespestcontrol.com/pest-control-sarasota-fl/>x</a>', t, { exact: true })).toEqual(expect.objectContaining({ found: true, isDofollow: true }));
    expect(verifier.findLinkInHtml("<a class='c' href='//www.wavespestcontrol.com/pest-control-sarasota-fl' rel=nofollow>x</a>", t, { exact: true })).toEqual(expect.objectContaining({ found: true, isDofollow: false }));
    expect(verifier.findLinkInHtml('<a href="https://wavespestcontrol.com/pest-control-sarasota-fl/?a=1&amp;b=2" REL="sponsored noopener">x</a>', t, { exact: true })).toEqual(expect.objectContaining({ found: true, isDofollow: false }));
    expect(verifier.findLinkInHtml('<a href="https://other.example/">no</a><a href=https://wavespestcontrol.com/other/>x</a>', t, { exact: true })).toEqual({ found: false });
  });

  test('exact mode refuses a descendant-path link as proof the lost link survives', () => {
    const html = '<a href="https://wavespestcontrol.com/pest-control-sarasota-fl/article/">deep</a>';
    expect(verifier.findLinkInHtml(html, 'https://wavespestcontrol.com/pest-control-sarasota-fl/', { exact: true })).toEqual({ found: false });
    expect(verifier.findLinkInHtml(html, 'https://wavespestcontrol.com/pest-control-sarasota-fl/')).toEqual(expect.objectContaining({ found: true }));
    const same = '<a href="https://www.wavespestcontrol.com/pest-control-sarasota-fl?utm=x#top">ok</a>';
    expect(verifier.findLinkInHtml(same, 'https://wavespestcontrol.com/pest-control-sarasota-fl/', { exact: true })).toEqual(expect.objectContaining({ found: true, isDofollow: true }));
  });

  test('returns status + rel from a fetched page and never follows into a blocked host', async () => {
    const html = '<p><a href="https://www.wavespestcontrol.com/pest-control-sarasota-fl/?utm=x" rel="sponsored">Waves</a></p>';
    const fetchPageFn = jest.fn(async () => ({ status: 200, html, blocked: false, error: null }));
    await expect(verifier.crawlForLink('https://blog.example/p', 'https://wavespestcontrol.com/pest-control-sarasota-fl/', { fetchPageFn }))
      .resolves.toEqual({ found: true, isDofollow: false, anchorText: 'Waves', status: 200, blocked: false, truncated: false, error: null });
    expect(fetchPageFn).toHaveBeenCalledWith('https://blog.example/p', { timeoutMs: 12000 });

    const blocked = jest.fn(async () => ({ status: 0, html: null, blocked: true, truncated: false, error: 'blocked_host' }));
    await expect(verifier.crawlForLink('http://169.254.169.254/latest', 'https://wavespestcontrol.com/', { fetchPageFn: blocked }))
      .resolves.toEqual({ found: false, status: 0, blocked: true, truncated: false, error: 'blocked_host' });

    const gone = jest.fn(async () => ({ status: 404, html: null, blocked: false, truncated: false, error: null }));
    await expect(verifier.crawlForLink('https://blog.example/p', 'https://wavespestcontrol.com/', { fetchPageFn: gone }))
      .resolves.toEqual({ found: false, status: 404, blocked: false, truncated: false, error: null });

    // a complete-but-EMPTY 2xx (204 / blank 200) is unverifiable, never "link removed"
    for (const [status, html] of [[204, ''], [200, ''], [200, '   \n']]) {
      const emptyOk = jest.fn(async () => ({ status, html, blocked: false, truncated: false, error: null }));
      await expect(verifier.crawlForLink('https://blog.example/p', 'https://wavespestcontrol.com/', { fetchPageFn: emptyOk }))
        .resolves.toEqual(expect.objectContaining({ found: false, status, unverifiable: 'empty' }));
      await expect(BacklinkMonitor.verifyLoss({ source_url: 'https://blog.example/p', target_url: 'https://wavespestcontrol.com/', miss_count: 1 }, { crawlFn: () => emptyOk().then(pg => verifier.crawlForLink('https://blog.example/p', 'https://wavespestcontrol.com/', { fetchPageFn: async () => pg })) }))
        .resolves.toEqual(expect.objectContaining({ outcome: 'unverified', error: 'empty_page' }));
    }
    // empty-but-truncated 2xx keeps the truncation flag so verifyLoss stays 'unverified'
    const emptyCut = jest.fn(async () => ({ status: 200, html: '', blocked: false, truncated: true, error: null }));
    await expect(verifier.crawlForLink('https://blog.example/p', 'https://wavespestcontrol.com/', { fetchPageFn: emptyCut }))
      .resolves.toEqual({ found: false, status: 200, blocked: false, truncated: true, unverifiable: 'empty', error: null });
  });

  test('contact-finder.fetchPage refuses private hosts before any network call and revalidates redirects', async () => {
    const { fetchPage } = require('../services/seo/contact-finder');
    const fetchFn = jest.fn();
    await expect(fetchPage('http://127.0.0.1/admin', { fetchFn, resolveHostFn: async () => true })).resolves.toEqual(expect.objectContaining({ blocked: true, html: null }));
    expect(fetchFn).not.toHaveBeenCalled();

    // public → 302 → private: the second hop is blocked, nothing fetched from it
    fetchFn.mockResolvedValueOnce({ status: 302, ok: false, headers: { get: () => 'http://10.0.0.5/secret' }, text: async () => '' });
    const r = await fetchPage('https://public.example/x', { fetchFn, resolveHostFn: async (h) => h === 'public.example' });
    expect(r).toEqual(expect.objectContaining({ blocked: true }));
    expect(fetchFn).toHaveBeenCalledTimes(1);

    fetchFn.mockResolvedValueOnce({ status: 404, ok: false, headers: { get: () => null }, text: async () => '' });
    await expect(fetchPage('https://public.example/gone', { fetchFn, resolveHostFn: async () => true })).resolves.toEqual({ status: 404, html: null, blocked: false, truncated: false, error: null });

    // a fetcher that reports a cut body surfaces truncated:true
    fetchFn.mockResolvedValueOnce({ status: 200, ok: true, complete: false, headers: { get: () => null }, text: async () => '<html>partial' });
    await expect(fetchPage('https://public.example/big', { fetchFn, resolveHostFn: async () => true })).resolves.toEqual(expect.objectContaining({ status: 200, truncated: true, html: '<html>partial' }));
  });
});
