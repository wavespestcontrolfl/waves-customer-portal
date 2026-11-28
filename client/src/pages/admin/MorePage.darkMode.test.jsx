// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: () => false,
  refetchFlags: vi.fn(),
}));

import MorePage from './MorePage';
import { AdminNavigationProvider } from '../../hooks/useAdminNavigation';

function renderMore(role = 'admin') {
  return render(
    <MemoryRouter initialEntries={['/admin/more']}>
      <Routes>
        <Route element={<AdminNavigationProvider user={{ id: 'fixture', role }} enabled><Outlet context={{ user: { role } }} /></AdminNavigationProvider>}>
          <Route path="/admin/more" element={<MorePage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.adminTheme;
});

describe('MorePage — Dark mode switch', () => {
  it('renders for both admin and technician, off by default, and toggles data-admin-theme', () => {
    renderMore('technician');
    const techSwitch = screen.getByRole('switch', { name: 'Dark mode' });
    expect(techSwitch).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(techSwitch);
    expect(techSwitch).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.adminTheme).toBe('dark');
    expect(JSON.parse(localStorage.getItem('waves_admin_navigation:fixture')).darkMode).toBe(true);

    cleanup();
    renderMore('admin');
    const adminSwitch = screen.getByRole('switch', { name: 'Dark mode' });
    expect(adminSwitch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(adminSwitch);
    expect(adminSwitch).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.dataset.adminTheme).toBeUndefined();
  });

  it('notes when storage is full while still applying dark mode for the current session', () => {
    renderMore('admin');
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      fireEvent.click(screen.getByRole('switch', { name: 'Dark mode' }));
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(screen.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.adminTheme).toBe('dark');
    expect(screen.getByRole('status')).toHaveTextContent("Applied for now, but this device's storage is full or blocked.");
  });
});
