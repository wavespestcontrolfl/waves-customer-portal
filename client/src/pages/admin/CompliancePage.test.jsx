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

    fireEvent.click(screen.getByRole('button', { name: 'Application Log' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Application Log' }));
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
