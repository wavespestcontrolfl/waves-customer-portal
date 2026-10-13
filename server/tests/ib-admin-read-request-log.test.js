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
const { ADMIN_READ_HEADER, adminReadMarkerValue, redactRequestUrl, redactRequestUrlFor } = require('../utils/redact-request-url');
const { errorHandler } = require('../middleware/errors');

const QUERY = 'email=a@example.test&phone=9415550100&name=Pat&days=30';
const VALUES = ['a@example.test', '9415550100', 'Pat'];

function appWith(handler) {
  registerRedactedTokens(morgan);
  const app = express();
  app.use(morgan(REDACTED_COMBINED_LOG, { stream: { write: message => logger.info(message.trim()) } }));
  const respond = handler || ((req, res) => res.json({ ok: true }));
  app.get('/api/admin/csr/overview', respond);
  app.get('/api/admin/job-forms/templates/by-service/:serviceType', respond);
  app.get('/api/admin/customers/:id/credits', respond);
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
    expect(message).toBe('GET /api/admin/csr/overview?email=[REDACTED]&phone=[REDACTED]&name=[REDACTED]&days=[REDACTED]: [admin read] Error');
  });
  test('a database error that echoes an input value logs the error class and code only', async () => {
    const dbError = Object.assign(new Error('invalid input syntax for type uuid: "9415550100"'), { code: '22P02' });
    await call('/api/admin/customers/9415550100/credits', { [ADMIN_READ_HEADER]: '1;p=2' }, () => { throw dbError; });
    const [message, meta] = logger.error.mock.calls[0];
    expect(message).toBe('GET /api/admin/customers/[REDACTED]/credits: [admin read] Error, code 22P02');
    expect(`${message} ${JSON.stringify(meta)}`).not.toContain('9415550100');
    expect(meta.stack).toMatch(/^\s+at /);
  });
  test('is unchanged without the header', async () => {
    await call(`/api/admin/csr/overview?${QUERY}`, {}, () => { throw new Error('boom'); });
    expect(logger.error.mock.calls[0][0]).toBe(`GET /api/admin/csr/overview?${QUERY}: boom`);
  });
});

describe('path parameters on a marked request', () => {
  const NAME = 'Synthetic%20Person%209415550100';
  const SERVICE = '/api/admin/job-forms/templates/by-service/';
  const CUSTOMER = '10000000-0000-4000-8000-00000000000a';
  const lineFor = fragment => loggedLines().find(text => text.includes(fragment));
  const leaks = text => /Synthetic|Person|9415550100/.test(text);

  test('a free-text parameter with a name and phone is masked in the access line and the error line', async () => {
    const header = { [ADMIN_READ_HEADER]: adminReadMarkerValue([4]) };
    expect(header[ADMIN_READ_HEADER]).toBe('1;p=4');
    await call(`${SERVICE}${NAME}`, header);
    const line = lineFor('/api/admin/job-forms');
    expect(line).toContain('GET /api/admin/job-forms/templates/by-service/[REDACTED] HTTP/1.1');
    expect(leaks(line)).toBe(false);
    jest.clearAllMocks();
    await call(`${SERVICE}${NAME}?x=1`, header, () => { throw new Error('boom'); });
    expect(logger.error.mock.calls[0][0]).toBe('GET /api/admin/job-forms/templates/by-service/[REDACTED]?x=[REDACTED]: [admin read] Error');
    expect(leaks(logger.error.mock.calls[0][0])).toBe(false);
  });

  test('a UUID customer parameter is masked too, the literal segments stay', async () => {
    await call(`/api/admin/customers/${CUSTOMER}/credits?days=7`, { [ADMIN_READ_HEADER]: adminReadMarkerValue([2]) });
    expect(lineFor('/api/admin/customers')).toContain('GET /api/admin/customers/[REDACTED]/credits?days=[REDACTED] HTTP/1.1');
    expect(lineFor('/api/admin/customers')).not.toContain(CUSTOMER);
  });

  test('an endpoint with no parameters logs its path unchanged', async () => {
    await call('/api/admin/csr/overview?days=30', { [ADMIN_READ_HEADER]: adminReadMarkerValue([]) });
    expect(lineFor('/api/admin/csr')).toContain('GET /api/admin/csr/overview?days=[REDACTED] HTTP/1.1');
  });

  test.each(['1;p=', '1;p=a', '1;p=3,', '1;p=3;x', '1;p=99', '1;p=1,2,3,4,5,6,7,8,9,10,11,12,13', '10', '1 ; p=3', '1;p=-1'])(
    'a malformed marker (%s) masks every segment after /api/admin', async (value) => {
      await call(`${SERVICE}${NAME}?x=1`, { [ADMIN_READ_HEADER]: value });
      const line = lineFor('HTTP/1.1');
      expect(line).toContain('GET /api/admin/[REDACTED]/[REDACTED]/[REDACTED]/[REDACTED]?x=[REDACTED] HTTP/1.1');
      expect(leaks(line)).toBe(false);
    });

  test('a header that is not a marker masks nothing; an unmarked request is unchanged', async () => {
    await call(`${SERVICE}Plain%20Name?x=1`, { [ADMIN_READ_HEADER]: '0' });
    expect(lineFor('/api/admin/job-forms')).toContain('by-service/Plain%20Name?x=1 HTTP/1.1');
    jest.clearAllMocks();
    await call(`${SERVICE}Plain%20Name?x=1`);
    expect(lineFor('/api/admin/job-forms')).toContain('by-service/Plain%20Name?x=1 HTTP/1.1');
  });

  test('the helper: strict parse, 12 indexes at most, each under 40; spoofing only logs less', () => {
    const urlFor = value => redactRequestUrlFor({ headers: { [ADMIN_READ_HEADER]: value }, originalUrl: '/api/admin/a/b/c?q=1' });
    expect(urlFor('1')).toBe('/api/admin/a/b/c?q=[REDACTED]');
    expect(urlFor('1;p=1,2')).toBe('/api/admin/[REDACTED]/[REDACTED]/c?q=[REDACTED]');
    expect(urlFor('1;p=0')).toBe('/api/[REDACTED]/a/b/c?q=[REDACTED]');
    expect(urlFor('1;p=1,2,3,4,5,6,7,8,9,10,11,12')).toBe('/api/admin/[REDACTED]/[REDACTED]/[REDACTED]?q=[REDACTED]');
    expect(urlFor('1;p=40')).toBe('/api/admin/[REDACTED]/[REDACTED]/[REDACTED]?q=[REDACTED]');
    expect(urlFor('1;p=39')).toBe('/api/admin/a/b/c?q=[REDACTED]');
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
