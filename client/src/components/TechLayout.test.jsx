// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useFeatureFlag', () => ({
  refetchFlags: vi.fn(async () => ({})),
  useFeatureFlagReady: vi.fn(() => ({ enabled: false, ready: true })),
}));

import { refetchFlags, useFeatureFlagReady } from '../hooks/useFeatureFlag';
import TechLayout from './TechLayout';
import TechNavigationLock from './tech/TechNavigationLock';

function LocationResult({ label }) {
  const location = useLocation();
  return <div>{`${label} ${location.pathname}${location.search}`}</div>;
}

function renderTech(initialPath = '/tech/protocols?day=monday') {
  return render(
    <TechNavigationLock><MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/tech" element={<TechLayout />}>
          <Route index element={<div>Protected field route</div>} />
          <Route path="protocols" element={<div>Protected field protocols</div>} />
          <Route path="more" element={<div>Protected field more</div>} />
          <Route path="documents" element={<div>Protected staff documents</div>} />
        </Route>
        <Route path="/admin/login" element={<LocationResult label="Staff login" />} />
        <Route path="/admin/change-password" element={<LocationResult label="Change password" />} />
        <Route path="*" element={<Outlet />} />
      </Routes>
    </MemoryRouter></TechNavigationLock>,
  );
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  };
}

