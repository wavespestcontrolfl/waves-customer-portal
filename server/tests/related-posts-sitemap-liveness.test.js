// getSitemapLiveRelatedPaths: merge-time freshness check against each
// publish host's deployed sitemap (later-queue from #5272).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { getSitemapLiveRelatedPaths } = require('../services/content/related-posts');

function urlset(urls) {
  return `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
}
function index(children) {
  return `<?xml version="1.0"?><sitemapindex>${children.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('')}</sitemapindex>`;
}
function fakeFetch(routes) {
  return jest.fn(async (url) => {
    const body = routes[url];
    if (body === undefined) return { status: 404, headers: new Map(), text: async () => 'not found' };
    return { status: 200, headers: new Map([['content-type', 'application/xml']]), text: async () => body };
  });
}

test('hub: keeps only paths listed in the sitemap index children', async () => {
  const fetchImpl = fakeFetch({
    'https://www.wavespestcontrol.com/sitemap-index.xml': index(['https://www.wavespestcontrol.com/sitemap-0.xml']),
    'https://www.wavespestcontrol.com/sitemap-0.xml': urlset(['https://www.wavespestcontrol.com/pest-control/carpenter-ants/']),
  });
  const live = await getSitemapLiveRelatedPaths(['/pest-control/fire-ants/', '/Pest-Control/Carpenter-Ants'], { fetchImpl });
  expect([...live]).toEqual(['/pest-control/carpenter-ants/']);
});

test('falls back to /sitemap.xml when the index is missing', async () => {
  const fetchImpl = fakeFetch({
    'https://www.wavespestcontrol.com/sitemap.xml': urlset(['https://www.wavespestcontrol.com/pest-control/fire-ants/']),
  });
  const live = await getSitemapLiveRelatedPaths(['/pest-control/fire-ants/'], { hosts: ['wavespestcontrol.com'], fetchImpl });
  expect([...live]).toEqual(['/pest-control/fire-ants/']);
});

test('a path must be in EVERY host sitemap (spoke URLs match by absolute URL)', async () => {
  const fetchImpl = fakeFetch({
    'https://www.wavespestcontrol.com/sitemap-index.xml': urlset(['https://www.wavespestcontrol.com/a/', 'https://www.wavespestcontrol.com/b/']),
    'https://www.sarasotaflpestcontrol.com/sitemap-index.xml': urlset(['https://www.sarasotaflpestcontrol.com/b/']),
  });
  const live = await getSitemapLiveRelatedPaths(['/a/', '/b/'], { hosts: ['wavespestcontrol.com', 'sarasotaflpestcontrol.com'], fetchImpl });
  expect([...live]).toEqual(['/b/']);
});

test('an unreadable host sitemap → null (caller withholds)', async () => {
  const fetchImpl = fakeFetch({});
  expect(await getSitemapLiveRelatedPaths(['/a/'], { hosts: ['wavespestcontrol.com'], fetchImpl })).toBeNull();
});

test('an unknown host → null; no paths → empty set without fetching', async () => {
  const fetchImpl = fakeFetch({});
  expect(await getSitemapLiveRelatedPaths(['/a/'], { hosts: ['example.com'], fetchImpl })).toBeNull();
  expect([...(await getSitemapLiveRelatedPaths([], { fetchImpl }))]).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
