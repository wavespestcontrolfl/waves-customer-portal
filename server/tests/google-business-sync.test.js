jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [{
    id: 'bradenton',
    name: 'Lakewood Ranch',
    googleLocationResourceName: 'accounts/1/locations/2',
    googlePlaceId: 'place-1',
  }],
}));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-flagship' }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));

function createDbMock(initialRows = {}) {
  const state = {
    rows: {
      google_reviews: [],
      customers: [],
      ...initialRows,
    },
    inserts: [],
    updates: [],
  };

  function matchesWhere(row, whereObj = {}) {
    return Object.entries(whereObj).every(([key, value]) => row[key] === value);
  }

  function makeQuery(table) {
    const query = {
      _table: table,
      _where: {},
      _whereNull: null,
      _limit: null,
      _rawFilters: [],
      where(arg, value) {
        if (arg && typeof arg === 'object') {
          Object.assign(this._where, arg);
        } else if (typeof arg === 'string' && arguments.length === 3) {
          const op = value;
          const compareValue = arguments[2];
          if (op === '!=') this._whereNot = { ...(this._whereNot || {}), [arg]: compareValue };
          else this._where[arg] = compareValue;
        } else if (typeof arg === 'string' && arguments.length >= 2) {
          this._where[arg] = value;
        }
        return this;
      },
      whereRaw(sql, bindings = []) {
        // Implemented for the two name-match clauses the service relies on;
        // other raw clauses keep the historical pass-through behavior.
        if (typeof sql === 'string' && sql.includes('LOWER(reviewer_name) = LOWER(?)')) {
          const name = String(bindings[0] || '').toLowerCase();
          this._rawFilters.push(row => String(row.reviewer_name || '').toLowerCase() === name);
        } else if (typeof sql === 'string' && sql.includes("first_name || ' ' || COALESCE(last_name")) {
          const name = String(bindings[0] || '').trim().toLowerCase();
          this._rawFilters.push(row => `${row.first_name || ''} ${row.last_name || ''}`.trim().toLowerCase() === name);
        }
        return this;
      },
      whereNull(column) { this._whereNull = column; return this; },
      whereNotNull(column) { this._rawFilters.push(row => row[column] != null); return this; },
      whereNot() { return this; },
      select() { return this; },
      limit(n) { this._limit = n; return this; },
      async first() {
        const rows = state.rows[this._table] || [];
        return rows
          .filter(row => matchesWhere(row, this._where))
          .filter(row => this._rawFilters.every(fn => fn(row)))
          .filter(row => !this._whereNull || row[this._whereNull] == null)
          .find(row => !this._whereNot || Object.entries(this._whereNot).every(([key, value]) => row[key] !== value)) || null;
      },
      insert(record) {
        const row = { id: record.id || `${table}-${state.inserts.length + 1}`, ...record };
        state.rows[table] = state.rows[table] || [];
        state.rows[table].push(row);
        state.inserts.push({ table, row });
        return {
          returning: async () => [{ id: row.id }],
          onConflict: () => ({
            merge: async (mergeRecord = {}) => {
              const existing = state.rows[table].find(r => r.google_review_id === row.google_review_id);
              if (existing && existing !== row) Object.assign(existing, mergeRecord);
              return [];
            },
          }),
        };
      },
      async update(record) {
        const rows = state.rows[this._table] || [];
        rows.filter(row => matchesWhere(row, this._where)).forEach(row => {
          Object.assign(row, record);
          state.updates.push({ table, id: row.id, record });
        });
        return 1;
      },
      then(resolve, reject) {
        const rows = (state.rows[this._table] || [])
          .filter(row => matchesWhere(row, this._where))
          .filter(row => this._rawFilters.every(fn => fn(row)))
          .filter(row => !this._whereNot || Object.entries(this._whereNot).every(([key, value]) => row[key] !== value))
          .filter(row => !this._whereNull || row[this._whereNull] == null);
        return Promise.resolve(this._limit ? rows.slice(0, this._limit) : rows).then(resolve, reject);
      },
    };
    return query;
  }

  const db = jest.fn(makeQuery);
  db.fn = { now: jest.fn(() => 'NOW') };
  db.__state = state;
  return db;
}

