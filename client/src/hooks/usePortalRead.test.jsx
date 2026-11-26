// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import usePortalRead, { PortalReadProvider, usePortalRefresh } from './usePortalRead';
import { PortalRefreshArea } from '../components/portal/PortalRefresh';
import { HOME_READS_KEY, HOME_SNAPSHOT_KEY, homeIdentityKey, readHomeSnapshot, writeHomeRead, writeHomeSnapshot } from '../lib/homeSnapshot';

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
function SilentRead({ load }) {
  usePortalRead('documents', load);
  return null;
}
function App({ load, extraLoad, account = 'a', show = true, enabled = true }) {
  return <PortalReadProvider key={account} enabled={enabled}><PortalRefreshArea>
    <RefreshFixture /><div data-testid="pull-target">Visits</div>
    {show && <Read load={load} />}
    {extraLoad && <SilentRead load={extraLoad} />}
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

  it('queues one resume cycle while a slower reader keeps the current refresh active', async () => {
    vi.useFakeTimers();
    const slowRefresh = deferred();
    const fastLoad = vi.fn()
      .mockResolvedValueOnce({ title: 'Fast initial' })
      .mockResolvedValueOnce({ title: 'Fast stale' })
      .mockResolvedValue({ title: 'Fast current' });
    const slowLoad = vi.fn()
      .mockResolvedValueOnce({ title: 'Slow initial' })
      .mockReturnValueOnce(slowRefresh.promise)
      .mockResolvedValue({ title: 'Slow current' });
    render(<App load={fastLoad} extraLoad={slowLoad} />);
    await act(async () => {});
    expect(screen.getByTestId('data')).toHaveTextContent('Fast initial');
    expect(slowLoad).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => fireEvent(window, new Event('focus')));
    expect(screen.getByTestId('data')).toHaveTextContent('Fast stale');
    expect(fastLoad).toHaveBeenCalledTimes(2);
    expect(slowLoad).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => {
      fireEvent(window, new Event('focus'));
      fireEvent(window, new Event('focus'));
    });
    expect(fastLoad).toHaveBeenCalledTimes(2);
    expect(slowLoad).toHaveBeenCalledTimes(2);

    await act(async () => slowRefresh.resolve({ title: 'Slow stale' }));
    expect(fastLoad).toHaveBeenCalledTimes(3);
    expect(slowLoad).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('data')).toHaveTextContent('Fast current');
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

  it('keeps the keyboard refresh control mounted and focused while a manual refresh is pending', async () => {
    const pending = deferred();
    const load = vi.fn().mockResolvedValueOnce({ title: 'Visit' }).mockReturnValueOnce(pending.promise);
    render(<App load={load} />);
    await screen.findByText('Visit');
    const refresh = screen.getByRole('button', { name: 'Refresh', exact: true });
    refresh.focus();
    expect(refresh).toHaveFocus();

    fireEvent.click(refresh);
    expect(screen.getByRole('button', { name: 'Refreshing…', exact: true })).toBe(refresh);
    expect(refresh).toHaveFocus();
    expect(refresh).not.toBeDisabled();
    expect(refresh).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Refreshing…', { selector: '[role="status"]' })).toBeVisible();
    fireEvent.click(refresh);
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve({ title: 'Fresh visit' }));
    expect(screen.getByRole('button', { name: 'Refresh', exact: true })).toBe(refresh);
    expect(refresh).toHaveFocus();
    expect(refresh).not.toHaveAttribute('aria-disabled');
    expect(refresh).toHaveClass('sr-only', 'focus:not-sr-only');

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent(window, new Event('offline'));
    expect(screen.getByRole('button', { name: 'Refresh', exact: true })).toBe(refresh);
    expect(refresh).toHaveFocus();
    expect(refresh).not.toBeDisabled();
    expect(refresh).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('You’re offline. Showing saved information.')).toBeVisible();
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

