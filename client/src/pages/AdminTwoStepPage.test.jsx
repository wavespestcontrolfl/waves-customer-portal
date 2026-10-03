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
