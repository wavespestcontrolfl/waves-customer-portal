/**
 * Live official-page reverification — dark behind NEWSLETTER_LIVE_REVERIFY.
 * Fail-closed ONLY on confirmed dead-event evidence; infra flake and SSRF
 * refusals pass for the EVENT (the fetch simply doesn't happen).
 */

const {
  reverifyEnabled,
  reverifyEvent,
  reverifyEvents,
  deadTextNearTitle,
  assertPublicHttpUrl,
  distinctiveTitleWords,
} = require('../services/event-reverify');

const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Inaugural Racer and Creator Expo',
  event_url: 'https://tickets.example/race-expo',
};

// DNS stub resolving every host to a public address.
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

afterEach(() => { delete process.env.NEWSLETTER_LIVE_REVERIFY; });

// Pinned-GET stub — reverifyEvent never touches global fetch; the
// transport is injected so tests exercise the verdict logic.
const mockGet = (status, text = '', location = null) => jest.fn(async () => ({ status, text, location }));

describe('gate', () => {
  test('default OFF — reverifyEvents passes everything without fetching', async () => {
    delete process.env.NEWSLETTER_LIVE_REVERIFY;
    expect(reverifyEnabled()).toBe(false);
    const get = mockGet(200);
    const result = await reverifyEvents([EVENT], { lookup: publicLookup, get });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  test('only the literal string true enables it', () => {
    process.env.NEWSLETTER_LIVE_REVERIFY = '1';
    expect(reverifyEnabled()).toBe(false);
    process.env.NEWSLETTER_LIVE_REVERIFY = 'true';
    expect(reverifyEnabled()).toBe(true);
  });
});

describe('SSRF guard (assertPublicHttpUrl)', () => {
  test('refuses non-http protocols and unparseable urls', async () => {
    expect((await assertPublicHttpUrl('file:///etc/passwd')).ok).toBe(false);
    expect((await assertPublicHttpUrl('gopher://x.example/')).ok).toBe(false);
    expect((await assertPublicHttpUrl('not a url')).ok).toBe(false);
  });

  test('refuses literal private, loopback, link-local/metadata, and CGNAT addresses', async () => {
    for (const target of [
      'http://127.0.0.1/x', 'http://10.1.2.3/', 'http://172.16.0.9/',
      'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::1]/',
      'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:10.0.0.1]/',
      // Global-unicast allowlist posture: benchmark, IETF-protocol,
      // reserved, broadcast, v6 multicast, deprecated site-local — and
      // v4-mapped even to public space (a real venue AAAA is 2000::/3).
      'http://198.18.0.9/', 'http://192.0.0.8/', 'http://240.0.0.1/',
      'http://255.255.255.255/', 'http://[ff05::1]/', 'http://[fec0::1]/',
      'http://[::ffff:8.8.8.8]/',
    ]) {
      const verdict = await assertPublicHttpUrl(target);
      expect(verdict.ok).toBe(false);
    }
  });

  test('refuses hostnames that RESOLVE to private space; allows public resolution', async () => {
    const evil = async () => [{ address: '169.254.169.254', family: 4 }];
    expect((await assertPublicHttpUrl('https://evil.example/', { lookup: evil })).ok).toBe(false);
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    expect((await assertPublicHttpUrl('https://mixed.example/', { lookup: mixed })).ok).toBe(false);
    expect((await assertPublicHttpUrl('https://good.example/', { lookup: publicLookup })).ok).toBe(true);
  });

  test('a refused fetch fails OPEN for the event — SSRF refusal is not dead-event evidence', async () => {
    process.env.NEWSLETTER_LIVE_REVERIFY = 'true';
    const get = mockGet(200);
    const verdict = await reverifyEvent(
      { ...EVENT, event_url: 'http://169.254.169.254/latest/meta-data' },
      { get },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain('refused');
    expect(get).not.toHaveBeenCalled();
  });

  test('the vetted address is PINNED — the transport receives exactly what validation resolved', async () => {
    process.env.NEWSLETTER_LIVE_REVERIFY = 'true';
    const get = mockGet(200, 'fine');
    await reverifyEvent(EVENT, { lookup: publicLookup, get });
    expect(get).toHaveBeenCalledTimes(1);
    const [urlObj, address, family] = get.mock.calls[0];
    expect(urlObj.hostname).toBe('tickets.example');
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });
});

describe('deadTextNearTitle (distinctive-token rule)', () => {
  test('cancellation near multiple distinctive title tokens is evidence', () => {
    const page = 'The Inaugural Racer and Creator Expo has been cancelled due to weather.';
    expect(deadTextNearTitle(page, EVENT.title)).toBe(true);
  });

  test('a bare "cancelled" elsewhere on a listing page is NOT evidence about this event', () => {
    const page = `Some other show was cancelled last month. ${'x'.repeat(2000)} Racer and Creator Expo — Saturday 9 AM, tickets available.`;
    expect(deadTextNearTitle(page, EVENT.title)).toBe(false);
  });

  test('generic-only words near a cancellation are not evidence ("event", "expo", "show")', () => {
    expect(distinctiveTitleWords('Summer Music Festival Night')).toEqual([]);
    expect(deadTextNearTitle('The festival event was cancelled', 'Summer Music Festival Night')).toBe(false);
    // One distinctive word alone on a multi-distinctive title is not enough.
    expect(deadTextNearTitle('A racer event was cancelled nearby', EVENT.title)).toBe(false);
  });

  test('tokens match as WHOLE words — "race" inside "bracelet" is not a hit', () => {
    expect(deadTextNearTitle('The Bracelet Workshop has been cancelled', 'Race Expo Tampa')).toBe(false);
    expect(deadTextNearTitle('The Tampa Race was cancelled', 'Race Expo Tampa')).toBe(true);
  });

  test('postponed counts; empty titles fail open', () => {
    expect(deadTextNearTitle('Racer Creator Expo postponed to October', EVENT.title)).toBe(true);
    expect(deadTextNearTitle('everything cancelled', '')).toBe(false);
  });
});

describe('reverifyEvent verdicts (gate on, DNS + transport stubbed)', () => {
  beforeEach(() => { process.env.NEWSLETTER_LIVE_REVERIFY = 'true'; });
  const opts = (get) => ({ lookup: publicLookup, get });

  test('404/410 = page gone = fail closed', async () => {
    const result = await reverifyEvent(EVENT, opts(mockGet(404)));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('404');
  });

  test('cancellation near title = fail closed', async () => {
    const get = mockGet(200, '<h1>Inaugural Racer and Creator Expo</h1><p>This event has been cancelled.</p>');
    const result = await reverifyEvent(EVENT, opts(get));
    expect(result.ok).toBe(false);
  });

  test('403/5xx/timeout = infra flake = pass with a note', async () => {
    expect((await reverifyEvent(EVENT, opts(mockGet(403)))).ok).toBe(true);
    expect((await reverifyEvent(EVENT, opts(mockGet(503)))).ok).toBe(true);
    const throwing = jest.fn(async () => { const e = new Error('boom'); e.name = 'AbortError'; throw e; });
    const timeout = await reverifyEvent(EVENT, opts(throwing));
    expect(timeout.ok).toBe(true);
    expect(timeout.note).toContain('timeout');
  });

  test('healthy page passes clean; missing url passes', async () => {
    const get = mockGet(200, '<h1>Racer and Creator Expo</h1> Saturday 9 AM');
    expect((await reverifyEvent(EVENT, opts(get))).ok).toBe(true);
    expect((await reverifyEvent({ ...EVENT, event_url: null }, opts(get))).ok).toBe(true);
  });

  test('redirects are followed manually with per-hop validation, bounded', async () => {
    const get = mockGet(301, '', 'https://hop.example/next');
    const result = await reverifyEvent(EVENT, opts(get));
    expect(result.ok).toBe(true);
    expect(result.note).toContain('redirects');
    expect(get.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test('reverifyEvents aggregates failures across the lineup', async () => {
    const get = mockGet(410);
    const result = await reverifyEvents([EVENT, { ...EVENT, id: 'x', title: 'Other Show' }], opts(get));
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
  });
});

describe('negated cancellation language (codex round 3)', () => {
  test('reassurance is not evidence: "not cancelled", "has not been canceled", "unless cancelled"', () => {
    expect(deadTextNearTitle('Racer Creator Expo is not cancelled — see you Saturday!', EVENT.title)).toBe(false);
    expect(deadTextNearTitle('The Racer Creator Expo has not been canceled.', EVENT.title)).toBe(false);
    expect(deadTextNearTitle('Racer Creator Expo runs rain or shine unless cancelled by the county.', EVENT.title)).toBe(false);
    expect(deadTextNearTitle('Racer Creator Expo will never be cancelled', EVENT.title)).toBe(false);
    // Plain cancellation is still evidence.
    expect(deadTextNearTitle('The Racer Creator Expo has been cancelled.', EVENT.title)).toBe(true);
  });
});

describe('negation with intervening adverbs (pre-push round)', () => {
  test('"not currently/officially/yet ..." are reassurance, not evidence', () => {
    expect(deadTextNearTitle('Racer Creator Expo is not currently cancelled', EVENT.title)).toBe(false);
    expect(deadTextNearTitle('Racer Creator Expo not officially canceled', EVENT.title)).toBe(false);
    expect(deadTextNearTitle('Racer Creator Expo not yet postponed', EVENT.title)).toBe(false);
  });
});
