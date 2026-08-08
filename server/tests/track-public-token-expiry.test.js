jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(),
}));
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
const mockGetViewUrl = jest.fn();
jest.mock('../services/photos', () => ({
  getViewUrl: mockGetViewUrl,
}));

const { ensureCustomerGeocoded } = require('../services/geocoder');
const trackPublicRouter = require('../routes/track-public');

function makeQuery({ firstResult = null, selectResult = [] } = {}) {
  const chain = {
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn(async () => firstResult),
    select: jest.fn(async () => selectResult),
  };
  return chain;
}

// 64-char lowercase-hex tokens — the only format /go tracks, and so the only
// format buildSummary may surface (codex #3286 P2: fixtures must satisfy the
// production predicates, not bypass them).
const LIVE_TOKEN = 'ab'.repeat(32);
const STALE_TOKEN = 'cd'.repeat(32);
const LEGACY_32_TOKEN = 'ef'.repeat(16);
const liveAsk = (over = {}) => ({
  customer_id: 'customer-1',
  token: LIVE_TOKEN,
  expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  created_at: new Date(Date.now() - 86400000).toISOString(),
  ...over,
});

// Predicate-EVALUATING fake for review_requests: buildSummary's token lookup
// filters by customer, token format (regex '~'), and expiry (whereNull OR
// '>' now, grouped). A mock that ignores predicates would stay green if a
// production filter were deleted (codex #3286 P2), so this one applies them.
function makeReviewRequestsQuery(rows) {
  let filtered = [...rows];
  const test = (row, col, op, val) => {
    if (op === '~') return new RegExp(val).test(String(row[col] ?? ''));
    if (op === '>') return row[col] != null && new Date(row[col]) > new Date(val);
    if (op === '<') return row[col] != null && new Date(row[col]) < new Date(val);
    return row[col] === val;
  };
  const chain = {
    whereNull: jest.fn((col) => {
      filtered = filtered.filter((r) => r[col] == null);
      return chain;
    }),
    whereNotIn: jest.fn((col, vals) => {
      filtered = filtered.filter((r) => !vals.includes(r[col]));
      return chain;
    }),
    where: jest.fn((a, b, c) => {
      if (typeof a === 'function') {
        // Grouped OR: whereNull(col) / orWhere(col, op, val)
        const arms = [];
        const builder = {
          whereNull: (col) => { arms.push((r) => r[col] == null); return builder; },
          orWhere: (col, op, val) => { arms.push((r) => test(r, col, op, val)); return builder; },
        };
        a(builder);
        filtered = filtered.filter((r) => arms.some((arm) => arm(r)));
      } else if (typeof a === 'object' && a !== null) {
        filtered = filtered.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
      } else {
        filtered = filtered.filter((r) => test(r, a, b, c));
      }
      return chain;
    }),
    orderBy: jest.fn((col, dir) => {
      filtered.sort((x, y) => (dir === 'desc'
        ? new Date(y[col] || 0) - new Date(x[col] || 0)
        : new Date(x[col] || 0) - new Date(y[col] || 0)));
      return chain;
    }),
    first: jest.fn(async () => filtered[0] || null),
  };
  return chain;
}

function installSummaryDb({
  record = null, photos = [], reviewRequests = [], invoice = null, customer = null,
} = {}) {
  mockDb.mockImplementation((table) => {
    if (table === 'invoices') {
      return makeQuery({ firstResult: invoice });
    }
    if (table === 'service_records') {
      return makeQuery({ firstResult: record });
    }
    if (table === 'service_photos') {
      return makeQuery({ selectResult: photos });
    }
    if (table === 'customers') {
      return makeQuery({ firstResult: customer });
    }
    if (table === 'review_requests') {
      return makeReviewRequestsQuery(reviewRequests);
    }
    return makeQuery();
  });
}

