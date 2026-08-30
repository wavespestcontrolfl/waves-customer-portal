/**
 * Win/loss slicing by fieldVerifyFlags and price band (estimator backlog).
 *
 * Pins: resolved-only semantics (won = accepted, lost = declined/expired,
 * resolution-date filter mirrors the client's fallback chain), dual
 * estimate_data shapes (engineRequest.profile vs engineInputs), flag
 * bucketing (presence / field / priority), price banding, and the
 * recurring-band × flag cross slice.
 */

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { winLossSlices, _private } = require('../services/estimate-winloss');

// Both reads (resolved rows, then the sent-cohort read) hit the same mock;
// pass `sentRows` to feed the cohort read something different.
function estimatesTable(rows, sentRows = []) {
  let call = 0;
  const make = (result) => {
    const builder = {
      whereIn: () => builder,
      where: () => builder,
      whereNotNull: () => builder,
      whereNull: () => builder,
      select: async () => result,
    };
    return builder;
  };
  return () => make(call++ === 0 ? rows : sentRows);
}

const NOW = Date.now();
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

function row(overrides = {}) {
  return {
    id: 'est-1',
    status: 'accepted',
    accepted_at: daysAgo(5),
    declined_at: null,
    expires_at: null,
    archived_at: null,
    created_at: daysAgo(10),
    updated_at: daysAgo(5),
    monthly_total: '79.00',
    onetime_total: null,
    estimate_data: {
      engineRequest: {
        profile: { fieldVerifyFlags: [] },
      },
    },
    ...overrides,
  };
}

