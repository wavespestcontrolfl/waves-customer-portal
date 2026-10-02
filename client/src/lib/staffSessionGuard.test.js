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
});
