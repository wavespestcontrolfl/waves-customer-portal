// @vitest-environment jsdom
// Appointment texts per SAVED property (app property scope, PR 3): the Visits
// tab's notifications card lists one entry per saved house once the server
// answers that shape, shows the selected house's toggles, saves a toggle to
// the PROFILE with the property named, and says contacts are shared.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import api from '../utils/api';
import { ScheduleTab } from './PortalPage';

const customer = { id: 'c1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', isPrimaryProfile: true, profileLabel: 'Primary', tier: 'Silver', property: {} };
const entries = [
  { id: 'c1:pa', key: 'c1:pa', customerId: 'c1', propertyId: 'pa', isPrimaryProfile: true, isPrimaryProperty: true, profileLabel: 'Primary', label: null, relationship: 'own_home', address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } },
  { id: 'c1:pr', key: 'c1:pr', customerId: 'c1', propertyId: 'pr', isPrimaryProfile: true, isPrimaryProperty: false, profileLabel: 'Primary', label: null, relationship: 'rental_owned', address: { line1: '77 Pine Ct', city: 'Palmetto', state: 'FL', zip: '34221' } },
];
const prefsOf = (on) => ({ appointmentConfirmation: on, serviceReminder72h: on, serviceReminder24h: on, techEnRoute: on, techArrived: on, appointmentNotifyPrimary: true });
const propertyPrefs = [
  { ...entries[0], preferences: prefsOf(true), contactsShared: true, serviceContacts: [], maxServiceContacts: 3 },
  { ...entries[1], preferences: prefsOf(false), quietByDefault: true, chosen: {}, contactsShared: true, serviceContacts: [], maxServiceContacts: 3 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getSchedule.mockResolvedValue({ upcoming: [], reservice: null, overlayHandoff: false, propertyScope: { enabled: true, propertyId: 'pr', closed: false } });
  api.getSavedPropertiesNext.mockResolvedValue({ properties: entries.map((e) => ({ key: e.key, customerId: e.customerId, propertyId: e.propertyId, next: null })) });
  api.getNotificationPrefs.mockResolvedValue({ preferences: prefsOf(true) });
  api.getPropertyNotificationPrefs.mockResolvedValue({ properties: propertyPrefs });
  api.updatePropertyNotificationPrefs.mockResolvedValue({ success: true, propertyId: 'pr', preferences: { techEnRoute: true } });
});
afterEach(() => cleanup());

