/**
 * SMS live GPS ETA (owner ruling 2026-09-29) — GATE_SMS_REAL_ANSWERS.
 *
 * A customer texting "where's the tech" on a TODAY en-route visit gets the
 * live GPS ETA + tracking link instead of always handing off. Reuses the
 * exact functions the public tracking page uses (resolveFreshTechPosition +
 * calculateBoundedTrackingEta) — never reimplemented — so the drafter's
 * facts block fails closed exactly like the tracking page does on a stale
 * or missing position, missing coordinates, or a provider timeout/error.
 *
 * Covers:
 *  - context-aggregator's resolveLiveEtaFact: the facts line's data source,
 *    fail-closed on every edge.
 *  - sms-shadow-drafter's buildFactsBlock: LIVE ETA + TRACKING LINK render
 *    only when the gate is on and the resolved fact is present.
 *  - the prompt rule: byte-identical to v11 when the gate is off; an
 *    explicit "state that exact number, never invent one" allowance when on.
 *  - the adversarial verifier: an ETA claim is grounded only against a
 *    matching LIVE ETA fact.
 *
 * Synthetic customer names only, per repo policy.
 */

jest.mock('../services/tracking-vehicle-location', () => ({
  resolveFreshTechPosition: jest.fn(),
}));
jest.mock('../services/customer-tracking-eta', () => {
  const actual = jest.requireActual('../services/customer-tracking-eta');
  return { ...actual, calculateBoundedTrackingEta: jest.fn() };
});

const { resolveFreshTechPosition } = require('../services/tracking-vehicle-location');
const { calculateBoundedTrackingEta } = require('../services/customer-tracking-eta');
const {
  resolveLiveEtaFact, liveEtaDestination, liveEtaDedupeKey, liveEtaEligible,
  _resetLiveEtaMemoForTests, _liveEtaMemoSizeForTests,
} = require('../services/context-aggregator');
const {
  buildFactsBlock, buildSystemPrompt, validateLiveEtaMinutes, findEtaMinutesClaims,
  replyClaimsEtaMinutes, buildLiveEtaSnapshot,
} = require('../services/sms-shadow-drafter');
const { buildVerifierSystemPrompt } = require('../services/sms-draft-verifier');

const GATE = 'GATE_SMS_REAL_ANSWERS';

function baseRow(overrides = {}) {
  return {
    id: 'svc-1',
    technician_id: 'tech-1',
    track_view_token: 'abc123token',
    tech_bouncie_imei: null,
    service_lat: 27.4,
    service_lng: -82.5,
    service_address_line1: null,
    service_address_zip: null,
    service_address_city: null,
    ...overrides,
  };
}

function baseCustomer(overrides = {}) {
  return {
    address_line1: '100 Main St',
    zip: '34219',
    city: 'Parrish',
    latitude: 27.41,
    longitude: -82.51,
    ...overrides,
  };
}

const FRESH_POSITION = { lat: 27.39, lng: -82.49, lastReportedAt: '2026-09-29T14:30:00Z', source: 'tech_status' };
const ETA_RESULT = { minutes: 14, distanceMiles: 3.2, source: 'google', techUpdatedAt: '2026-09-29T14:30:00Z' };

afterEach(() => {
  delete process.env[GATE];
  jest.clearAllMocks();
  // The cross-request memo (Codex round-4 P2) is process-wide, keyed on
  // (technician, destination) — every test below reuses baseRow()'s
  // tech-1/27.4,-82.5 pair, so a cached result from one test would otherwise
  // leak into the next one's mocked expectations.
  _resetLiveEtaMemoForTests();
});

