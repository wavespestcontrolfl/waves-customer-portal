/**
 * Issue-level GIF dedupe (owner rule 2026-07-09: the same GIF must never
 * appear twice in one issue — the Jul 9 draft shipped one Giphy result 6×
 * because limit=1 returned the same top GIF for similar search terms).
 *
 * Pins:
 *   1. searchGiphyCandidates returns an id+url candidate LIST (limit=10),
 *      [] on any failure — never a single winner.
 *   2. pickUniqueGif walks candidates against a shared used-set; exhausted
 *      candidates yield null (renderer falls back to the event photo)
 *      rather than a repeat.
 *   3. assembleBeehiivNewsletter end-to-end: terms that all share the same
 *      Giphy top result render distinct GIFs per section.
 *   4. The divider is the self-hosted 2026 mascot badge at 48px — not the
 *      old Beehiiv-CDN asset.
 */

const {
  searchGiphyCandidates,
  pickUniqueGif,
  pickUniqueGifWithRetry,
  heroTitleText,
  assembleBeehiivNewsletter,
} = require('../services/newsletter-draft');

function giphyGif(id) {
  return {
    id,
    images: { downsized_medium: { url: `https://media0.giphy.com/media/cid-${id}/${id}/giphy.gif` } },
  };
}

// Every term returns the SAME ranked list (dup-prone worst case): top result
// identical across terms, alternates available below it.
const SHARED_RANKING = ['topgif', 'alt1', 'alt2', 'alt3', 'alt4'].map(giphyGif);

describe('pickUniqueGif', () => {
  test('first unused candidate wins and is marked used', () => {
    const used = new Set();
    const url1 = pickUniqueGif(SHARED_RANKING.map(g => ({ id: g.id, url: g.images.downsized_medium.url })), used);
    const url2 = pickUniqueGif(SHARED_RANKING.map(g => ({ id: g.id, url: g.images.downsized_medium.url })), used);
    expect(url1).toContain('topgif');
    expect(url2).toContain('alt1');
    expect(used.size).toBe(2);
  });

  test('exhausted candidates yield null, never a repeat', () => {
    const used = new Set(['a']);
    expect(pickUniqueGif([{ id: 'a', url: 'https://x/a.gif' }], used)).toBeNull();
    expect(pickUniqueGif([], used)).toBeNull();
    expect(pickUniqueGif(null, used)).toBeNull();
  });
});

describe('pickUniqueGifWithRetry — expanded-keyword fallback', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GIPHY_API_KEY;
  });

  test('exhausted primary pool → broadened re-search finds an unused GIF', async () => {
    process.env.GIPHY_API_KEY = 'test-key';
    const searched = [];
    global.fetch = jest.fn(async (url) => {
      const q = decodeURIComponent(/q=([^&]+)/.exec(url)[1]).replace(/\+/g, ' ');
      searched.push(q);
      // broadened queries surface a fresh GIF the primary pool didn't have
      const data = q.includes('reaction') ? [giphyGif('freshgif')] : [giphyGif('topgif')];
      return { ok: true, json: async () => ({ data }) };
    });
    const used = new Set(['topgif']); // primary candidates all taken
    const url = await pickUniqueGifWithRetry('bass drop', [{ id: 'topgif', url: 'https://x/top.gif' }], used);
    expect(url).toContain('freshgif');
    expect(searched).toContain('bass drop reaction');
  });

  test('every broadened variant exhausted too → null (photo fallback), never a repeat', async () => {
    process.env.GIPHY_API_KEY = 'test-key';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [giphyGif('topgif')] }) }));
    const used = new Set(['topgif']);
    const url = await pickUniqueGifWithRetry('bass drop', [{ id: 'topgif', url: 'https://x/top.gif' }], used);
    expect(url).toBeNull();
  });
});

describe('heroTitleText — hero poster headline', () => {
  test('strips emoji, keeps the content words', () => {
    expect(heroTitleText('💣 Boom, Baby! The Only Fireworks Guide You’ll Need'))
      .toBe('Boom, Baby! The Only Fireworks Guide You’ll Need');
    expect(heroTitleText('Bubbles, Sea Lions & Sand Dollar Pillows — Full Send'))
      .toBe('Bubbles, Sea Lions & Sand Dollar Pillows — Full Send');
    expect(heroTitleText('')).toBe('');
  });
});

describe('searchGiphyCandidates', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GIPHY_API_KEY;
  });

  test('returns id+url candidates and requests a broad limit=25 pool', async () => {
    process.env.GIPHY_API_KEY = 'test-key';
    let requestedUrl;
    global.fetch = jest.fn(async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ data: SHARED_RANKING }) };
    });
    const candidates = await searchGiphyCandidates('excited dancing');
    expect(requestedUrl).toContain('limit=25');
    expect(candidates).toHaveLength(5);
    expect(candidates[0]).toEqual({ id: 'topgif', url: expect.stringContaining('topgif') });
  });

  test('no API key / API failure / malformed payload → []', async () => {
    expect(await searchGiphyCandidates('anything')).toEqual([]); // no key
    process.env.GIPHY_API_KEY = 'test-key';
    global.fetch = jest.fn(async () => ({ ok: false }));
    expect(await searchGiphyCandidates('anything')).toEqual([]);
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: 'nope' }) }));
    expect(await searchGiphyCandidates('anything')).toEqual([]);
    global.fetch = jest.fn(async () => { throw new Error('network'); });
    expect(await searchGiphyCandidates('anything')).toEqual([]);
  });
});

describe('assembleBeehiivNewsletter — no GIF repeats in one issue', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.GIPHY_API_KEY;
  });

  function eventFixture(n) {
    return {
      eventId: `a0000000-0000-4000-8000-00000000000${n}`,
      emoji: '🎵',
      title: `Event Number ${n}`,
      description: `Description for event ${n}`,
      date: 'Saturday, May 31 @ 7:00 PM',
      location: `Venue ${n}, Sarasota`,
      gifSearchTerm: `reaction term ${n}`,
      gifCaption: `caption ${n}`,
    };
  }

  test('three events whose terms share a Giphy top result get three distinct GIFs', async () => {
    process.env.GIPHY_API_KEY = 'test-key';
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: SHARED_RANKING }) }));

    const html = await assembleBeehiivNewsletter({
      selectedSubject: 'Weekend Lineup',
      greeting: 'Hey there',
      introText: 'Big week ahead.',
      introGifTerm: 'intro mood',
      events: [eventFixture(1), eventFixture(2), eventFixture(3)],
    });

    const gifUrls = [...html.matchAll(/https:\/\/media0\.giphy\.com\/media\/[^"]+\/giphy\.gif/g)].map(m => m[0]);
    expect(gifUrls.length).toBe(4); // intro + 3 events
    expect(new Set(gifUrls).size).toBe(4); // ALL distinct — the actual owner rule
  });

  test('divider uses the self-hosted 2026 mascot badge at 48px, not the Beehiiv CDN', async () => {
    const html = await assembleBeehiivNewsletter({
      selectedSubject: 'Weekend Lineup',
      greeting: 'Hey there',
      introText: 'Big week ahead.',
      events: [eventFixture(1)],
    });
    expect(html).toContain('https://d2riygw2ap9mi.cloudfront.net/social-media/waves-divider-2026.gif');
    expect(html).toContain('width="48"');
    expect(html).not.toContain('media.beehiiv.com');
  });
});
