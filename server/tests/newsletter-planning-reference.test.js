const mockRepeatedFilter = jest.fn(async (rows) => rows);
const mockFeaturedFilter = jest.fn(async (rows) => rows);

const mockRows = [{
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Future Harbor Art Walk',
  description: 'One-time art walk.',
  admin_status: 'approved',
  start_at: '2026-09-05T22:00:00Z',
  end_at: null,
  event_url: 'https://events.example/future-art-walk',
  event_type: 'one_time',
  recurrence_type: 'none',
  freshness_status: 'fresh_one_time',
  freshness_score: 100,
  times_featured: 0,
  last_featured_at: null,
  merged_into: null,
  source_id: 'source-1',
  source_priority_tier: 1,
  pulled_at: '2026-08-30T12:00:00Z',
}];

const mockQuery = {};
[
  'leftJoin', 'select', 'whereIn', 'whereNull', 'where', 'whereNotNull',
  'whereNotIn', 'orderByRaw',
].forEach((method) => { mockQuery[method] = jest.fn(() => mockQuery); });
mockQuery.then = (resolve, reject) => Promise.resolve(mockRows).then(resolve, reject);

const mockDb = jest.fn(() => mockQuery);

jest.mock('../models/db', () => mockDb);
jest.mock('../services/newsletter-event-selection', () => ({
  filterRepeatedDateIdentities: mockRepeatedFilter,
  filterPreviouslyFeaturedIdentities: mockFeaturedFilter,
}));
jest.mock('../services/newsletter-draft', () => ({
  createNewsletterDraft: jest.fn(),
  persistNewsletterDraft: jest.fn(),
}));

const { buildDigestPlan } = require('../services/newsletter-autopilot');
const { resolveIssueReference } = jest.requireActual('../services/newsletter-draft');

describe('newsletter future-issue planning reference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRepeatedFilter.mockImplementation(async (rows) => rows);
    mockFeaturedFilter.mockImplementation(async (rows) => rows);
  });

  test('centers DB-backed identity filters on the requested future issue Tuesday', async () => {
    const plan = await buildDigestPlan({ reference: new Date('2026-08-31T12:00:00Z') }); // Monday
    expect(plan.weekOf).toBe('2026-09-01');
    expect(plan.startDate.toISOString()).toBe('2026-09-01T04:00:00.000Z');
    expect(mockRepeatedFilter).toHaveBeenCalledWith(mockRows, { reference: plan.startDate });
    expect(mockFeaturedFilter).toHaveBeenCalledWith(mockRows, { reference: plan.startDate });
  });

  test('explicit draft issueReference accepts future targets and rejects malformed values', () => {
    expect(resolveIssueReference('2026-09-01T10:00:00Z').toISOString())
      .toBe('2026-09-01T10:00:00.000Z');
    expect(() => resolveIssueReference('not-a-date')).toThrow('issueReference must be a valid date');
  });
});