describe('Appointment texts per saved property', () => {
  it('shows the SELECTED house\'s toggles with the quiet-by-default copy and the shared-contacts note', async () => {
    render(<ScheduleTab customer={customer} properties={entries} activePropertyId="c1:pr" selectedProperty={{ key: 'c1:pr', customerId: 'c1', propertyId: 'pr' }} onSelectProperty={() => {}} />);
    expect(await screen.findByText('Appointment notifications')).toBeInTheDocument();
    expect(screen.getByText(/Rentals and managed properties start quiet/)).toBeInTheDocument();
    expect(screen.getByText(/On-location contacts are shared across this profile/)).toBeInTheDocument();
    expect(screen.getByText('All alerts off')).toBeInTheDocument();
  });
  it('a toggle saves to the PROFILE with the saved property named', async () => {
    render(<ScheduleTab customer={customer} properties={entries} activePropertyId="c1:pr" selectedProperty={{ key: 'c1:pr', customerId: 'c1', propertyId: 'pr' }} onSelectProperty={() => {}} />);
    await screen.findByText('Appointment notifications');
    const row = screen.getByText('Tech en route').closest('div');
    fireEvent.click(row.querySelector('[role="switch"]'));
    await waitFor(() => expect(api.updatePropertyNotificationPrefs).toHaveBeenCalledWith('c1', { techEnRoute: true, propertyId: 'pr' }));
  });
  it('the PRIMARY house reads the profile row copy', async () => {
    render(<ScheduleTab customer={customer} properties={entries} activePropertyId="c1:pa" selectedProperty={{ key: 'c1:pa', customerId: 'c1', propertyId: 'pa' }} onSelectProperty={() => {}} />);
    expect(await screen.findByText(/Your primary residence gets every alert/)).toBeInTheDocument();
    expect(screen.getByText('All alerts on')).toBeInTheDocument();
  });
  // The primary was retired: one active saved property, non-primary. Its own
  // toggles render, never the contacts-only card editing the profile defaults
  // (GitHub codex r0 P2).
  it('a LONE secondary saved property still gets its own toggles', async () => {
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [propertyPrefs[1]] });
    render(<ScheduleTab customer={customer} properties={[entries[1]]} activePropertyId="c1:pr" selectedProperty={{ key: 'c1:pr', customerId: 'c1', propertyId: 'pr' }} onSelectProperty={() => {}} />);
    expect(await screen.findByText('Appointment notifications')).toBeInTheDocument();
    expect(screen.getByText('Tech en route')).toBeInTheDocument();
    expect(screen.getByText('All alerts off')).toBeInTheDocument();
  });
  it('names the picker entries by HOUSE and moves the five category switches off the profile card', async () => {
    render(<ScheduleTab customer={customer} properties={entries} activePropertyId="c1:pr" selectedProperty={{ key: 'c1:pr', customerId: 'c1', propertyId: 'pr' }} onSelectProperty={() => {}} />);
    await screen.findByText('Appointment notifications');
    // The rental has no label: its relationship chip names it, never "Primary".
    expect(screen.getAllByText('Rental').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Primary residence · 77 Pine Ct/)).not.toBeInTheDocument();
    // The profile card keeps the delivery choice but not the on/off switch.
    expect(await screen.findByTestId('per-property-techEnRoute')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Tech En Route Alert' })).not.toBeInTheDocument();
  });
  it('keeps the delivery choice selectable when the HOUSE enables an alert the profile row has off', async () => {
    api.getNotificationPrefs.mockResolvedValue({ preferences: { ...prefsOf(true), techEnRoute: false, appPreferencesAvailable: false } });
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [propertyPrefs[0], { ...propertyPrefs[1], preferences: { ...prefsOf(false), techEnRoute: true } }] });
    render(<ScheduleTab customer={{ ...customer, email: 'pat@example.com' }} properties={entries} activePropertyId="c1:pr" selectedProperty={{ key: 'c1:pr', customerId: 'c1', propertyId: 'pr' }} onSelectProperty={() => {}} />);
    await screen.findByTestId('per-property-techEnRoute');
    const row = screen.getByTestId('per-property-techEnRoute').closest('[data-reminder-row]');
    const select = row.querySelector('select');
    expect(select).not.toBeNull();
    expect(select.disabled).toBe(false);
  });
  it('a SIBLING profile\'s house keeps that profile\'s identity in the picker', async () => {
    const sibling = { id: 'c2:pc', key: 'c2:pc', customerId: 'c2', propertyId: 'pc', isPrimaryProfile: false, isPrimaryProperty: true, profileLabel: 'Rental - Sandbar Ln', label: null, relationship: null, address: { line1: '9 Sandbar Ln', city: 'Bradenton', state: 'FL', zip: '34205' } };
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [...propertyPrefs, { ...sibling, preferences: prefsOf(true), contactsShared: true, serviceContacts: [], maxServiceContacts: 3 }] });
    render(<ScheduleTab customer={customer} properties={[...entries, sibling]} activePropertyId="c2:pc" selectedProperty={{ key: 'c2:pc', customerId: 'c2', propertyId: 'pc' }} onSelectProperty={() => {}} />);
    await screen.findByText('Appointment notifications');
    expect(screen.getAllByText('Rental - Sandbar Ln').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Primary residence · 9 Sandbar Ln/)).not.toBeInTheDocument();
  });
});
