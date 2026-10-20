// @vitest-environment jsdom
// Contact session (GATE_CONTACT_LOGIN): /auth/me reports actor.kind
// 'contact' for an on-location contact signed in with their own number. The
// Visits tab keeps the schedule READ but renders no Confirm / Reschedule /
// Request control (owner 2026-10-20: view only), never reads the holder's
// preference routes (they answer 403), and shows the contact's OWN
// notification card instead — choices that only narrow, with the holder's
// account-wide off locked, and a consent statement before texts turn on.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getSchedule: vi.fn(),
    getNotificationPrefs: vi.fn(),
    getPropertyNotificationPrefs: vi.fn(),
    getContactNotificationPrefs: vi.fn(),
    updateContactNotificationPrefs: vi.fn(),
    getNextService: vi.fn(),
    getServices: vi.fn(),
    getStationMap: vi.fn(),
    getTermiteBond: vi.fn(),
    getLawnHealth: vi.fn(),
    getRequests: vi.fn(),
    getCustomerPushStatus: vi.fn(),
  },
}));
const alerts = vi.hoisted(() => ({ showCustomerAlert: vi.fn() }));
vi.mock('../components/brand/CustomerDialogHost', () => ({
  showCustomerAlert: alerts.showCustomerAlert,
  showCustomerConfirm: vi.fn(async () => true),
}));

import api from '../utils/api';
import { DocumentSection, ScheduleTab } from './PortalPage';

// No tier on a contact session (the server omits the holder's plan).
const contactCustomer = {
  id: 'cust-1', firstName: 'Sam', lastName: 'Spouse',
  phone: '+19415550202', email: 'sam@example.com', property: {},
  actor: { kind: 'contact', slot: 1, name: 'Sam Spouse', phone: '+19415550202', email: 'sam@example.com' },
};
const holderCustomer = { ...contactCustomer, firstName: 'Pat', phone: '+19415550101', tier: 'gold', actor: { kind: 'holder' } };

const contactPrefs = () => ({
  contact: { name: 'Sam Spouse', phone: '+19415550202', email: 'sam@example.com', slot: 1 },
  preferences: {
    appointmentConfirmation: true, serviceReminder72h: false, serviceReminder24h: true, techEnRoute: true, techArrived: true, serviceCompleted: true,
    appointmentConfirmationChannel: 'both', serviceReminder72hChannel: 'both', serviceReminder24hChannel: 'both', enRouteChannel: 'both', techArrivedChannel: 'both', serviceCompleteChannel: 'both',
    smsEnabled: true, emailEnabled: true,
  },
  accountOff: { appointmentConfirmation: false, serviceReminder72h: true, serviceReminder24h: false, techEnRoute: false, techArrived: false, serviceCompleted: false },
  emailAvailable: true,
  reportsWithheld: false,
  consentAttestedAt: null,
  smsOptin: 'pending',
});

const futureDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const upcomingVisit = {
  id: 'svc-1', date: futureDate, serviceType: 'Quarterly Pest Control',
  windowStart: '09:00', status: 'confirmed', customerConfirmed: false,
  rescheduleUrl: '/reschedule/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

beforeEach(() => {
  Object.values(api).forEach((fn) => { if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null); });
  api.getSchedule.mockResolvedValue({ upcoming: [upcomingVisit] });
  api.getContactNotificationPrefs.mockResolvedValue(contactPrefs());
  api.updateContactNotificationPrefs.mockImplementation(async (patch) => {
    const next = contactPrefs();
    next.preferences = { ...next.preferences, ...patch };
    if (patch.consentAttested) next.consentAttestedAt = '2026-10-20T00:00:00Z';
    return next;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderSchedule(customer, props = {}) {
  render(<ScheduleTab customer={customer} onRequestVisit={props.onRequestVisit ?? null} />);
  await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
  await screen.findByText(/Quarterly Pest Control/);
}

describe('ScheduleTab — contact session is view-only', () => {
  it('lists the visit but renders no Confirm, no Reschedule, and never reads the holder\'s preferences', async () => {
    await renderSchedule(contactCustomer);
    expect(screen.getByText(/Quarterly Pest Control/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^confirm/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Reschedule')).not.toBeInTheDocument();
    expect(screen.queryByText('Request Visit')).not.toBeInTheDocument();
    // The holder's "You'll hear from us" timeline is built from the holder's
    // prefs; a contact's own choices live on their card (codex r6).
    expect(screen.queryByText("You'll hear from us")).not.toBeInTheDocument();
    expect(api.getNotificationPrefs).not.toHaveBeenCalled();
    expect(api.getPropertyNotificationPrefs).not.toHaveBeenCalled();
    // The holder's cards are gone; the contact's own card is up.
    expect(screen.queryByText('Reminder Settings')).not.toBeInTheDocument();
    expect(screen.queryByText('On-location contacts')).not.toBeInTheDocument();
    expect(await screen.findByTestId('contact-notification-card')).toBeInTheDocument();
  });

  it('a holder session renders the mutations and the holder cards, and no contact card', async () => {
    api.getNotificationPrefs.mockResolvedValue({ appointmentConfirmation: true });
    api.getPropertyNotificationPrefs.mockResolvedValue({ properties: [] });
    await renderSchedule(holderCustomer, { onRequestVisit: vi.fn() });
    expect(screen.getByRole('button', { name: /^confirm/i })).toBeInTheDocument();
    expect(screen.getByText('Reschedule')).toBeInTheDocument();
    expect(screen.getByText("You'll hear from us")).toBeInTheDocument();
    expect(api.getNotificationPrefs).toHaveBeenCalled();
    expect(api.getContactNotificationPrefs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('contact-notification-card')).not.toBeInTheDocument();
  });
});

describe('DocumentSection — contact session', () => {
  const sectionProps = {
    section: { id: 'service_report', label: 'Service Reports', icon: 'document' },
    emptyMessage: 'Nothing here yet',
    onDownload: vi.fn(), onShare: vi.fn(), onShareWithRealtor: vi.fn(), shareStatus: {},
    getExpirationBadge: () => null, formatDate: () => 'Jul 1, 2026', relativeTime: () => null, formatSize: () => null, compact: false,
  };
  const report = { id: 'auto_report_svc-1', title: 'Visit Report — Pest Control', documentType: 'service_report', viewUrl: '/report/tok', isAutoGenerated: true, linkedServiceRecordId: 'svc-1' };

  it('a contact can open a report but never shares it; the holder keeps Share', () => {
    const { unmount } = render(<DocumentSection {...sectionProps} customer={contactCustomer} items={[report]} />);
    expect(screen.getByRole('button', { name: /open visit report/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /share visit report/i })).not.toBeInTheDocument();
    unmount();
    render(<DocumentSection {...sectionProps} customer={holderCustomer} items={[report]} />);
    expect(screen.getByRole('button', { name: /share visit report/i })).toBeInTheDocument();
  });
});

describe('ContactNotificationCard', () => {
  it('shows the contact\'s effective choices; the holder\'s account-wide off is locked', async () => {
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    expect(screen.getByText(/Choose which updates reach you at \+19415550202/)).toBeInTheDocument();
    expect(screen.getByText('Turned off for this property by the account holder')).toBeInTheDocument();
    const reminder72 = screen.getByRole('switch', { name: '3-day reminder' });
    expect(reminder72).toBeDisabled();
    expect(reminder72).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('combobox', { name: 'Delivery method for 3-day reminder' })).toBeDisabled();
  });

  it('turning a purpose OFF saves without the consent statement', async () => {
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    fireEvent.click(screen.getByRole('switch', { name: 'On the way' }));
    await waitFor(() => expect(api.updateContactNotificationPrefs).toHaveBeenCalledWith({ techEnRoute: false }));
    expect(alerts.showCustomerAlert).not.toHaveBeenCalled();
  });

  it('turning texts ON needs the consent statement; ticking it records the attestation at once and the statement disappears', async () => {
    api.getContactNotificationPrefs.mockResolvedValue({ ...contactPrefs(), preferences: { ...contactPrefs().preferences, smsEnabled: false } });
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    fireEvent.click(screen.getByRole('switch', { name: 'Text messages' }));
    expect(api.updateContactNotificationPrefs).not.toHaveBeenCalled();
    expect(alerts.showCustomerAlert).toHaveBeenCalledWith(expect.stringMatching(/consent statement/i));
    // The pending opt-in text is mentioned in the statement.
    expect(screen.getByText(/agreeing here confirms it/i)).toBeInTheDocument();
    // The tick itself is the attestation (codex r2): recorded without waiting
    // for a preference change the already-on defaults may never make.
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api.updateContactNotificationPrefs).toHaveBeenCalledWith({ consentAttested: true }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
    // The card now shows the server's answer (texts on), and a later save
    // carries no second attestation.
    expect(screen.getByRole('switch', { name: 'Text messages' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'Text messages' }));
    await waitFor(() => expect(api.updateContactNotificationPrefs).toHaveBeenLastCalledWith({ smsEnabled: false }));
  });

  it('re-enabling an email-only purpose, or any purpose while texts are off, needs no consent statement (the effective text path does not open — codex r8)', async () => {
    const state = { ...contactPrefs(), preferences: { ...contactPrefs().preferences, techEnRoute: false, enRouteChannel: 'email', techArrived: false, smsEnabled: false } };
    api.getContactNotificationPrefs.mockResolvedValue(state);
    api.updateContactNotificationPrefs.mockImplementation(async (patch) => ({ ...state, preferences: { ...state.preferences, ...patch } }));
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    fireEvent.click(screen.getByRole('switch', { name: 'On the way' }));
    await waitFor(() => expect(api.updateContactNotificationPrefs).toHaveBeenCalledWith({ techEnRoute: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'On the way' })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('switch', { name: 'Technician arrival' }));
    await waitFor(() => expect(api.updateContactNotificationPrefs).toHaveBeenLastCalledWith({ techArrived: true }));
    expect(alerts.showCustomerAlert).not.toHaveBeenCalled();
  });

  it('a failed attestation un-ticks the statement and says so', async () => {
    api.updateContactNotificationPrefs.mockRejectedValueOnce(new Error('offline'));
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(alerts.showCustomerAlert).toHaveBeenCalledWith('offline'));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('the Email messages master switch writes emailEnabled, and is absent with no address on file', async () => {
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    fireEvent.click(screen.getByRole('switch', { name: 'Email messages' }));
    await waitFor(() => expect(api.updateContactNotificationPrefs).toHaveBeenCalledWith({ emailEnabled: false }));
    cleanup();
    api.getContactNotificationPrefs.mockResolvedValue({ ...contactPrefs(), emailAvailable: false });
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    expect(screen.queryByRole('switch', { name: 'Email messages' })).not.toBeInTheDocument();
  });

  it('a contact who replied STOP sees the START recovery note, and the statement never reads as texts switched back on (codex r3)', async () => {
    api.getContactNotificationPrefs.mockResolvedValue({ ...contactPrefs(), smsOptin: 'declined' });
    api.updateContactNotificationPrefs.mockImplementation(async (patch) => ({ ...contactPrefs(), smsOptin: 'declined', consentAttestedAt: patch.consentAttested ? '2026-10-20T00:00:00Z' : null }));
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    expect(screen.getByRole('status')).toHaveTextContent(/replied STOP.*text START/);
    expect(screen.getByText(/texts stay paused until you text START/i)).toBeInTheDocument();
    expect(screen.queryByText(/agreeing here confirms it/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
    // Attested, still paused: the note stays.
    expect(screen.getByRole('status')).toHaveTextContent(/replied STOP/);
  });

  it('a contact the report rule withholds from sees no Service reports row, and a note instead', async () => {
    api.getContactNotificationPrefs.mockResolvedValue({ ...contactPrefs(), reportsWithheld: true, emailAvailable: false });
    await renderSchedule(contactCustomer);
    await screen.findByTestId('contact-notification-card');
    expect(screen.queryByRole('switch', { name: 'Service reports' })).not.toBeInTheDocument();
    expect(screen.getByText('Service reports for this property go to the account holder.')).toBeInTheDocument();
    // No email on file: no Email delivery choice.
    const select = screen.getByRole('combobox', { name: 'Delivery method for On the way' });
    expect([...select.options].map((o) => o.value)).toEqual(['both', 'sms']);
  });

  it('a failed read offers a retry instead of a blank card', async () => {
    api.getContactNotificationPrefs.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(contactPrefs());
    await renderSchedule(contactCustomer);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    expect(await screen.findByTestId('contact-notification-card')).toBeInTheDocument();
  });
});
