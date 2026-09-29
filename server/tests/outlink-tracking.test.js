/**
 * Outside-link click tracking for prep guides (GATE_OUTLINK_TRACKING):
 * render-time rewrite (email version + /prep page blocks) and the /go/:code
 * redirect route. In-memory fake db; no network, nothing is sent.
 */

const mockTables = {
  outbound_links: [],
  outbound_link_clicks: [],
  scheduled_services: [],
  projects: [],
};

jest.mock('../models/db', () => {
  const make = (name) => {
    const state = { filter: null, codes: null };
    const rows = () => mockTables[name];
    const q = {
      insert: (data) => {
        const list = Array.isArray(data) ? data : [data];
        const run = (ignoreConflicts) => {
          list.forEach((r) => {
            if (ignoreConflicts && rows().some((x) => x.code === r.code)) return;
            rows().push({ id: `id-${name}-${rows().length + 1}`, ...r });
          });
        };
        // Lazy thenable: a plain await inserts; .onConflict().ignore() skips dup codes.
        return {
          then: (ok, err) => Promise.resolve().then(() => run(false)).then(ok, err),
          catch: (err) => Promise.resolve().then(() => run(false)).catch(err),
          onConflict: () => ({ ignore: () => Promise.resolve().then(() => run(true)) }),
        };
      },
      where: (f) => { state.filter = f; return q; },
      whereIn: (col, vals) => { state.codes = { col, vals }; return q; },
      first: async () => rows().find((r) => Object.entries(state.filter || {}).every(([k, v]) => r[k] === v)) || null,
      select: async () => rows().filter((r) => !state.codes || state.codes.vals.includes(r[state.codes.col])),
    };
    return q;
  };
  const fn = jest.fn((name) => make(name));
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const express = require('express');
const svc = require('../services/outlink-tracking');
const emailLib = require('../services/email-template-library');

const TOKEN = 'ab'.repeat(16);
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SERVICE = '22222222-2222-4222-8222-222222222222';
const AMAZON = 'https://www.amazon.com/dp/B004G6YL5E';
const CHEWY = 'https://www.chewy.com/hartz-groomers-best-flea-comb-dogs/dp/159708';
const OWN = 'https://www.wavespestcontrol.com/pest-control/get-rid-of-bed-bugs-lakewood-ranch-fl/';

const BLOCKS = [
  { type: 'paragraph', content: `Get a comb from [Chewy](${CHEWY}) or [Amazon](${AMAZON}).` },
  { type: 'list', items: [`[Our guide](${OWN})`, `[Call us](tel:+19415550100)`, `[Email us](mailto:contact@wavespestcontrol.com)`, `[Portal](https://portal.wavespestcontrol.com/?tab=visits)`] },
  { type: 'details', rows: [{ label: 'Buy', value: `[Amazon](${AMAZON})` }] },
];

const savedEnv = { ...process.env };
beforeEach(() => {
  Object.values(mockTables).forEach((t) => { t.length = 0; });
  process.env.JWT_SECRET = 'test-secret';
  process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
  delete process.env.GATE_OUTLINK_TRACKING;
});
afterAll(() => { process.env = savedEnv; });

const on = () => { process.env.GATE_OUTLINK_TRACKING = 'true'; };
const goLinks = (text) => [...String(text).matchAll(/https:\/\/portal\.wavespestcontrol\.com\/go\/[^)\s]+/g)].map((m) => m[0]);

describe('render-time rewrite (page blocks)', () => {
  const run = (over = {}) => svc.applyOutlinkTracking({
    blocks: BLOCKS, templateKey: 'prep.flea', prepToken: TOKEN, customerId: CUSTOMER, surface: 'page', ...over,
  });

  test('gate off: blocks come back untouched and nothing is registered', async () => {
    const out = await run();
    expect(out.blocks).toBe(BLOCKS);
    expect(out.rewritten).toBe(0);
    expect(mockTables.outbound_links).toHaveLength(0);
  });

  test('gate on: external links become /go/<code> with a signed context; every other link is untouched', async () => {
    on();
    mockTables.scheduled_services.push({ id: SERVICE, prep_token: TOKEN, customer_id: CUSTOMER });
    const out = await run();
    const [p, l, d] = out.blocks;
    expect(goLinks(p.content)).toHaveLength(2);
    expect(p.content).not.toContain('chewy.com');
    expect(p.content).not.toContain('amazon.com');
    expect(l.items).toEqual(BLOCKS[1].items); // own site, tel, mailto, portal
    expect(goLinks(d.rows[0].value)).toHaveLength(1);
    expect(d.rows[0].label).toBe('Buy');
    // the input is not mutated
    expect(BLOCKS[0].content).toContain(CHEWY);
    // one registered row per distinct URL (Amazon appears twice)
    expect(mockTables.outbound_links.map((r) => r.target_url).sort()).toEqual([AMAZON, CHEWY].sort());
    const u = new URL(goLinks(p.content)[0]);
    expect(u.searchParams.get('k')).toBe('prep.flea');
    expect(u.searchParams.get('v')).toBe(SERVICE);
    expect(u.searchParams.get('c')).toBe(CUSTOMER);
    expect(u.searchParams.get('s')).toBe('page');
    expect(u.searchParams.get('g')).toBeTruthy();
  });

  test('the tracking URL never carries the bearer prep token (no 32-hex value, no t param)', async () => {
    on();
    mockTables.scheduled_services.push({ id: SERVICE, prep_token: TOKEN, customer_id: CUSTOMER });
    const out = await run();
    for (const link of goLinks(JSON.stringify(out.blocks))) {
      expect(link).not.toContain(TOKEN);
      expect(link).not.toMatch(/[a-f0-9]{32}/i);
      expect(new URL(link).searchParams.has('t')).toBe(false);
      // and the request-log redactor has nothing sensitive to hide in it
      const { redactRequestUrl } = require('../utils/redact-request-url');
      const path = link.replace('https://portal.wavespestcontrol.com', '');
      expect(redactRequestUrl(path)).toBe(path);
    }
  });

  test('an unresolvable prep token yields no visit linkage (and still no token in the URL)', async () => {
    on();
    const out = await run();
    const u = new URL(goLinks(out.blocks[0].content)[0]);
    expect(u.searchParams.has('v')).toBe(false);
    expect(u.searchParams.has('p')).toBe(false);
    expect(u.search).not.toContain(TOKEN);
    expect(u.searchParams.get('c')).toBe(CUSTOMER);
  });

  test('registered destinations are the exact original URLs (no tag, no change)', async () => {
    on();
    await run();
    for (const r of mockTables.outbound_links) {
      expect([AMAZON, CHEWY]).toContain(r.target_url);
      expect(r.target_url).not.toMatch(/tag=|affiliate/i);
      expect(r.code).toBe(svc.codeForUrl(r.target_url));
    }
  });

  test('rendering twice registers the same codes once (idempotent)', async () => {
    on();
    const a = await run();
    const b = await run();
    expect(a.blocks[0].content).toBe(b.blocks[0].content);
    expect(mockTables.outbound_links).toHaveLength(2);
  });

  test('non-prep template, missing secret: untouched', async () => {
    on();
    expect((await run({ templateKey: 'invoice.sent' })).rewritten).toBe(0);
    delete process.env.JWT_SECRET;
    expect((await run()).blocks).toBe(BLOCKS);
  });

  test('a rewrite failure fails open to the original blocks', async () => {
    on();
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    const out = await run();
    expect(out.blocks).toBe(BLOCKS);
  });

  test('isExternalHttpUrl: own domains, subdomains and non-http are never external', () => {
    expect(svc.isExternalHttpUrl(AMAZON)).toBe(true);
    expect(svc.isExternalHttpUrl(OWN)).toBe(false);
    expect(svc.isExternalHttpUrl('https://portal.wavespestcontrol.com/x')).toBe(false);
    expect(svc.isExternalHttpUrl('https://venicelawncare.com/')).toBe(false);
    expect(svc.isExternalHttpUrl('https://wavespestcontrol.com.evil.example/')).toBe(true);
    expect(svc.isExternalHttpUrl('mailto:a@b.co')).toBe(false);
    expect(svc.isExternalHttpUrl('tel:+19415550100')).toBe(false);
    expect(svc.isExternalHttpUrl('/relative')).toBe(false);
    expect(svc.isExternalHttpUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('render-time rewrite (email)', () => {
  const template = { template_key: 'prep.flea' };
  const version = { id: 'v1', blocks: BLOCKS, text_body: `Buy: [Amazon](${AMAZON})`, subject: 's' };
  const payload = { prep_url: `https://portal.wavespestcontrol.com/prep/${TOKEN}` };

  test('gate off: the same version object comes back', async () => {
    const out = await svc.withOutlinkTrackingForEmail({ template, version, payload, recipientType: 'customer', recipientId: CUSTOMER });
    expect(out).toBe(version);
  });

  test('gate on: a copy carries rewritten blocks + text_body; id preserved; stored version untouched', async () => {
    on();
    const out = await svc.withOutlinkTrackingForEmail({ template, version, payload, recipientType: 'customer', recipientId: CUSTOMER });
    expect(out).not.toBe(version);
    expect(out.id).toBe('v1');
    expect(goLinks(out.blocks[0].content)).toHaveLength(2);
    expect(goLinks(out.text_body)).toHaveLength(1);
    expect(version.blocks[0].content).toContain(CHEWY);
    const u = new URL(goLinks(out.blocks[0].content)[0]);
    expect(u.search).not.toContain(TOKEN); // token lifted from payload.prep_url, resolved to ids, never emitted
    expect(u.searchParams.get('s')).toBe('email');
    expect(u.searchParams.get('c')).toBe(CUSTOMER);
  });

  test('the rendered email html links to /go, keeps own/tel/mailto links direct', async () => {
    on();
    const rewritten = await svc.withOutlinkTrackingForEmail({ template, version, payload, recipientType: 'customer', recipientId: CUSTOMER });
    const rendered = emailLib.renderTemplate({
      template: { template_key: 'prep.flea', name: 'Prep', mode: 'service' },
      version: { ...rewritten, subject: 'Prep' },
      payload: { first_name: 'Sam' },
    });
    expect(rendered.html).toContain('portal.wavespestcontrol.com/go/');
    expect(rendered.html).not.toContain('chewy.com');
    expect(rendered.html).toContain('wavespestcontrol.com/pest-control/get-rid-of-bed-bugs');
    expect(rendered.html).toContain('href="tel:+19415550100"');
    expect(rendered.html).toContain('href="mailto:contact@wavespestcontrol.com"');
  });

  test('non-prep template key is left alone even with the gate on', async () => {
    on();
    const out = await svc.withOutlinkTrackingForEmail({ template: { template_key: 'invoice.sent' }, version, payload, recipientType: 'customer', recipientId: CUSTOMER });
    expect(out).toBe(version);
  });
});

describe('GET /go/:code', () => {
  let server;
  let base;
  beforeAll((done) => {
    const app = express();
    app.use('/go', require('../routes/outbound-redirect'));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { server.close(done); });

  const get = (path, headers = {}) => fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari', ...headers },
  });
  const expectPrivacyHeaders = (res) => {
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  };
  const tick = () => new Promise((r) => setImmediate(r));

  async function registered() {
    on();
    const out = await svc.applyOutlinkTracking({
      blocks: [{ type: 'paragraph', content: `[Amazon](${AMAZON})` }],
      templateKey: 'prep.flea', prepToken: TOKEN, customerId: CUSTOMER, surface: 'email',
    });
    return new URL(goLinks(out.blocks[0].content)[0]);
  }

  test('known code: 302 to the exact stored target, click logged with verified context', async () => {
    mockTables.scheduled_services.push({ id: SERVICE, prep_token: TOKEN, customer_id: CUSTOMER });
    const u = await registered();
    const res = await get(u.pathname + u.search);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(AMAZON);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks).toHaveLength(1);
    const click = mockTables.outbound_link_clicks[0];
    expect(click).toMatchObject({
      template_key: 'prep.flea', surface: 'email', scheduled_service_id: SERVICE, customer_id: CUSTOMER,
    });
    expect(click.ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(click.user_agent).toContain('Safari');
  });

  test('a project-backed prep token attributes the click to the project', async () => {
    const PROJECT = '55555555-5555-4555-8555-555555555555';
    mockTables.projects.push({ id: PROJECT, prep_token: TOKEN, customer_id: CUSTOMER });
    const u = await registered();
    expect(u.searchParams.get('p')).toBe(PROJECT);
    expect((await get(u.pathname + u.search)).status).toBe(302);
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks[0]).toMatchObject({ project_id: PROJECT, scheduled_service_id: null, customer_id: CUSTOMER });
  });

  test('a tampered context still redirects but is not trusted for attribution', async () => {
    const u = await registered();
    u.searchParams.set('c', '33333333-3333-4333-8333-333333333333');
    const res = await get(u.pathname + u.search);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(AMAZON);
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks).toHaveLength(1);
    expect(mockTables.outbound_link_clicks[0]).toMatchObject({ template_key: null, customer_id: null, scheduled_service_id: null });
  });

  test('HEAD redirects like GET but records no click', async () => {
    const u = await registered();
    const res = await fetch(`${base}${u.pathname}${u.search}`, {
      method: 'HEAD', redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(AMAZON);
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks).toHaveLength(0);
  });

  test('a signed context replayed onto a different registered code still redirects but is not attributed', async () => {
    mockTables.scheduled_services.push({ id: SERVICE, prep_token: TOKEN, customer_id: CUSTOMER });
    const u = await registered();
    // Register a second destination and replay the first link's signed query onto it.
    const other = await svc.applyOutlinkTracking({
      blocks: [{ type: 'paragraph', content: `[Chewy](${CHEWY})` }],
      templateKey: 'prep.flea', prepToken: TOKEN, customerId: CUSTOMER, surface: 'email',
    });
    const otherCode = new URL(goLinks(other.blocks[0].content)[0]).pathname;
    expect(otherCode).not.toBe(u.pathname);
    const res = await get(otherCode + u.search);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(CHEWY);
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks).toHaveLength(1);
    expect(mockTables.outbound_link_clicks[0]).toMatchObject({ template_key: null, customer_id: null, scheduled_service_id: null });
    // control: the link's own signed context does attribute on its own code
    const own = await get(u.pathname + u.search);
    expect(own.status).toBe(302);
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks[1]).toMatchObject({ template_key: 'prep.flea', customer_id: CUSTOMER });
  });

  test('unknown code: generic 404, no click row', async () => {
    const res = await get(`/go/${'0'.repeat(20)}`);
    expect(res.status).toBe(404);
    expectPrivacyHeaders(res);
    await tick();
    expect(mockTables.outbound_link_clicks).toHaveLength(0);
  });

  test('every status carries the privacy headers: 302, 404, 429, 500', async () => {
    const u = await registered();
    const ok = await get(u.pathname + u.search);
    expect(ok.status).toBe(302);
    expectPrivacyHeaders(ok);
    const missing = await get('/go/short');
    expect(missing.status).toBe(404);
    expectPrivacyHeaders(missing);
    // 500: the lookup throws
    const db = require('../models/db');
    const impl = db.getMockImplementation();
    db.mockImplementationOnce(() => { throw new Error('boom'); });
    const failed = await get(`/go/${'2'.repeat(20)}`);
    expect(failed.status).toBe(500);
    expectPrivacyHeaders(failed);
    db.mockImplementation(impl);
  });

  test('the 429 from the rate limiter carries the privacy headers too', async () => {
    const limited = express();
    jest.resetModules();
    jest.doMock('express-rate-limit', () => (opts) => (req, res) => opts.handler(req, res));
    limited.use('/go', require('../routes/outbound-redirect'));
    jest.dontMock('express-rate-limit');
    const s2 = await new Promise((r) => { const sv = limited.listen(0, () => r(sv)); });
    try {
      const res = await fetch(`http://127.0.0.1:${s2.address().port}/go/${'0'.repeat(20)}`, { redirect: 'manual' });
      expect(res.status).toBe(429);
      expectPrivacyHeaders(res);
    } finally {
      await new Promise((r) => s2.close(r));
      jest.resetModules();
    }
  });

  test('malformed code: 404', async () => {
    expect((await get('/go/short')).status).toBe(404);
    expect((await get(`/go/${encodeURIComponent('../../etc/passwd')}`)).status).toBe(404);
  });

  test('no open redirect: a ?url= / ?u= / ?to= param is never followed, even on a real code', async () => {
    const u = await registered();
    for (const name of ['url', 'u', 'to', 'target', 'target_url', 'redirect', 'next']) {
      const res = await get(`${u.pathname}?${name}=https://evil.example/x`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(AMAZON);
    }
    // and an unregistered code with a url param is a plain 404
    const res = await get(`/go/${'1'.repeat(20)}?url=https://evil.example/x`);
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  test('a stored row whose target does not hash to its code is never served', async () => {
    const code = svc.codeForUrl('https://good.example/');
    mockTables.outbound_links.push({ id: 'x', code, target_url: 'https://evil.example/swapped' });
    expect((await get(`/go/${code}`)).status).toBe(404);
    const c2 = svc.codeForUrl('javascript:alert(1)');
    mockTables.outbound_links.push({ id: 'y', code: c2, target_url: 'javascript:alert(1)' });
    expect((await get(`/go/${c2}`)).status).toBe(404);
  });

  test('bot / preview UA: still 302, no click logged', async () => {
    const u = await registered();
    for (const ua of ['Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'Mozilla/5.0 (compatible; Googlebot/2.1)']) {
      const res = await get(u.pathname + u.search, { 'user-agent': ua });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(AMAZON);
    }
    await tick(); await tick();
    expect(mockTables.outbound_link_clicks).toHaveLength(0);
  });

  test('the route serves with the gate off (links already sent keep working)', async () => {
    const u = await registered();
    delete process.env.GATE_OUTLINK_TRACKING;
    const res = await get(u.pathname + u.search);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(AMAZON);
  });
});
