// @vitest-environment jsdom
// GATE_DAY_ONLY_PROMISE part E: the visit sheet shows what the customer was told, from the feed's `told` field (present
// only with the gate on): "Told: day only" for level day, "Told: {window}" for level hour, nothing for none or no field.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./RainOutSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../lib/cardHoldCancel', () => ({ confirmCardHoldFeeChoice: vi.fn() }));
vi.mock('../../hooks/useCustomerCards', () => ({ useCustomerCards: () => ({ cards: null }) }));
vi.mock('./ScheduleSaveNotice', () => ({ showScheduleSaveNotice: vi.fn() }));

window.scrollTo = vi.fn();

const VISIT = {
  id: 'svc-told', status: 'confirmed', serviceType: 'General Pest Control', serviceTypeDisplay: 'General Pest Control',
  estimatedPrice: 0, scheduledDate: '2031-03-07', windowStart: '13:00:00', windowEnd: '14:30:00', estimatedDuration: 90,
  customerId: 'cust-1', customerName: 'Fixture account',
};

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Told badge on the visit sheet', () => {
  it('level day reads "Told: day only"', () => {
    render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'day', dayOnly: true } }} onClose={() => {}} />);
    expect(screen.getByTestId('told-badge')).toHaveTextContent('Told: day only');
  });

  it('level hour reads "Told: {the visit\'s current window}"', () => {
    render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'hour', dayOnly: false } }} onClose={() => {}} />);
    expect(screen.getByTestId('told-badge').textContent).toMatch(/^Told: 1:00/);
  });

  it('level none, or no field (gate off), shows nothing', () => {
    const none = render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'none', dayOnly: false } }} onClose={() => {}} />);
    expect(screen.queryByTestId('told-badge')).toBeNull();
    none.unmount();
    render(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} />);
    expect(screen.queryByTestId('told-badge')).toBeNull();
  });
});
