/**
 * "Your Multi-Home Discount is on" email against the real migrated schema (skipped without DATABASE_URL; CI runs it).
 * PR 2's job applies the discount, then the email job reads its ledger and sends through the real email library, the
 * real seeded template (migration 20261105040000) and a FAKE provider (SendGrid is mocked at sendOne). The data reads
 * run inside ONE outer transaction that is rolled back; the email rows the library writes on its own pool are deleted by
 * idempotency key afterwards. Synthetic names and addresses only.
 */
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
jest.setTimeout(120000);

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GATE_MULTI_HOME_ALL_HOMES = 'true';
process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL = 'true';
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';

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

const NOW = new Date('2026-11-06T15:00:00Z');
const ACCEPTED_AT = new Date('2026-11-05T15:00:00Z');
const TEMPLATE_KEY = 'customer.multi_home_discount_on';

class Rollback extends Error {}

maybeDescribe('Multi-Home Discount email (real schema, fake provider)', () => {
  let conn;
  let apply;
  let mail;
  let appDb;
  const estimateIds = [];

  beforeAll(() => {
    conn = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 1 } });
    apply = require('../services/multi-home-discount-apply');
    mail = require('../services/multi-home-discount-email');
    appDb = require('../models/db');
  });
  afterEach(async () => {
    sendgrid.sendOne.mockClear();
    for (const id of estimateIds.splice(0)) await appDb('email_messages').where('idempotency_key', 'like', `${TEMPLATE_KEY}:${id}:%`).del();
    jest.restoreAllMocks();
    process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL = 'true';
  });
  afterAll(async () => {
    if (conn) await conn.destroy();
    await appDb.destroy();
  });

  async function inRollback(fn) {
    try {
      await conn.transaction(async (trx) => {
        await fn(trx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }

  let n = 0;
  async function customer(trx, extra = {}) {
    n += 1;
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: n % 2 ? 'Sample' : 'Example', last_name: `Person${n}`, phone: `+1941555${String(5000 + n)}`, email: `mhe-${id}@example.invalid`,
      address_line1: `${200 + n} Example Loop`, city: 'Sarasota', state: 'FL', zip: '34231',
      pipeline_stage: 'new_lead', active: true, billing_mode: 'per_application', per_application_fee: 120, ...extra,
    });
    return id;
  }
  async function property(trx, customerId, extra = {}) {
    n += 1;
    const id = randomUUID();
    await trx('customer_properties').insert({
      id, customer_id: customerId, address_line1: `${300 + n} Sample Court`, city: 'Sarasota', state: 'FL', zip: '34231',
      is_primary: true, active: true, ...extra,
    });
    return id;
  }
  async function link(trx, a, b) {
    const familyId = randomUUID();
    await trx('multi_home_family_members').insert([{ customer_id: a, family_id: familyId }, { customer_id: b, family_id: familyId }]);
  }
  async function estimate(trx, customerId, propertyId) {
    const id = randomUUID();
    estimateIds.push(id);
    await trx('estimates').insert({
      id, customer_id: customerId, property_id: propertyId, status: 'accepted', accepted_at: ACCEPTED_AT, token: randomUUID().replace(/-/g, ''),
      estimate_data: JSON.stringify({ summary: { manualDiscount: { presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40 } } }),
    });
    return id;
  }
  async function series(trx, { customerId, propertyId, price = 120, dates = ['2026-11-14', '2027-02-13', '2027-05-15'], sourceEstimateId = null, childExtra = {} }) {
    const rootId = randomUUID();
    const base = {
      customer_id: customerId, property_id: propertyId, service_type: 'Quarterly Pest Control Service', is_recurring: true,
      recurring_pattern: 'quarterly', service_category_snapshot: 'pest_control', service_key_snapshot: 'pest_general_quarterly',
      estimated_price: price, source_estimate_id: sourceEstimateId,
    };
    await trx('scheduled_services').insert({ id: rootId, ...base, scheduled_date: '2026-08-15', status: 'completed' });
    const ids = [];
    for (const date of dates) {
      const id = randomUUID();
      await trx('scheduled_services').insert({ id, ...base, recurring_parent_id: rootId, scheduled_date: date, status: 'pending', ...childExtra });
      ids.push(id);
    }
    return { rootId, ids };
  }
  // The parents' home (target) and the son's new home (source), linked as one family; the son pays by card on file
  // (no card here, so he is invoiced), the parents' home bills to a Bill-To payer.
  async function family(trx, { parentsExtra = {} } = {}) {
    const parents = await customer(trx, parentsExtra);
    const parentsHome = await property(trx, parents);
    const son = await customer(trx);
    const sonHome = await property(trx, son);
    await link(trx, parents, son);
    const estimateId = await estimate(trx, son, sonHome);
    const sonSeries = await series(trx, { customerId: son, propertyId: sonHome, price: 90, sourceEstimateId: estimateId });
    const parentSeries = await series(trx, { customerId: parents, propertyId: parentsHome });
    return { parents, parentsHome, son, sonHome, estimateId, sonSeries, parentSeries };
  }
  const messages = (estimateId) => appDb('email_messages').where('idempotency_key', 'like', `${TEMPLATE_KEY}:${estimateId}:%`).orderBy('recipient_email_snapshot');
  const emailRun = (trx, opts = {}) => mail.runMultiHomeDiscountEmail({ now: NOW, dbh: trx, ...opts });

  test('the real template is seeded, active, on the transactional stream, with preview fixtures', async () => {
    const template = await appDb('email_templates').where({ template_key: TEMPLATE_KEY }).first();
    expect(template).toMatchObject({ status: 'active', send_stream: 'transactional_required', suppression_group_key: 'transactional_required' });
    expect(template.active_version_id).toBeTruthy();
    const fixtures = await appDb('email_template_fixtures').where({ template_id: template.id });
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    expect(fixtures.filter((f) => f.is_default)).toHaveLength(1);
    const { renderVersion } = require('../services/email-template-library');
    for (const f of fixtures) {
      const rendered = await renderVersion(template.active_version_id, f.payload);
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.text).toContain('YOUR MULTI-HOME DISCOUNT IS ON');
    }
  });

  test('PR 2 applies, then the email is recorded once per paying address; a second run sends nothing', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const discount = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(discount).toMatchObject({ applied: 1, held: 0 });

      const first = await emailRun(trx);
      expect(first).toMatchObject({ ok: true, sources: 1, sent: 2, failed: 0, waiting: 0 });
      const rows = await messages(f.estimateId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.template_key === TEMPLATE_KEY && r.status === 'sent' && r.subject_snapshot === 'Your Multi-Home Discount is on')).toBe(true);
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(2);

      const parentsRow = rows.find((r) => r.recipient_id === f.parents);
      const sonRow = rows.find((r) => r.recipient_id === f.son);
      // The parents' email lists only the parents' home, from the PR 2 ledger.
      expect(parentsRow.text_snapshot).toContain('Regular: $120.00');
      expect(parentsRow.text_snapshot).toContain('Multi-Home 10%: -$12.00');
      expect(parentsRow.text_snapshot).toContain('Per application: $108.00');
      expect(parentsRow.text_snapshot).toContain('Starts: Sat, Nov 14');
      expect(parentsRow.text_snapshot).toContain('Service: Quarterly Pest Control Service');
      expect(parentsRow.text_snapshot).toContain('How it is paid: Invoice after each visit');
      // The son's email lists the new home from stored records only.
      expect(sonRow.text_snapshot).toContain('Per application: $90.00');
      expect(sonRow.text_snapshot).toContain('Regular: $100.00');
      expect(sonRow.text_snapshot).toContain('Multi-Home 10%: -$10.00');
      expect(sonRow.text_snapshot).toContain('Starts: Sat, Nov 14');
      expect(sonRow.text_snapshot).not.toContain('Per application: $108.00');
      expect(sonRow.text_snapshot).toContain('Hi Sample,');
      expect(sonRow.html_snapshot).toContain('Your Multi-Home Discount is on');

      const second = await emailRun(trx);
      expect(second).toMatchObject({ sent: 0, deduped: 2, failed: 0 });
      expect(await messages(f.estimateId)).toHaveLength(2);
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(2);
    });
  });

  test('both homes paying to one address get ONE email listing both', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const shared = `shared-${randomUUID()}@example.invalid`;
      await trx('customers').whereIn('id', [f.parents, f.son]).update({ email: shared });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(await emailRun(trx)).toMatchObject({ sent: 1 });
      const rows = await messages(f.estimateId);
      expect(rows).toHaveLength(1);
      expect(rows[0].text_snapshot).toContain('Per application: $90.00');
      expect(rows[0].text_snapshot).toContain('Per application: $108.00');
    });
  });

  test('a Bill-To payer\'s AP email receives the home it pays for, greeted by its first word', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const [payer] = await trx('payers').insert({ display_name: 'Morgan Example', ap_email: `ap-${randomUUID()}@example.invalid`, active: true }).returning('*');
      await trx('customers').where({ id: f.parents }).update({ payer_id: payer.id });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(await emailRun(trx)).toMatchObject({ sent: 2 });
      const rows = await messages(f.estimateId);
      const toPayer = rows.find((r) => r.recipient_email_snapshot === payer.ap_email);
      expect(toPayer).toBeTruthy();
      expect(toPayer.recipient_type).toBe('payer');
      expect(toPayer.text_snapshot).toContain('Hi Morgan,');
      expect(toPayer.text_snapshot).toContain('How it is paid: Invoice to you by email');
      expect(toPayer.text_snapshot).not.toContain('Per application: $90.00');
    });
  });

  // A sender that makes a staff edit after the job grouped the homes, then hands the send to the real library.
  const sendAfter = (edit) => async (args) => {
    await edit(args);
    return require('../services/email-template-library').sendTemplate(args);
  };

  test('an email address changed after grouping: refused at the provider handoff; the next run mails the new address once', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const moved = `moved-${randomUUID()}@example.invalid`;
      const first = await emailRun(trx, { send: sendAfter(() => trx('customers').where({ id: f.son }).update({ email: moved })) });
      expect(first).toMatchObject({ sent: 1, waiting: 1, failed: 0 });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      const refused = (await messages(f.estimateId)).find((r) => r.recipient_id === f.son);
      expect(refused).toMatchObject({ status: 'failed', error_message: 'aborted_by_caller_before_dispatch' });

      const second = await emailRun(trx);
      expect(second).toMatchObject({ sent: 1, deduped: 1, failed: 0 });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(2);
      const rows = await messages(f.estimateId);
      expect(rows.filter((r) => r.status === 'sent').map((r) => r.recipient_email_snapshot)).toContain(moved);
    });
  });

  test('a profile turns email off after grouping: refused at the provider handoff, and never sent after', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      const switchOff = async () => {
        const changed = await trx('notification_prefs').where({ customer_id: f.son }).update({ email_enabled: false });
        if (!changed) await trx('notification_prefs').insert({ customer_id: f.son, email_enabled: false });
      };
      expect(await emailRun(trx, { send: sendAfter(switchOff) })).toMatchObject({ sent: 1, waiting: 1 });
      expect(await emailRun(trx)).toMatchObject({ sent: 0, deduped: 1, failed: 0 });
      expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect((await messages(f.estimateId)).filter((r) => r.status === 'sent').map((r) => r.recipient_id)).toEqual([f.parents]);
    });
  });

  test('a held target blocks the send; once it is no longer a target the email goes', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      // A visit that already carries a different discount holds the target.
      await trx('scheduled_services').where({ id: f.parentSeries.ids[0] }).update({ discount_type: 'percentage', discount_amount: 5, discount_dollars: 5.85 });
      const discount = await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(discount).toMatchObject({ applied: 0, held: 1 });
      expect(await emailRun(trx)).toMatchObject({ sent: 0, waiting: 1 });
      expect(await messages(f.estimateId)).toHaveLength(0);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();

      // The family link is removed: the held series is no longer a target, PR 2 drops its held row, the email goes.
      await trx('multi_home_family_members').del();
      await trx('customers').where({ id: f.son }).update({ has_multi_home: true });
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      expect(await trx('multi_home_discount_applications').where({ source_estimate_id: f.estimateId, status: 'held' })).toHaveLength(0);
      expect(await emailRun(trx)).toMatchObject({ sent: 1, waiting: 0 });
      const rows = await messages(f.estimateId);
      expect(rows).toHaveLength(1);
      expect(rows[0].recipient_id).toBe(f.son);
      expect(rows[0].text_snapshot).not.toContain('$108.00');
    });
  });

  test('staff take the discount off another home after it was applied: the email does not claim it', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ applied: 1 });
      // Before the email runs, staff remove the discount from the parents' upcoming visits (back to the regular price).
      await trx('scheduled_services').whereIn('id', f.parentSeries.ids).update({
        estimated_price: 120, discount_id: null, discount_name: null, discount_type: null, discount_amount: null, discount_dollars: null,
      });
      expect(await emailRun(trx)).toMatchObject({ sent: 0, waiting: 1 });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await messages(f.estimateId)).toHaveLength(0);
    });
  });

  test('staff reprice the new home after the sale: the email does not claim its discount', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ applied: 1 });
      await trx('scheduled_services').whereIn('id', f.sonSeries.ids).update({ estimated_price: 100 });
      expect(await emailRun(trx)).toMatchObject({ sent: 0, waiting: 1 });
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });
  });

  test('a home sold with the discount netted in is proven from its own sale and shows its Regular and 10%', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      // The parents' plan was sold long ago (outside the 14-day window, so it is not a source itself) with the
      // Multi-Home Discount netted into its price.
      const sold = randomUUID();
      await trx('estimates').insert({
        id: sold, customer_id: f.parents, property_id: f.parentsHome, status: 'accepted', accepted_at: new Date(NOW.getTime() - 60 * 86400000),
        token: randomUUID().replace(/-/g, ''),
        estimate_data: JSON.stringify({ summary: { manualDiscount: { presetKey: 'multi_home', type: 'PERCENT', value: 10, recurringAmount: 40, amount: 40 } } }),
      });
      await trx('scheduled_services').whereIn('id', [f.parentSeries.rootId, ...f.parentSeries.ids]).update({ source_estimate_id: sold, estimated_price: 90 });
      expect(await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx })).toMatchObject({ already: 1, applied: 0 });
      expect(await emailRun(trx)).toMatchObject({ sent: 2, waiting: 0 });
      const parentsRow = (await messages(f.estimateId)).find((r) => r.recipient_id === f.parents);
      expect(parentsRow.text_snapshot).toContain('Regular: $100.00');
      expect(parentsRow.text_snapshot).toContain('Multi-Home 10%: -$10.00');
      expect(parentsRow.text_snapshot).toContain('Per application: $90.00');
    });
  });

  test('gate off: no email row, no provider call', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL = 'false';
      expect(await emailRun(trx)).toEqual({ ok: false, reason: 'gate_off' });
      expect(await messages(f.estimateId)).toHaveLength(0);
      expect(sendgrid.sendOne).not.toHaveBeenCalled();
    });
  });

  test('a source past the 14-day window is never sent', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      await trx('estimates').where({ id: f.estimateId }).update({ accepted_at: new Date('2026-10-01T15:00:00Z') });
      expect(await emailRun(trx)).toMatchObject({ sources: 0, sent: 0 });
      expect(await messages(f.estimateId)).toHaveLength(0);
    });
  });

  const backdate = (id) => appDb('email_messages').where({ id }).update({ updated_at: appDb.raw("now() - interval '25 hours'") });
  const failedRows = async (estimateId) => (await messages(estimateId)).filter((r) => String(r.status).toLowerCase() === 'failed');

  test('a definite provider rejection is never replayed from stored copy; the job re-sends it after fresh checks, once a day', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('not configured'), { code: 'SENDGRID_NOT_CONFIGURED' }));
      expect((await emailRun(trx)).sent).toBe(1);
      const failed = await failedRows(f.estimateId);
      expect(failed).toHaveLength(1);
      expect(failed[0].provider_handoff_phase).toBe('rejected');
      // The stored-copy retry rail never schedules this category.
      expect(failed[0].provider_retry_next_at).toBeNull();
      const calls = sendgrid.sendOne.mock.calls.length;
      // The same day: the failed address waits; nothing is sent.
      expect(await emailRun(trx)).toMatchObject({ sent: 0, waiting: 1 });
      expect(sendgrid.sendOne.mock.calls.length).toBe(calls);
      // A day later (the database clock), after the job's fresh checks, it is sent once.
      await backdate(failed[0].id);
      expect(await emailRun(trx)).toMatchObject({ sent: 1 });
      expect(sendgrid.sendOne.mock.calls.length).toBe(calls + 1);
    });
  });

  test('an ambiguous provider failure (it may have been delivered) is never re-sent, and is skipped quietly', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), { code: 503 }));
      await emailRun(trx);
      const failed = await failedRows(f.estimateId);
      expect(failed).toHaveLength(1);
      expect(failed[0].provider_handoff_phase).toBe('started');
      await backdate(failed[0].id);
      const calls = sendgrid.sendOne.mock.calls.length;
      expect(await emailRun(trx)).toMatchObject({ sent: 0, failed: 0, skipped: 1 });
      expect(sendgrid.sendOne.mock.calls.length).toBe(calls);
    });
  });

  test('the kill switch holds for a failed send: gate off, nothing is retried', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
      sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), { code: 503 }));
      await emailRun(trx);
      const failed = (await messages(f.estimateId)).find((r) => String(r.status).toLowerCase() === 'failed');
      await appDb('email_messages').where({ id: failed.id }).update({ updated_at: appDb.raw("now() - interval '25 hours'") });
      const calls = sendgrid.sendOne.mock.calls.length;
      const before = process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL;
      delete process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL;
      try {
        expect(await emailRun(trx)).toMatchObject({ ok: false, reason: 'gate_off' });
        expect(sendgrid.sendOne.mock.calls.length).toBe(calls);
      } finally {
        if (before !== undefined) process.env.GATE_MULTI_HOME_DISCOUNT_EMAIL = before;
      }
    });
  });

  test('an address on the suppression list is blocked by the normal sender and never retried', async () => {
    await inRollback(async (trx) => {
      const f = await family(trx);
      const blocked = (await trx('customers').where({ id: f.parents }).first('email')).email;
      await appDb('email_suppressions').insert({ email: blocked, suppression_type: 'bounce', group_key: null, status: 'active' });
      try {
        await apply.runMultiHomeAllHomes({ now: NOW, dbh: trx });
        expect(await emailRun(trx)).toMatchObject({ sent: 1, blocked: 1, failed: 0 });
        expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
        expect(await emailRun(trx)).toMatchObject({ sent: 0, blocked: 1, deduped: 1, failed: 0 });
        expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
        const row = (await messages(f.estimateId)).find((r) => r.recipient_email_snapshot === blocked);
        expect(row.status).toBe('blocked');
      } finally {
        await appDb('email_suppressions').where({ email: blocked }).del();
      }
    });
  });
});
