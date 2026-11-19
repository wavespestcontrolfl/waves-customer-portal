// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CommercialSetupVisitReviewDialog, {
  commercialSetupDecision,
  commercialSetupPayloadUnchanged,
  commercialSetupPropertySnapshot,
  commercialSetupReviewFromError,
} from './CommercialSetupVisitReviewDialog';

afterEach(cleanup);

const review = { invoiceId: 'invoice/source 1', visitKey: 'opaque-visit-property-time-token', prepaidAmountCents: 5500, visitFeeCents: 7300 };
const booking = {
  serviceNames: ['Commercial Rodent Bait Stations'],
  cadence: 'Quarterly',
  scheduledDate: '2035-01-02',
  windowStart: '09:00',
  windowEnd: '10:00',
  propertyLabel: 'Warehouse',
  propertyAddress: '200 Commerce Way, Bradenton, FL 34200',
};

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

it('compares the request body as it will be serialized on the wire', () => {
  expect(commercialSetupPayloadUnchanged(
    { scheduledDate: '2035-01-02', optional: undefined },
    { scheduledDate: '2035-01-02' },
  )).toBe(true);
  expect(commercialSetupPayloadUnchanged(
    { scheduledDate: '2035-01-02' },
    { scheduledDate: '2035-01-03' },
  )).toBe(false);
});

it('snapshots a validated property address and uses an honest id/default fallback', () => {
  expect(commercialSetupPropertySnapshot({
    property: { id: 'p-2', label: 'Warehouse', address_line1: '200 Commerce Way', city: 'Bradenton', state: 'FL', zip: '34200' },
  })).toEqual({ propertyLabel: 'Warehouse', propertyAddress: '200 Commerce Way, Bradenton, FL 34200' });
  expect(commercialSetupPropertySnapshot({ propertyId: 'p-missing' })).toEqual({
    propertyLabel: 'Property p-missing',
    propertyAddress: 'Address not available for property p-missing',
  });
  expect(commercialSetupPropertySnapshot()).toEqual({
    propertyLabel: 'Account/default service address',
    propertyAddress: 'Address not available in this booking',
  });
});

it('shows the exact booking snapshot, neutral source-invoice amounts, both choices, and cancellation without a default', () => {
  const onResolve = vi.fn();
  const onCancel = vi.fn();
  render(<CommercialSetupVisitReviewDialog review={review} booking={booking} onResolve={onResolve} onCancel={onCancel} />);
  expect(screen.getByRole('dialog', { name: 'Choose how to handle this setup fee' })).toBeInTheDocument();
  const bookingRegion = screen.getByRole('region', { name: 'Booking being reviewed' });
  expect(bookingRegion).toHaveTextContent('Commercial Rodent Bait Stations');
  expect(bookingRegion).toHaveTextContent('Quarterly');
  expect(bookingRegion).toHaveTextContent('Tue, Jan 2, 2035 · 9:00 AM–10:00 AM');
  expect(bookingRegion).toHaveTextContent('Warehouse');
  expect(bookingRegion).toHaveTextContent('200 Commerce Way, Bradenton, FL 34200');
  expect(screen.getByText(/source invoice includes/)).toHaveTextContent('$55.00');
  expect(screen.getByText(/visit's setup/)).toHaveTextContent('$73.00');
  expect(screen.getByRole('link', { name: 'Open source invoice' })).toHaveAttribute('href', '/admin/invoices?invoice=invoice%2Fsource%201');
  expect(onResolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: "Bill this booking's $73.00 setup separately" }));
  expect(onResolve).toHaveBeenLastCalledWith('separate');
  fireEvent.click(screen.getByRole('button', { name: 'Use the $55.00 setup on the source invoice for this visit' }));
  expect(onResolve).toHaveBeenLastCalledWith('covered');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel without saving' }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it('warns when a retry returned refreshed invoice evidence', () => {
  render(<CommercialSetupVisitReviewDialog review={review} changed onResolve={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('source invoice or setup amount changed');
});

it('names committed and remaining groups and scopes stopping to only the unsaved bookings', () => {
  const onCancel = vi.fn();
  render(<CommercialSetupVisitReviewDialog
    review={review}
    bookedGroups={['Quarterly: Pest Control']}
    remainingGroups={['Seasonal (Feb–Oct): Mosquito Control']}
    onResolve={vi.fn()}
    onCancel={onCancel}
  />);
  const notice = screen.getByRole('alert');
  expect(notice).toHaveTextContent('These appointments are already booked: Quarterly: Pest Control');
  expect(notice).toHaveTextContent('Remaining booking: Seasonal (Feb–Oct): Mosquito Control');
  expect(notice).toHaveTextContent('Stopping here leaves the remaining booking unsaved');
  fireEvent.click(screen.getByRole('button', { name: 'Stop — leave remaining booking unsaved' }));
  expect(onCancel).toHaveBeenCalledOnce();
});
