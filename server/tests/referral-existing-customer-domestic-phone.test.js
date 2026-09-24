/**
 * Audit repro r1-leads-reviews-3: submitReferral's "already a Waves customer"
 * guard compares customers.phone by exact equality to the E.164 form OR the
 * raw typed string only. A customer stored in domestic format
 * ('(941) 555-1234') is missed when the admin types '941-555-1234', so a
 * referral row + duplicate lead are written and the invite SMS fires.
 *
 * Written to assert the EXPECTED behaviour (refusal, no writes, no SMS), so
 * it FAILS on current code if the bug is real. CONTROL cases show the guard
 * works when the stored phone matches one of the two exact shapes.
 *
 * Runs only against a private waves_audit_* Postgres clone:
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_<slug>
 * Skips cleanly (no throw) when no such database is configured — the full
 * CI job runs with no DATABASE_URL at all.
 */
const knex = require('knex');
const crypto = require('crypto');

const connection = process.env.DATABASE_URL;
const hasAuditDb = !!connection && /waves_audit_/.test(connection);

let mockPg;
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockSend = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'invite body'),
}));

const engine = require('../services/referral-engine');

async function seed({ storedPhone }) {
  const customerId = crypto.randomUUID();
  const promoterCustomerId = crypto.randomUUID();
  await mockPg('customers').insert({ id: customerId, first_name: 'Existing', last_name: 'Customer', phone: storedPhone, email: `existing-${customerId}@example.test` });
  await mockPg('customers').insert({ id: promoterCustomerId, first_name: 'Promo', last_name: 'Ter', phone: '+12025550999', email: `promo-${promoterCustomerId}@example.test` });
  const [promoter] = await mockPg('referral_promoters').insert({
    customer_id: promoterCustomerId, first_name: 'Promo', last_name: 'Ter',
    customer_phone: '+12025550999', referral_code: crypto.randomBytes(4).toString('hex').toUpperCase(),
  }).returning('*');
  return { customerId, promoterCustomerId, promoter };
}

async function cleanup(f) {
  await mockPg('referrals').where({ promoter_id: f.promoter.id }).del().catch(() => {});
  // No leads delete here (Codex round 1 P1): every case in this file
  // asserts the guard REFUSES, so this test never creates a lead — a
  // by-phone delete would risk erasing an unrelated pre-existing row in a
  // shared audit database that happened to match either literal phone.
  await mockPg('referral_promoters').where({ id: f.promoter.id }).del();
  await mockPg('customers').whereIn('id', [f.customerId, f.promoterCustomerId]).del();
}

(hasAuditDb ? describe : describe.skip)('r1-leads-reviews-3: admin referral submit vs existing customer stored in domestic phone format', () => {
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(() => mockSend.mockClear());

  test('CONTROL: stored E.164 phone is refused', async () => {
    const f = await seed({ storedPhone: '+19415551234' });
    try {
      await expect(engine.submitReferral(f.promoter.id, { name: 'Friend X', phone: '941-555-1234', source: 'admin' }))
        .rejects.toThrow('already a Waves customer');
      expect(mockSend).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });

  test('BUG: stored domestic phone "(941) 555-1234" is NOT refused — referral + lead written, invite SMS sent', async () => {
    const f = await seed({ storedPhone: '(941) 555-1234' });
    try {
      let threw = null;
      let result = null;
      try {
        result = await engine.submitReferral(f.promoter.id, { name: 'Friend X', phone: '941-555-1234', source: 'admin' });
      } catch (e) { threw = e; }
      const referrals = await mockPg('referrals').where({ promoter_id: f.promoter.id });
      const leads = await mockPg('leads').where({ phone: '+19415551234' });
      const promoterAfter = await mockPg('referral_promoters').where({ id: f.promoter.id }).first();
      // Observability for the verdict
       
      console.log('OBSERVED', JSON.stringify({ threw: threw?.message || null, status: result?.status, referrals: referrals.length, leads: leads.length, total_referrals_sent: promoterAfter.total_referrals_sent, smsCalls: mockSend.mock.calls.length, smsTo: mockSend.mock.calls[0]?.[0]?.to }));
      // EXPECTED behaviour:
      expect(threw?.message).toMatch(/already a Waves customer/);
      expect(referrals).toHaveLength(0);
      expect(leads).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });

  test('BUG (bare digits): stored "9415551234" is NOT refused either', async () => {
    const f = await seed({ storedPhone: '9415551234' });
    try {
      await expect(engine.submitReferral(f.promoter.id, { name: 'Friend Y', phone: '(941) 555-1234', source: 'admin' }))
        .rejects.toThrow('already a Waves customer');
    } finally { await cleanup(f); }
  });
});
