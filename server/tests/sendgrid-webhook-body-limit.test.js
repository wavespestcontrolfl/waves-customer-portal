/**
 * POST /api/webhooks/sendgrid/events — body size (sweep #7765 B6).
 *
 * SendGrid posts many events in one JSON array. body-parser's 100 KB default
 * answered 413 before the signature check, and SendGrid re-sent the same
 * batch until it gave up, so the bounces in it were never recorded. A signed
 * batch of a few hundred KB must reach the handler; a limit still exists.
 * Invented data only.
 */
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const router = require('../routes/webhooks-sendgrid');

function sign(body, ts) {
  return crypto.sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('base64');
}

async function postRaw(body) {
  const app = express();
  app.use('/api/webhooks/sendgrid', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/sendgrid/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-twilio-email-event-webhook-signature': sign(body, ts),
        'x-twilio-email-event-webhook-timestamp': ts,
      },
      body,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// A valid, signed, empty event array padded to the given size: it passes the
// signature check and processes zero events, so no database is needed.
const paddedEmptyBatch = (bytes) => `[${' '.repeat(bytes)}]`;

describe('SendGrid event webhook body size', () => {
  test('a signed 300 KB batch reaches the handler instead of a 413', async () => {
    const res = await postRaw(paddedEmptyBatch(300 * 1024));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ received: 0, processed: 0 });
  });

  test('a body over the limit is still refused before the handler', async () => {
    const res = await postRaw(paddedEmptyBatch(6 * 1024 * 1024));
    expect(res.status).toBe(413);
  });
});
