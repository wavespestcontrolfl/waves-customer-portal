// @vitest-environment jsdom
/**
 * Terminal-action gating (Codex P1 on #2717): Cancel appointment and Mark
 * as no-show must only render while the visit is still active — the status
 * route reads the CURRENT row as fromStatus, so offering them on a
 * completed/cancelled visit lets one tap flip a finished (possibly
 * compliance) visit terminal in the other direction.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

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
