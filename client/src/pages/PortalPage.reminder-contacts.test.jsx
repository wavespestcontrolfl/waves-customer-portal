// @vitest-environment jsdom
// "Also gets visit texts": people named on a call get visit texts only. The
// account holder sees them under the on-location contacts editor, can stop or
// restart each one. ("Give app access" is a follow-up change.)
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});
vi.mock('../components/brand/CustomerDialogHost', async (importOriginal) => ({
  ...(await importOriginal()),
  showCustomerAlert: vi.fn(),
}));

import api from '../utils/api';
import { showCustomerAlert } from '../components/brand/CustomerDialogHost';
import { ScheduleTab } from './PortalPage';

const customer = { id: 'c1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', isPrimaryProfile: true, profileLabel: 'Primary', tier: 'Silver', property: {} };
const prefsOn = { appointmentConfirmation: true, serviceReminder72h: true, serviceReminder24h: true, techEnRoute: true, techArrived: true, appointmentNotifyPrimary: true };
const filled = (n) => ({ firstName: `First${n}`, lastName: `Last${n}`, phone: `94155500${n}${n}`, email: '' });
const profileEntry = (serviceContacts = []) => ({
  id: 'c1', customerId: 'c1', isPrimaryProfile: true, profileLabel: 'Primary',
  address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' },
  preferences: prefsOn, serviceContacts, maxServiceContacts: 3,
});
const person = (over = {}) => ({ id: 'r1', firstName: 'Bob', lastName: 'Example', phone: '+19415550111', stopped: false, stoppedAt: null, stoppedBy: null, addedAt: '2026-11-20T00:00:00Z', inContacts: false, ...over });

function setup({ contacts = [], reminders = [person()], customerOverride = {} } = {}) {
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [profileEntry(contacts)] });
  api.getReminderContacts.mockResolvedValue({ reminderContacts: reminders });
  return render(<ScheduleTab customer={{ ...customer, ...customerOverride }} properties={[]} onSelectProperty={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getSchedule.mockResolvedValue({ upcoming: [], reservice: null, overlayHandoff: false });
  api.getNotificationPrefs.mockResolvedValue({ preferences: prefsOn });
  api.updatePropertyNotificationPrefs.mockResolvedValue({ success: true, preferences: {} });
});
afterEach(() => cleanup());

describe('Also gets visit texts (named on a call)', () => {
  it('lists the people with the help copy, loaded for the profile id', async () => {
    setup();
    const section = await screen.findByTestId('reminder-contacts');
    expect(within(section).getByText('Also gets visit texts')).toBeInTheDocument();
    expect(within(section).getByText(/People named on a call get the booking, reminder and on-the-way texts for every visit\. Being on this list does not give app access\./)).toBeInTheDocument();
    expect(within(section).getByText('Bob Example')).toBeInTheDocument();
    expect(api.getReminderContacts).toHaveBeenCalledWith('c1');
  });

  it('renders no section for an empty list', async () => {
    setup({ reminders: [] });
    await screen.findByText('On-location contacts');
    await waitFor(() => expect(api.getReminderContacts).toHaveBeenCalled());
    expect(screen.queryByTestId('reminder-contacts')).not.toBeInTheDocument();
    expect(screen.queryByText('Also gets visit texts')).not.toBeInTheDocument();
  });

  it('hides the section when the load fails', async () => {
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [profileEntry()] });
    api.getReminderContacts.mockRejectedValue(new Error('boom'));
    render(<ScheduleTab customer={customer} properties={[]} onSelectProperty={() => {}} />);
    await screen.findByText('On-location contacts');
    await waitFor(() => expect(api.getReminderContacts).toHaveBeenCalled());
    expect(screen.queryByText('Also gets visit texts')).not.toBeInTheDocument();
  });

  it('never loads the list in a contact session', async () => {
    setup({ customerOverride: { actor: { kind: 'contact' } } });
    await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
    expect(api.getReminderContacts).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reminder-contacts')).not.toBeInTheDocument();
  });

  it('Stop texts calls the API and shows Stopped, then Restart texts brings it back', async () => {
    api.stopReminderContact.mockResolvedValue({ reminderContact: person({ stopped: true, stoppedBy: 'customer' }) });
    api.restartReminderContact.mockResolvedValue({ reminderContact: person() });
    setup();
    const section = await screen.findByTestId('reminder-contacts');
    fireEvent.click(within(section).getByRole('button', { name: 'Stop texts for Bob Example' }));
    await waitFor(() => expect(api.stopReminderContact).toHaveBeenCalledWith('c1', 'r1'));
    expect(await within(section).findByText('Stopped')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Restart texts for Bob Example' }));
    await waitFor(() => expect(api.restartReminderContact).toHaveBeenCalledWith('c1', 'r1'));
    await waitFor(() => expect(within(section).queryByText('Stopped')).not.toBeInTheDocument());
  });

  it('a failed Stop alerts and keeps the row unchanged', async () => {
    api.stopReminderContact.mockRejectedValue(new Error('nope'));
    setup();
    const section = await screen.findByTestId('reminder-contacts');
    fireEvent.click(within(section).getByRole('button', { name: 'Stop texts for Bob Example' }));
    await waitFor(() => expect(showCustomerAlert).toHaveBeenCalledWith('Could not stop texts. Please try again.'));
    expect(within(section).queryByText('Stopped')).not.toBeInTheDocument();
  });

  it('a person also in the contact spots says so and keeps Stop texts (it stops the texts this list sends)', async () => {
    setup({ reminders: [person({ inContacts: true })] });
    const section = await screen.findByTestId('reminder-contacts');
    expect(within(section).getByText('Also in your contacts above, which has its own text settings.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Stop texts for Bob Example' })).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Give app access' })).not.toBeInTheDocument();
  });
  it('a contacts save re-reads the list, so "also in your contacts" stays current', async () => {
    setup({ contacts: [filled(1)] });
    await screen.findByTestId('reminder-contacts');
    expect(api.getReminderContacts).toHaveBeenCalledTimes(1);
    api.getReminderContacts.mockResolvedValue({ reminderContacts: [person({ inContacts: true })] });
    api.updatePropertyNotificationPrefs.mockResolvedValue({ success: true, preferences: {}, serviceContacts: [filled(1)] });
    fireEvent.click(await screen.findByLabelText(/Everyone listed with a phone number agreed/));
    fireEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    await waitFor(() => expect(api.getReminderContacts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Also in your contacts above, which has its own text settings.')).toBeInTheDocument();
  });
});
