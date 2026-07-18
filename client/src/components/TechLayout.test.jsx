// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
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
}));

import { refetchFlags } from '../hooks/useFeatureFlag';
import TechLayout from './TechLayout';

function LocationResult({ label }) {
  const location = useLocation();
  return <div>{`${label} ${location.pathname}${location.search}`}</div>;
}

function renderTech(initialPath = '/tech/protocols?day=monday') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/tech" element={<TechLayout />}>
          <Route index element={<div>Protected field route</div>} />
          <Route path="protocols" element={<div>Protected field protocols</div>} />
        </Route>
        <Route path="/admin/login" element={<LocationResult label="Staff login" />} />
        <Route path="/admin/change-password" element={<LocationResult label="Change password" />} />
        <Route path="*" element={<Outlet />} />
      </Routes>
    </MemoryRouter>,
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
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
