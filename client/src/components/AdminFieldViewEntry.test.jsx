// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminFieldViewEntry from './AdminFieldViewEntry';

const shellMounts = vi.fn();
function Shell() {
  React.useEffect(() => { shellMounts(); }, []);
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="shell">{location.pathname}</output><button type="button" onClick={() => navigate('/admin')}>Home</button></>;
}

function open(pathname, { fieldView = true, role = 'admin' } = {}) {
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'acct-1', role }));
  localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, fieldView }));
  return render(<MemoryRouter initialEntries={[pathname]}><Routes>
    <Route path="/admin" element={<AdminFieldViewEntry><Shell /></AdminFieldViewEntry>}>
      <Route path="*" element={null} />
    </Route>
  </Routes></MemoryRouter>);
}

afterEach(() => { cleanup(); localStorage.clear(); shellMounts.mockClear(); });

describe('AdminFieldViewEntry', () => {
  it('opens Today without ever mounting the shell at /admin', () => {
    open('/admin');
    expect(screen.getByTestId('shell')).toHaveTextContent('/admin/today');
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
  });
});
