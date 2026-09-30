process.env.JWT_SECRET = 'test-secret-for-signed-map-images';
process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key-AAAA1111';
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_STATIC_MAPS_API_KEY;
delete process.env.REPORT_PIN_SECRET;
delete process.env.PUBLIC_PORTAL_URL;
delete process.env.PORTAL_URL;
delete process.env.CLIENT_URL;
delete process.env.PORTAL_DOMAIN;

// The server Google Maps key must never reach a customer or anonymous caller:
//   - the public lead-form lookup returns signed proxy URLs, not keyed URLs
//   - the customer service-report map + portal station map carry signed paths
//   - GET /api/public/map-image/:token rebuilds the Static Maps URL ONLY from
//     the signed, range-checked params (nothing from the caller's query)
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const express = require('express');
const signed = require('../services/signed-map-image');
const { scrubMapsKeysFromString, scrubMapsKeysDeep } = require('../services/estimate-map-image');
const mapImageRouter = require('../routes/public-map-image');
const { _test: lookupTest } = require('../routes/public-property-lookup');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const KEYED = 'https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&zoom=19&size=640x640&maptype=satellite&format=png&key=AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE1234567';
const PARAMS = { lat: 27.3, lng: -82.5, zoom: 19, width: 640, height: 340, scale: 2, maptype: 'satellite' };

let upstreamCalls;
let upstreamResponder;
const realFetch = global.fetch;

beforeEach(() => {
  upstreamCalls = [];
  upstreamResponder = () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG });
  global.fetch = jest.fn((url, init) => {
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      upstreamCalls.push(String(url));
      return Promise.resolve(upstreamResponder(String(url)));
    }
    return realFetch(url, init);
  });
});
afterAll(() => { global.fetch = realFetch; });

