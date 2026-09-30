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
const { calculateBoundedTrackingEta, STALE_TECH_STATUS_MS } = require('../services/customer-tracking-eta');
const {
  resolveLiveEtaFact, liveEtaDestination, liveEtaDedupeKey, liveEtaEligible,
  _resetLiveEtaMemoForTests, _liveEtaMemoSizeForTests, perVisitLiveEtas, mergeLiveUpcoming, buildLiveEtaGroups,
} = require('../services/context-aggregator');
const {
  buildFactsBlock, buildSystemPrompt, validateLiveEtaMinutes, findEtaMinutesClaims,
  replyClaimsEtaMinutes, buildLiveEtaSnapshot, normalizeTimeQuantities, normalizeNumberWords, countEnRouteEtaStops, bodyHasTimedArrivalPhrase, bodyMentionsArrival, bodyClaimsCompletedArrival, findGroundedMinutesFigures,
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

// Codex round-9 P2 (PR #5334): the memo now caps its expiry at the fix's own
// freshness deadline (fix time + STALE_TECH_STATUS_MS), so a "fresh" fixture
// must genuinely be fresh relative to the real clock.
const FRESH_POSITION = { lat: 27.39, lng: -82.49, lastReportedAt: new Date().toISOString(), source: 'tech_status' };
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
      // Codex round-11 P2: the GPS fix's own tracker-staleness deadline.
      fixExpiresAtMs: expect.any(Number),
    });
    expect(resolveFreshTechPosition).toHaveBeenCalledWith(expect.objectContaining({ techId: 'tech-1' }));
    expect(calculateBoundedTrackingEta).toHaveBeenCalledWith(expect.objectContaining({
      techLat: FRESH_POSITION.lat,
      techLng: FRESH_POSITION.lng,
      customerLat: 27.4,
      customerLng: -82.5,
    }));
  });

  test('the result carries the fix\'s tracker-staleness deadline: fix time + STALE_TECH_STATUS_MS (Codex round-11 P2)', async () => {
    process.env[GATE] = 'true';
    const fixAt = Date.now() - 60 * 1000;
    resolveFreshTechPosition.mockResolvedValue({ ...FRESH_POSITION, lastReportedAt: new Date(fixAt).toISOString() });
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);
    const out = await resolveLiveEtaFact(baseRow(), baseCustomer());
    expect(out.fixExpiresAtMs).toBe(fixAt + STALE_TECH_STATUS_MS);
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

  // Codex round-9 P2 (PR #5334): the TTL counts from insertion, but a fix
  // resolveFreshTechPosition accepted at 4 min 50 s old must not be reused
  // for a further 60 s — the public tracker rejects it as stale at 5 min.
  test('a nearly-stale GPS fix is NOT reused past its own freshness deadline, even inside the 60s insert TTL', async () => {
    process.env[GATE] = 'true';
    const t0 = Date.now();
    resolveFreshTechPosition.mockResolvedValue({ ...FRESH_POSITION, lastReportedAt: new Date(t0 - (STALE_TECH_STATUS_MS - 10 * 1000)).toISOString() });
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    let now = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const row = baseRow();
      await resolveLiveEtaFact(row, baseCustomer());
      now = t0 + 5 * 1000; // fix is 4:55 old, still fresh — reused
      await resolveLiveEtaFact(row, baseCustomer());
      expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
      now = t0 + 15 * 1000; // fix would now be 5:05 old: stale to the tracker, though the 60s TTL has 45s left
      await resolveLiveEtaFact(row, baseCustomer());
      expect(resolveFreshTechPosition).toHaveBeenCalledTimes(2);
    } finally {
      Date.now.mockRestore();
    }
  });

  test('a brand-new GPS fix still gets the full 60s insert TTL (the cap never LENGTHENS it)', async () => {
    process.env[GATE] = 'true';
    const t0 = Date.now();
    resolveFreshTechPosition.mockResolvedValue({ ...FRESH_POSITION, lastReportedAt: new Date(t0).toISOString() });
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);

    let now = t0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const row = baseRow();
      await resolveLiveEtaFact(row, baseCustomer());
      now = t0 + 59 * 1000;
      await resolveLiveEtaFact(row, baseCustomer());
      expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
      now = t0 + 61 * 1000;
      await resolveLiveEtaFact(row, baseCustomer());
      expect(resolveFreshTechPosition).toHaveBeenCalledTimes(2);
    } finally {
      Date.now.mockRestore();
    }
  });

  // Codex round-16 P1 (PR #5334): a failed / no-fix lookup is cached ~10 s, not 60 s.
  test('a failed/null lookup is cached only ~10s: reused at 9s, retried at 11s (a good result still lasts 60s)', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(null);
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const row = baseRow();
      const t0 = now;
      await resolveLiveEtaFact(row, baseCustomer());
      now = t0 + 9 * 1000;
      await resolveLiveEtaFact(row, baseCustomer());
      expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
      now = t0 + 11 * 1000;
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

describe('perVisitLiveEtas — grouped-stop siblings share minutes, never a tracking link (Codex round-9 P2, PR #5334)', () => {
  test('two siblings at one stop get the SAME minutes/asOf but each its OWN trackUrl', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);
    const pest = baseRow({ id: 'svc-pest', service_type: 'Pest Control', track_view_token: 'token-pest' });
    const lawn = baseRow({ id: 'svc-lawn', service_type: 'Lawn Care', track_view_token: 'token-lawn' });
    const customer = baseCustomer();
    const key = liveEtaDedupeKey(pest, customer);
    expect(liveEtaDedupeKey(lawn, customer)).toBe(key);

    // The representative's OWN result carries the pest link — exactly what
    // the aggregator stores per key and used to copy to every sibling.
    const representative = await resolveLiveEtaFact(pest, customer);
    expect(representative.trackUrl).toContain('/track/token-pest');

    const etas = perVisitLiveEtas([pest, lawn], [key, key], new Map([[key, representative]]));
    expect(etas[0].trackUrl).toContain('/track/token-pest');
    expect(etas[1].trackUrl).toContain('/track/token-lawn');
    expect(etas[1].trackUrl).not.toContain('token-pest');
    expect(etas[0].minutes).toBe(etas[1].minutes);
    expect(etas[0].asOf).toBe(etas[1].asOf);
    expect(resolveFreshTechPosition).toHaveBeenCalledTimes(1);
  });

  test('a sibling with no track_view_token gets NO link — never the representative\'s', async () => {
    process.env[GATE] = 'true';
    resolveFreshTechPosition.mockResolvedValue(FRESH_POSITION);
    calculateBoundedTrackingEta.mockResolvedValue(ETA_RESULT);
    const pest = baseRow({ id: 'svc-pest', track_view_token: 'token-pest' });
    const lawn = baseRow({ id: 'svc-lawn', track_view_token: null });
    const customer = baseCustomer();
    const key = liveEtaDedupeKey(pest, customer);
    const representative = await resolveLiveEtaFact(pest, customer);

    const etas = perVisitLiveEtas([pest, lawn], [key, key], new Map([[key, representative]]));
    expect(etas[0].trackUrl).toContain('/track/token-pest');
    expect(etas[1].trackUrl).toBeNull();
    expect(etas[1].minutes).toBe(representative.minutes);
  });

  test('a visit with no key / no resolved result stays null', () => {
    expect(perVisitLiveEtas([baseRow(), baseRow()], [null, 'k'], new Map())).toEqual([null, null]);
  });
});

