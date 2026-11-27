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
      jobs: [{ id: 'job-1', customer_id: 'c1', email: 'new@example.test', status: 'pending', attempts: 0, due: true, updated_at: 'v1', ...job }],
      customers,
      cards: [],
      journal: [],
      payers: [],
    };
    const builder = (table) => {
      const q = { conds: [], nots: [], locked: false, skip: false, dueOnly: false };
      q.where = (c) => {
        if (typeof c === 'string') q.dueOnly = true;
        else if (typeof c === 'function') { const ors = []; const sub = { where: (o) => { ors.push(o); return sub; }, orWhere: (o) => { ors.push(o); return sub; } }; c(sub); q.ors = ors; }
        else q.conds.push(c);
        return q;
      };
      q.whereNot = (c) => { q.nots.push(c); return q; };
      q.orderBy = () => q;
      q.limit = () => q;
      q.pluck = async (col) => rows().map((r) => r[col]);
      q.forUpdate = () => { q.locked = true; return q; };
      q.skipLocked = () => { q.skip = true; return q; };
      const rows = () => ({ stripe_email_sync_jobs: state.jobs, customers: state.customers, payment_methods: state.cards, customer_merge_journal: state.journal, payers: state.payers }[table])
        .filter((r) => !q.ors || q.ors.some((o) => Object.entries(o).every(([k, v]) => r[k] === v)))
        .filter((r) => q.conds.every((c) => Object.entries(c).every(([k, v]) => r[k] === v))
          && q.nots.every((c) => Object.entries(c).every(([k, v]) => r[k] !== v))
          && (!q.dueOnly || r.due)
          && !(q.skip && table === 'customers' && lockedCustomers.includes(r.id)));
      const note = (rs) => { if (q.locked) rs.forEach((r) => locks.push(`${table}:${r.id}`)); return rs; };
      q.first = async () => { if (state.throwOn === table) throw new Error('boom'); const r = note(rows().slice(0, 1))[0]; return r ? { ...r } : undefined; };
      q.select = async (...cols) => note(rows()).map((r) => (cols.length > 1 ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { id: r.id }));
      q.update = async (patch) => { rows().forEach((r) => Object.assign(r, patch)); return 1; };
      return q;
    };
    const trx = Object.assign((t) => builder(t), { fn: { now: () => 'NOW' }, raw: (sql) => ({ sql }) });
    const db = Object.assign((t) => builder(t), { transaction: async (fn) => fn(trx), fn: trx.fn, raw: trx.raw });
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

  test('a third-party payer on the same Stripe profile counts as shared: never written, office alerted', async () => {
    const sync = load({ customers: [cust()] });
    state.payers.push({ id: 'p1', stripe_customer_id: 'cus_1' });
    await expect(sync.processJob('job-1')).resolves.toBe('shared');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a job that throws outside the Stripe call is pushed back, so it cannot hold a place in every batch', async () => {
    const sync = load({ customers: [cust()] });
    state.throwOn = 'customer_merge_journal';
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    await expect(sync.drainDue()).resolves.toEqual({ error: 1 });
    expect(updateEmail).not.toHaveBeenCalled();
    expect(state.jobs[0]).toMatchObject({ status: 'pending', last_error: 'Error' });
    expect(state.jobs[0].next_attempt_at).toEqual({ sql: "now() + interval '15 minutes'" });
  });

  test('no Stripe profile yet: five re-checks over about an hour (counted apart from Stripe errors), then finished', async () => {
    let sync = load({ customers: [cust({ stripe_customer_id: null })] });
    await expect(sync.processJob('job-1')).resolves.toBe('recheck');
    expect(state.jobs[0]).toMatchObject({ status: 'pending', attempts: 0, not_linked_checks: 1 });
    sync = load({ job: { not_linked_checks: 5 }, customers: [cust({ stripe_customer_id: null })] });
    await expect(sync.processJob('job-1')).resolves.toBe('not_linked');
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'not_linked' });
    expect(updateEmail).not.toHaveBeenCalled();
    // Linked by the re-check: the email on file now goes to Stripe.
    sync = load({ job: { not_linked_checks: 4 }, customers: [cust()] });
    await expect(sync.processJob('job-1')).resolves.toBe('updated');
  });

  test('a record that was ever part of a merge (either side) is skipped with an office alert, never written', async () => {
    for (const side of ['winner_customer_id', 'loser_customer_id']) {
      const sync = load({ customers: [cust()] });
      state.journal.push({ id: 'j1', winner_customer_id: 'zz', loser_customer_id: 'zz', [side]: 'c1' });
      await expect(sync.processJob('job-1')).resolves.toBe('merged');
      expect(updateEmail).not.toHaveBeenCalled();
      expect(state.jobs[0]).toMatchObject({ status: 'skipped', result: 'merged' });
      expect(raiseAdminAlert.mock.calls[0][2].detail).toMatch(/Check which customer record owns this Stripe profile/);
    }
    // A merge between two OTHER records does not block this one.
    const other = load({ customers: [cust()] });
    state.journal.push({ id: 'j2', winner_customer_id: 'c7', loser_customer_id: 'c8' });
    await expect(other.processJob('job-1')).resolves.toBe('updated');
  });

  test('only the confirmed address goes to Stripe: a record that holds another address now is left alone', async () => {
    const sync = load({ customers: [cust({ email: 'office.edit@example.test' })] });
    await expect(sync.processJob('job-1')).resolves.toBe('superseded');
    expect(updateEmail).not.toHaveBeenCalled();
    const sameCase = load({ customers: [cust({ email: 'New@Example.test' })] });
    await expect(sameCase.processJob('job-1')).resolves.toBe('updated');
    expect(updateEmail).toHaveBeenCalledWith('cus_1', 'new@example.test', expect.any(Object));
  });

  test('a job a confirm re-armed since the failed try keeps its schedule (push-back matches the seen version only)', async () => {
    const sync = load({ customers: [cust()] });
    state.throwOn = 'customer_merge_journal';
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    // The drain reads version v1; a confirm re-arms the row (v2) before the failed try's push-back runs.
    const run = sync.drainDue();
    state.jobs[0].updated_at = 'v2';
    await expect(run).resolves.toEqual({ error: 1 });
    expect(state.jobs[0].next_attempt_at).toBeUndefined();
  });

  test('a merged-away record finishes without a Stripe call', async () => {
    for (const [row, result] of [[cust({ deleted_at: 'x', phone: 'merged-1' }), 'gone']]) {
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
  function handle(pending) {
    const calls = [];
    const trx = (table) => ({
      where: (c) => ({ update: async (patch) => { calls.push(['update', table, c, patch]); return pending ? 1 : 0; } }),
      insert: async (row) => { calls.push(['insert', table, row]); },
    });
    trx.fn = { now: () => 'NOW' };
    return { trx, calls };
  }
  const load = () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
    return require('../services/stripe-email-sync');
  };

  test('a pending job is re-armed with a fresh retry budget and the new source, not duplicated', async () => {
    const { enqueue } = load();
    const { trx, calls } = handle(true);
    await enqueue(trx, 'c1', ' new@example.test ', 'app_email_change');
    expect(calls).toEqual([['update', 'stripe_email_sync_jobs', { customer_id: 'c1', status: 'pending' },
      expect.objectContaining({ email: 'new@example.test', attempts: 0, not_linked_checks: 0, last_error: null, source: 'app_email_change', next_attempt_at: 'NOW' })]]);
  });

  test('no pending job: inserts one on the caller handle', async () => {
    const { enqueue } = load();
    const { trx, calls } = handle(false);
    await enqueue(trx, 'c1', 'new@example.test', 'app_email_change');
    expect(calls[1]).toEqual(['insert', 'stripe_email_sync_jobs', { customer_id: 'c1', email: 'new@example.test', source: 'app_email_change' }]);
  });
});
