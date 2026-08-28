jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ getBacklinks: jest.fn() }));
jest.mock('../services/notification-service', () => ({ create: jest.fn(async (o) => ({ id: 'n-1', ...o })) }));

const db = require('../models/db');
const dataforseo = require('../services/seo/dataforseo');
const NotificationService = require('../services/notification-service');
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
      whereNot: jest.fn((col, val) => { state.wheres.push(['NOT', col, val]); return b; }),
      whereRaw: jest.fn((sql, bind) => { state.raws.push([sql, bind]); return b; }),
      orWhereRaw: jest.fn((sql, bind) => { state.raws.push([sql, bind]); return b; }),
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
  miss_count: 0, is_dofollow: true, severity: 'clean', link_type: null, status: 'active', ...over,
});

function scanWith({ items = [], total = items.length, active = [], existingByUrl = {}, stillActiveDomain = false, owed = [], aged = [], alerted = [], recoveryRows = [] } = {}) {
  dataforseo.getBacklinks.mockResolvedValue({ tasks: [{ result: [{ items, total_count: total }] }] });
  const events = [], updates = [], increments = [], inserts = [], prospectOps = [];
  makeDb({
    seo_backlinks: (op, st) => {
      if (op === 'select') {
        if (st.raws.some(r => /lost_at <= now\(\)/.test(r[0]))) return aged; // aged-out sweep
        if (st.nulls.includes('recovery_queued_at')) return owed;
        // the ONE full-table load (no predicates): active rows + the lookup fixtures, by id
        if (!st.wheres.length && !st.raws.length && !st.nulls.length && !st.ins.length) {
          // lookup fixtures are keyed by their source URL; a fixture without a
          // target is assumed to point where the feed's first item points
          const fixtures = Object.entries(existingByUrl).map(([u, r]) => ({ source_url: u, target_url: items[0]?.url_to, ...r }));
          const byId = new Map();
          for (const r of active.concat(fixtures)) byId.set(r.id, byId.get(r.id) || r);
          return [...byId.values()];
        }
        return active;
      }
      if (op === 'first') {
        // domain-level "still active?" probe
        return stillActiveDomain ? { id: 'other' } : null;
      }
      if (op === 'update') { updates.push({ ids: st.wheres.find(w => w[0] === 'id')?.[1], patch: st.payload }); return 1; }
      if (op === 'increment') { increments.push({ ids: st.ins[0]?.[1] || st.wheres.find(w => w[0] === 'id')?.[1], ...st.payload }); return 1; }
      if (op === 'insert') { inserts.push(st.payload); return [1]; }
      throw new Error(`unexpected op ${op}`);
    },
    seo_backlink_events: (op, st) => {
      // the durable alert ledger read: rows already rung
      if (op === 'select') return alerted.map(id => ({ backlink_id: id }));
      events.push(st.payload); return [1];
    },
    seo_link_prospects: (op, st) => { prospectOps.push({ op, wheres: st.wheres, raws: st.raws, payload: st.payload }); return op === 'update' ? 1 : op === 'first' ? null : op === 'select' ? recoveryRows : []; },
  });
  return { events, updates, increments, inserts, prospectOps };
}

