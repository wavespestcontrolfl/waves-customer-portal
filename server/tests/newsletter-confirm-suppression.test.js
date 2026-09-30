/**
 * B13: the newsletter double-opt-in confirmation email bypasses SendGrid's
 * suppression group (asmGroupId 0), so the app-level vetoes must run at the
 * sendConfirmationEmail chokepoint — for EVERY caller (public form, quote
 * wizard, admin import, call pipeline, email fanout). A mocked db decides
 * each veto here; the real SQL runs in newsletter-confirm-suppression-postgres.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendOne: jest.fn(async () => ({ messageId: 'sg-1' })),
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
const { sendConfirmationEmail } = require('../services/newsletter-confirm');

// Per-table canned results. A value that is an Error is thrown by the query.
let tables;
function fakeQuery(table) {
  const q = {};
  const settle = () => {
    const v = tables[table];
    if (v instanceof Error) throw v;
    return v;
  };
  ['where', 'whereRaw', 'orWhere', 'orWhereRaw', 'orWhereNull', 'whereNull', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => { const v = settle(); return Array.isArray(v) ? v[0] || null : v || null; });
  q.then = (res, rej) => Promise.resolve().then(() => settle() || []).then(res, rej);
  return q;
}

const SUB = { id: 'sub-1', email: 'Neighbor@Example.com', first_name: 'Pat', confirmation_token: 'tok-1', customer_id: null };

beforeEach(() => {
  jest.clearAllMocks();
  tables = { email_suppressions: [], customers: [], call_log: [] };
  db.mockImplementation((t) => fakeQuery(t));
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
