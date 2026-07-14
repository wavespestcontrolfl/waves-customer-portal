// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useFeatureFlag', () => ({
  refetchFlags: vi.fn(async () => ({})),
}));

import { refetchFlags } from '../hooks/useFeatureFlag';
import AdminChangePasswordPage from './AdminChangePasswordPage';
import AdminForgotPasswordPage from './AdminForgotPasswordPage';
import AdminLoginPage from './AdminLoginPage';

function renderRoutes(initialPath, page) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin/login" element={page} />
        <Route path="/admin/change-password" element={page} />
        <Route path="/admin/forgot-password" element={<AdminForgotPasswordPage />} />
        <Route path="/tech" element={<div>Field tools home</div>} />
        <Route path="/tech/*" element={<div>Field tools destination</div>} />
        <Route path="/admin" element={<div>Admin home</div>} />
        <Route path="/admin/settings" element={<div>Admin settings</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillLogin(email = 'tech@example.com') {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'correct horse battery staple' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
}

describe('staff authentication destinations', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(refetchFlags).mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends a technician to Field Tools after an ordinary staff login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'tech-jwt',
        user: { id: 'tech-1', email: 'tech@example.com', role: 'technician' },
      }),
    })));

    renderRoutes('/admin/login', <AdminLoginPage />);
    fillLogin();

    expect(await screen.findByText('Field tools home')).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBe('tech-jwt');
  });

  it('keeps a committed login successful when flag refresh fails', async () => {
    vi.mocked(refetchFlags).mockRejectedValueOnce(new Error('flags unavailable'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'tech-jwt',
        user: { id: 'tech-1', email: 'tech@example.com', role: 'technician' },
      }),
    })));

    renderRoutes('/admin/login', <AdminLoginPage />);
    fillLogin();

    expect(await screen.findByText('Field tools home')).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBe('tech-jwt');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not honor an admin return target for a technician', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'tech-jwt',
        user: { id: 'tech-1', email: 'tech@example.com', role: 'technician' },
      }),
    })));

    renderRoutes('/admin/login?next=/admin/settings', <AdminLoginPage />);
    fillLogin();

    expect(await screen.findByText('Field tools home')).toBeInTheDocument();
    expect(screen.queryByText('Admin settings')).not.toBeInTheDocument();
  });

  it('routes a required rotation to the reset request without retaining a session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'rotation-only-jwt',
        user: {
          id: 'tech-1',
          email: 'tech@example.com',
          role: 'technician',
          mustChangePassword: true,
        },
      }),
    })));

    renderRoutes('/admin/login', <AdminLoginPage />);
    fillLogin();

    expect(await screen.findByRole('heading', { name: 'Reset required' })).toBeInTheDocument();
    expect(screen.getByLabelText('Staff email address')).toHaveValue('tech@example.com');
    expect(localStorage.getItem('waves_admin_token')).toBeNull();
    expect(localStorage.getItem('waves_admin_user')).toBeNull();
  });

  it('still routes a required reset when flag refresh fails', async () => {
    vi.mocked(refetchFlags).mockRejectedValueOnce(new Error('flags unavailable'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'rotation-only-jwt',
        user: {
          id: 'tech-1',
          email: 'tech@example.com',
          role: 'technician',
          mustChangePassword: true,
        },
      }),
    })));

    renderRoutes('/admin/login', <AdminLoginPage />);
    fillLogin();

    expect(await screen.findByRole('heading', { name: 'Reset required' })).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends a technician to Field Tools after changing a password', async () => {
    localStorage.setItem('waves_admin_token', 'old-tech-jwt');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'new-tech-jwt',
        user: { id: 'tech-1', role: 'technician' },
      }),
    })));

    renderRoutes('/admin/change-password', <AdminChangePasswordPage />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password-value' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'New-password-value-123!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'New-password-value-123!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(screen.getByText('Field tools home')).toBeInTheDocument());
    expect(localStorage.getItem('waves_admin_token')).toBe('new-tech-jwt');
  });

  it('keeps a committed password change successful when flag refresh fails', async () => {
    localStorage.setItem('waves_admin_token', 'old-tech-jwt');
    vi.mocked(refetchFlags).mockRejectedValueOnce(new Error('flags unavailable'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'new-tech-jwt',
        user: { id: 'tech-1', role: 'technician' },
      }),
    })));

    renderRoutes('/admin/change-password', <AdminChangePasswordPage />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password-value' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'New-password-value-123!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'New-password-value-123!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText('Field tools home')).toBeInTheDocument();
    expect(localStorage.getItem('waves_admin_token')).toBe('new-tech-jwt');
  });
});
