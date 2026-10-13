/**
 * The general admin read's loopback GET is logged by the real access-log
 * format and the real error logger: every query value is masked when the
 * request carries the admin-read marker, and nothing changes without it.
 * Synthetic values only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const morgan = require('morgan');
const logger = require('../services/logger');
const { REDACTED_COMBINED_LOG, registerRedactedTokens } = require('../utils/request-log-format');
const { ADMIN_READ_HEADER, redactRequestUrl, redactRequestUrlFor } = require('../utils/redact-request-url');
const { errorHandler } = require('../middleware/errors');

const QUERY = 'email=a@example.test&phone=9415550100&name=Pat&days=30';
const VALUES = ['a@example.test', '9415550100', 'Pat'];

function appWith(handler) {
  registerRedactedTokens(morgan);
  const app = express();
  app.use(morgan(REDACTED_COMBINED_LOG, { stream: { write: message => logger.info(message.trim()) } }));
  app.get('/api/admin/csr/overview', handler || ((req, res) => res.json({ ok: true })));
  app.use(errorHandler);
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(path, headers = {}, handler) {
  const { server, base } = appWith(handler);
  try {
    const res = await fetch(`${base}${path}`, { headers });
    await res.text();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

beforeEach(() => jest.clearAllMocks());
const loggedLines = () => logger.info.mock.calls.map(call => String(call[0]));

describe('the access log (Morgan) for a loopback admin read', () => {
  test('with the marker header every query value is masked and the path and keys stay', async () => {
    await call(`/api/admin/csr/overview?${QUERY}`, { [ADMIN_READ_HEADER]: '1' });
    const line = loggedLines().find(text => text.includes('/api/admin/csr/overview'));
    expect(line).toContain('GET /api/admin/csr/overview?email=[REDACTED]&phone=[REDACTED]&name=[REDACTED]&days=[REDACTED] HTTP/1.1');
    for (const value of VALUES) expect(line).not.toContain(value);
    expect(line).not.toContain('=30');
  });

  test('without the header the existing behavior is unchanged', async () => {
    await call(`/api/admin/csr/overview?${QUERY}&search=Pat`);
    const line = loggedLines().find(text => text.includes('/api/admin/csr/overview'));
    expect(line).toContain('?email=a@example.test&phone=9415550100&name=Pat&days=30&search=[REDACTED] HTTP/1.1');
  });

  test('a header with any other value masks nothing extra', async () => {
    await call(`/api/admin/csr/overview?${QUERY}`, { [ADMIN_READ_HEADER]: '0' });
    expect(loggedLines().find(text => text.includes('/api/admin/csr/overview'))).toContain('name=Pat');
  });
});

describe('the error logger', () => {
  test('masks every query value for an admin-read request, keeps the path and keys', async () => {
    await call(`/api/admin/csr/overview?${QUERY}`, { [ADMIN_READ_HEADER]: '1' }, () => { throw new Error('boom'); });
    const [message] = logger.error.mock.calls[0];
    expect(message).toBe('GET /api/admin/csr/overview?email=[REDACTED]&phone=[REDACTED]&name=[REDACTED]&days=[REDACTED]: boom');
  });
  test('is unchanged without the header', async () => {
    await call(`/api/admin/csr/overview?${QUERY}`, {}, () => { throw new Error('boom'); });
    expect(logger.error.mock.calls[0][0]).toBe(`GET /api/admin/csr/overview?${QUERY}: boom`);
  });
});

describe('the redactor', () => {
  test('maskAllQuery keeps keys, masks values, bare parts and the fragment', () => {
    expect(redactRequestUrl('/a/b?x=1&flag&e=a%40example.test#frag', { maskAllQuery: true })).toBe('/a/b?x=[REDACTED]&[REDACTED]&e=[REDACTED]#[REDACTED]');
    expect(redactRequestUrl('/a/b', { maskAllQuery: true })).toBe('/a/b');
  });
  test('the default call is the old behavior', () => {
    expect(redactRequestUrl('/a?x=1&q=Pat')).toBe('/a?x=1&q=[REDACTED]');
  });
  test('a spoofed header only reduces what is logged', () => {
    const spoofed = { headers: { [ADMIN_READ_HEADER]: '1' }, originalUrl: '/api/x?token=abc&n=1' };
    const plain = { headers: {}, originalUrl: '/api/x?token=abc&n=1' };
    expect(redactRequestUrlFor(plain)).toBe('/api/x?token=[REDACTED]&n=1');
    expect(redactRequestUrlFor(spoofed)).toBe('/api/x?token=[REDACTED]&n=[REDACTED]');
  });
  test('the server mounts the shared format, and Sentry already drops request URLs', () => {
    const fs = require('fs');
    const path = require('path');
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(index).toContain('registerRedactedTokens(morgan)');
    expect(index).toContain('morgan(REDACTED_COMBINED_LOG');
    const { REQUEST_DATA_INCLUDE } = require('../instrument');
    expect(REQUEST_DATA_INCLUDE).toMatchObject({ url: false, query_string: false, headers: false });
  });
});
