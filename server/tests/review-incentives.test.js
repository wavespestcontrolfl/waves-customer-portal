jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
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
    rows = rows.filter((row) => query.ops.every(([key, op, value]) => {
      const left = valueFor(row, key);
      if (left == null) return false;
      if (op === '>=') return left >= value;
      if (op === '<=') return left <= value;
      if (op === '>') return left > value;
      if (op === '<') return left < value;
      return left === value;
    }));
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
      order: null,
      limitValue: null,
      where(arg, op, value) {
        if (typeof arg === 'function') {
          arg(this);
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
      whereNot(column, value) { this.notEquals.push([column, value]); return this; },
      whereIn(column, values) { this.ins.push([column, values]); return this; },
      whereNotNull(column) { this.notNull.push(column); return this; },
      whereNull(column) { this.nulls.push(column); return this; },
      leftJoin() { return this; },
      select() { return this; },
      orderBy(column, direction = 'asc') { this.order = [column, direction]; return this; },
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
    expect(conn.__state.rows.activity_log[0]).toMatchObject({
      admin_user_id: 'admin-1',
      customer_id: 'customer-1',
      action: 'review_incentive_attributed',
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
});
