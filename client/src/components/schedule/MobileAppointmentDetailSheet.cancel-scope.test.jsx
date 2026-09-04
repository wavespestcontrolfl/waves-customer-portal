// @vitest-environment jsdom
/**
 * Cancel scope on the mobile sheet: a recurring visit offers the same
 * this_only / following / series choice the desktop sidebar and the
 * Edit-appointment modal send, and the chosen scope reaches BOTH the
 * card-hold fee prompt and the dispatch status request. A one-off visit
 * never shows the picker and always sends this_only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./RainOutSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: [], loading: false, error: null }),
}));
vi.mock('../../lib/cardHoldCancel', () => ({
  confirmCardHoldFeeChoice: vi.fn(async () => ({ proceed: true, waiveCardHoldFee: false })),
  fetchCardHoldCancelPreview: vi.fn(async () => null),
}));

import { confirmCardHoldFeeChoice } from '../../lib/cardHoldCancel';
import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

const baseService = {
  id: 55,
  customerId: 9,
  customerName: 'Test Customer 9',
  serviceType: 'Quarterly Pest Control',
  scheduledDate: '2026-09-10',
  scheduledTime: '10:00',
  address: '123 Palm Ave',
  status: 'confirmed',
};

function statusCall() {
  const call = global.fetch.mock.calls.find(([url, opts]) => /\/admin\/dispatch\/55\/status$/.test(url) && opts?.method === 'PUT');
  return call ? JSON.parse(call[1].body) : null;
}

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  confirmCardHoldFeeChoice.mockClear();
});
afterEach(cleanup);

describe('MobileAppointmentDetailSheet cancel scope', () => {
  it('hides the scope picker on a one-off visit and sends this_only', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.queryByText('Apply changes to')).toBeNull();
    fireEvent.click(screen.getByText('Confirm cancellation'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('this_only');
    expect(confirmCardHoldFeeChoice).toHaveBeenCalledWith(55, { scope: 'this_only' });
  });

  it('offers the three scopes on a recurring visit and defaults to this_only', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.getByText('Apply changes to')).toBeTruthy();
    expect(screen.getByLabelText('This appointment only').checked).toBe(true);
    fireEvent.click(screen.getByText('Confirm cancellation'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('this_only');
  });

  it('offers the series scopes on a legacy row that carries only recurringPattern', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: null, recurringPattern: 'quarterly' }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.getByText('Apply changes to')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('All appointments in series'));
    fireEvent.click(screen.getByText('Confirm cancellations'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('series');
  });

  it.each([
    ['This and following appointments', 'following'],
    ['All appointments in series', 'series'],
  ])('sends %s as scope %s to the fee prompt and the request', async (label, scope) => {
    const onCancelled = vi.fn();
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} onCancelled={onCancelled} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByText('Confirm cancellations'));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(confirmCardHoldFeeChoice).toHaveBeenCalledWith(55, { scope });
    expect(statusCall()).toMatchObject({ status: 'cancelled', scope, notifyCustomer: true });
  });

  it('adds the series caveat to the fee notice once a series scope is chosen', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    const caveat = /judged on their own saved cards/;
    await waitFor(() => expect(screen.getByText(/Couldn't check the saved card/)).toBeTruthy());
    expect(screen.queryByText(caveat)).toBeNull();
    fireEvent.click(screen.getByLabelText('This and following appointments'));
    await waitFor(() => expect(screen.getByText(caveat)).toBeTruthy());
  });

  it('does not send when the fee prompt is declined', async () => {
    confirmCardHoldFeeChoice.mockResolvedValueOnce({ proceed: false, waiveCardHoldFee: false });
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    fireEvent.click(screen.getByLabelText('All appointments in series'));
    fireEvent.click(screen.getByText('Confirm cancellations'));
    await waitFor(() => expect(confirmCardHoldFeeChoice).toHaveBeenCalledTimes(1));
    expect(statusCall()).toBeNull();
  });
});
