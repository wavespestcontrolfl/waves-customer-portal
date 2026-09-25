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
const reminder72 = () => screen.getByRole('combobox', { name: 'Delivery method for 3-day reminder' });
const reminder24 = () => screen.getByRole('combobox', { name: 'Delivery method for Day-before reminder' });
const billingChannel = (groupName, channelName) => within(screen.getByRole('group', { name: groupName })).getByRole('checkbox', { name: new RegExp(`^${channelName}`) });

beforeEach(() => {
  vi.clearAllMocks();
  prefs = { appPreferencesAvailable: true, pushEnabled: true, serviceReminder72h: true,
    serviceReminder24h: true, serviceReminder72hChannel: 'sms', serviceReminder24hChannel: 'sms',
    smsEnabled: false, emailEnabled: false,
    billingChannelsAvailable: true,
    invoiceChannels: ['sms'], paymentIssueChannels: ['sms'],
    billingReminderChannels: ['sms'], paymentConfirmationChannels: ['sms'],
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
  await screen.findByText('Connected to your Waves app.');
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

it('scopes the visit App shortcut away from billing without enabling a muted category or text/email', async () => {
  prefs.serviceReminder72h = false;
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  const shortcut = await screen.findByRole('button', { name: 'Use app for visit updates' });
  await waitFor(() => expect(shortcut).toBeEnabled());
  fireEvent.click(shortcut);
  await waitFor(() => expect(reminder24()).toHaveValue('push'));
  expect(api.updateNotificationPrefs).toHaveBeenCalledWith({
    appointmentConfirmationChannel: 'push', serviceReminder72hChannel: 'push', serviceReminder24hChannel: 'push',
    enRouteChannel: 'push', techArrivedChannel: 'push', serviceCompleteChannel: 'push', requestChannel: 'push',
  });
  expect(screen.getByRole('switch', { name: '3-day reminder', exact: true })).toHaveAttribute('aria-checked', 'false');
  expect(prefs).toMatchObject({ serviceReminder72h: false, smsEnabled: false, emailEnabled: false });
});

it.each([
  ['Email', ['email']], ['Text', ['sms']], ['App', ['push']],
  ['Email + Text', ['email', 'sms']], ['Email + App', ['email', 'push']],
  ['Text + App', ['sms', 'push']], ['Email + Text + App', ['email', 'sms', 'push']],
])('renders the %s billing channel combination', async (_label, channels) => {
  prefs.invoiceChannels = channels;
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Invoices' });
  expect(billingChannel('Invoices', 'Email')).toHaveProperty('checked', channels.includes('email'));
  expect(billingChannel('Invoices', 'Text')).toHaveProperty('checked', channels.includes('sms'));
  expect(billingChannel('Invoices', 'App')).toHaveProperty('checked', channels.includes('push'));
});

it('keeps the scalar delivery controls for an older server without the array capability', async () => {
  prefs.billingChannelsAvailable = false;
  render(<BillingTab customer={customer} />);
  expect(await screen.findByRole('combobox', { name: 'Delivery method for invoices' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Delivery method for billing reminders' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Invoices' })).not.toBeInTheDocument();
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

it('saves only changed billing categories and never changes the global text or email opt-outs', async () => {
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Invoices' });
  const app = billingChannel('Invoices', 'App');
  fireEvent.click(app);
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(api.updateNotificationPrefs).toHaveBeenLastCalledWith({ billingEmail: '', invoiceChannels: ['sms', 'push'] });
  expect(api.updateNotificationPrefs.mock.calls[0][0]).not.toHaveProperty('smsEnabled');
  expect(api.updateNotificationPrefs.mock.calls[0][0]).not.toHaveProperty('emailEnabled');
  expect(api.updateNotificationPrefs.mock.calls[0][0]).not.toHaveProperty('paymentConfirmationSms');
});

it('prevents removing the final channel with mouse or keyboard activation', async () => {
  prefs.smsEnabled = true;
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Invoices' });
  const text = billingChannel('Invoices', 'Text');
  expect(text).toBeDisabled();
  fireEvent.click(text);
  fireEvent.keyDown(text, { key: ' ', code: 'Space' });
  expect(text).toBeChecked();
});

it('rolls billing choices back when saving fails', async () => {
  prefs.smsEnabled = true;
  prefs.emailEnabled = true;
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Invoices' });
  const email = billingChannel('Invoices', 'Email');
  fireEvent.click(email);
  expect(email).toBeChecked();
  api.updateNotificationPrefs.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByText(/Couldn.t save your billing preferences/);
  expect(email).not.toBeChecked();
  expect(screen.queryByRole('button', { name: 'Saved', exact: true })).not.toBeInTheDocument();
});

it('rejects an ignored array update and restores the server-confirmed choices', async () => {
  prefs.smsEnabled = true;
  prefs.emailEnabled = true;
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Invoices' });
  const email = billingChannel('Invoices', 'Email');
  fireEvent.click(email);
  api.updateNotificationPrefs.mockResolvedValueOnce({ success: true, preferences: { ...prefs } });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByText(/Couldn.t save your billing preferences/);
  expect(email).not.toBeChecked();
});

it('shows a stored stale App choice, allows deselecting it when another remains, and blocks new App choices', async () => {
  prefs.smsEnabled = true;
  prefs.invoiceChannels = ['sms', 'push'];
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: false });
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Invoices' });
  const savedApp = billingChannel('Invoices', 'App');
  expect(savedApp).toBeEnabled();
  expect(billingChannel('Billing reminders', 'App')).toBeDisabled();
  fireEvent.click(savedApp);
  expect(savedApp).not.toBeChecked();
});

it('preserves the receipt-text opt-out until the customer explicitly turns it on', async () => {
  prefs.smsEnabled = true;
  prefs.paymentConfirmationSms = false;
  prefs.paymentConfirmationChannels = ['push'];
  render(<BillingTab customer={customer} />);
  await screen.findByRole('group', { name: 'Payment receipts' });
  expect(billingChannel('Payment receipts', 'Text')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(prefs.paymentConfirmationSms).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Turn on receipt texts' }));
  fireEvent.click(billingChannel('Payment receipts', 'Text'));
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(prefs).toMatchObject({ paymentConfirmationSms: true, paymentConfirmationChannels: ['sms', 'push'] });
});

it('a rejected receipt-text opt-in leaves the existing opt-out visible', async () => {
  prefs.smsEnabled = true;
  prefs.paymentConfirmationSms = false;
  prefs.paymentConfirmationChannels = ['push'];
  render(<BillingTab customer={customer} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on receipt texts' }));
  api.updateNotificationPrefs.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('alert');
  expect(billingChannel('Payment receipts', 'Text')).toBeDisabled();
  expect(screen.getByText('Text receipts are off.')).toBeInTheDocument();
});

it('requires a fresh connected app before selecting App for reminders', async () => {
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: false });
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByText(/Open the app to refresh its connection/);
  expect(within(reminder72()).getByRole('option', { name: 'App', exact: true })).toBeDisabled();
  expect(within(reminder24()).getByRole('option', { name: 'App', exact: true })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use app for visit updates' })).toBeDisabled();
});

it('keeps the existing reminder options when app preferences are unavailable', async () => {
  prefs.appPreferencesAvailable = false;
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByRole('combobox', { name: 'Delivery method for 3-day reminder' });
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
