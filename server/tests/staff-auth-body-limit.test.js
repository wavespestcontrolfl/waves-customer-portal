const http = require('http');
const express = require('express');
const {
  STAFF_AUTH_BODY_LIMIT,
  staffAuthBodyParsers,
} = require('../middleware/staff-auth-body');

function postJson(server, path, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let payload = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { payload += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, payload }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

describe('Staff auth body limit', () => {
  let server;
  let handler;

  beforeEach(async () => {
    handler = jest.fn((req, res) => res.json({ ok: true, body: req.body }));
    const app = express();
    app.use('/api/admin/auth', ...staffAuthBodyParsers);
    for (const route of ['login', 'forgot-password', 'reset-password']) {
      app.post(`/api/admin/auth/${route}`, handler);
    }
    app.use((error, _req, res, _next) => {
      res.status(error.status || 500).json({ error: error.type || error.message });
    });
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test.each(['login', 'forgot-password', 'reset-password'])(
    'returns 413 before the %s handler for oversized JSON',
    async (route) => {
      const oversized = JSON.stringify({ value: 'x'.repeat(17 * 1024) });
      const result = await postJson(server, `/api/admin/auth/${route}`, oversized);

      expect(STAFF_AUTH_BODY_LIMIT).toBe('16kb');
      expect(result.status).toBe(413);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  test('parses a normal credential payload before the route handler', async () => {
    const result = await postJson(
      server,
      '/api/admin/auth/login',
      JSON.stringify({ email: 'admin@example.test', password: 'small-password' }),
    );

    expect(result.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].body).toEqual({
      email: 'admin@example.test',
      password: 'small-password',
    });
  });
});
