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
// Advisory-lock helper needs a real pg pool — model it as pass-through; the
// degraded-alert dedupe under test is the 24h notification check inside it.
jest.mock('../utils/cron-lock', () => ({ runExclusive: async (name, fn) => fn() }));

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

  // Recognized raw clauses → row predicates. Anything unrecognized keeps the
  // historical pass-through (no filter), so unrelated raw SQL stays inert.
  function rawFilterFor(sql, bindings = []) {
    if (typeof sql !== 'string') return null;
    if (sql.includes('LOWER(reviewer_name) = LOWER(?)')) {
      const name = String(bindings[0] || '').toLowerCase();
      return row => String(row.reviewer_name || '').toLowerCase() === name;
    }
    if (sql.includes('LOWER(TRIM(first_name)) = LOWER(?) OR')) {
      const first = String(bindings[0] || '').trim().toLowerCase();
      const leading = String(bindings[1] || '').trim().toLowerCase();
      return row => {
        const fn = String(row.first_name || '').trim().toLowerCase();
        return fn === first || fn === leading;
      };
    }
    // Full-name clause BEFORE the last-name clause — the full-name SQL also
    // ends with the last-name substring, so specificity order matters.
    if (sql.includes("first_name || ' ' || COALESCE(last_name")) {
      const name = String(bindings[0] || '').trim().toLowerCase();
      return row => `${row.first_name || ''} ${row.last_name || ''}`.trim().toLowerCase() === name;
    }
    if (sql.includes("COALESCE(last_name, ''))) = LOWER(?)")) {
      const last = String(bindings[0] || '').trim().toLowerCase();
      return row => String(row.last_name || '').trim().toLowerCase() === last;
    }
    // Tier-3 surname-initial expansion ("Michael F." → last_name LIKE 'f%').
    if (sql.includes("COALESCE(last_name, ''))) LIKE LOWER(?)")) {
      const prefix = String(bindings[0] || '').toLowerCase().replace(/%+$/, '');
      return row => String(row.last_name || '').trim().toLowerCase().startsWith(prefix);
    }
    if (sql.includes("TRIM(COALESCE(last_name, '')) != ''")) {
      return row => String(row.last_name || '').trim() !== '';
    }
    if (sql.includes("reviewer_name IS NULL OR reviewer_name != '_stats'")) {
      return row => row.reviewer_name == null || row.reviewer_name !== '_stats';
    }
    if (sql.includes('publish_claimed_until IS NULL OR publish_claimed_until <')) {
      const cutoff = new Date(bindings[0]);
      return row => row.publish_claimed_until == null || new Date(row.publish_claimed_until) < cutoff;
    }
    if (sql.includes('review_created_at IS NULL OR review_created_at <')) {
      const cutoff = new Date(bindings[0]);
      return row => row.review_created_at == null || new Date(row.review_created_at) < cutoff;
    }
    return null;
  }

  function makeQuery(table) {
    const query = {
      _table: table,
      _where: {},
      _whereNull: null,
      _limit: null,
      _rawFilters: [],
      where(arg, value) {
        if (typeof arg === 'function') {
          // Grouped builder — the customer name match uses
          // .where(fn){ .where(fn){ AND raw filters } .orWhereRaw(...) }.
          // Model it as: group passes when ANY of its OR branches passes,
          // where each branch is the AND of its own raw filters.
          const group = { _branches: [], _current: [] };
          const branchApi = {
            where(fn2, val2) {
              if (typeof fn2 === 'function') fn2.call(branchApi);
              else if (typeof fn2 === 'string' && arguments.length >= 2) {
                group._current.push(row => row[fn2] === val2);
              }
              return branchApi;
            },
            whereRaw(sql, bindings) {
              const f = rawFilterFor(sql, bindings);
              if (f) group._current.push(f);
              return branchApi;
            },
            orWhereRaw(sql, bindings) {
              group._branches.push(group._current);
              group._current = [];
              const f = rawFilterFor(sql, bindings);
              if (f) group._current.push(f);
              return branchApi;
            },
            orWhereNull(column) {
              group._branches.push(group._current);
              group._current = [row => row[column] == null];
              return branchApi;
            },
          };
          arg.call(branchApi);
          group._branches.push(group._current);
          this._rawFilters.push(row => group._branches.some(branch => branch.every(f => f(row))));
        } else if (arg && typeof arg === 'object') {
          Object.assign(this._where, arg);
        } else if (typeof arg === 'string' && arguments.length === 3) {
          const op = value;
          const compareValue = arguments[2];
          if (op === '!=') this._whereNot = { ...(this._whereNot || {}), [arg]: compareValue };
          else if (op === '<') this._rawFilters.push(row => row[arg] != null && new Date(row[arg]) < new Date(compareValue));
          else if (op === '>') this._rawFilters.push(row => row[arg] != null && new Date(row[arg]) > new Date(compareValue));
          else if (op === '>=') this._rawFilters.push(row => row[arg] != null && new Date(row[arg]) >= new Date(compareValue));
          else this._where[arg] = compareValue;
        } else if (typeof arg === 'string' && arguments.length >= 2) {
          this._where[arg] = value;
        }
        return this;
      },
      whereRaw(sql, bindings = []) {
        const f = rawFilterFor(sql, bindings);
        if (f) this._rawFilters.push(f);
        return this;
      },
      whereNull(column) { this._whereNull = column; return this; },
      whereNotNull(column) { this._rawFilters.push(row => row[column] != null); return this; },
      whereIn(column, values) { this._rawFilters.push(row => values.includes(row[column])); return this; },
      whereNot() { return this; },
      select() { return this; },
      orderBy() { return this; },
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
        // created_at mirrors the DB column default — the degraded-sync
        // dedupe reads it back.
        const row = { id: record.id || `${table}-${state.inserts.length + 1}`, created_at: new Date(), ...record };
        state.rows[table] = state.rows[table] || [];
        // Mirror the google_reviews.google_review_id unique constraint: a
        // plain insert of a duplicate id fails with Postgres 23505 (the
        // overlapping-runner race under test); onConflict().merge() keeps
        // its upsert semantics.
        const duplicate = table === 'google_reviews' && record.google_review_id
          && state.rows[table].some(r => r.google_review_id === record.google_review_id);
        if (!duplicate) {
          state.rows[table].push(row);
          state.inserts.push({ table, row });
        }
        return {
          returning: async () => {
            if (duplicate) {
              const err = new Error('duplicate key value violates unique constraint "google_reviews_google_review_id_unique"');
              err.code = '23505';
              throw err;
            }
            return [{ id: row.id }];
          },
          onConflict: () => ({
            merge: async (mergeRecord = {}) => {
              const existing = state.rows[table].find(r => r.google_review_id === row.google_review_id);
              if (existing && existing !== row) Object.assign(existing, mergeRecord);
              return [];
            },
          }),
        };
      },
      async update(record, returning) {
        const rows = (state.rows[this._table] || [])
          .filter(row => matchesWhere(row, this._where))
          .filter(row => this._rawFilters.every(fn => fn(row)))
          .filter(row => !this._whereNull || row[this._whereNull] == null)
          .filter(row => !this._whereNot || Object.entries(this._whereNot).every(([key, value]) => row[key] !== value));
        rows.forEach(row => {
          const rec = { ...record };
          // GREATEST(COALESCE(col, epoch), ?) — the monotonic liveness
          // write: apply the bound value only when it advances the column.
          for (const [key, val] of Object.entries(rec)) {
            if (val && typeof val === 'object' && typeof val.__raw === 'string' && val.__raw.includes('GREATEST')) {
              const bound = new Date(val.__bindings?.[0] || 0);
              const cur = row[key] ? new Date(row[key]) : new Date(0);
              rec[key] = bound > cur ? val.__bindings[0] : row[key];
            }
          }
          Object.assign(row, rec);
          state.updates.push({ table, id: row.id, record: rec });
        });
        if (returning) {
          return rows.map(row => Object.fromEntries(returning.map(col => [col, row[col]])));
        }
        return rows.length;
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
  // Real Date, not a sentinel string — the missing-review reconcile compares
  // synced_at against the sync start time.
  db.fn = { now: jest.fn(() => new Date()) };
  db.raw = (sql, bindings = []) => ({ __raw: sql, __bindings: bindings });
  // Snapshot-rollback transaction: a throw inside the callback restores all
  // table state, mirroring the claim+alert atomicity under test.
  db.transaction = async (fn) => {
    const snapshot = JSON.parse(JSON.stringify(state.rows));
    try {
      return await fn(db);
    } catch (err) {
      for (const key of Object.keys(state.rows)) delete state.rows[key];
      Object.assign(state.rows, snapshot);
      throw err;
    }
  };
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
      reviewer_name: 'Paula Placeholder',
      star_rating: 5,
      review_text: 'Edited text',
      review_created_at: '2026-04-09T20:54:35Z',
      review_reply: 'Hello Paula! Thanks!',
      reply_updated_at: '2026-04-10T00:00:00Z',
    });
    service._getClient = jest.fn(async () => null); // force Places fallback
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'Paula Placeholder',
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
      review_reply: 'Hello Paula! Thanks!', // Places carries no reply data — never downgrade
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
      reviewer_name: 'Paula Placeholder',
      star_rating: 5,
      review_text: 'Original text',
      review_created_at: '2026-04-09T20:54:35Z',
      review_reply: 'Hello Paula! Thanks!',
      reply_updated_at: '2026-04-10T00:00:00Z',
    });
    service._getClient = jest.fn(async () => null);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'Paula Placeholder',
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
      review_reply: 'Hello Paula! Thanks!',
    });
  });

  test('Places fallback still inserts a row for a genuinely new reviewer', async () => {
    db.__state.rows.google_reviews.push({
      id: 'gbp-row-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-1',
      location_id: 'bradenton',
      reviewer_name: 'Paula Placeholder',
      star_rating: 5,
      review_text: 'Original text',
      review_created_at: '2026-04-09T20:54:35Z',
      review_reply: 'Hello Paula! Thanks!',
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

  test('a middle initial in the Google display name still matches the customer (prod 2026-07-10 miss)', async () => {
    db.__state.rows.customers.push({
      id: 'cust-fossier',
      first_name: 'Michael',
      last_name: 'Fossier',
      has_left_google_review: false,
      review_marked_at: null,
      deleted_at: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-mi',
        reviewer: { displayName: 'Michael P. Fossier' },
        starRating: 'FIVE',
        comment: 'Great service!',
        createTime: '2026-07-10T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const customer = db.__state.rows.customers.find(c => c.id === 'cust-fossier');
    expect(customer.has_left_google_review).toBe(true);
    expect((db.__state.rows.notifications || []).some(n => n.category === 'review')).toBe(false);
  });

  test('a compound SURNAME still matches via the full-string arm (Codex P2: Mary Van Dyke)', async () => {
    db.__state.rows.customers.push({
      id: 'cust-vandyke',
      first_name: 'Mary',
      last_name: 'Van Dyke',
      has_left_google_review: false,
      review_marked_at: null,
      deleted_at: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-vd',
        reviewer: { displayName: 'Mary Van Dyke' },
        starRating: 'FIVE',
        comment: 'Great!',
        createTime: '2026-07-10T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const customer = db.__state.rows.customers.find(c => c.id === 'cust-vandyke');
    expect(customer.has_left_google_review).toBe(true);
  });

  test('an exact full-name row beats a looser token match instead of reading as ambiguous (Codex round-2)', async () => {
    db.__state.rows.customers.push(
      { id: 'cust-exact', first_name: 'Mary Ann', last_name: 'Smith', has_left_google_review: false, review_marked_at: null, deleted_at: null },
      // Token arm would ALSO match this row (first token "Mary", last "Smith")
      { id: 'cust-loose', first_name: 'Mary', last_name: 'Smith', has_left_google_review: false, review_marked_at: null, deleted_at: null },
    );
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-exact',
        reviewer: { displayName: 'Mary Ann Smith' },
        starRating: 'FIVE',
        comment: 'Lovely',
        createTime: '2026-07-10T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    expect(db.__state.rows.customers.find(c => c.id === 'cust-exact').has_left_google_review).toBe(true);
    expect(db.__state.rows.customers.find(c => c.id === 'cust-loose').has_left_google_review).toBe(false);
  });

  test('a two-word first name still matches its exact display-name shape', async () => {
    db.__state.rows.customers.push({
      id: 'cust-maryann',
      first_name: 'Mary Ann',
      last_name: 'Smith',
      has_left_google_review: false,
      review_marked_at: null,
      deleted_at: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-ma',
        reviewer: { displayName: 'Mary Ann Smith' },
        starRating: 'FIVE',
        comment: 'Wonderful',
        createTime: '2026-07-10T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const customer = db.__state.rows.customers.find(c => c.id === 'cust-maryann');
    expect(customer.has_left_google_review).toBe(true);
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

  // ==========================================================================
  // Missing-review watchdog (Aug 2026: the Venice profile lost ALL its
  // reviews in a Google sweep and nothing noticed — these guard the alarm).
  // ==========================================================================

  function seedSyncedReview(overrides = {}) {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row = {
      google_review_id: 'accounts/1/locations/2/reviews/rev-keep',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-keep',
      location_id: 'bradenton',
      reviewer_name: 'John Doe',
      star_rating: 5,
      review_text: 'Great work',
      review_created_at: '2026-05-25T12:00:00Z',
      review_reply: null,
      customer_id: null,
      synced_at: past,
      missing_since: null,
      ...overrides,
    };
    db.__state.rows.google_reviews.push(row);
    return row;
  }

  function gbpFeed(reviews) {
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews });
    });
  }

  test('stamps missing_since and alerts admin when a previously-synced review disappears from the GBP feed', async () => {
    seedSyncedReview({ id: 'keep-1' });
    seedSyncedReview({
      id: 'gone-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-gone',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-gone',
      reviewer_name: 'Vanished Vera',
      review_created_at: '2026-04-01T12:00:00Z',
    });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);

    await service.syncAllReviews();

    const rows = db.__state.rows.google_reviews;
    expect(rows.find(r => r.id === 'gone-1').missing_since).toBeTruthy();
    expect(rows.find(r => r.id === 'keep-1').missing_since).toBeNull();
    const alert = (db.__state.rows.notifications || []).find(n => n.title.includes('removed at'));
    expect(alert).toBeTruthy();
    expect(alert.title).toContain('1 Google review removed at Lakewood Ranch');
    expect(alert.body).toContain('Vanished Vera');
    expect(alert.link).toBe('/admin/reviews');
  });

  test('releases the missing_since claim when the removal alert fails to persist (retries next sync)', async () => {
    seedSyncedReview({
      id: 'gone-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-gone',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-gone',
      reviewer_name: 'Vanished Vera',
    });
    gbpFeed([]);
    const NotificationService = require('../services/notification-service');
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValueOnce(null);

    await service.syncAllReviews();

    // Claim released: the row is re-claimable, and no alert row exists.
    expect(db.__state.rows.google_reviews.find(r => r.id === 'gone-1').missing_since).toBeNull();
    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('removed at'))).toHaveLength(0);

    // Next hourly run: notifyAdmin works again → stamp + alert.
    db.__state.rows.google_reviews.find(r => r.id === 'gone-1').synced_at =
      new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'gone-1').missing_since).toBeTruthy();
    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('removed at'))).toHaveLength(1);
    spy.mockRestore();
  });

  test('Places fallback clears missing_since when the sample confirms the review is live again', async () => {
    // GBP credentials down, review reinstated: the Places sample is positive
    // proof of liveness — the stamp must not persist until GBP recovers.
    seedSyncedReview({
      id: 'back-via-places',
      reviewer_name: 'Paula Placeholder',
      review_text: 'Edited text',
      star_rating: 5,
      missing_since: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    service._getClient = jest.fn(async () => null);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'Paula Placeholder',
          rating: 5,
          text: 'Edited text',
          // Corroborates the seeded review_created_at (2026-05-25T12:00:00Z):
          // an unedited review's Places `time` is its creation time — the
          // identity requirement for clearing a removal stamp.
          time: Math.floor(new Date('2026-05-25T12:00:00Z').getTime() / 1000),
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 5, user_ratings_total: 30 } }) };
    });

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'back-via-places').missing_since).toBeNull();
    // The corroborated clear also rings the correction bell.
    const restored = (db.__state.rows.notifications || []).find(n => n.title.includes('restored at'));
    expect(restored).toBeTruthy();
    expect(restored.body).toContain('Paula Placeholder');
  });

  test('Places fallback does NOT revive a stamped review on an uncorroborated same-name match', async () => {
    // Same display name + same generic content from a DIFFERENT account: the
    // dedup merge may still match, but the Places `time` (a fresh creation
    // date) does not corroborate the stored review_created_at — the removal
    // stamp must survive until the authoritative GBP feed decides.
    const stamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedSyncedReview({
      id: 'stamped-ambig',
      reviewer_name: 'Paula Placeholder',
      review_text: 'Great service',
      star_rating: 5,
      review_created_at: '2025-11-01T12:00:00Z',
      missing_since: stamp,
    });
    service._getClient = jest.fn(async () => null);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'Paula Placeholder',
          rating: 5,
          text: 'Great service',
          time: Math.floor(new Date('2026-05-25T12:00:00Z').getTime() / 1000),
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 5, user_ratings_total: 30 } }) };
    });

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'stamped-ambig').missing_since).toBe(stamp);
  });

  test('never stamps a Places-sampled row without an authoritative GBP identity', async () => {
    // An edited review moves the Places timestamp; the GBP feed may carry it
    // under its resource name while the orphaned sample row goes stale —
    // that is not a removal.
    seedSyncedReview({
      id: 'places-orphan',
      google_review_id: 'places_place-1_1700000000',
      gbp_review_name: null,
      reviewer_name: 'Sample Sally',
    });
    gbpFeed([]);

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'places-orphan').missing_since).toBeNull();
    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('removed at'))).toHaveLength(0);
  });

  test('does not re-alert on later syncs for a review already stamped missing', async () => {
    seedSyncedReview({
      id: 'gone-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-gone',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-gone',
      reviewer_name: 'Vanished Vera',
      missing_since: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    gbpFeed([]);

    await service.syncAllReviews();

    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('removed at'))).toHaveLength(0);
  });

  test('clears missing_since when a removed review reappears in the feed (reinstated)', async () => {
    seedSyncedReview({
      id: 'back-1',
      missing_since: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'back-1').missing_since).toBeNull();
    // The correction bell: the admin who saw "removed" hears it came back.
    const restored = (db.__state.rows.notifications || []).find(n => n.title.includes('restored at'));
    expect(restored).toBeTruthy();
    expect(restored.title).toContain('1 Google review restored at Lakewood Ranch');
    expect(restored.body).toContain('John Doe');
    expect(restored.link).toBe('/admin/reviews');
  });

  test('no restored bell when the feed simply confirms an unstamped review', async () => {
    seedSyncedReview({ id: 'keep-1' });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);

    await service.syncAllReviews();

    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('restored at'))).toHaveLength(0);
  });

  test('a review inside the fresh-review grace window is not stamped by one absent pull', async () => {
    // Google returns brand-new reviews inconsistently while replication/spam
    // screening settles (2026-08-13: a 2.5h-old review vanished from one pull
    // and was back two hours later) — absence of a <48h-old review is not
    // removal evidence. An old review missing from the SAME pull still stamps.
    seedSyncedReview({
      id: 'fresh-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-fresh',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-fresh',
      reviewer_name: 'Newly Nadia',
      review_created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    seedSyncedReview({
      id: 'old-gone-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-old-gone',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-old-gone',
      reviewer_name: 'Vanished Vera',
      review_created_at: '2026-04-01T12:00:00Z',
    });
    gbpFeed([]);

    await service.syncAllReviews();

    const rows = db.__state.rows.google_reviews;
    expect(rows.find(r => r.id === 'fresh-1').missing_since).toBeNull();
    expect(rows.find(r => r.id === 'old-gone-1').missing_since).toBeTruthy();
    const alert = (db.__state.rows.notifications || []).find(n => n.title.includes('removed at'));
    expect(alert).toBeTruthy();
    expect(alert.body).toContain('Vanished Vera');
    expect(alert.body).not.toContain('Newly Nadia');
  });

  test('a review older than the grace window stamps normally when absent', async () => {
    seedSyncedReview({
      id: 'aged-out-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-aged',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-aged',
      reviewer_name: 'Aged Out',
      review_created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
    });
    gbpFeed([]);

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'aged-out-1').missing_since).toBeTruthy();
  });

  test('a same-name review from a different account cannot hijack a stamped evidence row', async () => {
    // Stable GBP identity differs — only the display name and a nearby
    // timestamp match. The fuzzy fallback must not resolve to the stamped
    // row: that would overwrite the retained evidence and clear its stamp.
    seedSyncedReview({
      id: 'evidence-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-removed',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-removed',
      missing_since: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-copycat',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Totally different text',
      createTime: '2026-05-25T13:00:00Z',
    }]);

    await service.syncAllReviews();

    const evidence = db.__state.rows.google_reviews.find(r => r.id === 'evidence-1');
    expect(evidence.missing_since).toBeTruthy();
    expect(evidence.review_text).toBe('Great work');
    // The copycat landed as its own distinct row instead.
    const copycat = db.__state.rows.google_reviews.find(
      r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-copycat',
    );
    expect(copycat).toBeTruthy();
  });

  test('an unexpired publish claim defers the removal stamp; an expired claim does not', async () => {
    seedSyncedReview({ id: 'keep-1' });
    // Mid-publication: claimed 10 minutes into the future.
    seedSyncedReview({
      id: 'claimed-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-claimed',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-claimed',
      reviewer_name: 'Publishing Pat',
      publish_claimed_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    // Crashed publisher: claim expired an hour ago — stampable again.
    seedSyncedReview({
      id: 'expired-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-expired',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-expired',
      reviewer_name: 'Expired Edna',
      publish_claimed_until: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'claimed-1').missing_since).toBeNull();
    expect(db.__state.rows.google_reviews.find(r => r.id === 'expired-1').missing_since).toBeTruthy();
  });

  test('a failed reconcile surfaces in errors and rings the degraded alert (no Places fallback)', async () => {
    seedSyncedReview({ id: 'keep-1' });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);
    service._reconcileMissingReviews = jest.fn(async () => ({ ok: false, error: 'boom' }));
    // A pull-failure alert from earlier in the window must NOT suppress the
    // reconcile alert — distinct failure classes carry distinct titles.
    db.__state.rows.notifications = [{
      recipient_type: 'admin',
      title: 'Google review sync degraded for Lakewood Ranch',
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    }];

    const result = await service.syncAllReviews();

    // The pull itself succeeded — no Places review-sample fallback runs.
    expect(result.sources).toEqual({ bradenton: 'gbp' });
    expect(result.errors.some(e => e.source === 'reconcile')).toBe(true);
    const degraded = (db.__state.rows.notifications || []).filter(n => n.title.includes('removal reconcile failing'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0].body).toContain('pulled the GBP feed');
    expect(degraded[0].body).toContain('REMOVALS will not be detected');
    const urls = global.fetch.mock.calls.map(c => String(c[0]));
    expect(urls.filter(u => u.includes('fields=reviews'))).toHaveLength(0);
  });

  test('an older overlapping runner cannot regress a newer synced_at token', async () => {
    // Runner B (newer fetch start) refreshed the row; runner A (older start,
    // slower feed processing) upserts the same review afterwards. A's write
    // must not move synced_at backwards — B's reconcile would then see
    // `synced_at < B.syncStart` and stamp a review both feeds returned.
    const newerToken = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    seedSyncedReview({ id: 'overlap-1', synced_at: newerToken });
    const olderStart = new Date(Date.now() - 60 * 60 * 1000);

    await service._upsertGbpReview({
      google_review_id: 'accounts/1/locations/2/reviews/rev-keep',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-keep',
      location_id: 'bradenton',
      reviewer_name: 'John Doe',
      reviewer_photo_url: null,
      star_rating: 5,
      review_text: 'Great work',
      review_created_at: '2026-05-25T12:00:00Z',
      owner_reply: null,
      owner_reply_updated_at: null,
    }, olderStart);

    const row = db.__state.rows.google_reviews.find(r => r.id === 'overlap-1');
    expect(new Date(row.synced_at).toISOString()).toBe(newerToken);
  });

  test('Places fallback: uncorroborated same-name+content match cannot mutate a stamped evidence row', async () => {
    const stamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const oldSynced = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    seedSyncedReview({
      id: 'evidence-2',
      missing_since: stamp,
      synced_at: oldSynced,
      reviewer_photo_url: null,
    });
    service._getClient = jest.fn(async () => null); // GBP down → Places fallback
    // Same display name AND identical content, but the Places `time` is an
    // hour off the stored creation instant — a copycat account, not the
    // original review. Pre-fix this merged: photo/customer overwritten and
    // synced_at refreshed on retained evidence.
    const copycatTime = Math.floor(new Date('2026-05-25T13:00:00Z').getTime() / 1000);
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [{
          author_name: 'John Doe',
          rating: 5,
          text: 'Great work',
          time: copycatTime,
          profile_photo_url: 'https://copycat.example/photo.jpg',
        }] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
    });

    await service.syncAllReviews();

    const evidence = db.__state.rows.google_reviews.find(r => r.id === 'evidence-2');
    expect(evidence.missing_since).toBe(stamp);
    expect(evidence.reviewer_photo_url).toBeNull();
    expect(evidence.synced_at).toBe(oldSynced);
    // Ambiguous identity defers entirely — no synthetic Places row either.
    expect(db.__state.rows.google_reviews.some(r => String(r.google_review_id).startsWith('places_place-1'))).toBe(false);
  });

  test('fails closed: no missing stamps on the Places fallback, and the degraded-sync alert fires once per 24h', async () => {
    seedSyncedReview({ id: 'stale-1' });
    service._getClient = jest.fn(async () => null); // token missing → Places fallback
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('fields=reviews')) {
        return { json: async () => ({ status: 'OK', result: { reviews: [] } }) };
      }
      return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
    });

    await service.syncAllReviews();
    await service.syncAllReviews(); // second hourly run inside the dedupe window

    // The stale row is NOT stamped — a 5-review sample proves nothing.
    expect(db.__state.rows.google_reviews.find(r => r.id === 'stale-1').missing_since).toBeNull();
    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('removed at'))).toHaveLength(0);
    // One degraded alert across both runs (24h title dedupe).
    const degraded = (db.__state.rows.notifications || []).filter(n => n.title.includes('sync degraded'));
    expect(degraded).toHaveLength(1);
    // The alert fires BEFORE the fallback runs, so it must describe the
    // sample as an attempt — not claim a partial feed is already active.
    expect(degraded[0].body).toContain('will attempt the ~5-review Places sample');
  });

  test('fails closed when the GBP pull itself errors (no stamps, degraded alert instead)', async () => {
    seedSyncedReview({ id: 'stale-1' });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return { ok: false, status: 500, headers: { get: () => 'text/plain' }, text: async () => 'boom' };
    });

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'stale-1').missing_since).toBeNull();
    expect((db.__state.rows.notifications || []).filter(n => n.title.includes('removed at'))).toHaveLength(0);
    expect((db.__state.rows.notifications || []).some(n => n.title.includes('sync degraded'))).toBe(true);
  });

  test('runs the GBP watchdog when GOOGLE_MAPS_API_KEY is absent (key gates only Places)', async () => {
    // GBP auth is _getClient, not the Maps key — an env drift on the key
    // alone must not stop the authoritative pull or the removal watchdog.
    delete process.env.GOOGLE_MAPS_API_KEY;
    seedSyncedReview({
      id: 'gone-1',
      google_review_id: 'accounts/1/locations/2/reviews/rev-gone',
      gbp_review_name: 'accounts/1/locations/2/reviews/rev-gone',
      reviewer_name: 'Vanished Vera',
    });
    gbpFeed([]);

    const result = await service.syncAllReviews();

    expect(result.sources).toEqual({ bradenton: 'gbp' });
    expect(db.__state.rows.google_reviews.find(r => r.id === 'gone-1').missing_since).toBeTruthy();
    expect((db.__state.rows.notifications || []).some(n => n.title.includes('removed at'))).toBe(true);
    // No Places request went out without a key.
    const urls = global.fetch.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('maps.googleapis.com'))).toBe(false);
  });

  test('still alerts degraded sync when the key is absent AND GBP is down (no Places attempt)', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    seedSyncedReview({ id: 'stale-1' });
    service._getClient = jest.fn(async () => null); // GBP credential gap
    global.fetch = jest.fn(async () => jsonResponse({}));

    const result = await service.syncAllReviews();

    expect(result.sources).toEqual({ bradenton: 'none' });
    expect(db.__state.rows.google_reviews.find(r => r.id === 'stale-1').missing_since).toBeNull();
    const degraded = (db.__state.rows.notifications || []).find(n => n.title.includes('sync degraded'));
    expect(degraded).toBeTruthy();
    // The alert must not claim a Places sample remains when the caller
    // skipped the fallback — this is a complete outage.
    expect(degraded.body).toContain('no Places fallback is available');
    expect(degraded.body).not.toContain('Places sample');
    const urls = global.fetch.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('maps.googleapis.com'))).toBe(false);
  });

  test('an older sync snapshot cannot clear a stamp written by a newer reconciliation', async () => {
    // The stamp postdates this runner's fetch start (a newer overlapping
    // runner already decided the review is gone) — the stale snapshot's
    // upsert must keep the stamp rather than reviving the review.
    const futureStamp = new Date(Date.now() + 60 * 1000).toISOString();
    seedSyncedReview({ id: 'keep-1', missing_since: futureStamp });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);

    await service.syncAllReviews();

    expect(db.__state.rows.google_reviews.find(r => r.id === 'keep-1').missing_since).toBe(futureStamp);
  });

  test('an insert race between overlapping runners does not ring the degraded alert', async () => {
    seedSyncedReview({ id: 'keep-1' });
    gbpFeed([{
      name: 'accounts/1/locations/2/reviews/rev-keep',
      reviewer: { displayName: 'John Doe' },
      starRating: 'FIVE',
      comment: 'Great work',
      createTime: '2026-05-25T12:00:00Z',
    }]);
    // The losing runner's existence check raced the winner's insert and saw
    // nothing — its upsert takes the insert path and hits the unique
    // constraint. That must recover as an update, not surface as a GBP
    // failure.
    const spy = jest.spyOn(service, '_findExistingReview').mockResolvedValueOnce(null);

    const result = await service.syncAllReviews();

    expect(result.sources).toEqual({ bradenton: 'gbp' });
    expect((db.__state.rows.notifications || []).some(n => n.title.includes('sync degraded'))).toBe(false);
    expect(db.__state.rows.google_reviews.filter(r => r.google_review_id === 'accounts/1/locations/2/reviews/rev-keep')).toHaveLength(1);
    spy.mockRestore();
  });

  test('unlinked-review notification defers to the batch collector when one is passed', async () => {
    const spy = jest.spyOn(service, '_notifyUnlinkedReview').mockResolvedValue();
    const normalized = {
      google_review_id: 'gid-defer-1',
      gbp_review_name: 'accounts/1/locations/2/reviews/gid-defer-1',
      location_id: 'bradenton',
      reviewer_name: 'SunshineGal88',
      reviewer_photo_url: null,
      star_rating: 5,
      review_text: 'Great service',
      review_created_at: '2026-05-25T12:00:00Z',
      owner_reply: null,
      owner_reply_updated_at: null,
    };

    // With a collector: pushed, NOT notified inline (batch defers to end of run).
    const pending = [];
    const result = await service._upsertGbpReview(normalized, null, pending);
    expect(result.inserted).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(pending[0].google_review_id).toBe('gid-defer-1');

    // Without a collector (direct callers): inline notify still fires.
    await service._upsertGbpReview({
      ...normalized,
      google_review_id: 'gid-defer-2',
      gbp_review_name: 'accounts/1/locations/2/reviews/gid-defer-2',
      reviewer_name: 'OtherHandle77',
      review_created_at: '2026-05-26T12:00:00Z',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('a surname-initial display name ("Michael F.") matches the one recently-asked customer with that initial', async () => {
    db.__state.rows.customers.push({
      id: 'cust-mf',
      first_name: 'Michael',
      last_name: 'Fossier',
      has_left_google_review: false,
      review_marked_at: null,
    });
    // Corroboration: the initial expansion only links a customer we recently
    // asked for a review.
    db.__state.rows.review_requests = [{
      id: 'ask-1', customer_id: 'cust-mf', created_at: new Date().toISOString(),
    }];
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-initial',
        reviewer: { displayName: 'Michael F.' },
        starRating: 'FIVE',
        comment: 'Great service',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-initial');
    expect(review.customer_id).toBe('cust-mf');
    expect(db.__state.rows.customers[0].has_left_google_review).toBe(true);
  });

  test('a surname-initial match with NO recent review ask stays unlinked (weak identity — manual queue)', async () => {
    db.__state.rows.customers.push({
      id: 'cust-mf',
      first_name: 'Michael',
      last_name: 'Fossier',
      has_left_google_review: false,
      review_marked_at: null,
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-initial-noask',
        reviewer: { displayName: 'Michael F.' },
        starRating: 'FIVE',
        comment: 'Great service',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-initial-noask');
    expect(review.customer_id).toBeNull();
    expect(db.__state.rows.customers[0].has_left_google_review).toBe(false);
  });

  test('a surname initial matching TWO customers stays unlinked (ambiguous — manual queue)', async () => {
    db.__state.rows.customers.push(
      { id: 'cust-mf', first_name: 'Michael', last_name: 'Fossier', has_left_google_review: false, review_marked_at: null },
      { id: 'cust-mfar', first_name: 'Michael', last_name: 'Farley', has_left_google_review: false, review_marked_at: null },
    );
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
      }
      return jsonResponse({ reviews: [{
        name: 'accounts/1/locations/2/reviews/rev-initial-2',
        reviewer: { displayName: 'Michael F.' },
        starRating: 'FIVE',
        comment: 'Great service',
        createTime: '2026-05-25T12:00:00Z',
      }] });
    });

    await service.syncAllReviews();

    const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-initial-2');
    expect(review.customer_id).toBeNull();
    expect(db.__state.rows.customers.every(c => !c.has_left_google_review)).toBe(true);
    const alert = (db.__state.rows.notifications || []).find(n => n.category === 'review');
    expect(alert?.title).toContain('Michael F.');
  });

  describe('click auto-link (GATE_REVIEW_CLICK_AUTOLINK)', () => {
    const CONFIDENT_MATCH = {
      customerId: 'cust-clicker',
      clickedAt: '2026-05-25T11:58:00.000Z',
      clickOffsetMs: 2 * 60000,
      clickOffsetLabel: '2m before',
    };

    function feedWithUnmatchedReview() {
      global.fetch = jest.fn(async (url) => {
        if (String(url).includes('maps.googleapis.com')) {
          return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
        }
        return jsonResponse({ reviews: [{
          name: 'accounts/1/locations/2/reviews/rev-click',
          reviewer: { displayName: 'SunshineGal88' },
          starRating: 'FIVE',
          comment: 'Loved it',
          createTime: '2026-05-25T12:00:00Z',
        }] });
      });
    }

    afterEach(() => {
      delete process.env.GATE_REVIEW_CLICK_AUTOLINK;
    });

    test('gate ON + confident sole-click match → review links, flag flips, FYI bell replaces the match-this bell', async () => {
      process.env.GATE_REVIEW_CLICK_AUTOLINK = 'true';
      jest.doMock('../services/review-click-correlation', () => ({
        findConfidentClickMatch: jest.fn(async () => CONFIDENT_MATCH),
        findLikelyReviewers: jest.fn(async () => []),
      }));
      db.__state.rows.customers.push({
        id: 'cust-clicker', first_name: 'Jane', last_name: 'Doe',
        has_left_google_review: false, review_marked_at: null,
      });
      feedWithUnmatchedReview();

      await service.syncAllReviews();

      const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-click');
      expect(review.customer_id).toBe('cust-clicker');
      expect(review.link_source).toBe('click_auto');
      expect(db.__state.rows.customers[0].has_left_google_review).toBe(true);
      const notifs = (db.__state.rows.notifications || []).filter(n => n.category === 'review');
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toContain('Auto-linked');
      expect(notifs[0].body).toContain('2m before');
    });

    test('gate OFF: even a confident match stays a manual-queue notification, no link', async () => {
      const findConfidentClickMatch = jest.fn(async () => CONFIDENT_MATCH);
      jest.doMock('../services/review-click-correlation', () => ({
        findConfidentClickMatch,
        findLikelyReviewers: jest.fn(async () => []),
      }));
      feedWithUnmatchedReview();

      await service.syncAllReviews();

      const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-click');
      expect(review.customer_id).toBeNull();
      expect(review.link_source).toBeUndefined();
      expect(findConfidentClickMatch).not.toHaveBeenCalled();
      const notifs = (db.__state.rows.notifications || []).filter(n => n.category === 'review');
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toContain('Unlinked');
    });

    test('gate ON but no confident match → normal unlinked notification', async () => {
      process.env.GATE_REVIEW_CLICK_AUTOLINK = 'true';
      jest.doMock('../services/review-click-correlation', () => ({
        findConfidentClickMatch: jest.fn(async () => null),
        findLikelyReviewers: jest.fn(async () => []),
      }));
      feedWithUnmatchedReview();

      await service.syncAllReviews();

      const review = db.__state.rows.google_reviews.find(r => r.gbp_review_name === 'accounts/1/locations/2/reviews/rev-click');
      expect(review.customer_id).toBeNull();
      const notifs = (db.__state.rows.notifications || []).filter(n => n.category === 'review');
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toContain('Unlinked');
    });

    test('retro sweep links a review parked unlinked on an EARLIER sync', async () => {
      process.env.GATE_REVIEW_CLICK_AUTOLINK = 'true';
      jest.doMock('../services/review-click-correlation', () => ({
        findConfidentClickMatch: jest.fn(async () => CONFIDENT_MATCH),
        findLikelyReviewers: jest.fn(async () => []),
      }));
      db.__state.rows.customers.push({
        id: 'cust-clicker', first_name: 'Jane', last_name: 'Doe',
        has_left_google_review: false, review_marked_at: null,
      });
      // Parked on a previous run: already synced + unlinked, so this run's
      // upsert is NOT an insert and never reaches the collector — only the
      // end-of-run retro sweep can link it.
      db.__state.rows.google_reviews.push({
        id: 'parked-1',
        google_review_id: 'accounts/1/locations/2/reviews/gid-parked-1',
        gbp_review_name: 'accounts/1/locations/2/reviews/gid-parked-1',
        location_id: 'bradenton',
        reviewer_name: 'MysteryHandle',
        star_rating: 5,
        review_text: 'Nice',
        review_created_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        customer_id: null,
        missing_since: null,
        review_reply: null,
      });
      global.fetch = jest.fn(async (url) => {
        if (String(url).includes('maps.googleapis.com')) {
          return { json: async () => ({ status: 'OK', result: { rating: 4.9, user_ratings_total: 20 } }) };
        }
        return jsonResponse({ reviews: [{
          name: 'accounts/1/locations/2/reviews/gid-parked-1',
          reviewer: { displayName: 'MysteryHandle' },
          starRating: 'FIVE',
          comment: 'Nice',
          createTime: db.__state.rows.google_reviews[0].review_created_at,
        }] });
      });

      await service.syncAllReviews();

      const review = db.__state.rows.google_reviews.find(r => r.google_review_id === 'accounts/1/locations/2/reviews/gid-parked-1');
      expect(review.customer_id).toBe('cust-clicker');
      expect(review.link_source).toBe('click_auto');
      expect(db.__state.rows.customers[0].has_left_google_review).toBe(true);
    });
  });
});
