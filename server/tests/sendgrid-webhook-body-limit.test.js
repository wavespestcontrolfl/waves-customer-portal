/**
 * POST /api/webhooks/sendgrid/events — body size and in-flight budget
 * (sweep #7765 B6).
 *
 * SendGrid posts many events in one JSON array. body-parser's 100 KB default
 * answered 413 before the signature check, and SendGrid re-sent the same
 * batch until it gave up, so the bounces in it were never recorded. A signed
 * batch of a few hundred KB must reach the handler. Because every body is
 * buffered before the signature check, the route also holds a byte budget:
 * an over-cap Content-Length is refused before the body is read, a full
 * budget answers 503 (SendGrid retries), and bytes come back when a request
 * finishes, aborts or stalls. Invented data only.
 */
const crypto = require('crypto');
const http = require('http');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const router = require('../routes/webhooks-sendgrid');

const budget = router._eventsBodyBudget;
const MB = 1024 * 1024;
const PATH = '/api/webhooks/sendgrid/events';
let server;
let port;
const held = [];

function sign(body, ts) {
  return crypto.sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('base64');
}

function signedHeaders(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'x-twilio-email-event-webhook-signature': sign(body, ts),
    'x-twilio-email-event-webhook-timestamp': ts,
  };
}

async function postSigned(body) {
  const res = await fetch(`http://127.0.0.1:${port}${PATH}`, { method: 'POST', headers: signedHeaders(body), body });
  return { status: res.status, text: await res.text() };
}

// Sends the headers (and an optional first chunk) and keeps the body open:
// the request holds its share of the budget until it is destroyed.
function openUpload(declaredBytes, firstChunk = '[', extraHeaders = {}) {
  const req = http.request({
    host: '127.0.0.1', port, path: PATH, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(declaredBytes), ...extraHeaders },
  });
  const response = new Promise((resolve) => {
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, closed: false }); });
    req.on('error', () => resolve({ status: null, closed: true }));
    req.on('close', () => resolve({ status: null, closed: true }));
  });
  req.flushHeaders();
  if (firstChunk) req.write(firstChunk);
  held.push(req);
  return { req, response };
}

async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A valid, signed, empty event array padded to the given size: it passes the
// signature check and processes zero events, so no database is needed.
const paddedEmptyBatch = (bytes) => `[${' '.repeat(bytes)}]`;

beforeAll(async () => {
  const app = express();
  app.use('/api/webhooks/sendgrid', router);
  server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  ({ port } = server.address());
});

afterEach(async () => {
  while (held.length) held.pop().destroy();
  budget.uploadTimeoutMs = 30 * 1000;
  await waitFor(() => budget.inFlightBytes === 0);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('SendGrid event webhook body size and in-flight budget', () => {
  test('a signed 300 KB batch reaches the handler instead of a 413, and its bytes are released', async () => {
    const res = await postSigned(paddedEmptyBatch(300 * 1024));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ received: 0, processed: 0 });
    await waitFor(() => budget.inFlightBytes === 0);
  });

  test('a Content-Length over the cap gets 413 before any body byte is sent', async () => {
    const { response } = openUpload(6 * MB, null);
    await expect(response).resolves.toMatchObject({ status: 413 });
    expect(budget.inFlightBytes).toBe(0);
  });

  test('a full budget answers 503 before reading; bytes come back when the uploads end', async () => {
    const perUpload = 5 * MB;
    const slots = budget.budgetBytes / perUpload;
    for (let i = 0; i < slots; i += 1) openUpload(perUpload);
    await waitFor(() => budget.inFlightBytes === budget.budgetBytes);

    const busy = await postSigned('[]');
    expect(busy.status).toBe(503);

    while (held.length) held.pop().destroy();
    await waitFor(() => budget.inFlightBytes === 0);

    const after = await postSigned('[]');
    expect(after.status).toBe(200);
  });

  test('a compressed upload holds the full cap, whatever its Content-Length', async () => {
    // express.raw inflates gzip before the 5 MB cap applies, so 1 KB on the
    // wire can still fill 5 MB of memory.
    const slots = budget.budgetBytes / (5 * MB);
    for (let i = 0; i < slots; i += 1) openUpload(1024, null, { 'content-encoding': 'gzip' });
    await waitFor(() => budget.inFlightBytes === budget.budgetBytes);

    expect((await postSigned('[]')).status).toBe(503);
  });

  test('a finished request frees its bytes for the next one', async () => {
    // Open uploads leave exactly room for one more 5 MB body.
    for (let i = 1; i < budget.budgetBytes / (5 * MB); i += 1) openUpload(5 * MB);
    await waitFor(() => budget.inFlightBytes === budget.budgetBytes - 5 * MB);

    const body = paddedEmptyBatch(5 * MB - 2);
    expect((await postSigned(body)).status).toBe(200);
    await waitFor(() => budget.inFlightBytes === budget.budgetBytes - 5 * MB);
    expect((await postSigned(body)).status).toBe(200);
  });

  test('a stalled upload is cut off after the upload deadline and frees its bytes', async () => {
    budget.uploadTimeoutMs = 100;
    const { response } = openUpload(1 * MB);
    await waitFor(() => budget.inFlightBytes === 1 * MB);
    await expect(response).resolves.toMatchObject({ closed: true });
    await waitFor(() => budget.inFlightBytes === 0);
  });
});
