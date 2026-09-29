// POST /api/ops/digest — the external ops-cron → bell seam. Contract:
// 404 while the token is unset, 401 on mismatch, 409 while the in-app
// digest lane is off, 400 on a bad payload (FYI/FIRST are refused: only
// exceptions ring — owner 2026-09-11), 503 when no row landed, 201 with
// the row id (and deduped flag) otherwise. Every non-2xx is the caller's
// cue to email instead.

const mockNotifyAdmin = jest.fn();
const mockResolve = jest.fn();
const mockLockCalls = [];
const mockObservationUpdates = [];
const mockStanding = { row: null };
const mockClean = { row: null, error: null };
jest.mock('../models/db', () => {
  const builder = (table) => {
    const b = {};
    for (const m of ['where', 'whereRaw', 'orderBy', 'select']) b[m] = jest.fn(() => b);
    b.first = jest.fn(async () => {
      if (table === 'system_settings') {
        if (mockClean.error) throw mockClean.error;
        return mockClean.row;
      }
      return mockStanding.row;
    });
    b.update = jest.fn(async (changes) => { if (table === 'notifications') mockObservationUpdates.push(changes); return 1; });
    return b;
  };
  const trx = jest.fn((table) => builder(table));
  trx.raw = jest.fn((sql, bindings) => {
    if (/pg_advisory/.test(String(sql))) mockLockCalls.push(bindings);
    return { sql, bindings };
  });
  const db = jest.fn((table) => builder(table));
  db.raw = (sql, bindings) => ({ sql, bindings });
  db.transaction = jest.fn(async (fn) => fn(trx));
  return db;
});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
jest.mock('../services/ops-digest', () => {
  const actual = jest.requireActual('../services/ops-digest');
  return { ...actual, resolveOpsDigest: (...args) => mockResolve(...args) };
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const router = require('../routes/ops-digest-ingest');
const { validateDigest, KINDS } = router._private;

const TOKEN = 'ops-test-token-0123456789';

function lane(on) {
  process.env.GATE_OPS_DIGESTS_IN_APP = on ? 'true' : '';
  process.env.GATE_AGENT_ACTIVITY = on ? 'true' : '';
}

function appServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/ops/digest', router);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

const good = () => ({
  key: 'e22-schedule-integrity:overlaps-2026-09-11',
  kind: 'FIX',
  subject: 'schedule integrity — 3 overlapping visits',
  body: 'visit 0b9fce27 overlaps 11425c5f\nvisit 1a7f3f9a overlaps 1b0544b8',
  link: '/admin/agents?tab=activity',
  metadata: { check: { id: 'e22-schedule-integrity', title: 'Schedule integrity', cadence: 'daily' } },
});

let server; let baseUrl;
beforeEach(() => {
  mockNotifyAdmin.mockReset();
  mockResolve.mockReset();
  mockLockCalls.length = 0;
  mockObservationUpdates.length = 0;
  mockStanding.row = null;
  mockClean.row = null;
  mockClean.error = null;
  process.env.NODE_ENV = 'test';
  process.env.OPS_DIGEST_INGEST_TOKEN = TOKEN;
  lane(true);
  ({ server, baseUrl } = appServer());
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.OPS_DIGEST_INGEST_TOKEN;
});

async function post(body, { token = TOKEN } = {}) {
  const res = await fetch(`${baseUrl}/api/ops/digest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('auth and gates', () => {
  test('404 while the token is unset — the endpoint does not exist', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const { status, json } = await post(good());
    expect(status).toBe(404);
    // Same body an unknown route gets — nothing to distinguish it while dark.
    expect(json).toEqual({ error: 'Route not found: POST /api/ops/digest' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('every outcome carries the token-route privacy headers (no-store, noindex, no-referrer)', async () => {
    const headersOf = async (token) => {
      const res = await fetch(`${baseUrl}/api/ops/digest`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(good()) });
      return { status: res.status, cc: res.headers.get('cache-control'), robots: res.headers.get('x-robots-tag'), ref: res.headers.get('referrer-policy') };
    };
    mockNotifyAdmin.mockResolvedValue({ id: 'n-h', deduped: false });
    for (const [token, expected] of [[TOKEN, 201], ['nope', 401]]) {
      const h = await headersOf(token);
      expect(h.status).toBe(expected);
      expect(h.cc).toContain('no-store');
      expect(h.robots).toContain('noindex');
      expect(h.ref).toBe('no-referrer');
    }
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const dark = await headersOf('anything');
    expect(dark.status).toBe(404);
    expect(dark.cc).toContain('no-store');
    expect(dark.robots).toContain('noindex');
    expect(dark.ref).toBe('no-referrer');
  });

  test('the dark 404 sits ahead of the rate limiter, so a prober never sees a 429 while unset', () => {
    // Route-level order is the guarantee: darkUnlessConfigured is the first
    // handler on both POSTs (a production limiter would otherwise answer
    // 429 after 120 probes and reveal the route).
    const { darkUnlessConfigured, ingestAuth, ingestBodyErrorHandler } = router._private;
    for (const layer of router.stack.filter((l) => l.route)) {
      expect(layer.route.stack[0].handle).toBe(darkUnlessConfigured);
      // the limiter lives only in the pre-chain, so a request is counted once
      expect(layer.route.stack.map((l) => l.handle)).not.toContain(router.ingestPreParsers[2]);
    }
    // pre-chain order: privacy headers → dark → limiter → auth → parse → body errors
    const { noStore } = require('../middleware/no-store');
    expect(router.ingestPreParsers[0]).toBe(noStore);
    expect(router.ingestPreParsers[1]).toBe(darkUnlessConfigured);
    expect(router.ingestPreParsers[3]).toBe(ingestAuth);
    expect(router.ingestPreParsers[5]).toBe(ingestBodyErrorHandler);
    expect(router.ingestPreParsers).toHaveLength(6);
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    darkUnlessConfigured({}, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 on a wrong or missing bearer', async () => {
    expect((await post(good(), { token: 'nope' })).status).toBe(401);
    expect((await post(good(), { token: null })).status).toBe(401);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('409 while the in-app digest lane is off (either gate)', async () => {
    lane(false);
    expect((await post(good())).status).toBe(409);
    process.env.GATE_OPS_DIGESTS_IN_APP = 'true';
    process.env.GATE_AGENT_ACTIVITY = '';
    const { status, json } = await post(good());
    expect(status).toBe(409);
    expect(json.reason).toBe('in_app_disabled');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('payload', () => {
  test('exceptions only: FYI and FIRST are refused, FIX and ACT accepted (case-insensitive)', () => {
    expect([...KINDS].sort()).toEqual(['ACT', 'FIX']);
    expect(validateDigest({ ...good(), kind: 'FYI' }).error).toMatch(/FIX or ACT/);
    expect(validateDigest({ ...good(), kind: 'FIRST' }).error).toMatch(/FIX or ACT/);
    expect(validateDigest({ ...good(), kind: 'act' }).value.kind).toBe('ACT');
  });

  test('rejects a bad key, an empty subject/body, an off-portal link and oversized fields', () => {
    expect(validateDigest({ ...good(), key: 'has spaces' }).error).toMatch(/key/);
    expect(validateDigest({ ...good(), key: 'x'.repeat(121) }).error).toMatch(/key/);
    expect(validateDigest({ ...good(), subject: '   ' }).error).toMatch(/subject is required/);
    expect(validateDigest({ ...good(), subject: 's'.repeat(181) }).error).toMatch(/subject exceeds/);
    expect(validateDigest({ ...good(), body: '' }).error).toMatch(/body is required/);
    expect(validateDigest({ ...good(), body: 'b'.repeat(60001) }).error).toMatch(/body exceeds/);
    expect(validateDigest({ ...good(), link: 'https://evil.example/admin' }).error).toMatch(/\/admin path/);
    expect(validateDigest({ ...good(), link: '/customer/x' }).error).toMatch(/\/admin path/);
    expect(validateDigest({ ...good(), link: '/adminx' }).error).toMatch(/\/admin path/);
    expect(validateDigest({ ...good(), metadata: [1] }).error).toMatch(/metadata/);
    expect(validateDigest({ ...good(), metadata: { blob: 'm'.repeat(5000) } }).error).toMatch(/metadata exceeds/);
    expect(validateDigest('nope').error).toMatch(/JSON object/);
  });

  test('accepts /admin, /admin/, /admin?x and /admin#x links and a null link', () => {
    for (const link of ['/admin', '/admin/', '/admin?tab=x', '/admin#y', null]) {
      expect(validateDigest({ ...good(), link }).value.link).toBe(link);
    }
    expect(validateDigest({ ...good(), link: undefined }).value.link).toBe(null);
  });

  test('400 over HTTP with the reason and no bell write', async () => {
    const { status, json } = await post({ ...good(), kind: 'FYI' });
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid_payload');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('headline: optional, 60 chars max, trimmed, blank -> null', () => {
    expect(validateDigest({ ...good(), headline: 'Schedule — a call promise slipped' }).value.headline)
      .toBe('Schedule — a call promise slipped');
    expect(validateDigest({ ...good(), headline: '  ' }).value.headline).toBeNull();
    expect(validateDigest({ ...good() }).value.headline).toBeNull();
    expect(validateDigest({ ...good(), headline: 'h'.repeat(61) }).error).toMatch(/headline exceeds/);
  });

  test('count/newCount: an explicit null is rejected (only an omitted field falls back)', () => {
    expect(validateDigest({ ...good(), count: null }).error).toMatch(/count must be a non-negative integer/);
    expect(validateDigest({ ...good(), newCount: null }).error).toMatch(/newCount must be a non-negative integer/);
    expect(validateDigest({ ...good() }).error).toBeUndefined();
    expect(validateDigest({ ...good(), headline: 42 }).error).toMatch(/headline must be a string/);
  });

  test('summary: optional, 110 chars max, trimmed, blank -> null', () => {
    expect(validateDigest({ ...good(), summary: 'Oldest is 3 days.' }).value.summary).toBe('Oldest is 3 days.');
    expect(validateDigest({ ...good(), summary: '  ' }).value.summary).toBeNull();
    expect(validateDigest({ ...good(), summary: 's'.repeat(111) }).error).toMatch(/summary exceeds/);
    expect(validateDigest({ ...good(), summary: [] }).error).toMatch(/summary must be a string/);
  });

  test("audience: optional, one of owner/engineering/fyi", () => {
    for (const audience of ['owner', 'engineering', 'fyi']) {
      expect(validateDigest({ ...good(), audience }).value.audience).toBe(audience);
    }
    expect(validateDigest({ ...good() }).value.audience).toBeNull();
    expect(validateDigest({ ...good(), audience: 'urgent' }).error).toMatch(/audience must be/);
    // Trimmed like headline/summary; blank reads as omitted (the documented
    // contract — codex r2 P0 on #5236).
    expect(validateDigest({ ...good(), audience: ' owner ' }).value.audience).toBe('owner');
    expect(validateDigest({ ...good(), audience: '   ' }).value.audience).toBeNull();
    expect(validateDigest({ ...good(), audience: ' urgent ' }).error).toMatch(/audience must be/);
    expect(validateDigest({ ...good(), audience: 3 }).error).toMatch(/audience must be/);
  });
});

describe('the check -> destination map fills in what the caller did not send', () => {
  test('a mapped owner check gets its own area headline and its own admin page, overriding the caller\'s Activity-feed link', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-map', deduped: false });
    await post({ ...good(), key: 'b08-uncharged-collectibles:2026-09-11', link: '/admin/agents?tab=activity' });
    const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).toBe('Billing — schedule integrity — 3 overlapping visits');
    expect(opts.link).toBe('/admin/invoices');
    expect(opts.metadata.audience).toBe('owner');
    expect(opts.metadata.feed).toBeNull();
  });

  test('an unmapped ACT check with no caller link falls back to the Activity feed, owner audience', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-unmapped', deduped: false });
    await post({ ...good(), key: 'z99-brand-new-check:x', kind: 'ACT', link: undefined });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.link).toBe('/admin/agents?tab=activity');
    expect(opts.metadata.audience).toBe('owner');
    expect(opts.metadata.feed).toBeNull();
  });

  test('an unmapped FIX check is engineering-audience, Activity-only (good()\'s default kind)', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-unmapped-fix', deduped: false });
    await post({ ...good(), key: 'z99-brand-new-check:x' });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.audience).toBe('engineering');
    expect(opts.metadata.feed).toBe('activity');
  });

  test('the caller\'s own headline/summary/audience always win over the map', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-override', deduped: false });
    await post({
      ...good(), key: 'b08-uncharged-collectibles:2026-09-11',
      headline: 'Billing — 5 invoices never charged', summary: '$1,253.75 with a card on file.', audience: 'fyi',
    });
    const [, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).toBe('Billing — 5 invoices never charged');
    expect(body).toBe('$1,253.75 with a card on file.');
    expect(opts.metadata.audience).toBe('fyi');
    expect(opts.metadata.feed).toBe('activity');
  });

  test('the data-hygiene sweep\'s own headline(subject) parser wins over the generic fallback', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-hygiene', deduped: false });
    await post({
      ...good(), key: 'local:data-hygiene_sweep_2_fixed_66_exceptions_2_new_',
      subject: 'data-hygiene sweep — 3 fixed, 66 exceptions (2 new)',
      link: undefined,
    });
    const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).toBe('Data hygiene — 2 new issues, 66 open');
    expect(opts.link).toBe('/admin/agents?tab=activity'); // no better page than Activity for hygiene
  });

  // admin-alerts-ring scope (2026-09-28): the data-hygiene sweep's own
  // subject already carries count + newCount ("N fixed, M exceptions (K
  // new)") via config/ops-alert-routes.js's dataHygieneCounts — a "(0 new)"
  // day with the SAME backlog size as the standing comparison row goes
  // quiet; a "(2 new)" day always rings, whatever the backlog size did.
  describe('data-hygiene end to end: "(K new)" drives the ring decision', () => {
    test('"(0 new)" with an unchanged backlog size goes quiet — Activity-only, not new bell news', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-hygiene-quiet', deduped: false });
      mockStanding.row = { metadata: { count: 63 } }; // the last RUNG row's own backlog size
      await post({
        ...good(), key: 'local:data-hygiene_sweep_1_fixed_63_exceptions_0_new_',
        subject: 'data-hygiene sweep — 1 fixed, 63 exceptions (0 new)',
        link: undefined,
      });
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.count).toBe(63);
      expect(opts.metadata.newCount).toBe(0);
      expect(opts.metadata.quiet).toBe(true);
      expect(opts.metadata.feed).toBe('activity'); // out of the bell list/unread count/read-all
    });

    test('"(2 new)" rings, even against the same or a larger standing backlog', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-hygiene-ring', deduped: false });
      mockStanding.row = { metadata: { count: 66 } };
      await post({
        ...good(), key: 'local:data-hygiene_sweep_3_fixed_66_exceptions_2_new_',
        subject: 'data-hygiene sweep — 3 fixed, 66 exceptions (2 new)',
        link: undefined,
      });
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.count).toBe(66);
      expect(opts.metadata.newCount).toBe(2);
      expect(opts.metadata.quiet).toBe(false);
      expect(opts.metadata.feed).toBeNull(); // reaches the bell
    });

    test('a caller-supplied count/newCount always wins over the subject parse', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-hygiene-override', deduped: false });
      mockStanding.row = { metadata: { count: 63 } };
      await post({
        ...good(), key: 'local:data-hygiene_sweep_1_fixed_63_exceptions_0_new_',
        subject: 'data-hygiene sweep — 1 fixed, 63 exceptions (0 new)',
        link: undefined,
        count: 90,
        newCount: 5,
      });
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.count).toBe(90);
      expect(opts.metadata.newCount).toBe(5);
      expect(opts.metadata.quiet).toBe(false);
    });

    test('no standing row at all — the first post-deploy row for this class — rings once', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-hygiene-first', deduped: false });
      mockStanding.row = null;
      await post({
        ...good(), key: 'local:data-hygiene_sweep_1_fixed_63_exceptions_0_new_',
        subject: 'data-hygiene sweep — 1 fixed, 63 exceptions (0 new)',
        link: undefined,
      });
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.quiet).toBe(false);
      expect(opts.metadata.feed).toBeNull();
    });

    // The FRESH-insert `quiet` above (decideRingForNewRow's 7-day lookback)
    // and a REFRESH of an existing dedupeKey row (ringOnRefreshFrom, wired
    // as opts.ringOnRefresh) are two different decisions — a refresh that
    // rings must never end up hidden, and a quiet refresh must keep the
    // standing row's own visibility (notification-service.js's
    // mergeRefreshMetadata, unit-tested directly in
    // notification-admin-dedupe-refresh.test.js). Here: the wired function
    // itself, invoked against a fabricated existing row, agrees.
    test('the wired ringOnRefresh rings when the backlog grew past the existing row, stays quiet when it did not', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-hygiene-refresh', deduped: true, refreshed: true });
      // "(0 new)" isolates the count-only comparison (newCount > 0 would
      // otherwise always ring on its own, masking the count test below).
      await post({
        ...good(), key: 'local:data-hygiene_sweep_1_fixed_66_exceptions_0_new_',
        subject: 'data-hygiene sweep — 1 fixed, 66 exceptions (0 new)',
        link: undefined,
      });
      const { ringOnRefresh } = mockNotifyAdmin.mock.calls[0][3];
      expect(ringOnRefresh({}, { count: 60 })).toBe(true); // backlog grew (60 -> 66)
      expect(ringOnRefresh({}, { count: 66 })).toBe(false); // flat — the existing row's own visibility stands
    });

    test('an engineering-audience refresh gets no ringOnRefresh — notifyAdmin default re-surfaces any content change', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-eng-refresh', deduped: true, refreshed: true });
      await post({ ...good(), key: 'z98-engineering-check:x', subject: '4 jobs failed', audience: 'engineering', link: undefined });
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.audience).toBe('engineering');
      expect(opts).not.toHaveProperty('ringOnRefresh');
    });
  });

  // Follow-up to #5269 (codex r8 P1): e22's key is JUST `<check-id>:<finding>
  // -<date>` — nothing else variable — so it collapses to the alert class
  // once the date is stripped and proves nothing about which visits the
  // finding names. `itemIds` lets the check hand over that identity itself.
  describe('date-only ops-cron keys: itemIds carries the identity the key cannot', () => {
    const { itemSetHashFor } = require('../services/ops-digest');

    test('no count, no itemIds, a prior rung row of the same class -> rings (key alone proves nothing)', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-e22-i', deduped: false });
      mockStanding.row = { metadata: { opsKey: 'e22-schedule-integrity:overlaps-2026-09-10' } };
      await post(good()); // key: overlaps-2026-09-11 — same alertClass, subject has no leading count
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.quiet).toBe(false);
      expect(opts.metadata.feed).toBeNull();
    });

    test('itemIds naming the same visits as the prior row -> quiet', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-e22-ii', deduped: false });
      mockStanding.row = {
        metadata: {
          opsKey: 'e22-schedule-integrity:overlaps-2026-09-10',
          itemKeys: ['0b9fce27', '11425c5f'],
          itemSetHash: itemSetHashFor(['0b9fce27', '11425c5f']),
        },
      };
      await post({ ...good(), itemIds: ['0b9fce27', '11425c5f'] });
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.quiet).toBe(true);
      expect(opts.metadata.feed).toBe('activity');
      expect(opts.metadata.itemKeys).toEqual(['0b9fce27', '11425c5f']);
      expect(opts.metadata.itemSetHash).toBe(itemSetHashFor(['0b9fce27', '11425c5f']));
    });

    test('itemIds with one new id at an equal (absent) count -> rings', async () => {
      mockNotifyAdmin.mockResolvedValue({ id: 'n-e22-iii', deduped: false });
      mockStanding.row = {
        metadata: {
          opsKey: 'e22-schedule-integrity:overlaps-2026-09-10',
          itemKeys: ['0b9fce27', '11425c5f'],
          itemSetHash: itemSetHashFor(['0b9fce27', '11425c5f']),
        },
      };
      await post({ ...good(), itemIds: ['0b9fce27', '1a7f3f9a'] }); // 1a7f3f9a is new
      const opts = mockNotifyAdmin.mock.calls[0][3];
      expect(opts.metadata.quiet).toBe(false);
    });

    test('invalid itemIds -> 400', async () => {
      expect((await post({ ...good(), itemIds: 'not-an-array' })).status).toBe(400);
      expect((await post({ ...good(), itemIds: null })).status).toBe(400);
      expect((await post({ ...good(), itemIds: [123] })).status).toBe(400);
      expect((await post({ ...good(), itemIds: [''] })).status).toBe(400);
      expect((await post({ ...good(), itemIds: ['x'.repeat(201)] })).status).toBe(400);
      expect((await post({ ...good(), itemIds: Array.from({ length: 2001 }, (_, i) => `id-${i}`) })).status).toBe(400);
      expect(mockNotifyAdmin).not.toHaveBeenCalled();
    });
  });

  // For an unmapped check with no route.counts(), the generic fallback is
  // the first integer anywhere in the subject (never a newCount — a bare
  // number's meaning isn't safely guessable for an unconverted check).
  test('an unmapped check with no caller count falls back to the first integer in the subject', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-generic-count', deduped: false });
    await post({ ...good(), key: 'z99-brand-new-check:x', subject: '7 things need attention', link: undefined });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.count).toBe(7);
    expect(opts.metadata.newCount).toBeUndefined();
  });

  test('title never carries the KIND: prefix any more — kind rides in metadata only', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-noprefix', deduped: false });
    await post(good());
    const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).not.toMatch(/^(ACT|FIX):/);
    expect(opts.metadata.kind).toBe('FIX');
  });
});

