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
const mockUpdates = [];
jest.mock('../services/sendgrid-mail', () => ({
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
const { sendConfirmationEmail, releaseUnsentConfirmationStamp, ConfirmationVetoedError } = require('../services/newsletter-confirm');

// Per-table canned results. A value that is an Error is thrown by the query.
let tables;
let ownershipBusy;
function fakeQuery(table) {
  const q = {};
  const settle = () => {
    const v = tables[table];
    if (v instanceof Error) throw v;
    return v;
  };
  ['where', 'whereRaw', 'orWhere', 'orWhereRaw', 'orWhereNull', 'whereNull', 'select'].forEach((m) => {
    q[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; });
  });
  q.update = jest.fn(async (patch) => { mockUpdates.push({ table, patch, wheres: q.where.mock.calls.map((c) => c[0]) }); return 1; });
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
  mockUpdates.length = 0;
  ownershipBusy = false;
  tables = { email_suppressions: [], customers: [], notification_prefs: [], call_log: [] };
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

  test('a busy ownership fence refuses the send and reads nothing', async () => {
    ownershipBusy = true;
    await expect(sendConfirmationEmail(SUB)).rejects.toMatchObject({ code: 'confirmation_vetoed', reason: 'ownership_busy' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(mockOrder.some((e) => e.startsWith('read:'))).toBe(false);
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
  });

  test('a veto lookup error also answers uniformly and sends nothing', async () => {
    tables.email_suppressions = new Error('connection terminated');
    const r = await post('neighbor@example.com');
    expect(r).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('pre-stamp release after a failed send (public callers)', () => {
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
  const stampClears = () => mockUpdates.filter((u) => u.table === 'newsletter_subscribers' && u.patch.confirmation_sent_at === null);

  beforeEach(() => { mockSubscribe.mockResolvedValue({ action: 'confirmation_resent', subscriber: { ...SUB, confirmation_sent_at: new Date('2026-09-29T12:00:00.000Z') } }); });

  test('a transient ownership_busy veto clears the pre-stamp; the response stays uniform', async () => {
    ownershipBusy = true;
    const r = await post('neighbor@example.com');
    expect(r).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(stampClears()).toHaveLength(1);
  });

  test('an unverifiable veto lookup clears the pre-stamp', async () => {
    tables.email_suppressions = new Error('connection terminated');
    const r = await post('neighbor@example.com');
    expect(r.status).toBe(200);
    expect(stampClears()).toHaveLength(1);
  });

  test('permanent vetoes (suppressed, do-not-contact) leave the row stamped: no retry', async () => {
    // Direct (the route's per-IP limiter caps posts per minute in one file).
    tables.email_suppressions = [{ id: 's1', suppression_type: 'do_not_email' }];
    const stamped = { ...SUB, confirmation_sent_at: new Date() };
    const suppressed = await sendConfirmationEmail(stamped).catch((e) => e);
    expect(await releaseUnsentConfirmationStamp(stamped, suppressed)).toBe(false);
    tables.email_suppressions = [];
    mockDnc.mockResolvedValue(true);
    tables.customers = [{ id: 'c1' }];
    const dnc = await sendConfirmationEmail(SUB).catch((e) => e);
    expect(dnc.reason).toBe('do_not_contact');
    expect(await releaseUnsentConfirmationStamp(stamped, dnc)).toBe(false);
    expect(mockUpdates.filter((u) => u.patch.confirmation_sent_at === null)).toHaveLength(0);
  });

  test('a successful send leaves the stamp alone', async () => {
    await sendConfirmationEmail(SUB);
    expect(stampClears()).toHaveLength(0);
  });

  const STAMP = new Date('2026-09-29T12:00:00.000Z');
  const PRIOR = new Date('2026-09-20T12:00:00.000Z');
  const STAMPED = { ...SUB, confirmation_sent_at: STAMP };

  test('release is a compare-and-set on the exact pre-stamp, scoped to email + token + pending, and never throws', async () => {
    const ok = await releaseUnsentConfirmationStamp(STAMPED, new ConfirmationVetoedError('ownership_busy'));
    expect(ok).toBe(true);
    const u = mockUpdates.find((x) => x.table === 'newsletter_subscribers');
    expect(u.wheres).toContainEqual({ id: 'sub-1', confirmation_token: 'tok-1', status: 'pending', confirmation_sent_at: STAMP });
    expect(u.patch.confirmation_sent_at).toBeNull();
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(releaseUnsentConfirmationStamp(STAMPED, new Error('sendgrid'))).resolves.toBe(false);
  });

  test('a prior real delivery is RESTORED, never nulled', async () => {
    await releaseUnsentConfirmationStamp(STAMPED, new Error('sendgrid down'), { restoreTo: PRIOR });
    const u = mockUpdates.find((x) => x.table === 'newsletter_subscribers');
    expect(u.patch.confirmation_sent_at).toBe(PRIOR);
  });

  test('a subscriber without a recorded pre-stamp is left alone', async () => {
    expect(await releaseUnsentConfirmationStamp(SUB, new Error('x'))).toBe(false);
    expect(mockUpdates).toHaveLength(0);
  });

  test('both public routes hand the prior stamp to the release (source pin; the limiter caps posts per minute)', () => {
    const fs = require('fs');
    for (const f of ['public-newsletter.js', 'public-quote.js']) {
      const src = fs.readFileSync(require('path').join(__dirname, '..', 'routes', f), 'utf8');
      expect(src).toContain('await releaseUnsentConfirmationStamp(result.subscriber, e, { restoreTo: result.priorConfirmationSentAt })');
    }
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
