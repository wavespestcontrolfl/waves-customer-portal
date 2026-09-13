// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import usePortalRead, { PortalReadProvider, usePortalRefresh } from './usePortalRead';
import { PortalRefreshArea } from '../components/portal/PortalRefresh';

const native = vi.hoisted(() => ({ enabled: false, callback: null, remove: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../native/platform', () => ({ isNativeApp: () => native.enabled }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async (_event, callback) => { native.callback = callback; return { remove: native.remove }; }) } }));

const biometric = vi.hoisted(() => ({ locked: false }));
vi.mock('../components/BiometricGate', () => ({ useBiometricLock: () => biometric.locked }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function Read({ load }) {
  const read = usePortalRead('visits', load);
  return <>
    <div data-testid="verified">{String(read.verified)}</div>
    <div data-testid="data">{read.data?.title || 'No saved information'}</div>
    <div data-testid="state">{read.saved ? 'saved' : read.error ? 'error' : read.loading ? 'loading' : 'ready'}</div>
    <button onClick={read.refresh}>Retry read</button>
    <button onClick={() => read.update(previous => ({ ...previous, title: 'Confirmed' }))}>Confirm fixture</button>
  </>;
}
function RefreshFixture() {
  const portal = usePortalRefresh();
  return <button onClick={portal.refresh}>Refresh fixture</button>;
}
function App({ load, account = 'a', show = true, enabled = true }) {
  return <PortalReadProvider key={account} enabled={enabled}><PortalRefreshArea>
    <RefreshFixture /><div data-testid="pull-target">Visits</div>
    {show && <Read load={load} />}
  </PortalRefreshArea></PortalReadProvider>;
}

beforeEach(() => {
  biometric.locked = false;
  native.enabled = false;
  native.callback = null;
  native.remove.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('customer portal reads', () => {
  it('queues an unlock behind an active refresh and retries after it fails', async () => {
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Saved visit' })
      .mockReturnValueOnce(pending.promise).mockResolvedValue({ title: 'Current visit' });
    const { rerender } = render(<App load={load} />);
    await screen.findByText('Saved visit');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture', exact: true }));
    biometric.locked = true;
    rerender(<App load={load} />);
    biometric.locked = false;
    rerender(<App load={load} />);
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => pending.reject(new Error('Connection interrupted')));
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(screen.getByTestId('data')).toHaveTextContent('Current visit');
  });

  it('queues one reconnect retry behind an active refresh and recovers without another gesture', async () => {
    const pending = deferred();
    const recovered = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Saved visit' })
      .mockReturnValueOnce(pending.promise).mockReturnValueOnce(recovered.promise);
    render(<App load={load} />);
    await screen.findByText('Saved visit');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture', exact: true }));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    fireEvent(window, new Event('online'));
    fireEvent(window, new Event('online'));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => pending.reject(new Error('Connection interrupted')));
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    await act(async () => recovered.resolve({ title: 'Current visit' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(screen.getByTestId('data')).toHaveTextContent('Current visit');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('revalidates after a reconnect during a biometric lock even within the focus throttle', async () => {
    const load = vi.fn().mockResolvedValue({ title: 'Visit' });
    const { rerender } = render(<App load={load} />);
    await screen.findByText('Visit');
    biometric.locked = true;
    rerender(<App load={load} />);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    fireEvent(window, new Event('online'));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    biometric.locked = false;
    rerender(<App load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
  });

  it('keeps a loaded visit read-only until a deferred reconnect read succeeds', async () => {
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Saved visit' }).mockReturnValueOnce(pending.promise);
    render(<App load={load} />);
    await screen.findByText('Saved visit');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    fireEvent(window, new Event('online'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    await act(async () => pending.resolve({ title: 'Current visit' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(screen.getByTestId('data')).toHaveTextContent('Current visit');
  });

  it('keeps a remounted cached read in saved mode until the server verifies it again', async () => {
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Saved visit' }).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<App load={load} />);
    await screen.findByText('Saved visit');
    rerender(<App load={load} show={false} />);
    rerender(<App load={load} />);
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    await act(async () => pending.resolve({ title: 'Current visit' }));
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
  });

  it('keeps the saved state visible while retrying a failed refresh', async () => {
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Saved visit' }).mockRejectedValueOnce(new Error('unreachable')).mockReturnValueOnce(pending.promise);
    render(<App load={load} />);
    await screen.findByText('Saved visit');
    fireEvent.click(screen.getByRole('button', { name: 'Retry read' }));
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('saved'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry read' }));
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    expect(screen.getByTestId('verified')).toHaveTextContent('false');
    await act(async () => pending.resolve({ title: 'Fresh visit' }));
    expect(screen.getByTestId('data')).toHaveTextContent('Fresh visit');
  });

  it('keeps the loaded result during refresh, marks failed reads as saved, and recovers', async () => {
    const next = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Visit A' }).mockReturnValueOnce(next.promise).mockResolvedValue({ title: 'Visit B' });
    render(<App load={load} />);
    await screen.findByText('Visit A');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture', exact: true }));
    expect(screen.getByText('Visit A')).toBeInTheDocument();
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
    expect(screen.queryByText('Refresh your visits and documents')).not.toBeInTheDocument();
    expect(screen.getByTestId('verified')).toHaveTextContent('true');
    await act(async () => next.reject(new Error('offline')));
    expect(screen.getByTestId('verified')).toHaveTextContent('false');
    expect(screen.getByTestId('state')).toHaveTextContent('saved');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture', exact: true }));
    await screen.findByText('Visit B');
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
  });

  it('reuses saved reads between tabs while offline, but clears them for a different property', async () => {
    const load = vi.fn().mockResolvedValue({ title: 'Property A visit' });
    const { rerender } = render(<App load={load} />);
    await screen.findByText('Property A visit');
    rerender(<App load={load} show={false} />);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    rerender(<App load={load} />);
    expect(screen.getByText('Property A visit')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    rerender(<App load={load} account="b" />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.queryByText('Property A visit')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('discards a late result after the property changes', async () => {
    const old = deferred();
    const { rerender } = render(<App load={() => old.promise} />);
    rerender(<App account="b" load={async () => ({ title: 'Property B visit' })} />);
    await screen.findByText('Property B visit');
    await act(async () => old.resolve({ title: 'Property A visit' }));
    expect(screen.queryByText('Property A visit')).not.toBeInTheDocument();
  });

  it.each([401, 403])('does not retain a saved result after an access denial (%s)', async status => {
    const load = vi.fn().mockResolvedValueOnce({ title: 'Visit A' }).mockRejectedValue(Object.assign(new Error('Denied'), { status }));
    const { rerender } = render(<App load={load} />);
    await screen.findByText('Visit A');
    fireEvent.click(screen.getByRole('button', { name: 'Retry read' }));
    await waitFor(() => expect(screen.queryByText('Visit A')).not.toBeInTheDocument());
    rerender(<App load={load} show={false} />);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    rerender(<App load={load} />);
    expect(screen.queryByText('Visit A')).not.toBeInTheDocument();
  });

  it('prevents an older read from overwriting a confirmed result', async () => {
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Pending' }).mockReturnValueOnce(pending.promise);
    render(<App load={load} />);
    await screen.findByText('Pending');
    fireEvent.click(screen.getByRole('button', { name: 'Retry read' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm fixture' }));
    await act(async () => pending.resolve({ title: 'Pending' }));
    expect(screen.getByTestId('data')).toHaveTextContent('Confirmed');
  });

  it('bounds a stalled refresh and ignores its late result after retry', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ title: 'Recovered' });
    render(<App load={load} />);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(screen.getByTestId('state')).toHaveTextContent('error');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture', exact: true })));
    expect(screen.getByTestId('data')).toHaveTextContent('Recovered');
    await act(async () => pending.resolve({ title: 'Expired attempt' }));
    expect(screen.getByTestId('data')).toHaveTextContent('Recovered');
  });

  it('refreshes on return and reconnect, throttles duplicate focus, and waits for Face ID', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue({ title: 'Visit' });
    const { rerender } = render(<App load={load} />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => fireEvent(window, new Event('focus')));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => fireEvent(window, new Event('focus')));
    expect(load).toHaveBeenCalledTimes(2);
    biometric.locked = true;
    rerender(<App load={load} />);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => fireEvent(window, new Event('focus')));
    expect(load).toHaveBeenCalledTimes(2);
    biometric.locked = false;
    rerender(<App load={load} />);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(3);
    await act(async () => fireEvent(window, new Event('online')));
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('refreshes on native resume, coalesces browser focus, and removes its listener', async () => {
    native.enabled = true;
    const load = vi.fn().mockResolvedValue({ title: 'Visit' });
    const { unmount } = render(<App load={load} />);
    await screen.findByText('Visit');
    await waitFor(() => expect(native.callback).toBeTypeOf('function'));
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => native.callback({ isActive: false }));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => native.callback({ isActive: true }));
    await act(async () => fireEvent(window, new Event('focus')));
    expect(load).toHaveBeenCalledTimes(2);
    unmount();
    expect(native.remove).toHaveBeenCalledTimes(1);
    await act(async () => native.callback({ isActive: true }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('revalidates a restored browser page without showing a permanent refresh card', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue({ title: 'Visit' });
    render(<App load={load} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Refresh', exact: true })).toHaveClass('sr-only', 'focus:not-sr-only');
    expect(screen.queryByText('Refresh your visits and documents')).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    await act(async () => fireEvent(window, restored));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps the rollout off without adding refresh controls or resume reads', async () => {
    const load = vi.fn().mockResolvedValue({ title: 'Visit' });
    render(<App enabled={false} load={load} />);
    await screen.findByText('Visit');
    fireEvent(window, new Event('online'));
    expect(screen.queryByRole('button', { name: 'Refresh', exact: true })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refreshes for a downward pull, but ignores horizontal and cancelled gestures', async () => {
    const load = vi.fn().mockResolvedValue({ title: 'Visit' });
    render(<App load={load} />);
    await screen.findByText('Visit');
    const target = screen.getByTestId('pull-target');
    const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
    fireEvent.touchStart(target, touch(20, 10));
    fireEvent.touchMove(target, touch(22, 105));
    expect(screen.getByText('Release to refresh')).toBeInTheDocument();
    await act(async () => fireEvent.touchEnd(target));
    expect(load).toHaveBeenCalledTimes(2);
    fireEvent.touchStart(target, touch(20, 10));
    fireEvent.touchMove(target, touch(150, 110));
    fireEvent.touchEnd(target);
    fireEvent.touchStart(target, touch(20, 10));
    fireEvent.touchMove(target, touch(20, 110));
    fireEvent.touchCancel(target);
    fireEvent.touchEnd(target);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
