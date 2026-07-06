/**
 * /api/reviews/featured — public curated Google-review pool (estimate glass
 * proof ticker + review marquee + hub site all read this).
 *
 * Contract under test: the Places aggregate pseudo-rows the stats sync
 * upserts into google_reviews (reviewer_name='_stats', review_text =
 * '{"rating":5,"totalReviews":102}') must NEVER be served as reviews. They
 * carry star_rating=5, non-null review_text, and a fresh review_created_at,
 * so without the explicit exclusion they pass every other filter and sort
 * to the TOP of the pool — raw JSON rendered as the first customer review.
 */

// Chainable fake knex builder: records every filter call, is thenable, and
// clone() copies the recorded chain (matching knex clone semantics, so a
// filter applied before clone() is asserted on both location branches).
function mockMakeBuilder(rows, calls) {
  const builder = {
    calls,
    where(...args) { calls.push(['where', ...args]); return builder; },
    whereNot(...args) { calls.push(['whereNot', ...args]); return builder; },
    whereNotNull(...args) { calls.push(['whereNotNull', ...args]); return builder; },
    whereRaw(...args) { calls.push(['whereRaw', ...args]); return builder; },
    orderBy(...args) { calls.push(['orderBy', ...args]); return builder; },
    limit(...args) { calls.push(['limit', ...args]); return builder; },
    clone() { return mockMakeBuilder(rows, calls); },
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
  };
  return builder;
}

let mockDbRows = [];
let mockDbCalls = [];
jest.mock('../models/db', () => {
  const fn = jest.fn(() => mockMakeBuilder(mockDbRows, mockDbCalls));
  return fn;
});

const express = require('express');

let server;
let base;

beforeAll(async () => {
  const a = express();
  a.use('/api/reviews', require('../routes/reviews-public'));
  server = a.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mockDbRows = [
    {
      reviewer_name: 'Jane Example',
      star_rating: 5,
      review_text: 'Adam was fantastic, on time and thorough.',
      review_created_at: '2026-07-01T12:00:00Z',
      location_id: 'bradenton',
    },
  ];
  mockDbCalls = [];
});

describe('GET /api/reviews/featured', () => {
  test('base query excludes the _stats aggregate pseudo-rows', async () => {
    const res = await fetch(`${base}/api/reviews/featured?limit=8`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].reviewerName).toBe('Jane E.');

    const statsExclusions = mockDbCalls.filter(
      ([method, arg]) => method === 'whereRaw' && String(arg).includes("'_stats'"),
    );
    expect(statsExclusions.length).toBeGreaterThanOrEqual(1);
  });

  test('location-prioritized branch inherits the _stats exclusion (applied before clone)', async () => {
    const res = await fetch(`${base}/api/reviews/featured?location=bradenton&limit=8`);
    expect(res.status).toBe(200);

    const exclusionIdx = mockDbCalls.findIndex(
      ([method, arg]) => method === 'whereRaw' && String(arg).includes("'_stats'"),
    );
    const firstLocationIdx = mockDbCalls.findIndex(
      ([method, col]) => method === 'where' && col === 'location_id',
    );
    expect(exclusionIdx).toBeGreaterThanOrEqual(0);
    expect(firstLocationIdx).toBeGreaterThan(exclusionIdx);
  });
});