const flagged = (fields, priority = 'MEDIUM') => ({
  engineRequest: {
    profile: {
      fieldVerifyFlags: fields.map((field) => ({ field, reason: 'x', priority })),
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('winLossSlices', () => {
  test('clean vs flagged presence with win rates and the band cross', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'a' }), // clean, won, $79 recurring
      row({ id: 'b', status: 'declined', accepted_at: null, declined_at: daysAgo(3), estimate_data: flagged(['pool']) }),
      row({ id: 'c', status: 'expired', accepted_at: null, expires_at: daysAgo(2), estimate_data: flagged(['pool', 'lotSize'], 'HIGH') }),
      row({ id: 'd', estimate_data: flagged(['lotSize'], 'LOW'), monthly_total: '135.00' }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.resolved).toBe(4);
    expect(result.won).toBe(2);
    expect(result.lost).toBe(2);
    expect(result.byFlagPresence.clean).toMatchObject({ won: 1, lost: 0, total: 1, winRatePct: 100 });
    expect(result.byFlagPresence.flagged).toMatchObject({ won: 1, lost: 2, total: 3 });
    // Per-field: pool 0/2, lotSize 1/2.
    const pool = result.byFlagField.find((f) => f.field === 'pool');
    const lot = result.byFlagField.find((f) => f.field === 'lotSize');
    expect(pool).toMatchObject({ won: 0, lost: 2, total: 2, winRatePct: 0 });
    expect(lot).toMatchObject({ won: 1, lost: 1, total: 2, winRatePct: 50 });
    // Priority buckets.
    expect(result.byFlagPriority.HIGH.total).toBe(2); // both flags on row c
    expect(result.byFlagPriority.LOW.total).toBe(1);
    // Band cross: $60–89 row a clean-won + row b flagged-lost; $130+ row d flagged-won.
    const band6090 = result.recurringBandsByFlag.find((b) => b.key === '60_90');
    expect(band6090.clean).toMatchObject({ won: 1, total: 1 });
    expect(band6090.flagged).toMatchObject({ lost: 2, total: 2 }); // rows b and c both sit at the default $79
    const band130 = result.recurringBandsByFlag.find((b) => b.key === '130_plus');
    expect(band130.flagged).toMatchObject({ won: 1, total: 1 });
  });

  test('flattened engineInputs shape and missing profile both classify correctly', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'a', estimate_data: { engineInputs: { fieldVerifyFlags: [{ field: 'stories', priority: 'HIGH', reason: 'x' }] } } }),
      row({ id: 'b', estimate_data: {} }), // no profile at all
      // engineInputs WITHOUT enrichment markers = manual/v1 pricing inputs,
      // no lookup provenance → noProfile, never "clean".
      row({ id: 'c', estimate_data: '{"engineInputs":{"homeSqFt":1800}}' }),
      // engineInputs WITH a surviving enrichment marker counts as a profile.
      row({ id: 'd', estimate_data: { engineInputs: { homeSqFt: 1800, fieldVerifyFlags: [] } } }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.byFlagPresence.flagged.total).toBe(1);
    expect(result.byFlagPresence.noProfile.total).toBe(2);
    expect(result.byFlagPresence.clean.total).toBe(1);
    expect(result.byFlagField).toEqual([
      expect.objectContaining({ field: 'stories', total: 1 }),
    ]);
  });

  test('quote-wizard shape: estimate_data.enriched profile is recognized (not noProfile)', async () => {
    mockDbHandler = estimatesTable([
      row({
        id: 'qw',
        estimate_data: {
          lead_id: 'lead-1',
          enriched: { fieldVerifyFlags: [{ field: 'lotSize', reason: 'x', priority: 'MEDIUM' }] },
        },
      }),
      row({
        id: 'qw-clean',
        estimate_data: { lead_id: 'lead-2', enriched: { fieldVerifyFlags: [] } },
      }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.byFlagPresence.noProfile.total).toBe(0);
    expect(result.byFlagPresence.flagged.total).toBe(1);
    expect(result.byFlagPresence.clean.total).toBe(1);
  });

  test('resolution-date window: a re-saved old resolution is excluded', async () => {
    mockDbHandler = estimatesTable([
      // Accepted 200 days ago but updated yesterday (re-save) — outside window.
      row({ id: 'old', accepted_at: daysAgo(200), updated_at: daysAgo(1) }),
      row({ id: 'fresh' }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.resolved).toBe(1);
  });

  test('one-time estimates band on onetime_total when no recurring total', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'a', monthly_total: null, onetime_total: '249.00' }),
      row({ id: 'b', monthly_total: '0', onetime_total: '750.00', status: 'declined', accepted_at: null, declined_at: daysAgo(1) }),
    ]);

    const result = await winLossSlices({ days: 90 });

    const mid = result.byPriceBand.oneTime.find((b) => b.key === '150_300');
    const high = result.byPriceBand.oneTime.find((b) => b.key === '600_plus');
    expect(mid).toMatchObject({ won: 1, total: 1 });
    expect(high).toMatchObject({ lost: 1, total: 1 });
    // Recurring bands untouched.
    expect(result.byPriceBand.recurring.every((b) => b.total === 0)).toBe(true);
  });

  test('archived rows drop symmetrically — rates come from active rows only', async () => {
    // PipelineAnalytics computes close-rate from non-archived rows because
    // archived losses are never fetched; counting archived wins here would
    // inflate every win-rate slice.
    mockDbHandler = estimatesTable([
      row({ id: 'win-archived', archived_at: daysAgo(1) }), // excluded from rates
      row({ id: 'loss-archived', status: 'declined', accepted_at: null, declined_at: daysAgo(2), archived_at: daysAgo(1) }), // excluded
      row({ id: 'loss-live', status: 'declined', accepted_at: null, declined_at: daysAgo(2) }),
      row({ id: 'win-live' }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result.resolved).toBe(2);
    expect(result.won).toBe(1);
    expect(result.lost).toBe(1);
    expect(result.winRatePct).toBe(50);
  });

  test('zero resolved rows returns null win rates, not divide-by-zero', async () => {
    mockDbHandler = estimatesTable([]);
    const result = await winLossSlices({ days: 30 });
    expect(result.resolved).toBe(0);
    expect(result.winRatePct).toBeNull();
    expect(result.byFlagPresence.clean.winRatePct).toBeNull();
  });

  test('malformed flag entries are ignored, not crashed on', async () => {
    mockDbHandler = estimatesTable([
      row({
        estimate_data: {
          engineRequest: {
            profile: { fieldVerifyFlags: [null, 'junk', { reason: 'no field' }, { field: 'pool', priority: 'HIGH' }] },
          },
        },
      }),
    ]);
    const result = await winLossSlices({ days: 90 });
    expect(result.byFlagField).toHaveLength(1);
    expect(result.byFlagField[0].field).toBe('pool');
  });
});

