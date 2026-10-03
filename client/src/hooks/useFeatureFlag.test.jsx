// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
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

it('turns a mounted gate off when a later flag read fails closed', async () => {
  let online = true;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ flags: { 'pest-recap-v1': true } }) };
  }));
  localStorage.setItem('waves_admin_token', 'login-a');
  const { useFeatureFlag, refetchFlags } = await import('./useFeatureFlag');
  function Gate() {
    return useFeatureFlag('pest-recap-v1', false) ? <p>Recap capture</p> : <p>Recap hidden</p>;
  }

  render(<Gate />);
  expect(await screen.findByText('Recap capture')).toBeInTheDocument();

  online = false;
  await act(async () => { await refetchFlags(); });

  expect(await screen.findByText('Recap hidden')).toBeInTheDocument();
});

it('keeps a default-on flag the server switched off OFF when a reload fails', async () => {
  let online = true;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ flags: { ff_invoice_send_receipt: false } }) };
  }));
  localStorage.setItem('waves_admin_token', 'login-a');
  const { useFeatureFlag, refetchFlags } = await import('./useFeatureFlag');
  function Gate() {
    return useFeatureFlag('ff_invoice_send_receipt', true) ? <p>Receipt on</p> : <p>Receipt off</p>;
  }

  render(<Gate />);
  expect(await screen.findByText('Receipt off')).toBeInTheDocument();

  online = false;
  await act(async () => { await refetchFlags(); });

  expect(screen.getByText('Receipt off')).toBeInTheDocument();
});

it.each([
  ['the first read fails', false],
  ['a gate mounts after a failed reload', true],
])('fails a default-on flag closed when %s', async (_label, loadFirst) => {
  let online = loadFirst;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ flags: {} }) };
  }));
  localStorage.setItem('waves_admin_token', 'login-a');
  const { useFeatureFlag, useFeatureFlagReady, refetchFlags } = await import('./useFeatureFlag');
  if (loadFirst) {
    await refetchFlags();
    online = false;
    await refetchFlags();
  }
  function Gates() {
    const plain = useFeatureFlag('ff_invoice_send_receipt', true);
    const ready = useFeatureFlagReady('ff_invoice_send_receipt', true);
    return <p>{`plain:${plain} ready:${ready.ready}/${ready.enabled}`}</p>;
  }

  render(<Gates />);

  expect(await screen.findByText('plain:false ready:true/false')).toBeInTheDocument();
});

// #5573: a long-lived shell reads flags per verified account (refreshKey).
it('re-reads per refreshKey and fails closed while a new account\'s read is in flight (Codex #5573 r10/r12)', async () => {
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
    const ready = mod.useFeatureFlagReady('admin-navigation', false, who);
    return <output>{`${who}:${enabled}:${ready.ready}:${ready.enabled}`}</output>;
  }
  const view = render(<Probe who="a" />);
  expect(await screen.findByText('a:true:true:true')).toBeInTheDocument();
  act(() => { mod.refetchFlags(); });
  view.rerender(<Probe who="b" />);
  // The very first render for the new account shows the fail-closed default.
  expect(screen.getByText('b:false:false:false')).toBeInTheDocument();
  await act(async () => { release(); });
  expect(await screen.findByText('b:true:true:true')).toBeInTheDocument();
  view.unmount();
});

it('a default-on flag stays closed while a refetch is in flight (pre-push P1)', async () => {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  let release;
  let first = true;
  vi.stubGlobal('fetch', vi.fn(() => {
    if (first) { first = false; return Promise.resolve({ ok: true, status: 200, json: async () => ({ flags: {} }) }); }
    return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ flags: {} }) }); });
  }));
  const mod = await import('./useFeatureFlag');
  function Probe({ who }) { return <output>{`${who}:${mod.useFeatureFlag('on-by-default', true, who)}`}</output>; }
  const view = render(<Probe who="a" />);
  expect(await screen.findByText('a:true')).toBeInTheDocument();
  act(() => { mod.refetchFlags(); });
  view.rerender(<Probe who="b" />);
  expect(screen.getByText('b:false')).toBeInTheDocument();
  await act(async () => { release(); });
  expect(await screen.findByText('b:true')).toBeInTheDocument();
  view.unmount();
});
