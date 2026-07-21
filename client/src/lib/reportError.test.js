import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { reportError } from './reportError';

describe('reportError', () => {
  let sendBeacon;
  beforeEach(() => {
    sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('window', { location: { pathname: '/admin/banking' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const beaconBody = async () => JSON.parse(await sendBeacon.mock.calls[0][1].text());

  test('beacons only the structured, non-free-form fields', async () => {
    reportError(new TypeError('Boom'), { context: 'PageErrorBoundary', componentStack: 'in <App>' });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0][0]).toBe('/api/client-errors');
    const body = await beaconBody();
    // The free-form message/stack are NOT sent — the server transforms the rest.
    expect(body).toEqual({
      name: 'TypeError',
      context: 'PageErrorBoundary',
      route: '/admin/banking',
      componentStack: 'in <App>',
    });
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('stack');
  });

  test('accepts a plain string context', async () => {
    reportError(new Error('x'), 'banking:payout');
    expect((await beaconBody()).context).toBe('banking:payout');
  });

  test('falls back to keepalive fetch when sendBeacon returns false', () => {
    sendBeacon.mockReturnValue(false);
    const fetchMock = vi.fn(() => Promise.resolve());
    vi.stubGlobal('fetch', fetchMock);
    reportError(new Error('x'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/client-errors');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', keepalive: true });
  });

  test('does NOT double-send when sendBeacon succeeds', () => {
    sendBeacon.mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.resolve());
    vi.stubGlobal('fetch', fetchMock);
    reportError(new Error('x'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('never throws, even if sendBeacon throws', () => {
    sendBeacon.mockImplementation(() => { throw new Error('beacon down'); });
    expect(() => reportError(new Error('x'))).not.toThrow();
  });

  test('tolerates a non-Error argument', () => {
    expect(() => reportError('just a string')).not.toThrow();
    expect(sendBeacon).toHaveBeenCalled();
  });
});
