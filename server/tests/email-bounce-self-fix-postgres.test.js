/**
 * Bounced call email fixes itself (owner 2026-11-17, GATE_CALL_BOUNCE_SELF_FIX): the SQL halves of the self-fix, on real
 * PostgreSQL (the migrated database).
 *  - relookAfterNewCalls picks a no-fix ledger row only after a later PROCESSED call from the customer's phone that talks
 *    about email, only while the customer's primary email is still the bounced address, and marks the row looked so the
 *    same call is never read twice.
 *  - the once-per-customer check reads the ledger's jsonb evidence: after one self-fix, a bounce of the fixed address is a
 *    suggestion for a person, not a second self-fix.
 *  - a re-look runs the normal rescue on the same ledger row, so a later call can save a self-fix there.
 *  - a self-fix never moves to a known-bad address: one with a ledger bounce row (even with no block left), or one with
 *    a do-not-email row in any status (a released block, or a bounce from before the ledger existed).
 * A hard bounce suppresses the address before the rescue runs (the webhook's order), so the suite seeds that row too.
 * All names, phones and addresses synthetic.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const { randomUUID } = require('node:crypto');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(async () => ({ ok: false })) }));
jest.mock('../services/email', () => ({ send: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/customer-email-fanout', () => ({ propagateCustomerEmailChange: jest.fn(async () => ({})) }));
jest.mock('dns', () => ({ promises: { resolveMx: jest.fn(async () => [{ exchange: 'mx.example', priority: 1 }]) } }));

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('bounce self-fix SQL (Postgres)', () => {
  jest.setTimeout(30000);
  let db;
  let rescue;
  let NotificationService;
  let deliverOpsDigest;
  const priorGate = process.env.GATE_CALL_BOUNCE_SELF_FIX;
  const created = { customers: [], suppressions: [] };
  const tag = randomUUID().slice(0, 8);
  const addr = (local) => `${local}${tag}@yahoo.com`;

  beforeAll(() => {
    db = require('../models/db');
    rescue = require('../services/email-bounce-rescue');
    NotificationService = require('../services/notification-service');
    ({ deliverOpsDigest } = require('../services/ops-digest'));
  });

  beforeEach(() => {
    process.env.GATE_CALL_BOUNCE_SELF_FIX = 'true';
  });

  async function cleanup() {
    for (const id of created.customers) {
      await db('email_bounce_rescues').where({ customer_id: id }).del();
      await db('customer_interactions').where({ customer_id: id }).del();
      await db('call_log').where({ customer_id: id }).del();
      await db('customers').where({ id }).del();
    }
    if (created.suppressions.length) await db('email_suppressions').whereIn('email', created.suppressions).del();
    created.customers = [];
    created.suppressions = [];
  }

  afterEach(async () => {
    jest.clearAllMocks();
    await cleanup();
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_CALL_BOUNCE_SELF_FIX;
    else process.env.GATE_CALL_BOUNCE_SELF_FIX = priorGate;
    await cleanup();
    await db.destroy();
  });

  async function seedCustomer(email) {
    const id = randomUUID();
    const phone = `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await db('customers').insert({ id, first_name: 'Rae', last_name: 'Wilde', email, phone, active: true, pipeline_stage: 'new_lead' });
    created.customers.push(id);
    return { id, phone };
  }

  async function seedCall({ customerId, phone, transcription, processedHoursAgo = 1, extraction = {} }) {
    const at = new Date(Date.now() - processedHoursAgo * 3600 * 1000);
    await db('call_log').insert({
      customer_id: customerId, from_phone: phone, transcription, ai_extraction: JSON.stringify(extraction),
      created_at: at, processed_at: at,
    });
  }

  async function seedNoFixRow({ customerId, bouncedEmail, lookedHoursAgo = 48 }) {
    const at = new Date(Date.now() - lookedHoursAgo * 3600 * 1000);
    const [row] = await db('email_bounce_rescues').insert({
      bounced_email: bouncedEmail, customer_id: customerId, status: 'no_candidate', evidence: JSON.stringify({}),
      created_at: at, updated_at: at,
    }).returning('*');
    return row;
  }

  async function seedSuppression(email, status = 'active') {
    await db('email_suppressions').insert({ email, suppression_type: 'bounce', status, source: 'test' });
    created.suppressions.push(email);
  }

  const noChange = () => jest.fn(async () => ({ skipped: 'already_examined', status: 'no_candidate' }));

  it('re-looks once after a later call that talks about email, then marks the row looked', async () => {
    const bounced = addr('raew');
    const { id, phone } = await seedCustomer(bounced);
    const row = await seedNoFixRow({ customerId: id, bouncedEmail: bounced });
    await seedCall({ customerId: id, phone, transcription: 'Caller: about my email, there is no dot in it.' });

    const rescueFn = noChange();
    const first = await rescue.relookAfterNewCalls({ rescueFn });
    expect(rescueFn).toHaveBeenCalledWith(bounced, { appliedBy: 'relook' });
    expect(first).toMatchObject({ examined: 1, unchanged: 1 });
    const after = await db('email_bounce_rescues').where({ id: row.id }).first();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(row.updated_at).getTime());

    const again = noChange();
    await rescue.relookAfterNewCalls({ rescueFn: again });
    expect(again).not.toHaveBeenCalled();
  });

  it('skips a later call that never talks about email, a call before the last look, and a changed primary email', async () => {
    const quiet = addr('quiet');
    const a = await seedCustomer(quiet);
    await seedNoFixRow({ customerId: a.id, bouncedEmail: quiet });
    await seedCall({ customerId: a.id, phone: a.phone, transcription: 'Caller: can you come Tuesday instead?' });

    const old = addr('older');
    const b = await seedCustomer(old);
    await seedNoFixRow({ customerId: b.id, bouncedEmail: old, lookedHoursAgo: 2 });
    await seedCall({ customerId: b.id, phone: b.phone, transcription: 'Caller: my email is wrong.', processedHoursAgo: 5 });

    const moved = addr('moved');
    const c = await seedCustomer(addr('newer'));
    await seedNoFixRow({ customerId: c.id, bouncedEmail: moved });
    await seedCall({ customerId: c.id, phone: c.phone, transcription: 'Caller: my email changed.' });

    const rescueFn = noChange();
    await rescue.relookAfterNewCalls({ rescueFn });
    expect(rescueFn.mock.calls.map(([e]) => e)).not.toEqual(expect.arrayContaining([quiet]));
    expect(rescueFn.mock.calls.map(([e]) => e)).not.toEqual(expect.arrayContaining([old]));
    expect(rescueFn.mock.calls.map(([e]) => e)).not.toEqual(expect.arrayContaining([moved]));
  });

  it('saves one self-fix, and a bounce of the fixed address goes to a person', async () => {
    const bounced = addr('lymzafi');
    const fixed = addr('lynzafi');
    const { id, phone } = await seedCustomer(bounced);
    await seedCall({ customerId: id, phone, transcription: `Caller: correction, it is ${fixed}`, extraction: { email: fixed } });
    await seedSuppression(bounced);

    const first = await rescue.rescueBouncedAddress(bounced);
    expect(first).toMatchObject({ status: 'applied', candidate: fixed, selfFix: true });
    expect((await db('customers').where({ id }).first('email')).email).toBe(fixed);
    const ledger = await db('email_bounce_rescues').whereRaw('LOWER(bounced_email) = ?', [bounced]).first();
    expect(ledger).toMatchObject({ status: 'applied', applied_by: 'webhook' });
    expect(ledger.evidence).toMatchObject({ self_fix: true });
    const note = await db('customer_interactions').where({ customer_id: id }).first('body');
    expect(note.body).toContain(bounced);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);

    // The fixed address bounces too; a later call names a small fix of it. Once per customer: a person decides.
    await seedCall({ customerId: id, phone, transcription: `Caller: no, it is ${addr('lynzafy')}`, extraction: { email: addr('lynzafy') } });
    await seedSuppression(fixed);
    const second = await rescue.rescueBouncedAddress(fixed);
    expect(second).toMatchObject({ status: 'suggested', candidate: addr('lynzafy') });
    expect(second.selfFix).toBeUndefined();
    expect((await db('customers').where({ id }).first('email')).email).toBe(fixed);
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
  });

  it('a later call that talks about email saves a self-fix on the same ledger row, through the normal rescue', async () => {
    const bounced = addr('kwintar');
    const fixed = addr('kwintor');
    const { id, phone } = await seedCustomer(bounced);
    const row = await seedNoFixRow({ customerId: id, bouncedEmail: bounced });
    await seedSuppression(bounced);
    await seedCall({ customerId: id, phone, transcription: `Caller: my email is wrong, it is ${fixed}`, extraction: { email: fixed } });

    const summary = await rescue.relookAfterNewCalls({
      rescueFn: (email, opts) => (email === bounced ? rescue.rescueBouncedAddress(email, opts) : Promise.resolve({})),
    });
    expect(summary).toMatchObject({ fixed: 1 });
    expect((await db('customers').where({ id }).first('email')).email).toBe(fixed);
    const after = await db('email_bounce_rescues').where({ id: row.id }).first();
    expect(after).toMatchObject({ status: 'applied', applied_by: 'relook', candidate_email: fixed });
    expect(after.evidence).toMatchObject({ self_fix: true });
    expect(await db('email_bounce_rescues').where({ customer_id: id }).count('* as n').first()).toMatchObject({ n: '1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  it('never moves to an address with a ledger bounce row, even when no block is left for it', async () => {
    const older = addr('oldbox');
    const current = addr('oldbax');
    const { id, phone } = await seedCustomer(current);
    await db('email_bounce_rescues').insert({ bounced_email: older, customer_id: id, status: 'no_candidate', evidence: JSON.stringify({}) });
    await seedSuppression(current);
    await seedCall({ customerId: id, phone, transcription: `Caller: it is ${older}`, extraction: { email: older } });

    const r = await rescue.rescueBouncedAddress(current);
    expect(r).toMatchObject({ status: 'suggested', candidate: older });
    expect(r.selfFix).toBeUndefined();
    expect((await db('customers').where({ id }).first('email')).email).toBe(current);
  });

  it('never moves to an address whose do-not-email block was released (a bounce from before the ledger)', async () => {
    const older = addr('pastbox');
    const current = addr('pastbax');
    const { id, phone } = await seedCustomer(current);
    await seedSuppression(older, 'released');
    await seedSuppression(current);
    await seedCall({ customerId: id, phone, transcription: `Caller: it is ${older}`, extraction: { email: older } });

    const r = await rescue.rescueBouncedAddress(current);
    expect(r).toMatchObject({ status: 'suggested', candidate: older });
    expect(r.selfFix).toBeUndefined();
    expect((await db('customers').where({ id }).first('email')).email).toBe(current);
  });
});
