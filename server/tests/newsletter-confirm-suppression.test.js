/**
 * B13: the newsletter double-opt-in confirmation email bypasses SendGrid's
 * suppression group (asmGroupId 0), so the app-level vetoes must run at the
 * sendConfirmationEmail chokepoint — for EVERY caller (public form, quote
 * wizard, admin import, call pipeline, email fanout). A mocked db decides
 * each veto here; the real SQL runs in newsletter-confirm-suppression-postgres.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
const mockOrder = [];
jest.mock('../services/sendgrid-mail', () => ({
  isDefiniteRejection: (err) => new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]).has(Number(err?.status)),
  isConfigured: () => true,
  sendOne: jest.fn(async () => { mockOrder.push('send'); return { messageId: 'sg-1' }; }),
}));
jest.mock('../models/db', () => jest.fn());
const mockDnc = jest.fn();
jest.mock('../services/lead-first-touch-resume', () => ({
  customerCallDoNotContact: (...a) => mockDnc(...a),
}));
const mockSubscribe = jest.fn();
jest.mock('../services/newsletter-subscribers', () => ({
  subscribeOrResubscribe: (...a) => mockSubscribe(...a),
  lookupByToken: jest.fn(),
  confirmByToken: jest.fn(),
  EMAIL_RE: /.+@.+/,
}));

const express = require('express');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const { sendConfirmationEmail, CONFIRMATION_SEND_TIMEOUT_MS } = require('../services/newsletter-confirm');

// Per-table canned results. A value that is an Error is thrown by the query.
let tables;
let ownershipBusy;
let ownershipWaitTimesOut;
function fakeQuery(table) {
  const q = {};
  const settle = () => {
    const v = tables[table];
    if (v instanceof Error) throw v;
    return v;
  };
  ['where', 'whereRaw', 'orWhere', 'orWhereRaw', 'orWhereNull', 'whereNull', 'whereNotNull', 'select'].forEach((m) => {
    q[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; });
  });
  q.first = jest.fn(async () => { mockOrder.push(`read:${table}`); const v = settle(); return Array.isArray(v) ? v[0] || null : v || null; });
  q.then = (res, rej) => Promise.resolve().then(() => { mockOrder.push(`read:${table}`); return settle() || []; }).then(res, rej);
  return q;
}
// A transaction-shaped handle: records advisory-lock and read order.
function makeTrx() {
  const trx = jest.fn((t) => fakeQuery(t));
  trx.isTransaction = true;
  trx.raw = jest.fn(async (sql, bindings) => {
    const key = bindings && bindings[0];
    if (/pg_try_advisory_xact_lock/.test(sql)) {
      mockOrder.push(`try:${key}`);
      return { rows: [{ locked: !ownershipBusy }] };
    }
    if (/current_setting\('lock_timeout'\)/.test(sql)) return { rows: [{ value: '0' }] };
    if (/set_config\('lock_timeout'/.test(sql)) { mockOrder.push(`timeout:${key}`); return { rows: [] }; }
    if (/^SELECT pg_advisory_xact_lock/.test(sql) && /^email-ownership:/.test(String(key))) {
      mockOrder.push(`wait:${key}`);
      if (ownershipWaitTimesOut) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      return { rows: [] };
    }
    mockOrder.push(`lock:${key}`);
    return { rows: [] };
  });
  trx.transaction = jest.fn(async (fn) => fn(trx));
  return trx;
}
let rootTrx;

const SUB = { id: 'sub-1', email: 'Neighbor@Example.com', first_name: 'Pat', confirmation_token: 'tok-1', customer_id: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockOrder.length = 0;
  ownershipBusy = false;
  ownershipWaitTimesOut = false;
  tables = { email_suppressions: [], customers: [], notification_prefs: [], leads: [], estimates: [], call_log: [] };
  rootTrx = makeTrx();
  db.mockImplementation((t) => fakeQuery(t));
  db.transaction = jest.fn(async (fn) => fn(rootTrx));
  mockDnc.mockResolvedValue(false);
});

describe('sendConfirmationEmail vetoes (chokepoint)', () => {
  test('a normal address still gets the confirmation', async () => {
    const r = await sendConfirmationEmail(SUB);
    expect(r.messageId).toBe('sg-1');
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });

  test.each(['do_not_email', 'bounce', 'spam_complaint'])('an active %s suppression blocks the send', async (type) => {
    tables.email_suppressions = [{ id: 's1', suppression_type: type }];
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ code: 'confirmation_vetoed', reason: 'address_suppressed' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a do-not-contact request on the linked customer blocks the send', async () => {
    mockDnc.mockImplementation(async (id) => id === 'cust-1');
    await expect(sendConfirmationEmail({ ...SUB, customer_id: 'cust-1' }))
      .rejects.toMatchObject({ code: 'confirmation_vetoed', reason: 'do_not_contact' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a do-not-contact request on ANY profile carrying the mailbox blocks the send', async () => {
    tables.customers = [{ id: 'cust-9' }];
    mockDnc.mockImplementation(async (id) => id === 'cust-9');
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ reason: 'do_not_contact' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('profiles with no do-not-contact request do not block', async () => {
    tables.customers = [{ id: 'cust-9' }];
    await sendConfirmationEmail({ ...SUB, customer_id: 'cust-1' });
    expect(mockDnc).toHaveBeenCalledTimes(2);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });

  test('suppression lookup error = no send (fail closed)', async () => {
    tables.email_suppressions = new Error('connection terminated');
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ code: 'confirmation_vetoed', reason: 'veto_unverifiable' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('customer lookup error = no send (fail closed)', async () => {
    tables.customers = new Error('boom');
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ reason: 'veto_unverifiable' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('do-not-contact lookup error = no send (fail closed)', async () => {
    mockDnc.mockRejectedValue(new Error('boom'));
    await expect(sendConfirmationEmail({ ...SUB, customer_id: 'cust-1' })).rejects.toMatchObject({ reason: 'veto_unverifiable' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('the veto error and logs never carry the address', async () => {
    const logger = require('../services/logger');
    tables.email_suppressions = new Error('connection terminated');
    const err = await sendConfirmationEmail(SUB).catch((e) => e);
    expect(err.message).not.toMatch(/example\.com/i);
    for (const call of logger.warn.mock.calls) expect(call[0]).not.toMatch(/example\.com/i);
  });
});

describe('locking, ordering and connection reuse (B13 review)', () => {
  test('address key -> ownership fence -> reads -> send, all on ONE transaction', async () => {
    await sendConfirmationEmail(SUB);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const emailLc = 'neighbor@example.com';
    expect(mockOrder.slice(0, 2)).toEqual([`lock:customer-email:${emailLc}`, `try:email-ownership:customer-email:${emailLc}`]);
    const firstRead = mockOrder.findIndex((e) => e.startsWith('read:'));
    const send = mockOrder.indexOf('send');
    expect(firstRead).toBeGreaterThan(1);
    expect(send).toBeGreaterThan(firstRead);
    expect(mockOrder.slice(send + 1)).toEqual([]);
  });

  test('a Google address also takes its mailbox key, in the global sorted order, before the fence', async () => {
    await sendConfirmationEmail({ ...SUB, email: 'Pat.Smith+news@gmail.com' });
    expect(mockOrder.slice(0, 4)).toEqual([
      'lock:customer-email:pat.smith+news@gmail.com',
      'lock:customer-mailbox:patsmith@gmail.com',
      'try:email-ownership:customer-email:pat.smith+news@gmail.com',
      'try:email-ownership:customer-mailbox:patsmith@gmail.com',
    ]);
  });

  test('a caller-supplied transaction is reused: no second connection is opened', async () => {
    const callerTrx = makeTrx();
    await sendConfirmationEmail(SUB, { dbh: callerTrx });
    // sendOne's own DB reads (annual-offer guard, link rewrite) ride the same connection.
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ database: callerTrx }));
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(callerTrx.raw).toHaveBeenCalled();
    expect(callerTrx).toHaveBeenCalledWith('email_suppressions');
    expect(mockOrder).toContain('send');
  });

  test('a non-transaction handle is wrapped in a transaction rather than fencing nothing', async () => {
    const plain = jest.fn((t) => fakeQuery(t));
    plain.transaction = jest.fn(async (fn) => fn(rootTrx));
    await sendConfirmationEmail(SUB, { dbh: plain });
    expect(plain.transaction).toHaveBeenCalledTimes(1);
    expect(mockOrder).toContain('send');
  });

  test('a busy ownership fence WAITS (bounded) and then sends once the writer is done', async () => {
    ownershipBusy = true; // the non-blocking try is refused, the bounded wait succeeds
    await sendConfirmationEmail(SUB);
    const emailLc = 'neighbor@example.com';
    expect(mockOrder.slice(0, 5)).toEqual([
      `lock:customer-email:${emailLc}`,
      `try:email-ownership:customer-email:${emailLc}`,
      'timeout:3000ms',
      `wait:email-ownership:customer-email:${emailLc}`,
      'timeout:0',
    ]);
    expect(mockOrder).toContain('send');
    expect(mockOrder.indexOf('send')).toBeGreaterThan(mockOrder.findIndex((e) => e.startsWith('read:')));
  });

  test('a Google address waits on both ownership keys in the sorted order', async () => {
    ownershipBusy = true;
    await sendConfirmationEmail({ ...SUB, email: 'Pat.Smith+news@gmail.com' });
    const waits = mockOrder.filter((e) => e.startsWith('wait:'));
    expect(waits).toEqual([
      'wait:email-ownership:customer-email:pat.smith+news@gmail.com',
      'wait:email-ownership:customer-mailbox:patsmith@gmail.com',
    ]);
  });

  test('a writer that outlasts the wait refuses the send and reads nothing', async () => {
    ownershipBusy = true;
    ownershipWaitTimesOut = true;
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ code: 'confirmation_vetoed', reason: 'ownership_busy' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(mockOrder.some((e) => e.startsWith('read:'))).toBe(false);
  });

  test('a zero wait refuses at once without blocking', async () => {
    ownershipBusy = true;
    const { assertConfirmationAllowed } = require('../services/newsletter-confirm');
    await expect(assertConfirmationAllowed(SUB, rootTrx, { ownershipWaitMs: 0 })).rejects.toMatchObject({ reason: 'ownership_busy' });
    expect(mockOrder.some((e) => e.startsWith('wait:'))).toBe(false);
  });

  test('a failing lock statement fails closed', async () => {
    rootTrx.raw.mockRejectedValueOnce(new Error('lock timeout'));
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ reason: 'veto_unverifiable' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('reads run inside a savepoint on the caller transaction', async () => {
    await sendConfirmationEmail(SUB);
    expect(rootTrx.transaction).toHaveBeenCalledTimes(1);
  });

  test('ownership is read from customers (real columns only) and notification_prefs.billing_email', async () => {
    const cols = [];
    const fq = rootTrx.getMockImplementation();
    rootTrx.mockImplementation((t) => {
      const q = fq(t);
      const raw = q.whereRaw;
      q.whereRaw = jest.fn((sql, ...r) => { cols.push(`${t}:${sql}`); return raw(sql, ...r); });
      q.orWhereRaw = jest.fn((sql, ...r) => { cols.push(`${t}:${sql}`); return q; });
      return q;
    });
    await sendConfirmationEmail(SUB);
    const customers = cols.filter((c) => c.startsWith('customers:')).join('\n');
    expect(customers).not.toMatch(/billing_email/);
    for (const c of ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email']) {
      expect(customers).toMatch(new RegExp(`BTRIM\\(${c}\\)`));
    }
    expect(cols.filter((c) => c.startsWith('notification_prefs:')).join('\n')).toMatch(/BTRIM\(billing_email\)/);
  });

  test('a do-not-contact request on a billing_email owner blocks the send', async () => {
    tables.notification_prefs = [{ customer_id: 'cust-billing' }];
    mockDnc.mockImplementation(async (id) => id === 'cust-billing');
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ reason: 'do_not_contact' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('notification_prefs lookup error = no send (fail closed)', async () => {
    tables.notification_prefs = new Error('boom');
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ reason: 'veto_unverifiable' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('provider timeout bound while the connection and address lock are held', () => {
  test('the confirmation send asks for the short dedicated timeout', async () => {
    await sendConfirmationEmail(SUB);
    expect(CONFIRMATION_SEND_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: CONFIRMATION_SEND_TIMEOUT_MS }));
  });

  test('a provider timeout is a failed send: it rejects, and the public route answers uniformly', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ name: 'TimeoutError' });

    const router = require('../routes/public-newsletter');
    const app = express();
    app.use(express.json());
    app.use('/api/public/newsletter', router);
    mockSubscribe.mockResolvedValue({ action: 'confirmation_sent', subscriber: SUB });
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/public/newsletter/subscribe`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'neighbor@example.com' }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ success: true, pending: true });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('delivery-ambiguous provider failures', () => {
  const { isDeliveryAmbiguous } = require('../services/newsletter-confirm');

  test.each([
    ['timeout after dispatch', Object.assign(new Error('t'), { name: 'TimeoutError' }), true],
    ['abort', Object.assign(new Error('a'), { name: 'AbortError' }), true],
    ['5xx', Object.assign(new Error('x'), { status: 503 }), true],
    ['timeout-style 408', Object.assign(new Error('x'), { status: 408 }), true],
    ['network failure', new TypeError('fetch failed'), true],
    ['network failure with a socket cause', Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }), true],
    ['a plain TypeError before dispatch (code bug)', new TypeError("Cannot read properties of undefined (reading 'x')"), false],
    ['definite 422 rejection', Object.assign(new Error('x'), { status: 422 }), false],
    ['definite 400 rejection', Object.assign(new Error('x'), { status: 400 }), false],
    ['not configured (no request made)', Object.assign(new Error('x'), { code: 'SENDGRID_NOT_CONFIGURED' }), false],
    ['annual-offer guard (no request made)', Object.assign(new Error('x'), { annualOfferWithheld: true }), false],
    ['annual-offer guard lookup failure (no request made)', Object.assign(new Error('x'), { annualOfferGuardFailed: true }), false],
  ])('%s', (_name, err, expected) => {
    expect(isDeliveryAmbiguous(err)).toBe(expected);
  });

  test('sendConfirmationEmail tags an ambiguous send failure and leaves a definite one untagged', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ deliveryAmbiguous: true });
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 422 }));
    const definite = await sendConfirmationEmail(SUB).catch((e) => e);
    expect(definite.deliveryAmbiguous).toBeUndefined();
  });

  test('a veto is never tagged ambiguous (nothing was dispatched)', async () => {
    tables.email_suppressions = [{ id: 's1', suppression_type: 'do_not_email' }];
    const err = await sendConfirmationEmail(SUB).catch((e) => e);
    expect(err.deliveryAmbiguous).toBeUndefined();
  });
});

describe('POST /api/public/newsletter/subscribe with a vetoed address', () => {
  async function post(email) {
    const router = require('../routes/public-newsletter');
    const app = express();
    app.use(express.json());
    app.use('/api/public/newsletter', router);
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/public/newsletter/subscribe`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
      });
      return { status: r.status, body: await r.json() };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  beforeEach(() => {
    mockSubscribe.mockResolvedValue({ action: 'confirmation_resent', subscriber: SUB });
  });

  test('answers exactly like a normal subscribe and sends nothing', async () => {
    const normal = await post('neighbor@example.com');
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    sendgrid.sendOne.mockClear();

    tables.email_suppressions = [{ id: 's1', suppression_type: 'do_not_email' }];
    const vetoed = await post('neighbor@example.com');
    expect(vetoed).toEqual(normal);
    expect(vetoed).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    // A failed / vetoed public send leaves the row exactly as a provider failure always has
    // (stamp kept; a repeat post re-sends): the route writes nothing after the send.
    expect(db.mock.calls.filter((c) => c[0] === 'newsletter_subscribers')).toHaveLength(0);
  });

  test('a veto lookup error also answers uniformly and sends nothing', async () => {
    tables.email_suppressions = new Error('connection terminated');
    const r = await post('neighbor@example.com');
    expect(r).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('transactional callers hand their own connection to the send (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'services', f), 'utf8');

  test('call pipeline: address key before the subscriber row lock, send on the same trx', () => {
    const src = read('call-recording-processor.js');
    expect(src).toContain('sendConfirmationEmail(result.subscriber, { dbh: trx })');
    const keyAt = src.indexOf(".lockCustomerEmail(trx, String(result.subscriber.email || emailLc)");
    const rowAt = src.indexOf('.forUpdate()', keyAt);
    expect(keyAt).toBeGreaterThan(0);
    expect(rowAt).toBeGreaterThan(keyAt);
  });

  test('email fanout: both DOI transactions lock the address first and send on trx', () => {
    const src = read('customer-email-fanout.js');
    expect((src.match(/sendConfirmationEmail\(pendingConfirmation, \{ dbh: trx \}\)/g) || []).length).toBe(2);
    expect((src.match(/lockCustomerEmail\(trx, sentEmailLc\)/g) || []).length).toBe(2);
  });
});
