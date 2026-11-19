// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CommercialSetupVisitReviewDialog, {
  commercialSetupDecision,
  commercialSetupReviewFromError,
} from './CommercialSetupVisitReviewDialog';

afterEach(cleanup);

const review = { invoiceId: 'invoice/source 1', visitKey: 'opaque-visit-property-time-token', prepaidAmountCents: 5500, visitFeeCents: 7300 };

it('normalizes only the structured 409 review and binds either explicit decision to its amounts', () => {
  const error = Object.assign(new Error('review'), {
    status: 409,
    body: { code: 'COMMERCIAL_SETUP_VISIT_REVIEW', setupFeeReview: review },
  });
  expect(commercialSetupReviewFromError(error)).toEqual(review);
  expect(commercialSetupDecision(review, 'covered')).toEqual({ ...review, resolution: 'covered' });
  expect(commercialSetupDecision(review, 'separate')).toEqual({ ...review, resolution: 'separate' });
  expect(commercialSetupReviewFromError(Object.assign(error, { status: 500 }))).toBeNull();
});

it('rejects malformed cents instead of coercing null or an empty value to zero', () => {
  for (const malformed of [
    { ...review, prepaidAmountCents: null },
    { ...review, prepaidAmountCents: '' },
    { ...review, visitFeeCents: null },
    { ...review, visitFeeCents: '' },
  ]) {
    expect(commercialSetupReviewFromError({
      status: 409,
      code: 'COMMERCIAL_SETUP_VISIT_REVIEW',
      setupFeeReview: malformed,
    })).toBeNull();
  }
});

it('shows exact amounts, source invoice, both choices, and cancellation without a default', () => {
  const onResolve = vi.fn();
  const onCancel = vi.fn();
  render(<CommercialSetupVisitReviewDialog review={review} onResolve={onResolve} onCancel={onCancel} />);
  expect(screen.getByRole('dialog', { name: 'Choose how to handle this setup fee' })).toBeInTheDocument();
  expect(screen.getByText(/already carries a/)).toHaveTextContent('$55.00');
  expect(screen.getByText(/independent setup/)).toHaveTextContent('$73.00');
  expect(screen.getByRole('link', { name: 'Open source invoice' })).toHaveAttribute('href', '/admin/invoices?invoice=invoice%2Fsource%201');
  expect(onResolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: "Bill this booking's $73.00 setup separately" }));
  expect(onResolve).toHaveBeenLastCalledWith('separate');
  fireEvent.click(screen.getByRole('button', { name: 'Apply $55.00 prepayment to this booking' }));
  expect(onResolve).toHaveBeenLastCalledWith('covered');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel without saving' }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it('warns when a retry returned refreshed invoice evidence', () => {
  render(<CommercialSetupVisitReviewDialog review={review} changed onResolve={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('source invoice or setup amount changed');
});
