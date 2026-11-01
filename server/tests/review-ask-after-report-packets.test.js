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

// A table-dispatching fake of the handful of reads the enrollment makes. `invoice` is the visit's
// invoice (none by default); `memberNotes` is the member record's structured_notes; `updates`
// collects every write.
const MEMBER_NOTES = { visitOutcome: 'completed', requestReview: true };
function fakeDatabase({ smsEffect, legs, invoice = null, memberNotes = MEMBER_NOTES, updates = [] }) {
  const tables = {
    visit_completion_packets: { first: { id: 'pk-1', visit_id: 'v-1', status: 'done', payload: { items: [{ body: { requestReview: true } }] } } },
    service_visits: { first: { id: 'v-1', customer_id: 'c-1', technician_id: 't-1', billing_hold: false, completion_submitted_at: '2026-10-20T13:00:00.000Z' } },
    invoices: { first: invoice },
    customers: { first: { deleted_at: null } },
  };
  return (name) => {
    const q = {
      where(cond) { q.cond = cond; return q; },
      whereIn() { return q; },
      join() { return q; },
      orderBy() { return q; },
      update: async (row) => { updates.push({ table: name, row }); return 1; },
      select: async () => (name.startsWith('visit_completion_packet_items')
        ? [{ status: 'done', id: 's-1', record_id: 'r-1', structured_notes: memberNotes, service_type: 'Quarterly Pest Control' }]
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

describe('GATE_REVIEW_ASK_AT_VISIT on a combined visit (owner 2026-11-01)', () => {
  const marked = { ...MEMBER_NOTES, reviewAskAtVisit: true };
  const unpaid = { id: 'inv-1', status: 'sent' };

  test('every member completed with the switch on: the unpaid invoice does not hold the ask after the summary', async () => {
    const out = await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect: { status: 'sent' }, legs: sentLegs, invoice: unpaid, memberNotes: marked }), { deliverySettled: true });
    expect(out).toMatchObject({ enrolled: true });
    expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
  });

  test('the paid signal starts nothing for that visit and reopens no packet', async () => {
    const updates = [];
    const out = await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect: { status: 'sent' }, legs: [], invoice: { ...unpaid, status: 'paid' }, memberNotes: marked, updates }), { trigger: 'payment' });
    expect(out).toEqual({ enrolled: false, reason: 'asked_at_visit' });
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('a member completed with the switch off keeps the unpaid-invoice hold, and the payment still asks', async () => {
    const held = await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect: { status: 'sent' }, legs: sentLegs, invoice: unpaid }), { deliverySettled: true });
    expect(held).toEqual({ enrolled: false, reason: 'invoice_unpaid' });
    const paid = await enrollVisitCompletionReview('pk-1', fakeDatabase({ smsEffect: { status: 'sent' }, legs: sentLegs, invoice: { ...unpaid, status: 'paid' } }), { trigger: 'payment' });
    expect(paid).toMatchObject({ enrolled: true });
    expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
  });
});