describe('resolveLiveEtaFact — fail-closed data source', () => {
  test('gate off: returns null without calling the position/ETA lookups at all', async () => {
    delete process.env[GATE];
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
    expect(resolveFreshTechPosition).not.toHaveBeenCalled();
    expect(calculateBoundedTrackingEta).not.toHaveBeenCalled();
  });

  test('gate on, fresh position + a resolved ETA: returns minutes, an ET as-of stamp, and the canonical /track/:token URL', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toEqual({
      minutes: 14,
      asOf: expect.stringContaining('ET'),
      trackUrl: expect.stringContaining('/track/abc123token'),
    });
    expect(resolveFreshTechPosition).toHaveBeenCalledWith(expect.objectContaining({ techId: 'tech-1' }));
    expect(calculateBoundedTrackingEta).toHaveBeenCalledWith(expect.objectContaining({
      techLat: FRESH_POSITION.lat,
      techLng: FRESH_POSITION.lng,
      customerLat: 27.4,
      customerLng: -82.5,
    }));
  });

  test('no technician assigned: null, no lookups', async () => {
    process.env[GATE] = 'true';
    const out = await resolveLiveEtaFact(baseRow({ technician_id: null }), baseCustomer());
    expect(out).toBeNull();
    expect(resolveFreshTechPosition).not.toHaveBeenCalled();
  });

  test('no tracking token: null (never a customer-facing fact with no link)', async () => {
    process.env[GATE] = 'true';
    const out = await resolveLiveEtaFact(baseRow({ track_view_token: null }), baseCustomer());
    expect(out).toBeNull();
    expect(resolveFreshTechPosition).not.toHaveBeenCalled();
  });

  test('no destination coordinates anywhere (no visit pin, no customer geocode): null, no position lookup', async () => {
    process.env[GATE] = 'true';
    const row = baseRow({ service_lat: null, service_lng: null });
    const customer = baseCustomer({ latitude: null, longitude: null });
    const out = await resolveLiveEtaFact(row, customer);
    expect(out).toBeNull();
    expect(resolveFreshTechPosition).not.toHaveBeenCalled();
  });

  test('stamped address diverges from the primary and the visit has no own pin: no pin beats a wrong pin', async () => {
    process.env[GATE] = 'true';
    const row = baseRow({
      service_lat: null,
      service_lng: null,
      service_address_line1: '500 Other Ave',
      service_address_zip: '34205',
      service_address_city: 'Bradenton',
    });
    const customer = baseCustomer({ address_line1: '100 Main St', zip: '34219', city: 'Parrish' });
    const out = await resolveLiveEtaFact(row, customer);
    expect(out).toBeNull();
    expect(resolveFreshTechPosition).not.toHaveBeenCalled();
  });

  test('no fresh GPS position (stale ping or missing): null', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(null);
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
    expect(calculateBoundedTrackingEta).not.toHaveBeenCalled();
  });

  test('ETA lookup times out / returns nothing: null', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(null);
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
  });

  test('position lookup throws: caught, returns null (a lookup failure never blocks drafting)', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockRejectedValue(new Error('bouncie down'));
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
  });

  test('an ETA result with a non-finite minutes value is treated as no ETA', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue({ minutes: null, source: 'google' });
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
  });

  // Codex round-2 P2: calculateBoundedTrackingEta falls back to a
  // straight-line haversine guess (30mph average, source: 'haversine')
  // whenever Google Distance Matrix times out, fails, or is unconfigured —
  // that guess must never publish as a customer-facing "X minutes away".
  test('a haversine fallback result (Distance Matrix timeout/failure/unconfigured) is rejected, not published as a customer fact', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue({ minutes: 22, distanceMiles: 8.1, source: 'haversine', techUpdatedAt: FRESH_POSITION.lastReportedAt });
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
  });

  test('a resolved ETA with no source at all (unexpected shape) is also rejected, never assumed real', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue({ minutes: 14, distanceMiles: 3.2 });
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out).toBeNull();
  });
});

describe('resolveLiveEtaFact — cross-request memo (Codex round-4 P2, PR #5334): concurrent lanes share one lookup', () => {
  test('two concurrent callers for the SAME (technician, destination) share one lookup and get the same number', async () => {
    process.env[GATE] = 'true';
    let resolvePosition;
    resolveFreshTechPosition.mockImplementation(() => new Promise((resolve) => { resolvePosition = resolve; }));
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    // Two different scheduled_services rows at the same physical stop — the
    // exact twilio-webhook.js scenario: processInboundSms and
    // draftShadowReply each independently build a context for the SAME
    // inbound and each resolves the SAME row's LIVE ETA.
    const p1 = resolveLiveEtaFact(baseRow({ id: 'svc-a' }), baseCustomer());
    const p2 = resolveLiveEtaFact(baseRow({ id: 'svc-b' }), baseCustomer());
    resolvePosition(FRESH_POSITION);
    const [out1, out2] = await Promise.all([p1, p2]);

    expect(out1).toEqual(out2);
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
    expect(calculateBoundedTrackingEta).toHaveBeenCalledTimes(1);
  });

  // Codex round-5 P1: the memo must never leak one customer's tracking token
  // to another customer who happens to share a tech+destination inside the
  // 60s TTL (e.g. two units of one property, or a coincidental coordinate
  // collision). Each caller's own track_view_token must always come back in
  // ITS OWN result, even though the underlying GPS/Distance Matrix lookup is
  // shared exactly once.
  test('two different customers/tokens sharing a tech+destination each get their OWN trackUrl from one provider call', async () => {
    process.env[GATE] = 'true';
    let resolvePosition;
    resolveFreshTechPosition.mockImplementation(() => new Promise((resolve) => { resolvePosition = resolve; }));
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    const rowA = baseRow({ id: 'svc-a', track_view_token: 'token-customer-a' });
    const rowB = baseRow({ id: 'svc-b', track_view_token: 'token-customer-b' });
    const customerA = baseCustomer({ address_line1: '100 Main St' });
    const customerB = baseCustomer({ address_line1: '200 Other St' });

    const p1 = resolveLiveEtaFact(rowA, customerA);
    const p2 = resolveLiveEtaFact(rowB, customerB);
    resolvePosition(FRESH_POSITION);
    const [outA, outB] = await Promise.all([p1, p2]);

    expect(outA.minutes).toBe(outB.minutes);
    expect(outA.asOf).toBe(outB.asOf);
    expect(outA.trackUrl).toContain('/track/token-customer-a');
    expect(outB.trackUrl).toContain('/track/token-customer-b');
    expect(outA.trackUrl).not.toBe(outB.trackUrl);
    // One shared provider call for both — the memoized part is only the
    // tech-position/route-minutes lookup.
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
    expect(calculateBoundedTrackingEta).toHaveBeenCalledTimes(1);
  });

  // Same guarantee against the CACHED-result path (no in-flight promise —
  // the second call arrives after the first has already resolved and been
  // stored).
  test('a second customer reusing a cached (tech, destination) entry gets their OWN trackUrl, not the first customer\'s', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    const rowA = baseRow({ id: 'svc-a', track_view_token: 'token-customer-a' });
    const rowB = baseRow({ id: 'svc-b', track_view_token: 'token-customer-b' });

    const outA = await resolveLiveEtaFact(rowA, baseCustomer());
    const outB = await resolveLiveEtaFact(rowB, baseCustomer());

    expect(outA.trackUrl).toContain('/track/token-customer-a');
    expect(outB.trackUrl).toContain('/track/token-customer-b');
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
  });

  test('a different technician never shares the memo — its own lookup runs', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    await Promise.all([
      resolveLiveEtaFact(baseRow({ id: 'svc-a', technician_id: 'tech-1' }), baseCustomer()),
      resolveLiveEtaFact(baseRow({ id: 'svc-b', technician_id: 'tech-2' }), baseCustomer()),
    ]);
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(2);
  });

  test('a different destination never shares the memo, even for the same technician', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    await Promise.all([
      resolveLiveEtaFact(baseRow({ id: 'svc-a', service_lat: 27.4, service_lng: -82.5 }), baseCustomer()),
      resolveLiveEtaFact(baseRow({ id: 'svc-b', service_lat: 27.9, service_lng: -82.1 }), baseCustomer()),
    ]);
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(2);
  });

  test('a second, later call within the 60s TTL reuses the cached result with no second lookup', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    const row = baseRow();
    const out1 = await resolveLiveEtaFact(row, baseCustomer());
    const out2 = await resolveLiveEtaFact(row, baseCustomer());
    expect(out1).toEqual(out2);
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
  });

  test('a failed/null lookup is memoized too — a second caller in the same window does not repeat it', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(null); // stale/missing GPS

    const row = baseRow();
    const out1 = await resolveLiveEtaFact(row, baseCustomer());
    const out2 = await resolveLiveEtaFact(row, baseCustomer());
    expect(out1).toBeNull();
    expect(out2).toBeNull();
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
  });

  test('a call after the 60s TTL expires runs a fresh lookup, not the stale cached one', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const row = baseRow();
      await resolveLiveEtaFact(row, baseCustomer());
      now += 61 * 1000; // past the 60s TTL
      await resolveLiveEtaFact(row, baseCustomer());
      expect(resolveFreshTechPosition).toHaveBeenCalledTimes(2);
    } finally {
      Date.now.mockRestore();
    }
  });

  test('the memo is bounded — many distinct keys never grow it past the cap', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    for (let i = 0; i < 250; i += 1) {
      await resolveLiveEtaFact(baseRow({ id: `svc-${i}`, technician_id: `tech-${i}`, service_lat: 27 + i / 1000 }), baseCustomer());
    }
    expect(_liveEtaMemoSizeForTests()).toBeLessThanOrEqual(200);
  });
});

