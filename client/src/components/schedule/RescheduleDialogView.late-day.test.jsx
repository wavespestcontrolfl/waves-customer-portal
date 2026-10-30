// @vitest-environment jsdom
// GATE_ROUTE_CHECK_LATE_DAYS: a suggested day whose booked stops already arrive late carries a small tag.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RescheduleDialogView from './RescheduleDialogView';

afterEach(cleanup);

const baseProps = {
  service: { customerName: 'Fixture Customer', serviceType: 'Pest Control' },
  reason: 'customer_request', setReason: vi.fn(), notes: '', setNotes: vi.fn(), notificationType: 'none', setNotificationType: vi.fn(),
  sending: false, seriesConfirm: null, reasons: [{ value: 'customer_request', label: 'Customer request' }], loading: false,
  windowFor: () => null, handleReschedule: vi.fn(), showManual: false, setShowManual: vi.fn(), manualDate: '', setManualDate: vi.fn(),
  manualTime: '09:00', setManualTime: vi.fn(), durationMinutes: 60, handleManualReschedule: vi.fn(), manualConflicts: [],
  manualAvailability: null, onClose: vi.fn(),
};
const option = (displayDate, over = {}) => ({
  displayDate, suggestedWindow: { start: '15:00', end: '17:00', display: '3:00 PM-5:00 PM' }, currentLoad: 4, sameAreaServices: 2, ...over,
});

it('tags only the suggested day the server marks dayAlreadyLate', () => {
  render(<RescheduleDialogView {...baseProps} options={[option('Mon, Nov 2', { dayAlreadyLate: true }), option('Tue, Nov 3')]} />);
  expect(screen.getByText(/Mon, Nov 2/).parentElement).toHaveTextContent('already late');
  expect(screen.getByText(/Tue, Nov 3/).parentElement).not.toHaveTextContent('already late');
  expect(screen.getByText(/Mon, Nov 2/).parentElement).toHaveTextContent('4 jobs · 2 same area');
});
