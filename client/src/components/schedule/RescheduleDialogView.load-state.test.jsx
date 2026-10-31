// @vitest-environment jsdom
// Suggested dates: a failed load says so and offers Try again; an empty
// result says there are none. Before, both left a blank area (schedule audit S6).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

it('shows a failed load with Try again and the custom-date fallback', () => {
  const onRetryOptions = vi.fn();
  render(<RescheduleDialogView {...baseProps} options={[]} optionsError onRetryOptions={onRetryOptions} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load suggested dates');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetryOptions).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /Pick Custom Date/ })).toBeInTheDocument();
});

it('says there are no suggestions when the search found none', () => {
  render(<RescheduleDialogView {...baseProps} options={[]} />);
  expect(screen.getByText(/No suggested dates on route/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