describe('buildFactsBlock — LIVE ETA / TRACKING LINK rendering', () => {
  const liveEta = { minutes: 12, asOf: '2:45 PM ET', trackUrl: 'https://portal.wavespestcontrol.com/track/abc123' };

  test('gate on + a resolved liveEta on an en-route TODAY visit: both new lines render alongside LIVE STATUS', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: '1:00 PM–3:00 PM', tech: 'Sam', status: 'en_route', isToday: true, liveEta },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked en route to this visit');
    expect(block).toContain('LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)');
    // SMS-safe, scheme-free form (comms-lint's portal-link-scheme rule fails
    // any SMS carrying https://) — the fact itself must never carry a
    // scheme a model that echoes it verbatim would then fail lint on.
    expect(block).toContain('TRACKING LINK: portal.wavespestcontrol.com/track/abc123');
    expect(block).not.toContain('https://portal.wavespestcontrol.com/track/abc123');
  });

  test('gate on but liveEta is null (stale/missing/timeout upstream): LIVE STATUS still renders, no ETA/link line', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'en_route', isToday: true, liveEta: null },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked en route to this visit');
    expect(block).not.toContain('LIVE ETA');
    expect(block).not.toContain('TRACKING LINK');
  });

  test('gate OFF: a liveEta fact is never rendered even if somehow present — byte-identical to v11', () => {
    delete process.env[GATE];
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'en_route', isToday: true, liveEta },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked en route to this visit');
    expect(block).not.toContain('LIVE ETA');
    expect(block).not.toContain('TRACKING LINK');
  });

  test('on_site status never renders LIVE ETA, even with a liveEta fact attached', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'X',
      upcomingServices: [
        { type: 'Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'on_site', isToday: true, liveEta },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked on site at this visit');
    expect(block).not.toContain('LIVE ETA');
  });
});

describe('buildFactsBlock reads the customer-facing trackState, not raw status (Codex round-4 P2, PR #5334)', () => {
  const liveEta = { minutes: 12, asOf: '2:45 PM ET', trackUrl: 'https://portal.wavespestcontrol.com/track/abc123' };

  test('gate on: status says en_route but trackState (the tracker) says the admin flip never landed — NOT rendered as live, mirrors liveEtaEligible', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'en_route', trackState: 'scheduled', isToday: true, liveEta },
      ],
    });
    expect(block).not.toContain('LIVE STATUS: tech marked en route');
    expect(block).not.toContain('LIVE ETA');
    expect(block).toContain('no live tech location known');
  });

  test('gate on: status says confirmed but trackState says en_route (status write lagged the tracker) — rendered live off trackState', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'confirmed', trackState: 'en_route', isToday: true, liveEta },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked en route to this visit');
    expect(block).toContain('LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)');
  });

  test('gate on: trackState says on_site even though status still says en_route — rendered on-site off trackState, never LIVE ETA', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'en_route', trackState: 'on_site', isToday: true, liveEta },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked on site at this visit');
    expect(block).not.toContain('LIVE ETA');
  });

  test('gate OFF: trackState is ignored entirely — rendering stays status-based, byte-identical to v11', () => {
    delete process.env[GATE];
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'confirmed', trackState: 'en_route', isToday: true, liveEta },
      ],
    });
    expect(block).not.toContain('LIVE STATUS');
    expect(block).not.toContain('LIVE ETA');
    expect(block).toContain('no live tech location known');
  });

  test('a context predating trackState (no field at all) falls back to status, gate on or off', () => {
    process.env[GATE] = 'true';
    const block = buildFactsBlock({
      summary: 'Dana',
      upcomingServices: [
        { type: 'Quarterly Pest', date: '2026-09-29', window: null, tech: 'Sam', status: 'en_route', isToday: true, liveEta },
      ],
    });
    expect(block).toContain('LIVE STATUS: tech marked en route to this visit');
    expect(block).toContain('LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)');
  });
});

