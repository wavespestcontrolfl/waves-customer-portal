/**
 * GATE_REVIEW_ASK_AFTER_REPORT on the combined-visit packet path: the enrollment
 * passes the anchor review-request reads from the packet's own completion_sms
 * effect (reportTextAnchorForVisit, covered in review-ask-after-report.test.js).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/review-request', () => ({
  enrollPostService: jest.fn(async () => ({ started: true })),
  completionReviewDelay: jest.fn(() => undefined),
  reportTextAnchorForVisit: jest.fn(async () => null),
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

beforeEach(() => { ReviewService.enrollPostService.mockClear(); ReviewService.reportTextAnchorForVisit.mockClear(); });

const sentLegs = [{ status: 'sent' }, { status: 'sent' }];

test('the enrollment carries the visit anchor, read with the same database handle', async () => {
  const anchor = { status: 'sent', at: new Date('2026-10-20T13:05:00.000Z') };
  ReviewService.reportTextAnchorForVisit.mockResolvedValueOnce(anchor);
  const database = fakeDatabase({ smsEffect: { status: 'sent' }, legs: sentLegs });
  const out = await enrollVisitCompletionReview('pk-1', database);
  expect(out).toMatchObject({ enrolled: true });
  expect(ReviewService.reportTextAnchorForVisit).toHaveBeenCalledWith('v-1', database);
  expect(ReviewService.enrollPostService.mock.calls[0][0].reportTextAnchor).toEqual(anchor);
});

test('no anchor (gate off, or no sent summary text): enrollment keeps the smart window', async () => {
  await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect: null, legs: sentLegs }));
  expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
  expect(ReviewService.enrollPostService.mock.calls[0][0].reportTextAnchor).toBeNull();
});
