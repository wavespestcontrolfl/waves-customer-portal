/**
 * og:image backfill: extraction rules, SSRF-transport reuse, fill-only
 * update guard, weekly-backoff selection, kill switch. Transport and knex
 * are injected — no network, no db.
 */

const {
  backfillEnabled,
  backfillBatch,
  extractImageUrl,
  fetchPage,
} = require('../services/event-image-backfill');

afterEach(() => { delete process.env.NEWSLETTER_IMAGE_BACKFILL; });

const PAGE = 'https://venue.example/show';

describe('extractImageUrl', () => {
  test('og:image wins in either attribute order; twitter:image is the fallback', () => {
    expect(extractImageUrl('<meta property="og:image" content="https://cdn.example/a.jpg">', PAGE))
      .toBe('https://cdn.example/a.jpg');
    expect(extractImageUrl('<meta content="https://cdn.example/b.jpg" property="og:image">', PAGE))
      .toBe('https://cdn.example/b.jpg');
    expect(extractImageUrl('<meta name="twitter:image" content="https://cdn.example/c.jpg">', PAGE))
      .toBe('https://cdn.example/c.jpg');
    expect(extractImageUrl('<p>no meta at all</p>', PAGE)).toBeNull();
  });

  test('relative urls resolve against the page; non-http and oversized urls are skipped', () => {
    expect(extractImageUrl('<meta property="og:image" content="/img/poster.jpg">', PAGE))
      .toBe('https://venue.example/img/poster.jpg');
    expect(extractImageUrl('<meta property="og:image" content="data:image/png;base64,xxxx">', PAGE))
      .toBeNull();
    const huge = `https://cdn.example/${'x'.repeat(1100)}.jpg`;
    expect(extractImageUrl(`<meta property="og:image" content="${huge}">`, PAGE)).toBeNull();
  });

  test('walks the whole og:image array — a GIF/malformed first entry does not hide a valid later image', () => {
    const html = [
      '<meta property="og:image" content="https://cdn.example/anim.gif">',
      '<meta property="og:image" content="https://cdn.example/poster.jpg">',
    ].join('\n');
    expect(extractImageUrl(html, PAGE)).toBe('https://cdn.example/poster.jpg');
  });

  test('GIF-shaped urls are rejected — the thumbnail contract is still event art', () => {
    expect(extractImageUrl('<meta property="og:image" content="https://cdn.example/loop.gif">', PAGE))
      .toBeNull();
    expect(extractImageUrl('<meta property="og:image" content="https://media2.giphy.com/media/x/200.webp">', PAGE))
      .toBeNull();
  });
});

// DNS stub resolving every host to a public address (reverify pattern).
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const mockGet = (status, text = '', location = null) => jest.fn(async () => ({ status, text, location }));

describe('fetchPage', () => {
  test('follows redirects with per-hop re-vetting and returns the final body', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ status: 301, location: 'https://venue.example/moved' })
      .mockResolvedValueOnce({ status: 200, text: '<html>ok</html>' });
    const page = await fetchPage(PAGE, { lookup: publicLookup, get });
    expect(page.text).toBe('<html>ok</html>');
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('SSRF refusal and non-2xx both yield null (no image, never an error)', async () => {
    const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await fetchPage(PAGE, { lookup: privateLookup, get: mockGet(200, 'x') })).toBeNull();
    expect(await fetchPage(PAGE, { lookup: publicLookup, get: mockGet(404) })).toBeNull();
  });
});

// Minimal chainable knex stub: every filter method returns the chain;
// `limit` resolves the seeded rows; `update` records its guard state.
function knexStub(rows) {
  const updates = [];
  const knex = () => {
    const chain = {
      _wheres: [],
      _nullGuards: [],
      select: () => chain,
      whereNull: (col) => { chain._nullGuards.push(col); return chain; },
      whereNotNull: () => chain,
      whereIn: () => chain,
      where: (arg) => { if (arg && typeof arg === 'object' && arg.id) chain._wheres.push(arg.id); return chain; },
      orderByRaw: () => chain,
      limit: async () => rows,
      update: async (patch) => { updates.push({ id: chain._wheres[0], nullGuards: [...chain._nullGuards], patch }); return 1; },
    };
    return chain;
  };
  knex.updates = updates;
  return knex;
}

describe('backfillBatch', () => {
  const ROW = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Expo', event_url: PAGE };

  test('kill switch: NEWSLETTER_IMAGE_BACKFILL=false skips without touching the db', async () => {
    process.env.NEWSLETTER_IMAGE_BACKFILL = 'false';
    expect(backfillEnabled()).toBe(false);
    const knex = knexStub([ROW]);
    const result = await backfillBatch({ knex, lookup: publicLookup, get: mockGet(200) });
    expect(result.skipped).toBe(true);
    expect(knex.updates).toHaveLength(0);
  });

  test('fills image_url via a fill-only update (re-asserts whereNull) and stamps the attempt', async () => {
    const knex = knexStub([ROW]);
    const get = mockGet(200, '<meta property="og:image" content="https://cdn.example/poster.jpg">');
    const result = await backfillBatch({ knex, lookup: publicLookup, get });
    expect(result).toMatchObject({ processed: 1, filled: 1 });
    expect(knex.updates).toHaveLength(1);
    expect(knex.updates[0].id).toBe(ROW.id);
    expect(knex.updates[0].nullGuards).toContain('image_url');
    expect(knex.updates[0].patch.image_url).toBe('https://cdn.example/poster.jpg');
    expect(knex.updates[0].patch.image_backfill_attempted_at).toBeInstanceOf(Date);
  });

  test('no og:image → attempt stamped WITHOUT an image_url write, so retry backs off', async () => {
    const knex = knexStub([ROW]);
    const result = await backfillBatch({ knex, lookup: publicLookup, get: mockGet(200, '<p>bare page</p>') });
    expect(result).toMatchObject({ processed: 1, filled: 0 });
    expect(knex.updates).toHaveLength(1);
    expect(knex.updates[0].patch.image_url).toBeUndefined();
    expect(knex.updates[0].patch.image_backfill_attempted_at).toBeInstanceOf(Date);
  });
});
