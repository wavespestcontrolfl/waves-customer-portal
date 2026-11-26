// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleVitePreloadError, NETWORK_NEXT_MESSAGE, reloadFromNetwork, resetStaleChunkReloadForTests } from './staleChunkReload';

// A page opened from the service worker's saved copy reloads once for a chunk
// the server replaced. The reload must reach the network, so the page first
// asks the worker to skip the saved copy (public/sw.js NETWORK_NEXT_MESSAGE).
function controllerThat({ ack }) {
  return {
    postMessage: vi.fn((message, ports) => {
      if (ack) ports[0].postMessage({ type: 'waves:network-next-ack' });
    }),
  };
}
const withController = (controller) => vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  resetStaleChunkReloadForTests();
});

describe('reloadFromNetwork', () => {
  it('reloads at once when no worker controls the page', () => {
    const reload = vi.fn();
    withController(null);
    reloadFromNetwork(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at once when the browser has no worker API', () => {
    const reload = vi.fn();
    vi.stubGlobal('navigator', {});
    reloadFromNetwork(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('posts the message with a reply port first, then reloads once the worker acks', async () => {
    const reload = vi.fn();
    const controller = controllerThat({ ack: true });
    withController(controller);
    reloadFromNetwork(reload);
    expect(controller.postMessage).toHaveBeenCalledWith({ type: NETWORK_NEXT_MESSAGE }, [expect.anything()]);
    expect(reload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('reloads after 300 ms when the worker never acks, and only once', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    withController(controllerThat({ ack: false }));
    reloadFromNetwork(reload);
    vi.advanceTimersByTime(299);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each(['/admin/dispatch', '/tech', `/report/${'a'.repeat(32)}`])('reloads at once on %s, which the worker never answers from the saved copy', (pathname) => {
    const reload = vi.fn();
    const controller = controllerThat({ ack: true });
    vi.stubGlobal('location', { ...window.location, pathname });
    withController(controller);
    reloadFromNetwork(reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(controller.postMessage).not.toHaveBeenCalled();
  });

  it('reloads at once when the message cannot be posted', () => {
    const reload = vi.fn();
    withController({ postMessage: () => { throw new Error('closed'); } });
    reloadFromNetwork(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the stale-chunk heal goes through it by default', () => {
  it('a customer page that lost a chunk posts the message before location.reload runs', async () => {
    const reload = vi.fn();
    const controller = controllerThat({ ack: false });
    vi.stubGlobal('location', { ...window.location, pathname: '/', reload });
    withController(controller);
    vi.useFakeTimers();
    const event = new Event('vite:preloadError', { cancelable: true });
    handleVitePreloadError(event);
    expect(event.defaultPrevented).toBe(true);
    expect(controller.postMessage).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
