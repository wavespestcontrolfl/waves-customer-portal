// @vitest-environment jsdom
// Cold reopen in a dead zone, with the REAL feature-flag hook: the staff check
// and the flag read both hang. Both are bounded, so the shell still opens from
// this token's offline pass and the route content renders.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import TechLayout, { AUTH_CHECK_TIMEOUT_MS } from './TechLayout';
import TechNavigationLock from './tech/TechNavigationLock';
import { FLAGS_FETCH_TIMEOUT_MS } from '../hooks/useFeatureFlag';

function staffJwt(exp = Math.floor(Date.now() / 1000) + 3600) {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'HS256' })}.${part({ exp })}.fixture-signature`;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('opens the saved route when the staff check and the flag read both hang', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const token = staffJwt();
  localStorage.setItem('waves_admin_token', token);
  localStorage.setItem('waves_tech_offline_pass', JSON.stringify({
    binding: 'fixture-signature',
    profile: { id: 'tech-1', name: 'River Tech', role: 'technician' },
  }));
  // Every request hangs until its own abort fires.
  vi.stubGlobal('fetch', vi.fn((_url, options = {}) => new Promise((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })));

  render(
    <TechNavigationLock><MemoryRouter initialEntries={['/tech']}>
      <Routes>
        <Route path="/tech" element={<TechLayout />}>
          <Route index element={<div>Saved route content</div>} />
        </Route>
      </Routes>
    </MemoryRouter></TechNavigationLock>,
  );

  // The staff check gives up first; the shell then mounts and starts the
  // flag read, which gives up on its own bound.
  await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 100); });
  expect(await screen.findByText('Loading field workspace…')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(FLAGS_FETCH_TIMEOUT_MS + 100); });

  expect(await screen.findByText('Saved route content')).toBeInTheDocument();
});
