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

  test('beacons the error to /api/client-errors with message + context', async () => {
    reportError(new Error('Boom'), { context: 'PageErrorBoundary', componentStack: 'in <App>' });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe('/api/client-errors');
    const body = JSON.parse(await blob.text());
    expect(body).toMatchObject({
      message: 'Boom',
      context: 'PageErrorBoundary',
      componentStack: 'in <App>',
      url: '/admin/banking',
    });
  });

  test('accepts a plain string context', async () => {
    reportError(new Error('x'), 'banking:payout');
    const body = JSON.parse(await sendBeacon.mock.calls[0][1].text());
    expect(body.context).toBe('banking:payout');
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
