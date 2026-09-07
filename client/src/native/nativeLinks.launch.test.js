// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capMocks = vi.hoisted(() => {
  const state = { launchUrl: null, listeners: {}, platform: 'ios' };
  const App = {
    addListener: vi.fn(async (name, callback) => {
      state.listeners[name] = callback;
      return { remove: vi.fn() };
    }),
    getLaunchUrl: vi.fn(async () => (state.launchUrl ? { url: state.launchUrl } : null)),
  };
  return { state, App, reportNativeLink: vi.fn() };
});

vi.mock('./platform', () => ({
  isNativeApp: () => true,
  nativePlatform: () => capMocks.state.platform,
}));
vi.mock('@capacitor/app', () => ({ App: capMocks.App }));
vi.mock('../lib/reportError', () => ({ reportNativeLink: capMocks.reportNativeLink }));

import { initNativeLinks, LAUNCH_URL_CONSUMED_KEY } from './nativeLinks';

const ORIGIN = window.location.origin;
const SHORT_LINK = `${ORIGIN}/l/test-launch-link`;

// jsdom's location.assign throws "Not implemented" — replace it with a spy so
// navigation attempts are observable without tearing down the test document.
let assignSpy;

beforeEach(() => {
  sessionStorage.clear();
  capMocks.state.launchUrl = null;
  capMocks.state.listeners = {};
  capMocks.state.platform = 'ios';
  capMocks.App.addListener.mockReset().mockImplementation(async (name, callback) => {
    capMocks.state.listeners[name] = callback;
    return { remove: vi.fn() };
  });
  capMocks.App.getLaunchUrl.mockReset().mockImplementation(async () => (
    capMocks.state.launchUrl ? { url: capMocks.state.launchUrl } : null
  ));
  capMocks.reportNativeLink.mockClear();
  assignSpy = vi.fn();
  // vi.stubGlobal survives jsdom versions where window.location is a
  // non-configurable global (defineProperty throws there) and restores
  // automatically via unstubAllGlobals below.
  vi.stubGlobal('location', {
    origin: ORIGIN,
    pathname: '/',
    search: '',
    hash: '',
    assign: assignSpy,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const reported = (outcome) => capMocks.reportNativeLink.mock.calls
  .map(([report]) => report).filter((report) => report.outcome === outcome);

describe('launch URL replay (redirecting short links)', () => {
  it('navigates to the launch URL on the first boot of a session', async () => {
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(SHORT_LINK);
  });

  it('does NOT replay the same launch URL on later boots in the session', async () => {
    // The incident shape: /l/:code 302s to /estimate/:token, so the webview is
    // never "at" the launch URL and the dest===current guard can't stop the
    // replay. Only the consumed marker breaks the loop.
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    assignSpy.mockClear();

    // Simulate the post-redirect document re-running the module init.
    window.location.pathname = '/estimate/sometoken';
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('replays again when storage is empty (does not assert iOS cold-start persistence)', async () => {
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    assignSpy.mockClear();

    sessionStorage.clear();
    await initNativeLinks();
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
  });

  it('appUrlOpen taps still navigate every time', async () => {
    await initNativeLinks();
    const openUrl = `${ORIGIN}/estimate/other`;
    capMocks.state.listeners.appUrlOpen({ url: openUrl });
    capMocks.state.listeners.appUrlOpen({ url: openUrl });
    // Second call is suppressed only by the dest===current guard when already
    // there; our fake location stays at '/', so both taps navigate.
    expect(assignSpy).toHaveBeenCalledTimes(2);
    expect(assignSpy).toHaveBeenCalledWith(openUrl);
  });

  it('boots without navigating when there is no launch URL', async () => {
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(null);
    expect(reported('empty')).toEqual([{
      platform: 'ios', source: 'launch', outcome: 'empty', route: 'home', target: 'none',
    }]);
  });

  it('reports a retained marker suppressing the same URL while still on home', async () => {
    sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, SHORT_LINK);
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reported('replay-skipped')).toEqual([{
      platform: 'ios', source: 'launch', outcome: 'replay-skipped', route: 'home', target: 'shortlink',
    }]);
  });

  it('honors a different URL despite a retained marker', async () => {
    sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, `${ORIGIN}/l/previous-test-link`);
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
    expect(reported('replay-skipped')).toHaveLength(0);
  });

  it('honors a fresh event despite its marker and prevents replay after its redirect', async () => {
    sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, SHORT_LINK);
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    capMocks.state.listeners.appUrlOpen({ url: SHORT_LINK });
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);

    assignSpy.mockClear();
    window.location.pathname = '/estimate/test-estimate-token';
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reported('replay-skipped').at(-1).route).toBe('estimate');
  });

  it('marks an event-delivered short link before its first redirect', async () => {
    await initNativeLinks();
    capMocks.state.listeners.appUrlOpen({ url: SHORT_LINK });
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(SHORT_LINK);

    capMocks.state.launchUrl = SHORT_LINK;
    assignSpy.mockClear();
    window.location.pathname = '/estimate/test-estimate-token';
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('preserves Android\'s original launch marker when a later event opens another link', async () => {
    capMocks.state.platform = 'android';
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    const nextLink = `${ORIGIN}/l/next-test-link`;
    capMocks.state.listeners.appUrlOpen({ url: nextLink });
    expect(assignSpy).toHaveBeenLastCalledWith(nextLink);
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(SHORT_LINK);

    assignSpy.mockClear();
    window.location.pathname = '/estimate/next-test-token';
    // Android's Bridge.getIntentUri still returns SHORT_LINK after the event.
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reported('replay-skipped').at(-1)).toMatchObject({ platform: 'android', route: 'estimate' });
  });

  it.each([
    'https://example.invalid/estimate/test-token',
    `${ORIGIN}/admin/customers`,
    `${ORIGIN}/api/estimates/test-token`,
    `${ORIGIN}//example.invalid/test-token`,
    'not-a-url',
  ])('refuses %s before consuming or navigating', async (url) => {
    capMocks.state.launchUrl = url;
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(null);
    expect(reported('rejected')).toHaveLength(1);
    expect(JSON.stringify(capMocks.reportNativeLink.mock.calls)).not.toContain(url);
  });

  it('distinguishes an already displayed destination and still prevents later replay', async () => {
    window.location.pathname = '/estimate/test-token';
    capMocks.state.launchUrl = `${ORIGIN}/estimate/test-token`;
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reported('already-current')).toHaveLength(1);
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(capMocks.state.launchUrl);
  });

  it.each([null, `${ORIGIN}/l/previous-test-link`])(
    'restores the previous consumption marker (%s) when navigation throws', async (previous) => {
      if (previous) sessionStorage.setItem(LAUNCH_URL_CONSUMED_KEY, previous);
      capMocks.state.launchUrl = SHORT_LINK;
      assignSpy.mockImplementationOnce(() => { throw new Error('navigation denied'); });
      await initNativeLinks();
      expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(previous);
      expect(reported('navigation-failed')).toHaveLength(1);

      assignSpy.mockClear();
      await initNativeLinks();
      expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
    },
  );

  it('reports unavailable storage and preserves best-effort navigation', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
    expect(reported('storage-unavailable')).toHaveLength(1);
  });

  it('catches a listener-registration rejection without losing the launch lookup', async () => {
    capMocks.App.addListener.mockRejectedValueOnce(new Error('plugin missing'));
    capMocks.state.launchUrl = SHORT_LINK;
    await initNativeLinks();
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
    expect(reported('listener-error')).toHaveLength(1);
  });

  it('reports a failed launch lookup while keeping warm events operational', async () => {
    capMocks.App.getLaunchUrl.mockRejectedValueOnce(new Error('bridge error'));
    await initNativeLinks();
    expect(reported('lookup-error')).toHaveLength(1);
    capMocks.state.listeners.appUrlOpen({ url: SHORT_LINK });
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
  });

  it('reports an event without a URL instead of throwing from the native callback', async () => {
    await initNativeLinks();
    expect(() => capMocks.state.listeners.appUrlOpen(null)).not.toThrow();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reported('rejected')).toHaveLength(1);
  });

  it.each([SHORT_LINK, `${ORIGIN}/l/earlier-test-link`])(
    'does not overwrite a startup event with the delayed launch lookup (%s)', async (launchUrl) => {
      let resolveLaunch;
      capMocks.App.getLaunchUrl.mockImplementationOnce(() => new Promise((resolve) => { resolveLaunch = resolve; }));
      const boot = initNativeLinks();
      await vi.waitFor(() => expect(resolveLaunch).toBeTypeOf('function'));
      capMocks.state.listeners.appUrlOpen({ url: SHORT_LINK });
      resolveLaunch({ url: launchUrl });
      await boot;
      expect(assignSpy).toHaveBeenCalledTimes(1);
      expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
      expect(reported('superseded')).toHaveLength(1);
    },
  );

  it('consumes a superseded Android startup lookup so the next document stays on the newer link', async () => {
    capMocks.state.platform = 'android';
    capMocks.state.launchUrl = SHORT_LINK;
    let resolveLaunch;
    capMocks.App.getLaunchUrl.mockImplementationOnce(() => new Promise((resolve) => { resolveLaunch = resolve; }));
    const boot = initNativeLinks();
    await vi.waitFor(() => expect(resolveLaunch).toBeTypeOf('function'));
    const newerLink = `${ORIGIN}/l/newer-test-link`;
    capMocks.state.listeners.appUrlOpen({ url: newerLink });
    resolveLaunch({ url: SHORT_LINK });
    await boot;
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(newerLink);
    expect(sessionStorage.getItem(LAUNCH_URL_CONSUMED_KEY)).toBe(SHORT_LINK);

    assignSpy.mockClear();
    window.location.pathname = '/estimate/newer-test-token';
    await initNativeLinks();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reported('replay-skipped').at(-1)).toMatchObject({ platform: 'android', route: 'estimate' });
  });

  it('reports a stalled bridge but still honors a delayed launch result', async () => {
    vi.useFakeTimers();
    let resolveLaunch;
    capMocks.App.getLaunchUrl.mockImplementationOnce(() => new Promise((resolve) => { resolveLaunch = resolve; }));
    const boot = initNativeLinks();
    await vi.waitFor(() => expect(resolveLaunch).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(reported('lookup-timeout')).toHaveLength(1);
    expect(assignSpy).not.toHaveBeenCalled();
    resolveLaunch({ url: SHORT_LINK });
    await boot;
    expect(assignSpy).toHaveBeenCalledWith(SHORT_LINK);
  });

  it('never includes launch tokens, query strings or unknown path segments in diagnostics', async () => {
    window.location.pathname = '/private-test-segment/current-test-token';
    capMocks.state.launchUrl = `${ORIGIN}/estimate/private-test-token?secret=test-query#test-fragment`;
    await initNativeLinks();
    const serialized = JSON.stringify(capMocks.reportNativeLink.mock.calls);
    expect(serialized).not.toMatch(/private-test|current-test|test-query|test-fragment|https?:/);
    expect(reported('navigation-requested')).toEqual([{
      platform: 'ios', source: 'launch', outcome: 'navigation-requested', route: 'other', target: 'estimate',
    }]);
  });
});