describe('BacklinkMonitor verified loss detection', () => {
  beforeEach(() => { db.mockReset(); dataforseo.getBacklinks.mockReset(); NotificationService.create.mockClear(); NotificationService.create.mockImplementation(async (o) => ({ id: 'n-1', ...o })); });

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

    // partial scan (API said 1500 but only 1000 came back on a short page) → no snapshot, and the result says so
    spy.mockClear();
    dataforseo.getBacklinks.mockResolvedValueOnce({ tasks: [{ result: [{ items: [], total_count: 1500 }] }] });
    const r = await BacklinkMonitor.scan({ exclusive, snapshot: true, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanComplete: false, snapshotOk: false, snapshotError: expect.stringMatching(/incomplete/) }));
    expect(spy).not.toHaveBeenCalled();

    // snapshot throws → surfaced, not swallowed as success
    spy.mockImplementation(async () => { throw new Error('snapshots table locked'); });
    scanWith({ items: [], total: 0, active: [] });
    const r2 = await BacklinkMonitor.scan({ exclusive, snapshot: true, crawlFn: jest.fn() });
    expect(r2).toEqual(expect.objectContaining({ scanComplete: true, snapshotOk: false, snapshotError: 'snapshots table locked' }));
    // without snapshot:true the keys are absent (admin/agent callers that don't ask)
    scanWith({ items: [], total: 0, active: [] });
    expect(await BacklinkMonitor.scan({ exclusive, crawlFn: jest.fn() })).not.toHaveProperty('snapshotOk');
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
    // 'lost' ledger row, then the durable alert stamp (bell row + 'loss_alerted' commit together)
    expect(events).toEqual([expect.objectContaining({ backlink_id: 'bl-1', event_type: 'lost' }), expect.objectContaining({ backlink_id: 'bl-1', event_type: 'loss_alerted' })]);
    expect(r).toEqual(expect.objectContaining({ lostCount: 1, lostDomains: 1, highValueLost: 1, alertedNew: 1, alerted: 1, recoveryQueued: 1 }));
    expect(recovery).toHaveBeenCalledWith([expect.objectContaining({ domain: 'blog.example', lost_reason: 'link_removed', domain_rating: 45, alertable: true })]);
    // recovery reported a terminal outcome → the row is stamped so it is not swept again
    expect(updates.find(u => u.patch.recovery_queued_at)).toBeUndefined(); // stamp goes through whereIn, captured below
  });

  test('losses older than 90 days age out EXPLICITLY for both obligations: recovery (stamp + recovery_aged_out) when unstamped, alert (loss_alert_skipped aged_out) when never ledgered — one transaction', async () => {
    const log = [];
    // old-a: neither obligation closed → both; old-b: recovery already stamped, bell never landed → alert only (no re-stamp)
    const { events } = scanWith({ items: [], total: 0, active: [], aged: [{ id: 'old-a', recovery_queued_at: null, alert_ledgered: false }, { id: 'old-b', recovery_queued_at: new Date('2026-05-01T00:00:00Z'), alert_ledgered: false }] });
    const origImpl = db.getMockImplementation();
    db.mockImplementation((table) => { const b = origImpl(table); const u = b.update; b.update = jest.fn((p) => { log.push({ table, ins: b.whereIn.mock.calls.map(c => c[1]).flat(), patch: p }); return u(p); }); return b; });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), now: new Date('2026-08-30T07:30:00Z') });
    const stamp = log.find(l => l.patch.recovery_queued_at);
    expect(stamp.ins).toEqual(['old-a']); // old-b keeps its original stamp
    expect(events).toEqual([
      expect.objectContaining({ backlink_id: 'old-a', event_type: 'recovery_aged_out', detail: JSON.stringify({ after_days: 90 }) }),
      expect.objectContaining({ backlink_id: 'old-a', event_type: 'loss_alert_skipped', detail: JSON.stringify({ reason: 'aged_out', after_days: 90 }) }),
      expect.objectContaining({ backlink_id: 'old-b', event_type: 'loss_alert_skipped', detail: JSON.stringify({ reason: 'aged_out', after_days: 90 }) }),
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('recovery stamping: terminal outcomes stamp recovery_queued_at; errors AND deferred (stale live board row) are left for the next scan', async () => {
    const crawl = jest.fn(async () => ({ found: false, status: 200 }));
    const outcomeFor = { 'flaky.example': 'error', 'stale.example': 'deferred' };
    const recovery = jest.fn(async (losses) => ({ queued: 0, results: losses.map(l => ({ domain: l.domain, outcome: outcomeFor[l.domain] || 'skipped' })) }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const log = [];
    const active = [
      activeRow({ miss_count: 1 }),
      activeRow({ id: 'bl-2', source_url: 'https://flaky.example/p', source_domain: 'flaky.example', miss_count: 1 }),
      activeRow({ id: 'bl-3', source_url: 'https://stale.example/p', source_domain: 'stale.example', miss_count: 1 }),
    ];
    const { increments } = scanWith({ items: [seen], active });
    // capture whereIn-based updates (stamps)
    const origImpl = db.getMockImplementation();
    db.mockImplementation((table) => { const b = origImpl(table); const u = b.update; b.update = jest.fn((p) => { log.push({ table, ins: b.whereIn.mock.calls.map(c => c[1]).flat(), patch: p }); return u(p); }); return b; });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl, recoveryFn: recovery, now: new Date('2026-08-30T07:30:00Z') });
    const stamps = log.filter(l => l.patch.recovery_queued_at);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].ins).toEqual(['bl-1']); // blog.example settled; flaky.example errored + stale.example deferred → not stamped
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
    scanWith({ items: [seen], active: [], owed, alerted: ['old-1'] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery });
    // owed-only sweep (retry after an earlier queue error): re-queued, NOT re-alerted — the ledger says the bell already rang for this row
    expect(r).toEqual(expect.objectContaining({ lostCount: 0, lostDomains: 1, highValueLost: 1, alertedNew: 0, recoveryQueued: 1 }));
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
    const existing = { id: 'bl-1', status: 'active', is_dofollow: true, source_url: seen.url_from, target_url: seen.url_to };
    const { updates, events } = scanWith({ items: [seen], active: [activeRow()], existingByUrl: { [seen.url_from]: existing } });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ relChanges: 1, lostCount: 0, missed: 0 }));
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'active', is_dofollow: false, miss_count: 0 }));
    expect(events).toEqual([expect.objectContaining({ event_type: 'rel_changed', detail: JSON.stringify({ from: 'dofollow', to: 'nofollow', source: 'dataforseo' }) })]);
  });

  test('a respelled report (https + trailing slash + utm) UPDATES the canonical row (moved to the new spelling) instead of inserting a twin', async () => {
    const seen = { url_from: 'https://www.blog.example/post/', url_to: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x', domain_from: 'www.blog.example', domain_from_rank: 45, dofollow: true };
    const existing = { id: 'bl-1', status: 'active', is_dofollow: true, source_url: 'http://blog.example/post', target_url: 'https://wavespestcontrol.com/pest-control-sarasota-fl/' };
    const { updates, events, inserts, increments } = scanWith({ items: [seen], active: [activeRow({ source_url: existing.source_url, target_url: existing.target_url })], existingByUrl: { [existing.source_url]: existing } });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanned: 1, respelled: 1, missed: 0, lostCount: 0 }));
    expect(inserts).toHaveLength(0);
    expect(increments).toEqual([]); // the old-spelling active row was SEEN under the canonical key — no miss
    expect(updates[0]).toEqual({ ids: 'bl-1', patch: expect.objectContaining({ source_url: seen.url_from, target_url: seen.url_to, status: 'active' }) });
    expect(events).toEqual([expect.objectContaining({ backlink_id: 'bl-1', event_type: 'respelled' })]);
  });

  test('the canonical map strips query/fragment BEFORE the trailing-slash strip: /page/?utm=x resolves to the /page row (update, not a second row)', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/page/?utm=x', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const row = activeRow({ id: 'pg', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/page' });
    const { updates, inserts, increments } = scanWith({ items: [seen], active: [row] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanned: 1, missed: 0, respelled: 1 }));
    expect(inserts).toHaveLength(0);
    expect(increments).toEqual([]);
    expect(updates).toContainEqual({ ids: 'pg', patch: expect.objectContaining({ target_url: seen.url_to, status: 'active' }) });
  });
  test('canonical identity lower-cases the HOST only: /Post and /post are different links (the other is missed)', async () => {
    const { canonicalLinkUrl } = require('../services/seo/link-prospect-verifier')._test;
    expect(canonicalLinkUrl('HTTPS://WWW.Blog.Example/Post/')).toBe('blog.example/Post');
    expect(canonicalLinkUrl('http://blog.example/post?a=B#f')).toBe('blog.example/post?a=B#f');
    const seen = { url_from: 'https://blog.example/Post', url_to: 'https://wavespestcontrol.com/', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const lower = activeRow({ id: 'lower', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/' });
    const { increments } = scanWith({ items: [seen], active: [lower] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ missed: 1 }));
    expect(increments).toEqual([expect.objectContaining({ ids: ['lower'] })]);
  });

  test('VERIFY_CAP takes the longest-waiting candidates first (miss_count desc, id tie-break) so the tail is never starved', async () => {
    const crawl = jest.fn(async () => ({ found: true, isDofollow: true, status: 200 }));
    // 302 twice-missed candidates; the two with the HIGHEST miss_count sit last in DB order
    const active = Array.from({ length: 302 }, (_, i) => activeRow({ id: `c${String(i).padStart(3, '0')}`, source_url: `https://d${i}.example/p`, source_domain: `d${i}.example`, miss_count: i >= 300 ? 5 : 1 }));
    const { increments } = scanWith({ items: [], total: 0, active });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl });
    expect(crawl).toHaveBeenCalledTimes(300);
    const crawled = new Set(crawl.mock.calls.map(c => c[0]));
    expect(crawled.has('https://d300.example/p')).toBe(true);
    expect(crawled.has('https://d301.example/p')).toBe(true);
    // the two carried rows are the lowest-priority ones (c298, c299 by id tie-break) and got a miss each
    expect(increments.find(i => Array.isArray(i.ids) && i.ids.length === 2).ids).toEqual(['c298', 'c299']);
  });

  test('two legacy rows under one canonical key: the reported row survives, the twin is retired as merged (ledgered) in the same transaction; neither is missed', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const a = activeRow({ id: 'a', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/' });
    const b = activeRow({ id: 'b', source_url: 'http://www.blog.example/post/', target_url: 'https://www.wavespestcontrol.com' });
    const { increments, updates, events } = scanWith({ items: [seen], active: [a, b], existingByUrl: { [a.source_url]: a } });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ missed: 0, merged: 1 }));
    expect(increments).toEqual([]);
    // survivor updated active; twin retired (not lost — no loss bell, no owed recovery) with a ledger row naming the survivor
    expect(updates).toContainEqual({ ids: 'a', patch: expect.objectContaining({ status: 'active', source_url: a.source_url }) });
    expect(updates).toContainEqual({ ids: 'b', patch: expect.objectContaining({ status: 'merged', miss_count: 0 }) });
    expect(updates.find(u => u.ids === 'b').patch.status).not.toBe('lost');
    expect(events).toContainEqual(expect.objectContaining({ backlink_id: 'b', event_type: 'merged', detail: JSON.stringify({ into: 'a', source_url: b.source_url, target_url: b.target_url }) }));
    expect(db.transaction).toHaveBeenCalledTimes(1); // survivor update + twin retirement = one transaction
  });

  test('a GSC-import twin (excluded from loss detection) is still retired as merged when its canonical identity is reported', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const a = activeRow({ id: 'a', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/' });
    const g = activeRow({ id: 'g', source_url: 'http://www.blog.example/post/', target_url: 'https://www.wavespestcontrol.com', discovery_source: 'gsc_links_export' });
    const { updates, events, increments } = scanWith({ items: [seen], active: [a, g] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ merged: 1, missed: 0 }));
    expect(increments).toEqual([]);
    expect(updates).toContainEqual({ ids: 'g', patch: expect.objectContaining({ status: 'merged' }) });
    expect(events).toContainEqual(expect.objectContaining({ backlink_id: 'g', event_type: 'merged' }));
  });

  test('domain representative: a clean editorial loss out-ranks a warning-severity sibling (same reason/DR) so the domain stays alertable', async () => {
    const warn = { id: 'w', source_url: 'https://blog.example/a', target_url: 'https://wavespestcontrol.com/', source_domain: 'blog.example', domain_rating: 45, severity: 'warning', link_type: 'editorial', lost_reason: 'link_removed' };
    const clean = { id: 'c', source_url: 'https://blog.example/b', target_url: 'https://wavespestcontrol.com/', source_domain: 'blog.example', domain_rating: 45, severity: 'clean', link_type: 'editorial', lost_reason: 'link_removed' };
    makeDb({ seo_backlinks: (op) => (op === 'first' ? null : []) });
    const out = await BacklinkMonitor.domainLevelLosses([warn, clean]); // warning row FIRST in table order
    expect(out).toEqual([expect.objectContaining({ domain: 'blog.example', backlink_id: 'c', alertable: true })]);
  });

  test('twin retirement rolls back with the survivor update: a failing ledger insert leaves the twin untouched', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const a = activeRow({ id: 'a', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/' });
    const b = activeRow({ id: 'b', source_url: 'http://www.blog.example/post/', target_url: 'https://www.wavespestcontrol.com' });
    scanWith({ items: [seen], active: [a, b], existingByUrl: { [a.source_url]: a } });
    const inner = db.transaction.getMockImplementation();
    db.transaction = jest.fn(async (fn) => { try { return await inner(fn); } catch (e) { throw e; } });
    const origImpl = db.getMockImplementation();
    db.mockImplementation((table) => { if (table === 'seo_backlink_events') throw new Error('ledger down'); return origImpl(table); });
    await expect(BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() })).rejects.toThrow('ledger down');
  });

  test('a lost row that reappears is recovered (lost_at/lost_reason cleared, event recorded) and its recovery prospect closed as live', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x', domain_from: 'www.blog.example', domain_from_rank: 45, dofollow: true };
    const existing = { id: 'bl-9', status: 'lost', is_dofollow: true, lost_reason: 'link_removed', source_url: seen.url_from, target_url: seen.url_to };
    const recoveryRows = [{ id: 'p-rec', target_page: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/' }];
    const { updates, events, prospectOps } = scanWith({ items: [seen], active: [], existingByUrl: { [seen.url_from]: existing }, recoveryRows });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ recovered: 1 }));
    expect(updates[0].patch).toEqual(expect.objectContaining({ status: 'active', lost_at: null, lost_reason: null, miss_count: 0 }));
    expect(events).toEqual([expect.objectContaining({ backlink_id: 'bl-9', event_type: 'recovered' })]);
    // the un-pitched lost_recovery prospect for this link is resolved, not left for the drafter
    const candidates = prospectOps.find(o => o.op === 'select');
    expect(candidates.wheres[0][0]).toEqual({ status: 'prospect' });
    expect(candidates.raws[0]).toEqual([expect.stringMatching(/target_domain/), ['blog.example']]);
    expect(candidates.raws.map(r => r[0]).join(' ')).toMatch(/lost_recovery/);
    const resolve = prospectOps.find(o => o.op === 'update');
    expect(resolve.wheres[0][0]).toEqual({ id: 'p-rec', status: 'prospect' });
    expect(resolve.payload).toEqual(expect.objectContaining({ status: 'live', live_url: 'https://blog.example/post', backlink_id: 'bl-9', outreach_status: 'none' }));
    // prospect closure and the lost→active flip share ONE transaction
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('if the backlink flip/ledger write fails after the prospect was closed, the whole recovery rolls back together', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/', domain_from: 'blog.example', domain_from_rank: 45, dofollow: true };
    const existing = { id: 'bl-9', status: 'lost', is_dofollow: true, lost_reason: 'link_removed' };
    const { prospectOps } = scanWith({ items: [seen], active: [], existingByUrl: { [seen.url_from]: existing }, recoveryRows: [{ id: 'p-rec', target_page: 'https://wavespestcontrol.com/' }] });
    const impl = db.getMockImplementation();
    db.mockImplementation((table) => { if (table === 'seo_backlink_events') throw new Error('ledger down'); return impl(table); });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ recovered: 0, unresolvedRecoveries: 1, scanned: 1 }));
    // the prospect update ran INSIDE the transaction that threw → rolled back with the flip, never committed alone
    expect(db.transaction).toHaveBeenCalledTimes(1);
    await expect(db.transaction.mock.results[0].value).rejects.toThrow('ledger down');
    expect(prospectOps.some(o => o.op === 'update')).toBe(true);
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
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return rows[st.raws.find(r => /target_domain/.test(r[0]))?.[1]?.[0]] || null; if (op === 'insert') { inserts.push(st.payload); return [1]; } } });
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
    // the prior attempt is APPENDED to quality_signals.prior_outreach_attempts (append-only) so every resend counts against the cap
    expect(updates[0].patch.outreach_attempted_at).toBeNull();
    expect(updates[0].patch.quality_signals.__raw).toMatch(/'\{prior_outreach_attempts\}', CASE WHEN jsonb_typeof\(.*'prior_outreach_attempts'\) = 'array' THEN .* ELSE '\[\]'::jsonb END \|\| COALESCE\(to_jsonb\(outreach_attempted_at\), '\[\]'::jsonb\)/);
    // compiles through knex with exactly one binding (lost_reason) — no stray '?' in the jsonb SQL
    const knex = require('knex')({ client: 'pg' });
    const compiled = knex('seo_link_prospects').update({ quality_signals: knex.raw(updates[0].patch.quality_signals.__raw, updates[0].patch.quality_signals.bind) }).toSQL().toNative();
    expect(compiled.bindings).toEqual(['link_removed']);
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
    expect(lastInsert.insert.mock.results[0].value.onConflict).toHaveBeenCalledWith(['target_domain', 'target_page', 'location_key']); // v2: the board key includes location_key
    expect(lastInsert.insert.mock.results[0].value.returning).toHaveBeenCalledWith('id');
    expect(r.reasons).toEqual([{ domain: 'race.example', reason: 'already on board (concurrent insert)' }]);
  });

  test('a throwing row does not abort the rest of the batch', async () => {
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') { if (st.raws.find(r => /target_domain/.test(r[0]))?.[1]?.[0] === 'boom.example') throw new Error('db down'); return null; } if (op === 'insert') return [1]; } });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'resource', gate: { ok: true, lane: 'outreach' } }]) };
    const r = await recovery.queueLostDomains([{ ...loss, domain: 'boom.example' }, { ...loss, domain: 'fine.example' }], { scorer });
    expect(r.queued).toBe(1);
    expect(r.reasons).toEqual([{ domain: 'boom.example', reason: 'error: db down' }]);
    expect(r.results.map(x => x.outcome)).toEqual(['error', 'queued']);
  });

  test('board lookups match target_domain by canonical host: www./URL/mixed-case spellings compile to one binding and one expression', () => {
    const { TARGET_DOMAIN_CANONICAL_SQL } = recovery._test;
    const knex = require('knex')({ client: 'pg' });
    const c = knex('seo_link_prospects').whereRaw(`${TARGET_DOMAIN_CANONICAL_SQL} = ?`, ['blog.example']).toSQL().toNative();
    expect(c.bindings).toEqual(['blog.example']);
    expect(c.sql).toMatch(/lower\(btrim\(target_domain\)\)/);
    expect(c.sql).toMatch(/\^\(www\|mail\)\\\./);
  });

  test('every board lookup in queueOne goes through the canonical target_domain expression (in-flight probe + exact-page)', async () => {
    const raws = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') raws.push(st.raws.find(r => /target_domain/.test(r[0]))); return null; } });
    await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn(async () => [null]) } }).catch(() => {});
    expect(raws.length).toBeGreaterThanOrEqual(2);
    for (const r of raws) expect(r).toEqual([expect.stringMatching(/split_part.*target_domain/), ['blog.example']]);
  });

  test('insert is atomic per domain: advisory lock + in-flight RE-CHECK under it catches a row filed during scoring (other page/spelling)', async () => {
    let probes = 0; const raws = [];
    makeDb({ seo_link_prospects: (op, st) => {
      if (op === 'first' && st.ins.some(i => i[0] === 'status')) { probes++; return probes === 1 ? null : { id: 'p-race', status: 'contacted', target_page: 'https://www.wavespestcontrol.com/other/' }; }
      if (op === 'first') return null;
      if (op === 'insert') throw new Error('must not insert — the re-check under the lock found the racing row');
      return null;
    } });
    db.raw = jest.fn((sql, bind) => { raws.push([sql, bind]); return { __raw: sql, bind }; });
    const scorer = { scoreCandidates: jest.fn(async () => [{ intent_class: 'resource', gate: { ok: true, lane: 'outreach' }, contact: { contact_email: 'ed@blog.example' } }]) };
    const r = await recovery.queueLostDomains([loss], { scorer });
    expect(r).toEqual(expect.objectContaining({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'already on board (concurrent contacted for /other/)' }] }));
    expect(probes).toBe(2); // pre-scoring probe + re-check under the lock
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(raws).toContainEqual(['SELECT pg_advisory_xact_lock(hashtext(?))', ['lost_recovery:blog.example']]);
  });

  test('a domain with an in-flight row for ANOTHER Waves page is not queued again (no parallel outreach to one inbox)', async () => {
    const ops = [];
    makeDb({ seo_link_prospects: (op, st) => {
      ops.push({ op, ins: st.ins });
      // domain-wide in-flight probe (whereIn status) → a contacted row on a sibling page
      if (op === 'first' && st.ins.some(i => i[0] === 'status')) return { id: 'p-sib', status: 'contacted', target_page: 'https://www.wavespestcontrol.com/other/' };
      if (op === 'first') throw new Error('exact-page lookup must not run once the domain is in flight');
      if (op === 'insert') throw new Error('must not insert');
      return null;
    } });
    const r = await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn() } });
    expect(r).toEqual({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'already on board (contacted for /other/)' }], results: [{ domain: 'blog.example', backlink_id: 'bl-1', outcome: 'skipped' }] });
    expect(ops[0].ins[0]).toEqual(['status', expect.arrayContaining(['prospect', 'contacted', 'negotiating', 'placed', 'live', 'indexed'])]);
  });

  test('a STALE live/indexed board row (verifier has not demoted it yet) defers recovery instead of terminally skipping it', async () => {
    makeDb({ seo_link_prospects: (op, st) => {
      if (op === 'first' && st.ins.some(i => i[0] === 'status')) return { id: 'p-live', status: 'live', target_page: 'https://www.wavespestcontrol.com/x/' };
      if (op === 'insert') throw new Error('must not insert');
      return null;
    } });
    const r = await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn() } });
    expect(r.results).toEqual([{ domain: 'blog.example', backlink_id: 'bl-1', outcome: 'deferred' }]); // NOT 'skipped' → monitor leaves recovery_queued_at null
    expect(r.reasons[0].reason).toMatch(/still live for \/x\/ — deferred/);
  });

  test('a lost signup-lane placement (citation) is not reopened into the outreach board', async () => {
    const updates = [];
    makeDb({ seo_link_prospects: (op, st) => { if (op === 'first') return { id: 'p-cit', status: 'lost', notes: null, link_type: 'citation' }; if (op === 'update') { updates.push(st.payload); return 1; } if (op === 'insert') throw new Error('must not insert'); } });
    const r = await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn() } });
    expect(r).toEqual({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'lost citation placement — signup lane, not reopened' }], results: [{ domain: 'blog.example', backlink_id: 'bl-1', outcome: 'skipped' }] });
    expect(updates).toHaveLength(0);
  });

  test('resolveRecoveredLink closes un-pitched recovery prospects at DOMAIN scope; the row filed under a sibling page FOLLOWS the returned link (target_page moved) so the verifier will not demote it', async () => {
    const ops = [];
    // two candidate rows: one already on /x/ (same page), one filed under the sibling /y/ whose (domain,/x/) pair is FREE
    makeDb({ seo_link_prospects: (op, st) => {
      ops.push({ op, wheres: st.wheres, ins: st.ins, nulls: st.nulls, raws: st.raws, payload: st.payload });
      if (op === 'select') return [{ id: 'p-same', target_page: 'https://www.wavespestcontrol.com/x/' }, { id: 'p-sib', target_page: 'https://www.wavespestcontrol.com/y/' }];
      if (op === 'first') return null; // no other row owns (domain, /x/)
      return 1;
    } });
    const r = await recovery.resolveRecoveredLink({ id: 'bl-1', source_url: 'https://blog.example/post', source_domain: 'www.blog.example', target_url: 'https://wavespestcontrol.com/x/?u=1' }, new Date('2026-09-06T08:00:00Z'));
    expect(r).toEqual({ resolved: 2, superseded: 0, pending: 0 });
    const sel = ops[0];
    expect(sel.op).toBe('select');
    expect(sel.wheres[0][0]).toEqual({ status: 'prospect' });
    expect(sel.raws[0]).toEqual([expect.stringMatching(/^split_part\(split_part\(.*lower\(btrim\(target_domain\)\).*'\/', 1\), ':', 1\) = \?$/), ['blog.example']]); // canonical host, never the raw spelling
    expect(sel.ins).toEqual([]); // no target_page predicate — domain scope, same as the queue side
    expect(sel.raws.map(r => r[0]).join(' ')).toMatch(/lost_recovery/); // still only recovery rows, never a cold prospect
    // only unsent rows: none/drafted and outreach_sent_at IS NULL — sending/sent are left for reconciliation
    expect(sel.raws.map(r => r[0]).join(' ')).toMatch(/outreach_status.*'none', 'drafted'/);
    expect(sel.nulls).toContain('outreach_sent_at');
    const updates = ops.filter(o => o.op === 'update');
    expect(updates).toHaveLength(2);
    const same = updates.find(u => u.wheres[0][0].id === 'p-same'), sib = updates.find(u => u.wheres[0][0].id === 'p-sib');
    expect(same.wheres[0][0]).toEqual({ id: 'p-same', status: 'prospect' }); // conditional per row
    // …and the unsent guards are repeated ATOMICALLY on every write (a send may have started since the read)
    for (const u of updates) {
      expect(u.raws.map(r => r[0]).join(' ')).toMatch(/outreach_status.*'none', 'drafted'/);
      expect(u.nulls).toContain('outreach_sent_at');
    }
    expect(same.payload).toEqual(expect.objectContaining({ status: 'live', backlink_id: 'bl-1' }));
    expect(same.payload.target_page).toBeUndefined(); // same page: identity untouched
    expect(same.payload.first_live_at.__raw).toBe('COALESCE(first_live_at, ?)'); // original first-live history preserved
    expect(same.payload.notes.bind[0]).toMatch(/closed 2026-09-06:/); // 08:00Z = 04:00 ET → same ET day; ET date, not UTC
    // sibling row: moved to the returned page so live_url validates against target_page on the daily verify
    expect(sib.payload).toEqual(expect.objectContaining({ status: 'live', target_page: 'https://www.wavespestcontrol.com/x/', live_url: 'https://blog.example/post' }));
    expect(sib.payload.notes.bind[0]).toMatch(/Target page moved https:\/\/www\.wavespestcontrol\.com\/y\/ → https:\/\/www\.wavespestcontrol\.com\/x\//);
    // the (domain, returned page) ownership probe ran for the sibling only, excluding itself
    const probe = ops.find(o => o.op === 'first');
    expect(probe.ins).toEqual([['target_page', expect.arrayContaining(['https://www.wavespestcontrol.com/x/', 'https://wavespestcontrol.com/x/'])]]);
  });

  test('resolveRecoveredLink: when another board row already owns (domain, returned page), the sibling recovery row is closed as SUPERSEDED (rejected + note), never left live under a wrong target', async () => {
    const ops = [];
    makeDb({ seo_link_prospects: (op, st) => {
      ops.push({ op, wheres: st.wheres, raws: st.raws, nulls: st.nulls, payload: st.payload });
      if (op === 'select') return [{ id: 'p-sib', target_page: 'https://www.wavespestcontrol.com/y/' }];
      if (op === 'first') return { id: 'p-owner', status: 'live' };
      return 1;
    } });
    const r = await recovery.resolveRecoveredLink({ id: 'bl-1', source_url: 'https://blog.example/post', source_domain: 'blog.example', target_url: 'https://wavespestcontrol.com/x/' }, new Date('2026-09-06T08:00:00Z'));
    expect(r).toEqual({ resolved: 0, superseded: 1, pending: 0 });
    const upd = ops.find(o => o.op === 'update');
    expect(upd.wheres[0][0]).toEqual({ id: 'p-sib', status: 'prospect' });
    expect(upd.raws.map(r => r[0]).join(' ')).toMatch(/outreach_status.*'none', 'drafted'/);
    expect(upd.nulls).toContain('outreach_sent_at');
    expect(upd.payload).toEqual(expect.objectContaining({ status: 'rejected', backlink_id: 'bl-1', outreach_status: 'none', outreach_send_token: null }));
    expect(upd.payload.target_page).toBeUndefined();
    expect(upd.payload.notes.bind[0]).toMatch(/tracked by prospect p-owner \(live\); this recovery row is superseded/);
  });

  test('resolveRecoveredLink: a row whose send started after the candidate read (0-row guarded update) is left pending for reconciliation, never clobbered', async () => {
    makeDb({ seo_link_prospects: (op) => {
      if (op === 'select') return [{ id: 'p-sending', target_page: 'https://www.wavespestcontrol.com/x/' }];
      if (op === 'first') return null;
      return 0; // the guarded UPDATE matched nothing: outreach_status flipped to 'sending' meanwhile
    } });
    const r = await recovery.resolveRecoveredLink({ id: 'bl-1', source_url: 'https://blog.example/post', source_domain: 'blog.example', target_url: 'https://wavespestcontrol.com/x/' }, new Date('2026-09-06T08:00:00Z'));
    expect(r).toEqual({ resolved: 0, superseded: 0, pending: 1 });
  });

  test('a retired twin\'s spelling reported later resolves to the SURVIVOR — the merged row is never a lookup target and never resurrected', async () => {
    const a = activeRow({ id: 'a', source_url: 'https://blog.example/post', target_url: 'https://wavespestcontrol.com/' });
    const b = activeRow({ id: 'b', source_url: 'http://www.blog.example/post/', target_url: 'https://www.wavespestcontrol.com' });
    // feed reports the canonical spelling first (retires b), then b's old spelling
    const items = [
      { url_from: a.source_url, url_to: a.target_url, domain_from: 'blog.example', domain_from_rank: 45, dofollow: true },
      { url_from: b.source_url, url_to: b.target_url, domain_from: 'blog.example', domain_from_rank: 45, dofollow: true },
    ];
    const { updates } = scanWith({ items, active: [a, b] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanned: 2, merged: 1, missed: 0 }));
    const bUpdates = updates.filter(u => u.ids === 'b');
    expect(bUpdates).toHaveLength(1);
    expect(bUpdates[0].patch.status).toBe('merged'); // never flipped back to active
    // the second report moved the SURVIVOR to b's spelling instead
    expect(updates.filter(u => u.ids === 'a').map(u => u.patch.status)).toEqual(['active', 'active']);
    expect(updates.filter(u => u.ids === 'a')[1].patch.source_url).toBe(b.source_url);

    // and a merged row already in the table on load is not a lookup target either
    const { updates: u2, inserts } = scanWith({ items: [items[1]], active: [a, { ...b, status: 'merged' }] });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(inserts).toHaveLength(0);
    expect(u2.filter(u => u.ids === 'b')).toHaveLength(0);
    expect(u2.find(u => u.ids === 'a').patch).toEqual(expect.objectContaining({ status: 'active', source_url: b.source_url }));
  });

  test('the owed sweep brings back rows whose recovery settled but whose bell never rang (ledger NOT EXISTS), and settled non-alertable domains get loss_alert_skipped so they never re-enter', async () => {
    const recovery = jest.fn(async (losses) => ({ queued: losses.length, results: losses.map(l => ({ domain: l.domain, outcome: 'queued' })) }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const raws = [];
    scanWith({ items: [seen], active: [], owed: [] });
    const impl = db.getMockImplementation();
    db.mockImplementation((table) => { const b = impl(table); if (table === 'seo_backlinks') { const o = b.orWhereRaw; b.orWhereRaw = (sql, bind) => { raws.push(sql); return o(sql, bind); }; } return b; });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery });
    // episode-scoped: only ledger rows at/after the row's CURRENT lost_at count (an alert from an earlier, recovered loss does not)
    expect(raws.join(' ')).toMatch(/NOT EXISTS \(SELECT 1 FROM seo_backlink_events e WHERE e\.backlink_id = seo_backlinks\.id AND e\.event_type IN \('loss_alerted', 'loss_alert_skipped'\) AND e\.created_at >= COALESCE\(seo_backlinks\.lost_at, e\.created_at\)\)/);

    // a low-DR (not alertable) verified loss: settled → recovery stamp + loss_alert_skipped in one transaction
    const crawl = jest.fn(async () => ({ found: false, status: 200 }));
    const { events, updates } = scanWith({ items: [seen], active: [activeRow({ id: 'lowdr', miss_count: 1, domain_rating: 5 })] });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: crawl, recoveryFn: recovery });
    expect(r).toEqual(expect.objectContaining({ lostCount: 1, highValueLost: 0, alertedNew: 0 }));
    expect(events).toContainEqual(expect.objectContaining({ backlink_id: 'lowdr', event_type: 'loss_alert_skipped' }));
    expect(updates.some(u => u.patch && u.patch.recovery_queued_at)).toBe(true);
  });

  test('loss alert is DURABLE: an owed row with no loss_alerted ledger row rings (even though nothing was newly lost this scan); the admin bell row and the ledger stamps commit together, the SMS copy goes out after commit', async () => {
    const recovery = jest.fn(async (losses) => ({ queued: losses.length, results: losses.map(l => ({ domain: l.domain, outcome: 'queued' })) }));
    const seen = { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true };
    const owed = [{ id: 'old-1', source_url: 'https://old.example/res', target_url: 'https://wavespestcontrol.com/', source_domain: 'old.example', domain_rating: 60, anchor_text: null, severity: 'clean', link_type: null, lost_reason: 'page_gone' }];
    const { events } = scanWith({ items: [seen], active: [], owed, alerted: [] });
    const order = [];
    NotificationService.create.mockImplementation(async (o) => { order.push('bell'); return { id: 'n-1', ...o }; });
    const alertFn = jest.fn(async () => { order.push('sms'); });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery, alertFn });
    expect(r).toEqual(expect.objectContaining({ lostCount: 0, alertedNew: 1, alerted: 1 }));
    const msg = expect.stringMatching(/1 referring domain\(s\) lost — verified by crawl: old\.example DR60 \(page_gone\)/);
    expect(NotificationService.create).toHaveBeenCalledWith(expect.objectContaining({ recipientType: 'admin', category: 'system', bell: true, body: msg, link: '/admin/seo', connection: db, metadata: expect.objectContaining({ lane: 'backlink_loss', domains: ['old.example'], backlinkIds: ['old-1'] }) }));
    expect(alertFn).toHaveBeenCalledWith(msg);
    expect(events).toContainEqual(expect.objectContaining({ backlink_id: 'old-1', event_type: 'loss_alerted', detail: JSON.stringify({ domains: 1, notification_id: 'n-1' }) }));
    expect(order).toEqual(['bell', 'sms']); // bell + stamps committed BEFORE the SMS copy

    // the "already rung?" ledger read is scoped to the current loss episode (created_at >= the row's lost_at)
    const ledgerRaws = [];
    scanWith({ items: [seen], active: [], owed, alerted: [] });
    const impl0 = db.getMockImplementation();
    db.mockImplementation((table) => { const b = impl0(table); if (table === 'seo_backlink_events') { const w = b.whereRaw; b.whereRaw = (sql, bind) => { ledgerRaws.push(sql); return w(sql, bind); }; } return b; });
    await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery, alertFn: jest.fn(async () => {}) });
    expect(ledgerRaws.join(' ')).toMatch(/seo_backlink_events\.created_at >= COALESCE\(\(SELECT b\.lost_at FROM seo_backlinks b WHERE b\.id = seo_backlink_events\.backlink_id\), seo_backlink_events\.created_at\)/);

    // a failed SMS copy is logged by code only; the bell is the record, rows stay stamped (no re-ring next week)
    const { events: events2 } = scanWith({ items: [seen], active: [], owed, alerted: [] });
    const r2 = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery, alertFn: jest.fn(async () => { const e = new Error('Twilio: +19415550100 unreachable'); e.code = 21211; throw e; }) });
    expect(r2).toEqual(expect.objectContaining({ alertedNew: 1, alerted: 1 }));
    expect(events2).toContainEqual(expect.objectContaining({ backlink_id: 'old-1', event_type: 'loss_alerted' }));
    const logger = require('../services/logger');
    const warn = logger.warn.mock.calls.map(c => c[0]).find(m => /loss alert SMS copy failed/.test(m));
    expect(warn).toMatch(/code=21211/);
    expect(warn).not.toMatch(/\+1941/); // never the phone number

    // a bell-policy SUPPRESSION sentinel ({ suppressed }) is not a delivered alert: nothing stamped, nothing sent
    NotificationService.create.mockImplementation(async () => ({ id: null, suppressed: true }));
    const { events: events4 } = scanWith({ items: [seen], active: [], owed, alerted: [] });
    const sms4 = jest.fn(async () => {});
    const r4 = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery, alertFn: sms4 });
    expect(r4).toEqual(expect.objectContaining({ alertedNew: 1, alerted: 0 }));
    expect(events4.find(e => e && e.event_type === 'loss_alerted')).toBeUndefined();
    expect(sms4).not.toHaveBeenCalled();

    // a failed bell insert stamps NOTHING and sends nothing — the next scan rings
    NotificationService.create.mockImplementation(async () => null);
    const { events: events3 } = scanWith({ items: [seen], active: [], owed, alerted: [] });
    const sms3 = jest.fn(async () => {});
    const r3 = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn(), recoveryFn: recovery, alertFn: sms3 });
    expect(r3).toEqual(expect.objectContaining({ alertedNew: 1, alerted: 0 }));
    expect(events3.find(e => e && e.event_type === 'loss_alerted')).toBeUndefined();
    expect(sms3).not.toHaveBeenCalled();
  });

  test('a DataForSEO item is resolved from the in-memory canonical map — no per-item lookup query against seo_backlinks', async () => {
    const seen = { url_from: 'https://blog.example/post', url_to: 'https://wavespestcontrol.com/pest-control-sarasota-fl/?utm=x', domain_from: 'www.blog.example', domain_from_rank: 45, dofollow: true };
    const log = [];
    const orig = db.getMockImplementation;
    scanWith({ items: [seen, { ...seen, url_from: 'http://www.blog.example/post/' }], active: [activeRow()] });
    const impl = db.getMockImplementation();
    db.mockImplementation((table) => { const b = impl(table); if (table === 'seo_backlinks') { const f = b.first; b.first = (...a) => { log.push('first'); return f(...a); }; const s = b.select; b.select = (...a) => { log.push('select'); return s(...a); }; } return b; });
    const r = await BacklinkMonitor.scan({ exclusive: passthrough, crawlFn: jest.fn() });
    expect(r).toEqual(expect.objectContaining({ scanned: 2, missed: 0 }));
    // one full-table select (+ the owed/aged sweeps); the per-item lookups never hit .first()
    expect(log.filter(x => x === 'first')).toEqual([]);
    expect(log.filter(x => x === 'select').length).toBeLessThanOrEqual(3);
    void orig;
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

  test('reopen runs under the shared domain lock and repeats the domain-wide in-flight probe: a row filed concurrently for another page wins, the lost row is NOT reopened', async () => {
    let probes = 0; const raws = []; const updates = [];
    makeDb({ seo_link_prospects: (op, st) => {
      if (op === 'first' && st.ins.some(i => i[0] === 'status')) { probes++; return probes === 1 ? null : { id: 'p-new', status: 'prospect', target_page: 'https://www.wavespestcontrol.com/other/' }; }
      if (op === 'first') return { id: 'p-lost', status: 'lost', notes: null, link_type: 'resource' };
      if (op === 'update') { updates.push(st); return 1; }
      return null;
    } });
    db.raw = jest.fn((sql, bind) => { raws.push([sql, bind]); return { __raw: sql, bind }; });
    const r = await recovery.queueLostDomains([loss], { scorer: { scoreCandidates: jest.fn() } });
    expect(r).toEqual(expect.objectContaining({ queued: 0, skipped: 1, reasons: [{ domain: 'blog.example', reason: 'already on board (concurrent prospect for /other/)' }] }));
    expect(updates).toEqual([]); // nothing reopened
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(raws).toContainEqual(['SELECT pg_advisory_xact_lock(hashtext(?))', ['lost_recovery:blog.example']]);
    expect(probes).toBe(2);
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
