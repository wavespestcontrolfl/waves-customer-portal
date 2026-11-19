// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import AdminIndexRedirect from './AdminIndexRedirect';
import { AdminNavigationProvider } from '../hooks/useAdminNavigation';

function renderIndex(role, fieldView) {
  if (fieldView) localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: true }));
  return render(<MemoryRouter initialEntries={['/admin']}><Routes>
    <Route path="/admin" element={<AdminNavigationProvider user={{ id: 'acct-1', role }} enabled><Outlet context={{ user: { id: 'acct-1', role } }} /></AdminNavigationProvider>}>
      <Route index element={<AdminIndexRedirect />} />
      <Route path="today" element={<div>Today page</div>} />
      <Route path="dashboard" element={<div>Dashboard page</div>} />
    </Route>
  </Routes></MemoryRouter>);
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('AdminIndexRedirect', () => {
  it('opens the dashboard for an admin with Field view off', () => {
    renderIndex('admin', false);
    expect(screen.getByText('Dashboard page')).toBeInTheDocument();
  });
  it('opens Today for an admin with Field view on', () => {
    renderIndex('admin', true);
    expect(screen.getByText('Today page')).toBeInTheDocument();
  });
  it('opens Today for a technician', () => {
    renderIndex('technician', false);
    expect(screen.getByText('Today page')).toBeInTheDocument();
  });
  it('ignores a saved switch for a non-admin login other than the technician rule', () => {
    renderIndex('owner', true);
    expect(screen.getByText('Dashboard page')).toBeInTheDocument();
  });
});
