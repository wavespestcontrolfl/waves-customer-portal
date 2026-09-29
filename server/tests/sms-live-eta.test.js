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
const { resolveLiveEtaFact } = require('../services/context-aggregator');
const { buildFactsBlock, buildSystemPrompt } = require('../services/sms-shadow-drafter');
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
    expect(block).toContain('TRACKING LINK: https://portal.wavespestcontrol.com/track/abc123');
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
