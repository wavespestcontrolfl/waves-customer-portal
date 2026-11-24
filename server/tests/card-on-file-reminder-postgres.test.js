/**
 * "Add a card" reminder email against the real migrated schema (skipped without DATABASE_URL; CI runs it).
 * The sweep reads real removal-email rows, real saved methods, visits and invoices, and sends through the real email
 * library and the real seeded template (migration 20261124130000) with a FAKE provider (SendGrid is mocked at
 * sendOne). Every run is scoped to the test's own customers (customerIds), and each test deletes its rows afterwards.
 * Synthetic names and addresses only.
 */
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(120000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'bell' })),
  NotificationService: {},
}));
// The library's handoff marker uses a second pool; point it at the app pool so jest can exit.
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/sendgrid-mail', () => ({
  ...jest.requireActual('../services/sendgrid-mail'),
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'fake-provider-id' })),
}));

const sendgrid = require('../services/sendgrid-mail');

// 10:00 AM ET on Tue Nov 24 2026. A removal on Nov 21 is exactly 3 days old; a card that expired in Nov (first bad day
// Dec 1) is due from Dec 4, so the expiry cases run at EXPIRY_NOW.
const NOW = new Date('2026-11-24T15:00:00Z');
const EXPIRY_NOW = new Date('2026-12-05T15:00:00Z');
const DUE_REMOVAL = new Date('2026-11-21T15:00:00Z');
const KEY = 'payment.card_on_file_reminder';

