// Report text to on-location contacts (GATE_CONTACT_REPORT_TEXT, owner
// 2026-10-03): one plain text with the report link to each confirmed contact
// when the account holder's visit-complete text goes out. It rides the
// scheduled-SMS rail; this suite covers the queue, the send-time recheck, the
// registry entry and the hook sites.
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550000' }));
jest.mock('../utils/customer-comms-lock', () => ({
  withSmsConsentLock: jest.fn(async (dbh, _keys, fn) => fn(dbh)),
}));
jest.mock('../services/recipient-optin', () => ({
  optinHeldPhoneKeys: jest.fn(async () => new Map()),
  resolveServiceContactSmsRecipient: jest.fn(),
}));
// A knex stand-in: each db(table) call returns a chain that records its
// calls and resolves to the next queued result for that table. A transaction
// runs its callback on the same stand-in.
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
          call.ops.push([prop, ...args.map((a) => (typeof a === 'function' ? '[fn]' : a))]);
          return chain;
        };
      },
    });
    return chain;
  });
  db.transaction = jest.fn(async (fn) => { db.isTransaction = true; try { return await fn(db); } finally { db.isTransaction = false; } });
  db.mockState = state;
  return db;
});

const db = require('../models/db');
const logger = require('../services/logger');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { optinHeldPhoneKeys } = require('../services/recipient-optin');
const ContactReportText = require('../services/contact-report-text');

// What the renderer returns: the one render carries the name marker.
const RENDERED = 'Hello __CONTACT_FIRST_NAME__! The Waves service report for 12 Example Way is ready: https://portal.example/report/tok\n\nQuestions or requests? Reply here.';
const BODY = RENDERED.replace('__CONTACT_FIRST_NAME__', 'Riley');
const CUSTOMER = {
  id: 'cust-1', first_name: 'Dana', phone: '+19415550100', address_line1: '99 Profile Rd',
  service_contact_name: 'Riley Tenant', service_contact_phone: '(941) 555-0123',
  service_contact2_name: 'Morgan Manager', service_contact2_phone: '941-555-0456',
  service_contact3_name: 'Dana Again', service_contact3_phone: '941-555-0100', // the holder's own number
  service_contacts_consent_at: new Date('2026-09-30T12:00:00Z'),
};
const ARGS = { customerId: 'cust-1', sourceKey: 'record:rec-1', reportUrl: 'https://portal.example/report/tok', scheduledServiceId: 'svc-1' };
const queue = (table, ...values) => { db.mockState.queue[table] = [...(db.mockState.queue[table] || []), ...values]; };
const opsFor = (table) => db.mockState.calls.filter((c) => c.table === table);
const inserts = () => opsFor('sms_log').map((c) => c.ops.find((o) => o[0] === 'insert')).filter(Boolean).map((o) => o[1]);
// The reads a queue makes for two confirmed contacts with no earlier rows:
// the profile and the visit address (for the body, before the transaction),
// then the profile again under its row lock.
const queueReads = (customer = CUSTOMER) => {
  queue('customers', customer, customer);
  queue('scheduled_services', { service_address_line1: '12 Example Way' });
};

