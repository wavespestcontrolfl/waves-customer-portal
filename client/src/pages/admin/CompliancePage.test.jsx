// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/admin/AdminCommandHeader', () => ({
  default: ({ sections, activeKey, onSectionChange, ariaLabel, variant }) => (
    <nav aria-label={ariaLabel} data-variant={variant}>
      {sections.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-current={activeKey === key ? 'page' : undefined}
          onClick={() => onSectionChange(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  ),
}));

vi.mock('./CredentialsPage', () => ({
  default: ({ embedded }) => (
    <div>{embedded ? 'Embedded credentials workspace' : 'Credentials page'}</div>
  ),
}));

import CompliancePage from './CompliancePage';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderCompliance(entry = '/admin/compliance') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/compliance"
          element={(
            <>
              <CompliancePage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CompliancePage Staff authentication', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the current Phase-B Staff token for dashboard requests', async () => {
    localStorage.setItem('waves_admin_token', 'phase-b-staff-token');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderCompliance();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers?.Authorization).toBe('Bearer phase-b-staff-token');
    }
    expect(screen.getByRole('navigation', { name: 'Compliance section' })).toHaveAttribute(
      'data-variant',
      'workspace',
    );
    expect(screen.getByRole('navigation', { name: 'Compliance section' }).closest('[data-ui-density]'))
      .toHaveAttribute('data-ui-density', 'comfortable');
  });

  it('deep-links to the embedded Credentials workspace', () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    renderCompliance('/admin/compliance?source=alert&tab=credentials');

    expect(screen.getByText('Embedded credentials workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Credentials' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('location-search')).toHaveTextContent(
      '?source=alert&tab=credentials',
    );
  });

  it('keeps tab selection in the URL without dropping other context', () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    renderCompliance('/admin/compliance?source=settings');

    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));

    expect(screen.getByText('Embedded credentials workspace')).toBeInTheDocument();
    expect(screen.getByTestId('location-search')).toHaveTextContent(
      '?source=settings&tab=credentials',
    );
  });

  it('hides the admin-only Credentials tab from technician accounts', () => {
    // /api/admin/credentials is requireAdmin while this page is
    // requireTechOrAdmin — techs must not be offered a 403-only workspace.
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'tech' }));
    renderCompliance('/admin/compliance?tab=credentials');

    expect(
      screen.queryByRole('button', { name: 'Credentials' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Embedded credentials workspace'),
    ).not.toBeInTheDocument();
    // The unrecognized deep-link falls back to the Dashboard tab.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('keeps application filters on the existing endpoint', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ applications: [], total: 0 }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderCompliance();

    fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
    fireEvent.change(screen.getByLabelText('Product name'), { target: { value: 'Synthetic product' } });

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => (
      String(url).includes('/api/admin/compliance-v2/applications?')
      && String(url).includes('productName=Synthetic+product')
      && String(url).includes('limit=25')
      && String(url).includes('offset=0')
    ))).toBe(true));
  });

  it('does not download an HTTP error as CSV and allows a successful retry', async () => {
    const createObjectURL = vi.fn(() => 'blob:synthetic-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let fail = true;
    const blob = new Blob(['Date,Product\n2035-01-01,Fixture'], { type: 'text/csv' });
    const readBlob = vi.fn(async () => blob);
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('/report/export')
      ? { ok: !fail, status: fail ? 503 : 200, blob: readBlob }
      : { ok: true, json: async () => ({ applications: [], total: 0 }) }));
    renderCompliance('/admin/compliance?tab=applications');
    fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export for DACS' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed (HTTP 503)');
    expect(readBlob).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Export for DACS' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-export');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('edits a license in the shared dialog with the existing payload', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    const technician = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Fixture technician',
      license: 'OLD-1',
      licenseExpiry: '2027-02-01',
      licenseCategories: ['General Household Pest'],
      licenseStatus: 'active',
    };
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).endsWith('/licenses') ? { technicians: [technician] } : {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderCompliance('/admin/compliance?tab=licenses');

    await screen.findByText('Fixture technician');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit license' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('License #'), { target: { value: 'NEW-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/compliance-v2/licenses/11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          fl_applicator_license: 'NEW-2',
          license_expiry: '2027-02-01',
          license_categories: ['General Household Pest'],
        }),
      }),
    ));
    // Gate off (no idCard block from the server): no training column or buttons, no new request.
    expect(screen.queryByText('ID card and training')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Training log' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('training'))).toBe(true);
  });

  // GATE_TECH_TRAINING_DATES (dark): the server adds the blocks only for a technician with a hire date.
  describe('ID card and training dates', () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const employee = {
      id: ID,
      name: 'Fixture employee',
      license: null,
      licenseExpiry: '2027-06-30',
      licenseCategories: null,
      licenseStatus: 'none',
      training: { days: 2, hours: 16, categories: ['GHP'], fiveDaysDone: false, fortyHoursDone: false },
      idCard: { appliedOn: null, applicationDueOn: '2026-10-31', issuedOn: null, status: 'overdue' },
      classroom: { dueOn: null, doneOn: null, status: null },
      renewalTraining: { dueBy: '2027-06-30', doneOn: null, status: 'due' },
    };
    const owner = { id: '22222222-2222-4222-8222-222222222222', name: 'Fixture owner', license: null, licenseExpiry: null, licenseCategories: null, licenseStatus: 'none' };

    function stubFetch(extra = () => null) {
      const fetchMock = vi.fn(async (url, init = {}) => {
        const made = extra(String(url), init);
        if (made) return made;
        return { ok: true, json: async () => (String(url).endsWith('/licenses') ? { technicians: [employee, owner] } : {}) };
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('shows the dates and statuses for an employee only, and sends the four dates with the edit', async () => {
      localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
      const fetchMock = stubFetch();
      renderCompliance('/admin/compliance?tab=licenses');

      await screen.findByText('Fixture employee');
      expect(screen.getByText('ID card and training')).toBeInTheDocument();
      expect(screen.getByText(/apply by/)).toBeInTheDocument();
      expect(screen.getByText('overdue')).toBeInTheDocument();
      expect(screen.getByText('5-day check open')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Training log' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Print record' })).toHaveLength(1);

      fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
      fireEvent.change(screen.getByLabelText('ID card applied'), { target: { value: '2026-10-28' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/compliance-v2/licenses/${ID}`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            fl_applicator_license: '', license_expiry: '2027-06-30', license_categories: [],
            id_card_applied_on: '2026-10-28', id_card_issued_on: '', classroom_hours_done_on: '', renewal_training_done_on: '',
          }),
        }),
      ));
    });

    it('adds a training day from the log and removes one', async () => {
      localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
      const days = [{ id: 'd1', trainingDate: '2026-10-02', hours: 8, category: 'GHP', topics: 'Label reading', trainerName: 'Fixture operator', materials: null }];
      const fetchMock = stubFetch((url, init) => {
        if (!url.endsWith('/training-days') && !url.includes('/training-days/')) return null;
        if (init.method === 'POST' || init.method === 'DELETE') return { ok: true, json: async () => ({ success: true }) };
        return { ok: true, json: async () => ({ days, summary: { days: 1, hours: 8, categories: ['GHP'], fiveDaysDone: false, fortyHoursDone: false } }) };
      });
      renderCompliance('/admin/compliance?tab=licenses');

      await screen.findByText('Fixture employee');
      fireEvent.click(screen.getByRole('button', { name: 'Training log' }));
      await screen.findByText('Label reading');
      expect(screen.getByText(/1 day, 8 of 40 hours/)).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: '2026-10-03' } });
      fireEvent.change(screen.getByLabelText(/^Topics covered/), { target: { value: 'Termite biology' } });
      fireEvent.change(screen.getByLabelText(/^Trainer/), { target: { value: 'Fixture operator' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add day' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/compliance-v2/licenses/${ID}/training-days`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ training_date: '2026-10-03', hours: 8, category: 'GHP', topics: 'Termite biology', trainer_name: 'Fixture operator', materials: null }),
        }),
      ));

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/compliance-v2/licenses/${ID}/training-days/d1`,
        expect.objectContaining({ method: 'DELETE' }),
      ));
    });

    it('shows the printable record heading and prints it with the typed syllabus note, escaped', async () => {
      localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
      const record = {
        heading: 'Initial five-day (40-hour) pesticide applicator employee training record',
        authority: 'Rule 5E-14.1421, Florida Administrative Code; F.S. 482.091(3)',
        retention: 'Keep this record for 2 years.',
        technician: { id: ID, name: 'Fixture employee', hireDate: '2026-10-01' },
        days: [{ id: 'd1', trainingDate: '2026-10-02', hours: 8, category: 'GHP', topics: 'Label <b>reading</b>', trainerName: 'Fixture operator', materials: null }],
        totals: { days: 1, hours: 8, categories: ['GHP'], fiveDaysDone: false, fortyHoursDone: false },
        signatures: [{ role: 'Certified operator in charge', lines: ['Printed name', 'Signature'] }],
      };
      stubFetch((url) => (url.endsWith('/training-record') ? { ok: true, json: async () => record } : null));
      const written = [];
      const print = vi.fn();
      vi.stubGlobal('open', vi.fn(() => ({ document: { open: vi.fn(), write: (html) => written.push(html), close: vi.fn() }, focus: vi.fn(), print })));
      renderCompliance('/admin/compliance?tab=licenses');

      await screen.findByText('Fixture employee');
      fireEvent.click(screen.getByRole('button', { name: 'Print record' }));
      await screen.findByText(record.heading);
      fireEvent.change(screen.getByLabelText(/^Course syllabus/), { target: { value: 'Syllabus <script>x</script>' } });
      fireEvent.click(screen.getByRole('button', { name: 'Print' }));
      expect(print).toHaveBeenCalledOnce();
      const html = written.join('');
      expect(html).toContain('Rule 5E-14.1421');
      expect(html).toContain('Label &lt;b&gt;reading&lt;/b&gt;');
      expect(html).toContain('Syllabus &lt;script&gt;x&lt;/script&gt;');
      expect(html).toContain('Certified operator in charge');
      expect(html).not.toContain('<script>');
    });
  });
});

// UI audit F0406: a failed dashboard load is an error with a retry, never a
// perpetual "Loading dashboard…" and never a blank dashboard of dashes.
describe('CompliancePage dashboard failure states', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'test-token');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the error copy and a Retry control when the dashboard request returns 500', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/dashboard')) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCompliance();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the dashboard — HTTP 500/);
    expect(screen.queryByText('Loading dashboard…')).not.toBeInTheDocument();
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes('/dashboard')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(([u]) => String(u).includes('/dashboard')).length;
      expect(after).toBe(before + 1);
    });
  });

  it('renders the error copy when the dashboard request rejects (network)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/dashboard')) throw new Error('Failed to fetch');
      return { ok: true, json: async () => ({}) };
    }));
    renderCompliance();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to fetch/);
    expect(screen.queryByText('Loading dashboard…')).not.toBeInTheDocument();
  });
});
