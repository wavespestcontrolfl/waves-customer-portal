/**
 * email-sync upsertEmail — a sender that is one of OUR OWN addresses never
 * matches a customer record (the email mirror of the SMS owned-number
 * guard, #3829). Prod 2026-09-03: one customer record carries contact@ on
 * file, so 2,319 messages this mailbox sent to itself (backup-drill
 * failures, digests, control messages) and every outbound copy Gmail lists
 * were stored as that customer's email and rang the "email from a
 * customer" bell. Pins: an owned sender is never looked up and never
 * linked (case-insensitive, whole internal domain), and an ordinary
 * customer sender still links exactly as before.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ trashMessage: jest.fn() }));
jest.mock('../services/email/spam-blocker', () => ({
  isBlocked: jest.fn(async () => false),
  domainFromAddress: (a) => String(a || '').split('@')[1] || '',
}));
jest.mock('../services/zelle-notice-reconciler', () => ({
  ZELLE_RETRY_MARK: 'zelle_notice_retry',
  isZelleReconcileEnabled: () => false,
  sweepStaleClaims: jest.fn(async () => 0),
}));
jest.mock('../services/zelle-notice', () => ({ isZelleNoticeCandidate: () => false }));

const db = require('../models/db');
const { upsertEmail, customerEmailBellEligible } = require('../services/email/email-sync');

// Recording knex stand-in: every builder call is logged per table; awaiting
// a chain resolves from that table's scripted result.
let calls;
let results;
function installDb() {
  calls = [];
  results = { customers: null, vendor_email_domains: null, emails: { first: null, insert: ['e-1'] } };
  db.mockReset();
  db.schema = { hasColumn: jest.fn(async () => false) };
  db.mockImplementation((table) => {
    const rec = { table, ops: [] };
    calls.push(rec);
    const chain = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const out = table === 'emails'
            ? (rec.ops.some(([op]) => op === 'insert') ? results.emails.insert : results.emails.first)
            : results[table];
          return (resolve, reject) => Promise.resolve(out).then(resolve, reject);
        }
        return (...args) => { rec.ops.push([prop, args]); return chain; };
      },
    });
    return chain;
  });
}

// An outbound copy (SENT, not INBOX) takes the shortest store path; the
// customer match sits before every branch, so it is exercised the same.
const parsedFrom = (from, over = {}) => ({
  gmail_id: 'g-1', gmail_thread_id: 't-1', from_address: from, from_name: 'Waves',
  to_address: 'contact@wavespestcontrol.com', subject: 'FIX: nightly backup drill failed',
  body_text: 'x', body_html: null, snippet: 'x', has_attachments: false,
  label_ids: ['SENT'], received_at: new Date(), is_read: false, is_starred: false, ...over,
});
const customerLookups = () => calls.filter((c) => c.table === 'customers');
const insertedRow = () => {
  const ins = calls.find((c) => c.table === 'emails' && c.ops.some(([op]) => op === 'insert'));
  return ins.ops.find(([op]) => op === 'insert')[1][0];
};

describe('upsertEmail — owned-sender guard', () => {
  beforeEach(installDb);

  test('a message from one of our own addresses never looks up or links a customer', async () => {
    results.customers = { id: 'cust-with-our-address' }; // would match if consulted
    await upsertEmail(parsedFrom('contact@wavespestcontrol.com'));
    expect(customerLookups()).toHaveLength(0);
    expect(insertedRow().customer_id).toBeNull();
  });

  test('the owned check is case-insensitive and covers every address on the internal domain', async () => {
    for (const from of ['Contact@WavesPestControl.com', 'automations@wavespestcontrol.com', 'anyone@wavespestcontrol.com']) {
      installDb();
      results.customers = { id: 'cust-with-our-address' };
      await upsertEmail(parsedFrom(from));
      expect(customerLookups()).toHaveLength(0);
      expect(insertedRow().customer_id).toBeNull();
    }
  });

  test('a stored row an older pod linked to an owned sender is unlinked on resync (rolling-deploy gap)', async () => {
    results.emails.first = { id: 'e-old', gmail_id: 'g-1', customer_id: 'cust-with-our-address', auto_action: null, label_ids: ['SENT'] };
    await upsertEmail(parsedFrom('contact@wavespestcontrol.com'));
    const update = calls.find((c) => c.table === 'emails' && c.ops.some(([op]) => op === 'update')).ops.find(([op]) => op === 'update')[1][0];
    expect(update.customer_id).toBeNull();
    expect(customerLookups()).toHaveLength(0);
  });

  test('a stored customer-sender row keeps its link on resync (the update never touches customer_id)', async () => {
    results.emails.first = { id: 'e-old', gmail_id: 'g-1', customer_id: 'cust-jane', auto_action: null, label_ids: ['SENT'] };
    results.customers = { id: 'cust-jane' };
    await upsertEmail(parsedFrom('jane@example.com'));
    const update = calls.find((c) => c.table === 'emails' && c.ops.some(([op]) => op === 'update')).ops.find(([op]) => op === 'update')[1][0];
    expect('customer_id' in update).toBe(false);
  });

  test('a customer sender still matches case-insensitively and links', async () => {
    results.customers = { id: 'cust-jane' };
    await upsertEmail(parsedFrom('Jane@Example.com'));
    const [lookup] = customerLookups();
    expect(lookup.ops).toEqual(expect.arrayContaining([['whereRaw', ['LOWER(email) = ?', ['jane@example.com']]]]));
    expect(insertedRow().customer_id).toBe('cust-jane');
  });
});

describe('customerEmailBellEligible — an owned sender never rings', () => {
  // A row linked before the guard, or by an older pod mid-deploy, still
  // carries a customer_id when the existing-row recovery and the sweep
  // re-offer it; the bell must refuse it on the address alone.
  const aligned = {
    customerId: 'cust-with-our-address', classification: null, listUnsubscribe: null, labelIds: ['INBOX'],
    receivedAt: new Date(), authenticationResults: 'mx.google.com; dkim=pass header.d=wavespestcontrol.com; spf=pass smtp.mailfrom=wavespestcontrol.com',
  };
  test('authenticated mail from our own address, linked to a customer, is not a bell candidate', () => {
    expect(customerEmailBellEligible({ ...aligned, fromAddress: 'contact@wavespestcontrol.com' })).toBe(false);
    expect(customerEmailBellEligible({ ...aligned, fromAddress: 'Contact@WavesPestControl.com' })).toBe(false);
  });
  test('the same shape from a customer domain still rings', () => {
    expect(customerEmailBellEligible({ ...aligned, fromAddress: 'jane@example.com', authenticationResults: 'mx.google.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com' })).toBe(true);
  });
});
