jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [{
    id: 'lakewood-ranch',
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
      whereRaw() { return this; },
      whereNull(column) { this._whereNull = column; return this; },
      whereNot() { return this; },
      select() { return this; },
      limit(n) { this._limit = n; return this; },
      async first() {
        const rows = state.rows[this._table] || [];
        return rows
          .filter(row => matchesWhere(row, this._where))
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

    expect(result.sources).toEqual({ 'lakewood-ranch': 'gbp' });
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
      location_id: 'lakewood-ranch',
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
      location_id: 'lakewood-ranch',
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
      location_id: 'lakewood-ranch',
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
});
