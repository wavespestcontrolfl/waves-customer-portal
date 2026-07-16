// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/admin/AdminCommandHeader', () => ({
  default: ({ sections, activeKey, onSectionChange, ariaLabel }) => (
    <nav aria-label={ariaLabel}>
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
  });

  it('deep-links to the embedded Credentials workspace', () => {
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
    renderCompliance('/admin/compliance?source=settings');

    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));

    expect(screen.getByText('Embedded credentials workspace')).toBeInTheDocument();
    expect(screen.getByTestId('location-search')).toHaveTextContent(
      '?source=settings&tab=credentials',
    );
  });
});
