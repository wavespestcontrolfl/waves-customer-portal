// Public-safe grounding: what the reply drafter is allowed to know about a
// review's customer. The privacy boundary is what this module DOES NOT read
// (no call_log, sms_log, review_requests feedback, technician notes) — the
// db mock below throws on any table outside the allowlist to pin that.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/locations', () => ({
  WAVES_LOCATIONS: [
    { id: 'bradenton', name: 'Lakewood Ranch', area: 'Lakewood Ranch / Bradenton' },
    { id: 'sarasota', name: 'Sarasota', area: 'Sarasota' },
  ],
}));

const mockAllowedTables = new Set(['technicians', 'customers', 'scheduled_services']);
const mockState = { customers: [], scheduled_services: [], technicians: [] };

jest.mock('../models/db', () => {
  const dbFn = (table) => {
    if (!mockAllowedTables.has(table)) throw new Error(`grounding must not read ${table}`);
    const filters = [];
    const api = {
      where(obj) { filters.push((r) => Object.entries(obj).every(([k, v]) => r[k] === v)); return api; },
      async first() { return mockState[table].filter((r) => filters.every((f) => f(r)))[0] || null; },
      async select() { return mockState[table].filter((r) => filters.every((f) => f(r))); },
    };
    return api;
  };
  return dbFn;
});

const G = require('../services/review-reply/grounding');

const NOW = new Date('2026-08-27T12:00:00Z');

beforeEach(() => {
  mockState.technicians = [{ name: 'Marcus Reyes', active: true }, { name: 'Bob Ortiz', active: true }, { name: 'Al', active: true }];
  mockState.customers = [];
  mockState.scheduled_services = [];
});

describe('review-derived facts', () => {
  test('reviewer first name: real names pass, handles and initials do not', () => {
    expect(G.reviewerFirstName('Dana Whitfield')).toBe('Dana');
    expect(G.reviewerFirstName('dana w.')).toBe('Dana');
    expect(G.reviewerFirstName('A Google User')).toBeNull();
    expect(G.reviewerFirstName('J.')).toBeNull();
    expect(G.reviewerFirstName('XXBLAZE99')).toBeNull();
    expect(G.reviewerFirstName('')).toBeNull();
  });
  test('technician names only when the reviewer wrote them; 2-letter names never match', () => {
    expect(G.mentionedTechNames('Marcus was great, so was Al', ['Marcus', 'Bob', 'Al'])).toEqual(['Marcus']);
    expect(G.mentionedTechNames('marcus was great', ['Marcus'])).toEqual(['Marcus']);
    expect(G.mentionedTechNames('', ['Marcus'])).toEqual([]);
  });
  test('topics come from the reviewer text', () => {
    expect(G.detectTopics('Came out fast, the ants are gone, highly recommend')).toEqual(
      expect.arrayContaining(['responsiveness', 'results', 'recommend', 'pest']),
    );
    expect(G.detectTopics('')).toEqual([]);
  });
});

describe('account-derived facts', () => {
  test('service types map to public category labels only', () => {
    expect(G.serviceCategoriesFrom(['pest_control_quarterly', 'lawn_care', 'mosquito_monthly', 'termite_bait'])).toEqual(
      ['pest control', 'lawn care', 'mosquito control', 'termite protection'],
    );
  });
  test('tenure buckets', () => {
    expect(G.tenureBucket('2026-08-01', NOW)).toBe('new');
    expect(G.tenureBucket('2026-01-01', NOW)).toBe('established');
    expect(G.tenureBucket('2024-06-01', NOW)).toBe('long_term');
    expect(G.tenureBucket(null, NOW)).toBeNull();
  });
  test('only served cities surface', () => {
    expect(G.servedCity('sarasota')).toBe('Sarasota');
    expect(G.servedCity('Tampa')).toBeNull();
    expect(G.servedCity('')).toBeNull();
  });
});

describe('buildReplyGrounding', () => {
  const review = {
    id: 'rev-1', location_id: 'sarasota', reviewer_name: 'Dana W.', star_rating: 5,
    review_text: 'Marcus came out within 2 days and the ants are gone.', customer_id: 'cust-1',
  };

  test('linked review: derived account facts + provenance + allowlists', async () => {
    mockState.customers = [{ id: 'cust-1', city: 'Venice', member_since: '2025-01-15', created_at: '2025-01-15' }];
    mockState.scheduled_services = [
      { customer_id: 'cust-1', status: 'completed', service_type: 'pest_control' },
      { customer_id: 'cust-1', status: 'completed', service_type: 'lawn_care' },
      { customer_id: 'cust-1', status: 'cancelled', service_type: 'mosquito' },
    ];
    const g = await G.buildReplyGrounding(review);
    expect(g.review.firstName).toBe('Dana');
    expect(g.review.mentionedTechNames).toEqual(['Marcus']);
    expect(g.account).toEqual({ relationship: 'recurring', tenure: 'long_term', serviceCategories: ['pest control', 'lawn care'], city: 'Venice' });
    expect(g.provenance.relationship).toBe('account');
    expect(g.provenance.mentionedTechNames).toBe('review');
    // Verifier allowlists: reviewer + mentioned tech; every other tech forbidden.
    expect(g.allow.names).toEqual(['Dana', 'Marcus']);
    expect(g.allow.forbiddenNames).toEqual(['Bob']);
    expect(g.allow.cities).toEqual(expect.arrayContaining(['Sarasota', 'Venice', 'Florida']));
    expect(g.allow.digits).toEqual(['2']);
    // Nothing private is present anywhere in the pack.
    const json = JSON.stringify(g);
    for (const k of ['transcript', 'sms', 'call_summary', 'feedback', 'notes', 'phone', 'address', 'invoice']) {
      expect(json.toLowerCase()).not.toContain(k);
    }
  });

  test('unlinked review: review-only pack, account null', async () => {
    const g = await G.buildReplyGrounding({ ...review, customer_id: null });
    expect(g.account).toBeNull();
    expect(g.provenance.relationship).toBeUndefined();
    expect(g.review.topics).toEqual(expect.arrayContaining(['results', 'pest']));
  });

  test('a failed account read degrades to review-only instead of throwing', async () => {
    mockState.customers = null; // forces the mock to throw inside loadAccountFacts
    const g = await G.buildReplyGrounding(review);
    expect(g.account).toBeNull();
  });

  test('rating-only review', async () => {
    const g = await G.buildReplyGrounding({ ...review, review_text: null, customer_id: null });
    expect(g.review.hasText).toBe(false);
    expect(g.review.wordCount).toBe(0);
    expect(g.review.mentionedTechNames).toEqual([]);
  });
});
