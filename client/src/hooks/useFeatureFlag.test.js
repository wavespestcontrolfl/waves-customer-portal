// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

// A login switch refetches flags while the previous user's read is still in
// flight: whichever answers last, only the new user's flags become the cache.
it('never lets a superseded flag read overwrite the new login\'s flags', async () => {
  const pending = [];
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((resolve, reject) => {
    pending.push({ resolve, init });
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })));
  const flagsBody = (flags) => ({ ok: true, status: 200, json: async () => ({ flags }) });
  const { refetchFlags } = await import('./useFeatureFlag');

  localStorage.setItem('waves_admin_token', 'login-a');
  const first = refetchFlags();
  localStorage.setItem('waves_admin_token', 'login-b');
  const second = refetchFlags();

  // The superseded read was aborted; even if its answer still lands, it loses.
  expect(pending[0].init.signal.aborted).toBe(true);
  pending[0].resolve(flagsBody({ 'tech-field-workspace': true }));
  pending[1].resolve(flagsBody({ 'tech-field-workspace': false }));

  await expect(second).resolves.toEqual({ 'tech-field-workspace': false });
  await expect(first).resolves.toEqual({ 'tech-field-workspace': false });
});

it('resolves to no flags, without a network read, when nobody is signed in', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const { refetchFlags } = await import('./useFeatureFlag');

  await expect(refetchFlags()).resolves.toEqual({});
  expect(fetchMock).not.toHaveBeenCalled();
});

// A long-lived shell keeps its hook mounted across a login switch: with a
// refreshKey (the verified account) it re-reads the refetched flags.
it('useFeatureFlagReady re-reads when its refreshKey changes after refetchFlags', async () => {
  const React = await import('react');
  const { render, screen, act, cleanup } = await import('@testing-library/react');
  localStorage.setItem('waves_admin_token', 'fixture-only');
  let answer = { 'tech-field-workspace': true };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flags: answer }) })));
  const mod = await import('./useFeatureFlag');
  function Probe({ who }) {
    const { enabled, ready } = mod.useFeatureFlagReady('tech-field-workspace', false, who);
    return React.createElement('output', null, `${who}:${ready}:${enabled}`);
  }
  const view = render(React.createElement(Probe, { who: 'a' }));
  expect(await screen.findByText('a:true:true')).toBeTruthy();
  answer = { 'tech-field-workspace': false };
  await act(async () => { await mod.refetchFlags(); });
  view.rerender(React.createElement(Probe, { who: 'b' }));
  expect(await screen.findByText('b:true:false')).toBeTruthy();
  cleanup();
});

it('useFeatureFlag re-reads when its refreshKey changes after refetchFlags (Codex #5573 r8)', async () => {
  const React = await import('react');
  const { render, screen, act, cleanup } = await import('@testing-library/react');
  localStorage.setItem('waves_admin_token', 'fixture-only');
  let answer = { 'admin-navigation': true };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flags: answer }) })));
  const mod = await import('./useFeatureFlag');
  function Probe({ who }) {
    const enabled = mod.useFeatureFlag('admin-navigation', false, who);
    return React.createElement('output', null, `${who}:${enabled}`);
  }
  const view = render(React.createElement(Probe, { who: 'a' }));
  expect(await screen.findByText('a:true')).toBeTruthy();
  answer = { 'admin-navigation': false };
  await act(async () => { await mod.refetchFlags(); });
  view.rerender(React.createElement(Probe, { who: 'b' }));
  expect(await screen.findByText('b:false')).toBeTruthy();
  cleanup();
});

it('a refetch for a new account fails closed until the new read answers (Codex #5573 r10)', async () => {
  const React = await import('react');
  const { render, screen, act, cleanup } = await import('@testing-library/react');
  localStorage.setItem('waves_admin_token', 'fixture-only');
  let release;
  let first = true;
  vi.stubGlobal('fetch', vi.fn(() => {
    if (first) { first = false; return Promise.resolve({ ok: true, status: 200, json: async () => ({ flags: { 'admin-navigation': true } }) }); }
    return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ flags: { 'admin-navigation': true } }) }); });
  }));
  const mod = await import('./useFeatureFlag');
  function Probe({ who }) {
    const enabled = mod.useFeatureFlag('admin-navigation', false, who);
    return React.createElement('output', null, `${who}:${enabled}`);
  }
  const view = render(React.createElement(Probe, { who: 'a' }));
  expect(await screen.findByText('a:true')).toBeTruthy();
  act(() => { mod.refetchFlags(); });
  view.rerender(React.createElement(Probe, { who: 'b' }));
  expect(await screen.findByText('b:false')).toBeTruthy();
  await act(async () => { release(); });
  expect(await screen.findByText('b:true')).toBeTruthy();
  cleanup();
});

it('a same-account refetch updates already-mounted readers (Codex #5573 r15)', async () => {
  const React = await import('react');
  const { render, screen, act, cleanup } = await import('@testing-library/react');
  localStorage.setItem('waves_admin_token', 'fixture-only');
  let answer = { 'tech-field-workspace': false };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ flags: answer }) })));
  const mod = await import('./useFeatureFlag');
  function Probe() {
    const { enabled, ready } = mod.useFeatureFlagReady('tech-field-workspace', false, 'same-user');
    const plain = mod.useFeatureFlag('tech-field-workspace', false, 'same-user');
    return React.createElement('output', null, `${ready}:${enabled}:${plain}`);
  }
  render(React.createElement(Probe));
  expect(await screen.findByText('true:false:false')).toBeTruthy();
  answer = { 'tech-field-workspace': true };
  await act(async () => { await mod.refetchFlags(); });
  expect(await screen.findByText('true:true:true')).toBeTruthy();
  cleanup();
});
