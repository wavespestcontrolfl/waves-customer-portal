const dataforseo = require('../services/seo/dataforseo');

const GOTO = 'https://google.com/goto?url=CAESeAHEIkXX&gsessionid=SC2CQpjv';

function organic(over = {}) {
  return {
    type: 'organic',
    rank_absolute: 7,
    domain: 'google.com',
    title: 'Pest Control in Lakewood Ranch',
    url: GOTO,
    breadcrumb: 'https://www.masseyservices.com',
    website_name: 'Massey Services',
    ...over,
  };
}

function serp(items) {
  return { tasks: [{ result: [{ items }] }] };
}

describe('serpOrganic google /goto wrapper normalization', () => {
  const orig = dataforseo.request;
  let response;
  beforeEach(() => { dataforseo.request = async () => response; });
  afterEach(() => { dataforseo.request = orig; });

  const itemsOf = (data) => data.tasks[0].result[0].items;

  test('goto item gets the breadcrumb host as domain; url keeps the goto link, site_url the base', async () => {
    response = serp([organic()]);
    const [item] = itemsOf(await dataforseo.serpOrganic('pest control', 'Bradenton,Florida,United States'));
    expect(item).toMatchObject({
      domain: 'www.masseyservices.com',
      url: GOTO,
      site_url: 'https://www.masseyservices.com',
      domain_from_breadcrumb: true,
    });
  });

  test('desktop breadcrumb with a truncated path uses the base url only', async () => {
    response = serp([organic({ breadcrumb: 'https://www.orkin.com › ... › Sarasota Pest Control' })]);
    const [item] = itemsOf(await dataforseo.serpOrganic('pest control', 'Sarasota,Florida,United States', 'desktop'));
    expect(item.domain).toBe('www.orkin.com');
    expect(item.site_url).toBe('https://www.orkin.com');
    expect(item.url).toBe(GOTO);
  });

  test('breadcrumb origin with a trailing slash still restores the domain', async () => {
    response = serp([organic({ breadcrumb: 'https://www.wavespestcontrol.com/' })]);
    const [item] = itemsOf(await dataforseo.serpOrganic('pest control', 'Bradenton,Florida,United States'));
    expect(item.domain).toBe('www.wavespestcontrol.com');
    expect(item.site_url).toBe('https://www.wavespestcontrol.com');
  });

  test('a port in the breadcrumb origin stays in site_url', async () => {
    response = serp([organic({ breadcrumb: 'https://shop.example.com:8443' })]);
    const [item] = itemsOf(await dataforseo.serpOrganic('pest control'));
    expect(item.domain).toBe('shop.example.com');
    expect(item.site_url).toBe('https://shop.example.com:8443');
  });

  test('a breadcrumb that carries a URL path still restores the domain', async () => {
    response = serp([organic({ breadcrumb: 'https://www.turnerpest.com/residential/sarasota/' })]);
    const [item] = itemsOf(await dataforseo.serpOrganic('pest control'));
    expect(item.domain).toBe('www.turnerpest.com');
    expect(item.site_url).toBe('https://www.turnerpest.com');
  });

  test('breadcrumb with no host ("5 comments") leaves the item unchanged', async () => {
    response = serp([organic({ breadcrumb: '5 comments' })]);
    const [item] = itemsOf(await dataforseo.serpOrganic('pest control'));
    expect(item).toEqual(organic({ breadcrumb: '5 comments' }));
  });

  test('normal non-goto organic item and non-organic items are unchanged', async () => {
    const normal = organic({ domain: 'example.com', url: 'https://example.com/pest', breadcrumb: 'https://example.com › pest' });
    const paa = { type: 'people_also_ask', url: GOTO, breadcrumb: 'https://www.masseyservices.com' };
    response = serp([structuredClone(normal), structuredClone(paa)]);
    const items = itemsOf(await dataforseo.serpOrganic('pest control'));
    expect(items[0]).toEqual(normal);
    expect(items[1]).toEqual(paa);
  });

  test('a rank-tracker style .includes lookup finds the Waves item again', async () => {
    response = serp([
      organic(),
      organic({ breadcrumb: 'https://www.wavespestcontrol.com › pest-control', website_name: 'Waves Pest Control', rank_absolute: 9 }),
    ]);
    const items = itemsOf(await dataforseo.serpOrganic('pest control'));
    const hit = items.find((i) => i.type === 'organic' && (i.domain || '').includes('wavespestcontrol'));
    expect(hit.rank_absolute).toBe(9);
  });

  test('a null request result (gate off, failure) passes through as null', async () => {
    response = null;
    expect(await dataforseo.serpOrganic('pest control')).toBeNull();
  });

  test('a response with no tasks or no items does not throw', async () => {
    response = { tasks: [{ result: null }, { result: [{}] }, null] };
    await expect(dataforseo.serpOrganic('pest control')).resolves.toBe(response);
  });
});
