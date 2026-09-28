// @vitest-environment jsdom
import { expect, it, describe } from 'vitest';
import { receiptReasonText } from './MarkPrepaidModal';

// Codex pre-push P2 (round 3): resolveScheduledServiceCharge's two
// sibling-coverage refusals (admin-schedule.js) — 'sibling_invoice_needs_review'
// and 'sibling_lookup_failed' — used to fall through to the generic
// "no receipt was sent" fallback text, leaving the operator with no idea
// whether to retry or go fix something in Customer 360. Both now get
// actionable copy naming what to do.
describe('receiptReasonText — sibling-coverage refusals', () => {
  it('sibling_invoice_needs_review tells the operator to reconcile in Customer 360', () => {
    const text = receiptReasonText({ reason: 'sibling_invoice_needs_review' });
    expect(text).toMatch(/Customer 360/);
    expect(text).toMatch(/prepayment was recorded/i);
  });

  it('sibling_lookup_failed tells the operator to retry', () => {
    const text = receiptReasonText({ reason: 'sibling_lookup_failed' });
    expect(text).toMatch(/try again/i);
    expect(text).toMatch(/prepayment was recorded/i);
  });

  // Round-8 P1 (owner decision — narrow + fail closed): a definitive
  // 'covered' sibling-coverage verdict is now ALSO a flat mint refusal.
  it('sibling_invoice_covered tells the operator to collect on the combined trip invoice instead', () => {
    const text = receiptReasonText({ reason: 'sibling_invoice_covered' });
    expect(text).toMatch(/combined trip invoice/i);
    expect(text).toMatch(/prepayment was recorded/i);
  });

  it('an unrecognized reason still falls back to the generic message (unchanged)', () => {
    expect(receiptReasonText({ reason: 'something_new' }))
      .toBe('The prepayment was recorded, but no receipt was sent.');
  });
});
