// @vitest-environment jsdom
// useWriteTracking: as a part of a stop, every non-GET request of a sheet is work in flight (the container never closes
// or unmounts a part mid-write); a GET is not. Outside a container the request is returned as it is.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartBusyContext, useWriteTracking } from './FastCompleteParts';

afterEach(() => cleanup());

function harness(request, enabled = true) {
  const reports = [];
  const holder = {};
  function Probe() {
    holder.request = useWriteTracking(request, enabled);
    return null;
  }
  render(<PartBusyContext.Provider value={(source, busy) => reports.push([source, busy])}><Probe /></PartBusyContext.Provider>);
  const busyNow = () => reports.filter(([source]) => source === 'writes').at(-1)?.[1] === true;
  return { holder, busyNow, reports };
}
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('useWriteTracking', () => {
  it.each([
    ['a sod rooted date', '/admin/dispatch/svc/lawn-fast/sod-rooted?sodAware=1', { method: 'POST', body: '{}' }],
    ['a trouble area clear', '/admin/dispatch/svc/lawn-fast/trouble-areas/area-1/clear', { method: 'POST', body: '{}' }],
    ['a delete', '/tech/services/svc/treatment-zone', { method: 'DELETE' }],
    ['a lower-case method', '/admin/x', { method: 'patch' }],
  ])('%s in flight is busy until it settles', async (_label, path, options) => {
    const pending = deferred();
    const { holder, busyNow } = harness(vi.fn(() => pending.promise));
    let call;
    act(() => { call = holder.request(path, options); });
    expect(busyNow()).toBe(true);
    await act(async () => { pending.resolve({ ok: true }); await call; });
    expect(busyNow()).toBe(false);
  });

  it('a write that fails is not busy afterwards, and its error still reaches the caller', async () => {
    const pending = deferred();
    const { holder, busyNow } = harness(vi.fn(() => pending.promise));
    let call;
    act(() => { call = holder.request('/admin/x', { method: 'POST' }).catch((err) => err); });
    expect(busyNow()).toBe(true);
    await act(async () => { pending.reject(new Error('refused')); });
    expect((await call).message).toBe('refused');
    expect(busyNow()).toBe(false);
  });

  it('two writes at once stay busy until both settle', async () => {
    const a = deferred(); const b = deferred();
    const queue = [a, b];
    const { holder, busyNow } = harness(vi.fn(() => queue.shift().promise));
    let one; let two;
    act(() => { one = holder.request('/x', { method: 'POST' }); two = holder.request('/y', { method: 'POST' }); });
    await act(async () => { a.resolve(1); await one; });
    expect(busyNow()).toBe(true);
    await act(async () => { b.resolve(2); await two; });
    expect(busyNow()).toBe(false);
  });

  it('a GET (explicit or by default) is never busy', async () => {
    const pending = deferred();
    const { holder, busyNow } = harness(vi.fn(() => pending.promise));
    let reads;
    act(() => { reads = Promise.all([holder.request('/admin/dispatch/svc/lawn-fast/context'), holder.request('/y', { method: 'GET' })]); });
    expect(busyNow()).toBe(false);
    await act(async () => { pending.resolve({}); await reads; });
  });

  it('outside a container the request is returned as it is', () => {
    const request = vi.fn();
    const { holder } = harness(request, false);
    expect(holder.request).toBe(request);
  });
});
