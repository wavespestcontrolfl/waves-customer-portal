// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({ default: {
  getSchedule: vi.fn(), getNotificationPrefs: vi.fn(), getPropertyNotificationPrefs: vi.fn(),
  getCustomerPushStatus: vi.fn(), updateNotificationPrefs: vi.fn(),
  getPayments: vi.fn(), getBalance: vi.fn(), getCards: vi.fn(), getAutopay: vi.fn(),
} }));

import api from '../utils/api';
import { BillingTab, ScheduleTab } from './PortalPage';

const customer = { id: 'qa-app', firstName: 'QA', phone: '9415550142', email: 'qa@example.invalid', property: {} };
let prefs;
const reminder72 = () => screen.getByRole('combobox', { name: 'Delivery method for 72-Hour Appointment Reminder' });
const reminder24 = () => screen.getByRole('combobox', { name: 'Delivery method for 24-Hour Service Reminder' });

beforeEach(() => {
  vi.clearAllMocks();
  prefs = { appPreferencesAvailable: true, pushEnabled: true, serviceReminder72h: true,
    serviceReminder24h: true, serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'sms',
    smsEnabled: false, emailEnabled: false,
  };
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getNotificationPrefs.mockImplementation(async () => ({ ...prefs }));
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: true });
  api.getPayments.mockResolvedValue({ payments: [] });
  api.getBalance.mockResolvedValue({ currentBalance: 0 });
  api.getCards.mockResolvedValue({ cards: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.updateNotificationPrefs.mockImplementation(async (changes) => {
    prefs = { ...prefs, ...changes };
    return { success: true, preferences: prefs };
  });
});
afterEach(cleanup);

it('offers App on both reminder rows and saves each existing channel field', async () => {
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByText('Your account has a recently connected app.');
  for (const select of [reminder72(), reminder24()]) {
    expect(within(select).getByRole('option', { name: 'App', exact: true })).toBeEnabled();
    expect(within(select).queryByRole('option', { name: 'App first' })).not.toBeInTheDocument();
  }
  fireEvent.change(reminder72(), { target: { value: 'push' } });
  await waitFor(() => expect(reminder72()).toBeEnabled());
  fireEvent.change(reminder24(), { target: { value: 'push' } });
  await waitFor(() => expect(api.updateNotificationPrefs.mock.calls).toEqual([
    [{ serviceReminder72hChannel: 'push' }], [{ serviceReminder24hChannel: 'push' }],
  ]));
  expect(reminder72()).toHaveValue('push');
  expect(reminder24()).toHaveValue('push');
});

it('includes both reminders in the App shortcut without enabling a muted category or text/email', async () => {
  prefs.serviceReminder72h = false;
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  const shortcut = await screen.findByRole('button', { name: 'Use App for supported updates' });
  await waitFor(() => expect(shortcut).toBeEnabled());
  fireEvent.click(shortcut);
  await waitFor(() => expect(reminder24()).toHaveValue('push'));
  expect(api.updateNotificationPrefs).toHaveBeenCalledWith({
    appointmentConfirmationChannel: 'push', serviceReminder72hChannel: 'push', serviceReminder24hChannel: 'push',
    enRouteChannel: 'push', techArrivedChannel: 'push', serviceCompleteChannel: 'push', paymentConfirmationChannel: 'push', invoiceChannel: 'push', paymentIssueChannel: 'push', requestChannel: 'push',
  });
  expect(screen.getByRole('switch', { name: '72-Hour Appointment Reminder', exact: true })).toHaveAttribute('aria-checked', 'false');
  expect(prefs).toMatchObject({ serviceReminder72h: false, smsEnabled: false, emailEnabled: false });
});

it('saves Payment problems to App without enabling text or email', async () => {
  render(<BillingTab customer={customer} />);
  const select = await screen.findByRole('combobox', { name: 'Delivery method for payment problems' });
  await waitFor(() => expect(within(select).getByRole('option', { name: 'App', exact: true })).toBeEnabled());
  fireEvent.change(select, { target: { value: 'push' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(prefs).toMatchObject({ paymentIssueChannel: 'push', smsEnabled: false, emailEnabled: false });
});

it('opens the payment methods section after loading an App action destination', async () => {
  const scroll = vi.fn();
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    render(<BillingTab customer={customer} focusPaymentMethods />);
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'start' }));
    expect(scroll.mock.instances[0].id).toBe('billing-payment-methods');
  } finally { HTMLElement.prototype.scrollIntoView = previous; }
});

