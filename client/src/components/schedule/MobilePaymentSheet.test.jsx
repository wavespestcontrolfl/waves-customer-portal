// @vitest-environment jsdom

// Codex round (07-18, P2 on #2820): the server-side requireAdmin on
// POST /admin/invoices/:id/charge-card left the technician checkout UI
// rendering a tender that could only 403. The Card on File tender renders
// for admin-role users only; technician, corrupt, and missing profiles all
// fail closed to hidden.

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import MobilePaymentSheet from './MobilePaymentSheet';

function stubLocalStorage(entries) {
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => (key in entries ? entries[key] : null)),
  });
}

function renderSheet() {
  render(
    <MobilePaymentSheet
      desktopVisible
      service={{ id: 'svc-1' }}
      invoiceId="inv-1"
      amount={125}
    />,
  );
}

describe('MobilePaymentSheet Card on File role gate', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the Card on File tender for an admin-role user', () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u1', role: 'admin' }),
    });
    renderSheet();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Card on File')).toBeInTheDocument();
  });

  it('hides the tender for a technician-role user (server would 403)', () => {
    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: JSON.stringify({ id: 'u2', role: 'technician' }),
    });
    renderSheet();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
  });

  it('fails closed when the stored profile is missing or corrupt', () => {
    stubLocalStorage({ waves_admin_token: 'test-token' });
    renderSheet();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
    cleanup();

    stubLocalStorage({
      waves_admin_token: 'test-token',
      waves_admin_user: 'not-json{',
    });
    renderSheet();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.queryByText('Card on File')).not.toBeInTheDocument();
  });
});
