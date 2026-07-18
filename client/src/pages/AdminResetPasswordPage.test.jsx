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
import AdminResetPasswordPage from './AdminResetPasswordPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/reset-password']}>
      <Routes>
        <Route path="/admin/reset-password" element={<AdminResetPasswordPage />} />
        <Route path="/admin/settings" element={<div>Password reset complete</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminResetPasswordPage', () => {
  const token = 'A'.repeat(43);
  let store;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    vi.mocked(refetchFlags).mockResolvedValue({});
    window.history.replaceState({}, '', `/admin/reset-password#token=${token}`);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('scrubs the fragment credential and submits the captured one-time token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'new-staff-jwt',
        user: { id: 'admin-1', role: 'admin', mustChangePassword: false },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(window.location.hash).toBe('');
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Ocean-waves-are-7-feet' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Ocean-waves-are-7-feet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/auth/reset-password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token, newPassword: 'Ocean-waves-are-7-feet' }),
      }),
    ));
    expect(store.get('waves_admin_token')).toBe('new-staff-jwt');
    expect(await screen.findByText('Password reset complete')).toBeInTheDocument();
  });

  it('keeps submission disabled when the reset fragment is absent', () => {
    window.history.replaceState({}, '', '/admin/reset-password');
    renderPage();

    expect(screen.getByRole('button', { name: 'Reset password' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Request a new reset link' })).toBeInTheDocument();
  });

  it('rejects mismatched confirmation without sending the one-time token', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Ocean-waves-are-7-feet' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Different-waves-are-8-feet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a committed reset successful when flag refresh fails', async () => {
    vi.mocked(refetchFlags).mockRejectedValueOnce(new Error('flags unavailable'));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: 'new-staff-jwt',
        user: { id: 'admin-1', role: 'admin', mustChangePassword: false },
      }),
    })));

    renderPage();
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Ocean-waves-are-7-feet' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Ocean-waves-are-7-feet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Password reset complete')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('new-staff-jwt');
  });
});
