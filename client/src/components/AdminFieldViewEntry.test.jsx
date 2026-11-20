// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminFieldViewEntry from './AdminFieldViewEntry';
import { saveStaffOfflinePass } from '../lib/adminAuth';

const shellMounts = vi.fn();
function Shell() {
  React.useEffect(() => { shellMounts(); }, []);
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-testid="shell">{location.pathname}</output>
    <output data-testid="landing">{String(location.state?.fieldViewLanding === true)}</output>
    <button type="button" onClick={() => navigate('/admin')}>Home</button>
  </>;
}

function staffJwt(exp = Math.floor(Date.now() / 1000) + 3600) {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'HS256' })}.${part({ exp })}.fixture-signature`;
}

// A device a verified check left signed in: the token, its offline pass and
// the login's saved switch.
function open(pathname, { fieldView = true, role = 'admin', token = staffJwt() } = {}) {
  localStorage.setItem('waves_admin_token', token);
  saveStaffOfflinePass(token, { id: 'acct-1', name: 'Fixture Admin', role });
  localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView }));
  return render(<MemoryRouter initialEntries={[pathname]}><Routes>
    <Route path="/admin" element={<AdminFieldViewEntry><Shell /></AdminFieldViewEntry>}>
      <Route path="*" element={null} />
    </Route>
  </Routes></MemoryRouter>);
}

afterEach(() => { cleanup(); localStorage.clear(); shellMounts.mockClear(); });

describe('AdminFieldViewEntry', () => {
  it('opens Today without ever mounting the shell at /admin, marked as a Field view landing', () => {
    open('/admin');
    expect(screen.getByTestId('shell')).toHaveTextContent('/admin/today');
    expect(screen.getByTestId('landing')).toHaveTextContent('true');
    expect(shellMounts).toHaveBeenCalledTimes(1);
  });
  it('does the same for /admin/', () => {
    open('/admin/');
    expect(screen.getByTestId('shell')).toHaveTextContent('/admin/today');
  });
  it('reads the switch as saved now: turned off since, a later /admin opens the shell', () => {
    open('/admin');
    expect(screen.getByTestId('shell')).toHaveTextContent('/admin/today');
    // The switch was turned off since; the shell's own index rule decides.
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByTestId('shell')).toHaveTextContent(/^\/admin$/);
    expect(shellMounts).toHaveBeenCalledTimes(1);
  });
  it('changes nothing with the switch off, for another role, or on another path', () => {
    open('/admin', { fieldView: false });
    expect(screen.getByTestId('shell')).toHaveTextContent(/^\/admin$/);
    cleanup();
    open('/admin', { role: 'technician' });
    expect(screen.getByTestId('shell')).toHaveTextContent(/^\/admin$/);
    cleanup();
    open('/admin/customers');
    expect(screen.getByTestId('shell')).toHaveTextContent('/admin/customers');
    expect(screen.getByTestId('landing')).toHaveTextContent('false');
  });
  // Pre-push P1: the shell must check an expired login at /admin, so the
  // sign-in it asks for returns there and the next login lands by its own switch.
  it('leaves /admin alone when the token has expired', () => {
    open('/admin', { token: staffJwt(Math.floor(Date.now() / 1000) - 60) });
    expect(screen.getByTestId('shell')).toHaveTextContent(/^\/admin$/);
  });
});