// Codex round-13 P2 (PR #5334): limit(3) could drop the en-route row on a
// 4-service day, so "where's the tech" found no live tech.
describe('upcoming services keep a live visit the limit(3) would drop (round 13 P2)', () => {
  const row = (id, date, track_state = 'scheduled') => ({ id, scheduled_date: date, track_state });
  test('a customer with no live row (or a live row already in the first three) gets EXACTLY the old rows in the old order', () => {
    const limited = [row('a', '2026-09-30'), row('b', '2026-09-30'), row('c', '2026-10-01')];
    expect(mergeLiveUpcoming(limited, [])).toBe(limited);
    expect(mergeLiveUpcoming(limited, [row('b', '2026-09-30', 'en_route')])).toBe(limited);
  });

  test('the live row the limit dropped is merged in, a non-live row comes off the end, date order is kept', () => {
    const limited = [row('a', '2026-09-30'), row('b', '2026-09-30'), row('c', '2026-09-30')];
    const merged = mergeLiveUpcoming(limited, [row('d', '2026-09-30', 'en_route')]);
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']);
    expect(merged).toHaveLength(3);
  });

  test('live rows are never the ones dropped to stay at the cap', () => {
    const limited = [row('a', '2026-09-30', 'en_route'), row('b', '2026-09-30'), row('c', '2026-10-02')];
    const merged = mergeLiveUpcoming(limited, [row('a', '2026-09-30', 'en_route'), row('d', '2026-10-01', 'on_property')]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'd']);
  });

  describe('loadUpcomingServices — the live query runs only when LIVE ETA is requested', () => {
    function loadWithDb(limitedRows, liveRows) {
      const calls = { live: 0, base: 0 };
      let agg;
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => jest.fn(() => {
          let isLive = false;
          const chain = {};
          for (const m of ['leftJoin', 'where', 'whereNotIn', 'orderBy', 'limit']) chain[m] = () => chain;
          chain.whereIn = (col) => { if (col === 'ss.track_state') isLive = true; return chain; };
          chain.select = async () => { if (isLive) { calls.live += 1; return liveRows; } calls.base += 1; return limitedRows; };
          return chain;
        }));
        agg = require('../services/context-aggregator');
      });
      return { agg, calls };
    }
    afterEach(() => { jest.dontMock('../models/db'); });

    // Codex round-14 P2: the live-row query is independent of the operational
    // status list. An in-memory query engine models the two constraints.
    function loadWithRows(allRows) {
      let agg;
      jest.isolateModules(() => {
        jest.doMock('../models/db', () => jest.fn(() => {
          const filters = [];
          let cap = Infinity;
          const chain = {};
          chain.leftJoin = () => chain;
          chain.where = (col, opOrVal, maybeVal) => {
            const [op, val] = maybeVal === undefined ? ['=', opOrVal] : [opOrVal, maybeVal];
            filters.push((r) => (op === '>=' ? String(r[col.replace('ss.', '')]) >= String(val) : String(r[col.replace('ss.', '')]) === String(val)));
            return chain;
          };
          chain.whereIn = (col, list) => { filters.push((r) => list.includes(r[col.replace('ss.', '')])); return chain; };
          chain.whereNotIn = (col, list) => { filters.push((r) => !list.includes(r[col.replace('ss.', '')])); return chain; };
          chain.orderBy = () => chain;
          chain.limit = (n) => { cap = n; return chain; };
          chain.select = async () => allRows.filter((r) => filters.every((f) => f(r))).slice(0, cap);
          return chain;
        }));
        agg = require('../services/context-aggregator');
      });
      return agg;
    }

    test('a `rescheduled` row with a live track_state (markEnRoute status sync failed) is still found; terminal rows and other days are not', async () => {
      const today = require('../utils/datetime-et').etDateString();
      const mk = (id, status, track_state, scheduled_date = today) => ({ id, customer_id: 'c1', status, track_state, scheduled_date });
      const rows = [
        mk('p1', 'confirmed', 'scheduled'), mk('p2', 'confirmed', 'scheduled'), mk('p3', 'confirmed', 'scheduled'),
        mk('split', 'rescheduled', 'en_route'),
        mk('done', 'completed', 'en_route'), mk('cxl', 'cancelled', 'on_property'), mk('skip', 'skipped', 'en_route'),
        mk('tomorrow', 'rescheduled', 'en_route', '2999-01-01'),
      ];
      const agg = loadWithRows(rows);
      const out = await agg.loadUpcomingServices({ id: 'c1' }, true);
      expect(out.map((r) => r.id)).toContain('split');
      for (const gone of ['done', 'cxl', 'skip', 'tomorrow']) expect(out.map((r) => r.id)).not.toContain(gone);
      expect(out).toHaveLength(3);
      // Without LIVE ETA the split-state row is (as before) not requested at all.
      const plain = await agg.loadUpcomingServices({ id: 'c1' }, false);
      expect(plain.map((r) => r.id)).not.toContain('split');
    });

    test('includeLiveEta false: only the original limited query runs (byte-identical rows)', async () => {
      const limited = [row('a', '2026-09-30'), row('b', '2026-09-30'), row('c', '2026-09-30')];
      const { agg, calls } = loadWithDb(limited, [row('d', '2026-09-30', 'en_route')]);
      await expect(agg.loadUpcomingServices({ id: 'c1' }, false)).resolves.toBe(limited);
      expect(calls).toEqual({ live: 0, base: 1 });
    });

    test('includeLiveEta true: the live row missing from the limited list is merged in', async () => {
      const limited = [row('a', '2026-09-30'), row('b', '2026-09-30'), row('c', '2026-09-30')];
      const { agg, calls } = loadWithDb(limited, [row('d', '2026-09-30', 'en_route')]);
      const out = await agg.loadUpcomingServices({ id: 'c1' }, true);
      expect(out.map((r) => r.id)).toContain('d');
      expect(out).toHaveLength(3);
      expect(calls).toEqual({ live: 1, base: 1 });
    });
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

  // Codex round-9 P2 (PR #5334): "about 2 hours out" used to be recorded as
  // the raw captured "2", so a LIVE ETA of "2 minutes" accepted an ETA off by
  // nearly two hours. Hour figures are now normalized to minutes BEFORE the
  // comparison: 2 hours is 120 minutes.
  test('"About 2 hours out." is REJECTED when the LIVE ETA is 2 minutes (round 9: hours are not minutes)', () => {
    const result = validateLiveEtaMinutes({ reply: 'About 2 hours out.', factsBlock: 'LIVE ETA: about 2 minutes (GPS, as of 2:45 PM ET)' });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatch(/120/);
  });

  test('"About 2 hours out." passes only against a LIVE ETA of exactly 120 minutes', () => {
    const result = validateLiveEtaMinutes({ reply: 'About 2 hours out.', factsBlock: 'LIVE ETA: about 120 minutes (GPS, as of 2:45 PM ET)' });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  // Codex round-10 P2 (PR #5334): "12.5 minutes away" was read as "5" (the
  // unit regex matched after the decimal point) and the "." split the
  // sentence, so a live "5 minutes" fact accepted a 12.5-minute claim.
  describe('decimal minutes are one value, never a fractional suffix (Codex round-10 P2)', () => {
    test.each([
      ['The tech is 12.5 minutes away.', [12.5]],
      ['12.5 min out', [12.5]],
      ['about 7.5 minutes from you', [7.5]],
      ['between 10.5 and 12 minutes away', [10.5, 12]],
    ])('findEtaMinutesClaims(%p) reads %p', (reply, minutes) => {
      expect(findEtaMinutesClaims(reply).map((c) => c.minutes)).toEqual(minutes);
    });

    test('a decimal claim never equals an integer LIVE ETA — even the fractional suffix or truncated integer', () => {
      for (const n of [5, 12]) {
        const result = validateLiveEtaMinutes({ reply: 'The tech is 12.5 minutes away.', factsBlock: `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)` });
        expect(result.ok).toBe(false);
      }
    });

    test('"1.5 hours" still normalizes to 90 minutes', () => {
      expect(normalizeTimeQuantities('1.5 hours away')).toBe('90 minutes away');
    });
  });

  // Codex pre-push P1 (round 11, PR #5334): with NO live ETA fact, "2 hours
  // away" passed while "120 minutes away" failed — hours were only
  // normalized on the live-context path. They are now normalized on every
  // path; windows and durations stay unaffected.
  describe('hour-based arrival claims are rejected with NO live ETA fact, exactly like their minutes equivalents (round 11 P1)', () => {
    const NO_LIVE = 'LIVE STATUS: tech marked en route to this visit';
    test.each([
      ['The tech is 2 hours away.', 'The tech is 120 minutes away.'],
      ['He is 2 hrs out.', 'He is 120 minutes out.'],
      ['He is 1 hr 20 min away.', 'He is 80 minutes away.'],
      ['He should arrive in about 1.5 hours.', 'He should arrive in about 90 minutes.'],
    ])('%p is rejected like %p', (hours, minutes) => {
      expect(validateLiveEtaMinutes({ reply: minutes, factsBlock: NO_LIVE }).ok).toBe(false);
      expect(validateLiveEtaMinutes({ reply: hours, factsBlock: NO_LIVE }).ok).toBe(false);
      expect(findEtaMinutesClaims(hours).map((c) => c.minutes)).toEqual(findEtaMinutesClaims(minutes).map((c) => c.minutes));
    });

    test.each([
      'Your 2 hour arrival window starts at 9.',
      'Your arrival window is 2 hours.',
      'Your arrival window: 1 to 2 hours.',
      'The treatment takes about 2 hours.',
      'Please allow 2 hours before letting pets out.',
    ])('%p is never an ETA claim', (reply) => {
      expect(findEtaMinutesClaims(reply)).toEqual([]);
      expect(validateLiveEtaMinutes({ reply, factsBlock: NO_LIVE })).toEqual({ ok: true, violations: [] });
    });
  });

  // Codex round-11 P2 (PR #5334): "one hundred twenty minutes away" used to
  // read as "1 hundred 20 minutes", so only the trailing 20 was validated.
  describe('written-out hundreds are ONE value (round 11 P2)', () => {
    const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;
    test.each([
      ['one hundred twenty minutes away', 120],
      ['a hundred and twenty minutes away', 120],
      ['one hundred and twenty minutes away', 120],
      ['hundred-twenty minutes away', 120],
      ['one hundred twenty-five minutes out', 125],
      ['a hundred minutes away', 100],
    ])('%p is exactly %p — accepted only against that live figure', (phrase, minutes) => {
      const reply = `The tech is ${phrase}.`;
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(minutes) }).ok).toBe(true);
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(20) }).ok).toBe(false);
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(25) }).ok).toBe(false);
      expect(findEtaMinutesClaims(reply).map((c) => c.minutes)).toEqual([minutes]);
    });

    test('normalizeNumberWords reads the whole compound', () => {
      expect(normalizeNumberWords('one hundred twenty minutes')).toBe('120 minutes');
      expect(normalizeNumberWords('twenty-five and twelve')).toBe('25 and 12');
    });

    test.each([
      'The tech is a thousand minutes away.',
      'The tech is a dozen minutes away.',
      'The tech is hundreds of minutes away.',
    ])('%p — a number word it cannot convert next to a time unit fails closed, live ETA or not', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: 'LIVE ETA: about 12 minutes (GPS, as of 2:45 PM ET)' }).ok).toBe(false);
      expect(validateLiveEtaMinutes({ reply, factsBlock: 'LIVE STATUS: tech marked en route to this visit' }).ok).toBe(false);
    });

    test('a hundred of something that is not a time is untouched', () => {
      expect(validateLiveEtaMinutes({ reply: 'We serve over a hundred neighbors. The tech is on the way!', factsBlock: facts(12) }))
        .toEqual({ ok: true, violations: [] });
    });
  });

  // Codex pre-push P1 (round 12, PR #5334): the window exclusion is ONE
  // shared predicate (isWindowQuantity) used by the normalizer AND every
  // leftover-word check, so a window hour the normalizer leaves alone is
  // never then rejected as an unread ETA — with live facts present.
  describe('appointment-window hours pass with LIVE facts present; real hour ETAs still fail (round 12 P1)', () => {
    const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;
    test.each([
      'Your arrival window is 2 hours.',
      'Your 2 hour arrival window starts at 9.',
      'Your tech will arrive within the 2-hour arrival window.',
      'Your 2-hour window starts at 9.',
      'Your arrival window: 1 to 2 hours.',
      'Your arrival window is half an hour.',
      'Your arrival window is a quarter of an hour.',
      'Your arrival window is an hour.',
      'Your arrival window is 2 hours. The tech is 2 minutes away.',
    ])('%p is accepted against a live 2-minute ETA', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) })).toEqual({ ok: true, violations: [] });
    });

    test.each([
      'The tech is 2 hours away.',
      'He is about half an hour away.',
      'He is an hour out.',
      'The tech is a thousand minutes away.',
      'Your arrival window is 2 hours, and the tech is 2 hours away.',
    ])('%p is still rejected against a live 2-minute ETA', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) }).ok).toBe(false);
    });

    // Codex round-12 P2: a hyphenated window ("the 2-hour arrival window")
    // used to read as a bare "2 minutes" claim — checked against a live figure
    // that is NOT 2, so the coincidence above cannot hide it.
    test.each([
      'Your tech will arrive within the 2-hour arrival window.',
      'Your 2-hour window starts at 9.',
      'Your tech will arrive within the 2 hour arrival window.',
    ])('%p passes against a live 12-minute ETA', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(12) })).toEqual({ ok: true, violations: [] });
    });

    test.each([
      ['The tech is 2-hour away.', 12],
      ['The tech is 12-minute away.', 9],
    ])('a hyphenated real ETA %p is still checked against live %p', (reply, live) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(live) }).ok).toBe(false);
    });

    test('a hyphenated minutes ETA matching the live figure is accepted', () => {
      expect(validateLiveEtaMinutes({ reply: 'The tech is 12-minute away.', factsBlock: facts(12) }).ok).toBe(true);
    });

  // Codex pre-push P1 (round 13, PR #5334): a duration governed by an OFFICE
  // follow-up verb ("within the hour" is an approved sms-followup-sla phrase)
  // is never a tech ETA, even when "arrival" shares the sentence.
  describe('office follow-up timing is not a tech ETA; tech arrival timing still is (round 13 P1)', () => {
    const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;
    test.each([
      "I'll confirm your arrival window within the hour.",
      "I'll get back to you within the hour about your arrival.",
      "We'll text you back within an hour about your arrival.",
      'Someone will call you back within 30 minutes to confirm arrival.',
      "I'll let you know within the hour when the tech is on the way.",
      'Within the hour.',
    ])('%p passes with live facts present', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) })).toEqual({ ok: true, violations: [] });
    });

    test.each([
      'The tech will arrive within the hour.',
      "I'll confirm the tech is on the way in 20 minutes.",
      "The tech is 20 minutes away, I'll confirm.",
      "I'll check — he is about 20 minutes away.",
      "He will be there in 20. I'll confirm.",
    ])('%p is still an ETA claim, rejected against a live 2', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) }).ok).toBe(false);
    });

    test('the SLA phrase list is the shared follow-up module\'s, not a copy', () => {
      expect(require('../services/sms-followup-sla').SLA_PHRASES).toContain('within the hour');
    });
  });

    test('the normalizer and the leftover-word checks agree on windows', () => {
      const body = 'Your arrival window is 2 hours.';
      expect(normalizeTimeQuantities(body)).toBe(body);
      expect(bodyHasTimedArrivalPhrase(body, { unnormalizedHoursOnly: true })).toBe(false);
      expect(bodyHasTimedArrivalPhrase(body, { unconvertedNumbersOnly: true })).toBe(false);
      expect(bodyHasTimedArrivalPhrase('Your arrival window is half an hour.')).toBe(false);
    });
  });

  // Codex round-13 P2 (PR #5334): seconds/days/weeks arrival durations and
  // completed-arrival claims.
  describe('seconds, days and completed arrivals (round 13 P2)', () => {
    const facts = (n) => `LIVE STATUS: tech marked en route to this visit, LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;
    test.each([
      ['The tech is 90 seconds away.', [1.5]],
      ['The tech is 30 secs out.', [0.5]],
      ['The tech is 60 seconds away.', [1]],
    ])('%p reads as %p minutes', (reply, minutes) => {
      expect(findEtaMinutesClaims(reply).map((c) => c.minutes)).toEqual(minutes);
    });
    test.each([
      'The tech is 90 seconds away.',
      'The tech is a few seconds away.',
      'The tech is 2 days away.',
      'The tech will arrive in 3 weeks.',
    ])('%p is rejected against a live 2-minute ETA', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) }).ok).toBe(false);
    });
    test('"60 seconds away" binds to a live 1-minute ETA exactly', () => {
      expect(validateLiveEtaMinutes({ reply: 'The tech is 60 seconds away.', factsBlock: facts(1) }).ok).toBe(true);
    });
    test('a bare "day" (no count) is never a duration claim', () => {
      expect(validateLiveEtaMinutes({ reply: 'Have a great day — the tech is on the way!', factsBlock: facts(2) }).ok).toBe(true);
    });

    test.each([
      'The technician has arrived.',
      'The tech just arrived at your home.',
      'The tech is here.',
      "He's outside.",
      'The tech pulled up.',
    ])('%p is rejected while the facts say the tech is still EN ROUTE', (reply) => {
      const result = validateLiveEtaMinutes({ reply, factsBlock: facts(2) });
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatch(/ARRIVED/);
    });
    test('the same arrival claims pass once the facts say the tech is on site', () => {
      expect(validateLiveEtaMinutes({ reply: 'The technician has arrived.', factsBlock: 'LIVE STATUS: tech marked on site at this visit' }).ok).toBe(true);
    });
    test.each([
      'The tech will arrive in 2 minutes.',
      'The tech is arriving in 2 minutes.',
      "The tech hasn't arrived yet.",
      'We are here to help — the tech is on the way!',
    ])('%p stays en-route status (not a completed arrival)', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) }).ok).toBe(true);
    });
  });

  describe('normalizeTimeQuantities — every hour quantity is read WITH its unit (Codex round-9 P2)', () => {
    test.each([
      ['about 2 hours out', 'about 120 minutes out'],
      ['about 2 hrs out', 'about 120 minutes out'],
      ['2h out', '120 minutes out'],
      ['1 hr 20 min away', '80 minutes away'],
      ['1h20m away', '80 minutes away'],
      ['1 hour and 20 minutes away', '80 minutes away'],
      ['an hour and 20 minutes away', '80 minutes away'],
      ['1.5 hours away', '90 minutes away'],
      ['2 and a half hours away', '150 minutes away'],
      ['2 hours and a half away', '150 minutes away'],
      ['an hour and a half away', '90 minutes away'],
      ['1 to 2 hours away', '60-120 minutes away'],
    ])('%p reads as %p', (input, expected) => {
      expect(normalizeTimeQuantities(input)).toBe(expected);
    });

    test('a vague hour phrase is left alone for the fail-closed check, never guessed', () => {
      expect(normalizeTimeQuantities('half an hour away')).toBe('half an hour away');
      expect(normalizeTimeQuantities('an hour out')).toBe('an hour out');
      expect(normalizeTimeQuantities('a couple hours out')).toBe('a couple hours out');
    });
  });

  describe('validateLiveEtaMinutes — hour-based ETAs compare as minutes (Codex round-9 P2)', () => {
    const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;
    test.each([
      ['He is 1 hr 20 min out.', 80],
      ['He is 1 hour and 20 minutes away.', 80],
      ['He is 1.5 hours away.', 90],
      ['He is two and a half hours out.', 150],
      ['He is an hour and a half away.', 90],
    ])('%p matches a LIVE ETA of exactly %p minutes', (reply, minutes) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(minutes) }).ok).toBe(true);
    });

    test.each([
      'He is 1 hr 20 min out.',
      'He is 1 hour and 20 minutes away.',
      'He is 1.5 hours away.',
      'He is two and a half hours out.',
      'He is an hour and a half away.',
      'He is 2 hours out.',
    ])('%p is rejected against a LIVE ETA of 2 minutes', (reply) => {
      expect(validateLiveEtaMinutes({ reply, factsBlock: facts(2) }).ok).toBe(false);
    });

    test.each([
      'He is about half an hour away.',
      'He is an hour out.',
      'He is a couple hours out.',
      'He is an hour or so away.',
      'He is an hour out, about 12 minutes.',
    ])('%p — an hour phrase the parser cannot turn into minutes fails closed even beside a matching minutes figure', (reply) => {
      const result = validateLiveEtaMinutes({ reply, factsBlock: facts(12) });
      expect(result.ok).toBe(false);
    });

    test('an hour-based dry-time duration in an unrelated clause is still never an ETA claim', () => {
      const result = validateLiveEtaMinutes({
        reply: 'The tech is 12 minutes away. Please keep pets off the lawn — allow 2 hours before letting them out.',
        factsBlock: facts(12),
      });
      expect(result).toEqual({ ok: true, violations: [] });
    });
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

// Codex pre-push P1 (round 14, PR #5334): bodyMentionsArrival is the
// AFFIRMATIVE en-route status predicate, not a broad arrival-word trigger.
describe('bodyMentionsArrival — affirmative en-route status only (round 14 P1)', () => {
  test.each([
    'The tech is on the way.', 'Your tech is en route.', 'The tech has left for your place.', 'The tech is close.',
    'He will be there shortly.', 'He is heading over now.', 'The tech is arriving in 2 minutes.',
  ])('%p is an en-route status claim', (body) => {
    expect(bodyMentionsArrival(body)).toBe(true);
  });
  test.each([
    "I'll confirm your arrival window within the hour.", 'Your arrival window is 2 hours.', 'You have 2 visits left this year.',
    "I'll text you once he's on the way.", 'If the tech is en route we will let you know.',
  ])('%p is not', (body) => {
    expect(bodyMentionsArrival(body)).toBe(false);
  });
});

// Codex round-15 (PR #5334): negated corrections, coming/headed, qualified bare
// numbers, and equal live ETA entries.
describe('round 15: negation, coming/headed, qualified ETAs, equal entries', () => {
  let priorGate;
  beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });
  test.each([
    'He is no longer en route.', 'The tech is not on the way yet.', "The tech isn't coming today.",
    'The tech is not headed your way.', "He hasn't left for your place.",
  ])('%p is a correction, not an affirmative en-route claim', (body) => {
    expect(bodyMentionsArrival(body)).toBe(false);
  });
  test.each([
    'The tech is coming now.', 'The tech is headed your way.', "He's heading over.", 'The technician is coming.',
    'Not yet, but the tech is on the way.', 'The tech is on the way.',
  ])('%p is an affirmative en-route claim', (body) => {
    expect(bodyMentionsArrival(body)).toBe(true);
  });
  test.each([
    'The tech has not arrived yet.', "The tech isn't here yet.", "He hasn't pulled up.", 'The tech is not here.',
  ])('%p is not a completed-arrival claim', (body) => {
    expect(bodyClaimsCompletedArrival(body)).toBe(false);
  });
  test('"We are coming to help" is not a tech status claim', () => {
    expect(bodyMentionsArrival('We are coming to help.')).toBe(false);
  });

  test.each(['ETA is 20 max', 'ETA is 20 or so', 'ETA 20 tops', 'His ETA is 20 give or take.'])('%p is a 20-minute claim', (body) => {
    expect(findEtaMinutesClaims(body).map((c) => c.minutes)).toEqual([20]);
    expect(findGroundedMinutesFigures(body).map((c) => c.minutes)).toEqual([20]);
    const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;
    expect(validateLiveEtaMinutes({ reply: body, factsBlock: facts(9) }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: body, factsBlock: facts(20) }).ok).toBe(true);
  });
  test.each(['You have 20 or so visits left.', 'ETA is 20 visits'])('%p stays a count, not an ETA', (body) => {
    expect(findEtaMinutesClaims(body)).toEqual([]);
  });

  test('two LIVE ETA lines with the SAME figure still count as two stops — no number approved', () => {
    const facts = 'LIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)\nLIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)';
    expect(validateLiveEtaMinutes({ reply: 'The tech is 9 minutes away.', factsBlock: facts }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: 'The techs are on the way!', factsBlock: facts }).ok).toBe(true);
  });
});

// Codex round-16 P2s (PR #5334).
describe('round 16 P2s: Nm, slash fractions, status-only groups, distinct stops', () => {
  let priorGate;
  beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });
  const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;

  test.each([['ETA: 20m', 20], ['His ETA is 20 m', 20], ['tech is 20m away', 20]])('%p is an exact %p-minute claim (not just an unclassified signal)', (body, m) => {
    expect(findEtaMinutesClaims(body).map((c) => c.minutes)).toEqual([m]);
    expect(validateLiveEtaMinutes({ reply: body, factsBlock: facts(9) }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: body, factsBlock: facts(m) }).ok).toBe(true);
  });
  test('"5 m" outside an arrival sentence (metres) is untouched', () => {
    expect(findEtaMinutesClaims('The hedge is 5 m wide.')).toEqual([]);
  });

  test.each([['1/2 hour away', 30], ['3/4 hr out', 45], ['1 1/2 hours away', 90]])('%p reads as %p minutes, never "1/120"', (body, m) => {
    expect(findEtaMinutesClaims(body).map((c) => c.minutes)).toEqual([m]);
    expect(validateLiveEtaMinutes({ reply: `The tech is ${body}.`, factsBlock: facts(m) }).ok).toBe(true);
    expect(validateLiveEtaMinutes({ reply: `The tech is ${body}.`, factsBlock: facts(120) }).ok).toBe(false);
  });
  test('an appointment window in fractions is left alone', () => {
    expect(validateLiveEtaMinutes({ reply: 'Your arrival window is 1/2 hour.', factsBlock: facts(12) })).toEqual({ ok: true, violations: [] });
  });

  test('buildLiveEtaSnapshot keeps a status-only (minutes null) entry', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['t'] }] }))
      .toEqual({ entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['t'] }] });
  });

  describe('buildLiveEtaGroups', () => {
    const today = require('../utils/datetime-et').etDateString();
    const svc = (id, extra = {}) => ({ id, scheduled_date: today, status: 'en_route', track_state: 'en_route', track_view_token: `tok-${id}`, technician_id: 'tech-1', ...extra });
    test('an unresolved live stop still gets a minutes-null group (grouped siblings share one); resolved keeps minutes', () => {
      const rows = [svc('a'), svc('b'), svc('c', { technician_id: null })];
      const groups = buildLiveEtaGroups({ upcomingServices: rows, liveEtaKeys: ['k1', 'k1', null], uniqueLiveEtaKeys: ['k1'], liveEtaResultByKey: new Map([['k1', null]]), includeLiveEta: true });
      expect(groups.map(({ destinations, ...g }) => g)).toEqual([
        { minutes: null, scheduledServiceIds: ['a', 'b'], trackTokens: ['tok-a', 'tok-b'], state: 'en_route', technicianId: 'tech-1' },
        { minutes: null, scheduledServiceIds: ['c'], trackTokens: ['tok-c'], state: 'en_route' },
      ]);
      const resolved = buildLiveEtaGroups({ upcomingServices: rows.slice(0, 2), liveEtaKeys: ['k1', 'k1'], uniqueLiveEtaKeys: ['k1'], liveEtaResultByKey: new Map([['k1', { minutes: 9, fixExpiresAtMs: 5 }]]), includeLiveEta: true });
      expect(resolved.map(({ destinations, ...g }) => g)).toEqual([{ minutes: 9, scheduledServiceIds: ['a', 'b'], trackTokens: ['tok-a', 'tok-b'], state: 'en_route', technicianId: 'tech-1', fixExpiresAtMs: 5 }]);
    });
    test('includeLiveEta false or a non-live row: no groups', () => {
      expect(buildLiveEtaGroups({ upcomingServices: [svc('a')], liveEtaKeys: [null], uniqueLiveEtaKeys: [], liveEtaResultByKey: new Map(), includeLiveEta: false })).toEqual([]);
      expect(buildLiveEtaGroups({ upcomingServices: [svc('a', { track_state: 'scheduled' })], liveEtaKeys: [null], uniqueLiveEtaKeys: [], liveEtaResultByKey: new Map(), includeLiveEta: true })).toEqual([]);
    });
  });

  test('grouped siblings render the ETA line twice but are ONE stop: a numeric draft is approved; two real stops are not', () => {
    const twoLines = `${facts(9)}\n${facts(9)}`;
    expect(validateLiveEtaMinutes({ reply: 'The tech is 9 minutes away.', factsBlock: twoLines, liveEtaStopCount: 1 }).ok).toBe(true);
    expect(validateLiveEtaMinutes({ reply: 'The tech is 9 minutes away.', factsBlock: twoLines, liveEtaStopCount: 2 }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: 'The tech is 9 minutes away.', factsBlock: twoLines }).ok).toBe(false);
  });
});

describe('counted day/week/month durations need a tech subject (round-17 follow-up)', () => {
  let priorGate;
  beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });
  const facts = 'LIVE ETA: about 9 minutes (GPS, as of 2:45 PM ET)';
  test.each(['Your visit is 2 days away.', "We'll see you in 2 weeks.", 'Your next treatment is in 3 weeks.'])('%p passes with and without live facts', (reply) => {
    expect(validateLiveEtaMinutes({ reply, factsBlock: facts }).ok).toBe(true);
    expect(validateLiveEtaMinutes({ reply, factsBlock: 'LIVE STATUS: tech marked en route to this visit' }).ok).toBe(true);
  });
  test.each(['The tech is 2 days away.', 'He will arrive in 3 weeks.'])('%p is rejected', (reply) => {
    expect(validateLiveEtaMinutes({ reply, factsBlock: facts }).ok).toBe(false);
  });
});

// Codex round-18 P2s (PR #5334).
describe('round 18 P2s: decimals, driving, on-site groups, technician identity', () => {
  let priorGate;
  beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });
  const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;

  test.each([
    'He will be there in 12.5.', 'The tech should make it in 12.5', "He'll be by in 12.5", 'ETA 12.5', 'ETA: 12.50', 'ETA is 12.5 max',
    '12.5min away', '12.5 min away', 'The tech is 12.5 out',
  ])('%p is ONE decimal claim (12.5) — never the prefix 12 or suffix 5, and never equal to an integer live ETA', (reply) => {
    const claims = [...findEtaMinutesClaims(reply), ...findGroundedMinutesFigures(reply)].map((c) => c.minutes);
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(c).toBe(12.5);
    for (const live of [12, 5, 13]) expect(validateLiveEtaMinutes({ reply, factsBlock: facts(live) }).ok).toBe(false);
  });

  test.each([
    'The technician is driving to your house now.', "He's driving over.", 'The tech is in the truck.', 'The crew is on the road.',
  ])('%p is an affirmative en-route status', (body) => {
    expect(bodyMentionsArrival(body)).toBe(true);
  });
  test.each(['The tech is not driving over today.', 'We are driving to a training.'])('%p is not', (body) => {
    expect(bodyMentionsArrival(body)).toBe(false);
  });

  test('numeric ambiguity counts only EN-ROUTE stops: en-route(12) + on-site allows "12 minutes away"; two en-route do not', () => {
    const oneEnRouteOneOnSite = { liveEtaGroups: [{ minutes: 12, state: 'en_route' }, { minutes: null, state: 'on_property' }] };
    const twoEnRoute = { liveEtaGroups: [{ minutes: 12, state: 'en_route' }, { minutes: 12, state: 'en_route' }] };
    expect(countEnRouteEtaStops(oneEnRouteOneOnSite)).toBe(1);
    expect(countEnRouteEtaStops(twoEnRoute)).toBe(2);
    expect(countEnRouteEtaStops({})).toBeNull();
    const reply = 'The tech is 12 minutes away.';
    expect(validateLiveEtaMinutes({ reply, factsBlock: facts(12), liveEtaStopCount: countEnRouteEtaStops(oneEnRouteOneOnSite) }).ok).toBe(true);
    expect(validateLiveEtaMinutes({ reply, factsBlock: facts(12), liveEtaStopCount: countEnRouteEtaStops(twoEnRoute) }).ok).toBe(false);
  });

  describe('buildLiveEtaGroups — on-site visits and technician identity', () => {
    const today = require('../utils/datetime-et').etDateString();
    const svc = (id, extra = {}) => ({ id, scheduled_date: today, status: 'en_route', track_state: 'en_route', track_view_token: `tok-${id}`, technician_id: 'tech-1', ...extra });
    test('an on_property visit becomes a minutes-null status group recorded as on_property; a scheduled one does not', () => {
      const rows = [svc('a', { status: 'on_site', track_state: 'on_property' }), svc('b', { track_state: 'scheduled' })];
      expect(buildLiveEtaGroups({ upcomingServices: rows, liveEtaKeys: [null, null], uniqueLiveEtaKeys: [], liveEtaResultByKey: new Map(), includeLiveEta: true }).map(({ destinations, ...g }) => g))
        .toEqual([{ minutes: null, scheduledServiceIds: ['a'], trackTokens: ['tok-a'], state: 'on_property', technicianId: 'tech-1' }]);
    });
    test('the snapshot carries technicianId and state through', () => {
      expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: 9, scheduledServiceIds: ['a'], technicianId: 'tech-1', state: 'en_route' }] }))
        .toEqual({ entries: [{ minutes: 9, scheduledServiceIds: ['a'], trackTokens: [], technicianId: 'tech-1', state: 'en_route' }] });
    });
  });
});

// Codex round-19 P2s (PR #5334).
describe('round 19 P2s: window minutes, zero, tracking-link digits, on-site sibling grouping', () => {
  let priorGate;
  beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; });
  afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });
  const facts = (n) => `LIVE ETA: about ${n} minutes (GPS, as of 2:45 PM ET)`;

  test.each([
    'Your 120-minute arrival window starts at 9.', 'Your arrival window is 120 minutes.', 'Your 90 minute window starts at 9.',
    'Your arrival window is 90 seconds.', 'Your arrival window: 20-30 minutes.',
  ])('%p (a window, any unit) is never an ETA claim', (reply) => {
    expect(findEtaMinutesClaims(reply)).toEqual([]);
    expect(findGroundedMinutesFigures(reply)).toEqual([]);
    expect(validateLiveEtaMinutes({ reply, factsBlock: facts(9) })).toEqual({ ok: true, violations: [] });
  });
  test('a real minutes ETA beside a window is still checked', () => {
    expect(validateLiveEtaMinutes({ reply: 'Your 120-minute arrival window starts at 9. The tech is 20 minutes away.', factsBlock: facts(9) }).ok).toBe(false);
  });

  test('"zero" is a number: "zero minutes away" is a 0-minute claim, checked against the live figure', () => {
    expect(normalizeNumberWords('zero minutes away')).toBe('0 minutes away');
    expect(findEtaMinutesClaims('The tech is zero minutes away.').map((c) => c.minutes)).toEqual([0]);
    expect(validateLiveEtaMinutes({ reply: 'The tech is zero minutes away.', factsBlock: facts(9) }).ok).toBe(false);
  });
  test.each(['The tech is several minutes away.', 'The tech is a handful of minutes away.'])('%p — an unconvertible number word next to a time unit fails closed', (reply) => {
    expect(validateLiveEtaMinutes({ reply, factsBlock: facts(9) }).ok).toBe(false);
  });

  test('the digits ending a /track/ token are not an ETA (link stripped before draft-time parsing)', () => {
    const reply = 'Track your tech: portal.wavespestcontrol.com/track/abcdef9';
    expect(validateLiveEtaMinutes({ reply, factsBlock: 'LIVE STATUS: tech marked en route to this visit' })).toEqual({ ok: true, violations: [] });
    expect(validateLiveEtaMinutes({ reply: 'The tech is 9 minutes away: portal.wavespestcontrol.com/track/abcdef7', factsBlock: facts(9) }).ok).toBe(true);
    expect(require('../services/sms-track-links').stripTrackLinks('a b/track/x9 c')).toBe('a   c');
  });

  test('on-site grouped siblings sharing a technician + destination form ONE on_property group', () => {
    const today = require('../utils/datetime-et').etDateString();
    const mk = (id, extra = {}) => ({ id, scheduled_date: today, status: 'on_site', track_state: 'on_property', track_view_token: `tok-${id}`, technician_id: 'tech-1', service_lat: 27.4, service_lng: -82.5, ...extra });
    const customer = baseCustomer();
    const rows = [mk('a'), mk('b'), mk('c', { technician_id: 'tech-2' })];
    const groups = buildLiveEtaGroups({ upcomingServices: rows, liveEtaKeys: [null, null, null], uniqueLiveEtaKeys: [], liveEtaResultByKey: new Map(), includeLiveEta: true, customer });
    expect(groups.map((g) => g.scheduledServiceIds)).toEqual([['a', 'b'], ['c']]);
    expect(groups.every((g) => g.state === 'on_property' && g.minutes === null)).toBe(true);
    expect(groups[0].trackTokens).toEqual(['tok-a', 'tok-b']);
  });
});

// Codex round-20 P2s (PR #5334).
describe('round 20 P2s: bare-past arrival, en-route hyphen, destination identity', () => {
  test.each(['The technician arrived.', 'The tech just arrived at your home.', 'Our crew finally arrived.'])('%p is a completed-arrival claim', (t) => {
    expect(bodyClaimsCompletedArrival(t)).toBe(true);
  });
  test('a negated "hasn\'t arrived" is still a correction, not a claim', () => {
    expect(bodyClaimsCompletedArrival("The technician hasn't arrived yet.")).toBe(false);
  });
  test.each(['Your technician is en-route.', 'Your technician is en route.', 'Your technician is enroute.'])('%p is an en-route status claim', (t) => {
    expect(bodyMentionsArrival(t)).toBe(true);
  });
  test('bodyMentionsVisitStatus: broad status vocabulary, minus conditionals / corrections / windows', () => {
    const { bodyMentionsVisitStatus } = require('../services/sms-shadow-drafter');
    for (const t of ['The technician arrived.', 'Your tech is en-route.', 'The crew is outside.', 'The tech has pulled up.']) expect(bodyMentionsVisitStatus(t)).toBe(true);
    for (const t of ['Thanks, 5 stars!', "I'll text you once he's on the way.", "The tech hasn't arrived yet.", 'Your arrival window is 2 hours.']) expect(bodyMentionsVisitStatus(t)).toBe(false);
  });
  test('the snapshot carries each group destination through', () => {
    const destinations = [{ id: 'a', propertyId: 'prop-1', lat: 27.4, lng: -82.5, line1: '1 Test St', zip: '34285' }];
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: 9, scheduledServiceIds: ['a'], destinations }] }).entries[0].destinations).toEqual(destinations);
  });
  test('buildLiveEtaGroups records property id + stamped coordinates per member', () => {
    const today = require('../utils/datetime-et').etDateString();
    const row = { id: 'a', scheduled_date: today, status: 'en_route', track_state: 'en_route', track_view_token: 'tok-a', technician_id: 'tech-1', property_id: 'prop-1', service_lat: '27.4', service_lng: '-82.5', service_address_line1: '1 Test St', service_address_zip: '34285' };
    const [g] = buildLiveEtaGroups({ upcomingServices: [row], liveEtaKeys: [null], uniqueLiveEtaKeys: [], liveEtaResultByKey: new Map(), includeLiveEta: true });
    expect(g.destinations).toEqual([{ id: 'a', propertyId: 'prop-1', lat: 27.4, lng: -82.5, line1: '1 Test St', zip: '34285' }]);
  });
});

// Codex round-17 P2 (PR #5334): destination coordinates are a PAIR.
describe('liveEtaDestination — lat/lng are used only as a complete pair (round 17 P2)', () => {
  test('a visit latitude alone never mixes with the customer longitude', () => {
    expect(liveEtaDestination(baseRow({ service_lat: 27.4, service_lng: null }), baseCustomer())).toEqual({ lat: 27.41, lng: -82.51 });
    expect(liveEtaDestination(baseRow({ service_lat: null, service_lng: -82.5 }), baseCustomer())).toEqual({ lat: 27.41, lng: -82.51 });
  });
  test('a complete visit pair wins; a complete customer pair is the fallback', () => {
    expect(liveEtaDestination(baseRow(), baseCustomer())).toEqual({ lat: 27.4, lng: -82.5 });
    expect(liveEtaDestination(baseRow({ service_lat: null, service_lng: null }), baseCustomer())).toEqual({ lat: 27.41, lng: -82.51 });
  });
  test('a partial visit pair AND a partial customer pair fails closed', () => {
    expect(liveEtaDestination(baseRow({ service_lat: 27.4, service_lng: null }), baseCustomer({ longitude: null }))).toBeNull();
    expect(liveEtaDestination(baseRow({ service_lat: null, service_lng: -82.5 }), baseCustomer({ latitude: null }))).toBeNull();
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

  // Codex round-11 P2 (PR #5334): the GPS-fix expiry rides into the persisted
  // entry so send time can expire the claim with its fix.
  test('carries a finite fixExpiresAtMs into the entry, and omits it when unknown (older-shape entries unchanged)', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [
      { minutes: 12, scheduledServiceIds: ['svc-1'], fixExpiresAtMs: 1780000000000 },
      { minutes: 9, scheduledServiceIds: ['svc-2'], fixExpiresAtMs: undefined },
      { minutes: 7, scheduledServiceIds: ['svc-3'], fixExpiresAtMs: NaN },
    ] })).toEqual({ entries: [
      { minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: [], fixExpiresAtMs: 1780000000000 },
      { minutes: 9, scheduledServiceIds: ['svc-2'], trackTokens: [] },
      { minutes: 7, scheduledServiceIds: ['svc-3'], trackTokens: [] },
    ] });
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

  test('a group with no ids, or a non-numeric non-null minutes value, is dropped (a minutes-null status-only group is kept — round 16)', () => {
    expect(buildLiveEtaSnapshot({ liveEtaGroups: [{ minutes: 'soon', scheduledServiceIds: ['svc-1'] }, { minutes: 12, scheduledServiceIds: [] }, { minutes: null, scheduledServiceIds: [] }] }))
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