describe('prompt rule — LIVE ETA allowance', () => {
  test('gate off: no ETA/tracking-link language leaks into the prompt (v11 byte-identical)', () => {
    delete process.env[GATE];
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain('LIVE ETA');
    expect(prompt).not.toContain('TRACKING LINK');
    expect(prompt).toMatch(/never guess an ETA/i);
  });

  test('gate on: the drafter may state the exact LIVE ETA minutes and share the tracking link, but still never invent one', () => {
    process.env[GATE] = 'true';
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('LIVE ETA');
    expect(prompt).toContain('TRACKING LINK');
    expect(prompt).toMatch(/never compute, round, or invent one/i);
    // the no-status fallback (no LIVE STATUS at all) is untouched
    expect(prompt).toMatch(/never guess an ETA/i);
  });
});

describe('adversarial verifier — ETA claims checked against LIVE ETA', () => {
  test('the checklist names ETA/minutes-away claims and requires an exact LIVE ETA match', () => {
    const prompt = buildVerifierSystemPrompt();
    expect(prompt).toMatch(/minutes away/i);
    expect(prompt).toContain('LIVE ETA');
    expect(prompt).toMatch(/EXACT number of minutes/);
  });
});

describe('liveEtaDestination / liveEtaDedupeKey — grouped-stop dedupe (independent review finding #1, PR #5334)', () => {
  test('two siblings at the same physical stop (same tech, same destination) share one key', () => {
    const customer = baseCustomer();
    const a = baseRow({ id: 'svc-a', technician_id: 'tech-1' });
    const b = baseRow({ id: 'svc-b', technician_id: 'tech-1' });
    expect(liveEtaDedupeKey(a, customer)).toBe(liveEtaDedupeKey(b, customer));
    expect(liveEtaDedupeKey(a, customer)).not.toBeNull();
  });

  test('a different technician never merges with another tech\'s stop', () => {
    const customer = baseCustomer();
    const a = baseRow({ id: 'svc-a', technician_id: 'tech-1' });
    const b = baseRow({ id: 'svc-b', technician_id: 'tech-2' });
    expect(liveEtaDedupeKey(a, customer)).not.toBe(liveEtaDedupeKey(b, customer));
  });

  test('a different resolved destination never merges, even for the same technician', () => {
    const customer = baseCustomer();
    const a = baseRow({ id: 'svc-a', technician_id: 'tech-1', service_lat: 27.4, service_lng: -82.5 });
    const b = baseRow({ id: 'svc-b', technician_id: 'tech-1', service_lat: 27.9, service_lng: -82.1 });
    expect(liveEtaDedupeKey(a, customer)).not.toBe(liveEtaDedupeKey(b, customer));
  });

  test('no technician, or no resolvable destination: null (never dedupes a row that would fail closed on its own)', () => {
    const customer = baseCustomer();
    expect(liveEtaDedupeKey(baseRow({ technician_id: null }), customer)).toBeNull();
    expect(liveEtaDestination(baseRow({ service_lat: null, service_lng: null }), baseCustomer({ latitude: null, longitude: null }))).toBeNull();
  });
});

describe('liveEtaEligible — track_state gate (Codex round-1 finding, PR #5334)', () => {
  const TODAY = '2026-09-29';
  test('status en_route + track_state en_route, today: eligible', () => {
    expect(liveEtaEligible({ status: 'en_route', track_state: 'en_route', scheduled_date: TODAY }, TODAY)).toBe(true);
  });

  test('status en_route but track_state still "scheduled" (the admin flip landed, the tracker flip did not — server/routes/tech-track.js): NOT eligible', () => {
    expect(liveEtaEligible({ status: 'en_route', track_state: 'scheduled', scheduled_date: TODAY }, TODAY)).toBe(false);
  });

  test('a no_show/cancelled/completed status overrides a stale track_state="en_route": NOT eligible', () => {
    expect(liveEtaEligible({ status: 'cancelled', track_state: 'en_route', scheduled_date: TODAY }, TODAY)).toBe(false);
    expect(liveEtaEligible({ status: 'completed', track_state: 'en_route', scheduled_date: TODAY }, TODAY)).toBe(false);
  });

  test('not today: NOT eligible even with both states en_route', () => {
    expect(liveEtaEligible({ status: 'en_route', track_state: 'en_route', scheduled_date: '2026-09-28' }, TODAY)).toBe(false);
  });
});

