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

// Route-dispatcher audit D: a route-checked day says what it adds to the drive, as Tech Home's sheet does.
it('a day with driveMinutes says "+N min drive"; a day without keeps the load and same-area counts', () => {
  render(<RescheduleDialogView {...baseProps} options={[option('Mon, Nov 2', { routeChecked: true, driveMinutes: 12 }), option('Tue, Nov 3')]} />);
  const mon = screen.getByText(/Mon, Nov 2/).parentElement;
  expect(mon).toHaveTextContent('3:00 PM-5:00 PM · +12 min drive');
  expect(mon).not.toHaveTextContent('jobs');
  expect(screen.getByText(/Tue, Nov 3/).parentElement).toHaveTextContent('3:00 PM-5:00 PM · 4 jobs · 2 same area');
});

it('a zero-minute drive still reads as a drive, not as the load counts', () => {
  render(<RescheduleDialogView {...baseProps} options={[option('Wed, Nov 4', { routeChecked: true, driveMinutes: 0 })]} />);
  expect(screen.getByText(/Wed, Nov 4/).parentElement).toHaveTextContent('+0 min drive');
});
