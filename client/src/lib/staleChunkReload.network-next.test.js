// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleVitePreloadError, NETWORK_ONLY_PARAM, networkOnlyUrl, reloadFromNetwork, resetStaleChunkReloadForTests, stripNetworkOnlyParam,
} from './staleChunkReload';

// A page opened from the service worker's saved copy reloads once for a chunk
// the server replaced. The reload must reach the network, so on the screens
// the worker can answer from the saved copy it loads the same address with
// NETWORK_ONLY_PARAM (public/sw.js never answers such a load from the copy).
const at = (href) => vi.stubGlobal('location', { ...window.location, href, pathname: new URL(href).pathname });
const withWorker = (controller = {}) => vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller } });

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  resetStaleChunkReloadForTests();
});

describe('networkOnlyUrl', () => {
  it.each([
    ['https://portal.test/', 'https://portal.test/?waves-network=1'],
    ['https://portal.test/?tab=billing#top', 'https://portal.test/?tab=billing&waves-network=1#top'],
    ['https://portal.test/login', 'https://portal.test/login?waves-network=1'],
  ])('marks the customer screen %s', (href, expected) => {
    expect(networkOnlyUrl(href)).toBe(expected);
  });

  it.each(['https://portal.test/admin/dispatch', 'https://portal.test/tech', `https://portal.test/report/${'a'.repeat(32)}`])(
    'leaves %s alone: the worker never answers it from the saved copy',
    (href) => { expect(networkOnlyUrl(href)).toBeNull(); },
  );
});

describe('reloadFromNetwork', () => {
  it('loads the marked address at once on a customer screen, without a plain reload', () => {
    const reload = vi.fn();
    const replace = vi.fn();
    at('https://portal.test/?tab=visits');
    withWorker();
    reloadFromNetwork(reload, replace);
    expect(replace).toHaveBeenCalledWith(`https://portal.test/?tab=visits&${NETWORK_ONLY_PARAM}=1`);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(['https://portal.test/admin/dispatch', 'https://portal.test/tech'])('reloads %s as before, at once', (href) => {
    const reload = vi.fn();
    const replace = vi.fn();
    at(href);
    withWorker();
    reloadFromNetwork(reload, replace);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('reloads plainly when no worker controls the page: no saved copy can have answered it', () => {
    const reload = vi.fn();
    const replace = vi.fn();
    at('https://portal.test/');
    withWorker(null);
    reloadFromNetwork(reload, replace);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('stripNetworkOnlyParam', () => {
  it('removes the mark without a history entry and keeps the rest of the address', () => {
    window.history.replaceState({ k: 1 }, '', `/?tab=billing&${NETWORK_ONLY_PARAM}=1#top`);
    const length = window.history.length;
    stripNetworkOnlyParam();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/?tab=billing#top');
    expect(window.history.length).toBe(length);
    expect(window.history.state).toEqual({ k: 1 });
  });

  it('leaves an unmarked address alone', () => {
    window.history.replaceState(null, '', '/?tab=plan');
    const spy = vi.spyOn(window.history, 'replaceState');
    stripNetworkOnlyParam();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the stale-chunk heal goes through it by default', () => {
  it('a customer page that lost a chunk loads its marked address', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, href: 'https://portal.test/', pathname: '/', replace, reload: vi.fn() });
    withWorker();
    const event = new Event('vite:preloadError', { cancelable: true });
    handleVitePreloadError(event);
    expect(event.defaultPrevented).toBe(true);
    expect(replace).toHaveBeenCalledWith(`https://portal.test/?${NETWORK_ONLY_PARAM}=1`);
  });
});
