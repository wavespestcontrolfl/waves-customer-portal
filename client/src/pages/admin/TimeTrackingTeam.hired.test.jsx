// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamTab } from './staff/TeamTab';

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
// A prospective row the server offers the Google press on: a linked company address that can sign in.
const LINKED = {
  ...PROSPECTIVE,
  email: 'applicant@example.test',
  google_email: 'new.hire@company.test',
  hire_action: 'hire',
  hire_login: 'google',
};
const SETTLED = {
  id: 'tech-s',
  name: 'Settled Tech',
  email: 'settled@example.test',
  role: 'technician',
  active: true,
  employment_status: 'active',
};

function stubApi({ technicians = [LINKED, SETTLED], onPost } = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    if (options.method === 'POST') return onPost ? onPost(url, options) : json({});
    return json({ technicians });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const posts = (fetchMock) => fetchMock.mock.calls.filter(([, options = {}]) => options.method === 'POST');

describe('TeamTab Hired button (Google press)', () => {
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

  it('a row with no hire_action (no usable Google address): no Hired button', async () => {
    stubApi({ technicians: [PROSPECTIVE, SETTLED] });
    render(<TeamTab showToast={vi.fn()} />);
    expect(await screen.findByText('Placeholder One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hired' })).not.toBeInTheDocument();
  });

  it('a non-admin sees no buttons: the server sends hire_action to admins only', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
    // What GET /technicians returns to a technician caller: no hire fields
    // (staff-hire-packet-postgres asserts the server side).
    stubApi({ technicians: [PROSPECTIVE, SETTLED] });
    render(<TeamTab showToast={vi.fn()} />);
    expect(await screen.findByText('Placeholder One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hired' })).not.toBeInTheDocument();
  });

  it('shows Hired only on the row the server offered it on', async () => {
    stubApi();
    render(<TeamTab showToast={vi.fn()} />);
    await screen.findByText('Placeholder One');
    expect(screen.getAllByRole('button', { name: 'Hired' })).toHaveLength(1);
  });

  it('opens a prefilled dialog that names the Google address, requires email and first day, then hires and refreshes', async () => {
    const showToast = vi.fn();
    const fetchMock = stubApi({
      technicians: [{ ...LINKED, email: null }],
      onPost: async () => json({ hired: true, emailed: null, login: 'google' }),
    });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hired' }));

    const dialog = await screen.findByRole('dialog', { name: 'Hire Placeholder One' });
    expect(dialog).toHaveTextContent('They sign in with Google as new.hire@company.test.');
    expect(dialog).toHaveTextContent('They get no password and no email is sent.');
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Placeholder One');
    expect(within(dialog).getByLabelText(/^Mobile phone/)).toHaveValue('+19415550100');
    expect(within(dialog).getByLabelText(/^First day/)).toHaveValue('2027-01-04');
    expect(within(dialog).getByLabelText(/^Pay rate/)).toHaveValue(20);
    expect(within(dialog).getByLabelText(/^Job title/)).toHaveValue('Technician');
    expect(within(dialog).getByLabelText(/^Email/)).toHaveValue('');

    // Email is empty: nothing is sent, and the dialog says why.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire with Google sign-in' }));
    expect(posts(fetchMock)).toHaveLength(0);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name, email and first day are required.');

    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: ' new.hire@example.test ' } });
    fireEvent.change(within(dialog).getByLabelText(/^Employment type/), { target: { value: 'w2' } });
    const listCallsBefore = fetchMock.mock.calls.filter(([, o = {}]) => !o.method).length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire with Google sign-in' }));

    await waitFor(() => expect(showToast)
      .toHaveBeenCalledWith('Hired. Placeholder One signs in with Google. No email was sent.'));
    const [[url, options]] = posts(fetchMock);
    expect(url).toBe('/api/admin/timetracking/technicians/tech-p/hire/google');
    expect(JSON.parse(options.body)).toEqual({
      name: 'Placeholder One',
      email: 'new.hire@example.test',
      phone: '+19415550100',
      hireDate: '2027-01-04',
      payRate: '20.00',
      jobTitle: 'Technician',
      employmentType: 'w2',
      googleEmail: 'new.hire@company.test',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, o = {}]) => !o.method).length).toBeGreaterThan(listCallsBefore));
  });

  it('a Google-only account shows how the person stands today and offers no Hired button', async () => {
    // The state comes from the server: with the Google gate off the row carries no google_email at all.
    const row = (id, name, state) => ({ ...SETTLED, id, name, hire_google_only: state });
    stubApi({
      technicians: [
        { ...row('tech-g', 'Google Hire', 'ready'), google_email: 'g.hire@company.test' },
        row('tech-u', 'Unlinked Hire', 'unlinked'),
        { ...row('tech-b', 'Outside Hire', 'bad_address'), google_email: 'b.hire@elsewhere.test' },
        row('tech-o', 'Off Hire', 'off'),
        // A prospective row past the press: the server sends no hire_action for it.
        { ...row('tech-r', 'Returning Hire', 'returning'), employment_status: 'prospective', active: false, hire_action: null },
      ],
    });
    render(<TeamTab showToast={vi.fn()} />);
    await screen.findByText('Google Hire');
    expect(screen.getByText('Signs in with Google')).toBeInTheDocument();
    expect(screen.getByText('No sign-in. Link a Google address.')).toBeInTheDocument();
    expect(screen.getByText('No sign-in. Link a company Google address.')).toBeInTheDocument();
    expect(screen.getByText('No sign-in. Staff Google sign-in is off or not set up.')).toBeInTheDocument();
    expect(screen.getByText('Google-only account. Turn it on from the edit form, or clear its Google sign-in first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hired' })).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the server reason when the hire is refused', async () => {
    const showToast = vi.fn();
    stubApi({ onPost: async () => json({ error: 'Email already in use' }, false, 409) });
    render(<TeamTab showToast={showToast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hired' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hire Placeholder One' });
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: 'taken@example.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hire with Google sign-in' }));
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
});
