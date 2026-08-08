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
      select: () => q,
      limit: () => Promise.resolve(rows),
    };
    return q;
  });
  return calls;
}

beforeEach(() => { db.mockReset(); });

describe('resolvePublishedPostByUrl', () => {
  test('returns the single published post whose LIVE URL matches path + domain', async () => {
    const calls = scriptDb([[{ id: 7, slug: 'bed-bugs-bradenton' }]]);
    const post = await RefreshAudit.resolvePublishedPostByUrl('https://www.wavespestcontrol.com/bed-bugs-bradenton/?utm_source=x');

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
    expect(await RefreshAudit.resolvePublishedPostByUrl('https://www.wavespestcontrol.com/a/')).toBeNull();
  });

  test('falls back to a domain-scoped slug match when no live URL is recorded', async () => {
    const calls = scriptDb([[], [{ id: 9, slug: 'lawn-care-venice' }]]);
    const post = await RefreshAudit.resolvePublishedPostByUrl('https://www.wavespestcontrol.com/lawn-care-venice/');

    expect(post).toMatchObject({ id: 9 });
    expect(calls[1].whereNull).toContain('astro_live_url');
    expect(calls[1].whereRaw.map(([, b]) => b).flat()).toContain('wavespestcontrol.com');
  });

  test('FAILS CLOSED on an ambiguous slug fallback', async () => {
    scriptDb([[], [{ id: 9 }, { id: 10 }]]);
    expect(await RefreshAudit.resolvePublishedPostByUrl('https://www.wavespestcontrol.com/a/')).toBeNull();
  });

  test('null when nothing matches', async () => {
    scriptDb([[], []]);
    expect(await RefreshAudit.resolvePublishedPostByUrl('https://www.wavespestcontrol.com/nope/')).toBeNull();
  });

  test('null (no query) on unusable input', async () => {
    scriptDb([]);
    expect(await RefreshAudit.resolvePublishedPostByUrl(null)).toBeNull();
    expect(await RefreshAudit.resolvePublishedPostByUrl('')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a spoke URL is scoped to the spoke domain, never the hub', async () => {
    const calls = scriptDb([[{ id: 11 }]]);
    await RefreshAudit.resolvePublishedPostByUrl('https://parrishexterminator.com/bed-bugs-bradenton/');
    const binds = calls[0].whereRaw.map(([, b]) => b[0]);
    expect(binds).toContain('parrishexterminator.com');
    expect(binds).not.toContain('wavespestcontrol.com');
  });
});