describe('findEtaMinutesClaims / replyClaimsEtaMinutes / validateLiveEtaMinutes — deterministic minutes guard (independent review finding #3, PR #5334; broadened — pre-push audit P1, round 2)', () => {
  afterEach(() => { delete process.env[GATE]; });

  test('arrival-scoped phrasing is detected: "X minutes away", "ETA is about X minutes", "arriving in X minutes"', () => {
    expect(findEtaMinutesClaims('The tech is 12 minutes away.').map((c) => c.minutes)).toEqual([12]);
    expect(findEtaMinutesClaims('ETA is about 9 minutes.').map((c) => c.minutes)).toEqual([9]);
    expect(findEtaMinutesClaims('He\'s arriving in 15 minutes.').map((c) => c.minutes)).toEqual([15]);
    expect(replyClaimsEtaMinutes('The tech is 12 minutes away.')).toBe(true);
  });

  // Broadened detection (pre-push audit P1): the number may now come AFTER
  // the trigger, separated by a comma/"about", not just immediately before
  // it — "The tech is on the way, about 12 minutes." was missed by the
  // original narrow proximity window.
  test('the number after the trigger, separated by a comma/"about", is detected: "on the way, about 12 minutes"', () => {
    expect(findEtaMinutesClaims('The tech is on the way, about 12 minutes.').map((c) => c.minutes)).toEqual([12]);
  });

  test('"out" right after the number, sentence-scoped: "12 minutes out"', () => {
    expect(findEtaMinutesClaims('He\'s 12 minutes out.').map((c) => c.minutes)).toEqual([12]);
  });

  test('"should arrive in about 12 min" (abbreviated "min")', () => {
    expect(findEtaMinutesClaims('He should arrive in about 12 min.').map((c) => c.minutes)).toEqual([12]);
  });

  test('"ETA 12 minutes" (bare ETA, no "is about")', () => {
    expect(findEtaMinutesClaims('ETA 12 minutes.').map((c) => c.minutes)).toEqual([12]);
  });

  test('"heading your way — 12 minutes" (em dash, number after the trigger)', () => {
    expect(findEtaMinutesClaims('Heading your way — 12 minutes.').map((c) => c.minutes)).toEqual([12]);
  });

  test('unrelated durations never false-positive: "takes about 30 minutes to dry", "allow 30 minutes before letting pets out", "takes about 45 minutes"', () => {
    expect(findEtaMinutesClaims('The treatment takes about 30 minutes to dry.')).toHaveLength(0);
    expect(findEtaMinutesClaims('Please allow 30 minutes before letting pets out.')).toHaveLength(0);
    expect(findEtaMinutesClaims('It takes about 45 minutes.')).toHaveLength(0);
    expect(replyClaimsEtaMinutes('The treatment takes about 30 minutes to dry.')).toBe(false);
    expect(replyClaimsEtaMinutes('Please allow 30 minutes before letting pets out.')).toBe(false);
    expect(replyClaimsEtaMinutes('It takes about 45 minutes.')).toBe(false);
  });

  // The exclusion must win even when a duration phrase shares a sentence
  // with a generic trigger word like "out" ("...letting pets out" carries
  // "out") or "away"/"eta" elsewhere nearby.
  // Round 3 (audit P1): a STRONG arrival word in the sentence makes every
  // figure in it a claim — conservative on purpose. The worst case is a
  // revision that splits the sentence; the alternative let "take about 12
  // minutes to arrive" skip every freshness check.
  test('a strong arrival word in the sentence wins over a duration exclusion (conservative)', () => {
    expect(findEtaMinutesClaims('He\'s on the way — allow 30 minutes before letting pets out.').map((c) => c.minutes)).toEqual([30]);
  });

  test('gate off: never runs (byte-identical to v11 — no LIVE ETA fact can exist anyway)', () => {
    delete process.env[GATE];
    expect(validateLiveEtaMinutes({ reply: 'The tech is 99 minutes away.', factsBlock: 'LIVE ETA: about 12 minutes' })).toEqual({ ok: true, violations: [] });
  });

  test('gate on: an ETA claim matching the facts block passes', () => {
    process.env[GATE] = 'true';
    const result = validateLiveEtaMinutes({ reply: 'The tech is 12 minutes away.', factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)' });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test('gate on: a reply with no minutes claim passes regardless of the facts', () => {
    process.env[GATE] = 'true';
    expect(validateLiveEtaMinutes({ reply: 'The tech is on the way!', factsBlock: 'LIVE ETA: about 12 minutes' })).toEqual({ ok: true, violations: [] });
  });

  test('gate on: an ETA claim with NO LIVE ETA fact in the facts block fails', () => {
    process.env[GATE] = 'true';
    const result = validateLiveEtaMinutes({ reply: 'The tech is 12 minutes away.', factsBlock: 'LIVE STATUS: tech marked en route to this visit' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/no LIVE ETA/);
  });

  test('gate on: an ETA claim that does NOT match the facts number fails', () => {
    process.env[GATE] = 'true';
    const result = validateLiveEtaMinutes({ reply: 'The tech is 20 minutes away.', factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/20 minute/);
    expect(result.violations[0]).toMatch(/12 minutes/);
  });

  test('an unrelated duration alongside a correct ETA claim never false-positives the whole reply', () => {
    process.env[GATE] = 'true';
    const result = validateLiveEtaMinutes({
      reply: 'The tech is 12 minutes away. The treatment takes about 30 minutes to dry once he\'s done.',
      factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)',
    });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  // Codex round-2 P2: a range states TWO bounds — validating only the
  // endpoint next to "min(s)/minutes" silently dropped the other one.
  describe('range claims: every bound is its own claim', () => {
    test('digit hyphen range: "10-12 minutes away"', () => {
      expect(findEtaMinutesClaims('The tech is 10-12 minutes away.').map((c) => c.minutes).sort()).toEqual([10, 12]);
    });

    test('en dash range: "10–12 minutes away"', () => {
      expect(findEtaMinutesClaims('The tech is 10–12 minutes away.').map((c) => c.minutes).sort()).toEqual([10, 12]);
    });

    test('"to" range, written-out number words: "ten to twelve minutes away"', () => {
      expect(findEtaMinutesClaims('The tech is ten to twelve minutes away.').map((c) => c.minutes).sort()).toEqual([10, 12]);
    });

    test('"or" range: "10 or 12 minutes out"', () => {
      expect(findEtaMinutesClaims('He\'s 10 or 12 minutes out.').map((c) => c.minutes).sort()).toEqual([10, 12]);
    });

    test('"between N and M minutes"', () => {
      expect(findEtaMinutesClaims('He\'ll be there in between 10 and 12 minutes.').map((c) => c.minutes).sort()).toEqual([10, 12]);
    });

    test('a duration range never false-positives: "takes 10-12 minutes to dry"', () => {
      expect(findEtaMinutesClaims('The treatment takes 10-12 minutes to dry.')).toEqual([]);
    });

    test('validateLiveEtaMinutes rejects a reply stating a range when only ONE bound is grounded', () => {
      process.env[GATE] = 'true';
      const result = validateLiveEtaMinutes({
        reply: 'The tech is 10-12 minutes away.',
        factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)',
      });
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatch(/10 minute/);
    });

    test('validateLiveEtaMinutes rejects a range across two distinct LIVE ETA lines (Codex r3: two live ETAs fail closed)', () => {
      process.env[GATE] = 'true';
      const factsBlock = 'UPCOMING SERVICES:\n- Pest TODAY LIVE ETA: about 10 minutes\n- Lawn TODAY LIVE ETA: about 12 minutes';
      expect(validateLiveEtaMinutes({ reply: 'The tech is 10-12 minutes away.', factsBlock }).ok).toBe(false);
    });
  });

  // Codex round-5 P2: a vague/approximate duration phrase states WHEN the
  // tech arrives exactly like a parsed number, but there is no exact figure
  // to check against the LIVE ETA fact — reject it outright, the same
  // direction as an unmatched number, instead of waving it through as pure
  // status copy.
  describe('validateLiveEtaMinutes — vague/approximate duration wording is rejected, not waved through as status copy', () => {
    let prior;
    beforeEach(() => { prior = process.env[GATE]; process.env[GATE] = 'true'; });
    afterEach(() => { if (prior === undefined) delete process.env[GATE]; else process.env[GATE] = prior; });

    test.each([
      'The tech is about half an hour away.',
      'He is an hour out.',
      'He should be there in a few minutes.',
      'He should be there in a couple minutes.',
      'He is a quarter hour out.',
      'He is on the way and should be there shortly.',
      'He is on the way and should be there any minute now.',
      'He is on the way and should be there soon.',
    ])('%p is rejected even though the facts carry a matching LIVE ETA', (reply) => {
      const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)' });
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatch(/exact/i);
    });

    test('rejected the same way with NO LIVE ETA fact in the facts block at all', () => {
      const result = validateLiveEtaMinutes({ reply: 'He is about half an hour away.', factsBlock: 'LIVE STATUS: tech marked en route to this visit' });
      expect(result.ok).toBe(false);
    });

    test('pure status copy with no duration wording at all still passes', () => {
      expect(validateLiveEtaMinutes({ reply: 'The tech is on the way!', factsBlock: 'LIVE ETA: about 12 minutes' })).toEqual({ ok: true, violations: [] });
    });

    test('a duration phrase in an unrelated sentence (treatment dry time, not arrival) never false-positives', () => {
      const result = validateLiveEtaMinutes({
        reply: 'The tech is 12 minutes away. Please let the dog out — the treatment needs about half an hour to dry.',
        factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)',
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });

    test('gate off: never runs (byte-identical to v11)', () => {
      delete process.env[GATE];
      expect(validateLiveEtaMinutes({ reply: 'He is about half an hour away.', factsBlock: 'LIVE ETA: about 12 minutes' })).toEqual({ ok: true, violations: [] });
    });
  });
});

describe('round 6 (Codex P2): bare numeric ETA claims with no unit and no "in"/duration wording at all', () => {
  let prior;
  beforeEach(() => { prior = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (prior === undefined) delete process.env[GATE]; else process.env[GATE] = prior; });

  test.each([
    ['ETA: 20', 20],
    ['His ETA is 20.', 20],
    ['ETA 20', 20],
    ['eta ~20', 20],
    ['20 out.', 20],
  ])('%p is parsed as a minutes claim at draft time and blocked when it does not match the facts', (reply, minutes) => {
    expect(findEtaMinutesClaims(reply).map((c) => c.minutes)).toEqual([minutes]);
    const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(new RegExp(`${minutes} minute`));
  });

  test.each([
    ['ETA: 20', 20],
    ['His ETA is 20.', 20],
    ['ETA 20', 20],
    ['eta ~20', 20],
    ['20 out.', 20],
  ])('%p passes validateLiveEtaMinutes when it DOES match the facts', (reply, minutes) => {
    const result = validateLiveEtaMinutes({ reply, factsBlock: `LIVE ETA: about ${minutes} minutes (GPS, as of 2:45 PM ET)` });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test('negative: a clock time ("at 2:30") is never parsed as an ETA minutes claim', () => {
    expect(findEtaMinutesClaims('He\'ll be there at 2:30.')).toEqual([]);
    expect(validateLiveEtaMinutes({ reply: 'He\'ll be there at 2:30.', factsBlock: 'LIVE ETA: about 9 minutes' })).toEqual({ ok: true, violations: [] });
  });

  test('negative: "by 3" (no am/pm, still clearly a time) is never parsed as an ETA minutes claim', () => {
    expect(findEtaMinutesClaims('He should be there by 3.')).toEqual([]);
  });

  test('negative: a time-of-day range ("arriving between 2 and 4 pm") is never parsed as an ETA minutes claim', () => {
    expect(findEtaMinutesClaims('He\'s arriving between 2 and 4 pm.')).toEqual([]);
  });

  test('negative: an address after the number ("on the way to 123 Main St") is never parsed as an ETA minutes claim', () => {
    expect(findEtaMinutesClaims('He\'s on the way to 123 Main St.')).toEqual([]);
  });

  test('a bare number with no arrival trigger anywhere in the sentence is never a claim', () => {
    expect(findEtaMinutesClaims('Your invoice total is 20.')).toEqual([]);
  });

  test('"20 out of 30 jobs done today" never claims — "out of" is excluded', () => {
    expect(findEtaMinutesClaims('20 out of 30 jobs done today.')).toEqual([]);
  });

  test('gate off: never runs (byte-identical to v11)', () => {
    delete process.env[GATE];
    expect(validateLiveEtaMinutes({ reply: 'ETA: 99', factsBlock: 'LIVE ETA: about 9 minutes' })).toEqual({ ok: true, violations: [] });
  });
});

describe('round 3 (audit P1s): arrival wording beats duration exclusions; every LIVE ETA line grounds', () => {
  const { findEtaMinutesClaims, validateLiveEtaMinutes } = require('../services/sms-shadow-drafter');
  let prior;
  beforeEach(() => { prior = process.env.GATE_SMS_REAL_ANSWERS; process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; });

  test.each([
    'The tech will take about 12 minutes to arrive.',
    'Please allow 12 minutes for him to arrive.',
    'He should be here in 12 minutes.',
    'Give it about 12 minutes and he will show up.',
  ])('counts as an ETA claim: %s', (reply) => {
    expect(findEtaMinutesClaims(reply).map((c) => c.minutes)).toEqual([12]);
  });

  test.each([
    'The treatment takes about 30 minutes to dry.',
    'Please allow 30 minutes before letting pets out.',
  ])('still not an ETA claim: %s', (reply) => {
    expect(findEtaMinutesClaims(reply)).toEqual([]);
  });

  test('two distinct live stops: no minutes figure may go out, even a real one (Codex r3: prose cannot bind to the right visit)', () => {
    const factsBlock = 'UPCOMING SERVICES:\n- Pest TODAY LIVE ETA: about 9 minutes\n- Lawn TODAY LIVE ETA: about 20 minutes';
    expect(validateLiveEtaMinutes({ reply: 'Your lawn tech is about 20 minutes away.', factsBlock }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: 'Your lawn tech is about 9 minutes away.', factsBlock }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: 'Your tech is about 15 minutes away.', factsBlock }).ok).toBe(false);
  });
});

// Codex round-7 P2 (structural default-deny): every earlier round added one
// more arrival-trigger word to findEtaMinutesClaims's phrase list ("on the
// way", written numbers, ranges, "from you", bare "ETA: 20", "20 minutes to
// go") — an open-ended enumeration. Once the facts actually carry a LIVE ETA
// to check a claim against, validateLiveEtaMinutes stops depending on that
// list for a plain minutes figure: it binds by default, no trigger word
// required, unless its own clause is an explicit non-arrival duration.
describe('round 7 (Codex P2): structural default-deny at draft time — a plain minutes figure needs no trigger word once the facts carry a LIVE ETA', () => {
  let prior;
  beforeEach(() => { prior = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (prior === undefined) delete process.env[GATE]; else process.env[GATE] = prior; });

  test.each([
    '20 minutes to go.',
    '20 min left.',
    'Due in 20.',
    'Be with you in 20 minutes.',
    'Reach you in about 20.',
  ])('%p is bound to the LIVE ETA figure with no trigger-list match required', (reply) => {
    const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 20 minutes (GPS, as of 2:45 PM ET)' });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test.each([
    '20 minutes to go.',
    'Due in 20.',
  ])('%p is rejected when it does not match the LIVE ETA figure', (reply) => {
    const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)' });
    expect(result.ok).toBe(false);
  });

  test.each([
    'Allow 30 minutes to dry.',
    'The service takes about 45 minutes.',
  ])('explicit non-arrival duration %p never needs to match the LIVE ETA figure', (reply) => {
    expect(validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 20 minutes (GPS, as of 2:45 PM ET)' })).toEqual({ ok: true, violations: [] });
  });

  // The point of the structural fix: a bare "20 minutes." with no arrival
  // wording at all still gets bound once the facts carry a LIVE ETA — no
  // future phrasing needs its own trigger-word addition here.
  test('a bare "20 minutes." with no arrival wording at all is still bound and checked', () => {
    const passing = validateLiveEtaMinutes({ reply: '20 minutes.', factsBlock: 'LIVE ETA: about 20 minutes (GPS, as of 2:45 PM ET)' });
    expect(passing).toEqual({ ok: true, violations: [] });
    const failing = validateLiveEtaMinutes({ reply: '20 minutes.', factsBlock: 'LIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)' });
    expect(failing.ok).toBe(false);
  });

  test('the same bare "20 minutes." with NO LIVE ETA fact at all passes — nothing to check it against here', () => {
    expect(validateLiveEtaMinutes({ reply: '20 minutes.', factsBlock: 'LIVE STATUS: tech marked en route to this visit' })).toEqual({ ok: true, violations: [] });
  });

  test('gate off: never runs (byte-identical to before)', () => {
    delete process.env[GATE];
    expect(validateLiveEtaMinutes({ reply: '20 minutes to go.', factsBlock: 'LIVE ETA: about 9 minutes' })).toEqual({ ok: true, violations: [] });
  });
});

describe('round 8 (Codex P2): bare-integer default-deny — "The tech should make it in 20" catches neither IMPLICIT_MINUTES_ARRIVAL_RE nor a strong trigger', () => {
  let prior;
  beforeEach(() => { prior = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (prior === undefined) delete process.env[GATE]; else process.env[GATE] = prior; });

  test.each([
    'The tech should make it in 20.',
    "He'll be by in 20.",
    '20ish.',
  ])('%p is bound to the LIVE ETA figure with no unit word or fixed phrase required', (reply) => {
    const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 20 minutes (GPS, as of 2:45 PM ET)' });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test.each([
    'The tech should make it in 20.',
    "He'll be by in 20.",
    'About 2 hours out.',
  ])('%p is rejected when it does not match the LIVE ETA figure', (reply) => {
    const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)' });
    expect(result.ok).toBe(false);
  });

  // "about 2 hours out" is a claim in its OWN right (no unit word — bound as
  // the raw captured figure "2", same as every other pass in this module)
  // and gets the EXACT-match treatment: it passes when the (contrived) LIVE
  // ETA figure is itself 2, and is rejected above when it is 9.
  test('"About 2 hours out." is bound to the LIVE ETA figure', () => {
    const result = validateLiveEtaMinutes({ reply: 'About 2 hours out.', factsBlock: 'LIVE ETA: about 2 minutes (GPS, as of 2:45 PM ET)' });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  // The "no-snapshot trigger path" fix: findEtaMinutesClaims itself now
  // recognizes these phrasings, so an ungrounded claim fails closed even
  // with NO LIVE ETA fact in the facts block at all — it must never be
  // silently waved through as status copy just because
  // findGroundedMinutesFigures never ran.
  test.each([
    'The tech should make it in 20.',
    "He'll be by in 20.",
  ])('%p with NO LIVE ETA fact at all is rejected as an ungrounded claim', (reply) => {
    const result = validateLiveEtaMinutes({ reply, factsBlock: 'LIVE STATUS: tech marked en route to this visit' });
    expect(result.ok).toBe(false);
  });

  test.each([
    '$20 is due at the visit.',
    'He should be there at 2:30.',
    "He's on the way to 123 Main St.",
    'You have 2 visits left this year.',
    'Your renewal lands on the 20th.',
    'Battery is at 100% right now.',
  ])('negative: %p is never parsed as a bare-integer ETA claim even with a LIVE ETA fact present', (reply) => {
    expect(validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 20 minutes (GPS, as of 2:45 PM ET)' })).toEqual({ ok: true, violations: [] });
  });

  test('gate off: never runs (byte-identical to before)', () => {
    delete process.env[GATE];
    expect(validateLiveEtaMinutes({ reply: 'The tech should make it in 20.', factsBlock: 'LIVE ETA: about 9 minutes' })).toEqual({ ok: true, violations: [] });
  });
});

describe('buildLiveEtaSnapshot — the send-time freshness snapshot input (independent review finding #2, PR #5334; grouped by distinct ETA — pre-push audit P1, round 2)', () => {
  test('no scheduled_service ever backed a LIVE ETA fact: null', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [] })).toBeNull();
    expect(buildLiveEtaSnapshot({})).toBeNull();
    expect(buildLiveEtaSnapshot(null)).toBeNull();
  });

  test('carries the exact groups context-aggregator collected, filtering out nullish ids', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: 12, scheduledServiceIds: ['svc-1', null, 'svc-2'] }] }))
      .toEqual({ entries: [{ minutes: 12, scheduledServiceIds: ['svc-1', 'svc-2'], trackTokens: [] }] });
  });

  test('two distinct stops (different technicians/destinations) persist as two separate entries', () => {
    expect(buildLiveEtaSnapshot({
      liveEtaGroups: [
        { minutes: 9, scheduledServiceIds: ['svc-1'] },
        { minutes: 20, scheduledServiceIds: ['svc-2'] },
      ],
    })).toEqual({
      entries: [
        { minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: [] },
        { minutes: 20, scheduledServiceIds: ['svc-2'], trackTokens: [] },
      ],
    });
  });

  test('a group with no minutes or no ids is dropped rather than persisted as a bogus entry', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: null, scheduledServiceIds: ['svc-1'] }, { minutes: 12, scheduledServiceIds: [] }] }))
      .toBeNull();
  });

  // Codex round-4 P2 (PR #5334): the /track/:token(s) each entry covers,
  // carried through unchanged — filtered of blanks the same way ids are —
  // so sms-eta-freshness.js can revalidate a tracking-link-only reply.
  test('carries each group\'s trackTokens through, filtering blanks', () => {
    expect(buildLiveEtaSnapshot({
      liveEtaGroups: [{ minutes: 12, scheduledServiceIds: ['svc-1', 'svc-2'], trackTokens: ['tok-a', null, 'tok-b', ''] }],
    })).toEqual({ entries: [{ minutes: 12, scheduledServiceIds: ['svc-1', 'svc-2'], trackTokens: ['tok-a', 'tok-b'] }] });
  });

  test('a group with no trackTokens at all still persists (defaults to empty)', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }))
      .toEqual({ entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: [] }] });
  });
});
