// processFollowups' low-tap branch: a customer who tapped a score under 8 and left no comment gets a person's
// call, not a review ask. Its alert was a text to the owner's phone that reached nobody since about 2026-09-01,
// while the row was still marked followed up, so it never came back. It is now a quiet owner alert
// (services/owner-alerts.js), and the row is marked only once that alert row is written.
// (Dormant today: no live route records a score, so this branch only meets rows from the retired rating flow.)
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })),
}));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { deliverOpsDigest } = require('../services/ops-digest');
const ReviewService = require('../services/review-request');

function chain(overrides = {}) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNotExists', 'whereExists', 'orderByRaw']) {
    q[m] = jest.fn(() => q);
  }
  return Object.assign(q, { limit: jest.fn(async () => []), first: jest.fn(), update: jest.fn(async () => 1) }, overrides);
}

let markQuery;
let activityInserts;
beforeEach(() => {
  jest.clearAllMocks();
  markQuery = chain();
  activityInserts = [];
  const reviewRequestQueries = [
    chain(), // deleted-customer close-out pre-pass
    chain({ limit: jest.fn(async () => [{ id: 'rr-low', customer_id: 'cust-1', score: 5, service_type: 'pest_control', category: 'passive' }]) }),
    markQuery, // the low-tap row's followed-up mark
    chain(), // the customer follow-up scan: nothing eligible
  ];
  db.mockImplementation((table) => {
    if (table === 'review_requests') return reviewRequestQueries.shift() || chain();
    if (table === 'customers') return chain({ first: jest.fn(async () => ({ id: 'cust-1', first_name: 'Jamie', last_name: 'Rivera' })) });
    if (table === 'activity_log') return { insert: async (row) => { activityInserts.push(row); } };
    throw new Error(`Unexpected table query: ${table}`);
  });
});

test('writes a quiet owner alert, then marks the row followed up, and texts nobody', async () => {
  const result = await ReviewService.processFollowups();

  expect(result.internalFollowups).toBe(1);
  expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  expect(deliverOpsDigest.mock.calls[0][0]).toMatchObject({
    headline: 'Customers — call Jamie Rivera before any review ask',
    summary: 'Tapped 5 of 10 for pest control but left no comment.',
    audience: 'fyi',
    dedupeKey: 'owner-alert:rating-no-feedback:rr-low',
    link: '/admin/customers?customerId=cust-1',
  });
  expect(markQuery.update).toHaveBeenCalledWith(expect.objectContaining({ followup_sent: true }));
  expect(activityInserts).toHaveLength(1);
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('an alert row that was not written leaves the row unmarked, so the next run retries it', async () => {
  deliverOpsDigest.mockResolvedValueOnce({ ok: false, channel: 'email', error: 'owner alerts have no email path' });

  const result = await ReviewService.processFollowups();

  expect(result.internalFollowups).toBe(0);
  expect(markQuery.update).not.toHaveBeenCalled();
  expect(activityInserts).toHaveLength(0);
});
