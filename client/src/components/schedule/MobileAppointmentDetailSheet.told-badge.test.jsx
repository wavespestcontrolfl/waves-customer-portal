// @vitest-environment jsdom
// GATE_DAY_ONLY_PROMISE part E: the visit sheet shows what the customer was told, from the feed's `told` field (present
// only with the gate on): "Told: day only" for level day, "Told: {the promised window}" for level hour, nothing for none or no field.
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

  it('level hour reads the window the customer was told (2 hours), not the visit\'s 90-minute block', () => {
    render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'hour', dayOnly: false, date: '2031-03-07', window: '1:00 PM - 3:00 PM' } }} onClose={() => {}} />);
    expect(screen.getByTestId('told-badge')).toHaveTextContent('Told: 1:00 PM - 3:00 PM');
  });

  it('a visit moved after the promise shows the PROMISED date and window', () => {
    render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'hour', dayOnly: false, date: '2031-03-05', window: '9:00 AM - 11:00 AM' } }} onClose={() => {}} />);
    expect(screen.getByTestId('told-badge')).toHaveTextContent('Told: Wed, Mar 5, 9:00 AM - 11:00 AM');
  });

  it('an unknown slot reads "time not recorded"', () => {
    render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'hour', dayOnly: false, date: null, window: null } }} onClose={() => {}} />);
    expect(screen.getByTestId('told-badge')).toHaveTextContent('Told: time not recorded');
  });

  it('level none, or no field (gate off), shows nothing', () => {
    const none = render(<MobileAppointmentDetailSheet service={{ ...VISIT, told: { level: 'none', dayOnly: false } }} onClose={() => {}} />);
    expect(screen.queryByTestId('told-badge')).toBeNull();
    none.unmount();
    render(<MobileAppointmentDetailSheet service={VISIT} onClose={() => {}} />);
    expect(screen.queryByTestId('told-badge')).toBeNull();
  });
});
