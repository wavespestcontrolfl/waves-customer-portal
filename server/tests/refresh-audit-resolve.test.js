jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const RefreshAudit = require('../services/seo/refresh-audit');

// Capture the predicates each query builds so the domain-scoping can be
// asserted, and hand back a scripted result set per call.
function scriptDb(resultsPerCall) {
  const calls = [];
  let call = 0;
  db.mockImplementation((table) => {
    const rec = { table, where: [], whereRaw: [], whereNull: [], whereNotNull: [] };
    calls.push(rec);
    const rows = resultsPerCall[call] || [];
    call += 1;
    const q = {
      where: (...a) => { rec.where.push(a); return q; },
      whereRaw: (sql, binds) => { rec.whereRaw.push([sql, binds]); return q; },
      whereNull: (c) => { rec.whereNull.push(c); return q; },
      whereNotNull: (c) => { rec.whereNotNull.push(c); return q; },
      modify: (fn) => { fn(q); return q; },
      select: () => q,
      limit: () => Promise.resolve(rows),
    };
    return q;
  });
  return calls;
}

beforeEach(() => { db.mockReset(); });

// enqueueRefresh returns early on the in-flight check, so this only needs
// blog_posts + opportunity_queue. Exercises the REAL key construction rather
// than a mocked enqueue — the gap codex flagged on the previous round.
function enqueueDbWithInflight(inflightRow) {
  db.mockImplementation((table) => {
    if (table === 'blog_posts') {
      return { where: () => ({ first: async () => ({
        id: 42, slug: 'bed-bugs-bradenton', status: 'published', tag: 'Bed Bugs',
        astro_live_url: 'https://www.wavespestcontrol.com/bed-bugs-bradenton/',
      }) }) };
    }
    const q = {
      whereIn: () => q, where: () => q, whereRaw: () => q,
      first: async () => inflightRow,
    };
    return q;
  });
}

describe('enqueueRefresh — recognising its own queue row', () => {
  test('an in-flight row under THIS cycle key reports own:true', async () => {
    const expectedKey = 'refresh-audit:wavespestcontrol.com:bed-bugs-bradenton:reg-imp-1';
    enqueueDbWithInflight({ status: 'claimed', page_url: 'https://x/', dedupe_key: expectedKey });

    const out = await RefreshAudit.enqueueRefresh({ blogPostId: 42, cycleKey: 'reg-imp-1' });
    expect(out).toMatchObject({ queued: false, own: true, status: 'claimed' });
  });

  test('a FOREIGN page edit under another key reports own:false', async () => {
    enqueueDbWithInflight({ status: 'claimed', page_url: 'https://x/', dedupe_key: 'gsc-miner:something-else' });

    const out = await RefreshAudit.enqueueRefresh({ blogPostId: 42, cycleKey: 'reg-imp-1' });
    expect(out).toMatchObject({ queued: false, own: false });
  });

  test('a different cycle of the same page is NOT own', async () => {
    enqueueDbWithInflight({
      status: 'done', page_url: 'https://x/',
      dedupe_key: 'refresh-audit:wavespestcontrol.com:bed-bugs-bradenton:reg-imp-OTHER',
    });

    const out = await RefreshAudit.enqueueRefresh({ blogPostId: 42, cycleKey: 'reg-imp-1' });
    expect(out.own).toBe(false);
  });
});

describe('resolvePostByUrl', () => {
  test('returns the single published post whose LIVE URL matches path + domain', async () => {
    const calls = scriptDb([[{ id: 7, slug: 'bed-bugs-bradenton' }]]);
    const post = await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/bed-bugs-bradenton/?utm_source=x');

    expect(post).toMatchObject({ id: 7 });
    expect(calls[0].table).toBe('blog_posts');
    expect(calls[0].where).toContainEqual(['status', 'published']);
    // Both the path AND the registrable domain must be bound — a path-only
    // match would cross hub/spoke sites that share the same path.
    const binds = calls[0].whereRaw.map(([, b]) => b[0]);
    expect(binds).toContain('/bed-bugs-bradenton');
    expect(binds).toContain('wavespestcontrol.com');
  });

  test('FAILS CLOSED on an ambiguous live match rather than guessing a domain', async () => {
    scriptDb([[{ id: 7 }, { id: 8 }]]);
    expect(await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/a/')).toBeNull();
  });

  test('falls back to a domain-scoped slug match when no live URL is recorded', async () => {
    const calls = scriptDb([[], [{ id: 9, slug: 'lawn-care-venice' }]]);
    const post = await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/lawn-care-venice/');

    expect(post).toMatchObject({ id: 9 });
    expect(calls[1].whereNull).toContain('astro_live_url');
    expect(calls[1].whereRaw.map(([, b]) => b).flat()).toContain('wavespestcontrol.com');
  });

  test('FAILS CLOSED on an ambiguous slug fallback', async () => {
    scriptDb([[], [{ id: 9 }, { id: 10 }]]);
    expect(await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/a/')).toBeNull();
  });

  test('null when nothing matches', async () => {
    scriptDb([[], []]);
    expect(await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/nope/')).toBeNull();
  });

  test('null (no query) on unusable input', async () => {
    scriptDb([]);
    expect(await RefreshAudit.resolvePostByUrl(null)).toBeNull();
    expect(await RefreshAudit.resolvePostByUrl('')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a temporarily DRAFT post still resolves — publication state is enqueueRefresh\'s call', async () => {
    // Both published passes miss, then the any-status pass finds it. Filtering
    // drafts out here would make them look like a URL with no blog_posts row,
    // and the caller parks those permanently — so republishing would never
    // revive the regression.
    const calls = scriptDb([[], [], [{ id: 12, status: 'draft' }]]);
    const post = await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/being-edited/');

    expect(post).toMatchObject({ id: 12, status: 'draft' });
    // The first pass constrains on published; the recovering pass does not.
    expect(calls[0].where).toContainEqual(['status', 'published']);
    expect(calls[2].where).not.toContainEqual(['status', 'published']);
  });

  test('a PUBLISHED match wins over a same-path draft', async () => {
    scriptDb([[{ id: 7, status: 'published' }], [{ id: 99, status: 'draft' }]]);
    const post = await RefreshAudit.resolvePostByUrl('https://www.wavespestcontrol.com/a/');
    expect(post).toMatchObject({ id: 7 });
  });

  test('a spoke URL is scoped to the spoke domain, never the hub', async () => {
    const calls = scriptDb([[{ id: 11 }]]);
    await RefreshAudit.resolvePostByUrl('https://parrishexterminator.com/bed-bugs-bradenton/');
    const binds = calls[0].whereRaw.map(([, b]) => b[0]);
    expect(binds).toContain('parrishexterminator.com');
    expect(binds).not.toContain('wavespestcontrol.com');
  });
});
