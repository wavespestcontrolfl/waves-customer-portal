// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../hooks/useFeatureFlag', () => ({
  refetchFlags: vi.fn(async () => ({})),
}));
// Sign in with Google is off unless a test turns it on; its status request
// would otherwise take the first reply each test queues.
vi.mock('../native/wavesAdminGoogleSignIn', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchGoogleSignInEnabled: vi.fn(async () => false),
}));

import AdminLoginPage from './AdminLoginPage';
import { fetchGoogleSignInEnabled } from '../native/wavesAdminGoogleSignIn';

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
      .mockResolvedValueOnce(reply(404, { error: 'Not found' })));
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
  it('a forced password change after a two-step sign-in keeps the session for the signed-in change page', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { mfaRequired: true, challengeToken: 'challenge-1' }))
      .mockResolvedValueOnce(reply(200, { token: 'jwt-mfa', user: { id: 'a', role: 'admin', mustChangePassword: true, email: 'owner@example.test' } })));
    render(
      <MemoryRouter initialEntries={['/admin/login']}>
        <Routes>
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/admin/change-password" element={<div>Change password page</div>} />
          <Route path="/admin/forgot-password" element={<div>Forgot password page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await submitPassword();
    fireEvent.click(await screen.findByRole('button', { name: 'Use a recovery code instead' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'AAAA-BBBB-CCCC-DDDD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Change password page')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('jwt-mfa');
  });
});

describe('AdminLoginPage Sign in with Google', () => {
  let store;
  const RESULT = 'r'.repeat(43);
  const SECRET = 's'.repeat(43);

  function renderAt(entry) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/admin" element={<div>Admin home</div>} />
          <Route path="/admin/customers" element={<div>Customers page</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    });
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(fetchGoogleSignInEnabled).mockResolvedValue(false);
    delete window.webkit;
  });

  it('shows the button only when the server says Google sign-in is on', async () => {
    renderAt('/admin/login');
    await waitFor(() => expect(fetchGoogleSignInEnabled).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();
    cleanup();
    vi.mocked(fetchGoogleSignInEnabled).mockResolvedValue(true);
    renderAt('/admin/login');
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('finishes the sign-in Google sent back and returns to the saved page', async () => {
    sessionStorage.setItem('waves_google_signin_secret', SECRET);
    sessionStorage.setItem('waves_google_signin_next', '/admin/customers');
    const fetchMock = vi.fn(async () => reply(200, { token: 'jwt-google', user: { id: 'a', role: 'admin' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt(`/admin/login#google_result=${RESULT}`);
    expect(await screen.findByText('Customers page')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('jwt-google');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/auth/google/finish', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ result: RESULT, verifier: SECRET });
    expect(sessionStorage.getItem('waves_google_signin_secret')).toBeNull();
  });

  it('asks for the authenticator code after Google for an enrolled account', async () => {
    sessionStorage.setItem('waves_google_signin_secret', SECRET);
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { mfaRequired: true, challengeToken: 'challenge-g' })));
    renderAt(`/admin/login#google_result=${RESULT}`);
    expect(await screen.findByLabelText('Authentication code')).toBeInTheDocument();
    expect(store.has('waves_admin_token')).toBe(false);
  });

  it('says why Google refused, and a page without the secret cannot finish', async () => {
    renderAt('/admin/login#google_error=not_allowed');
    expect(await screen.findByRole('alert')).toHaveTextContent('not linked to an active Waves staff account');
    cleanup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt(`/admin/login#google_result=${RESULT}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your Google sign-in expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inside Waves Admin 1.7 asks the app for Google and signs in with its answer', async () => {
    vi.mocked(fetchGoogleSignInEnabled).mockResolvedValue(true);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone) Mobile/15E148 WavesAdmin/1.7');
    const postMessage = vi.fn((message) => {
      setTimeout(() => window.dispatchEvent(new CustomEvent('wavesadmin:googlesignin', { detail: { result: RESULT } })), 0);
      return message;
    });
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage } } };
    const fetchMock = vi.fn(async () => reply(200, { token: 'jwt-app', user: { id: 'a', role: 'admin' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/admin/login');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByText('Admin home')).toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith({ type: 'googleSignIn', challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const { verifier } = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The server checks SHA-256(verifier), base64url, against the challenge.
    expect(postMessage.mock.calls[0][0].challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(store.get('waves_admin_token')).toBe('jwt-app');
  });

  it('hides the button in Waves Admin before 1.7, which has no Google step', async () => {
    vi.mocked(fetchGoogleSignInEnabled).mockResolvedValue(true);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone) Mobile/15E148 WavesAdmin/1.6');
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage: vi.fn() } } };
    vi.mocked(fetchGoogleSignInEnabled).mockClear();
    renderAt('/admin/login');
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument();
    expect(fetchGoogleSignInEnabled).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).not.toBeInTheDocument();
  });
});
