// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useAdminNavigation, { AdminNavigationProvider } from './useAdminNavigation';

vi.mock('../lib/fieldView', async (importOriginal) => ({
  ...(await importOriginal()),
  warmFieldViewLanding: vi.fn(async () => true),
}));

let navigation;
function Probe() {
  navigation = useAdminNavigation();
  return null;
}

const mount = (user, { enabled = true } = {}) => render(
  <MemoryRouter>
    <AdminNavigationProvider user={user} enabled={enabled}>
      <Probe />
    </AdminNavigationProvider>
  </MemoryRouter>,
);

const saved = (id) => JSON.parse(localStorage.getItem(`waves_admin_navigation:${id}`) || 'null');

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.adminTheme;
  navigation = null;
});

describe('Admin dark mode preference', () => {
  it('defaults to off and leaves the document attribute unset', () => {
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.darkMode).toBe(false);
    expect(document.documentElement.dataset.adminTheme).toBeUndefined();
  });

  it('toggles data-admin-theme on documentElement and persists per account', () => {
    mount({ id: 'acct-1', role: 'admin' });
    act(() => { navigation.setDarkMode(true); });
    expect(navigation.darkMode).toBe(true);
    expect(document.documentElement.dataset.adminTheme).toBe('dark');
    expect(saved('acct-1')).toMatchObject({ darkMode: true, version: 2 });

    cleanup();
    expect(document.documentElement.dataset.adminTheme).toBeUndefined();

    mount({ id: 'acct-2', role: 'admin' });
    expect(navigation.darkMode).toBe(false);
    expect(document.documentElement.dataset.adminTheme).toBeUndefined();

    cleanup();
    mount({ id: 'acct-1', role: 'admin' });
    expect(navigation.darkMode).toBe(true);
    expect(document.documentElement.dataset.adminTheme).toBe('dark');
  });

  it('applies for technician logins as well as admins and respects enabled=false', () => {
    localStorage.setItem('waves_admin_navigation:tech-1', JSON.stringify({ version: 2, darkMode: true }));
    mount({ id: 'tech-1', role: 'technician' }, { enabled: false });
    expect(document.documentElement.dataset.adminTheme).toBeUndefined();

    cleanup();
    mount({ id: 'tech-1', role: 'technician' }, { enabled: true });
    expect(navigation.darkMode).toBe(true);
    expect(document.documentElement.dataset.adminTheme).toBe('dark');
  });

  it('syncs cross-tab storage events and cleans up when turned off', () => {
    mount({ id: 'acct-1', role: 'admin' });
    localStorage.setItem('waves_admin_navigation:acct-1', JSON.stringify({ version: 2, darkMode: true }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_admin_navigation:acct-1' }));
    });
    expect(navigation.darkMode).toBe(true);
    expect(document.documentElement.dataset.adminTheme).toBe('dark');

    act(() => { navigation.setDarkMode(false); });
    expect(navigation.darkMode).toBe(false);
    expect(document.documentElement.dataset.adminTheme).toBeUndefined();
    expect(saved('acct-1').darkMode).toBe(false);
  });

  it('still applies dark mode in-session when storage writes fail', () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    let result;
    try {
      mount({ id: 'acct-1', role: 'admin' });
      act(() => { result = navigation.setDarkMode(true); });
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(result).toBe(false);
    expect(navigation.darkMode).toBe(true);
    expect(document.documentElement.dataset.adminTheme).toBe('dark');
  });
});