// Saved home reads (owner 2026-11-25): only 'next-visit' and 'latest-service'
// reach browser storage, under the login + property they were read for.
describe('saved home reads', () => {
  const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tokenFor = (claims) => `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`;
  const TOKEN = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1' });
  const identity = homeIdentityKey(TOKEN);
  const visit = { id: 'v1', serviceType: 'Pest Control', date: '2026-12-01', windowStart: '09:00', reportUrl: 'https://example.test/report/secret' };

  function HomeReads({ nextLoad, lastLoad, otherLoad, who = identity, property = 'cust-1:p1' }) {
    return <PortalReadProvider enabled persistIdentity={who} persistProperty={property}>
      <Probe name="next-visit" load={nextLoad} />
      <Probe name="latest-service" load={lastLoad} />
      <Probe name="documents" load={otherLoad} />
    </PortalReadProvider>;
  }
  function Probe({ name, load }) {
    const read = usePortalRead(name, load);
    return <div data-testid={name}>{`${read.data ? JSON.stringify(read.data) : 'none'}|${read.verified}|${read.saved}`}</div>;
  }
  const never = () => new Promise(() => {});
  const seed = (property = 'cust-1:p1') => {
    writeHomeRead(identity, property, 'next-visit', { next: visit, propertyScope: { enabled: true, propertyId: 'p1' } }, Date.now() - 60000);
    writeHomeRead(identity, property, 'latest-service', { services: [visit] }, Date.now() - 60000);
  };

  beforeEach(() => { localStorage.clear(); localStorage.setItem('waves_token', TOKEN); });
  afterEach(() => localStorage.clear());

  it('hydrates the two reads at mount as unverified saved data before any load answers', () => {
    seed();
    render(<HomeReads nextLoad={never} lastLoad={never} otherLoad={never} />);
    const next = screen.getByTestId('next-visit').textContent;
    expect(next).toContain('Pest Control');
    expect(next).toMatch(/\|false\|true$/);
    expect(next).not.toContain('reportUrl');
    expect(screen.getByTestId('latest-service').textContent).toMatch(/Pest Control.*\|false\|true$/);
    // Nothing else is ever hydrated.
    expect(screen.getByTestId('documents').textContent).toBe('none|false|false');
  });

  it('a successful refresh verifies the read and persists only the two home reads, cut to the card fields', async () => {
    seed();
    const fresh = { next: { ...visit, serviceType: 'Lawn Care' }, propertyScope: null };
    render(<HomeReads nextLoad={async () => fresh} lastLoad={async () => ({ services: [visit] })} otherLoad={async () => ({ documents: [{ id: 'd1', name: 'Private doc' }] })} />);
    await waitFor(() => expect(screen.getByTestId('next-visit').textContent).toMatch(/Lawn Care.*\|true\|false$/));
    const raw = localStorage.getItem(HOME_READS_KEY);
    expect(raw).toContain('Lawn Care');
    for (const word of ['Private doc', 'documents', 'reportUrl', 'secret']) expect(raw).not.toContain(word);
    expect(Object.keys(JSON.parse(raw).reads).sort()).toEqual(['latest-service', 'next-visit']);
  });

  it('a failed refresh keeps the saved read on screen and in storage', async () => {
    seed();
    render(<HomeReads nextLoad={async () => { throw new Error('weak signal'); }} lastLoad={never} otherLoad={never} />);
    await waitFor(() => expect(screen.getByTestId('next-visit').textContent).toMatch(/Pest Control.*\|false\|true$/));
    expect(JSON.parse(localStorage.getItem(HOME_READS_KEY)).reads['next-visit']).toBeTruthy();
  });

  it('a 401 clears the saved reads from memory and storage', async () => {
    seed();
    render(<HomeReads nextLoad={async () => { throw Object.assign(new Error('no'), { status: 401 }); }} lastLoad={never} otherLoad={never} />);
    await waitFor(() => expect(screen.getByTestId('next-visit').textContent).toBe('none|false|false'));
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('serves nothing, and deletes the entry, for another property or another login', () => {
    seed('cust-1:p1');
    render(<HomeReads nextLoad={never} lastLoad={never} otherLoad={never} property="cust-1:p2" />);
    expect(screen.getByTestId('next-visit').textContent).toBe('none|false|false');
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
    cleanup();
    seed('cust-1:p1');
    const other = homeIdentityKey(tokenFor({ customerId: 'cust-1', sessionId: 'fam-2' }));
    render(<HomeReads nextLoad={never} lastLoad={never} otherLoad={never} who={other} />);
    expect(screen.getByTestId('next-visit').textContent).toBe('none|false|false');
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('writes nothing without a login identity (contact or cancelled sessions) and hydrates nothing', async () => {
    seed();
    render(<HomeReads nextLoad={async () => ({ next: null })} lastLoad={async () => ({ services: [] })} otherLoad={never} who={null} />);
    expect(screen.getByTestId('next-visit').textContent).toBe('none|false|false');
    await waitFor(() => expect(screen.getByTestId('next-visit').textContent).toMatch(/\|true\|false$/));
    // The entry from before is untouched by this identity-less provider.
    expect(JSON.parse(localStorage.getItem(HOME_READS_KEY)).reads['next-visit'].data.next.id).toBe('v1');
  });

  it('never persists when the provider is disabled', async () => {
    seed();
    render(<PortalReadProvider enabled={false} persistIdentity={identity} persistProperty="cust-1:p1"><Probe name="next-visit" load={async () => ({ next: { id: 'x', serviceType: 'Disabled' } })} /></PortalReadProvider>);
    await waitFor(() => expect(screen.getByTestId('next-visit').textContent).toContain('Disabled'));
    expect(localStorage.getItem(HOME_READS_KEY)).not.toContain('Disabled');
  });

  it('a denied read empties every mounted sibling, in memory and on disk', async () => {
    seed();
    render(<HomeReads nextLoad={async () => { throw Object.assign(new Error('no'), { status: 403 }); }} lastLoad={never} otherLoad={never} />);
    // latest-service never answers, yet it must not keep its hydrated data.
    await waitFor(() => expect(screen.getByTestId('latest-service').textContent).toBe('none|false|false'));
    expect(screen.getByTestId('next-visit').textContent).toBe('none|false|false');
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('an answer that was already on the way when a sibling was denied is discarded and writes nothing', async () => {
    seed();
    let release;
    const lateLast = () => new Promise((resolve) => { release = resolve; });
    render(<HomeReads nextLoad={async () => { throw Object.assign(new Error('no'), { status: 401 }); }} lastLoad={lateLast} otherLoad={never} />);
    await waitFor(() => expect(localStorage.getItem(HOME_READS_KEY)).toBeNull());
    await act(async () => { release({ services: [{ id: 'late', serviceType: 'Late Visit', date: '2026-12-02' }] }); });
    expect(screen.getByTestId('latest-service').textContent).not.toContain('Late Visit');
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('saves nothing when the login that started the read is not the provider\'s login', async () => {
    const otherToken = tokenFor({ customerId: 'cust-1', sessionId: 'fam-2' });
    let release;
    // The read starts while another login's token is stored, and answers after this provider's login is back.
    localStorage.setItem('waves_token', otherToken);
    render(<HomeReads nextLoad={() => new Promise((resolve) => { release = resolve; })} lastLoad={never} otherLoad={never} />);
    localStorage.setItem('waves_token', TOKEN);
    await act(async () => { release({ next: { id: 'x', serviceType: 'Wrong Login Visit' } }); });
    expect(screen.getByTestId('next-visit').textContent).toContain('Wrong Login Visit');
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('a denied read also deletes the saved account, so an offline relaunch adopts nothing', async () => {
    seed();
    const me = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', actor: { kind: 'holder' }, cancelled: false };
    expect(writeHomeSnapshot({ token: TOKEN, requestIdentity: identity, me, propertyPayload: { scope: 'saved', properties: [], selected: null } })).toBe(true);
    expect(readHomeSnapshot(TOKEN)).not.toBeNull();
    render(<HomeReads nextLoad={async () => { throw Object.assign(new Error('no'), { status: 401 }); }} lastLoad={never} otherLoad={never} />);
    await waitFor(() => expect(localStorage.getItem(HOME_READS_KEY)).toBeNull());
    expect(localStorage.getItem(HOME_SNAPSHOT_KEY)).toBeNull();
    expect(readHomeSnapshot(TOKEN)).toBeNull();
  });
});
