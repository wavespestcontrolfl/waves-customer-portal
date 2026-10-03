// Report text to on-location contacts (GATE_CONTACT_REPORT_TEXT, owner
// 2026-10-03): one plain text with the report link to each confirmed contact
// when the account holder's visit-complete text goes out.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/recipient-optin', () => ({
  optinHeldPhoneKeys: jest.fn(async () => new Map()),
  resolveServiceContactSmsRecipient: jest.fn(),
}));
// A knex stand-in: each db(table) call returns a chain that records its
// calls and resolves to the next queued result for that table.
jest.mock('../models/db', () => {
  const state = { queue: {}, calls: [] };
  const db = jest.fn((table) => {
    const call = { table, ops: [] };
    state.calls.push(call);
    const next = () => {
      const q = state.queue[table] || [];
      const value = q.length ? q.shift() : undefined;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve, reject) => next().then(resolve, reject);
        if (prop === 'catch') return (reject) => next().catch(reject);
        return (...args) => {
          // A where(fn) builder callback is recorded, not run.
          call.ops.push([prop, ...args.map((a) => (typeof a === 'function' ? '[fn]' : a))]);
          return chain;
        };
      },
    });
    return chain;
  });
  db.raw = (sql) => ({ raw: sql });
  db.mockState = state;
  return db;
});

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { optinHeldPhoneKeys } = require('../services/recipient-optin');
const ContactReportText = require('../services/contact-report-text');

const CUSTOMER = {
  id: 'cust-1', first_name: 'Dana', phone: '+19415550100', address_line1: '12 Example Way',
  service_contact_name: 'Riley Tenant', service_contact_phone: '(941) 555-0123',
  service_contact2_name: 'Morgan Manager', service_contact2_phone: '941-555-0456',
  service_contact3_name: 'Dana Again', service_contact3_phone: '941-555-0100', // the holder's own number
  service_contacts_consent_at: new Date('2026-09-30T12:00:00Z'),
};
const ROW = {
  id: 'row-1', customer_id: 'cust-1', source_key: 'record:rec-1', scheduled_service_id: 'svc-1',
  phone_key: '9415550123', phone_e164: '(941) 555-0123', report_url: 'https://portal.example/report/tok',
  status: 'pending', attempts: 1, created_at: new Date(),
};
const queue = (table, ...values) => { db.mockState.queue[table] = [...(db.mockState.queue[table] || []), ...values]; };
const opsFor = (table) => db.mockState.calls.filter((c) => c.table === table);
const lastUpdate = () => {
  const updates = opsFor('contact_report_texts').map((c) => c.ops.find((o) => o[0] === 'update')).filter(Boolean);
  return updates[updates.length - 1][1];
};
// The reads a dispatch makes up to the send, for a contact still confirmed.
const queueDispatchReads = (row = ROW) => {
  // The claim, then the send_started_at stamp (1 row updated).
  queue('contact_report_texts', [row], 1);
  queue('customers', CUSTOMER);
  queue('scheduled_services', { service_address_line1: '12 Example Way' });
};

beforeEach(() => {
  process.env.GATE_CONTACT_REPORT_TEXT = 'true';
  db.mockClear();
  db.mockState.queue = {};
  db.mockState.calls = [];
  sendCustomerMessage.mockReset();
  renderSmsTemplate.mockReset().mockResolvedValue('Waves Pest Control: The service report for 12 Example Way is ready: https://portal.example/report/tok');
  optinHeldPhoneKeys.mockReset().mockResolvedValue(new Map());
});
afterAll(() => { delete process.env.GATE_CONTACT_REPORT_TEXT; });

