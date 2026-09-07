// Exercise the real rate-limit middleware: healthy native traffic must never
// consume the capacity reserved for native failures and existing crash reports.
const mockCapture = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCapture(...args),
  captureMessage: (...args) => mockCaptureMessage(...args),
}));

const express = require('express');
const router = require('../routes/client-errors');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/client-errors', router);
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const post = (body, ip) => fetch(`${baseUrl}/api/client-errors`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  body: JSON.stringify(body),
});

test('routine native traffic cannot consume either error quota, and all quotas remain enforced', async () => {
  const routine = {
    context: 'native-links',
    nativeLink: { platform: 'ios', source: 'boot', outcome: 'started', route: 'home', target: 'none' },
  };
  const nativeFailure = {
    context: 'native-links',
    nativeLink: { platform: 'ios', source: 'launch', outcome: 'lookup-error', route: 'home', target: 'none' },
  };
  const crash = { name: 'TypeError', context: 'PageErrorBoundary', route: '/estimate/test-token' };

  // Exhaust one routine per-IP bucket. Its rejected request must not debit the
  // shared routine bucket, which still admits ten more from a different IP.
  for (let i = 0; i < 10; i++) expect((await post(routine, '203.0.113.1')).status).toBe(204);
  expect((await post(routine, '203.0.113.1')).status).toBe(429);
  for (let i = 0; i < 10; i++) expect((await post(routine, '203.0.113.2')).status).toBe(204);
  expect((await post(routine, '203.0.113.3')).status).toBe(429);
  expect(mockCaptureMessage.mock.calls.filter(([, options]) => options.level === 'info')).toHaveLength(20);

  // The SAME exhausted IP still has all 30 error slots. Native errors share
  // that protected budget with the legacy reporter, not with healthy stages.
  for (let i = 0; i < 30; i++) {
    expect((await post(i % 2 ? crash : nativeFailure, '203.0.113.1')).status).toBe(204);
  }
  expect((await post(crash, '203.0.113.1')).status).toBe(429);
  for (let i = 0; i < 30; i++) expect((await post(crash, '203.0.113.2')).status).toBe(204);
  expect((await post(nativeFailure, '203.0.113.3')).status).toBe(429);
  expect(mockCapture).toHaveBeenCalledTimes(45);
  expect(mockCaptureMessage.mock.calls.filter(([, options]) => options.level === 'error')).toHaveLength(15);
});
