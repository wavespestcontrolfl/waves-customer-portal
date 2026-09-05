jest.mock('../models/db', () => jest.fn());
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
// Advisory-lock pass-through: the payout money boundary and manual
// attribution run under gbp-review-sync:<loc>; lock-busy behavior is
// asserted separately by overriding this mock per-test.
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, fn) => fn()),
  isLocked: jest.fn(async () => false),
  recordJobStart: jest.fn(async () => {}),
  recordJobEnd: jest.fn(async () => {}),
  // Real predicate, not a stub: the lock-busy tests below assert on it.
  wasLockSkipped: (result) => !!(result && result.skipped === true
    && ['lease_held', 'no_connection'].includes(result.reason)),
}));

const ReviewIncentives = require('../services/review-incentives');

function createDbMock(initialRows = {}) {
  const state = {
    rows: {
      review_incentive_payouts: [],
      service_records: [],
      scheduled_services: [],
      review_requests: [],
      google_reviews: [],
      customers: [],
      technicians: [],
      activity_log: [],
      ...initialRows,
    },
  };

  function tableName(input) {
    return String(input).split(/\s+as\s+/i)[0];
  }

  function valueFor(row, column) {
    const key = String(column).split('.').pop();
    return row[key];
  }

  function filteredRows(query) {
    let rows = [...(state.rows[query.table] || [])];
    rows = rows.filter((row) => query.equals.every(([key, value]) => valueFor(row, key) === value));
    rows = rows.filter((row) => query.notEquals.every(([key, value]) => valueFor(row, key) !== value));
    rows = rows.filter((row) => query.notNull.every((key) => valueFor(row, key) != null));
    rows = rows.filter((row) => query.nulls.every((key) => valueFor(row, key) == null));
    rows = rows.filter((row) => query.ins.every(([key, values]) => values.includes(valueFor(row, key))));
    rows = rows.filter((row) => (query.rawFilters || []).every((fn) => fn(row)));
    rows = rows.filter((row) => query.ops.every(([key, op, value]) => {
      const left = valueFor(row, key);
      if (left == null) return false;
      if (op === '>=') return left >= value;
      if (op === '<=') return left <= value;
      if (op === '>') return left > value;
      if (op === '<') return left < value;
      return left === value;
    }));
    if (query.rawOrder) {
      rows.sort((a, b) => query.rawOrder(a) - query.rawOrder(b) || String(a.last_name || '').localeCompare(String(b.last_name || '')));
    }
    if (query.order) {
      const [key, dir] = query.order;
      rows.sort((a, b) => {
        const av = valueFor(a, key);
        const bv = valueFor(b, key);
        if (av === bv) return 0;
        const result = av > bv ? 1 : -1;
        return dir === 'desc' ? -result : result;
      });
    }
    return query.limitValue ? rows.slice(0, query.limitValue) : rows;
  }

  function makeQuery(inputTable) {
    const query = {
      table: tableName(inputTable),
      equals: [],
      notEquals: [],
      notNull: [],
      nulls: [],
      ops: [],
      ins: [],
      rawFilters: [],
      // Raw OR clauses are pass-throughs (the mock does not model the
      // customer search's LIKE group); their SQL + bindings are captured so
      // a test can assert what the search binds.
      rawWheres: [],
      order: null,
      limitValue: null,
      where(arg, op, value) {
        if (typeof arg === 'function') {
          // knex binds the builder as `this` AND passes it — callbacks use either.
          arg.call(this, this);
          return this;
        }
        if (arg && typeof arg === 'object') {
          Object.entries(arg).forEach(([key, val]) => this.equals.push([key, val]));
          return this;
        }
        if (arguments.length === 3) {
          if (op === '!=') this.notEquals.push([arg, value]);
          else this.ops.push([arg, op, value]);
          return this;
        }
        this.equals.push([arg, op]);
        return this;
      },
      orWhere() { return this; },
      whereILike() { return this; },
      orWhereILike() { return this; },
      orWhereRaw(sql, bindings) { this.rawWheres.push([String(sql), bindings || []]); return this; },
      whereNot(column, value) { this.notEquals.push([column, value]); return this; },
      whereIn(column, values) { this.ins.push([column, values]); return this; },
      whereNotNull(column) { this.notNull.push(column); return this; },
      whereNull(column) { this.nulls.push(column); return this; },
      whereRaw(sql) {
        // Recognized raw clauses become row predicates; anything else is a
        // pass-through (matches the google-business-sync mock convention).
        if (String(sql).includes("link_source NOT IN ('manual_no_visit', 'click_auto')")) {
          this.rawFilters.push((row) => row.link_source == null || !['manual_no_visit', 'click_auto'].includes(row.link_source));
        }
        return this;
      },
      forUpdate() { return this; },
      leftJoin() { return this; },
      select() { return this; },
      orderBy(column, direction = 'asc') { this.order = [column, direction]; return this; },
      orderByRaw(sql) {
        // The attribution search's service-proximity ORDER BY becomes a row
        // sort: customers with a service_records / completed scheduled_services
        // row first, then last name (bindings ignored — window is not modelled).
        if (String(sql).includes('EXISTS (SELECT 1 FROM service_records')) {
          this.rawOrder = (row) => {
            const served = (state.rows.service_records || []).some((r) => r.customer_id === row.id && r.technician_id != null)
              || (state.rows.scheduled_services || []).some((r) => r.customer_id === row.id && r.status === 'completed' && r.technician_id != null);
            return served ? 0 : 1;
          };
        }
        return this;
      },
      limit(value) { this.limitValue = value; return this; },
      async first() { return filteredRows(this)[0] || null; },
      count() {
        return {
          first: async () => ({ count: String(filteredRows(this).length) }),
        };
      },
      insert(row) {
        if (!state.rows[this.table]) state.rows[this.table] = [];
        const inserted = { id: row.id || `${this.table}-${state.rows[this.table].length + 1}`, ...row };
        state.rows[this.table].push(inserted);
        return {
          returning: async () => [inserted],
          onConflict: () => ({ merge: async () => [inserted], ignore: async () => [inserted] }),
        };
      },
      async update(patch) {
        const rows = filteredRows(this);
        rows.forEach((row) => Object.assign(row, patch));
        return rows.length;
      },
      then(resolve, reject) {
        return Promise.resolve(filteredRows(this)).then(resolve, reject);
      },
    };
    return query;
  }

  const conn = jest.fn(makeQuery);
  conn.fn = { now: jest.fn(() => new Date('2026-06-01T12:00:00.000Z')) };
  // The payout money boundary runs its liveness check + insert in one
  // transaction (row-locked in prod); the mock passes the same conn through.
  conn.transaction = async (fn) => fn(conn);
  conn.__state = state;
  return conn;
}

