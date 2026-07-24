// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capMocks = vi.hoisted(() => {
  const state = { launchUrl: null, listeners: {} };
  const App = {
    addListener: vi.fn(async (name, callback) => {
      state.listeners[name] = callback;
      return { remove: vi.fn() };
    }),
    getLaunchUrl: vi.fn(async () => (state.launchUrl ? { url: state.launchUrl } : null)),
  };
  return { state, App };
});

vi.mock('./platform', () => ({
  isNativeApp: () => true,
  nativePlatform: () => 'ios',
}));
vi.mock('@capacitor/app', () => ({ App: capMocks.App }));

import { initNativeLinks, LAUNCH_URL_CONSUMED_KEY } from './nativeLinks';

const ORIGIN = window.location.origin;
const SHORT_LINK = `${ORIGIN}/l/75zer`;

// jsdom's location.assign throws "Not implemented" — replace it with a spy so
// navigation attempts are observable without tearing down the test document.
let assignSpy;

beforeEach(() => {
  sessionStorage.clear();
  capMocks.state.launchUrl = null;
  capMocks.state.listeners = {};
  capMocks.App.addListener.mockClear();
  capMocks.App.getLaunchUrl.mockClear();
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
  vi.unstubAllGlobals();
});

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

  it('replays again after the session storage resets (new cold start)', async () => {
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
  });
});