maybeDescribe('card on file reminder (real schema, fake provider)', () => {
  let db;
  let sweep;
  let lifecycle;
  let guard;
  let payer;
  const customerIds = [];

  beforeAll(() => {
    db = require('../models/db');
    sweep = require('../services/card-on-file-reminder');
    lifecycle = require('../services/payment-lifecycle-email');
    guard = require('../services/customer-lifecycle-guard');
    payer = require('../services/payer');
  });

  afterEach(async () => {
    sendgrid.sendOne.mockClear();
    jest.restoreAllMocks();
    delete process.env.GATE_CARD_ON_FILE_REMINDER;
    const ids = customerIds.splice(0);
    if (!ids.length) return;
    for (const [table, column] of [
      ['card_on_file_reminders', 'customer_id'], ['customer_interactions', 'customer_id'], ['autopay_log', 'customer_id'],
      ['payment_methods', 'customer_id'], ['invoices', 'customer_id'], ['scheduled_services', 'customer_id'],
      ['notification_prefs', 'customer_id'], ['email_messages', 'recipient_id'],
    ]) {
      await db(table).whereIn(column, ids).del().catch(() => {});
    }
    await db('email_suppressions').whereIn('email', ids.map((id) => `cof-${id}@example.invalid`)).del().catch(() => {});
    await db('customers').whereIn('id', ids).del();
  });

  afterAll(async () => {
    await db.destroy();
  });

  let n = 0;
  async function customer(extra = {}) {
    n += 1;
    const id = randomUUID();
    customerIds.push(id);
    await db('customers').insert({
      id, first_name: 'Sample', last_name: `Person${n}`, phone: `+1941555${String(7000 + n)}`, email: `cof-${id}@example.invalid`,
      address_line1: `${200 + n} Example Loop`, city: 'Sarasota', state: 'FL', zip: '34231',
      pipeline_stage: 'new_lead', active: true, billing_mode: 'per_application', ...extra,
    });
    return id;
  }
  async function removalEmail(customerId, createdAt = DUE_REMOVAL) {
    await db('email_messages').insert({
      template_key: 'payment.method_removed', recipient_type: 'customer', recipient_id: customerId,
      recipient_email_snapshot: `cof-${customerId}@example.invalid`, status: 'sent', created_at: createdAt,
      idempotency_key: `payment.method_removed:${customerId}:${randomUUID()}`,
    });
  }
  async function card(customerId, extra = {}) {
    const [row] = await db('payment_methods').insert({
      customer_id: customerId, processor: 'stripe', stripe_payment_method_id: `pm_${randomUUID()}`, method_type: 'card',
      card_brand: 'visa', last_four: '4242', exp_month: 12, exp_year: 2031, is_default: true, autopay_enabled: false, ...extra,
    }).returning('*');
    return row;
  }
  async function visit(customerId, date = '2026-12-02', extra = {}) {
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: date, service_type: 'Quarterly Pest Control Service', status: 'confirmed', ...extra,
    }).returning('id');
    return row.id;
  }
  async function invoice(customerId) {
    n += 1;
    await db('invoices').insert({
      token: randomUUID().replace(/-/g, ''), invoice_number: `COF-${Date.now()}-${n}`, customer_id: customerId,
      status: 'sent', subtotal: 100, total: 100, amount_paid: 0,
    });
  }
  const run = (id, opts = {}) => sweep.runCardOnFileReminderSweep({ now: NOW, customerIds: [id], ...opts });
  const ledger = (id) => db('card_on_file_reminders').where({ customer_id: id }).orderBy('created_at');
  const emails = (id) => db('email_messages').where({ template_key: KEY, recipient_id: id });

  // A removal 3 days ago, no card left, a visit on the calendar: the case every other test varies one rule of.
  async function dueCustomer(extra = {}) {
    const id = await customer(extra);
    await removalEmail(id);
    await visit(id);
    return id;
  }

  test('the real template is seeded, active, on the transactional stream', async () => {
    const template = await db('email_templates').where({ template_key: KEY }).first();
    expect(template).toMatchObject({ status: 'active', send_stream: 'transactional_required', suppression_group_key: 'transactional_required' });
    expect(template.active_version_id).toBeTruthy();
  });

  test('gate off: no query, no row, no email', async () => {
    const id = await dueCustomer();
    const result = await run(id);
    expect(result).toMatchObject({ mode: 'off', candidates: 0 });
    expect(await ledger(id)).toHaveLength(0);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('an unknown gate value is off, and the sender itself refuses unless the mode is true', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'yes';
    const id = await dueCustomer();
    expect((await run(id)).mode).toBe('off');
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    expect(await lifecycle.sendCardOnFileReminder({ customerId: id, propertyLabel: 'x', idempotencyKey: 'k' })).toMatchObject({ ok: false, reason: 'gate_off' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('shadow records who would get it and sends nothing; flipping to true then still sends it, once', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await dueCustomer();
    expect(await run(id)).toMatchObject({ mode: 'shadow', candidates: 1, shadow: 1, sent: 0 });
    const [row] = await ledger(id);
    expect(row).toMatchObject({ outcome: 'shadow', trigger_kind: 'removed' });
    expect(String(row.next_visit_date)).toContain('2026');
    expect(await emails(id)).toHaveLength(0);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();

    // A second shadow pass records nothing new.
    expect(await run(id)).toMatchObject({ shadow: 0, skipped: { sent_within_30_days: 1 } });
    expect(await ledger(id)).toHaveLength(1);

    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    expect(await run(id)).toMatchObject({ mode: 'true', sent: 1 });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect((await ledger(id)).map((r) => r.outcome).sort()).toEqual(['sent', 'shadow']);
    expect(await run(id)).toMatchObject({ sent: 0, skipped: { sent_within_30_days: 1 } });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });

  test('live: sends the approved email once with the property, the next visit and the save-only card link', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await dueCustomer();
    expect(await run(id)).toMatchObject({ sent: 1, failed: 0 });
    const [message] = await emails(id);
    expect(message).toMatchObject({ status: 'sent', subject_snapshot: 'Your Waves account has no card on file', recipient_email_snapshot: `cof-${id}@example.invalid` });
    expect(message.categories).toEqual(expect.arrayContaining(['payment', 'card_on_file_reminder']));
    expect(message.text_snapshot).toContain('Hi Sample,');
    expect(message.text_snapshot).toContain('Example Loop, Sarasota, FL 34231 are still on the schedule. Your account has no card on file now.');
    expect(message.text_snapshot).toContain('Next visit: December 2, 2026');
    expect(message.text_snapshot).toContain(`?tab=billing&add_card=1&notificationProperty=${id}`);
    expect(message.text_snapshot).toContain('Adding a card does not turn Auto Pay on.');
    const [row] = await ledger(id);
    expect(row).toMatchObject({ outcome: 'sent', email_message_id: message.id });
    // The same event never sends twice.
    expect(await run(id)).toMatchObject({ sent: 0 });
    expect(await emails(id)).toHaveLength(1);
  });

  test('timing: not before day 3, and not for an event older than the 10-day window', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const early = await customer();
    await removalEmail(early, new Date('2026-11-22T15:00:00Z'));
    await visit(early);
    const stale = await customer();
    await removalEmail(stale, new Date('2026-11-13T15:00:00Z'));
    await visit(stale);
    const lastDay = await customer();
    await removalEmail(lastDay, new Date('2026-11-14T15:00:00Z'));
    await visit(lastDay);
    expect(await sweep.runCardOnFileReminderSweep({ now: NOW, customerIds: [early, stale, lastDay] })).toMatchObject({ candidates: 1, shadow: 1 });
    expect(await ledger(early)).toHaveLength(0);
    expect(await ledger(stale)).toHaveLength(0);
    expect(await ledger(lastDay)).toHaveLength(1);
  });

  test('the NEWEST loss decides the timing: an older removal never sends early, and an older one is ignored once a newer one is due', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await customer();
    await visit(id);
    await removalEmail(id, new Date('2026-11-19T15:00:00Z'));
    await removalEmail(id, new Date('2026-11-23T15:00:00Z'));
    // Nov 24: the Nov 19 removal is 5 days old, but the last card went yesterday.
    expect(await run(id)).toMatchObject({ candidates: 0, shadow: 0 });
    // Nov 26: the newest loss is now 3 days old.
    expect(await run(id, { now: new Date('2026-11-26T15:00:00Z') })).toMatchObject({ candidates: 1, shadow: 1 });
    const [row] = await ledger(id);
    expect(String(row.trigger_on instanceof Date ? row.trigger_on.toISOString() : row.trigger_on)).toContain('2026-11-2');
    // A card that lapsed yesterday (Dec 1) postpones an older removal the same way.
    const expiring = await customer();
    await visit(expiring, '2026-12-20');
    await removalEmail(expiring, new Date('2026-11-27T15:00:00Z'));
    await card(expiring, { exp_month: 11, exp_year: 2026 });
    expect(await run(expiring, { now: new Date('2026-12-02T15:00:00Z') })).toMatchObject({ candidates: 0 });
    expect(await run(expiring, { now: new Date('2026-12-04T15:00:00Z') })).toMatchObject({ candidates: 1, shadow: 1 });
  });

  test('a card expiring in Jan-Sep is found whether its month is stored zero-padded (Stripe: 09) or not (9), and with a 2-digit year', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const at = new Date('2026-10-06T15:00:00Z');
    const ids = [];
    for (const [month, year] of [['09', '2026'], ['9', '2026'], ['09', '26']]) {
      const id = await customer();
      await visit(id, '2026-10-20');
      await card(id, { exp_month: month, exp_year: year });
      ids.push(id);
    }
    expect(await sweep.runCardOnFileReminderSweep({ now: at, customerIds: ids })).toMatchObject({ candidates: 3, shadow: 3 });
  });

  test('(a) a card added before day 3 ends it; an expired or unverified-bank method does not count as a card', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const added = await dueCustomer();
    await card(added);
    expect(await run(added)).toMatchObject({ shadow: 0, skipped: { has_usable_method: 1 } });

    const expired = await dueCustomer();
    await card(expired, { exp_month: 1, exp_year: 2026 });
    expect(await run(expired)).toMatchObject({ shadow: 1 });

    const pendingBank = await dueCustomer();
    await card(pendingBank, { method_type: 'ach', exp_month: null, exp_year: null, ach_status: 'pending_verification' });
    expect(await run(pendingBank)).toMatchObject({ shadow: 1 });

    const verifiedBank = await dueCustomer();
    await card(verifiedBank, { method_type: 'ach', exp_month: null, exp_year: null, ach_status: 'verified' });
    expect(await run(verifiedBank)).toMatchObject({ shadow: 0, skipped: { has_usable_method: 1 } });
  });

  test('(d) Auto Pay turned off on purpose while a card is kept: never emailed, whatever else is in the history', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await dueCustomer({ autopay_enabled: false });
    await card(id);
    await db('autopay_log').insert({ customer_id: id, event_type: 'autopay_disabled', details: JSON.stringify({}) });
    expect(await run(id)).toMatchObject({ sent: 0, skipped: { has_usable_method: 1 } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('(d) an EXPIRED card of a customer who turned Auto Pay off on purpose is not a trigger; one lost through a removal is', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const deliberate = await customer({ autopay_enabled: false });
    await visit(deliberate, '2026-12-12');
    await card(deliberate, { exp_month: 11, exp_year: 2026 });
    await db('autopay_log').insert({ customer_id: deliberate, event_type: 'autopay_disabled', details: JSON.stringify({}) });
    expect(await run(deliberate, { now: EXPIRY_NOW })).toMatchObject({ candidates: 1, shadow: 0, skipped: { autopay_off_on_purpose: 1 } });

    const cascaded = await customer({ autopay_enabled: false });
    await visit(cascaded, '2026-12-12');
    await card(cascaded, { exp_month: 11, exp_year: 2026 });
    await db('autopay_log').insert({ customer_id: cascaded, event_type: 'autopay_disabled', details: JSON.stringify({ source: 'payment_method_removed' }) });
    expect(await run(cascaded, { now: EXPIRY_NOW })).toMatchObject({ shadow: 1 });
    const [row] = await ledger(cascaded);
    expect(row).toMatchObject({ trigger_kind: 'expired', outcome: 'shadow' });

    // Staff turning it off (the Intelligence Bar, the office) is a person's choice too.
    const staff = await customer({ autopay_enabled: false });
    await visit(staff, '2026-12-12');
    await card(staff, { exp_month: 11, exp_year: 2026 });
    await db('autopay_log').insert({ customer_id: staff, event_type: 'autopay_disabled', details: JSON.stringify({ source: 'intelligence_bar' }) });
    expect(await run(staff, { now: EXPIRY_NOW })).toMatchObject({ shadow: 0, skipped: { autopay_off_on_purpose: 1 } });
  });

  test('expiry trigger: a card is good through the end of its expiry month, and the email is due 3 days after it lapsed', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await customer();
    await visit(id, '2026-12-12');
    await card(id, { exp_month: 11, exp_year: 2026 });
    // Dec 2: the card lapsed Dec 1, so it is day 1.
    expect(await run(id, { now: new Date('2026-12-02T15:00:00Z') })).toMatchObject({ candidates: 0 });
    expect(await run(id, { now: new Date('2026-12-04T15:00:00Z') })).toMatchObject({ candidates: 1, shadow: 1 });
    // A card with a 2-digit legacy year reads the same way.
    const legacy = await customer();
    await visit(legacy, '2026-12-12');
    await card(legacy, { exp_month: 11, exp_year: 26 });
    expect(await run(legacy, { now: EXPIRY_NOW })).toMatchObject({ shadow: 1 });
  });

  test('(b) needs an upcoming visit or an open invoice; with only an invoice the Next visit line is left out', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const nothing = await customer();
    await removalEmail(nothing);
    expect(await run(nothing)).toMatchObject({ sent: 0, skipped: { nothing_upcoming: 1 } });

    const past = await customer();
    await removalEmail(past);
    await visit(past, '2026-11-10', { status: 'completed' });
    const cancelled = await customer();
    await removalEmail(cancelled);
    await visit(cancelled, '2026-12-02', { status: 'cancelled' });
    expect(await sweep.runCardOnFileReminderSweep({ now: NOW, customerIds: [past, cancelled] })).toMatchObject({ sent: 0, skipped: { nothing_upcoming: 2 } });

    const owes = await customer();
    await removalEmail(owes);
    await invoice(owes);
    expect(await run(owes)).toMatchObject({ sent: 1 });
    const [message] = await emails(owes);
    expect(message.text_snapshot).toContain('Your account has no card on file now.');
    expect(message.text_snapshot).not.toContain('Next visit');
    expect(message.text_snapshot).not.toMatch(/\{\{|\}\}/);
  });

  test('(c) a deleted, inactive or churned customer is not emailed; an annual prepay with nothing due is not either, with an open invoice it is', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const inactive = await dueCustomer({ active: false });
    const churned = await dueCustomer({ pipeline_stage: 'churned' });
    const deleted = await dueCustomer({ deleted_at: new Date('2026-11-20T00:00:00Z') });
    expect(await sweep.runCardOnFileReminderSweep({ now: NOW, customerIds: [inactive, churned, deleted] })).toMatchObject({ shadow: 0, skipped: { customer_not_active: 3 } });

    jest.spyOn(guard, 'findActivePrepayTerm').mockResolvedValue({ id: 'term-1' });
    const prepaid = await dueCustomer();
    expect(await run(prepaid)).toMatchObject({ shadow: 0, skipped: { prepaid_nothing_due: 1 } });
    await invoice(prepaid);
    expect(await run(prepaid)).toMatchObject({ shadow: 1 });
  });

  test('a customer whose only visits bill a third-party payer is not emailed, and an unreadable payer picture fails closed', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const billed = await dueCustomer();
    const spy = jest.spyOn(payer, 'resolveForInvoice').mockResolvedValue({ payerId: 'payer-1' });
    expect(await run(billed)).toMatchObject({ shadow: 0, skipped: { payer_billed: 1 } });
    spy.mockRejectedValue(new Error('payer lookup down'));
    expect(await run(billed)).toMatchObject({ shadow: 0, skipped: { payer_check_failed: 1 } });
  });

  test('the payer is resolved per visit: a Bill-To on the first visit alone skips it, and the next self-pay visit is the one named', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await customer();
    await removalEmail(id);
    const billedVisit = await visit(id, '2026-12-02');
    await visit(id, '2026-12-09');
    jest.spyOn(payer, 'resolveForInvoice').mockImplementation(async ({ scheduledServiceId }) => (
      scheduledServiceId === billedVisit ? { payerId: 'payer-1' } : { payerId: null }
    ));
    expect(await run(id)).toMatchObject({ sent: 1 });
    const [message] = await emails(id);
    expect(message.text_snapshot).toContain('Next visit: December 9, 2026');
    expect(message.text_snapshot).not.toContain('December 2, 2026');
  });

  test('(e) at most one email per customer per 30 days', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const recent = await dueCustomer();
    await db('card_on_file_reminders').insert({
      customer_id: recent, trigger_kind: 'removed', trigger_key: 'removed:earlier', trigger_on: '2026-10-30', outcome: 'sent',
      created_at: new Date('2026-10-30T15:00:00Z'),
    });
    expect(await run(recent)).toMatchObject({ sent: 0, skipped: { sent_within_30_days: 1 } });

    const old = await dueCustomer();
    await db('card_on_file_reminders').insert({
      customer_id: old, trigger_kind: 'removed', trigger_key: 'removed:earlier', trigger_on: '2026-10-20', outcome: 'sent',
      created_at: new Date('2026-10-20T15:00:00Z'),
    });
    expect(await run(old)).toMatchObject({ sent: 1 });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });

  test('(f) an address with any active suppression, an unsubscribe included, is not emailed, and nothing is queued for it', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const bounced = await dueCustomer();
    await db('email_suppressions').insert({ email: `cof-${bounced}@example.invalid`, suppression_type: 'bounce', status: 'active', source: 'test' });
    const unsubscribed = await dueCustomer();
    await db('email_suppressions').insert({ email: `cof-${unsubscribed}@example.invalid`, suppression_type: 'unsubscribe', status: 'active', source: 'test' });
    expect(await sweep.runCardOnFileReminderSweep({ now: NOW, customerIds: [bounced, unsubscribed] })).toMatchObject({ sent: 0, skipped: { email_suppressed: 2 } });
    expect(await emails(bounced)).toHaveLength(0);
    expect(await emails(unsubscribed)).toHaveLength(0);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    // A released suppression no longer counts.
    await db('email_suppressions').where({ email: `cof-${unsubscribed}@example.invalid` }).update({ status: 'released' });
    expect(await run(unsubscribed)).toMatchObject({ sent: 1 });
  });

  test('a customer who chose the app (push) in the old billing reminder setting is not emailed; a text default or an explicit email choice is', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const push = await dueCustomer();
    await db('notification_prefs').insert({ customer_id: push, billing_channel: 'push' });
    expect(await run(push)).toMatchObject({ shadow: 0, skipped: { billing_email_not_selected: 1 } });
    const text = await dueCustomer();
    await db('notification_prefs').insert({ customer_id: text, billing_channel: 'sms' });
    const email = await dueCustomer();
    await db('notification_prefs').insert({ customer_id: email, billing_channel: 'push', billing_channels: ['email'] });
    expect(await sweep.runCardOnFileReminderSweep({ now: NOW, customerIds: [text, email] })).toMatchObject({ shadow: 2 });
    const appOnly = await dueCustomer();
    await db('notification_prefs').insert({ customer_id: appOnly, billing_channels: ['push'] });
    expect(await run(appOnly)).toMatchObject({ shadow: 0, skipped: { billing_email_not_selected: 1 } });
  });

  test('a bounce-recovery copy of a removal notice is not an event: a fresh created_at never moves an old removal', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await customer();
    await visit(id);
    await removalEmail(id, new Date('2026-11-20T15:00:00Z'));
    await db('email_messages').insert({
      template_key: 'payment.method_removed', recipient_type: 'customer', recipient_id: id, recipient_email_snapshot: `cof-${id}@example.invalid`,
      status: 'sent', created_at: new Date('2026-11-23T15:00:00Z'), idempotency_key: `bounce_recovery:${randomUUID()}`,
    });
    // The recovery copy (Nov 23) would postpone the Nov 20 removal to Nov 26; the original decides, so it is due today.
    expect(await run(id)).toMatchObject({ candidates: 1, shadow: 1 });
    const stale = await customer();
    await visit(stale);
    await db('email_messages').insert({
      template_key: 'payment.method_removed', recipient_type: 'customer', recipient_id: stale, recipient_email_snapshot: `cof-${stale}@example.invalid`,
      status: 'sent', created_at: new Date('2026-11-21T15:00:00Z'), idempotency_key: `bounce_recovery:${randomUUID()}`,
    });
    expect(await run(stale)).toMatchObject({ candidates: 0 });
  });

  test('two methods lost on the same ET day pick the same trigger in the sweep and in the handoff re-read, whatever order the rows come back in', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await dueCustomer();
    await removalEmail(id);
    await removalEmail(id);
    await removalEmail(id);
    jest.spyOn(lifecycle, 'sendCardOnFileReminder').mockImplementationOnce(async (args) => {
      expect(await args.beforeProviderHandoff()).toBe(true);
      return { ok: false, reason: 'stopped' };
    });
    expect(await run(id)).toMatchObject({ skipped: { stopped: 1 } });
  });

  test('a customer whose active flag is NULL cannot sign in to the linked form and is not emailed', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await dueCustomer({ active: null });
    expect(await run(id)).toMatchObject({ shadow: 0, skipped: { customer_not_active: 1 } });
  });

  test('a customer with no email address is skipped', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await dueCustomer({ email: null });
    expect(await run(id)).toMatchObject({ shadow: 0, skipped: { missing_email: 1 } });
  });

  test('the checks run again right before the provider request: a card added in between stops the send', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await dueCustomer();
    jest.spyOn(lifecycle, 'sendCardOnFileReminder').mockImplementation(async (args) => {
      await card(id);
      expect(await args.beforeProviderHandoff()).toBe(false);
      return { ok: false, reason: 'stopped' };
    });
    expect(await run(id)).toMatchObject({ sent: 0, skipped: { stopped: 1 } });
    expect(await ledger(id)).toHaveLength(0);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('the visit named in the email changing before the provider request stops the send; the next pass sends the new facts', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await customer();
    await removalEmail(id);
    const visitId = await visit(id, '2026-12-02');
    await invoice(id);
    const real = lifecycle.sendCardOnFileReminder;
    const stub = jest.spyOn(lifecycle, 'sendCardOnFileReminder').mockImplementationOnce(async (args) => {
      // The visit is cancelled in between: an invoice is still open, so the customer stays eligible, but the email
      // would name a visit that is gone.
      await db('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
      expect(await args.beforeProviderHandoff()).toBe(false);
      return { ok: false, reason: 'stopped' };
    });
    expect(await run(id)).toMatchObject({ sent: 0, skipped: { stopped: 1 } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    stub.mockImplementation(real);
    expect(await run(id)).toMatchObject({ sent: 1 });
    const [message] = await emails(id);
    expect(message.text_snapshot).not.toContain('Next visit');
  });

  test('a card removed after the sweep read its events makes a newer loss that is not due: the send stops', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await dueCustomer();
    jest.spyOn(lifecycle, 'sendCardOnFileReminder').mockImplementationOnce(async (args) => {
      await removalEmail(id, new Date('2026-11-24T14:00:00Z'));
      expect(await args.beforeProviderHandoff()).toBe(false);
      return { ok: false, reason: 'stopped' };
    });
    expect(await run(id)).toMatchObject({ sent: 0, skipped: { stopped: 1 } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await ledger(id)).toHaveLength(0);
  });

  test('a visit booked at a secondary saved property names that property, not the profile address', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    const id = await customer();
    await removalEmail(id);
    await visit(id, '2026-12-02', {
      service_address_line1: '77 Rental Court', service_address_city: 'Venice', service_address_state: 'FL', service_address_zip: '34285',
    });
    expect(await run(id)).toMatchObject({ sent: 1 });
    const [message] = await emails(id);
    expect(message.text_snapshot).toContain('Your Waves visits at 77 Rental Court, Venice, FL 34285 are still on the schedule.');
    expect(message.text_snapshot).not.toContain('Example Loop');
  });

  test('the payer search pages past the first ten visits: an eleventh visit that bills the customer still counts', async () => {
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    const id = await customer();
    await removalEmail(id);
    const ids = [];
    for (let day = 1; day <= 11; day += 1) ids.push(await visit(id, `2027-01-${String(day).padStart(2, '0')}`));
    jest.spyOn(payer, 'resolveForInvoice').mockImplementation(async ({ scheduledServiceId }) => (
      scheduledServiceId === ids[10] ? { payerId: null } : { payerId: 'payer-1' }
    ));
    expect(await run(id)).toMatchObject({ shadow: 1 });
    const [row] = await ledger(id);
    expect(String(row.next_visit_date)).toContain('2027');
  });

  test('a collections dispute hold withholds it in live AND shadow mode, writes no ledger row, and the next pass tries again', async () => {
    const id = await dueCustomer();
    const hold = require('../services/collections/collection-hold');
    jest.spyOn(hold, 'messagingHeldByCollectionHold').mockResolvedValue({ held: true, reason: 'dispute' });
    process.env.GATE_CARD_ON_FILE_REMINDER = 'shadow';
    expect(await run(id)).toMatchObject({ shadow: 0, skipped: { collection_hold: 1 } });
    process.env.GATE_CARD_ON_FILE_REMINDER = 'true';
    expect(await run(id)).toMatchObject({ sent: 0, skipped: { collection_hold: 1 } });
    expect(await ledger(id)).toHaveLength(0);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});
