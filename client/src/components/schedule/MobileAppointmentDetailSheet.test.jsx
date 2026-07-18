// @vitest-environment jsdom
/**
 * Terminal-action gating (Codex P1 on #2717): Cancel appointment and Mark
 * as no-show must only render while the visit is still active — the status
 * route reads the CURRENT row as fromStatus, so offering them on a
 * completed/cancelled visit lets one tap flip a finished (possibly
 * compliance) visit terminal in the other direction.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./RainOutSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: [], loading: false, error: null }),
}));
vi.mock('../../lib/cardHoldCancel', () => ({
  confirmCardHoldFeeChoice: vi.fn(),
}));

import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

const baseService = {
  id: 55,
  customerId: 9,
  customerName: 'Test Customer',
  serviceType: 'WDO Inspection',
  scheduledDate: '2026-07-13',
  scheduledTime: '10:00',
  address: '123 Palm Ave',
  monthlyRate: 250,
};

function renderSheet(status) {
  return render(
    <MobileAppointmentDetailSheet
      service={{ ...baseService, status }}
      onClose={() => {}}
    />,
  );
}

describe('MobileAppointmentDetailSheet terminal-action gating', () => {
  it('offers Cancel and No-show while the visit is active', () => {
    renderSheet('confirmed');
    expect(screen.getByText('Cancel appointment')).toBeTruthy();
    expect(screen.getByText('Mark as no-show')).toBeTruthy();
    cleanup();
  });

  it.each(['completed', 'cancelled', 'no_show', 'skipped'])(
    'hides Cancel and No-show for a %s visit',
    (status) => {
      renderSheet(status);
      expect(screen.queryByText('Cancel appointment')).toBeNull();
      expect(screen.queryByText('Mark as no-show')).toBeNull();
      cleanup();
    },
  );
});

describe('MobileAppointmentDetailSheet completion routing', () => {
  it('honors an explicit standard profile when a closed legacy project remains linked', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...baseService,
          status: 'confirmed',
          completionProfile: { projectBacked: false, requiresProject: false },
          linkedProject: { id: 44, status: 'closed' },
        }}
        onClose={() => {}}
      />,
    );

    const complete = screen.getByRole('button', { name: 'Complete service' });
    expect(complete.disabled).toBe(false);
    cleanup();
  });

  it('opens a no-charge project visit through the project completion route', async () => {
    const onCompleteService = vi.fn();
    const onReviewCheckout = vi.fn();
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...baseService,
          status: 'confirmed',
          monthlyRate: 0,
          servicePrice: 0,
          completionProfile: { projectBacked: true },
          linkedProject: { id: 44, status: 'draft' },
        }}
        onClose={() => {}}
        onCompleteService={onCompleteService}
        onReviewCheckout={onReviewCheckout}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open project details' }));
    await waitFor(() => expect(onCompleteService).toHaveBeenCalledTimes(1));
    expect(onReviewCheckout).not.toHaveBeenCalled();
    cleanup();
  });
});
