/**
 * GATE_REVIEW_ASK_AFTER_REPORT on the combined-visit packet path: the ask is
 * anchored to the packet's own completion_sms effect. Only a 'sent' text
 * anchors it; a suppressed or missing one keeps the smart window (no anchor).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/review-request', () => ({
  enrollPostService: jest.fn(async () => ({ started: true })),
  completionReviewDelay: jest.fn(() => undefined),
}));
jest.mock('../services/visit-completion-summary', () => ({ resumeVisitReviewOutreach: jest.fn(async () => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ReviewService = require('../services/review-request');
const { enrollVisitCompletionReview } = require('../services/visit-completion-packets');

// A table-dispatching fake of the handful of reads the enrollment makes.
function fakeDatabase({ smsEffect, legs }) {
  const tables = {
    visit_completion_packets: { first: { id: 'pk-1', visit_id: 'v-1', status: 'done', payload: { items: [{ body: { requestReview: true } }] } } },
    service_visits: { first: { id: 'v-1', customer_id: 'c-1', technician_id: 't-1', billing_hold: false, completion_submitted_at: '2026-10-20T13:00:00.000Z' } },
    invoices: { first: null },
    customers: { first: { deleted_at: null } },
  };
  return (name) => {
    const q = {
      where(cond) { q.cond = cond; return q; },
      whereIn() { return q; },
      join() { return q; },
      orderBy() { return q; },
      update: async () => 1,
      select: async () => (name.startsWith('visit_completion_packet_items')
        ? [{ status: 'done', id: 's-1', record_id: 'r-1', structured_notes: { visitOutcome: 'completed', requestReview: true }, service_type: 'Quarterly Pest Control' }]
        : legs),
      first: async () => (name === 'visit_effects' ? smsEffect : tables[name]?.first ?? null),
    };
    return q;
  };
}

const ENV = 'GATE_REVIEW_ASK_AFTER_REPORT';
let saved;
beforeEach(() => { saved = process.env[ENV]; ReviewService.enrollPostService.mockClear(); });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

const sentLegs = [{ status: 'sent' }, { status: 'sent' }];

test('gate on, summary text sent: the enrollment carries a sent anchor at the effect send time', async () => {
  process.env[ENV] = 'true';
  const sentAt = new Date('2026-10-20T13:05:00.000Z');
  const out = await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect: { status: 'sent', sent_at: sentAt }, legs: sentLegs }));
  expect(out).toMatchObject({ enrolled: true });
  expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
  expect(ReviewService.enrollPostService.mock.calls[0][0].reportTextAnchor).toEqual({ status: 'sent', at: sentAt });
});

test.each([
  ['suppressed', { status: 'suppressed', sent_at: null }],
  ['missing', null],
  ['failed', { status: 'failed', sent_at: null }],
])('gate on, summary text %s: no anchor, so enrollment keeps the smart window', async (_label, smsEffect) => {
  process.env[ENV] = 'true';
  await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect, legs: [{ status: 'suppressed' }, { status: 'suppressed' }] }));
  expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
  expect(ReviewService.enrollPostService.mock.calls[0][0]).not.toHaveProperty('reportTextAnchor');
});

test('gate off: the enrollment arguments are exactly as before (no anchor key, no effect read)', async () => {
  delete process.env[ENV];
  const database = jest.fn(fakeDatabase({ smsEffect: { status: 'sent', sent_at: new Date() }, legs: sentLegs }));
  await enrollVisitCompletionReview('pk-1', database);
  expect(ReviewService.enrollPostService.mock.calls[0][0]).not.toHaveProperty('reportTextAnchor');
  expect(database.mock.calls.filter(([t]) => t === 'visit_effects')).toHaveLength(1); // the delivery-legs read only
});