describe('count fallback: only a LEADING number is a count', () => {
  const { firstIntegerInSubject } = router._private;
  test('a leading count is read; a date or time further in is not', () => {
    expect(firstIntegerInSubject('42 scheduled-visit pair(s) overlap')).toBe(42);
    expect(firstIntegerInSubject('promised on a call, NOT on the calendar — Mon 09-28 10:00 (…2108)')).toBeNull();
    expect(firstIntegerInSubject('Drafts/call pipelines quiet: 47 stale draft(s)')).toBeNull();
    expect(firstIntegerInSubject('')).toBeNull();
  });
});

// admin-alerts-ring-v2 follow-up: count and newCount resolve INDEPENDENTLY
// — a caller who supplies one but not the other must still get the
// check-map's own value for the missing one, not have it replaced by the
// parser's count (or dropped to null) just because the OTHER field was given.
describe('resolveCounts: count and newCount resolve independently', () => {
  const { resolveCounts } = router._private;
  const dataHygieneSubject = 'Data hygiene sweep — 63 fixed, 66 exceptions (2 new)';
  const dataHygieneRoute = { counts: (subject) => {
    const m = /—\s*\d+\s+fixed,\s*(\d+)\s+exceptions?\s*\((\d+)\s+new\)/i.exec(subject);
    return m ? { count: Number(m[1]), newCount: Number(m[2]) } : null;
  } };
  const noCountsRoute = { counts: null };

  test('newCount alone: count still resolves from the check-map, not replaced by the parser or dropped to null', () => {
    const result = resolveCounts({ count: null, newCount: 1, subject: dataHygieneSubject, route: dataHygieneRoute });
    expect(result).toEqual({ count: 66, newCount: 1 });
  });

  test('count alone: newCount still resolves from the check-map', () => {
    const result = resolveCounts({ count: 999, newCount: null, subject: dataHygieneSubject, route: dataHygieneRoute });
    expect(result).toEqual({ count: 999, newCount: 2 });
  });

  test('neither given: both resolve from the check-map', () => {
    const result = resolveCounts({ count: null, newCount: null, subject: dataHygieneSubject, route: dataHygieneRoute });
    expect(result).toEqual({ count: 66, newCount: 2 });
  });

  test('both given: both are the caller\'s own values, verbatim', () => {
    const result = resolveCounts({ count: 5, newCount: 1, subject: dataHygieneSubject, route: dataHygieneRoute });
    expect(result).toEqual({ count: 5, newCount: 1 });
  });

  test('an unmapped check with no counts(): count falls back to the leading integer, newCount stays null even with a leading number', () => {
    const result = resolveCounts({ count: null, newCount: null, subject: '42 scheduled-visit pair(s) overlap', route: noCountsRoute });
    expect(result).toEqual({ count: 42, newCount: null });
  });
});

