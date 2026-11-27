/**
 * stripe-email-sync (owner 2026-11-27 "build"): the durable job that copies a customer's current email onto their
 * linked Stripe customer, under the customer row lock, never onto a Stripe id another row shares.
 */
describe('stripe-email-sync processJob', () => {
  let state; let locks; let updateEmail; let raiseAdminAlert;

  function load({ job = {}, customers = [], stripeResult = 'updated' } = {}) {
    jest.resetModules();
    locks = [];
    state = {
      jobs: [{ id: 'job-1', customer_id: 'c1', status: 'pending', attempts: 0, ...job }],
      customers,
    };
    const builder = (table) => {
      const q = { conds: [], nots: [], locked: false };
      q.where = (c) => { q.conds.push(c); return q; };
      q.whereNot = (c) => { q.nots.push(c); return q; };
      q.orderBy = () => q;
      q.forUpdate = () => { q.locked = true; return q; };
      q.skipLocked = () => q;
      const rows = () => (table === 'stripe_email_sync_jobs' ? state.jobs : state.customers)
        .filter((r) => q.conds.every((c) => Object.entries(c).every(([k, v]) => r[k] === v))
          && q.nots.every((c) => Object.entries(c).every(([k, v]) => r[k] !== v)));
      const note = (rs) => { if (q.locked) rs.forEach((r) => locks.push(`${table}:${r.id}`)); return rs; };
      q.first = async () => { const r = note(rows().slice(0, 1))[0]; return r ? { ...r } : undefined; };
      q.select = async () => note(rows()).map((r) => ({ id: r.id }));
      q.update = async (patch) => { rows().forEach((r) => Object.assign(r, patch)); return 1; };
      return q;
    };
    const trx = Object.assign(builder, { fn: { now: () => 'NOW' }, raw: (sql) => ({ sql }) });
    const db = Object.assign(builder, { transaction: async (fn) => fn(trx), fn: trx.fn });
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    updateEmail = jest.fn(async () => {
      locks.push('stripe-call');
      if (stripeResult instanceof Error) throw stripeResult;
      return stripeResult;
    });
    jest.doMock('../services/stripe', () => ({ updateCustomerEmail: updateEmail }));
    raiseAdminAlert = jest.fn(async () => ({ id: 'n1' }));
    jest.doMock('../services/admin-alert-compose', () => ({ raiseAdminAlert }));
    return require('../services/stripe-email-sync');
  }

  const cust = (over = {}) => ({ id: 'c1', email: 'new@example.test', stripe_customer_id: 'cus_1', deleted_at: null, phone: '+19415550100', ...over });

  test('updates Stripe with the email on file, holding the job and customer locks through the call', async () => {
    const sync = load({ customers: [cust()] });
    await expect(sync.processJob('job-1')).resolves.toBe('updated');
    expect(updateEmail).toHaveBeenCalledWith('cus_1', 'new@example.test', { timeout: 10000 });
    expect(locks).toEqual(['stripe_email_sync_jobs:job-1', 'customers:c1', 'stripe-call']);
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'updated' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a Stripe id another customer row shares is never changed: skipped, both rows locked, office alerted', async () => {
    const sync = load({ customers: [cust(), cust({ id: 'c2', email: 'other@example.test' })] });
    await expect(sync.processJob('job-1')).resolves.toBe('shared');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(locks).toContain('customers:c2');
    expect(state.jobs[0]).toMatchObject({ status: 'skipped', result: 'shared' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ area: 'Customers', severity: 'needs-you', subject: { type: 'customer', id: 'c1' } });
    expect(opts.dedupeKey).toBe('stripe_email_sync:job-1');
    expect(typeof opts.trx).toBe('function');
  });

  test('no link, no email, or a merged-away record finish without a Stripe call', async () => {
    for (const [row, result] of [[cust({ stripe_customer_id: null }), 'not_linked'], [cust({ email: '  ' }), 'no_email'], [cust({ deleted_at: 'x', phone: 'merged-1' }), 'gone']]) {
      const sync = load({ customers: [row] });
      await expect(sync.processJob('job-1')).resolves.toBe(result);
      expect(updateEmail).not.toHaveBeenCalled();
      expect(state.jobs[0].status).not.toBe('pending');
    }
  });

  test('a Stripe error retries with a later attempt; the last attempt gives up and alerts the office', async () => {
    let sync = load({ customers: [cust()], stripeResult: Object.assign(new Error('x'), { type: 'StripeConnectionError' }) });
    await expect(sync.processJob('job-1')).resolves.toBe('retry');
    expect(state.jobs[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'StripeConnectionError' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    sync = load({ job: { attempts: 5 }, customers: [cust()], stripeResult: new Error('x') });
    await expect(sync.processJob('job-1')).resolves.toBe('gave_up');
    expect(state.jobs[0]).toMatchObject({ status: 'failed', result: 'gave_up', attempts: 6 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('no Stripe key on this process leaves the job pending without spending an attempt', async () => {
    const sync = load({ customers: [cust()], stripeResult: 'not_configured' });
    await expect(sync.processJob('job-1')).resolves.toBe('not_configured');
    expect(state.jobs[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  test('a job already claimed or finished is left alone', async () => {
    const sync = load({ job: { status: 'done' }, customers: [cust()] });
    await expect(sync.processJob('job-1')).resolves.toBe('busy');
    expect(updateEmail).not.toHaveBeenCalled();
  });
});

describe('stripe-email-sync enqueue', () => {
  test('one pending row per customer: a repeat re-arms it on the caller handle', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
    const { enqueue } = require('../services/stripe-email-sync');
    const trx = { raw: jest.fn(async () => {}) };
    await enqueue(trx, 'c1', 'app_email_change');
    const [sql, args] = trx.raw.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(customer_id\) WHERE status = 'pending'/);
    expect(args).toEqual(['c1', 'app_email_change']);
  });
});
