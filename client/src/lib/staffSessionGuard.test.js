import { describe, expect, it, vi } from 'vitest';
import { installStaffSessionGuard } from './staffSessionGuard';

const answer = (status) => vi.fn(async () => ({ status }));

describe('installStaffSessionGuard', () => {
  it('fires once per token and again for a later login', async () => {
    let token = 'login-a';
    const onRejected = vi.fn();
    const target = { fetch: answer(401) };
    installStaffSessionGuard({ getToken: () => token, onRejected, target });

    await target.fetch('/api/admin/thing', { headers: { Authorization: 'Bearer login-a' } });
    await target.fetch('/api/admin/thing', { headers: { Authorization: 'Bearer login-a' } });
    expect(onRejected).toHaveBeenCalledTimes(1);

    token = 'login-b';
    await target.fetch('/api/jobs/1/visual-moments', { headers: new Headers({ Authorization: 'Bearer login-b' }) });
    expect(onRejected).toHaveBeenCalledTimes(2);
  });

  it('ignores other tokens, other hosts and the terminal handoff check', async () => {
    const onRejected = vi.fn();
    const target = { fetch: answer(401) };
    installStaffSessionGuard({ getToken: () => 'login-a', onRejected, target });

    await target.fetch('/api/admin/thing', { headers: { Authorization: 'Bearer other' } });
    await target.fetch('https://elsewhere.example/x', { headers: { Authorization: 'Bearer login-a' } });
    await target.fetch('/api/stripe/terminal/validate-handoff', { method: 'POST', headers: { Authorization: 'Bearer login-a' } });
    expect(onRejected).not.toHaveBeenCalled();
  });
  it('a 403 MFA_ENROLLMENT_REQUIRED for the current token fires the enrollment hook once; other 403s do not', async () => {
    const onRejected = vi.fn();
    const onEnrollmentRequired = vi.fn();
    const make = (code) => ({ status: 403, clone: () => ({ json: async () => ({ code }) }) });
    const target = { fetch: vi.fn(async (url) => make(url.endsWith('/held') ? 'MFA_ENROLLMENT_REQUIRED' : 'TECHNICIAN_SCOPE')) };
    installStaffSessionGuard({ getToken: () => 'login-a', onRejected, onEnrollmentRequired, target });

    await target.fetch('/api/admin/other', { headers: { Authorization: 'Bearer login-a' } });
    await target.fetch('/api/admin/held', { headers: { Authorization: 'Bearer other' } });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(onEnrollmentRequired).not.toHaveBeenCalled();

    await target.fetch('/api/admin/held', { headers: { Authorization: 'Bearer login-a' } });
    await target.fetch('/api/admin/held', { headers: { Authorization: 'Bearer login-a' } });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(onEnrollmentRequired).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
  });
});
