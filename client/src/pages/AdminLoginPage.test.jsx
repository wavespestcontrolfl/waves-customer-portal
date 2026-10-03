// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useFeatureFlag', () => ({
  refetchFlags: vi.fn(async () => ({})),
}));

import AdminLoginPage from './AdminLoginPage';

function renderPage(entry = '/admin/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin" element={<div>Admin home</div>} />
        <Route path="/admin/two-step" element={<div>Two-step setup</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function submitPassword() {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'owner@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long staff password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
}

describe('AdminLoginPage two-step sign-in', () => {
  let store;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('signs in with the password alone when the server issues a session (gate off)', async () => {
    const fetchMock = vi.fn(async () => reply(200, { token: 'jwt', user: { id: 'a', role: 'admin' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await submitPassword();
    expect(await screen.findByText('Admin home')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for the authenticator code, stores no session until it passes, then signs in', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { mfaRequired: true, challengeToken: 'challenge-1' }))
      .mockResolvedValueOnce(reply(401, { error: 'That code did not work. Check your authenticator app and try again.', code: 'MFA_INVALID' }))
      .mockResolvedValueOnce(reply(200, { token: 'jwt-mfa', user: { id: 'a', role: 'admin', twoStep: { enabled: true, enrollmentRequired: false } } }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await submitPassword();

    const codeField = await screen.findByLabelText('Authentication code');
    expect(store.has('waves_admin_token')).toBe(false);
    fireEvent.change(codeField, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code did not work');
    expect(store.has('waves_admin_token')).toBe(false);

    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Admin home')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('jwt-mfa');
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toMatch(/\/admin\/auth\/login\/mfa$/);
    expect(JSON.parse(init.body)).toEqual({ challengeToken: 'challenge-1', code: '123456' });
  });

  it('accepts a recovery code instead', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { mfaRequired: true, challengeToken: 'challenge-1' }))
      .mockResolvedValueOnce(reply(200, { token: 'jwt-mfa', user: { id: 'a', role: 'admin' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await submitPassword();
    fireEvent.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Admin home')).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).code).toBe('abcd-efgh-ijkl-mnop');
  });

  it('an expired challenge sends the person back to the password step', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { mfaRequired: true, challengeToken: 'challenge-1' }))
      .mockResolvedValueOnce(reply(401, { error: 'Your sign-in expired. Enter your email and password again.', code: 'MFA_CHALLENGE_INVALID' })));
    renderPage();
    await submitPassword();
    fireEvent.change(await screen.findByLabelText('Authentication code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Your sign-in expired');
  });

  it('an admin who still owes enrollment goes straight to the two-step setup page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, {
      token: 'jwt', user: { id: 'a', role: 'admin', twoStep: { enabled: false, enrollmentRequired: true } },
    })));
    renderPage();
    await submitPassword();
    expect(await screen.findByText('Two-step setup')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('jwt');
  });
});