function jsonResponse(body) {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('Google Business review sync', () => {
  let db;
  let service;

  beforeEach(() => {
    jest.resetModules();
    process.env.GOOGLE_MAPS_API_KEY = 'maps-key';
    db = createDbMock();
    jest.doMock('../models/db', () => db);
    service = require('../services/google-business');
    service._clients = {};
    service._getClient = jest.fn(async () => ({}));
    service._getHeaders = jest.fn(async () => ({ Authorization: 'Bearer test' }));
  });

  afterEach(() => {
    delete global.fetch;
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  test('paginates GBP reviews and upserts each page by GBP resource name', async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      if (String(url).includes('pageToken=next-page')) {
        return jsonResponse({ reviews: [{
          name: 'accounts/1/locations/2/reviews/rev-2',
          reviewer: { displayName: 'Jane Roe' },
          starRating: 'FOUR',
          comment: 'Good visit',
          createTime: '2026-05-24T12:00:00Z',
        }] });
      }
      return jsonResponse({
        reviews: [{
          name: 'accounts/1/locations/2/reviews/rev-1',
          reviewer: { displayName: 'John Doe' },
          starRating: 'FIVE',
          comment: 'Great work',
          createTime: '2026-05-25T12:00:00Z',
        }],
        nextPageToken: 'next-page',
      });
    });

    const result = await service.syncAllReviews();

    expect(result.sources).toEqual({ 'bradenton': 'gbp' });
    expect(result.synced).toBe(2);
    expect(db.__state.rows.google_reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ gbp_review_name: 'accounts/1/locations/2/reviews/rev-1', reviewer_name: 'John Doe', star_rating: 5 }),
      expect.objectContaining({ gbp_review_name: 'accounts/1/locations/2/reviews/rev-2', reviewer_name: 'Jane Roe', star_rating: 4 }),
    ]));
  });

  test('upgrades a legacy Places row to the GBP review resource identity', async () => {
    db.__state.rows.google_reviews.push({
      id: 'legacy-1',
      google_review_id: 'places_place-1_1779710400',
      location_id: 'bradenton',
      reviewer_name: 'John Doe',
      star_rating: 5,
      review_text: 'Old sample',
      review_created_at: '2026-05-25T12:00:00Z',
      gbp_review_name: null,
      review_reply: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-1',
        reviewer: { displayName: 'John Doe' },
        starRating: 'FIVE',
        comment: 'Updated text',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews).toHaveLength(2); // stats row + upgraded legacy row
    expect(db.__state.rows.google_reviews.find(r => r.id === 'legacy-1')).toMatchObject({
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      review_text: 'Updated text',
    });
  });

  test('clears a stale local reply when Google no longer has a reply', async () => {
    db.__state.rows.google_reviews.push({
      id: 'review-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      location_id: 'bradenton',
      reviewer_name: 'John Doe',
      star_rating: 5,
      review_text: 'Great',
      review_created_at: '2026-05-25T12:00:00Z',
      review_reply: 'Old public reply',
      reply_updated_at: '2026-05-25T13:00:00Z',
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-1',
        reviewer: { displayName: 'John Doe' },
        starRating: 'FIVE',
        comment: 'Great',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'review-1')).toMatchObject({
      review_reply: null,
      reply_updated_at: null,
    });
  });

  test('preserves a local draft reply during GBP sync', async () => {
    db.__state.rows.google_reviews.push({
      id: 'review-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      location_id: 'bradenton',
      reviewer_name: 'John Doe',
      star_rating: 2,
      review_text: 'Bad',
      review_created_at: '2026-05-25T12:00:00Z',
      review_reply: '[DRAFT] We are sorry.',
      reply_updated_at: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-1',
        reviewer: { displayName: 'John Doe' },
        starRating: 'TWO',
        comment: 'Bad',
        reviewReply: { comment: 'Public Google reply', updateTime: '2026-05-25T13:00:00Z' },
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'review-1').review_reply).toBe('[DRAFT] We are sorry.');
  });

  test('Places fallback dedupes an edited review against the GBP row once content converges (no duplicate)', async () => {
    // The synthetic places_* id embeds the Places `time` field, which moves
    // on edit — when the GBP-linked row already carries the edited content
    // (the GBP feed updated it), the sample must match it, not re-insert.
    db.__state.rows.google_reviews.push({
      id: 'gbp-row-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      location_id: 'bradenton',
      reviewer_name: 'Jackie Lopez',
      star_rating: 5,
      review_text: 'Edited text',
      review_created_at: '2026-04-09T20:54:35Z',
      review_reply: 'Hello Jackie! Thanks!',
      reply_updated_at: '2026-04-10T00:00:00Z',
    });
    service._getClient = jest.fn(async () => null); // force Places fallback
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'Jackie Lopez',
          rating: 5,
          text: 'Edited text',
          time: 1779307832, // edit moved the timestamp → brand-new places_* id
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 5, user_ratings_total: 30 } }) };
    });

    await service.syncAllReviews();

    const reviewRows = db.__state.rows.google_reviews.filter(r => r.reviewer_name !== '_stats');
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0]).toMatchObject({
      id: 'gbp-row-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      review_text: 'Edited text',
      review_reply: 'Hello Jackie! Thanks!', // Places carries no reply data — never downgrade
    });
  });

  test('Places fallback skips a same-name review with different content (no overwrite, no insert)', async () => {
    // Ambiguous: a different account sharing the display name, or an edit
    // the GBP feed has not caught up with — either way, defer to GBP.
    db.__state.rows.google_reviews.push({
      id: 'gbp-row-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      location_id: 'bradenton',
      reviewer_name: 'Jackie Lopez',
      star_rating: 5,
      review_text: 'Original text',
      review_created_at: '2026-04-09T20:54:35Z',
      review_reply: 'Hello Jackie! Thanks!',
      reply_updated_at: '2026-04-10T00:00:00Z',
    });
    service._getClient = jest.fn(async () => null);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'Jackie Lopez',
          rating: 1,
          text: 'Completely different text',
          time: 1779307832,
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 5, user_ratings_total: 30 } }) };
    });

    await service.syncAllReviews();

    const reviewRows = db.__state.rows.google_reviews.filter(r => r.reviewer_name !== '_stats');
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0]).toMatchObject({
      id: 'gbp-row-1',
      star_rating: 5,
      review_text: 'Original text', // untouched
      review_reply: 'Hello Jackie! Thanks!',
    });
  });

  test('Places fallback still inserts a row for a genuinely new reviewer', async () => {
    db.__state.rows.google_reviews.push({
      id: 'gbp-row-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      location_id: 'bradenton',
      reviewer_name: 'Jackie Lopez',
      star_rating: 5,
      review_text: 'Original text',
      review_created_at: '2026-04-09T20:54:35Z',
      review_reply: 'Hello Jackie! Thanks!',
      reply_updated_at: '2026-04-10T00:00:00Z',
    });
    service._getClient = jest.fn(async () => null);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'New Person',
          rating: 4,
          text: 'First visit',
          time: 1779307900,
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 5, user_ratings_total: 31 } }) };
    });

    await service.syncAllReviews();

    const reviewRows = db.__state.rows.google_reviews.filter(r => r.reviewer_name !== '_stats');
    expect(reviewRows).toHaveLength(2);
    expect(reviewRows.find(r => r.reviewer_name === 'New Person')).toMatchObject({
      google_review_id: 'places_place-1_1779307900',
      star_rating: 4,
    });
  });

  test('Places fallback never name-merges into an un-linked Places row (same display name = new row)', async () => {
    // Display names are not unique across Google accounts. A row without a
    // GBP linkage has no authoritative feed to self-heal from, so a same-name
    // reviewer must insert a distinct row rather than overwrite it.
    db.__state.rows.google_reviews.push({
      id: 'places-row-1',
      google_review_id: 'places_place-1_1700000000',
      gbp_review_name: null,
      location_id: 'bradenton',
      reviewer_name: 'John Smith',
      star_rating: 5,
      review_text: 'First John Smith',
      review_created_at: '2026-01-01T00:00:00Z',
      review_reply: null,
    });
    service._getClient = jest.fn(async () => null);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'John Smith',
          rating: 1,
          text: 'A different John Smith',
          time: 1779308000,
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 4.8, user_ratings_total: 32 } }) };
    });

    await service.syncAllReviews();

    const reviewRows = db.__state.rows.google_reviews.filter(r => r.reviewer_name !== '_stats');
    expect(reviewRows).toHaveLength(2);
    expect(reviewRows.find(r => r.id === 'places-row-1').review_text).toBe('First John Smith');
    expect(reviewRows.find(r => r.google_review_id === 'places_place-1_1779308000')).toMatchObject({
      star_rating: 1,
      review_text: 'A different John Smith',
    });
  });

  test('auto-flips has_left_google_review when a synced review matches a customer', async () => {
    db.__state.rows.customers.push({
      id: 'cust-1',
      first_name: 'John',
      last_name: 'Doe',
      has_left_google_review: false,
      review_marked_at: null,
      deleted_at: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-1',
        reviewer: { displayName: 'John Doe' },
        starRating: 'FIVE',
        comment: 'Great work',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const customer = db.__state.rows.customers.find(c => c.id === 'cust-1');
    expect(customer.has_left_google_review).toBe(true);
    expect(customer.review_marked_at).toBeTruthy();
    // No admin "unlinked" notification when the review matched a customer.
    expect((db.__state.rows.notifications || []).some(n => n.category === 'review')).toBe(false);
  });

  test('notifies admin when a newly synced review cannot be matched to a customer', async () => {
    // No customers seeded → the reviewer name resolves to no customer.
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-9',
        reviewer: { displayName: 'Stranger Smith' },
        starRating: 'FIVE',
        comment: 'Loved it',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const notifs = db.__state.rows.notifications || [];
    const alert = notifs.find(n => n.recipient_type === 'admin' && n.category === 'review');
    expect(alert).toBeTruthy();
    expect(alert.title).toContain('Stranger Smith');
    expect(alert.link).toBe('/admin/reviews');
  });

  test('does not re-notify for an already-synced unmatched review', async () => {
    db.__state.rows.google_reviews.push({
      id: 'review-existing',
      google_review_id: 'accounts/1/locations/2/reviews/rev-9',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-9',
      location_id: 'bradenton',
      reviewer_name: 'Stranger Smith',
      star_rating: 5,
      review_text: 'Loved it',
      review_created_at: '2026-05-25T12:00:00Z',
      customer_id: null,
      review_reply: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-9',
        reviewer: { displayName: 'Stranger Smith' },
        starRating: 'FIVE',
        comment: 'Loved it',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    expect((db.__state.rows.notifications || []).filter(n => n.category === 'review')).toHaveLength(0);
  });

  test('alerts admin when a review name matches only a soft-deleted customer', async () => {
    db.__state.rows.customers.push({
      id: 'cust-deleted',
      first_name: 'John',
      last_name: 'Doe',
      has_left_google_review: false,
      review_marked_at: null,
      deleted_at: '2026-05-01T00:00:00Z', // soft-deleted → not a real link
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-1',
        reviewer: { displayName: 'John Doe' },
        starRating: 'FIVE',
        comment: 'Great work',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    // The deleted record is never auto-flagged...
    expect(db.__state.rows.customers.find(c => c.id === 'cust-deleted').has_left_google_review).toBe(false);
    // ...and the review still surfaces for manual matching.
    const alert = (db.__state.rows.notifications || []).find(n => n.category === 'review');
    expect(alert).toBeTruthy();
    expect(alert.title).toContain('John Doe');
  });

  test('does not auto-mark when a reviewer name matches multiple active customers', async () => {
    // Display names are not unique. Two active "John Doe" customers → we can't
    // tell which one left the review, so neither is auto-flagged (auto-marking
    // an arbitrary one would suppress outreach for someone who never reviewed)
    // and the review is routed to the manual-match alert instead.
    db.__state.rows.customers.push(
      { id: 'cust-a', first_name: 'John', last_name: 'Doe', has_left_google_review: false, review_marked_at: null, deleted_at: null },
      { id: 'cust-b', first_name: 'John', last_name: 'Doe', has_left_google_review: false, review_marked_at: null, deleted_at: null },
    );
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-1',
        reviewer: { displayName: 'John Doe' },
        starRating: 'FIVE',
        comment: 'Great work',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    // Neither ambiguous customer is flipped...
    expect(db.__state.rows.customers.every(c => c.has_left_google_review === false)).toBe(true);
    // ...the review is left unlinked...
    const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-1');
    expect(review.customer_id).toBeNull();
    // ...and the office is alerted to match it manually.
    const alert = (db.__state.rows.notifications || []).find(n => n.category === 'review');
    expect(alert).toBeTruthy();
    expect(alert.title).toContain('John Doe');
  });
});
