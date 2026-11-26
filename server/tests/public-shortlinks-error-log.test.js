/**
 * A failed /l/:code lookup logs a driver code only. The short code fronts a bearer-token URL, and a knex error message carries
 * its bound values (the code itself), so the raw code and the database message never reach the log.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'shortlink-error-log-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use('/l', require('../routes/public-shortlinks'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

test('a database failure answers 500 and logs the driver code, never the short code or the message', async () => {
  const code = 'abcdefghjk';
  db.mockImplementation(() => ({
    where: () => ({
      first: async () => { throw Object.assign(new Error(`select * from "short_codes" where "code" = '${code}' - connection terminated`), { code: '57P01' }); },
    }),
  }));
  const res = await fetch(`${base}/l/${code}`, { redirect: 'manual' });
  expect(res.status).toBe(500);
  const logged = JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls]);
  expect(logged).not.toContain(code);
  expect(logged).not.toContain('connection terminated');
  expect(logged).toContain('code=57P01');
});