describe('gate', () => {
  test('dark unless exactly true', () => {
    for (const value of [undefined, '', '1', 'on', 'TRUE']) {
      if (value === undefined) delete process.env.GATE_CONTACT_REPORT_TEXT; else process.env.GATE_CONTACT_REPORT_TEXT = value;
      expect(ContactReportText.enabled()).toBe(false);
    }
    process.env.GATE_CONTACT_REPORT_TEXT = 'true';
    expect(ContactReportText.enabled()).toBe(true);
  });

  test('off: nothing is queued and the database is not read', async () => {
    delete process.env.GATE_CONTACT_REPORT_TEXT;
    expect(await ContactReportText.queueContactReportTexts({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' })).toEqual([]);
    expect(await ContactReportText.sweepContactReportTexts()).toEqual({ dispatched: 0 });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('queueContactReportTexts', () => {
  test('one row per confirmed contact; never the account holder', async () => {
    queue('customers', CUSTOMER);
    queue('contact_report_texts', [{ id: 'row-1' }], [{ id: 'row-2' }]);
    const ids = await ContactReportText.queueContactReportTexts({
      customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://portal.example/report/tok', scheduledServiceId: 'svc-1',
    });
    expect(ids).toEqual(['row-1', 'row-2']);
    const inserts = opsFor('contact_report_texts').map((c) => c.ops.find((o) => o[0] === 'insert')[1]);
    expect(inserts.map((i) => i.phone_key)).toEqual(['9415550123', '9415550456']);
    expect(inserts[0]).toMatchObject({ customer_id: 'cust-1', source_key: 'record:rec-1', scheduled_service_id: 'svc-1', report_url: 'https://portal.example/report/tok' });
    // One text per contact per report: the unique key is the claim.
    expect(opsFor('contact_report_texts')[0].ops).toContainEqual(['onConflict', ['source_key', 'phone_key']]);
    expect(opsFor('contact_report_texts')[0].ops).toContainEqual(['ignore']);
  });

  test('a contact held by an unconfirmed opt-in ask is not queued', async () => {
    optinHeldPhoneKeys.mockResolvedValue(new Map([['cust-1', new Set(['9415550123'])]]));
    queue('customers', CUSTOMER);
    queue('contact_report_texts', [{ id: 'row-2' }]);
    const ids = await ContactReportText.queueContactReportTexts({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' });
    expect(ids).toEqual(['row-2']);
    expect(optinHeldPhoneKeys).toHaveBeenCalledWith(['cust-1']);
  });

  test('an unreadable opt-in state queues every slot contact; the send decides', async () => {
    optinHeldPhoneKeys.mockRejectedValue(new Error('connection reset'));
    queue('customers', CUSTOMER);
    queue('contact_report_texts', [{ id: 'row-1' }], [{ id: 'row-2' }]);
    expect(await ContactReportText.queueContactReportTexts({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' }))
      .toEqual(['row-1', 'row-2']);
  });

  test('a secondary profile with no phone: the account primary\'s number in a slot is the holder, never a contact', async () => {
    // The profile row, then the account primary read (withAccountPrimaryContact).
    queue('customers',
      { ...CUSTOMER, phone: null, is_primary_profile: false, account_id: 'acct-1', service_contact2_phone: null, service_contact3_phone: null, service_contact_phone: '941-555-0100' },
      { id: 'cust-primary', first_name: 'Dana', phone: '+19415550100', email: null });
    expect(await ContactReportText.queueContactReportTexts({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' })).toEqual([]);
    expect(opsFor('contact_report_texts')).toHaveLength(0);
  });

  test('an account without the consent stamp queues nothing', async () => {
    queue('customers', { ...CUSTOMER, service_contacts_consent_at: null });
    expect(await ContactReportText.queueContactReportTexts({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' })).toEqual([]);
    expect(opsFor('contact_report_texts')).toHaveLength(0);
  });

  test('a repeat for the same report inserts nothing new', async () => {
    queue('customers', CUSTOMER);
    queue('contact_report_texts', [], []);
    expect(await ContactReportText.queueContactReportTexts({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' })).toEqual([]);
  });
});

describe('dispatchContactReportText', () => {
  test('sends the plain report text to the contact and settles sent', async () => {
    queueDispatchReads();
    sendCustomerMessage.mockResolvedValue({ sent: true });
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'sent' });
    expect(renderSmsTemplate).toHaveBeenCalledWith('contact_report_ready',
      { street_address: '12 Example Way', report_url: 'https://portal.example/report/tok' }, expect.any(Object), { throwOnError: true });
    const sent = sendCustomerMessage.mock.calls[0][0];
    expect(sent).toMatchObject({
      channel: 'sms', audience: 'customer', purpose: 'service_completion', to: '(941) 555-0123', customerId: 'cust-1',
      appointmentId: 'svc-1', identityTrustLevel: 'service_contact_authorized',
    });
    expect(sent.metadata).toMatchObject({ original_message_type: 'contact_report_ready', templateKey: 'contact_report_ready' });
    // Never routed by the account holder's channel preference (push or email).
    expect(sent.metadata.useCustomerChannel).toBeUndefined();
    expect(lastUpdate()).toMatchObject({ status: 'sent', claimed_at: null });
  });

  test('every write after the claim is fenced to that claim', async () => {
    const claimedAt = new Date('2026-10-03T15:00:00Z');
    queueDispatchReads({ ...ROW, claimed_at: claimedAt });
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, code: 'RATE_LIMITED' });
    await ContactReportText.dispatchContactReportText('row-1');
    const writes = opsFor('contact_report_texts').slice(1).filter((c) => c.ops.some((o) => o[0] === 'update'));
    expect(writes).toHaveLength(2); // the send_started_at stamp, then the release
    for (const write of writes) {
      expect(write.ops).toContainEqual(['where', { id: 'row-1', status: 'pending', claimed_at: claimedAt }]);
    }
  });

  test('a failure is logged by row id and error code, never the error text', async () => {
    const logger = require('../services/logger');
    logger.warn.mockClear();
    queue('contact_report_texts', [ROW]);
    queue('customers', Object.assign(new Error('insert into ... values (+19415550123, https://portal.example/report/tok)'), { code: '08006' }));
    await ContactReportText.dispatchContactReportText('row-1');
    const logged = logger.warn.mock.calls.map((c) => c[0]).join(' ');
    expect(logged).toMatch(/row row-1 \(08006\)/);
    expect(logged).not.toMatch(/9415550123|report\/tok/);
  });

  test('the send is stamped under the claim before the sender is called', async () => {
    queueDispatchReads({ ...ROW, claimed_at: new Date('2026-10-03T15:00:00Z') });
    sendCustomerMessage.mockImplementation(async () => {
      const stamp = opsFor('contact_report_texts').map((c) => c.ops).find((ops) => ops.some((o) => o[0] === 'update' && o[1].send_started_at));
      expect(stamp).toContainEqual(['where', { id: 'row-1', status: 'pending', claimed_at: new Date('2026-10-03T15:00:00Z') }]);
      return { sent: true };
    });
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'sent' });
    // The claim itself takes only a row no earlier claim handed to the sender.
    expect(opsFor('contact_report_texts')[0].ops).toContainEqual(['whereNull', 'send_started_at']);
  });

  test('a claim lost before the stamp sends nothing', async () => {
    queue('contact_report_texts', [ROW], 0);
    queue('customers', CUSTOMER);
    queue('scheduled_services', { service_address_line1: '12 Example Way' });
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'not_claimed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a row another dispatch holds is not sent', async () => {
    queue('contact_report_texts', []);
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'not_claimed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a contact removed or no longer confirmed gets nothing', async () => {
    queue('contact_report_texts', [ROW]);
    queue('customers', { ...CUSTOMER, service_contact_phone: null });
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'suppressed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'suppressed', status_reason: 'contact_not_confirmed' });
  });

  test('a contact held by an unconfirmed opt-in ask at the send gets nothing', async () => {
    queue('contact_report_texts', [ROW]);
    queue('customers', CUSTOMER);
    optinHeldPhoneKeys.mockResolvedValue(new Map([['cust-1', new Set(['9415550123'])]]));
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'suppressed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an opt-in read that fails at the send releases the row for a retry, never contact_not_confirmed', async () => {
    queue('contact_report_texts', [ROW]);
    queue('customers', CUSTOMER);
    optinHeldPhoneKeys.mockRejectedValue(new Error('connection reset'));
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'pending', status_reason: 'dispatch_error' });
  });

  test('a report older than 24 hours is not announced', async () => {
    queue('contact_report_texts', [{ ...ROW, created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) }]);
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'suppressed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'suppressed', status_reason: 'expired' });
  });

  test('the gate turned off after the queue: suppressed, not sent', async () => {
    queue('contact_report_texts', [ROW]);
    delete process.env.GATE_CONTACT_REPORT_TEXT;
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'suppressed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an inactive template sends nothing', async () => {
    queueDispatchReads();
    renderSmsTemplate.mockResolvedValue(undefined);
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'suppressed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'suppressed', status_reason: 'template_off' });
  });

  test('the send window holds the row until it opens', async () => {
    queueDispatchReads();
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', deferred: true, nextAllowedAt: '2026-10-04T12:00:00Z' });
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'deferred' });
    expect(lastUpdate()).toMatchObject({ status: 'pending', claimed_at: null, not_before: new Date('2026-10-04T12:00:00Z') });
  });

  test.each([
    ['a policy block', { sent: false, blocked: true, code: 'OPTED_OUT' }, 'suppressed', 'suppressed'],
    ['a retryable block', { sent: false, blocked: true, retryable: true, code: 'RATE_LIMITED' }, 'retry', 'pending'],
    ['a definitive provider rejection', { sent: false, terminal: true, providerErrorCode: '21610' }, 'failed', 'failed'],
    ['an ambiguous provider failure', { sent: false, code: 'PROVIDER_FAILURE' }, 'unknown_delivery', 'unknown_delivery'],
  ])('%s settles %s', async (_name, result, state, status) => {
    queueDispatchReads();
    sendCustomerMessage.mockResolvedValue(result);
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state });
    expect(lastUpdate()).toMatchObject({ status });
  });

  test('a retryable block on the last attempt fails the row', async () => {
    queueDispatchReads({ ...ROW, attempts: 5 });
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, code: 'RATE_LIMITED' });
    await ContactReportText.dispatchContactReportText('row-1');
    expect(lastUpdate()).toMatchObject({ status: 'failed' });
  });

  test('a sender that throws is never retried (the provider may hold the text)', async () => {
    queueDispatchReads();
    sendCustomerMessage.mockRejectedValue(new Error('socket hang up'));
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'error' });
    expect(lastUpdate()).toMatchObject({ status: 'unknown_delivery' });
  });

  test('a template read that fails releases the row for a retry, never template_off', async () => {
    queueDispatchReads();
    renderSmsTemplate.mockRejectedValue(new Error('connection reset'));
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'pending', status_reason: 'dispatch_error' });
  });

  test('a failure before the sender releases the row for a retry', async () => {
    queue('contact_report_texts', [ROW]);
    queue('customers', new Error('connection reset'));
    expect(await ContactReportText.dispatchContactReportText('row-1')).toEqual({ state: 'error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'pending', status_reason: 'dispatch_error' });
  });
});

describe('sweepContactReportTexts', () => {
  test('a claim that reached the sender and died settles unknown_delivery and is never sent again', async () => {
    queue('contact_report_texts', 1, []);
    expect(await ContactReportText.sweepContactReportTexts()).toEqual({ dispatched: 0 });
    const [interrupted, pending] = opsFor('contact_report_texts');
    expect(interrupted.ops).toContainEqual(['whereNotNull', 'send_started_at']);
    expect(interrupted.ops.find((o) => o[0] === 'update')[1]).toMatchObject({ status: 'unknown_delivery', status_reason: 'dispatch_interrupted' });
    expect(pending.ops).toContainEqual(['whereNull', 'send_started_at']);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('dispatches the pending rows it finds', async () => {
    queue('contact_report_texts', 0, [{ id: 'row-1' }]);
    queueDispatchReads();
    sendCustomerMessage.mockResolvedValue({ sent: true });
    expect(await ContactReportText.sweepContactReportTexts()).toEqual({ dispatched: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });
});

describe('notifyContactsReportReady', () => {
  test('never throws into the closeout', async () => {
    queue('customers', new Error('connection reset'));
    await expect(ContactReportText.notifyContactsReportReady({ customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://x/report/t' }))
      .resolves.toBe(0);
  });
});

describe('the approved wording and the hooks', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the template is the owner-approved text, GSM-7, with no STOP line', () => {
    const { TEMPLATE } = require('../models/migrations/20261003120000_contact_report_texts');
    expect(TEMPLATE.body).toBe('Waves Pest Control: The service report for {street_address} is ready: {report_url}');
    expect(TEMPLATE.variables).toEqual(['street_address', 'report_url']);
     
    expect(TEMPLATE.body).toMatch(/^[\x00-\x7F]+$/);
    expect(TEMPLATE.body).not.toMatch(/STOP/);
  });

  test('the closeout queues the contact text only with a real report link, on sent and on a send-window hold', () => {
    const source = read('services/complete-scheduled-service.js');
    const hooks = source.match(/if \(reportToken && smsMetadata\.report_url\) \{\s+await require\('\.\/contact-report-text'\)\.notifyContactsReportReady\(/g);
    expect(hooks).toHaveLength(2);
  });

  test('the combined-stop summary queues it on sent and on a send-window hold', () => {
    const source = read('services/visit-completion-summary.js');
    expect(source.match(/ContactReportText\.notifyContactsReportReady\(/g)).toHaveLength(2);
    expect(source).toMatch(/sourceKey: `visit:\$\{visit\.id\}`/);
  });
});

describe('summarySmsRecipient: who gets the combined-stop summary text', () => {
  const { resolveServiceContactSmsRecipient } = require('../services/recipient-optin');
  const { summarySmsRecipient } = require('../services/visit-completion-summary');

  beforeEach(() => resolveServiceContactSmsRecipient.mockReset().mockResolvedValue({ phone: '(941) 555-0123', name: 'Riley Tenant', role: 'service_contact' }));

  test('gate on: the account holder', async () => {
    expect(await summarySmsRecipient(CUSTOMER)).toMatchObject({ phone: '+19415550100', name: 'Dana', role: 'primary' });
    expect(resolveServiceContactSmsRecipient).not.toHaveBeenCalled();
  });

  test('gate on, account holder with no phone: the slot-1 contact rule', async () => {
    expect((await summarySmsRecipient({ ...CUSTOMER, phone: null })).phone).toBe('(941) 555-0123');
  });

  test('gate off: the slot-1 contact rule, unchanged', async () => {
    delete process.env.GATE_CONTACT_REPORT_TEXT;
    const opts = { dbh: {} };
    expect((await summarySmsRecipient(CUSTOMER, opts)).phone).toBe('(941) 555-0123');
    expect(resolveServiceContactSmsRecipient).toHaveBeenCalledWith(CUSTOMER, opts);
  });
});
