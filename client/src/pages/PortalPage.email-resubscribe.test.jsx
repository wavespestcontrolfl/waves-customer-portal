// @vitest-environment jsdom
// GATE_PORTAL_EMAIL_RESUBSCRIBE: the account holder's notification settings show a notice when
// the holder's own address carries an unsubscribe link, ask for ONE confirmation email, and
// then say "Check your email". The app never turns emails back on itself.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({ default: {
  getSchedule: vi.fn(), getNotificationPrefs: vi.fn(), getPropertyNotificationPrefs: vi.fn(),
  getCustomerPushStatus: vi.fn(), updateNotificationPrefs: vi.fn(), requestEmailResubscribe: vi.fn(),
} }));

import api from '../utils/api';
import { ScheduleTab } from './PortalPage';

const customer = { id: 'qa-app', firstName: 'QA', phone: '9415550142', email: 'qa@example.invalid', property: {} };
const PAUSED = { state: 'paused', maskedEmail: 'q***@example.invalid' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockResolvedValue({ appPreferencesAvailable: true, pushEnabled: true, emailResubscribe: PAUSED });
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: true });
});
afterEach(cleanup);

it('shows the notice for a paused address, posts on the button, then tells the customer to check their email', async () => {
  api.requestEmailResubscribe.mockResolvedValue({ state: 'sent', maskedEmail: 'q***@example.invalid', sentAt: '2026-11-04T12:00:00.000Z' });
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  expect(await screen.findByText('Emails to q***@example.invalid are off because of an unsubscribe link.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Turn emails back on' }));
  expect(await screen.findByText('Check your email. We sent a link to q***@example.invalid. Open it to turn emails back on.')).toBeInTheDocument();
  expect(api.requestEmailResubscribe).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Turn emails back on' })).not.toBeInTheDocument();
  expect(api.updateNotificationPrefs).not.toHaveBeenCalled();
});

it('an already-sent link shows the check-your-email line with no button', async () => {
  api.getNotificationPrefs.mockResolvedValue({ appPreferencesAvailable: true, pushEnabled: true,
    emailResubscribe: { state: 'sent', maskedEmail: 'q***@example.invalid', sentAt: '2026-11-04T12:00:00.000Z' } });
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  expect(await screen.findByText(/^Check your email\./)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Turn emails back on' })).not.toBeInTheDocument();
});

it('a failed send says so and keeps the button; a network error says the same', async () => {
  api.requestEmailResubscribe.mockResolvedValueOnce({ state: 'failed' }).mockRejectedValueOnce(new Error('offline'));
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByText(/are off because of an unsubscribe link\.$/);
  fireEvent.click(screen.getByRole('button', { name: 'Turn emails back on' }));
  expect(await screen.findByText("We couldn't send the email. Please try again later.")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Turn emails back on' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Turn emails back on' }));
  await waitFor(() => expect(api.requestEmailResubscribe).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("We couldn't send the email. Please try again later.")).toBeInTheDocument();
});

it('shows nothing when the payload has no emailResubscribe field', async () => {
  api.getNotificationPrefs.mockResolvedValue({ appPreferencesAvailable: true, pushEnabled: true });
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByText('Connected to your Waves app.');
  expect(screen.queryByTestId('email-resubscribe')).not.toBeInTheDocument();
});
