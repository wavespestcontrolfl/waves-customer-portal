// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/useFeatureFlag', () => ({
  refetchFlags: vi.fn(async () => ({})),
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') },
}));

import AdminTwoStepPage from './AdminTwoStepPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/two-step']}>
      <Routes>
        <Route path="/admin/two-step" element={<AdminTwoStepPage />} />
        <Route path="/admin" element={<div>Admin home</div>} />
        <Route path="/admin/login" element={<div>Sign in page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('AdminTwoStepPage', () => {
  let store;

  beforeEach(() => {
    store = new Map([['waves_admin_token', 'old-jwt']]);
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

  it('walks a held admin through password → QR + key → code → recovery codes → signed in', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: true, enforced: true, recoveryCodesRemaining: 0 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', expiresInMinutes: 15 }))
      .mockResolvedValueOnce(reply(200, {
        token: 'new-jwt',
        user: { id: 'a', role: 'admin', twoStep: { enabled: true, enrollmentRequired: false } },
        recoveryCodes: ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'],
      }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    expect(await screen.findByText('Your account needs two-step sign-in before Waves Admin opens.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'my password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByAltText('QR code for your authenticator app')).toHaveAttribute('src', 'data:image/png;base64,QR');
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));

    expect(await screen.findByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('new-jwt');
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I saved these codes'));
    fireEvent.click(done);
    expect(await screen.findByText('Admin home')).toBeInTheDocument();

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ currentPassword: 'my password' });
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/admin\/auth\/mfa\/totp\/confirm$/);
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer old-jwt');
  });

  it('says so when the gate is off (the routes answer 404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404, { error: 'Not found' })));
    renderPage();
    expect(await screen.findByText('Two-step sign-in is not turned on for Waves yet.')).toBeInTheDocument();
  });

  it('an enrolled, enforced admin sees no turn-off form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: true, recoveryCodesRemaining: 7 })));
    renderPage();
    expect(await screen.findByText('Two-step sign-in is on')).toBeInTheDocument();
    expect(screen.getByText(/7 unused recovery codes left/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off two-step sign-in' })).not.toBeInTheDocument();
  });

  it('a confirmation that finishes after another tab signed out does not bring the old session back', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 0 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 }))
      .mockImplementationOnce(async () => {
        store.delete('waves_admin_token');
        return reply(200, { token: 'new-jwt', user: { id: 'a', role: 'admin' }, recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] });
      }));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    expect(await screen.findByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
    expect(store.has('waves_admin_token')).toBe(false);
  });

  it('a 401 for a token another tab already replaced keeps the newer session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      store.set('waves_admin_token', 'newer-jwt-from-another-tab');
      return reply(401, { error: 'Session has been revoked', code: 'TOKEN_REVOKED' });
    }));
    renderPage();
    expect(await screen.findByText('You signed in again in another tab. Try that once more.')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('newer-jwt-from-another-tab');
    expect(screen.queryByText('Sign in page')).not.toBeInTheDocument();
  });

  it('turning it off continues this session on the fresh token', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 9 }))
      .mockResolvedValueOnce(reply(200, { ok: true, token: 'after-off-jwt', user: { id: 'a', role: 'admin' } }))
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Code from your authenticator', { selector: '#two-step-off-code' }), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off two-step sign-in' }));
    expect(await screen.findByText('Set up two-step sign-in')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('after-off-jwt');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer after-off-jwt');
  });

  it('another tab signing out mid-enrollment still shows the one-time codes, then leaves on Done', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 0 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 }))
      .mockImplementationOnce(async () => {
        // The other tab reacts to the committed change before this answer lands.
        store.delete('waves_admin_token');
        window.dispatchEvent(new StorageEvent('storage', { key: 'waves_admin_token' }));
        return reply(200, { token: 'new-jwt', user: { id: 'a', role: 'admin' }, recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] });
      }));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    expect(await screen.findByText('AAAA-BBBB-CCCC-DDDD')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('I saved these codes'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
  });

  it('when the recovery-code window has closed, replacing asks for a code again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: true, recoveryCodesRemaining: 0, replaceWithoutCode: true }))
      .mockResolvedValueOnce(reply(400, { error: 'Enter a code from your current authenticator app to replace it.' }))
      .mockResolvedValueOnce(reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: true, recoveryCodesRemaining: 0, replaceWithoutCode: false }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace authenticator (new phone)' }));
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Code from your current authenticator')).toBeInTheDocument();
  });

  it('a recovery code spent to replace the authenticator keeps a retry window on this session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: true, recoveryCodesRemaining: 1 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15, token: 'recovery-window-jwt', replaceWithoutCode: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace authenticator (new phone)' }));
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Code from your current authenticator'), { target: { value: 'AAAA-BBBB-CCCC-DDDD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Code from the app')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('recovery-window-jwt');
    // Cancel back to the setup form: no current code is asked for now.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace authenticator (new phone)' }));
    expect(screen.queryByLabelText('Code from your current authenticator')).not.toBeInTheDocument();
  });

  it('another tab signing out ends this page at once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 9 })));
    renderPage();
    expect(await screen.findByText('Two-step sign-in is on')).toBeInTheDocument();
    store.delete('waves_admin_token');
    window.dispatchEvent(new StorageEvent('storage', { key: 'waves_admin_token' }));
    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
  });

  it('cancelling a first setup from the QR step keeps a way back to Settings', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 0 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 })));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toBeInTheDocument();
  });

  it('a revoked session goes back to sign in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'Two-step sign-in required. Sign in again.', code: 'MFA_REQUIRED' })));
    renderPage();
    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
    expect(store.has('waves_admin_token')).toBe(false);
  });
  it('a mistyped code during setup stays on the QR step with an inline error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 0 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 }))
      .mockResolvedValueOnce(reply(400, { error: 'That code did not work. Check your authenticator app and try again.', code: 'MFA_INVALID' })));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code did not work');
    expect(screen.getByAltText('QR code for your authenticator app')).toBeInTheDocument();
    expect(store.get('waves_admin_token')).toBe('old-jwt');
  });
  it('an expired setup goes back to the password step and says why', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: false, enrollmentRequired: false, enforced: false, recoveryCodesRemaining: 0 }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 }))
      .mockResolvedValueOnce(reply(409, { error: 'This setup expired. Start again to get a new QR code.', code: 'MFA_SETUP_EXPIRED' })));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This setup expired');
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('right after a recovery-code sign-in, replacing the authenticator asks for the password only', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(200, { available: true, enabled: true, enrollmentRequired: false, enforced: true, recoveryCodesRemaining: 0, replaceWithoutCode: true }))
      .mockResolvedValueOnce(reply(200, { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x', expiresInMinutes: 15 }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace authenticator (new phone)' }));
    expect(screen.queryByLabelText('Code from your current authenticator')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Code from the app')).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ currentPassword: 'pw' });
  });
});