beforeEach(() => {
  process.env.GATE_CONTACT_REPORT_TEXT = 'true';
  db.mockClear();
  db.transaction.mockClear();
  db.mockState.queue = {};
  db.mockState.calls = [];
  logger.error.mockClear();
  logger.warn.mockClear();
  renderSmsTemplate.mockReset().mockResolvedValue(RENDERED);
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
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(0);
    expect(db).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('queueContactReportTexts', () => {
  test('one scheduled text per confirmed contact on the existing rail; never the account holder', async () => {
    queueReads();
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(2);
    const rows = inserts();
    expect(rows.map((r) => r.to_phone)).toEqual(['(941) 555-0123', '941-555-0456']);
    expect(rows[0]).toMatchObject({
      customer_id: 'cust-1', direction: 'outbound', status: 'scheduled', message_type: 'contact_report_ready',
      message_body: BODY, from_phone: '+19415550000',
    });
    const meta = JSON.parse(rows[0].metadata);
    expect(meta).toMatchObject({
      entry_point: 'contact_report_ready_deferred', contact_report_key: 'record:rec-1:9415550123',
      scheduled_service_id: 'svc-1', template_key: 'contact_report_ready', replay_purpose: 'service_completion',
      appointment_contact_role: 'service_contact', resolve_from_by_customer: true,
    });
    // The row is the CONTACT's: never swapped to the account holder's phone,
    // never routed by the account holder's channel preference.
    expect(meta.refresh_customer_phone).toBeUndefined();
    expect(meta.useCustomerChannel).toBeUndefined();
    expect(renderSmsTemplate).toHaveBeenCalledWith('contact_report_ready',
      { first_name: '__CONTACT_FIRST_NAME__', street_address: '12 Example Way', report_url: 'https://portal.example/report/tok' }, expect.any(Object),
      { throwOnError: true, requiredVars: ['report_url'] });
    // One render (one template and variant selection) for the whole queue.
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(rows[1].message_body).toMatch(/^Hello Morgan! The Waves service report/);
    // A worker that predates the registry entry refuses the row.
    expect(meta.requires_registered_dispatch).toBe(true);
    // The greeted name rides the row for the send-time recheck.
    expect(meta.contact_report_first_name).toBe('Riley');
    expect(JSON.parse(rows[1].metadata).contact_report_first_name).toBe('Morgan');
  });

  test('a tenant contact, or an unlabeled contact on a property-manager account, gets no report text', async () => {
    queueReads({ ...CUSTOMER, service_contact_role: 'tenant' });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(1);
    expect(inserts().map((r) => r.to_phone)).toEqual(['941-555-0456']);

    db.mockState.calls = [];
    queueReads({ ...CUSTOMER, contact_role: 'property_manager', service_contact2_role: 'property_manager' });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(1);
    expect(inserts().map((r) => r.to_phone)).toEqual(['941-555-0456']);
  });

  test('each contact is greeted by their own first name; a nameless contact is never greeted by the account holder\'s', async () => {
    queueReads({ ...CUSTOMER, service_contact2_name: null });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(2);
    expect(inserts().map((r) => r.message_body.split('!')[0])).toEqual(['Hello Riley', 'Hello there']);
    expect(inserts().map((r) => JSON.parse(r.metadata).contact_report_first_name)).toEqual(['Riley', 'there']);
  });

  test('a name with accents or non-Latin characters is made GSM-safe, so the text stays GSM-7', async () => {
    queueReads({ ...CUSTOMER, service_contact_name: '\u00c1lvaro N\u00fa\u00f1ez', service_contact2_name: '\u7530\u4e2d \u592a\u90ce' });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(2);
    const bodies = inserts().map((r) => r.message_body);
    expect(bodies.map((b) => b.split('!')[0])).toEqual(['Hello Alvaro', 'Hello there']);
    const { detectEncoding } = require('../services/messaging/segment-counter');
    for (const body of bodies) expect(detectEncoding(body).encoding).toBe('GSM_7');
    expect(inserts().map((r) => JSON.parse(r.metadata).contact_report_first_name)).toEqual(['Alvaro', 'there']);
  });

  test('the name comes from the lock-held row: a rename on the same phone before the lock is greeted by the saved name', async () => {
    // The unlocked read sees Riley; the locked read sees the saved contact.
    queue('customers', CUSTOMER, { ...CUSTOMER, service_contact_name: 'Jordan Newtenant' });
    queue('scheduled_services', { service_address_line1: '12 Example Way' });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(2);
    expect(inserts()[0].message_body).toMatch(/^Hello Jordan!/);
    expect(JSON.parse(inserts()[0].metadata).contact_report_first_name).toBe('Jordan');
  });

  test('an edited body without a name carries no name to recheck: a later rename does not drop it', async () => {
    queueReads();
    renderSmsTemplate.mockResolvedValue('Waves: your service report is ready: https://portal.example/report/tok');
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(2);
    const meta = JSON.parse(inserts()[0].metadata);
    expect(meta.contact_report_first_name).toBeUndefined();
    queue('customers', { ...CUSTOMER, service_contact_name: 'Jordan Newtenant' });
    expect(await ContactReportText.recheckContactReportText({ ...meta, customer_id: 'cust-1', to_phone: '(941) 555-0123' })).toEqual({ eligible: true });
  });

  test('the body is rendered before the transaction opens (the template read uses the root pool)', async () => {
    queueReads();
    renderSmsTemplate.mockImplementation(async () => { expect(db.transaction).not.toHaveBeenCalled(); return RENDERED; });
    await ContactReportText.queueContactReportTexts(ARGS);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('an edited template that lost the report link queues nothing', async () => {
    queueReads();
    renderSmsTemplate.mockResolvedValue('Waves Pest Control: The service report for 12 Example Way is ready.');
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('runs under the customer row lock, the lock a contact save takes', async () => {
    queueReads();
    await ContactReportText.queueContactReportTexts(ARGS);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(opsFor('customers')[0].ops).not.toContainEqual(['forUpdate']);
    expect(opsFor('customers')[1].ops).toContainEqual(['forUpdate']);
  });

  test('a contact that already has a row for this report is not queued again', async () => {
    queueReads();
    queue('sms_log', { id: 'existing' }); // contact 1: found; contact 2: not found, inserted
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(1);
    expect(inserts().map((r) => r.to_phone)).toEqual(['941-555-0456']);
    expect(opsFor('sms_log')[0].ops).toContainEqual(['whereRaw', "metadata->>'contact_report_key' = ?", ['record:rec-1:9415550123']]);
  });

  test('a send-window hold queues the text for when the window opens', async () => {
    queueReads();
    const opens = new Date('2026-10-04T12:00:00Z');
    await ContactReportText.queueContactReportTexts({ ...ARGS, notBefore: opens });
    expect(inserts()[0].scheduled_for).toEqual(opens);
  });

  test('a contact held by an unconfirmed opt-in ask is not queued', async () => {
    optinHeldPhoneKeys.mockResolvedValue(new Map([['cust-1', new Set(['9415550123'])]]));
    queueReads();
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(1);
    expect(inserts().map((r) => r.to_phone)).toEqual(['941-555-0456']);
  });

  test('the number the visit-complete text went to never gets the report text too', async () => {
    queueReads();
    expect(await ContactReportText.queueContactReportTexts({ ...ARGS, excludePhone: '+1 (941) 555-0123' })).toBe(1);
    expect(inserts().map((r) => r.to_phone)).toEqual(['941-555-0456']);
  });

  test('a combined-stop summary row carries the visit and its token hash for the recheck', async () => {
    queueReads();
    await ContactReportText.queueContactReportTexts({ ...ARGS, sourceKey: 'visit:v-1', source: { visitId: 'v-1', summaryTokenHash: 'hash-1' } });
    expect(JSON.parse(inserts()[0].metadata)).toMatchObject({ visit_id: 'v-1', summary_token_hash: 'hash-1', contact_report_key: 'visit:v-1:9415550123' });
  });

  test('a secondary profile with no phone: the account primary\'s number in a slot is the holder, never a contact', async () => {
    // The profile row, then the account primary read (withAccountPrimaryContact).
    queue('customers',
      { ...CUSTOMER, phone: null, is_primary_profile: false, account_id: 'acct-1', service_contact2_phone: null, service_contact3_phone: null, service_contact_phone: '941-555-0100' },
      { id: 'cust-primary', first_name: 'Dana', phone: '+19415550100', email: null });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(0);
    expect(inserts()).toHaveLength(0);
  });

  test('an account without the consent stamp, or an inactive template, queues nothing', async () => {
    queue('customers', { ...CUSTOMER, service_contacts_consent_at: null });
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(0);
    queueReads();
    renderSmsTemplate.mockResolvedValue(undefined);
    expect(await ContactReportText.queueContactReportTexts(ARGS)).toBe(0);
    expect(inserts()).toHaveLength(0);
  });

  test('the visit has no address of its own: the profile street', async () => {
    queue('customers', CUSTOMER, CUSTOMER);
    queue('scheduled_services', { service_address_line1: null });
    await ContactReportText.queueContactReportTexts(ARGS);
    expect(renderSmsTemplate.mock.calls[0][1].street_address).toBe('99 Profile Rd');
  });

  test.each([
    ['the visit address read', () => { queue('customers', CUSTOMER); queue('scheduled_services', new Error('connection reset')); }],
    ['the opt-in read', () => { queueReads(); optinHeldPhoneKeys.mockRejectedValue(new Error('connection reset')); }],
    ['the template read', () => { queueReads(); renderSmsTemplate.mockRejectedValue(new Error('connection reset')); }],
  ])('%s failing throws (never a wrong street, a dropped contact or "template off")', async (_name, arrange) => {
    arrange();
    await expect(ContactReportText.queueContactReportTexts(ARGS)).rejects.toThrow('connection reset');
    expect(inserts()).toHaveLength(0);
  });
});

describe('notifyContactsReportReady', () => {
  test('a queue that fails once is retried', async () => {
    queue('customers', new Error('connection reset'));
    queueReads();
    await expect(ContactReportText.notifyContactsReportReady(ARGS, { delaysMs: [0, 0] })).resolves.toBe(2);
  });

  test('never throws into the closeout; a queue that keeps failing is logged as lost, by id and code only', async () => {
    const err = () => Object.assign(new Error('insert ... (+19415550123, https://portal.example/report/tok)'), { code: '08006' });
    queue('customers', err(), err(), err());
    await expect(ContactReportText.notifyContactsReportReady(ARGS, { delaysMs: [0, 0] })).resolves.toBe(0);
    const logged = logger.error.mock.calls[0][0];
    expect(logged).toMatch(/queue failed for record:rec-1 after 3 tries \(08006\); contact report text not sent/);
    expect(logged).not.toMatch(/9415550123|report\/tok/);
  });
});

describe('recheckContactReportText: is the queued text still right to send', () => {
  const META = { customer_id: 'cust-1', to_phone: '(941) 555-0123', contact_report_queued_at: new Date().toISOString() };

  test('a contact who is still confirmed: eligible', async () => {
    queue('customers', CUSTOMER);
    expect(await ContactReportText.recheckContactReportText(META)).toEqual({ eligible: true });
  });

  test('the gate turned off after the queue: dropped', async () => {
    delete process.env.GATE_CONTACT_REPORT_TEXT;
    expect(await ContactReportText.recheckContactReportText(META)).toEqual({ eligible: false, reason: 'contact-report-gate-off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('a report older than 24 hours is not announced', async () => {
    const old = { ...META, contact_report_queued_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    expect(await ContactReportText.recheckContactReportText(old)).toEqual({ eligible: false, reason: 'contact-report-expired' });
  });

  test('a contact removed or replaced since the queue gets nothing', async () => {
    queue('customers', { ...CUSTOMER, service_contact_phone: '941-555-0999' });
    expect(await ContactReportText.recheckContactReportText(META)).toEqual({ eligible: false, reason: 'contact-removed' });
  });

  test('the phone saved under another name since the queue: the text that greets the old name is dropped', async () => {
    const meta = { ...META, contact_report_first_name: 'Riley' };
    queue('customers', CUSTOMER);
    expect(await ContactReportText.recheckContactReportText(meta)).toEqual({ eligible: true });
    queue('customers', { ...CUSTOMER, service_contact_name: 'Jordan Newtenant' });
    expect(await ContactReportText.recheckContactReportText(meta)).toEqual({ eligible: false, reason: 'contact-renamed' });
    // A nameless slot was greeted "there"; a name added later is a change too.
    queue('customers', { ...CUSTOMER, service_contact_name: null });
    expect(await ContactReportText.recheckContactReportText({ ...meta, contact_report_first_name: 'there' })).toEqual({ eligible: true });
  });

  test('a contact who replied STOP to the opt-in ask since the queue gets nothing', async () => {
    queue('customers', CUSTOMER);
    optinHeldPhoneKeys.mockResolvedValue(new Map([['cust-1', new Set(['9415550123'])]]));
    expect(await ContactReportText.recheckContactReportText(META)).toEqual({ eligible: false, reason: 'contact-removed' });
  });

  test('a combined-stop summary revoked or reissued since the queue: dropped', async () => {
    queue('service_visits', undefined);
    const meta = { ...META, visit_id: 'v-1', summary_token_hash: 'hash-1' };
    expect(await ContactReportText.recheckContactReportText(meta)).toEqual({ eligible: false, reason: 'contact-report-summary-revoked' });
    const visitRead = opsFor('service_visits')[0].ops;
    expect(visitRead).toContainEqual(['where', { id: 'v-1', summary_token_hash: 'hash-1' }]);
    expect(visitRead).toContainEqual(['whereNull', 'summary_token_revoked_at']);
  });

  test('in the locked handoff the summary row is held FOR SHARE, so a revoke waits for the request', async () => {
    const meta = { ...META, visit_id: 'v-1', summary_token_hash: 'hash-1' };
    queue('service_visits', { id: 'v-1' });
    queue('customers', CUSTOMER);
    await ContactReportText.recheckContactReportText(meta);
    expect(opsFor('service_visits')[0].ops).not.toContainEqual(['forShare']);
    db.isTransaction = true;
    try {
      queue('service_visits', { id: 'v-1' });
      queue('customers', CUSTOMER);
      await ContactReportText.recheckContactReportText(meta, { conn: db });
    } finally {
      db.isTransaction = false;
    }
    expect(opsFor('service_visits')[1].ops).toContainEqual(['forShare']);
  });

  test('a live combined-stop summary and a confirmed contact: eligible', async () => {
    queue('service_visits', { id: 'v-1' });
    queue('customers', CUSTOMER);
    expect(await ContactReportText.recheckContactReportText({ ...META, visit_id: 'v-1', summary_token_hash: 'hash-1' })).toEqual({ eligible: true });
  });

  test('a failed read throws (the registry holds the row for a retry)', async () => {
    queue('customers', CUSTOMER);
    optinHeldPhoneKeys.mockRejectedValue(new Error('connection reset'));
    await expect(ContactReportText.recheckContactReportText(META)).rejects.toThrow('connection reset');
  });
});

describe('registry entry contact_report_ready_deferred', () => {
  const registry = require('../services/messaging/deferred-replay-registry');
  const META = { customer_id: 'cust-1', to_phone: '(941) 555-0123', contact_report_queued_at: new Date().toISOString() };

  test('the queue uses a registered deferred entry point', () => {
    expect(registry.isDeferredReplayEntryPoint(ContactReportText.ENTRY_POINT)).toBe(true);
  });

  test('recheck: eligible for a confirmed contact, retryable (never a send, never a drop) on a failed read', async () => {
    queue('customers', CUSTOMER);
    expect(await registry.recheckDeferredReplay('contact_report_ready_deferred', META)).toEqual({ eligible: true });
    queue('customers', Object.assign(new Error('select ... +19415550123'), { code: '08006' }));
    expect(await registry.recheckDeferredReplay('contact_report_ready_deferred', META))
      .toEqual({ eligible: false, reason: 'recheck-failed', retryable: true });
    expect(logger.warn.mock.calls.map((c) => c[0]).join(' ')).not.toMatch(/9415550123/);
  });

  test('the send runs under the contact-save lock: the customer row is held and the check repeats before the provider', async () => {
    const { withSmsConsentLock } = require('../utils/customer-comms-lock');
    const handoff = registry.deferredSmsHandoff('contact_report_ready_deferred', META);
    const dispatch = jest.fn(async () => ({ sent: true }));
    // The row lock read, then the recheck's customer read.
    queue('customers', { id: 'cust-1' }, CUSTOMER);
    expect(await handoff(dispatch)).toEqual({ sent: true });
    expect(withSmsConsentLock).toHaveBeenCalledWith(db, { phone: '(941) 555-0123', customerId: 'cust-1' }, expect.any(Function));
    expect(opsFor('customers')[0].ops).toContainEqual(['forUpdate']);
    expect(dispatch).toHaveBeenCalledWith(db);
  });

  test('a contact removed before the lock is refused: the provider is never called', async () => {
    const handoff = registry.deferredSmsHandoff('contact_report_ready_deferred', META);
    const dispatch = jest.fn();
    queue('customers', { id: 'cust-1' }, { ...CUSTOMER, service_contact_phone: null });
    expect(await handoff(dispatch)).toEqual({ ok: false, code: 'CONTACT_REPORT_STALE_AT_HANDOFF', reason: 'contact-removed' });
    queue('customers', { id: 'cust-1' }, new Error('connection reset'));
    expect(await handoff(dispatch)).toEqual({ ok: false, code: 'CONTACT_REPORT_CHECK_FAILED_AT_HANDOFF', reason: 'recheck-failed', retryable: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a worker without this entry refuses the row; this one sends the frozen body', async () => {
    const send = jest.fn(async () => ({ sent: true }));
    expect(await registry.dispatchDeferredReplay('contact_report_ready_deferred', { requires_registered_dispatch: true }, send)).toEqual({ sent: true });
    const refused = await registry.dispatchDeferredReplay('an_entry_this_worker_does_not_know', { requires_registered_dispatch: true }, send);
    expect(refused).toMatchObject({ sent: false, blocked: true, code: 'DEFERRED_DISPATCH_UNAVAILABLE', retryable: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('the sender allows the locked handoff for this text only on the scheduled replay', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services/messaging/send-customer-message.js'), 'utf8');
    expect(source).toMatch(/input\.metadata\?\.original_message_type === 'contact_report_ready'\s+&& input\.entryPoint === 'scheduled_sms_cron'\)/);
  });
});

describe('the approved wording and the hooks', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the template is in the house voice: "Hello {first_name}!", "Waves", the link, the standard closing; no STOP line', () => {
    const seed = require('../models/migrations/20261003150000_contact_report_ready_template');
    const voice = require('../models/migrations/20261004100000_contact_report_ready_house_voice');
    expect(voice.BODY).toBe('Hello {first_name}! The Waves service report for {street_address} is ready: {report_url}\n\nQuestions or requests? Reply here.');
    expect(voice.VARIABLES).toEqual(['first_name', 'street_address', 'report_url']);
    // GSM-7: plain ASCII only.
    expect([...voice.BODY].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    expect(voice.BODY).not.toMatch(/STOP|Pest Control/);
    // Only the seeded wording is replaced (an admin edit is kept).
    expect(voice.SEEDED_BODY).toBe(seed.TEMPLATE.body);
  });

  test('the closeout queues it only with a real report link, on sent, on a send-window hold and in the accepted-send recovery', () => {
    const source = read('services/complete-scheduled-service.js');
    expect(source).toMatch(/if \(reportToken && smsMetadata\.report_url\) contactReportUrl = smsMetadata\.report_url;/);
    expect(source).toMatch(/if \(!contactReportUrl\) return;/);
    expect(source.match(/await notifyContactsOfReport\(/g)).toHaveLength(3);
    // Only for a text: an App-channel completion notice queues none.
    expect(source).toMatch(/if \(smsResult\.channel !== 'push'\) await notifyContactsOfReport\(\);/);
    // The recovery decides on the RESOLVED channel: the snapshot (a push that
    // succeeded, then a local write that threw) or the accepted outcome.
    expect(source).toMatch(/if \(e\.providerOutcome\?\.provider === 'push'\) snap\.channel = 'push';\s+(?:\/\/.*\s+)+if \(snap\.channel !== 'push'\) await notifyContactsOfReport\(\);/);
    expect(source).toMatch(/if \(smsResult\.channel === 'push'\) \{\s+sentSmsChannel = 'push';\s+completionSmsAcceptedSnapshot\.channel = 'push';/);
  });

  test('the combined-stop summary queues it on sent (before its finalize write) and on a send-window hold', () => {
    const source = read('services/visit-completion-summary.js');
    expect(source.match(/await notifyContacts\(/g)).toHaveLength(2);
    expect(source).toMatch(/if \(outcome === 'sent'\) await notifyContacts\(\);\s+await VisitGroups\.finalizeVisitNotification\(visit\.id, 'completion_sms', outcome/);
    expect(source).toMatch(/source: \{ visitId: visit\.id, summaryTokenHash: visit\.summary_token_hash \}/);
    expect(source).toMatch(/excludePhone: recipient\?\.phone \|\| null/);
  });

  test('no second delivery mechanism: no ledger table, no sweep', () => {
    expect(read('services/contact-report-text.js')).not.toMatch(/contact_report_texts|sendCustomerMessage/);
    expect(read('index.js')).not.toMatch(/contact-report-text/);
  });
});

describe('wording migration: seeded bodies swapped on the base row and variants, the allowlist widened on every base row', () => {
  const voice = require('../models/migrations/20261004100000_contact_report_ready_house_voice');

  function fakeKnex({ templates, variants }) {
    const updates = [];
    const knex = (table) => {
      const rows = table === 'sms_templates' ? templates : variants;
      let cond = {};
      const match = () => rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      const q = {
        where(c) { cond = { ...cond, ...c }; return q; },
        select: async () => match(),
        update: async (patch) => {
          const hit = match();
          hit.forEach((r) => Object.assign(r, patch));
          updates.push({ table, cond, patch });
          return hit.length;
        },
      };
      return q;
    };
    knex.schema = { hasTable: async (name) => name !== 'audit_log' };
    knex.fn = { now: () => 'now' };
    knex.updates = updates;
    return knex;
  }

  test('seeded base row and seeded variant get the new body; edited ones keep theirs; other templates are untouched', async () => {
    const templates = [
      { id: 't1', template_key: 'contact_report_ready', body: voice.SEEDED_BODY, variables: JSON.stringify(['street_address', 'report_url']) },
      { id: 't2', template_key: 'another_template', body: voice.SEEDED_BODY, variables: '[]' },
    ];
    const variants = [
      { id: 'v1', template_key: 'contact_report_ready', body: voice.SEEDED_BODY },
      { id: 'v2', template_key: 'contact_report_ready', body: 'An edited variant {report_url}' },
    ];
    await voice.up(fakeKnex({ templates, variants }));
    expect(templates[0].body).toBe(voice.BODY);
    expect(JSON.parse(templates[0].variables)).toEqual(['first_name', 'street_address', 'report_url']);
    expect(templates[1]).toMatchObject({ body: voice.SEEDED_BODY, variables: '[]' });
    expect(variants.map((v) => v.body)).toEqual([voice.BODY, 'An edited variant {report_url}']);
  });

  test('an admin-edited base row keeps its body and still gains first_name in its allowlist', async () => {
    const templates = [{ id: 't1', template_key: 'contact_report_ready', body: 'Edited by an admin: {report_url}', variables: ['street_address', 'report_url', 'custom'] }];
    await voice.up(fakeKnex({ templates, variants: [] }));
    expect(templates[0].body).toBe('Edited by an admin: {report_url}');
    expect(JSON.parse(templates[0].variables)).toEqual(['first_name', 'street_address', 'report_url', 'custom']);
  });

  test('a second run changes nothing; down is a no-op that keeps the widened allowlist', async () => {
    const templates = [{ id: 't1', template_key: 'contact_report_ready', body: voice.SEEDED_BODY, variables: '["street_address","report_url"]' }];
    const knex = fakeKnex({ templates, variants: [] });
    await voice.up(knex);
    const writes = knex.updates.length;
    await voice.up(knex);
    await voice.down(knex);
    expect(knex.updates).toHaveLength(writes);
    expect(JSON.parse(templates[0].variables)).toContain('first_name');
  });

  test('every changed row records an audit event with the before and after', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'models/migrations/20261004100000_contact_report_ready_house_voice.js'), 'utf8');
    expect(source).toMatch(/if \(changed\) await audit\(table, row\.id, \{ before: SEEDED_BODY, after: BODY \}\);/);
    expect(source).toMatch(/await audit\('sms_templates', row\.id, \{ variables_before: before, variables_after: after \}\);/);
    expect(source).toMatch(/critical: true, trx: knex,/);
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

describe('the portal card mentions the report text under the gate, with the condition in its wording', () => {
  test('the server flag is the gate; the card says "when your own visit-complete texts are on"', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes/notifications.js'), 'utf8');
    expect(source).toMatch(/function contactReportTextsOn\(\) \{\s+return require\('\.\.\/config\/feature-gates'\)\.contactReportTextLive\(\);/);
    expect(source.match(/contactReportTexts: contactReportTextsOn\(\),/g)).toHaveLength(2);
    const card = fs.readFileSync(path.join(__dirname, '..', '..', 'client/src/pages/PortalPage.jsx'), 'utf8');
    expect(card).toMatch(/appointment texts and, when your own visit-complete texts are on, a text with the service report link after each visit/);
  });
});