describe('review incentives', () => {
  const policy = {
    enabled: true,
    amountCents: 500,
    currency: 'USD',
    eligibleSources: ['google_review'],
    minRating: 1,
    requireCustomerMatchForGoogle: true,
  };

  test('does not create payouts from rate-page review requests', async () => {
    const conn = createDbMock({
      review_requests: [{
        id: 'request-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_record_id: 'service-1',
        rating: 10,
        rated_at: '2026-05-29T14:00:00.000Z',
        status: 'reviewed',
        service_type: 'General Pest',
        service_date: '2026-05-29',
      }],
    });

    const result = await ReviewIncentives.createPayoutForReviewRequest('request-1', { conn, policy });

    expect(result).toMatchObject({
      created: false,
      skipped: true,
      reason: 'confirmed_google_review_required',
    });
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('a click-auto-linked review never mints a payout until a human confirms the match', async () => {
    const conn = createDbMock({
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-click',
        customer_id: 'customer-1',
        link_source: 'click_auto',
        reviewer_name: 'SunshineGal88',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/click',
      }],
    });

    const result = await ReviewIncentives.createPayoutForGoogleReview('google-click', { conn, policy });

    expect(result).toMatchObject({ created: false, skipped: true, reason: 'not_eligible' });
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('re-attributing a review with a POSTED automatic reply parks it review_edited_after_post inside the relink and rings the bell after commit (codex r36)', async () => {
    mockNotify.mockClear();
    const conn = createDbMock({
      customers: [
        { id: 'customer-1', first_name: 'Customer', last_name: 'One', active: true },
        { id: 'customer-2', first_name: 'Customer', last_name: 'Two', active: true },
      ],
      technicians: [{ id: 'tech-1', name: 'Tech One', active: true }],
      service_records: [],
      google_reviews: [{
        id: 'google-posted',
        customer_id: 'customer-1',
        link_source: 'click_auto',
        auto_linked_at: '2026-05-29T16:05:00.000Z',
        reviewer_name: 'Dana W.',
        star_rating: 5,
        review_text: 'Great',
        review_reply: 'Hi Dana, glad to keep looking after your Venice home.',
        auto_reply_status: 'posted',
        auto_reply_reason: null,
        publish_claimed_until: null,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/posted',
      }],
    });
    await ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-posted', customerId: 'customer-2', technicianId: null, serviceRecordId: null, noVisit: true, adminId: 'admin-1',
    }, { conn });
    const row = conn.__state.rows.google_reviews[0];
    expect(row).toMatchObject({ customer_id: 'customer-2', auto_reply_status: 'parked', auto_reply_reason: 'review_edited_after_post', review_reply: 'Hi Dana, glad to keep looking after your Venice home.' });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][3].metadata).toMatchObject({ reason: 'review_edited_after_post', cause: 'attribution', needsAction: true });
  });

  test('confirming a click_auto link against the SAME customer requeues a stored pipeline draft (grounding identity changed) — codex r58', async () => {
    mockNotify.mockClear();
    const conn = createDbMock({
      customers: [{ id: 'customer-1', first_name: 'Customer', last_name: 'One', active: true }],
      technicians: [],
      service_records: [],
      google_reviews: [{
        id: 'google-same', customer_id: 'customer-1', link_source: 'click_auto', auto_linked_at: '2026-05-29T16:05:00.000Z',
        reviewer_name: 'Dana W.', star_rating: 5, review_text: 'Great', review_reply: '[DRAFT] Hi Dana, thanks.',
        auto_reply_status: 'drafted', auto_reply_reason: 'shadow', auto_reply_draft: 'Hi Dana, thanks.', publish_claimed_until: null,
        review_created_at: '2026-05-29T16:00:00.000Z', location_id: 'sarasota', google_review_id: 'accounts/1/locations/2/reviews/same',
      }],
    });
    await ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-same', customerId: 'customer-1', technicianId: null, serviceRecordId: null, noVisit: true, adminId: 'admin-1',
    }, { conn });
    expect(conn.__state.rows.google_reviews[0]).toMatchObject({ link_source: 'manual_no_visit', auto_reply_status: 'queued', auto_reply_reason: 'review_changed', auto_reply_draft: null, review_reply: null });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('re-attribution refuses while an automatic publish holds the review (live publish claim) — hook P1', async () => {
    const conn = createDbMock({
      customers: [
        { id: 'customer-1', first_name: 'Customer', last_name: 'One', active: true },
        { id: 'customer-2', first_name: 'Customer', last_name: 'Two', active: true },
      ],
      technicians: [],
      service_records: [],
      google_reviews: [{
        id: 'google-inflight', customer_id: 'customer-1', link_source: 'click_auto', auto_linked_at: '2026-05-29T16:05:00.000Z',
        reviewer_name: 'Dana W.', star_rating: 5, review_text: 'Great', review_reply: null,
        auto_reply_status: 'queued', auto_reply_reason: null, publish_claimed_until: '2099-01-01T00:00:00.000Z',
        review_created_at: '2026-05-29T16:00:00.000Z', location_id: 'sarasota', google_review_id: 'accounts/1/locations/2/reviews/inflight',
      }],
    });
    await expect(ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-inflight', customerId: 'customer-2', technicianId: null, serviceRecordId: null, noVisit: true, adminId: 'admin-1',
    }, { conn })).rejects.toMatchObject({ code: 'reply_publish_in_flight', statusCode: 409 });
    expect(conn.__state.rows.google_reviews[0].customer_id).toBe('customer-1');
  });

  test('an explicit no-visit confirm never auto-resolves a technician or mints a payout', async () => {
    // The customer HAS a resolvable prior service — exactly the case where
    // the technician resolver would otherwise hijack a "Confirm match (no
    // visit on file)" click into a paid 'manual' link (pre-push P0).
    const conn = createDbMock({
      customers: [{
        id: 'customer-1',
        first_name: 'Customer',
        last_name: 'One',
        active: true,
      }],
      technicians: [{ id: 'tech-1', name: 'Tech One', active: true }],
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-click',
        customer_id: 'customer-1',
        link_source: 'click_auto',
        reviewer_name: 'SunshineGal88',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/click',
      }],
    });

    const result = await ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-click',
      customerId: 'customer-1',
      technicianId: null,
      serviceRecordId: null,
      noVisit: true,
      adminId: 'admin-1',
    }, { conn, policy });

    expect(result).toMatchObject({ created: false, skipped: true, reason: 'payout_policy_ineligible' });
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
    expect(conn.__state.rows.google_reviews[0]).toMatchObject({
      customer_id: 'customer-1',
      link_source: 'manual_no_visit',
    });
  });

  test('does not create duplicate payouts for the same Google review', async () => {
    const conn = createDbMock({
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
      }],
    });

    const first = await ReviewIncentives.createPayoutForGoogleReview('google-1', { conn, policy });
    const second = await ReviewIncentives.createPayoutForGoogleReview('google-1', { conn, policy });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(1);
  });

  test('does not create payouts for reviews before the program start', async () => {
    const conn = createDbMock({
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
      }],
    });

    const result = await ReviewIncentives.createPayoutForGoogleReview('google-1', {
      conn,
      policy: { ...policy, programStartsAt: '2026-06-01T00:00:00.000Z' },
    });

    expect(result).toMatchObject({
      created: false,
      skipped: true,
      reason: 'before_program_start',
    });
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('excludes historical reviews from the attribution queue after program start', async () => {
    const conn = createDbMock({
      google_reviews: [
        {
          id: 'old-google',
          customer_id: null,
          reviewer_name: 'Old Customer',
          star_rating: 5,
          review_created_at: '2026-05-29T16:00:00.000Z',
          location_id: 'sarasota',
          google_review_id: 'accounts/1/locations/2/reviews/old',
        },
        {
          id: 'new-google',
          customer_id: null,
          reviewer_name: 'New Customer',
          star_rating: 5,
          review_created_at: '2026-06-01T16:00:00.000Z',
          location_id: 'sarasota',
          google_review_id: 'accounts/1/locations/2/reviews/new',
        },
      ],
    });

    const queue = await ReviewIncentives.getAttributionQueue({
      conn,
      policy: { ...policy, programStartsAt: '2026-06-01T00:00:00.000Z' },
      days: 365,
    });

    expect(queue.count).toBe(1);
    expect(queue.items[0]).toMatchObject({
      id: 'new-google',
      reason: 'missing_customer',
    });
  });

  test('dashboard visibility counts only post-program Google reviews', async () => {
    const conn = createDbMock({
      google_reviews: [
        {
          id: 'old-google',
          customer_id: null,
          reviewer_name: 'Old Customer',
          star_rating: 5,
          review_created_at: '2026-05-29T16:00:00.000Z',
          location_id: 'sarasota',
          google_review_id: 'accounts/1/locations/2/reviews/old',
        },
        {
          id: 'new-google',
          customer_id: null,
          reviewer_name: 'New Customer',
          star_rating: 5,
          review_created_at: '2026-06-01T16:00:00.000Z',
          location_id: 'sarasota',
          google_review_id: 'accounts/1/locations/2/reviews/new',
        },
        {
          id: 'stats-row',
          customer_id: null,
          reviewer_name: '_stats',
          star_rating: 5,
          review_created_at: '2026-06-01T18:00:00.000Z',
          location_id: 'sarasota',
          google_review_id: 'stats',
        },
      ],
    });

    const dashboard = await ReviewIncentives.getDashboard({
      conn,
      policy: { ...policy, programStartsAt: '2026-06-01T00:00:00.000Z' },
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-06-02T00:00:00.000Z',
    });

    expect(dashboard.period).toMatchObject({
      effectiveStart: '2026-06-01T00:00:00.000Z',
      programStartsAt: '2026-06-01T00:00:00.000Z',
    });
    expect(dashboard.summary.confirmedGoogleReviews).toBe(1);
    expect(dashboard.summary.unattributedGoogleReviews).toBe(1);
  });

  test('attributes a matched Google review to the most recent technician service', async () => {
    const conn = createDbMock({
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-2',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
      }],
    });

    const result = await ReviewIncentives.createPayoutForGoogleReview('google-1', { conn, policy });

    expect(result.created).toBe(true);
    expect(conn.__state.rows.review_incentive_payouts[0]).toMatchObject({
      technician_id: 'tech-2',
      customer_id: 'customer-1',
      service_record_id: 'service-1',
      google_review_id: 'google-1',
      source: 'google_review',
      amount_cents: 500,
    });
  });

  test('uses Eastern business dates when attributing late-night Google reviews', async () => {
    const conn = createDbMock({
      service_records: [
        {
          id: 'sunday-service',
          customer_id: 'customer-1',
          technician_id: 'tech-sunday',
          service_date: '2026-05-31',
        },
        {
          id: 'monday-service',
          customer_id: 'customer-1',
          technician_id: 'tech-monday',
          service_date: '2026-06-01',
        },
      ],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-06-01T02:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
      }],
    });

    const result = await ReviewIncentives.createPayoutForGoogleReview('google-1', { conn, policy });

    expect(result.created).toBe(true);
    expect(conn.__state.rows.review_incentive_payouts[0]).toMatchObject({
      technician_id: 'tech-sunday',
      service_record_id: 'sunday-service',
      pay_period_start: '2026-05-25',
      pay_period_end: '2026-05-31',
    });
  });

  test('manually attributes an unmatched Google review to a customer technician visit', async () => {
    const conn = createDbMock({
      customers: [{
        id: 'customer-1',
        first_name: 'Customer',
        last_name: 'One',
        phone: '9415550101',
        address_line1: '123 Main St',
        city: 'Sarasota',
        active: true,
      }],
      technicians: [{
        id: 'tech-1',
        name: 'Tech One',
        active: true,
      }],
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
      }],
    });

    const result = await ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-1',
      customerId: 'customer-1',
      serviceRecordId: 'service-1',
      adminId: 'admin-1',
    }, { conn, policy });

    expect(result.created).toBe(true);
    expect(conn.__state.rows.google_reviews[0].customer_id).toBe('customer-1');
    expect(conn.__state.rows.review_incentive_payouts[0]).toMatchObject({
      technician_id: 'tech-1',
      customer_id: 'customer-1',
      service_record_id: 'service-1',
      google_review_id: 'google-1',
      source: 'google_review',
      amount_cents: 500,
    });
    expect(conn.__state.rows.review_incentive_payouts[0].attribution_snapshot).toContain('manual_admin_match');
    // Find by action, not index — the manual match now ALSO writes the
    // review_manual_marked row (has_left_google_review parity with the sync
    // paths) before the attribution row.
    const activityActions = conn.__state.rows.activity_log.map((r) => r.action);
    expect(activityActions).toContain('review_manual_marked');
    const attributed = conn.__state.rows.activity_log.find((r) => r.action === 'review_incentive_attributed');
    expect(attributed).toMatchObject({
      admin_user_id: 'admin-1',
      customer_id: 'customer-1',
      action: 'review_incentive_attributed',
    });
    // And the customer is marked so future review asks stop.
    expect(conn.__state.rows.customers.find((c) => c.id === 'customer-1')).toMatchObject({
      has_left_google_review: true,
    });
  });

  test('manual attribution rejects reviews before the program start', async () => {
    const conn = createDbMock({
      customers: [{
        id: 'customer-1',
        first_name: 'Customer',
        last_name: 'One',
        active: true,
      }],
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: '2026-05-27',
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
      }],
    });

    await expect(ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-1',
      customerId: 'customer-1',
      serviceRecordId: 'service-1',
      adminId: 'admin-1',
    }, {
      conn,
      policy: { ...policy, programStartsAt: '2026-06-01T00:00:00.000Z' },
    })).rejects.toMatchObject({ code: 'review_before_program_start' });

    expect(conn.__state.rows.google_reviews[0].customer_id).toBeNull();
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('never pays out a review Google has removed', async () => {
    // Rolling-window fixtures derive from the clock so the suite never rots
    // past a hardcoded date (r16 lesson).
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conn = createDbMock({
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: daysAgo(12).slice(0, 10),
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: daysAgo(10),
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
        missing_since: daysAgo(8),
      }],
    });

    const direct = await ReviewIncentives.createPayoutForGoogleReview('google-1', { conn, policy });
    expect(direct).toMatchObject({ created: false, skipped: true, reason: 'removed_from_google' });

    const sync = await ReviewIncentives.syncReviewIncentives({ conn, policy, sinceDays: 365 });
    expect(sync.scannedGoogleReviews).toBe(0);
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('a removal stamp landing after the snapshot read cannot earn money', async () => {
    // The hourly scan and direct callers pass previously loaded review
    // objects; the reconcile can stamp the row while attribution resolves.
    // insertPayout re-reads the CURRENT row immediately before money moves.
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conn = createDbMock({
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: daysAgo(12).slice(0, 10),
      }],
      // The DB row is ALREADY stamped…
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: daysAgo(10),
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
        missing_since: daysAgo(1),
      }],
    });
    // …but the caller holds a stale snapshot read before the stamp landed.
    const staleSnapshot = {
      id: 'google-1',
      customer_id: 'customer-1',
      reviewer_name: 'Customer One',
      star_rating: 5,
      review_created_at: daysAgo(10),
      location_id: 'sarasota',
      google_review_id: 'accounts/1/locations/2/reviews/abc',
      missing_since: null,
    };

    const result = await ReviewIncentives.createPayoutForGoogleReview(staleSnapshot, { conn, policy });

    expect(result).toMatchObject({ created: false, skipped: true, reason: 'removed_from_google' });
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('attribution queue and dashboard counts exclude removed reviews', async () => {
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stamped = {
      id: 'removed-google',
      customer_id: null,
      reviewer_name: 'Removed Customer',
      star_rating: 5,
      review_created_at: daysAgo(9),
      location_id: 'sarasota',
      google_review_id: 'accounts/1/locations/2/reviews/removed',
      missing_since: daysAgo(8),
    };
    const live = {
      id: 'live-google',
      customer_id: null,
      reviewer_name: 'Live Customer',
      star_rating: 5,
      review_created_at: daysAgo(10),
      location_id: 'sarasota',
      google_review_id: 'accounts/1/locations/2/reviews/live',
    };
    const conn = createDbMock({ google_reviews: [stamped, live] });

    const queue = await ReviewIncentives.getAttributionQueue({ conn, policy, days: 365 });
    expect(queue.count).toBe(1);
    expect(queue.items[0].id).toBe('live-google');

    const dashboard = await ReviewIncentives.getDashboard({
      conn,
      policy,
      periodStart: daysAgo(30),
      periodEnd: new Date().toISOString(),
    });
    expect(dashboard.summary.confirmedGoogleReviews).toBe(1);
  });

  test('candidate search: a customer with a recent service leads a name-only match without one (owner ruling 2026-09-03)', async () => {
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conn = createDbMock({
      customers: [
        { id: 'customer-blake', first_name: 'Blake', last_name: 'Northgate', active: true },
        { id: 'customer-sam', first_name: 'Sam', last_name: 'Northgate', active: true },
      ],
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-sam',
        technician_id: 'tech-1',
        service_date: daysAgo(17).slice(0, 10),
      }],
      technicians: [{ id: 'tech-1', name: 'Adam' }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'slim northgate',
        star_rating: 5,
        review_created_at: daysAgo(10),
        location_id: 'bradenton',
        google_review_id: 'accounts/1/locations/2/reviews/northgate',
      }],
    });

    const result = await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    // Blake sorts first alphabetically by first name within the surname; the
    // recent service moves Sam ahead.
    expect(result.candidates.map((c) => [c.id, c.services.length > 0])).toEqual([
      ['customer-sam', true],
      ['customer-blake', false],
    ]);
    expect(result.likelyReviewers).toEqual([]);
    // The review's currently linked click_auto customer stays pinned first even
    // when the name search returns them mid-list and the service sort would
    // demote them (pre-push P1 r2).
    conn.__state.rows.google_reviews[0].customer_id = 'customer-blake';
    conn.__state.rows.google_reviews[0].link_source = 'click_auto';
    const pinned = await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    expect(pinned.candidates.map((c) => c.id)).toEqual(['customer-blake', 'customer-sam']);
    // The service ranking happens in SQL before the page is cut: with
    // limit 1 the serviced customer still wins over the alphabetical first.
    conn.__state.rows.google_reviews[0].customer_id = null;
    conn.__state.rows.google_reviews[0].link_source = null;
    const paged = await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn, limit: 1 });
    expect(paged.candidates.map((c) => c.id)).toEqual(['customer-sam']);
  });

  // The surname clause: the folded column (lowercase, apostrophe-free,
  // de-accented via translate()) IN the normalized whole-word suffixes.
  const FOLDED_IN = /^translate\(regexp_replace\(LOWER\(last_name\), '\[''’‘ʼ\]', '', 'g'\), '[^']+', '[^']+'\) IN \(\?, \?\)$/;
  // The translate() table folds every dash form to "-" and every accented
  // Latin letter to its base, position for position (GH codex r9 P2).
  const foldTable = (sql) => { const m = sql.match(/translate\(.*?, '([^']+)', '([^']+)'\)/); return { from: [...m[1]], to: [...m[2]] }; };

  test('candidate search binds the COMPLETE surname list against the folded column — either side may carry the accents (GH codex r1 P1/P2, r8 P2)', async () => {
    const conn = createDbMock({
      customers: [{ id: 'customer-pepe', first_name: 'Pepe', last_name: 'Muñoz-Pérez', active: true }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'Pepe Muñoz-Pérez',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/pepe',
      }],
    });
    await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    const surnameClauses = () => conn.mock.results.map((r) => r.value).filter((q) => q.table === 'customers').flatMap((q) => q.rawWheres).filter(([sql]) => sql.includes(') IN ('));
    // Normalized whole-word suffixes, one equality list against the folded
    // column — never a bare final token only. No unaccent extension is
    // assumed: translate() folds the column.
    expect(surnameClauses()).toEqual([[expect.stringMatching(FOLDED_IN), ['pepe munoz-perez', 'munoz-perez']]]);
    // The reverse spelling direction — reviewer typed WITHOUT the accents the
    // record keeps — binds the identical operands (GH codex r8 P2).
    conn.mock.results.length = 0;
    conn.__state.rows.google_reviews[0].reviewer_name = 'Pepe Munoz-Perez';
    await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    expect(surnameClauses()).toEqual([[expect.stringMatching(FOLDED_IN), ['pepe munoz-perez', 'munoz-perez']]]);
    // Apostrophes in any form are dropped from the operands and from the
    // column (GH codex r4 P1, r5 P2): "Pat O’Muñoz" finds a record stored
    // "O'Muñoz", "OMunoz" or "O’Munoz".
    conn.mock.results.length = 0;
    conn.__state.rows.google_reviews[0].reviewer_name = 'Pat O’Muñoz';
    await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    expect(surnameClauses()).toEqual([[expect.stringMatching(FOLDED_IN), ['pat omunoz', 'omunoz']]]);
    // A one-token display name binds no surname clause at all.
    conn.mock.results.length = 0;
    conn.__state.rows.google_reviews[0].reviewer_name = 'SunshineGal88';
    await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    expect(surnameClauses()).toEqual([]);
  });

  test('candidate search and the linked-customer pin skip ARCHIVED customers (deleted_at set, active untouched) (GH codex r8 P2)', async () => {
    const conn = createDbMock({
      customers: [
        { id: 'customer-live', first_name: 'Sam', last_name: 'Northgate', active: true },
        { id: 'customer-archived', first_name: 'Blake', last_name: 'Northgate', active: true, deleted_at: '2026-06-01T00:00:00.000Z' },
      ],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-archived',
        link_source: 'click_auto',
        reviewer_name: 'slim northgate',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/northgate',
      }],
    });
    const result = await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    // Neither the search nor the click_auto linked-customer fallback offers
    // the archived record.
    expect(result.candidates.map((c) => c.id)).toEqual(['customer-live']);
    const customerQueries = conn.mock.results.map((r) => r.value).filter((q) => q.table === 'customers');
    expect(customerQueries.length).toBeGreaterThanOrEqual(2);
    customerQueries.forEach((q) => expect(q.nulls).toContain('deleted_at'));
  });

  test('candidate search expands surnames ONLY on the reviewer-name fallback — an explicit q keeps plain field matching (GH codex r2 P2)', async () => {
    const conn = createDbMock({
      customers: [{ id: 'customer-pepe', first_name: 'Pepe', last_name: 'Street', active: true }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'Pepe Muñoz-Pérez',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/pepe',
      }],
    });
    const surnameClauses = () => conn.mock.results.map((r) => r.value).filter((q) => q.table === 'customers').flatMap((q) => q.rawWheres)
      .filter(([sql]) => sql.includes(') IN ('));
    // "10 Main Street" is an address search: no customer surnamed "Street"
    // may be pulled in (and ranked ahead of the address hit) by a surname
    // clause derived from the search-box value.
    await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn, q: '10 Main Street' });
    expect(surnameClauses()).toEqual([]);
    // The reviewer-name fallback still binds the surname alternatives.
    conn.mock.results.length = 0;
    await ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn });
    expect(surnameClauses()).toEqual([[expect.stringMatching(FOLDED_IN), ['pepe munoz-perez', 'munoz-perez']]]);
    const table = foldTable(surnameClauses()[0][0]);
    expect(table.from.length).toBe(table.to.length);
    for (const dash of ['\u2010', '\u2011', '\u2013', '\u2014', '\u2212']) expect(table.to[table.from.indexOf(dash)]).toBe('-');
    expect(table.to[table.from.indexOf('ñ')]).toBe('n');
  });

  test('candidate search and manual attribution reject removed reviews', async () => {
    const conn = createDbMock({
      customers: [{
        id: 'customer-1',
        first_name: 'Customer',
        last_name: 'One',
        active: true,
      }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: '2026-05-29T16:00:00.000Z',
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
        missing_since: '2026-05-31T09:00:00.000Z',
      }],
    });

    await expect(ReviewIncentives.searchAttributionCandidates({ reviewId: 'google-1', conn }))
      .rejects.toMatchObject({ code: 'review_removed_from_google' });

    await expect(ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-1',
      customerId: 'customer-1',
      adminId: 'admin-1',
    }, { conn, policy })).rejects.toMatchObject({ code: 'review_removed_from_google' });

    expect(conn.__state.rows.google_reviews[0].customer_id).toBeNull();
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
  });

  test('a removal stamp landing MID-attribution aborts before any side effect', async () => {
    // The entry guard reads a live row; the reconcile stamps it while the
    // customer/technician lookups run. The customer-link write is conditional
    // on liveness — zero rows updated must abort the whole flow: no customer
    // link, no has_left_google_review mark, no thank-you, no payout.
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conn = createDbMock({
      customers: [{
        id: 'customer-1',
        first_name: 'Customer',
        last_name: 'One',
        active: true,
        has_left_google_review: false,
      }],
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: daysAgo(12).slice(0, 10),
      }],
      technicians: [{ id: 'tech-1', name: 'Tech One' }],
      google_reviews: [{
        id: 'google-1',
        customer_id: null,
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: daysAgo(10),
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
        missing_since: null,
      }],
    });
    // Simulate the reconcile landing mid-flow: the first customers lookup
    // happens AFTER the entry liveness guard — stamp the row right then.
    const baseImpl = conn.getMockImplementation();
    let stampLanded = false;
    conn.mockImplementation((table) => {
      if (String(table).startsWith('customers') && !stampLanded) {
        stampLanded = true;
        conn.__state.rows.google_reviews[0].missing_since = daysAgo(0);
      }
      return baseImpl(table);
    });

    await expect(ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-1',
      customerId: 'customer-1',
      serviceRecordId: 'service-1',
      adminId: 'admin-1',
    }, { conn, policy })).rejects.toMatchObject({ code: 'review_removed_from_google' });

    expect(stampLanded).toBe(true); // the race actually ran
    expect(conn.__state.rows.google_reviews[0].customer_id).toBeNull();
    expect(conn.__state.rows.customers[0].has_left_google_review).toBe(false);
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
    expect(conn.__state.rows.activity_log).toHaveLength(0);
  });

  test('a busy location sync defers the payout and 409s manual attribution', async () => {
    // A sync cycle mid-flight may hold an authoritative feed proving the
    // review absent before the stamp lands — money and attribution must wait.
    const { runExclusive } = require('../utils/cron-lock');
    const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conn = createDbMock({
      customers: [{
        id: 'customer-1',
        first_name: 'Customer',
        last_name: 'One',
        active: true,
        has_left_google_review: false,
      }],
      service_records: [{
        id: 'service-1',
        customer_id: 'customer-1',
        technician_id: 'tech-1',
        service_date: daysAgo(12).slice(0, 10),
      }],
      technicians: [{ id: 'tech-1', name: 'Tech One' }],
      google_reviews: [{
        id: 'google-1',
        customer_id: 'customer-1',
        reviewer_name: 'Customer One',
        star_rating: 5,
        review_created_at: daysAgo(10),
        location_id: 'sarasota',
        google_review_id: 'accounts/1/locations/2/reviews/abc',
        missing_since: null,
      }],
    });

    runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
    const payout = await ReviewIncentives.createPayoutForGoogleReview('google-1', { conn, policy });
    expect(payout).toMatchObject({ created: false, skipped: true, reason: 'sync_in_progress' });
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);

    runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
    await expect(ReviewIncentives.manualAttributeGoogleReview({
      reviewId: 'google-1',
      customerId: 'customer-1',
      serviceRecordId: 'service-1',
      adminId: 'admin-1',
    }, { conn, policy })).rejects.toMatchObject({ code: 'review_sync_in_progress' });
    expect(conn.__state.rows.customers[0].has_left_google_review).toBe(false);
    expect(conn.__state.rows.review_incentive_payouts).toHaveLength(0);
    expect(conn.__state.rows.activity_log).toHaveLength(0);
  });
});
