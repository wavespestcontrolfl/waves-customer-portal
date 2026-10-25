// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTab } from './TimeTrackingPage';

const json = (body, ok = true, status = ok ? 200 : 409) => ({ ok, status, json: vi.fn(async () => body) });

const PROSPECTIVE = {
  id: 'tech-p',
  name: 'Placeholder One',
  email: null,
  phone: '+19415550100',
  role: 'technician',
  active: false,
  employment_status: 'prospective',
  pay_rate: '20.00',
  job_title: 'Technician',
  hire_date: '2027-01-04T00:00:00.000Z',
};
const WAITING = {
  id: 'tech-w',
  name: 'Waiting Hire',
  email: 'waiting@example.test',
  role: 'technician',
  active: true,
  employment_status: 'active',
  hire_password_unset: true,
  hire_link_pending: false,
  hire_link_expires_at: null,
};
const SETTLED = {
  id: 'tech-s',
  name: 'Settled Tech',
  email: 'settled@example.test',
  role: 'technician',
  active: true,
  employment_status: 'active',
  hire_password_unset: false,
  hire_link_pending: false,
  hire_link_expires_at: null,
};

function stubApi({ live = true, technicians = [PROSPECTIVE, WAITING, SETTLED], onPost } = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    if (options.method === 'POST') return onPost ? onPost(url, options) : json({});
    return json(live ? { technicians, hiredPacketLive: true } : { technicians });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const posts = (fetchMock) => fetchMock.mock.calls.filter(([, options = {}]) => options.method === 'POST');

describe('TeamTab Hired button (GATE_HIRED_PACKET)', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gate off: no Hired button and no Resend link, whatever the rows say', async () => {
    stubApi({ live: false });
    render(<TeamTab showToast={vi.fn()} />);
    expect(await screen.findByText('Placeholder One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hired' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend link' })).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for first password')).not.toBeInTheDocument();
  });

  it('a non-admin never sees the buttons even if the flag arrives', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    stubApi();
    render(<TeamTab showToast={vi.fn()} />);
    expect(await screen.findByText('Placeholder One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hired' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend link' })).not.toBeInTheDocument();
  });

  it('shows Hired only on a prospective row and Resend link only where no password is set', async () => {
    stubApi();
    render(<TeamTab showToast={vi.fn()} />);
    await screen.findByText('Placeholder One');
    expect(screen.getAllByRole('button', { name: 'Hired' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Resend link' })).toHaveLength(1);
    expect(screen.getByText('Link expired or not sent')).toBeInTheDocument();
  });

  it('opens a prefilled dialog, requires email and first day, then hires and refreshes', async () => {
    const showToast = vi.fn();
    const fetchMock = stubApi({ onPost: async () => json({ hired: true, emailed: true }) });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hired' }));

    const dialog = await screen.findByRole('dialog', { name: 'Hire Placeholder One' });
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Placeholder One');
    expect(within(dialog).getByLabelText(/^Mobile phone/)).toHaveValue('+19415550100');
    expect(within(dialog).getByLabelText(/^First day/)).toHaveValue('2027-01-04');
    expect(within(dialog).getByLabelText(/^Pay rate/)).toHaveValue(20);
    expect(within(dialog).getByLabelText(/^Job title/)).toHaveValue('Technician');
    expect(within(dialog).getByLabelText(/^Email/)).toHaveValue('');

    // Email is empty: nothing is sent, and the dialog says why.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire and send link' }));
    expect(posts(fetchMock)).toHaveLength(0);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name, email and first day are required.');

    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: ' new.hire@example.test ' } });
    fireEvent.change(within(dialog).getByLabelText(/^Employment type/), { target: { value: 'w2' } });
    const listCallsBefore = fetchMock.mock.calls.filter(([, o = {}]) => !o.method).length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire and send link' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Welcome email sent to new.hire@example.test.'));
    const [[url, options]] = posts(fetchMock);
    expect(url).toBe('/api/admin/timetracking/technicians/tech-p/hire');
    expect(JSON.parse(options.body)).toEqual({
      name: 'Placeholder One',
      email: 'new.hire@example.test',
      phone: '+19415550100',
      hireDate: '2027-01-04',
      payRate: '20.00',
      jobTitle: 'Technician',
      employmentType: 'w2',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, o = {}]) => !o.method).length).toBeGreaterThan(listCallsBefore));
  });

  it.each([
    ['uncertain', 'Hired. The email may not have gone out. Use Resend link if it does not arrive.'],
    [false, 'Hired, but the email failed. Use Resend link.'],
  ])('toast when emailed is %s', async (emailed, message) => {
    const showToast = vi.fn();
    stubApi({ onPost: async () => json({ hired: true, emailed }) });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hired' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hire Placeholder One' });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: 'new.hire@example.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire and send link' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(message));
  });

  it('keeps the dialog open and shows the server reason when the hire is refused', async () => {
    const showToast = vi.fn();
    stubApi({ onPost: async () => json({ error: 'Email already in use' }, false, 409) });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hired' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hire Placeholder One' });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: 'taken@example.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire and send link' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Email already in use');
    expect(showToast).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Cancel closes the dialog without sending anything', async () => {
    const fetchMock = stubApi();
    render(<TeamTab showToast={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hired' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hire Placeholder One' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it('Resend link posts to the resend endpoint and toasts the result', async () => {
    const showToast = vi.fn();
    const fetchMock = stubApi({ onPost: async () => json({ resent: true, emailed: true }) });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Welcome email sent to waiting@example.test.'));
    expect(posts(fetchMock)).toHaveLength(1);
    expect(posts(fetchMock)[0][0]).toBe('/api/admin/timetracking/technicians/tech-w/hire/resend');
  });

  it('Resend link shows the server reason when it is refused', async () => {
    const showToast = vi.fn();
    stubApi({ onPost: async () => json({ error: 'A link was just sent. Try again in a minute.' }, false, 409) });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed: A link was just sent. Try again in a minute.'));
  });
});
