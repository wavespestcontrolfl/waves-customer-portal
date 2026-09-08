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

  it('retains a selected visit in the unauthenticated sign-in destination', () => {
    renderTech('/tech?visit=row%3Atwo');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Staff login /admin/login?next=%2Ftech%3Fvisit%3Drow%253Atwo')).toBeInTheDocument();
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
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/auth/me', {
      headers: { Authorization: 'Bearer staff-access-token' },
    });

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
});
