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

it('uses one delivery control for optional reports and weather alerts, retaining the report channel when off', async () => {
  prefs = { ...prefs, serviceCompleted: true, serviceCompleteChannel: 'push', weatherAlerts: true };
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  const reports = await screen.findByRole('combobox', { name: 'Delivery method for Service reports' });
  const weather = screen.getByRole('combobox', { name: 'Delivery method for Weather & property alerts' });
  await waitFor(() => expect(within(reports).getByRole('option', { name: 'App', exact: true })).toBeEnabled());
  expect(screen.queryByRole('switch', { name: 'Service reports', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Weather & property alerts', exact: true })).not.toBeInTheDocument();
  expect(within(reports).getAllByRole('option').map(option => option.textContent)).toEqual(['Text', 'App', 'Off']);
  expect(within(weather).getAllByRole('option').map(option => option.textContent)).toEqual(['App', 'Off']);

  fireEvent.change(reports, { target: { value: 'off' } });
  await waitFor(() => expect(reports).toBeEnabled());
  expect(reports).toHaveValue('off');
  expect(prefs).toMatchObject({ serviceCompleted: false, serviceCompleteChannel: 'push' });
  fireEvent.change(reports, { target: { value: 'sms' } });
  await waitFor(() => expect(reports).toBeEnabled());
  expect(reports).toHaveValue('sms');
  expect(prefs).toMatchObject({ serviceCompleted: true, serviceCompleteChannel: 'sms' });

  fireEvent.change(weather, { target: { value: 'off' } });
  await waitFor(() => expect(weather).toBeEnabled());
  expect(weather).toHaveValue('off');
  fireEvent.change(weather, { target: { value: 'push' } });
  await waitFor(() => expect(weather).toBeEnabled());
  expect(weather).toHaveValue('push');
  expect(api.updateNotificationPrefs.mock.calls).toEqual([
    [{ serviceCompleted: false }],
    [{ serviceCompleteChannel: 'sms', serviceCompleted: true }],
    [{ weatherAlerts: false }],
    [{ weatherAlerts: true }],
  ]);
  expect(prefs).toMatchObject({ smsEnabled: false, emailEnabled: false });
});

it.each(['offline', 'ignored'])('restores optional report and weather choices after an %s save', async (failure) => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    prefs = { ...prefs, serviceCompleted: false, serviceCompleteChannel: 'push', weatherAlerts: true };
    api.updateNotificationPrefs.mockImplementation(async () => {
      if (failure === 'offline') throw new Error('offline');
      return { success: true, preferences: { ...prefs } };
    });
    render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
    const reports = await screen.findByRole('combobox', { name: 'Delivery method for Service reports' });
    const weather = screen.getByRole('combobox', { name: 'Delivery method for Weather & property alerts' });
    fireEvent.change(reports, { target: { value: 'sms' } });
    await waitFor(() => expect(reports).toBeEnabled());
    expect(reports).toHaveValue('off');
    fireEvent.change(weather, { target: { value: 'off' } });
    await waitFor(() => expect(weather).toBeEnabled());
    expect(weather).toHaveValue('push');
    expect(prefs).toMatchObject({ serviceCompleted: false, serviceCompleteChannel: 'push', weatherAlerts: true });
  } finally { errorLog.mockRestore(); }
});

it('keeps a stored App report choice visible without offering a new App choice on an unavailable device', async () => {
  prefs = { ...prefs, serviceCompleted: true, serviceCompleteChannel: 'push' };
  api.getCustomerPushStatus.mockResolvedValue({ available: true, enabled: true, registered: true, fresh: false });
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  const reports = await screen.findByRole('combobox', { name: 'Delivery method for Service reports' });
  expect(reports).toHaveValue('push');
  expect(within(reports).getByRole('option', { name: 'App', exact: true })).toBeDisabled();
  expect(within(reports).getByRole('option', { name: 'Off', exact: true })).toBeEnabled();
  fireEvent.change(reports, { target: { value: 'off' } });
  await waitFor(() => expect(reports).toBeEnabled());
  expect(reports).toHaveValue('off');
  expect(prefs.serviceCompleteChannel).toBe('push');
});

it('scopes the visit App shortcut away from billing without enabling a muted category or text/email', async () => {
  prefs.serviceReminder72h = false;
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByText('Connected to your Waves app.');
  expect(screen.queryByRole('button', { name: 'Use app for visit updates' })).not.toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'App notifications for my account' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Manage app notification settings' }));
  expect(api.updateNotificationPrefs).not.toHaveBeenCalled();
  expect(screen.getByRole('switch', { name: 'App notifications for my account' })).toBeVisible();
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

it('requires a usable alternative before clearing the only billing email destination', async () => {
  const noAccountEmail = { ...customer, email: '' };
  prefs = { ...prefs, billingEmail: 'billing@example.invalid', emailEnabled: true, smsEnabled: true,
    invoiceChannels: ['email'], paymentIssueChannels: ['email'], billingReminderChannels: ['email'], paymentConfirmationChannels: ['email'] };
  render(<BillingTab customer={noAccountEmail} />);
  await screen.findByRole('group', { name: 'Invoices' });
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/Add an available Text or App option/);
  expect(api.updateNotificationPrefs).not.toHaveBeenCalled();
  for (const group of ['Invoices', 'Payment problems', 'Billing reminders', 'Payment receipts']) fireEvent.click(billingChannel(group, 'Text'));
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(api.updateNotificationPrefs).toHaveBeenCalledWith(expect.objectContaining({
    billingEmail: '', invoiceChannels: ['email', 'sms'], paymentIssueChannels: ['email', 'sms'], billingReminderChannels: ['email', 'sms'], paymentConfirmationChannels: ['email', 'sms'],
  }));
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

it.each([
  ['Payment receipts', 'paymentConfirmationChannels', ['sms', 'push'], 'App', { paymentConfirmationSms: false }, customer],
  // Owner ruling 2026-09-26: the portal-wide email switch no longer makes
  // Email unavailable (hasBillingEmail no longer reads it) — only a missing
  // address does, so Email is made unavailable here by clearing it instead.
  ['Invoices', 'invoiceChannels', ['email', 'sms'], 'Text', {}, { ...customer, email: '' }],
])('keeps the last usable channel in %s when another selected channel is unavailable', async (group, key, channels, usable, overrides, renderCustomer) => {
  prefs = { ...prefs, smsEnabled: true, emailEnabled: true, [key]: channels, ...overrides };
  render(<BillingTab customer={renderCustomer} />);
  await screen.findByRole('group', { name: group });
  const lastUsable = billingChannel(group, usable);
  expect(lastUsable).toBeDisabled();
  fireEvent.click(lastUsable);
  expect(lastUsable).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save billing preferences' }));
  await screen.findByRole('button', { name: 'Saved', exact: true });
  expect(api.updateNotificationPrefs.mock.calls[0][0]).not.toHaveProperty(key);
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
  expect(screen.getByRole('switch', { name: 'App notifications for my account' })).toBeVisible();
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

it('reveals help for every service notification without changing preferences', async () => {
  render(<ScheduleTab customer={customer} onRequestVisit={() => {}} />);
  await screen.findByRole('combobox', { name: 'Delivery method for request updates' });
  const explanations = [
    ['Appointment updates', 'Bookings, changes and cancellations'],
    ['3-day reminder', 'A reminder three days before your visit'],
    ['Day-before reminder', 'A reminder the day before your visit'],
    ['On the way', 'Live technician tracking'],
    ['Technician arrival', 'An alert when your technician reaches the property'],
    ['Service reports', 'Choose text or app alerts; app may fall back to text. Off stops all report notifications, including emails. Reports remain in Documents.'],
    ['Weather & property alerts', 'Rain and lawn advisories in the app. Choose Off to stop these alerts.'],
    ['Request updates', 'Updates when your service request is received or changes'],
  ];
  for (const [label, description] of explanations) {
    const summary = screen.getByText(label, { selector: 'summary span' }).closest('summary');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText(description)).toBeVisible();
  }
  expect(api.updateNotificationPrefs).not.toHaveBeenCalled();
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