describe('TechLayout staff-session verification', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(refetchFlags).mockResolvedValue({});
    vi.mocked(useFeatureFlagReady).mockReturnValue({ enabled: false, ready: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the light navigation only after verified staff access and an enabled workspace flag', async () => {
    localStorage.setItem('waves_admin_token', 'fixture-only');
    vi.mocked(useFeatureFlagReady).mockReturnValue({ enabled: true, ready: true });
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { id: 'tech-fixture', name: 'Fixture Tech', role: 'technician' })));
    renderTech('/tech');
    expect(await screen.findByText('Protected field route')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Field navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute('href', '/tech/tools');
    expect(screen.getByRole('link', { name: 'More' })).toHaveAttribute('href', '/tech/more');
    expect(screen.queryByText('Messages')).not.toBeInTheDocument();
  });

  it.each(['/tech?visit=row%3Atwo', '/TECH/?visit=row%3Atwo', '/TECH/PROTOCOLS/?visit=row%3Atwo'])('retains the unauthenticated sign-in destination %s', (path) => {
    renderTech(path);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText(`Staff login /admin/login?next=${encodeURIComponent(path)}`)).toBeInTheDocument();
  });

  it.each(['/tech/documents', '/tech/documents/', '/TECH/DOCUMENTS/'])('keeps controlled documents unavailable at %s inside the enabled field shell', async (path) => {
    localStorage.setItem('waves_admin_token', 'fixture-only');
    vi.mocked(useFeatureFlagReady).mockReturnValue({ enabled: true, ready: true });
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { id: 'tech-fixture', role: 'technician' })));
    renderTech(path);
    expect(await screen.findByText('Staff documents are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Protected staff documents')).not.toBeInTheDocument();
  });

  it.each([
    ['/tech/', 'Today', false], ['/TECH/', 'Today', false],
    ['/tech/more/', 'More', true], ['/TECH/MORE/', 'More', true],
    ['/TECH/PROTOCOLS/', 'Tools', true],
  ])('matches shell navigation and visit return state at %s', async (path, section, returnVisible) => {
    localStorage.setItem('waves_admin_token', 'fixture-only');
    vi.mocked(useFeatureFlagReady).mockReturnValue({ enabled: true, ready: true });
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { id: 'tech-fixture', role: 'technician' })));
    renderTech(`${path}?visit=row%3Atwo`);
    expect(await screen.findByRole('link', { name: section, exact: true })).toHaveAttribute('aria-current', 'page');
    expect(Boolean(screen.queryByRole('link', { name: 'Return to visit' }))).toBe(returnVisible);
  });

  it('holds the outlet until the workspace flag resolves', async () => {
    localStorage.setItem('waves_admin_token', 'fixture-only');
    vi.mocked(useFeatureFlagReady).mockReturnValue({ enabled: false, ready: false });
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { id: 'tech-fixture', name: 'Fixture Tech', role: 'technician' })));
    renderTech();
    expect(await screen.findByText('Loading field workspace…')).toBeInTheDocument();
    expect(screen.queryByText('Protected field protocols')).not.toBeInTheDocument();
  });

  it.each(['/TECH/DOCUMENTS', '/tech/documents/', '/TECH/DOCUMENTS/'])('keeps disabled documents unavailable at %s', async (path) => {
    localStorage.setItem('waves_admin_token', 'fixture-only');
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { id: 'tech-fixture', role: 'technician' })));
    renderTech(path);
    expect(await screen.findByText('Staff documents are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Protected staff documents')).not.toBeInTheDocument();
  });

  it('does not treat the retired adminToken storage key as a staff session', () => {
    localStorage.setItem('adminToken', 'legacy-untyped-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderTech();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Protected field protocols')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('does not render protected field content until /admin/auth/me verifies the token', async () => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    let finishRequest;
    const fetchMock = vi.fn(() => new Promise((resolve) => {
      finishRequest = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderTech();

    expect(screen.getByRole('status')).toHaveTextContent('Verifying staff access');
    expect(screen.queryByText('Protected field protocols')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/auth/me', expect.objectContaining({
      headers: { Authorization: 'Bearer staff-access-token' },
    }));

    await act(async () => {
      finishRequest(response(200, {
        id: 'tech-1',
        name: 'River Tech',
        email: 'river@example.com',
        role: 'technician',
        mustChangePassword: false,
      }));
    });

    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
    expect(screen.getByText('River Tech')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('waves_admin_user'))).toMatchObject({
      id: 'tech-1',
      role: 'technician',
    });
  });

  it('renders from the stored profile when /admin/auth/me gets no answer at all', async () => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-1', name: 'River Tech', role: 'technician' }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    renderTech();

    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
    expect(screen.getByText('River Tech')).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBe('staff-access-token');
  });

  it('falls back to the stored profile when the verification request hangs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      localStorage.setItem('waves_admin_token', 'staff-access-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-1', name: 'River Tech', role: 'technician' }));
      vi.stubGlobal('fetch', vi.fn((_url, options = {}) => new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })));

      renderTech();
      expect(screen.getByRole('status')).toHaveTextContent('Verifying staff access');
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });

      expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
      expect(screen.getByText('River Tech')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['the body read fails', () => Promise.reject(new TypeError('network error'))],
    ['the body is not JSON', () => Promise.reject(new SyntaxError('Unexpected token <'))],
  ])('treats a 2xx whose body never arrives as weak signal when %s', async (_label, body) => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-1', name: 'River Tech', role: 'technician' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: body })));

    renderTech();

    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBe('staff-access-token');
  });

  it('clears the saved route with the session on a 401', async () => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    localStorage.setItem('waves_tech_route_snapshot', JSON.stringify({ techId: 'tech-1' }));
    vi.stubGlobal('fetch', vi.fn(async () => response(401, { error: 'Session expired' })));

    renderTech();

    expect(await screen.findByText(/Staff login \/admin\/login\?next=/)).toBeInTheDocument();
    expect(localStorage.getItem('waves_tech_route_snapshot')).toBeNull();
  });

  it('still clears a rejected session when the 401 body times out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      localStorage.setItem('waves_admin_token', 'staff-access-token');
      localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-1', name: 'River Tech', role: 'technician' }));
      vi.stubGlobal('fetch', vi.fn(async (_url, options = {}) => ({
        ok: false, status: 401,
        json: () => new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
      })));

      renderTech();
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });

      expect(await screen.findByText(/Staff login \/admin\/login\?next=/)).toBeInTheDocument();
      expect(localStorage.getItem('waves_admin_token')).toBeNull();
      expect(localStorage.getItem('waves_admin_user')).toBeNull();
      expect(screen.queryByText('Protected field protocols')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a server error', () => response(503, { error: 'Unavailable' }), { id: 'tech-1', name: 'River Tech', role: 'technician' }],
    ['no stored profile', () => { throw new TypeError('Failed to fetch'); }, null],
    ['a stored profile with a non-staff role', () => { throw new TypeError('Failed to fetch'); }, { id: 'x', role: 'customer' }],
    ['a stored profile that still owes a password change', () => { throw new TypeError('Failed to fetch'); }, { id: 'tech-1', role: 'technician', mustChangePassword: true }],
  ])('keeps the verification error offline with %s', async (_label, respond, stored) => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    if (stored) localStorage.setItem('waves_admin_user', JSON.stringify(stored));
    vi.stubGlobal('fetch', vi.fn(async () => respond()));

    renderTech();

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to verify staff access');
    expect(screen.queryByText('Protected field protocols')).not.toBeInTheDocument();
  });

  it('clears invalid session state and sends a 401 to login with the field destination', async () => {
    localStorage.setItem('waves_admin_token', 'revoked-token');
    localStorage.setItem('adminToken', 'legacy-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-1' }));
    vi.stubGlobal('fetch', vi.fn(async () => response(401, {
      error: 'Session has been revoked',
    })));

    renderTech();

    expect(await screen.findByText(
      'Staff login /admin/login?next=%2Ftech%2Fprotocols%3Fday%3Dmonday',
    )).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBeNull();
    expect(localStorage.getItem('adminToken')).toBeNull();
    expect(localStorage.getItem('waves_admin_user')).toBeNull();
  });

  it('treats a malformed successful profile as invalid authentication', async () => {
    localStorage.setItem('waves_admin_token', 'invalid-profile-token');
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      role: 'technician',
    })));

    renderTech('/tech');

    expect(await screen.findByText(
      'Staff login /admin/login?next=%2Ftech',
    )).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBeNull();
  });

  it('takes over the full PWA identity — manifest, apple title, AND document title — and restores on unmount', async () => {
    // A tech signing in through /admin/login lands here after the admin
    // bookmark hook restored the customer identity; document.title must be
    // swapped by this layout (the restore runs first in effect order) and
    // must match the /tech SECTIONS title renderHTML serves on a cold load.
    document.head.innerHTML = `
      <link rel="manifest" href="/manifest.json">
      <meta name="apple-mobile-web-app-title" content="Waves">
    `;
    document.title = 'Waves Customer Portal';
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      id: 'tech-1',
      name: 'River Tech',
      email: 'river@example.com',
      role: 'technician',
      mustChangePassword: false,
    })));

    const view = renderTech('/tech');
    expect(await screen.findByText('Protected field route')).toBeInTheDocument();
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.tech.json',
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute('content', 'Field Tools');
    expect(document.title).toBe('Waves Tech');

    view.unmount();
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.json',
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute('content', 'Waves');
    expect(document.title).toBe('Waves Customer Portal');
  });

  it('routes a verified forced-rotation session to change password', async () => {
    localStorage.setItem('waves_admin_token', 'rotation-token');
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      id: 'tech-1',
      name: 'River Tech',
      email: 'river@example.com',
      role: 'technician',
      mustChangePassword: true,
    })));

    renderTech('/tech');

    expect(await screen.findByText(
      'Change password /admin/change-password',
    )).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBe('rotation-token');
    expect(screen.queryByText('Protected field route')).not.toBeInTheDocument();
  });

  it('renders the verified profile, not the stored one, when caching it fails', async () => {
    localStorage.setItem('waves_admin_token', 'fixture-new-login');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-old', name: 'Old Fixture', role: 'technician' }));
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { id: 'tech-new', name: 'New Fixture', role: 'technician' })));
    // A storage that is full: the profile cache write throws.
    const map = new Map([
      ['waves_admin_token', 'fixture-new-login'],
      ['waves_admin_user', JSON.stringify({ id: 'tech-old', name: 'Old Fixture', role: 'technician' })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => {
        if (key === 'waves_admin_user') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        map.set(key, String(value));
      },
      removeItem: (key) => { map.delete(key); },
      clear: () => map.clear(),
    });

    renderTech();

    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
    expect(screen.getAllByText(/New Fixture/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Old Fixture/)).not.toBeInTheDocument();
    // The stale profile cannot unlock a later offline reopen either.
    expect(map.has('waves_admin_user')).toBe(false);
  });

  it('ends the session when any staff call on the tech screens gets a 401 for this token', async () => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-1', role: 'technician' }));
    localStorage.setItem('waves_tech_route_snapshot', JSON.stringify({ techId: 'tech-1' }));
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/admin/auth/me')) return response(200, { id: 'tech-1', name: 'River Tech', role: 'technician' });
      if (/en-route|public/.test(String(url))) return response(401, { error: 'Session has been revoked', code: 'TOKEN_REVOKED' });
      return response(200, {});
    }));

    renderTech();
    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();

    // Another tab's login, then an unrelated public path: neither ends it.
    await act(async () => { await fetch('/api/tech/services/s1/en-route', { method: 'POST', headers: { Authorization: 'Bearer other-login' } }); });
    await act(async () => { await fetch('/api/public/thing', { headers: { Authorization: 'Bearer staff-access-token' } }); });
    expect(localStorage.getItem('waves_admin_token')).toBe('staff-access-token');

    await act(async () => { await fetch('/api/tech/services/s1/en-route', { method: 'POST', headers: { Authorization: 'Bearer staff-access-token' } }); });

    expect(await screen.findByText(/Staff login \/admin\/login\?next=/)).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBeNull();
    expect(localStorage.getItem('waves_admin_user')).toBeNull();
    expect(localStorage.getItem('waves_tech_route_snapshot')).toBeNull();
  });

  it('removes its fetch guard on unmount', async () => {
    localStorage.setItem('waves_admin_token', 'staff-access-token');
    const fetchMock = vi.fn(async () => response(200, { id: 'tech-1', role: 'technician' }));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderTech();
    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
    expect(globalThis.fetch).not.toBe(fetchMock);
    view.unmount();
    expect(globalThis.fetch).toBe(fetchMock);
  });

  it('ignores a verification answer that lands after another tab signed in, and checks the new login', async () => {
    localStorage.setItem('waves_admin_token', 'fixture-login-a');
    let answerA;
    const fetchMock = vi.fn((url, init) => {
      if (init?.headers?.Authorization === 'Bearer fixture-login-a') return new Promise((resolve) => { answerA = resolve; });
      if (String(url).includes('/admin/auth/me')) return Promise.resolve(response(200, { id: 'tech-b', name: 'Fixture B', role: 'technician' }));
      return Promise.resolve(response(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTech();
    await vi.waitFor(() => expect(answerA).toBeTypeOf('function'));
    localStorage.setItem('waves_admin_token', 'fixture-login-b');
    localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'tech-b', name: 'Fixture B', role: 'technician' }));
    await act(async () => { answerA(response(200, { id: 'tech-a', name: 'Fixture A', role: 'technician' })); });

    expect(await screen.findByText('Protected field protocols')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('waves_admin_user')).id).toBe('tech-b');
    expect(screen.queryByText(/Fixture A/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/admin/auth/me') && init?.headers?.Authorization === 'Bearer fixture-login-b')).toBe(true);
  });
});
