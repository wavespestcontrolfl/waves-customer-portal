// @vitest-environment jsdom
// useWriteTracking: as a part of a stop, every non-GET request of a sheet is work in flight (the container never closes
// or unmounts a part mid-write); a GET is not. Outside a container the request is returned as it is.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartBusyContext, usePartBusy, useWriteTracking } from './FastCompleteParts';

afterEach(() => cleanup());

function harness(request, enabled = true) {
  const reports = [];
  const active = new Set();
  const holder = {};
  function Probe() {
    holder.request = useWriteTracking(request, enabled);
    return null;
  }
  render(<PartBusyContext.Provider value={(key, busy) => { reports.push([key, busy]); if (busy) active.add(key); else active.delete(key); }}><Probe /></PartBusyContext.Provider>);
  const busyNow = () => active.size > 0;
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

describe('busy keys are per part', () => {
  it('overlapping writes in two parts: the first to finish leaves the stop busy; the second makes it idle', async () => {
    const keys = new Set();
    const report = (key, on) => { if (on) keys.add(key); else keys.delete(key); };
    const pest = deferred(); const lawn = deferred();
    const holders = { pest: {}, lawn: {} };
    function Part({ name, request }) {
      holders[name].request = useWriteTracking(request, true);
      return null;
    }
    render(<PartBusyContext.Provider value={report}><Part name="pest" request={vi.fn(() => pest.promise)} /><Part name="lawn" request={vi.fn(() => lawn.promise)} /></PartBusyContext.Provider>);
    let a; let b;
    act(() => { a = holders.pest.request('/x', { method: 'POST' }); b = holders.lawn.request('/y', { method: 'POST' }); });
    expect(keys.size).toBe(2);
    await act(async () => { pest.resolve(1); await a; });
    // The pest write finished: the lawn write still holds the stop busy.
    expect(keys.size).toBe(1);
    await act(async () => { lawn.resolve(2); await b; });
    expect(keys.size).toBe(0);
  });

  it('two sources of one part (a write and a dictation) never share a key either', () => {
    const keys = new Set();
    const report = (key, on) => { if (on) keys.add(key); else keys.delete(key); };
    function Part({ dictating, writing }) {
      usePartBusy('dictation', dictating);
      usePartBusy('writes', writing);
      return null;
    }
    const { rerender } = render(<PartBusyContext.Provider value={report}><Part dictating writing /></PartBusyContext.Provider>);
    expect(keys.size).toBe(2);
    rerender(<PartBusyContext.Provider value={report}><Part dictating={false} writing /></PartBusyContext.Provider>);
    expect(keys.size).toBe(1);
  });
});