it('saves the invoice App choice without enabling text or email and shows save failures', async () => {
  render(<BillingTab customer={customer} />);
  const select = await screen.findByRole('combobox', { name: 'Delivery method for invoices' });
  await waitFor(() => expect(within(select).getByRole('option', { name: 'App', exact: true })).toBeEnabled());
  fireEvent.change(select, { target: { value: 'push' } });
  api.updateNotificationPrefs.mockRejectedValueOnce(new Error('unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByText(/Couldn.t save your billing preferences/);
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(api.updateNotificationPrefs).toHaveBeenLastCalledWith(expect.objectContaining({ invoiceChannel: 'push' }));
  expect(prefs).toMatchObject({ invoiceChannel: 'push', smsEnabled: false, emailEnabled: false });
});

it.each([['invoiceChannel', 'invoices'], ['paymentIssueChannel', 'payment problems']])('does not resubmit an unchanged %s App choice after a gate rollback', async (field, label) => {
  prefs[field] = 'push';
  render(<BillingTab customer={customer} />);
  const select = await screen.findByRole('combobox', { name: `Delivery method for ${label}` });
  expect(select).toHaveValue('push');
  api.updateNotificationPrefs.mockImplementation(async (changes) => {
    if (changes[field] === 'push') throw new Error('App preferences unavailable');
    return { success: true };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(api.updateNotificationPrefs).toHaveBeenCalledTimes(1);
  expect(api.updateNotificationPrefs.mock.calls[0][0]).not.toHaveProperty(field);
  expect(select).toHaveValue('push');
});

it.each([['invoiceChannel', 'invoices'], ['paymentIssueChannel', 'payment problems']])('rejects an ignored %s opt-out after rollback and restores the saved choice', async (field, label) => {
  prefs[field] = 'push';
  render(<BillingTab customer={customer} />);
  const select = await screen.findByRole('combobox', { name: `Delivery method for ${label}` });
  expect(select).toHaveValue('push');
  api.updateNotificationPrefs.mockResolvedValue({ success: true, preferences: { ...prefs } });
  fireEvent.change(select, { target: { value: 'sms' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByText(/Couldn.t save your billing preferences/);
  expect(select).toHaveValue('push');
  expect(screen.queryByRole('button', { name: 'Saved', exact: true })).not.toBeInTheDocument();
});

it('retains the saved invoice choice when the app is stale and hides it with the gate off', async () => {
  prefs.invoiceChannel = 'push';
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: false });
  const first = render(<BillingTab customer={customer} />);
  const select = await screen.findByRole('combobox', { name: 'Delivery method for invoices' });
  expect(select).toHaveValue('push');
  expect(within(select).getByRole('option', { name: 'App', exact: true })).toBeDisabled();
  fireEvent.change(select, { target: { value: 'sms' } });
  first.unmount();
  prefs.appPreferencesAvailable = false;
  render(<BillingTab customer={customer} />);
  await screen.findByRole('button', { name: 'Save billing preferences' });
  expect(screen.queryByRole('combobox', { name: 'Delivery method for invoices' })).not.toBeInTheDocument();
});

it('requires a fresh connected app before selecting App for reminders', async () => {
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: false });
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByText(/Open the app to refresh its connection/);
  expect(within(reminder72()).getByRole('option', { name: 'App', exact: true })).toBeDisabled();
  expect(within(reminder24()).getByRole('option', { name: 'App', exact: true })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use App for supported updates' })).toBeDisabled();
});

it('keeps the existing reminder options when app preferences are unavailable', async () => {
  prefs.appPreferencesAvailable = false;
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByRole('combobox', { name: 'Delivery method for 72-Hour Appointment Reminder' });
  expect(within(reminder72()).queryByRole('option', { name: 'App', exact: true })).not.toBeInTheDocument();
  expect(within(reminder24()).queryByRole('option', { name: 'App', exact: true })).not.toBeInTheDocument();
  expect(api.getCustomerPushStatus).not.toHaveBeenCalled();
});


it('saves Request updates to App and restores Email after a failed save', async () => {
  prefs.requestChannel = 'email';
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  const select = await screen.findByRole('combobox', { name: 'Delivery method for request updates' });
  await waitFor(() => expect(within(select).getByRole('option', { name: 'App', exact: true })).toBeEnabled());
  api.updateNotificationPrefs.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(select, { target: { value: 'push' } });
  await waitFor(() => expect(select).toHaveValue('email'));
  fireEvent.change(select, { target: { value: 'push' } });
  await waitFor(() => expect(prefs.requestChannel).toBe('push'));
  expect(api.updateNotificationPrefs).toHaveBeenLastCalledWith({ requestChannel: 'push' });
});


it('does not show an unconfirmed Request updates opt-out during gate rollback', async () => {
  prefs.requestChannel = 'push';
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  const select = await screen.findByRole('combobox', { name: 'Delivery method for request updates' });
  api.updateNotificationPrefs.mockResolvedValueOnce({ success: true, preferences: { appPreferencesAvailable: false } });
  fireEvent.change(select, { target: { value: 'email' } });
  await waitFor(() => expect(select).toHaveValue('push'));
});

it('blocks invalid billing email before saving and accepts a corrected address', async () => {
  prefs.billingEmail = 'existing@example.com';
  render(<BillingTab customer={customer} />);
  const field = await screen.findByRole('textbox', { name: 'Billing email', exact: true });
  fireEvent.change(field, { target: { value: 'invalid-email' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  expect(field.validity.typeMismatch).toBe(true);
  expect(api.updateNotificationPrefs).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: 'corrected@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(api.updateNotificationPrefs).toHaveBeenCalledWith(expect.objectContaining({ billingEmail: 'corrected@example.com' }));
});
