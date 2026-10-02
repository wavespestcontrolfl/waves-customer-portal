// @vitest-environment jsdom
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
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

// A cold start in a dead zone fails the flag read closed; when the phone is
// back online the read is retried and screens already showing the gate update.
it('retries a failed flag read when the browser comes back online and updates mounted gates', async () => {
  let online = false;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ flags: { 'pest-recap-v1': true } }) };
  }));
  localStorage.setItem('waves_admin_token', 'login-a');
  const { useFeatureFlag } = await import('./useFeatureFlag');
  function Gate() {
    return useFeatureFlag('pest-recap-v1', false) ? <p>Recap capture</p> : <p>Recap hidden</p>;
  }

  render(<Gate />);
  expect(await screen.findByText('Recap hidden')).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  online = true;
  await act(async () => { window.dispatchEvent(new Event('online')); });

  expect(await screen.findByText('Recap capture')).toBeInTheDocument();
});