describe('resolutionDateMs fallback chain (mirrors client resolutionDate)', () => {
  const { resolutionDateMs } = _private;
  test('accepted prefers accepted_at, falls back to created_at', () => {
    expect(resolutionDateMs({ status: 'accepted', accepted_at: '2026-06-01T00:00:00Z' }))
      .toBe(new Date('2026-06-01T00:00:00Z').getTime());
    expect(resolutionDateMs({ status: 'accepted', created_at: '2026-05-01T00:00:00Z' }))
      .toBe(new Date('2026-05-01T00:00:00Z').getTime());
  });
  test('expired uses expires_at then updated_at then created_at', () => {
    expect(resolutionDateMs({ status: 'expired', expires_at: '2026-06-02T00:00:00Z', updated_at: '2026-06-09T00:00:00Z' }))
      .toBe(new Date('2026-06-02T00:00:00Z').getTime());
  });
  test('open statuses resolve to null', () => {
    expect(resolutionDateMs({ status: 'sent', created_at: '2026-06-01T00:00:00Z' })).toBeNull();
  });
});

// ── Estimator-audit slices (2026-08-29): dispositions, service line, lead
// source, WaveGuard tier, sent cohorts ──────────────────────────────────────
describe('winLossSlices — audit slices', () => {
  const lawnData = { result: { recurring: { tier: 'gold', services: [{ service: 'lawn', name: 'Lawn Care', mo: 48 }] } } };

  test('why-we-lose counts stamped dispositions and derives unstamped ones; dead/won-elsewhere leave the rates', async () => {
    mockDbHandler = estimatesTable([
      row({ id: 'w', lead_source: 'Google', waveguard_tier: 'silver', estimate_data: lawnData }),
      row({ id: 'x', status: 'expired', accepted_at: null, expires_at: daysAgo(2), disposition: 'expired_unviewed', lead_source: 'google', service_interest: 'Pest Control' }),
      // Unstamped expired row with an open signal → derived expired_viewed.
      row({ id: 'y', status: 'expired', accepted_at: null, expires_at: daysAgo(2), view_count: 3, lead_source: null, service_interest: 'Mosquito' }),
      // Unstamped declined row with a legacy label → derived code.
      row({ id: 'z', status: 'declined', accepted_at: null, declined_at: daysAgo(1), decline_reason: 'Too expensive', lead_source: 'referral', estimate_data: lawnData }),
      // Never winnable: counted in "why we lose", excluded from every rate.
      row({ id: 'dead', status: 'declined', accepted_at: null, declined_at: daysAgo(1), disposition: 'invalid_lead', lead_source: 'thumbtack' }),
      // Archived live row with a classification: visible in "why we lose",
      // out of the rates (archived drops stay symmetric) — codex pre-push P1.
      row({ id: 'parked', status: 'viewed', accepted_at: null, archived_at: daysAgo(4), disposition: 'archived_unresolved', disposition_at: daysAgo(4) }),
    ]);

    const result = await winLossSlices({ days: 90 });

    expect(result).toMatchObject({ resolved: 4, won: 1, lost: 3, winRatePct: 25, excludedFromRates: 1 });
    // pctOfLosses denominator = group 'lost' only (4 here); the dead lead
    // is listed for visibility with a null percentage.
    expect(result.byDisposition).toEqual([
      expect.objectContaining({ code: 'expired_unviewed', count: 1, pctOfLosses: 25, group: 'lost' }),
      expect.objectContaining({ code: 'expired_viewed', count: 1, pctOfLosses: 25 }),
      expect.objectContaining({ code: 'archived_unresolved', count: 1 }),
      expect.objectContaining({ code: 'declined_price', count: 1 }),
      expect.objectContaining({ code: 'invalid_lead', count: 1, group: 'dead', pctOfLosses: null }),
    ]);

    const lawn = result.byServiceLine.find((s) => s.key === 'lawn');
    expect(lawn).toMatchObject({ label: 'Lawn Care', won: 1, lost: 1, total: 2, winRatePct: 50 });
    expect(result.byServiceLine.find((s) => s.key === 'pest')).toMatchObject({ won: 0, lost: 1 });
    expect(result.byServiceLine.find((s) => s.key === 'mosquito')).toMatchObject({ lost: 1 });

    expect(result.byLeadSource.find((s) => s.key === 'google')).toMatchObject({ won: 1, lost: 1, total: 2 });
    expect(result.byLeadSource.find((s) => s.key === 'unknown')).toMatchObject({ lost: 1 });
    expect(result.byLeadSource.find((s) => s.key === 'thumbtack')).toBeUndefined(); // dead row left the rates

    // Column wins; falls back to the persisted recurring.tier; else "none".
    expect(result.byWaveguardTier.find((t) => t.key === 'silver')).toMatchObject({ label: 'Silver', won: 1 });
    expect(result.byWaveguardTier.find((t) => t.key === 'gold')).toMatchObject({ label: 'Gold', lost: 1 });
    expect(result.byWaveguardTier.find((t) => t.key === 'none')).toMatchObject({ label: 'No bundle', total: 2 });
  });

  test('sent cohorts: outcome as of N days after send, open offers counted, immature ages skipped', async () => {
    const sent = [
      // Sent 40d ago, accepted 3d after → won in every mature cohort (7/14/30).
      row({ id: 'w', sent_at: daysAgo(40), accepted_at: daysAgo(37), viewed_at: daysAgo(39.5), view_count: 1 }),
      // Sent 20d ago, expired at 7d → open in 7d cohort? expired_at = 13d ago = 7d after send → lost at 7d and 14d; 30d immature.
      row({ id: 'l', status: 'expired', accepted_at: null, sent_at: daysAgo(20), expires_at: daysAgo(13), view_count: 0 }),
      // Sent 3d ago, still live → too young for every cohort.
      row({ id: 'o', status: 'viewed', accepted_at: null, sent_at: daysAgo(3), viewed_at: daysAgo(2.5) }),
      // Sent 10d ago, declined 9d after → 7d cohort: open; 14d immature.
      row({ id: 'd', status: 'declined', accepted_at: null, sent_at: daysAgo(10), declined_at: daysAgo(1) }),
      // Dead lead never counts.
      row({ id: 'x', status: 'declined', accepted_at: null, sent_at: daysAgo(50), declined_at: daysAgo(49), disposition: 'invalid_lead' }),
      // Archived ACCEPTED row keeps its historical win — archiving must not
      // rewrite past cohort rates (codex pre-push P1, survivorship bias).
      row({ id: 'a', sent_at: daysAgo(50), accepted_at: daysAgo(49), archived_at: daysAgo(10) }),
      // Live sent row archived WITH a classification counts as a loss at its
      // disposition date; one archived with NO classification has no outcome
      // and is skipped.
      row({ id: 'p', status: 'sent', accepted_at: null, sent_at: daysAgo(25), archived_at: daysAgo(20), disposition: 'archived_unresolved', disposition_at: daysAgo(20) }),
      row({ id: 'q', status: 'sent', accepted_at: null, sent_at: daysAgo(25), archived_at: daysAgo(20) }),
    ];
    mockDbHandler = estimatesTable([], sent);

    const { sentCohorts } = await winLossSlices({ days: 30 });

    expect(sentCohorts.sentTotal).toBe(6);
    expect(sentCohorts.viewedTotal).toBe(2);
    expect(sentCohorts.cohorts.map((c) => c.maturityDays)).toEqual([7, 14, 30]); // ≤ window only
    const at = (m) => sentCohorts.cohorts.find((c) => c.maturityDays === m);
    // 7d cohort: w won, a won(1d), l lost, d open, p lost(5d after send)
    expect(at(7)).toMatchObject({ sent: 5, won: 2, lost: 2, open: 1, winRatePct: 40 });
    expect(at(14)).toMatchObject({ sent: 4, won: 2, lost: 2, open: 0 });
    expect(at(30)).toMatchObject({ sent: 2, won: 2, lost: 0, open: 0, winRatePct: 100 });
    expect(sentCohorts.medianHoursToFirstView).toBe(12); // 0.5d for both viewed rows
    expect(sentCohorts.medianDaysToDecision).toBe(3); // 3d (w), 9d (d), 1d (a)
  });

  test('no sent rows → empty cohorts with null rates', async () => {
    mockDbHandler = estimatesTable([], []);
    const { sentCohorts } = await winLossSlices({ days: 7 });
    expect(sentCohorts).toMatchObject({ sentTotal: 0, viewRatePct: null, medianHoursToFirstView: null });
    expect(sentCohorts.cohorts).toEqual([expect.objectContaining({ maturityDays: 7, sent: 0, winRatePct: null })]);
  });
});
