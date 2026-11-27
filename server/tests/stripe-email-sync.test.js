/**
 * stripe-email-sync (owner 2026-11-27 "build"): the durable job that copies a customer's current email onto their
 * linked Stripe customer, under the customer row lock, never onto a Stripe id another row shares.
 */
describe('stripe-email-sync processJob', () => {
  let state; let locks; let updateEmail; let raiseAdminAlert;

  function load({ job = {}, customers = [], stripeResult = 'updated', lockedCustomers = [] } = {}) {
    jest.resetModules();
    locks = [];
    state = {
      jobs: [{ id: 'job-1', customer_id: 'c1', status: 'pending', attempts: 0, due: true, ...job }],
      customers,
      cards: [],
    };
    const builder = (table) => {
      const q = { conds: [], nots: [], locked: false, skip: false, dueOnly: false };
      q.where = (c) => { if (typeof c === 'string') q.dueOnly = true; else q.conds.push(c); return q; };
      q.whereNot = (c) => { q.nots.push(c); return q; };
      q.orderBy = () => q;
      q.forUpdate = () => { q.locked = true; return q; };
      q.skipLocked = () => { q.skip = true; return q; };
      const rows = () => ({ stripe_email_sync_jobs: state.jobs, customers: state.customers, payment_methods: state.cards }[table])
        .filter((r) => q.conds.every((c) => Object.entries(c).every(([k, v]) => r[k] === v))
          && q.nots.every((c) => Object.entries(c).every(([k, v]) => r[k] !== v))
          && (!q.dueOnly || r.due)
          && !(q.skip && table === 'customers' && lockedCustomers.includes(r.id)));
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
    expect(updateEmail).toHaveBeenCalledWith('cus_1', 'new@example.test', { timeout: 10000, maxNetworkRetries: 0 });
    // Customer first, then the job: the same order as an email confirm (no deadlock).
    expect(locks).toEqual(['customers:c1', 'stripe_email_sync_jobs:job-1', 'stripe-call']);
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'updated' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a Stripe id another customer row shares is never changed: skipped (the other row is not locked), office alerted', async () => {
    const sync = load({ customers: [cust(), cust({ id: 'c2', email: 'other@example.test' })] });
    await expect(sync.processJob('job-1')).resolves.toBe('shared');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(locks).not.toContain('customers:c2');
    expect(state.jobs[0]).toMatchObject({ status: 'skipped', result: 'shared' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ area: 'Customers', severity: 'needs-you', subject: { type: 'customer', id: 'c1' } });
    expect(opts.dedupeKey).toBe('stripe_email_sync:job-1');
    expect(typeof opts.trx).toBe('function');
  });

  test("another customer's saved card on the same Stripe id counts as shared ownership", async () => {
    const sync = load({ customers: [cust()] });
    state.cards.push({ id: 'pm-9', customer_id: 'c2', stripe_customer_id: 'cus_1' });
    await expect(sync.processJob('job-1')).resolves.toBe('shared');
    expect(updateEmail).not.toHaveBeenCalled();
    // Our own card on it is fine.
    const own = load({ customers: [cust()] });
    state.cards.push({ id: 'pm-1', customer_id: 'c1', stripe_customer_id: 'cus_1' });
    await expect(own.processJob('job-1')).resolves.toBe('updated');
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

  test('no Stripe key on this process leaves the job untouched (no attempt, same schedule), and drainDue claims nothing', async () => {
    const sync = load({ customers: [cust()], stripeResult: 'not_configured' });
    await expect(sync.processJob('job-1')).resolves.toBe('not_configured');
    expect(state.jobs[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(state.jobs[0].next_attempt_at).toBeUndefined();
    jest.doMock('../config/stripe-config', () => ({ secretKey: undefined }));
    await expect(sync.drainDue()).resolves.toEqual({});
  });

  test('a merge undo onto a record with no email alerts the office (Stripe may hold the other email)', async () => {
    const sync = load({ job: { source: 'merge_undo' }, customers: [cust({ email: null })] });
    await expect(sync.processJob('job-1')).resolves.toBe('no_email');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][2].detail).toMatch(/clear or fix it by hand/);
    const app = load({ job: { source: 'app_email_change' }, customers: [cust({ email: null })] });
    await app.processJob('job-1');
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a job an overlapping drain just rescheduled is not due, so it is left alone', async () => {
    const sync = load({ job: { due: false, attempts: 1 }, customers: [cust()], stripeResult: new Error('x') });
    await expect(sync.processJob('job-1')).resolves.toBe('busy');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(state.jobs[0].attempts).toBe(1);
  });

  test('a customer row another transaction holds (a confirm in flight) leaves the job for the next tick', async () => {
    const sync = load({ customers: [cust()], lockedCustomers: ['c1'] });
    await expect(sync.processJob('job-1')).resolves.toBe('busy');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(state.jobs[0].status).toBe('pending');
  });

  test('shared and gave-up alerts give different instructions: never edit a shared profile by hand first', async () => {
    let sync = load({ customers: [cust(), cust({ id: 'c2' })] });
    await sync.processJob('job-1');
    expect(raiseAdminAlert.mock.calls[0][2].detail).toMatch(/Do not change the Stripe email yet/);
    sync = load({ job: { attempts: 5 }, customers: [cust()], stripeResult: new Error('x') });
    await sync.processJob('job-1');
    expect(raiseAdminAlert.mock.calls[0][2].detail).toMatch(/fix Stripe by hand only if they differ/);
  });

  test('a job already claimed or finished is left alone', async () => {
    const sync = load({ job: { status: 'done' }, customers: [cust()] });
    await expect(sync.processJob('job-1')).resolves.toBe('busy');
    expect(updateEmail).not.toHaveBeenCalled();
  });
});

describe('stripe-email-sync enqueue', () => {
  test('skips the insert when a pending job already exists, on the caller handle', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
    const { enqueue } = require('../services/stripe-email-sync');
    const trx = { raw: jest.fn(async () => {}) };
    await enqueue(trx, 'c1', 'app_email_change');
    const [sql, args] = trx.raw.mock.calls[0];
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM stripe_email_sync_jobs WHERE customer_id = \? AND status = 'pending'\)/);
    expect(args).toEqual(['c1', 'app_email_change', 'c1']);
  });
});
