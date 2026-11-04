/**
 * GATE_PORTAL_EMAIL_RESUBSCRIBE on real PostgreSQL: which email_suppressions
 * rows a customer's own Email-messages switch may release (the SQL, including
 * the Gmail-spelling match), and the stamps the release writes.
 *
 * Every case runs in a transaction that is always rolled back, on the real table.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('email resubscribe on PostgreSQL', () => {
  let db;
  let service;
  let n = 0;

  beforeAll(() => {
    db = require('../models/db');
    service = require('../services/email-resubscribe');
  });
  afterAll(async () => { await db.destroy(); });

  const uniq = () => `resub-${Date.now()}-${++n}`;

  async function inRolledBackTx(fn) {
    const rollback = new Error('rollback');
    try {
      await db.transaction(async (trx) => { await fn(trx); throw rollback; });
    } catch (e) { if (e !== rollback) throw e; }
  }
  const sup = async (trx, row) => {
    const [saved] = await trx('email_suppressions').insert({
      status: 'active', group_key: null, suppression_type: 'unsubscribe', source: 'sendgrid_event_webhook', ...row,
    }).returning('*');
    return saved;
  };

  test('a global unsubscribe and a service_operational unsubscribe release', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const globalRow = await sup(trx, { email });
      const serviceRow = await sup(trx, { email, group_key: 'service_operational' });
      const rows = await service.releasableUnsubscribes(email.toUpperCase(), { dbh: trx });
      expect(rows.map((r) => r.id).sort()).toEqual([globalRow.id, serviceRow.id].sort());
    });
  });

  test('the two June 2026 SendGrid-import sources (customer unsubscribes made at SendGrid) release', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const asm = await sup(trx, { email, group_key: 'service_operational', source: 'sendgrid_asm_backfill' });
      const dropped = await sup(trx, { email, group_key: 'service_operational', source: 'sendgrid_dropped_backfill_2026_06_01' });
      const rows = await service.releasableUnsubscribes(email, { dbh: trx });
      expect(rows.map((r) => r.id).sort()).toEqual([asm.id, dropped.id].sort());
    });
  });

  test('a staff-made row stays staff-made after the webhook overwrote its source (metadata.created_by survives, even null)', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      await sup(trx, { email, metadata: JSON.stringify({ created_by: 'tech-1', reason: 'asked by phone' }) });
      await sup(trx, { email, metadata: JSON.stringify({ created_by: null }) });
      expect(await service.releasableUnsubscribes(email, { dbh: trx })).toEqual([]);
    });
  });

  test('never releasable: newsletter, bounce, spam complaint, do-not-email, staff-made, already released', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      await sup(trx, { email, group_key: 'marketing_newsletter' });
      await sup(trx, { email, suppression_type: 'bounce' });
      await sup(trx, { email, suppression_type: 'spam_complaint' });
      await sup(trx, { email, suppression_type: 'do_not_email' });
      await sup(trx, { email, source: 'admin_manual' });
      await sup(trx, { email, status: 'released' });
      await sup(trx, { email: `other-${uniq()}@example.com` });
      expect(await service.releasableUnsubscribes(email, { dbh: trx })).toEqual([]);
    });
  });

  test('a Gmail-equivalent spelling of the address is covered', async () => {
    await inRolledBackTx(async (trx) => {
      const local = uniq().replace(/-/g, '');
      const row = await sup(trx, { email: `${local.slice(0, 5)}.${local.slice(5)}@gmail.com` });
      const rows = await service.releasableUnsubscribes(`${local}@gmail.com`, { dbh: trx });
      expect(rows.map((r) => r.id)).toEqual([row.id]);
    });
  });

  test('release skips a row that is not in onlyIds, and releases nothing without onlyIds', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const cleared = await sup(trx, { email });
      const late = await sup(trx, { email, group_key: 'service_operational' });
      expect((await service.releaseOwnUnsubscribes({ email, customerId: 'c-1', actor: 'holder' }, { dbh: trx }))).toEqual([]);
      const released = await service.releaseOwnUnsubscribes({ email, customerId: 'c-1', actor: 'holder', onlyIds: [cleared.id] }, { dbh: trx });
      expect(released.map((r) => r.id)).toEqual([cleared.id]);
      expect((await trx('email_suppressions').where({ id: late.id }).first()).status).toBe('active');
    });
  });

  test('release stamps the rows, keeps earlier metadata, and leaves other blocks active', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const unsub = await sup(trx, { email, metadata: JSON.stringify({ provider: 'sendgrid' }) });
      const bounce = await sup(trx, { email, suppression_type: 'bounce' });
      const note = { ok: true, status: 204, at: new Date().toISOString() };
      const released = await service.releaseOwnUnsubscribes({
        email, customerId: 'c-1', actor: 'holder', onlyIds: [unsub.id], sendgridClear: { [unsub.id]: note },
      }, { dbh: trx });
      expect(released.map((r) => r.id)).toEqual([unsub.id]);
      const after = await trx('email_suppressions').where({ id: unsub.id }).first();
      expect(after).toMatchObject({ status: 'released', consent_source: 'portal_email_switch' });
      expect(after.released_at).toBeInstanceOf(Date);
      expect(after.consent_timestamp).toBeInstanceOf(Date);
      expect(after.metadata).toMatchObject({
        provider: 'sendgrid', released_via: 'portal_email_switch', released_by: null,
        released_for_customer_id: 'c-1', actor: 'holder', contact_slot: null, sendgrid_clear: note,
      });
      expect((await trx('email_suppressions').where({ id: bounce.id }).first()).status).toBe('active');
      expect(await service.releasableUnsubscribes(email, { dbh: trx })).toEqual([]);
    });
  });
});
