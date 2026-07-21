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

  test('redacts token routes regardless of token length', async () => {
    for (const [path, expected] of [
      ['/report/AbC123dEf456GhI789jkL', '/report/:token'],
      ['/estimate/abc', '/estimate/:token'], // legacy 3-char slug
      ['/pay/statement/xyz789', '/pay/:token'],
      ['/receipt/ZZZ', '/receipt/:token'],
    ]) {
      sendBeacon.mockClear();
      vi.stubGlobal('window', { location: { pathname: path } });
      reportError(new Error('crash'));
      const body = JSON.parse(await sendBeacon.mock.calls[0][1].text());
      expect(body.url).toBe(expected);
    }
  });

  test('keeps token-free admin/tech paths intact for triage', async () => {
    for (const path of ['/admin/banking', '/tech/route', '/login', '/']) {
      sendBeacon.mockClear();
      vi.stubGlobal('window', { location: { pathname: path } });
      reportError(new Error('crash'));
      const body = JSON.parse(await sendBeacon.mock.calls[0][1].text());
      expect(body.url).toBe(path);
    }
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
