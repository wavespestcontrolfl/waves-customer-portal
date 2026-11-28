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

  it('keeps dark mode active across admin route transitions while re-verifying and clears it when leaving admin', () => {
    window.history.pushState({}, '', '/admin/dashboard');
    try {
      mount({ id: 'acct-1', role: 'admin' });
      act(() => { navigation.setDarkMode(true); });
      expect(document.documentElement.dataset.adminTheme).toBe('dark');

      // Navigating within /admin remounts with enabled=false before /admin/auth/me resolves
      cleanup();
      window.history.pushState({}, '', '/admin/customers');
      expect(document.documentElement.dataset.adminTheme).toBe('dark');
      mount(null, { enabled: false });
      expect(document.documentElement.dataset.adminTheme).toBe('dark');

      // Leaving /admin clears data-admin-theme
      cleanup();
      window.history.pushState({}, '', '/');
      mount({ id: 'acct-1', role: 'admin' }, { enabled: true });
      cleanup();
      expect(document.documentElement.dataset.adminTheme).toBeUndefined();

      // Logging out or opening standalone /admin/login or /admin/two-step clears data-admin-theme
      for (const standalonePath of ['/admin/login', '/admin/two-step']) {
        window.history.pushState({}, '', '/admin/dashboard');
        mount({ id: 'acct-1', role: 'admin' }, { enabled: true });
        expect(document.documentElement.dataset.adminTheme).toBe('dark');
        window.history.pushState({}, '', standalonePath);
        cleanup();
        expect(document.documentElement.dataset.adminTheme).toBeUndefined();
      }
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('still applies dark mode in-session across provider remounts when storage writes fail', () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    let result;
    try {
      mount({ id: 'acct-unsaved-1', role: 'admin' });
      act(() => { result = navigation.setDarkMode(true); });
      expect(result).toBe(false);
      expect(navigation.darkMode).toBe(true);
      expect(document.documentElement.dataset.adminTheme).toBe('dark');

      // Simulate route navigation remounting AdminNavigationProvider with storage still blocked
      cleanup();
      expect(document.documentElement.dataset.adminTheme).toBeUndefined();
      mount({ id: 'acct-unsaved-1', role: 'admin' });
      expect(navigation.darkMode).toBe(true);
      expect(document.documentElement.dataset.adminTheme).toBe('dark');

      // Toggling another preference (like a menu group) after remount keeps unsaved dark mode
      act(() => { navigation.toggleGroup(navigation.groups[0].id); });
      expect(navigation.darkMode).toBe(true);
      expect(document.documentElement.dataset.adminTheme).toBe('dark');

      // Does not leak to a different account
      cleanup();
      mount({ id: 'acct-unsaved-2', role: 'admin' });
      expect(navigation.darkMode).toBe(false);
      expect(document.documentElement.dataset.adminTheme).toBeUndefined();
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});