describe('public track token expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
    mockDb.mockReset();
    mockGetViewUrl.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('keeps missing and future expirations live', () => {
    expect(trackPublicRouter._test.isTrackTokenLive(null)).toBe(true);
    expect(trackPublicRouter._test.isTrackTokenLive('2026-05-05T12:00:00.000Z')).toBe(true);
    expect(trackPublicRouter._test.isTrackTokenLive('2026-05-05T12:01:00.000Z')).toBe(true);
  });

  test('fails closed for expired or malformed expirations', () => {
    expect(trackPublicRouter._test.isTrackTokenLive('2026-05-05T11:59:59.999Z')).toBe(false);
    expect(trackPublicRouter._test.isTrackTokenLive('not-a-date')).toBe(false);
  });

  test('only exposes fresh vehicle timestamps', () => {
    expect(trackPublicRouter._test.isFreshVehicleTimestamp('2026-05-05T11:55:00.000Z')).toBe(true);
    expect(trackPublicRouter._test.isFreshVehicleTimestamp('2026-05-05T11:54:59.999Z')).toBe(false);
    expect(trackPublicRouter._test.isFreshVehicleTimestamp(null)).toBe(false);
    expect(trackPublicRouter._test.isFreshVehicleTimestamp('not-a-date')).toBe(false);
  });

  test('geocodes en-route destination coordinates when customer record is missing them', async () => {
    ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4208, lng: -82.4929 });

    const row = await trackPublicRouter._test.ensureEnRouteDestinationGeocoded({
      track_state: 'en_route',
      customer_id: 'cust-1',
      latitude: null,
      longitude: null,
    });

    expect(ensureCustomerGeocoded).toHaveBeenCalledWith('cust-1');
    expect(row.latitude).toBe(27.4208);
    expect(row.longitude).toBe(-82.4929);
  });

  test('does not geocode non-en-route tracking states', async () => {
    const row = await trackPublicRouter._test.ensureEnRouteDestinationGeocoded({
      track_state: 'scheduled',
      customer_id: 'cust-1',
      latitude: null,
      longitude: null,
    });

    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  test('does not geocode the primary address when the stamped address diverges', async () => {
    // Stamped secondary/rental booking with no property geocode: the tracker
    // must show no pin rather than map/ETA the customer's primary home.
    const row = await trackPublicRouter._test.ensureEnRouteDestinationGeocoded({
      track_state: 'en_route',
      customer_id: 'cust-1',
      stamped_address_diverges: true,
      latitude: null,
      longitude: null,
    });

    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  test('still geocodes for a stamped booking AT the primary address', async () => {
    // Every phone booking stamps — a stamp matching the primary must keep
    // the geocode fallback or ordinary bookings lose their pin/ETA.
    ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4208, lng: -82.4929 });

    const row = await trackPublicRouter._test.ensureEnRouteDestinationGeocoded({
      track_state: 'en_route',
      customer_id: 'cust-1',
      stamped_address_diverges: false,
      latitude: null,
      longitude: null,
    });

    expect(ensureCustomerGeocoded).toHaveBeenCalledWith('cust-1');
    expect(row.latitude).toBe(27.4208);
  });

  test('hides report token and photos when frozen delivery suppresses customer artifacts', async () => {
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'disabled' }),
      },
      photos: [{ s3_key: 'service-photos/record-1/internal.jpg' }],
      reviewRequests: [liveAsk()],
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.serviceReportToken).toBeNull();
    expect(summary.photos).toEqual([]);
    expect(summary.reviewUrl).toBeNull();
    expect(mockDb.mock.calls.map(([table]) => table)).not.toContain('service_photos');
    expect(mockDb.mock.calls.map(([table]) => table)).not.toContain('review_requests');
    expect(mockGetViewUrl).not.toHaveBeenCalled();
  });

  test('presigns completion photos and review CTA when the frozen delivery is customer-visible', async () => {
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      photos: [
        { s3_key: 'service-photos/record-1/after-1.jpg' },
        { s3_key: null },
        { s3_key: 'service-photos/record-1/after-2.jpg' },
      ],
      reviewRequests: [
        // Newest ask is live 64-hex; an older stale ask and a legacy 32-char
        // row must both lose to it through the real predicates.
        liveAsk(),
        liveAsk({ token: STALE_TOKEN, expires_at: new Date(Date.now() - 86400000).toISOString(), created_at: new Date(Date.now() - 20 * 86400000).toISOString() }),
        liveAsk({ token: LEGACY_32_TOKEN, created_at: new Date(Date.now() - 30 * 86400000).toISOString() }),
      ],
    });
    mockGetViewUrl
      .mockResolvedValueOnce('https://signed.example/after-1.jpg')
      .mockResolvedValueOnce('https://signed.example/after-2.jpg');

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.serviceReportToken).toBe('report-token');
    expect(summary.photos).toEqual([
      'https://signed.example/after-1.jpg',
      'https://signed.example/after-2.jpg',
    ]);
    // The tracked /go redirect, NOT the raw /rate page: the track link rides
    // along in nearly every visit SMS, so this was the most-seen review CTA and
    // the only one whose clicks were unattributable.
    expect(summary.reviewUrl).toBe(`/api/rate/${LIVE_TOKEN}/go`);
    expect(mockDb.mock.calls.map(([table]) => table)).toContain('service_photos');
    expect(mockDb.mock.calls.map(([table]) => table)).toContain('review_requests');
    expect(mockGetViewUrl).toHaveBeenCalledTimes(2);
  });

  test('hides the review CTA from a customer already marked as having reviewed', async () => {
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      customer: { has_left_google_review: true },
      reviewRequests: [liveAsk()],
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.reviewUrl).toBeNull();
    // ...and it never even looks for a token.
    expect(mockDb.mock.calls.map(([table]) => table)).not.toContain('review_requests');
  });

  test('hides the review CTA when the customer has no live token left', async () => {
    // Tokens expire after 14 days; the expiry predicate filters the row out,
    // so the lookup comes back empty rather than handing over a dead link
    // that used to render "link expired". The fixture is a REAL expired row —
    // the predicate does the excluding, not the mock (codex #3286 P2).
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      customer: { has_left_google_review: false },
      reviewRequests: [
        liveAsk({ expires_at: new Date(Date.now() - 86400000).toISOString() }),
      ],
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.reviewUrl).toBeNull();
  });

  test('a token /go cannot track never surfaces — legacy 32-char rows are filtered', async () => {
    // /go only tracks 64-char lowercase-hex tokens; anything else 302s to the
    // raw rate page, which is exactly the unattributable surface this CTA is
    // leaving. A customer whose only live row is legacy gets no CTA.
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      customer: { has_left_google_review: false },
      reviewRequests: [liveAsk({ token: LEGACY_32_TOKEN })],
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.reviewUrl).toBeNull();
  });

  test('a finalized ask never surfaces — no re-soliciting after feedback', async () => {
    // A passive/detractor who already submitted through the rate page is NOT
    // marked has_left_google_review, and /go checks only format + expiry — so
    // an unfiltered lookup would send them to Google instead of the
    // thank-you state (codex #3286 r2). Same finality predicate as
    // submitRating: rated_at, or a submitted/reviewed/rated status.
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      customer: { has_left_google_review: false },
      reviewRequests: [
        liveAsk({ rated_at: new Date(Date.now() - 3600000).toISOString() }),
        liveAsk({ token: STALE_TOKEN, status: 'submitted', created_at: new Date(Date.now() - 2 * 86400000).toISOString() }),
      ],
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.reviewUrl).toBeNull();
  });

  test('a null expires_at counts as live (whereNull arm of the expiry group)', async () => {
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      customer: { has_left_google_review: false },
      reviewRequests: [liveAsk({ expires_at: null })],
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.reviewUrl).toBe(`/api/rate/${LIVE_TOKEN}/go`);
  });

  // Backdated quiet closeout (PR #2897 fix round 9, Codex P1): the review
  // invoice is minted as an UNREVIEWED draft at face value — deposits/
  // prepaid/credit deliberately unapplied — so an old /track/:token must not
  // hand the customer its /pay/:token until the office has sent it.
  const backfillRecord = {
    id: 'record-bf',
    report_view_token: 'report-token',
    structured_notes: JSON.stringify({ backfill: true, typedReportDelivery: 'auto_send' }),
  };

  test('suppresses the pay link for a backfilled visit while the review invoice is an unsent draft', async () => {
    installSummaryDb({
      record: backfillRecord,
      invoice: { token: 'inv-token', payer_id: null, status: 'draft' },
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-bf',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.invoiceToken).toBeNull();
    // The rest of the completed summary is untouched — only the pay surface
    // waits for review.
    expect(summary.serviceReportToken).toBe('report-token');
  });

  test('a queued or mid-send backfill invoice stays suppressed; a SENT one resumes the normal pay surface', async () => {
    for (const status of ['scheduled', 'sending']) {
      installSummaryDb({
        record: backfillRecord,
        invoice: { token: 'inv-token', payer_id: null, status },
      });
      const summary = await trackPublicRouter._test.buildSummary({
        id: 'scheduled-bf', customer_id: 'customer-1', completed_at: '2026-05-05T12:00:00.000Z',
      });
      expect(summary.invoiceToken).toBeNull();
    }
    // Reviewer finalized a send (draft/scheduled/sending → sent, then
    // viewed/overdue as the customer interacts, or a payment path takes it
    // further) — the tracking page shows the pay link again.
    for (const status of ['sent', 'viewed', 'overdue', 'paid']) {
      installSummaryDb({
        record: backfillRecord,
        invoice: { token: 'inv-token', payer_id: null, status },
      });
      const summary = await trackPublicRouter._test.buildSummary({
        id: 'scheduled-bf', customer_id: 'customer-1', completed_at: '2026-05-05T12:00:00.000Z',
      });
      expect(summary.invoiceToken).toBe('inv-token');
    }
  });

  test('non-backfill completions still expose their fresh draft invoice (live pay-link flow unchanged)', async () => {
    installSummaryDb({
      record: {
        id: 'record-live',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      invoice: { token: 'inv-token', payer_id: null, status: 'draft' },
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-live',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.invoiceToken).toBe('inv-token');
  });

  test('the payer-billed guard still wins for backfills — a payer invoice never surfaces regardless of status', async () => {
    installSummaryDb({
      record: backfillRecord,
      invoice: { token: 'inv-token', payer_id: 'payer-1', status: 'sent' },
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-bf', customer_id: 'customer-1', completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.invoiceToken).toBeNull();
  });
});