describe('bell write', () => {
  test('201: one ops_digest row, bell:true, opsKey/subject/kind/audience/source metadata, rolling-day dedupe', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n1', deduped: false });
    const { status, json } = await post(good());
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, id: 'n1', deduped: false });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('ops_digest');
    // No caller headline and no prefix on the title any more (admin-alerts-
    // brevity scope) — the check-map's own area ("e22-schedule-integrity" ->
    // Schedule) fills the fallback `${area} — ${subject}`.
    expect(title).toBe('Schedule — schedule integrity — 3 overlapping visits');
    // No caller summary -> no bell body; the whole report is in `detail`.
    expect(body).toBeNull();
    expect(opts.detail).toBe('visit 0b9fce27 overlaps 11425c5f\nvisit 1a7f3f9a overlaps 1b0544b8');
    expect(opts).toEqual({
      // The caller's own link was the Activity feed itself, so the
      // check-map's more specific page (Schedule -> /admin/dispatch) wins.
      link: '/admin/dispatch',
      bell: true,
      detail: 'visit 0b9fce27 overlaps 11425c5f\nvisit 1a7f3f9a overlaps 1b0544b8',
      dedupeKey: 'ops-crons:e22-schedule-integrity:overlaps-2026-09-11',
      dedupeWindowMs: 24 * 60 * 60 * 1000,
      // a later run's recurrence refreshes the standing row (observedAt above all)
      refreshOnDedupe: true,
      // admin-alerts-ring scope: the ring-only-on-change decision for the
      // dedupeKey's refresh path (never exercised on this FIRST insert).
      ringOnRefresh: expect.any(Function),
      dedupeVersion: undefined,
      // probe + write share one advisory-locked transaction
      trx: expect.anything(),
      metadata: {
        check: { id: 'e22-schedule-integrity', title: 'Schedule integrity', cadence: 'daily' },
        opsKey: 'e22-schedule-integrity:overlaps-2026-09-11',
        subject: 'schedule integrity — 3 overlapping visits',
        kind: 'FIX',
        // e22-schedule-integrity is a mapped OWNER check (Schedule ->
        // /admin/dispatch), so this FIX finding still rings the bell.
        audience: 'owner',
        feed: null,
        source: 'ops-crons',
        observedAt: expect.any(String),
        // admin-alerts-ring scope: the check id survives, its generated
        // hash/date suffix is trimmed. No caller count, and this subject
        // doesn't LEAD with a number, so no count is stored; this first-ever
        // row for the class has no prior row to compare — rings.
        alertClass: 'e22-schedule-integrity:overlaps',
        quiet: false,
        // admin-alerts-ring-v2 follow-up: a fresh insert that rings (not
        // quiet) stamps its own rungAt — findPriorRungRow's 7-day baseline
        // reads this, not created_at.
        rungAt: expect.any(String),
      },
    });
  });

  test('the write takes the dedupe advisory lock first — the same one /resolve takes', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-lock', deduped: false });
    await post(good());
    expect(mockLockCalls).toEqual([['admin:ops-crons:e22-schedule-integrity:overlaps-2026-09-11']]);
  });

  test('a DELAYED re-post cannot replace newer content or re-bell it', async () => {
    // A recurrence already raised the standing row to 14:00.
    mockStanding.row = { created_at: new Date('2026-09-11T10:00:00Z'), observed_at: '2026-09-11T14:00:00.000Z' };
    const result = await post({ ...good(), subject: 'older finding', body: 'old body', link: '/admin/old', observedAt: '2026-09-11T12:00:00Z' });
    expect(result).toEqual({ status: 200, json: { ok: true, stale: true } });
    // notifyAdmin refreshes a deduped row when CONTENT differs even if the
    // version is clamped. Skipping it protects the 14:00 row's body/read state.
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a timestamp-less response-loss retry preserves the standing version', async () => {
    const payload = good();
    const stamp = '2026-09-11T11:00:00.000Z';
    mockStanding.row = { created_at: stamp, observed_at: stamp, dedupe_version: stamp,
      title: `FIX: ${payload.subject}`, body: payload.body, link: payload.link };
    mockNotifyAdmin.mockResolvedValue({ id: 'n-read', deduped: true });
    await post(payload);
    expect(mockNotifyAdmin.mock.calls[0][3].dedupeVersion).toBeUndefined();
    expect(mockObservationUpdates).toHaveLength(1);
    expect(Object.keys(mockObservationUpdates[0])).toEqual(['metadata']);
    expect(Date.parse(mockObservationUpdates[0].metadata.bindings[0])).toBeGreaterThan(Date.parse(stamp));
  });

  test('a LATER run raises the observation and so rewrites the standing row', async () => {
    mockStanding.row = { created_at: new Date('2026-09-11T10:00:00Z'), observed_at: '2026-09-11T11:00:00.000Z' };
    mockNotifyAdmin.mockResolvedValue({ id: 'n-new', deduped: true, refreshed: true });
    await post({ ...good(), observedAt: '2026-09-11T13:00:00Z' });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.observedAt).toBe('2026-09-11T13:00:00.000Z');
    expect(opts.dedupeVersion).toBe('2026-09-11T13:00:00.000Z');
  });

  test('a ringing row stamps rungAt at delivery time, never its (possibly old) observedAt', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-old-obs', deduped: false });
    await post({ ...good(), observedAt: '2026-09-11T13:00:00Z' });
    const { metadata } = mockNotifyAdmin.mock.calls[0][3];
    expect(metadata.quiet).toBe(false);
    expect(metadata.observedAt).toBe('2026-09-11T13:00:00.000Z');
    expect(Date.now() - Date.parse(metadata.rungAt)).toBeLessThan(60_000);
  });

  test('T2 clean with zero standing rows suppresses delayed T1 but permits later T3', async () => {
    mockClean.row = { value: '2026-09-11T12:00:00.000Z' };
    const stale = await post({ ...good(), observedAt: '2026-09-11T11:00:00Z' });
    expect(stale).toEqual({ status: 200, json: { ok: true, stale: true } });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    mockNotifyAdmin.mockResolvedValue({ id: 'n-t3', deduped: false });
    const later = await post({ ...good(), observedAt: '2026-09-11T13:00:00Z' });
    expect(later).toEqual({ status: 201, json: { ok: true, id: 'n-t3', deduped: false } });
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.observedAt).toBe('2026-09-11T13:00:00.000Z');
  });

  test('a failed watermark read is retryable, never an acknowledged stale or bell write', async () => {
    mockClean.error = new Error('system settings unavailable');
    const result = await post({ ...good(), observedAt: '2026-09-11T11:00:00Z' });
    expect(result).toEqual({ status: 503, json: { ok: false, reason: 'bell_write_failed' } });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('laterOf and the standing probe: no standing row, unparsable or missing observation all fall back to the incoming value', async () => {
    const { laterOf } = router._private;
    expect(laterOf(null, '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf(undefined, '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf('nonsense', '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf('2026-09-11T09:00:00.000Z', '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T12:00:00.000Z');
    expect(laterOf(new Date('2026-09-11T15:00:00Z'), '2026-09-11T12:00:00.000Z')).toBe('2026-09-11T15:00:00.000Z');
  });

  test('201 with deduped:true when the keyed row already stands', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n-old', deduped: true });
    const { status, json } = await post(good());
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, id: 'n-old', deduped: true });
  });

  test('503 when the write returns null, a suppression sentinel, or throws', async () => {
    mockNotifyAdmin.mockResolvedValueOnce(null);
    expect((await post(good())).status).toBe(503);
    mockNotifyAdmin.mockResolvedValueOnce({ id: null, suppressed: true });
    expect((await post(good())).status).toBe(503);
    mockNotifyAdmin.mockRejectedValueOnce(new Error('db down'));
    const { status, json } = await post(good());
    expect(status).toBe(503);
    expect(json).toEqual({ ok: false, reason: 'bell_write_failed' });
  });

  test('observedAt: caller ISO timestamp is honoured, future or garbage falls back to now, and it is seam-owned', () => {
    const { observedAtFrom } = router._private;
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    expect(observedAtFrom('2026-09-11T11:10:00Z', now)).toBe('2026-09-11T11:10:00.000Z');
    expect(observedAtFrom('2027-01-01T00:00:00Z', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(observedAtFrom('nope', now)).toBe('2026-09-11T12:00:00.000Z');
    expect(observedAtFrom(undefined, now)).toBe('2026-09-11T12:00:00.000Z');
    expect(validateDigest({ ...good(), observedAt: '2026-09-11T11:10:00Z', metadata: { observedAt: 'spoof' } }).value.metadata).toEqual({});
  });

  test('resolve passes the clean run observation as notAfter', async () => {
    mockResolve.mockResolvedValue(1);
    const res = await fetch(`${baseUrl}/api/ops/digest/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ key: 'k1', observedAt: '2026-09-11T11:10:00Z' }) });
    expect(res.status).toBe(200);
    expect(mockResolve.mock.calls[0][0].notAfter).toBe('2026-09-11T11:10:00.000Z');
  });

  test('metadata cannot override the seam fields or pre-resolve the finding', async () => {
    mockNotifyAdmin.mockResolvedValue({ id: 'n2', deduped: false });
    await post({ ...good(), metadata: { source: 'spoof', opsKey: 'spoof', kind: 'FYI', audience: 'fyi', feed: 'not-activity', resolved: true, resolvedAt: 'x', resolvedBy: 'y', dedupeKey: 'z', rungAt: 'spoof', keep: 1 } });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata).toEqual({
      keep: 1,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11',
      subject: 'schedule integrity — 3 overlapping visits',
      kind: 'FIX',
      audience: 'owner',
      feed: null,
      source: 'ops-crons',
      observedAt: expect.any(String),
      alertClass: 'e22-schedule-integrity:overlaps',
      quiet: false,
      // admin-alerts-ring-v2 follow-up: the route's own stamp, not the
      // caller's spoofed value (RESERVED_METADATA_KEYS strips it above).
      rungAt: expect.any(String),
    });
    expect(opts.metadata.resolved).toBeUndefined();
    expect(opts.metadata.rungAt).not.toBe('spoof');
    expect(validateDigest({ ...good(), metadata: { resolved: true } }).value.metadata).toEqual({});
  });
});

describe('POST /resolve (fall-off rule)', () => {
  async function resolve(body, { token = TOKEN } = {}) {
    const res = await fetch(`${baseUrl}/api/ops/digest/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  test('same auth as ingest: 404 unset (generic body), 401 mismatch', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const dark = await resolve({ key: 'k' });
    expect(dark.status).toBe(404);
    expect(dark.json).toEqual({ error: 'Route not found: POST /api/ops/digest/resolve' });
    process.env.OPS_DIGEST_INGEST_TOKEN = TOKEN;
    expect((await resolve({ key: 'k' }, { token: 'nope' })).status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('retires the key scoped to source ops-crons and reports the count; works with the lane off', async () => {
    lane(false); // retiring history must not depend on the ingest lane
    mockResolve.mockResolvedValue(2);
    const { status, json } = await resolve({ key: 'e22-schedule-integrity:overlaps', successes: 3 });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, resolved: 2 });
    expect(mockResolve).toHaveBeenCalledWith({ key: 'e22-schedule-integrity:overlaps', source: 'ops-crons', lockKey: 'ops-crons:e22-schedule-integrity:overlaps', notAfter: expect.any(String), resolvedBy: 'ops-crons:3-clean-runs', throwOnError: true });
  });

  test('nothing standing is still a 200 with resolved 0; bad key is 400', async () => {
    mockResolve.mockResolvedValue(0);
    expect((await resolve({ key: 'never-rang' })).json).toEqual({ ok: true, resolved: 0 });
    expect(mockResolve).toHaveBeenCalledWith({ key: 'never-rang', source: 'ops-crons', lockKey: 'ops-crons:never-rang', notAfter: expect.any(String), resolvedBy: 'ops-crons', throwOnError: true });
    expect((await resolve({ key: 'has spaces' })).status).toBe(400);
    expect((await resolve({})).status).toBe(400);
  });

  test('a failed clean resolution returns 503 so the caller can retry', async () => {
    mockResolve.mockRejectedValue(new Error('settings write failed'));
    expect(await resolve({ key: 'never-rang' })).toEqual({ status: 503, json: { ok: false, reason: 'resolve_failed' } });
  });
});

describe('dark 404 body equals the app-level unknown-route body', () => {
  test('genericNotFound, the router and the pre-router gate all emit exactly what middleware/errors.js notFound emits', async () => {
    const { notFound } = require('../middleware/errors');
    const { genericNotFound } = router._private;
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const capture = () => { const r = { status: jest.fn(() => r), json: jest.fn(() => r) }; return r; };
    const req = { method: 'POST', originalUrl: '/api/ops/digest?x=1', path: '/api/ops/digest' };
    const a = capture(); notFound(req, a);
    const b = capture(); genericNotFound({ ...req, path: '/' }, b); // inside the mounted router req.path is the remainder
    expect(b.json.mock.calls[0][0]).toEqual(a.json.mock.calls[0][0]);
    // and over HTTP: an unknown sibling path through the real notFound vs the dark route
    const app = express();
    app.use('/api/ops/digest', ...router.ingestPreParsers);
    app.use('/api/ops/digest', router);
    app.use(notFound);
    const s2 = app.listen(0); const base = `http://127.0.0.1:${s2.address().port}`;
    try {
      const dark = await (await fetch(`${base}/api/ops/digest`, { method: 'POST' })).json();
      const unknown = await (await fetch(`${base}/api/ops/nothing`, { method: 'POST' })).json();
      expect(Object.keys(dark)).toEqual(Object.keys(unknown));
      expect(dark.error.replace('/api/ops/digest', '/api/ops/nothing')).toBe(unknown.error);
    } finally { await new Promise((r) => s2.close(r)); }
  });
});

describe('pre-parser chain (mounted ahead of the global JSON parser, like server/index.js)', () => {
  function chainServer() {
    const app = express();
    app.use('/api/ops/digest', ...router.ingestPreParsers);
    app.use(express.json({ limit: '1mb' })); // the "global" parser comes AFTER
    app.use('/api/ops/digest', router);
    const server = app.listen(0);
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
  }
  async function raw(baseUrl, body, token) {
    const res = await fetch(`${baseUrl}/api/ops/digest`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
    let json = null; try { json = await res.json(); } catch { /* html */ }
    return { status: res.status, json };
  }

  test('token unset + malformed body → generic 404, never 400', async () => {
    delete process.env.OPS_DIGEST_INGEST_TOKEN;
    const { server: s2, baseUrl } = chainServer();
    try {
      const out = await raw(baseUrl, '{not json', 'anything');
      expect(out.status).toBe(404);
      expect(out.json).toEqual({ error: 'Route not found: POST /api/ops/digest' });
    } finally { await new Promise((r) => s2.close(r)); }
  });

  test('token set + wrong bearer + malformed body → 401 (auth before parse)', async () => {
    const { server: s2, baseUrl } = chainServer();
    try {
      expect((await raw(baseUrl, '{not json', 'nope')).status).toBe(401);
      expect((await raw(baseUrl, '{not json', null)).status).toBe(401);
    } finally { await new Promise((r) => s2.close(r)); }
  });

  test('token set + right bearer + malformed body → 400 JSON from the chain handler', async () => {
    const { server: s2, baseUrl } = chainServer();
    try {
      const out = await raw(baseUrl, '{not json', TOKEN);
      expect(out.status).toBe(400);
      expect(out.json).toEqual({ ok: false, reason: 'invalid_json' });
      const big = await raw(baseUrl, JSON.stringify({ ...good(), body: 'x'.repeat(1100 * 1024) }), TOKEN);
      expect(big.status).toBe(413);
      expect(big.json).toEqual({ ok: false, reason: 'payload_too_large' });
    } finally { await new Promise((r) => s2.close(r)); }
  });
});

describe('server/index.js mount order (unobservable-when-dark)', () => {
  // The route contract promises a plain 404 while the token is unset, at any
  // request volume and for any body. That holds only if the pre-router gate
  // is mounted BEFORE the global /api/ limiter and BEFORE the global JSON
  // parser. The real app boots a server + DB, so this pins the ORDER
  // statically from the entrypoint source instead (pre-push P1 on #4397).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  test('the /api/ops/digest dark gate precedes the global cors(), the global /api/ limiter, the global JSON parser, and the router mount', () => {
    const gate = at("app.use('/api/ops/digest', require('./middleware/no-store').noStore, (req, res, next) => {");
    expect(src.slice(gate, gate + 600)).toContain('OPS_DIGEST_INGEST_TOKEN');
    // an OPTIONS preflight must hit the dark 404 before cors() can answer 204
    expect(gate).toBeLessThan(at("app.use(cors({"));
    expect(gate).toBeLessThan(at("app.use('/api/', limiter);"));
    expect(gate).toBeLessThan(at("app.use(express.json({ limit: '1mb'"));
    expect(gate).toBeLessThan(at("app.use('/api/ops/digest', require('./routes/ops-digest-ingest'));"));
  });

  test('the ingest pre-parser chain is mounted before the global JSON parser and before the router', () => {
    const pre = at("app.use('/api/ops/digest', ...require('./routes/ops-digest-ingest').ingestPreParsers);");
    expect(pre).toBeLessThan(at("app.use(express.json({ limit: '1mb'"));
    expect(pre).toBeLessThan(at("app.use('/api/ops/digest', require('./routes/ops-digest-ingest'));"));
    expect(pre).toBeGreaterThan(at("app.use('/api/', limiter);"));
  });
});