async function withServer(fn, { trustProxy = false } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', true);
  app.use('/api/public/map-image', mapImageRouter);
  // Anything the router lets fall through would land here (stands in for the
  // global limiter / app notFound that follow it in server/index.js).
  app.use((req, res) => res.status(418).send('fell through'));
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

describe('signed token', () => {
  test('round-trips exactly the signed params', () => {
    const token = signed.signMapImageToken(PARAMS);
    expect(signed.verifyMapImageToken(token)).toEqual({
      lat: '27.3000000', lng: '-82.5000000', zoom: 19, width: 640, height: 340, scale: 2, maptype: 'satellite',
    });
  });

  test('a tampered payload, tampered signature, wrong shape or expired token verifies as null', () => {
    const token = signed.signMapImageToken(PARAMS);
    const [v, body, sig] = token.split('.');
    const otherBody = Buffer.from('27.3000000|-82.5000000|1|640x340|2|satellite|9999999999').toString('base64url');
    expect(signed.verifyMapImageToken(`${v}.${otherBody}.${sig}`)).toBeNull();
    expect(signed.verifyMapImageToken(`${v}.${body}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(signed.verifyMapImageToken(`${v}.${body}`)).toBeNull();
    expect(signed.verifyMapImageToken('v2.' + body + '.' + sig)).toBeNull();
    expect(signed.verifyMapImageToken('')).toBeNull();
    expect(signed.verifyMapImageToken(undefined)).toBeNull();
    expect(signed.verifyMapImageToken(`${'a'.repeat(400)}`)).toBeNull();
    const past = signed.signMapImageToken(PARAMS, { nowSeconds: 1000, ttlSeconds: 60 });
    expect(signed.verifyMapImageToken(past)).toBeNull();
    const fresh = signed.signMapImageToken(PARAMS, { nowSeconds: 1000, ttlSeconds: 60 });
    expect(signed.verifyMapImageToken(fresh, { nowSeconds: 1030 })).not.toBeNull();
    expect(signed.verifyMapImageToken(fresh, { nowSeconds: 1061 })).toBeNull();
  });

  test('a token minted at exactly the 24 h cap still verifies on a pod whose clock is a little behind', () => {
    const DAY = 24 * 60 * 60;
    const token = signed.signMapImageToken(PARAMS, { nowSeconds: 10000, ttlSeconds: DAY * 5 });
    // A requested lifetime above the cap is clamped to it; verify with the clock 1 s, 30 s and 60 s behind.
    for (const behind of [0, 1, 30, 60]) {
      expect([behind, signed.verifyMapImageToken(token, { nowSeconds: 10000 - behind }) !== null]).toEqual([behind, true]);
    }
    // ...but skew is bounded: a token can never be honoured for materially longer than the cap.
    expect(signed.verifyMapImageToken(token, { nowSeconds: 10000 - 61 })).toBeNull();
    expect(signed.verifyMapImageToken(token, { nowSeconds: 10000 - 3600 })).toBeNull();
    // and it is still refused once expired
    expect(signed.verifyMapImageToken(token, { nowSeconds: 10000 + DAY })).toBeNull();
  });

  test('a token signed under a different secret does not verify', () => {
    const token = signed.signMapImageToken(PARAMS);
    process.env.JWT_SECRET = 'a-different-secret';
    try {
      expect(signed.verifyMapImageToken(token)).toBeNull();
    } finally {
      process.env.JWT_SECRET = 'test-secret-for-signed-map-images';
    }
  });

  test('no signing secret means no signed URL (fail closed)', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(signed.signMapImageToken(PARAMS)).toBeNull();
      expect(signed.signedMapImagePath(PARAMS)).toBeNull();
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  test('out-of-range params are refused at signing time', () => {
    for (const bad of [
      { ...PARAMS, lat: 95 }, { ...PARAMS, lng: -181 }, { ...PARAMS, lat: 'x' }, { ...PARAMS, zoom: 0 },
      { ...PARAMS, zoom: 23 }, { ...PARAMS, zoom: 19.5 }, { ...PARAMS, width: 641 }, { ...PARAMS, height: 0 },
      { ...PARAMS, scale: 4 }, { ...PARAMS, maptype: 'roadmap' }, { ...PARAMS, maptype: 'satellite&markers=x' },
    ]) {
      expect(signed.signMapImageToken(bad)).toBeNull();
    }
  });

  test('the keyless URL is built only from validated params and never contains a key', () => {
    const url = signed.keylessStaticMapUrl(signed.verifyMapImageToken(signed.signMapImageToken(PARAMS)));
    expect(url).toBe('https://maps.googleapis.com/maps/api/staticmap?center=27.3000000%2C-82.5000000&zoom=19&size=640x340&scale=2&maptype=satellite');
    expect(url).not.toMatch(/key=/i);
  });
});

describe('signedMapImagePathFromStaticUrl (lookup URLs)', () => {
  test('keeps only center/zoom/size/maptype and drops the key, markers and path', () => {
    const withExtras = `${KEYED}&markers=color:red|1,2&path=weight:5|3,4&signature=abc`;
    const abs = signed.signedMapImagePathFromStaticUrl(withExtras, { absolute: true });
    expect(abs.startsWith('https://portal.wavespestcontrol.com/api/public/map-image/v1.')).toBe(true);
    expect(abs).not.toMatch(/AIza|key=|markers|maps\.googleapis|test-maps-key/);
    const params = signed.verifyMapImageToken(abs.split('/').pop());
    expect(params).toEqual({ lat: '27.3000000', lng: '-82.5000000', zoom: 19, width: 640, height: 640, scale: 1, maptype: 'satellite' });
  });

  test('report/portal links default to a 2 h lifetime', () => {
    const token = signed.signedMapImagePath(PARAMS).split('/').pop();
    const exp = Number(Buffer.from(token.split('.')[1], 'base64url').toString().split('|')[6]);
    const remaining = exp - Math.floor(Date.now() / 1000);
    expect(remaining).toBeGreaterThan(2 * 3600 - 60);
    expect(remaining).toBeLessThanOrEqual(2 * 3600);
  });

  test('relative by default; non-Static-Maps or address-centred URLs sign to null', () => {
    expect(signed.signedMapImagePathFromStaticUrl(KEYED)).toMatch(/^\/api\/public\/map-image\/v1\./);
    for (const bad of [
      'https://example.com/staticmap?center=1,2',
      'https://maps.googleapis.com/maps/api/geocode/json?address=x&key=AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE1234567',
      'https://maps.googleapis.com/maps/api/staticmap?center=12+Example+Ln&zoom=19&size=640x640',
      'https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&zoom=40&size=640x640',
      '', null, undefined,
    ]) {
      expect(signed.signedMapImagePathFromStaticUrl(bad)).toBeNull();
    }
  });
});

describe('GET /api/public/map-image/:token', () => {
  test('streams the image; key added server-side from the signed params only, caller query ignored', async () => {
    const path = signed.signedMapImagePath(PARAMS);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}${path}?center=99,99&zoom=1&key=caller-key&markers=evil&url=http://169.254.169.254/&size=5000x5000`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toMatch(/private/);
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    });
    expect(upstreamCalls).toHaveLength(1);
    const upstream = new URL(upstreamCalls[0]);
    expect(upstream.origin + upstream.pathname).toBe('https://maps.googleapis.com/maps/api/staticmap');
    expect(upstream.searchParams.get('center')).toBe('27.3000000,-82.5000000');
    expect(upstream.searchParams.get('zoom')).toBe('19');
    expect(upstream.searchParams.get('size')).toBe('640x340');
    expect(upstream.searchParams.get('scale')).toBe('2');
    expect(upstream.searchParams.getAll('key')).toEqual(['test-maps-key-AAAA1111']);
    expect([...upstream.searchParams.keys()].sort()).toEqual(['center', 'key', 'maptype', 'scale', 'size', 'zoom']);
    expect(upstreamCalls[0]).not.toMatch(/caller-key|evil|99,99|169\.254/);
  });

  test('a dedicated GOOGLE_STATIC_MAPS_API_KEY is preferred, matching the basemap provider', async () => {
    process.env.GOOGLE_STATIC_MAPS_API_KEY = 'dedicated-static-key-BBBB2222';
    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}${signed.signedMapImagePath(PARAMS)}`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      });
      expect(new URL(upstreamCalls[0]).searchParams.getAll('key')).toEqual(['dedicated-static-key-BBBB2222']);
    } finally {
      delete process.env.GOOGLE_STATIC_MAPS_API_KEY;
    }
  });

  test('bad signature, tampered params, garbage and expired tokens -> identical generic 404, no upstream fetch', async () => {
    const good = signed.signMapImageToken(PARAMS);
    const [v, body, sig] = good.split('.');
    const forged = Buffer.from('27.3000000|-82.5000000|1|640x640|2|satellite|9999999999').toString('base64url');
    const expired = signed.signMapImageToken(PARAMS, { nowSeconds: 1000, ttlSeconds: 60 });
    const bodies = [];
    await withServer(async (baseUrl) => {
      for (const token of [`${v}.${forged}.${sig}`, `${v}.${body}.${'A'.repeat(43)}`, 'garbage', 'v1..', expired, encodeURIComponent('../../etc/passwd')]) {
        const res = await fetch(`${baseUrl}/api/public/map-image/${token}`);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
        bodies.push(await res.text());
      }
    });
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/key|maps\.googleapis|test-maps-key/i);
    expect(upstreamCalls).toHaveLength(0);
  });

  test('a token that expires while in use is refused (Date.now moved past exp)', async () => {
    const path = signed.signedMapImagePath(PARAMS, { ttlSeconds: 60 });
    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 1000;
    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}${path}`);
        expect(res.status).toBe(404);
      });
    } finally {
      Date.now = realNow;
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  test('upstream failure or a non-image body -> generic 404 with no key or URL in the body', async () => {
    const path = signed.signedMapImagePath(PARAMS);
    for (const responder of [
      () => ({ ok: false, status: 403, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('nope') }),
      () => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>') }),
    ]) {
      upstreamResponder = responder;
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}${path}`);
        expect(res.status).toBe(404);
        const text = await res.text();
        expect(text).not.toMatch(/key|maps\.googleapis|test-maps-key/i);
      });
    }
  });

  test('no Maps key configured -> 404, nothing fetched', async () => {
    const savedKey = process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}${signed.signedMapImagePath(PARAMS)}`);
        expect(res.status).toBe(404);
      });
    } finally {
      process.env.GOOGLE_MAPS_API_KEY = savedKey;
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  test('60/min per client; the 429 carries the privacy headers; IPv6 /64 shares a bucket', async () => {
    const path = signed.signedMapImagePath(PARAMS);
    await withServer(async (baseUrl) => {
      const hit = (ip) => fetch(`${baseUrl}${path}`, { headers: { 'X-Forwarded-For': ip } });
      for (let i = 0; i < 60; i += 1) {
        const res = await hit(`2001:db8:7:8::${i + 1}`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      const limited = await hit('2001:db8:7:8:ffff::9');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('cache-control')).toBe('no-store');
      expect(limited.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      await limited.text();
      const other = await hit('2001:db8:9:9::1');
      expect(other.status).toBe(200);
      await other.arrayBuffer();
    }, { trustProxy: true });
  });
});

describe('router-level coverage: nothing under the mount falls through', () => {
  const genericBody = JSON.stringify({ error: 'Not found' });

  test('empty token, doubled slash, extra segments, uppercase mount, non-GET methods -> stamped generic 404', async () => {
    const good = signed.signMapImageToken(PARAMS);
    await withServer(async (baseUrl) => {
      const cases = [
        ['GET', '/api/public/map-image'],
        ['GET', '/api/public/map-image/'],
        ['GET', '/api/public/map-image//x'],
        ['GET', `/api/public/map-image//${good}`],
        ['GET', `/api/public/map-image/${good}/extra`],
        ['GET', `/api/public/map-image/${good}/extra/more`],
        ['POST', `/api/public/map-image/${good}`],
        ['PUT', `/api/public/map-image/${good}`],
        ['DELETE', '/api/public/map-image/'],
        ['OPTIONS', '/api/public/map-image/x'],
      ];
      for (const [method, p] of cases) {
        const res = await fetch(`${baseUrl}${p}`, { method });
        const label = `${method} ${p}`;
        expect([label, res.status]).toEqual([label, 404]);
        expect([label, res.headers.get('cache-control')]).toEqual([label, 'no-store']);
        expect([label, res.headers.get('cross-origin-resource-policy')]).toEqual([label, 'cross-origin']);
        expect([label, res.headers.get('referrer-policy')]).toEqual([label, 'no-referrer']);
        expect([label, await res.text()]).toEqual([label, genericBody]);
      }
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  test('malformed percent-encodings under the mount get the same stamped generic 404, never a 500', async () => {
    await withServer(async (baseUrl) => {
      for (const p of ['/%E0%A4%A', '/%', '/%zz', '/%E0%A4%A/x', '/v1.%E0%A4%A.sig', '/%C0%AE%C0%AE', '/%E0%A4%A?x=1']) {
        for (const method of ['GET', 'HEAD', 'POST']) {
          const res = await fetch(`${baseUrl}/api/public/map-image${p}`, { method });
          const label = `${method} ${p}`;
          expect([label, res.status]).toEqual([label, 404]);
          expect([label, res.headers.get('cache-control')]).toEqual([label, 'no-store']);
          expect([label, res.headers.get('cross-origin-resource-policy')]).toEqual([label, 'cross-origin']);
          expect([label, res.headers.get('referrer-policy')]).toEqual([label, 'no-referrer']);
          if (method !== 'HEAD') expect([label, await res.text()]).toEqual([label, JSON.stringify({ error: 'Not found' })]);
        }
      }
    });
  });

  test('HEAD, uppercase mount path and a trailing slash on a valid token behave like GET', async () => {
    const path = signed.signedMapImagePath(PARAMS);
    await withServer(async (baseUrl) => {
      const head = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      const upper = await fetch(`${baseUrl}${path.replace('/api/public/map-image', '/API/PUBLIC/MAP-IMAGE')}`);
      expect(upper.status).toBe(200);
      await upper.arrayBuffer();
      const slash = await fetch(`${baseUrl}${path}/`);
      expect(slash.status).toBe(200);
      await slash.arrayBuffer();
    });
  });

  test('over the limit, non-token subpaths and other methods get a stamped 429, never a fall-through', async () => {
    await withServer(async (baseUrl) => {
      const hit = (p, method = 'GET') => fetch(`${baseUrl}${p}`, { method, headers: { 'X-Forwarded-For': '2001:db8:aa:bb::1' } });
      for (let i = 0; i < 60; i += 1) {
        const res = await hit('/api/public/map-image/');
        expect(res.status).toBe(404);
        await res.text();
      }
      for (const [p, method] of [['/api/public/map-image/', 'GET'], ['/API/PUBLIC/MAP-IMAGE//x', 'GET'], ['/api/public/map-image/a/b', 'POST'], ['/api/public/map-image/whatever', 'GET']]) {
        const res = await hit(p, method);
        expect([p, method, res.status]).toEqual([p, method, 429]);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        await res.text();
      }
    }, { trustProxy: true });
  });
});

describe('public lead-form lookup payload', () => {
  test('satellite URLs are absolute signed proxy URLs, never keyed Google URLs', () => {
    const out = lookupTest.publicSatellitePayload({
      closeUrl: KEYED,
      microCloseUrl: KEYED.replace('zoom=19', 'zoom=22'),
      wideUrl: KEYED.replace('zoom=19', 'zoom=18'),
      ultraCloseUrl: KEYED,
      superCloseUrl: KEYED,
      inServiceArea: true,
    });
    expect(Object.keys(out).sort()).toEqual(['closeUrl', 'inServiceArea', 'microCloseUrl', 'wideUrl']);
    for (const field of ['closeUrl', 'microCloseUrl', 'wideUrl']) {
      expect(out[field]).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/api\/public\/map-image\/v1\./);
    }
    // 24 h (the cap): the marketing quote form cannot re-request the lookup.
    const exp = (url) => Number(Buffer.from(url.split('/').pop().split('.')[1], 'base64url').toString().split('|')[6]);
    const remaining = exp(out.closeUrl) - Math.floor(Date.now() / 1000);
    expect(remaining).toBeGreaterThan(24 * 3600 - 60);
    expect(remaining).toBeLessThanOrEqual(24 * 3600);
    expect(signed.verifyMapImageToken(out.microCloseUrl.split('/').pop()).zoom).toBe(22);
    expect(signed.verifyMapImageToken(out.wideUrl.split('/').pop()).zoom).toBe(18);
    expect(out.inServiceArea).toBe(true);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/AIza|key=|maps\.googleapis|test-maps-key/);
    expect(scrubMapsKeysFromString(text)).toBe(text);
  });

  test('a signed link whose signature looks like a bare Google key survives the scrub intact', () => {
    // Crafted: "AIza" + 39 base64url chars = the 43-char signature shape.
    const sig = `AIza${'Ab3_-'.repeat(7)}wxyz`;
    expect(sig).toHaveLength(43);
    const url = `https://portal.wavespestcontrol.com/api/public/map-image/v1.MjcuMw.${sig}`;
    const body = { lead_id: 'x', note: 'stray AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE1234567 in text', satellite: { closeUrl: url } };
    const out = scrubMapsKeysDeep(body);
    expect(out.satellite.closeUrl).toBe(url);
    expect(out.note).not.toMatch(/AIza/);
    expect(scrubMapsKeysFromString(`<img src="${url}">`)).toBe(`<img src="${url}">`);
    expect(scrubMapsKeysFromString(`${url} and key=AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE1234567`)).toBe(`${url} and `);
  });

  test('no satellite / no urls -> null fields, no throw', () => {
    expect(lookupTest.publicSatellitePayload(null)).toBeNull();
    expect(lookupTest.publicSatellitePayload({ inServiceArea: false })).toEqual({
      closeUrl: null, microCloseUrl: null, wideUrl: null, inServiceArea: false,
    });
  });

  test('the route wraps its success body in the key scrub', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/public-property-lookup'), 'utf8');
    // Source scrubbed FIRST, signed URLs attached AFTER (a signature can look like a bare key).
    expect(src).toMatch(/const publicBody = scrubMapsKeysDeep\(\{\s*lead_id: lead\.id,/);
    expect(src).toMatch(/publicBody\.satellite = publicSatellitePayload\(result\.satellite\);\s*res\.json\(publicBody\);/);
    expect(src).not.toMatch(/closeUrl: result\.satellite/);
  });
});
