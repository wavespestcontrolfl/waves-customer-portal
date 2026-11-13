/**
 * get_customer_text_status against real PostgreSQL (committed rows, cleaned up): the real send-path validators on real
 * notification_prefs and messaging_suppression rows. An additional-property profile seeded by the one seeding function
 * (createDefaultCustomerRows) reads its five appointment texts blocked while the account's main profile reads them
 * allowed; a STOP and a do-not-text row block every type; the 60-day lists read the audit log and sms_log. The tool only
 * reads: every case checks that it wrote nothing. No provider is reachable: nothing here sends. Synthetic names only.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('IB get_customer_text_status (real PG)', () => {
  let db;
  let executeCommsTool;
  let createDefaultCustomerRows;
  const created = { customers: [], accounts: [], phones: [] };
  const APPOINTMENT_TYPES = ['appointment_confirmation', 'appointment_reminder_72h', 'appointment_reminder_24h', 'tech_en_route', 'tech_arrived'];

  beforeAll(() => {
    // Real rows are written: only a dedicated QA database (or CI's), never anything else.
    const url = new URL(process.env.DATABASE_URL);
    const ok = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
      || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test');
    if (!ok) throw new Error('A dedicated waves_qa_<32 hex> database is required');
    db = require('../models/db');
    ({ executeCommsTool } = require('../services/intelligence-bar/comms-tools'));
    ({ createDefaultCustomerRows } = require('../services/customer-default-rows'));
  });

  afterAll(async () => {
    if (!db) return;
    if (created.phones.length) await db('messaging_suppression').whereIn('phone', created.phones).del();
    for (const id of created.customers) {
      await db('sms_log').where({ customer_id: id }).del();
      await db('messaging_audit_log').where({ customer_id: id }).del();
      await db('notification_prefs').where({ customer_id: id }).del();
      await db('property_preferences').where({ customer_id: id }).del();
      await db('customers').where({ id }).del();
    }
    if (created.accounts.length) await db('customer_accounts').whereIn('id', created.accounts).del();
    await db.destroy();
  });

  const newPhone = () => {
    const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;
    created.phones.push(phone);
    return phone;
  };

  // A customer with the default rows every creation path seeds.
  async function customer(over = {}) {
    const id = randomUUID();
    const phone = over.phone || newPhone();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Texts', phone, email: `${id}@example.invalid`, property_type: 'residential', ...over });
    created.customers.push(id);
    await createDefaultCustomerRows(db, id);
    return { id, phone };
  }

  async function account() {
    const id = randomUUID();
    await db('customer_accounts').insert({ id, first_name: 'Fixture' });
    created.accounts.push(id);
    return id;
  }

  // Every row the tool could have touched, to prove it only reads.
  async function rowCounts(c) {
    const count = async (query) => Number((await query.count('* as n').first()).n);
    return {
      sms: await count(db('sms_log').where({ customer_id: c.id })),
      audit: await count(db('messaging_audit_log').where({ customer_id: c.id })),
      suppression: await count(db('messaging_suppression').where({ phone: c.phone })),
      prefs: (await db('notification_prefs').where({ customer_id: c.id }).first('updated_at'))?.updated_at?.toISOString() || null,
    };
  }

  const status = (c) => executeCommsTool('get_customer_text_status', { customer_id: c.id });
  const blockedTypes = (out) => out.text_types.filter((t) => t.allowed === false).map((t) => t.type);

  test('an additional-property profile reads its five appointment texts off; the main profile on the same number reads all on', async () => {
    const accountId = await account();
    const main = await customer({ account_id: accountId, is_primary_profile: true });
    const second = await customer({ account_id: accountId, is_primary_profile: false, phone: main.phone, last_name: 'Second' });
    const before = await rowCounts(second);

    const out = await status(second);
    expect(out).toMatchObject({ customer_id: second.id, additional_property_profile: true, opted_out_of_all_texts: false, do_not_text_list: null });
    expect(blockedTypes(out)).toEqual(APPOINTMENT_TYPES);
    expect(out.text_types.find((t) => t.type === 'tech_en_route')).toMatchObject({ code: 'PURPOSE_OPTED_OUT' });
    expect(out.text_types.filter((t) => t.allowed === true).map((t) => t.type))
      .toEqual(['service_completion', 'billing', 'payment_receipt', 'review_request', 'conversational']);
    expect(await rowCounts(second)).toEqual(before);

    const mainOut = await status(main);
    expect(mainOut.additional_property_profile).toBe(false);
    expect(blockedTypes(mainOut)).toEqual([]);
    expect(mainOut.appointment_text_recipients).toEqual([{ role: 'primary', phone_last4: `…${main.phone.slice(-4)}` }]);
  });

  test('a STOP blocks every text type and the do-not-text row is named', async () => {
    const c = await customer();
    await db('notification_prefs').where({ customer_id: c.id }).update({ sms_enabled: false });
    await db('messaging_suppression').insert({ phone: c.phone, reason: 'opt_out_keyword', source: 'synthetic_test', captured_body: 'STOP' });
    const before = await rowCounts(c);

    const out = await status(c);
    expect(out.opted_out_of_all_texts).toBe(true);
    expect(out.do_not_text_list).toMatchObject({ reason: 'opt_out_keyword', source: 'synthetic_test' });
    expect(out.text_types.every((t) => t.allowed === false && t.code === 'SUPPRESSED_OPT_OUT')).toBe(true);
    expect(await rowCounts(c)).toEqual(before);

    // The do-not-text row cleared, the STOP on the settings row still blocks.
    await db('messaging_suppression').where({ phone: c.phone }).update({ active: false, cleared_at: new Date() });
    const stopOnly = await status(c);
    expect(stopOnly.do_not_text_list).toBeNull();
    expect(stopOnly.text_types.every((t) => t.allowed === false && t.code === 'SMS_OPTED_OUT')).toBe(true);
  });

  test('the 60-day lists: blocked sends without quiet-hours holds, undelivered texts, the last sent text', async () => {
    const c = await customer();
    const other = await customer();
    const audit = (customerId, over) => ({
      to_hash: 'a'.repeat(64), to_last4: '0000', customer_id: customerId, audience: 'customer', purpose: 'tech_en_route', channel: 'sms',
      body_hash: 'b'.repeat(64), ...over,
    });
    const daysAgo = (n) => new Date(Date.now() - n * 86400000);
    await db('messaging_audit_log').insert([
      audit(c.id, { blocked_code: 'PROVIDER_FAILURE', blocked_reason: 'synthetic provider failure', created_at: daysAgo(2) }),
      audit(c.id, { blocked_code: 'QUIET_HOURS_HOLD', blocked_reason: 'held', created_at: daysAgo(1) }),
      audit(c.id, { blocked_code: 'PROVIDER_FAILURE', blocked_reason: 'too old', created_at: daysAgo(90) }),
      audit(c.id, { blocked_code: 'EMAIL_OPTED_OUT', channel: 'email', created_at: daysAgo(1) }),
      audit(c.id, { created_at: daysAgo(1) }), // a sent row: no block
      audit(other.id, { blocked_code: 'PROVIDER_FAILURE', created_at: daysAgo(1) }),
    ]);
    const text = (customerId, over) => ({ customer_id: customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: c.phone, message_body: 'Synthetic text', message_type: 'reminder', ...over });
    await db('sms_log').insert([
      text(c.id, { status: 'undelivered', created_at: daysAgo(3) }),
      text(c.id, { status: 'undelivered', created_at: daysAgo(90) }),
      text(c.id, { status: 'delivered', message_type: 'receipt', created_at: daysAgo(5) }),
      text(c.id, { status: 'delivered', message_type: 'receipt', created_at: daysAgo(70) }),
      text(c.id, { status: 'received', direction: 'inbound', created_at: daysAgo(1) }),
      text(other.id, { status: 'delivered', created_at: daysAgo(1) }),
    ]);

    const out = await status(c);
    expect(out.recent_blocked).toEqual([{ time: expect.any(String), type: 'tech_en_route', code: 'PROVIDER_FAILURE', reason: 'synthetic provider failure' }]);
    expect(out.recent_not_delivered).toEqual([{ time: expect.any(String), type: 'reminder', status: 'undelivered' }]);
    expect(out.last_text_sent).toMatchObject({ type: 'receipt', status: 'delivered' });
    expect(Date.now() - new Date(out.last_text_sent.time).getTime()).toBeLessThan(6 * 86400000);
    expect(out.text_types.every((t) => t.allowed === true)).toBe(true);
  });

  // customers.phone is NOT NULL: a customer with no number carries an empty string.
  test('no phone on file answers without a check', async () => {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Nophone', phone: '', email: `${id}@example.invalid`, property_type: 'residential' });
    created.customers.push(id);
    expect(await executeCommsTool('get_customer_text_status', { customer_id: id })).toMatchObject({ customer_id: id, no_phone: true });
  });
});
