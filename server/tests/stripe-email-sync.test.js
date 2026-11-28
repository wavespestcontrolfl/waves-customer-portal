/**
 * stripe-email-sync (owner 2026-11-27 "build"): the durable job that copies a customer's current email onto their
 * linked Stripe customer, under the customer row lock, never onto a Stripe id another row shares.
 */
describe('stripe-email-sync processJob', () => {
  let state; let locks; let updateEmail; let raiseAdminAlert; let readOwner;

  function load({ job = {}, customers = [], stripeResult = 'updated', lockedCustomers = [], owner } = {}) {
    jest.resetModules();
    locks = [];
    state = {
      jobs: [{ id: 'job-1', customer_id: 'c1', email: 'new@example.test', status: 'pending', attempts: 0, not_linked_checks: 0, due: true, updated_at: 'v1', ...job }],
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
      q.limit = (n) => { q._lim = n; return q; };
      q.whereNotIn = (col, vals) => { q.notIn = [col, vals]; return q; };
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
      q.first = async () => { if (state.throwOn === table) { if (state.onThrow) state.onThrow(); throw new Error('boom'); } const r = note(rows().slice(0, 1))[0]; return r ? { ...r } : undefined; };
      // drainDue selects id + updated_at::text AS version; the fake's updated_at is already a text version.
      q.whereNotNull = (col) => { q.notNull = col; return q; };
      q.select = async (...cols) => note(rows()).filter((r) => !q.notNull || r[q.notNull] != null)
        .filter((r) => !q.notIn || !q.notIn[1].includes(r[q.notIn[0]])).slice(0, q._lim || undefined)
        .map((r) => (cols.length > 1 ? { id: r.id, version: r.updated_at } : cols[0] === 'stripe_customer_id' ? { stripe_customer_id: r.stripe_customer_id } : { id: r.id }));
      q.whereRaw = (sql, [v]) => { q.conds.push({ updated_at: v }); return q; };
      q.update = (patch) => {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch, patch.attempts && patch.attempts.sql === 'attempts + 1' ? { attempts: (r._attempts = (r._attempts ?? r.attempts ?? 0) + 1) } : {}));
        const p = Promise.resolve(hit.length);
        p.returning = async () => hit.map((r) => ({ id: r.id, customer_id: r.customer_id, attempts: r.attempts }));
        return p;
      };
      return q;
    };
    const trx = Object.assign((t) => builder(t), {
      fn: { now: () => 'NOW' },
      raw: (sql) => {
        if (String(sql).includes('pg_try_advisory_xact_lock')) {
          locks.push('advisory-lock');
          return Promise.resolve({ rows: [{ locked: true }] });
        }
        return { sql };
      },
    });
    trx.transaction = async (fn) => fn(trx);
    let customerRowLocked = false;
    const db = Object.assign((t) => builder(t), {
      transaction: async (fn) => {
        const hadLock = customerRowLocked;
        locks.push('tx-start');
        try {
          return await fn(trx);
        } finally {
          if (!hadLock) customerRowLocked = false;
          locks.push('tx-end');
        }
      },
      fn: trx.fn,
      raw: trx.raw,
    });
    const origForUpdate = builder;
    void origForUpdate;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    updateEmail = jest.fn(async () => {
      // Customer row lock was released before Stripe HTTP; only the outer
      // stripe.email.sync advisory lock stays held.
      locks.push('stripe-call-after-customer-unlock');
      if (stripeResult instanceof Error) throw stripeResult;
      return stripeResult;
    });
    // By default each Stripe profile names the customer row that links it.
    readOwner = jest.fn(async (sid) => (
      owner === undefined
        ? { deleted: false, customerId: (state.customers.find((c) => c.stripe_customer_id === sid) || {}).id || null, payerId: null }
        : owner
    ));
    jest.doMock('../services/stripe', () => ({ updateCustomerEmail: updateEmail, readCustomerOwner: readOwner }));
    raiseAdminAlert = jest.fn(async () => ({ id: 'n1' }));
    jest.doMock('../services/admin-alert-compose', () => ({ raiseAdminAlert }));
    return require('../services/stripe-email-sync');
  }

  const cust = (over = {}) => ({ id: 'c1', email: 'new@example.test', stripe_customer_id: 'cus_1', deleted_at: null, phone: '+19415550100', ...over });

  test('updates Stripe under the stripe.email.sync advisory lock while releasing the customer row lock before Stripe HTTP', async () => {
    const sync = load({ customers: [cust()] });
    await expect(sync.processJob('job-1')).resolves.toBe('updated');
    expect(updateEmail).toHaveBeenCalledWith('cus_1', 'new@example.test', { timeout: 10000, maxNetworkRetries: 0, idempotencyKey: 'stripe-email-sync:job-1:cus_1:0' });
    // Outer tx holds ONLY the stripe.email.sync advisory lock across Stripe HTTP.
    // Inner Tx 1 locks customer -> job and commits before Stripe HTTP; Inner Tx 2
    // commits the job without re-locking customers FOR UPDATE (no ABBA deadlock).
    expect(locks).toEqual([
      'tx-start', 'advisory-lock',
      'tx-start', 'customers:c1', 'stripe_email_sync_jobs:job-1', 'tx-end',
      'stripe-call-after-customer-unlock',
      'tx-start', 'stripe_email_sync_jobs:job-1', 'tx-end',
      'tx-end',
    ]);
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'updated' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a newer email edit during Stripe HTTP supersedes the job cleanly without retrying or alerting', async () => {
    const sync = load({ customers: [cust()], stripeResult: new Error('network timeout') });
    updateEmail.mockImplementationOnce(async () => {
      state.customers[0].email = 'newer@example.test';
      throw new Error('network timeout');
    });
    await expect(sync.processJob('job-1')).resolves.toBe('superseded');
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'superseded' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('pushBack checks superseded/gone before raising a worker_error gave-up alert', async () => {
    const sync = load({ job: { attempts: 8 }, customers: [cust()] });
    state.throwOn = 'customer_merge_journal';
    // Customer email changes after the worker throws, before pushBack runs its transaction.
    state.onThrow = () => { state.customers[0].email = 'newer@example.test'; };
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    await expect(sync.drainDue()).resolves.toEqual({ error: 1 });
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'superseded' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();

    // Same for a customer row merged away right before pushBack runs.
    const gone = load({ job: { attempts: 8 }, customers: [cust()] });
    state.throwOn = 'customer_merge_journal';
    state.onThrow = () => { state.customers[0].deleted_at = '2026-11-27T00:00:00Z'; state.customers[0].phone = 'merged-1'; };
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    await expect(gone.drainDue()).resolves.toEqual({ error: 1 });
    expect(state.jobs[0]).toMatchObject({ status: 'skipped', result: 'gone' });
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

  test("the record's own saved card on another Stripe profile (or cards with no link) goes to the office", async () => {
    let sync = load({ customers: [cust()] });
    state.cards.push({ id: 'pm-1', customer_id: 'c1', stripe_customer_id: 'cus_other' });
    await expect(sync.processJob('job-1')).resolves.toBe('card_conflict');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    sync = load({ customers: [cust({ stripe_customer_id: null })] });
    state.cards.push({ id: 'pm-1', customer_id: 'c1', stripe_customer_id: 'cus_card' });
    await expect(sync.processJob('job-1')).resolves.toBe('card_conflict');
    // Own cards on the linked profile are fine.
    sync = load({ customers: [cust()] });
    state.cards.push({ id: 'pm-1', customer_id: 'c1', stripe_customer_id: 'cus_1' });
    await expect(sync.processJob('job-1')).resolves.toBe('updated');
  });

  test('an address changed since the confirm finishes quietly, before any card or link check could alert', async () => {
    const sync = load({ customers: [cust({ email: 'office.edit@example.test' })] });
    state.cards.push({ id: 'pm-1', customer_id: 'c1', stripe_customer_id: 'cus_other' });
    await expect(sync.processJob('job-1')).resolves.toBe('superseded');
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('Stripe already holding the confirmed email (a lost response that applied) finishes with no second write', async () => {
    const sync = load({ job: { attempts: 2 }, customers: [cust()], owner: { deleted: false, customerId: 'c1', payerId: null, email: 'NEW@example.test' } });
    await expect(sync.processJob('job-1')).resolves.toBe('updated');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(state.jobs[0]).toMatchObject({ status: 'done', result: 'updated' });
    // Not there yet: the write uses this attempt's own key.
    const retry = load({ job: { attempts: 2 }, customers: [cust()] });
    await retry.processJob('job-1');
    expect(updateEmail.mock.calls[0][2].idempotencyKey).toBe('stripe-email-sync:job-1:cus_1:2');
  });

  test('a drain still running makes the next tick in this process skip (no stacked drains)', async () => {
    const sync = load({ customers: [cust()] });
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    let release;
    updateEmail.mockImplementationOnce(() => new Promise((r) => { release = () => r('updated'); }));
    const first = sync.drainDue();
    await new Promise((r) => setImmediate(r));
    await expect(sync.drainDue()).resolves.toEqual({ skipped_overlap: 1 });
    release();
    await expect(first).resolves.toEqual({ updated: 1 });
  });

  test('busy jobs (customer row held) do not count: the drain pages past them to reach due work', async () => {
    const sync = load({ customers: [cust(), cust({ id: 'c2', stripe_customer_id: 'cus_2' })], lockedCustomers: ['c1'] });
    state.jobs.push({ id: 'job-2', customer_id: 'c2', email: 'new@example.test', status: 'pending', attempts: 0, due: true, updated_at: 'v1' });
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    await expect(sync.drainDue({ limit: 1 })).resolves.toEqual({ busy: 1, updated: 1 });
    expect(updateEmail).toHaveBeenCalledWith('cus_2', 'new@example.test', expect.any(Object));
  });

  test("the Stripe profile's own record must name this customer, or the office decides (payer, other, blank, deleted)", async () => {
    for (const owner of [{ customerId: 'c9' }, { customerId: null }, { customerId: 'c1', payerId: 'p1' }, { customerId: 'c1', deleted: true }]) {
      const sync = load({ customers: [cust()], owner: { deleted: false, payerId: null, ...owner } });
      await expect(sync.processJob('job-1')).resolves.toBe('stripe_owner');
      expect(updateEmail).not.toHaveBeenCalled();
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    }
    const ok = load({ customers: [cust()] });
    await expect(ok.processJob('job-1')).resolves.toBe('updated');
    expect(readOwner).toHaveBeenCalledWith('cus_1', { timeout: 10000, maxNetworkRetries: 0 });
    // A stable idempotency key per job and profile: a retry after a lost response replays the same write.
    expect(updateEmail.mock.calls[0][2]).toMatchObject({ idempotencyKey: 'stripe-email-sync:job-1:cus_1:0' });
  });

  test('six failed ownership reads give up with an alert that says to confirm the owner first, and never write', async () => {
    const sync = load({ job: { attempts: 5 }, customers: [cust()] });
    readOwner.mockRejectedValue(Object.assign(new Error('x'), { type: 'StripeConnectionError' }));
    await expect(sync.processJob('job-1')).resolves.toBe('gave_up');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(raiseAdminAlert.mock.calls[0][2].detail).toMatch(/^Email on the customer record: .*\nFirst confirm in Stripe that the profile belongs to this customer/s);
  });

  test('the alert-only retry re-checks ownership first: a profile that became shared gets the shared alert instead', async () => {
    const sync = load({ job: { attempts: 6 }, customers: [cust(), cust({ id: 'c2' })] });
    await expect(sync.processJob('job-1')).resolves.toBe('shared');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(readOwner).not.toHaveBeenCalled();
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
    expect(state.jobs[0]).toMatchObject({ status: 'pending', last_error: 'Error', attempts: 1 });
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

  test('a merged record with no Stripe profile gets no alert: nothing in Stripe to fix, the job ends as not_linked', async () => {
    const sync = load({ job: { not_linked_checks: 5 }, customers: [cust({ stripe_customer_id: null })] });
    state.journal.push({ id: 'j1', winner_customer_id: 'c1', loser_customer_id: 'zz' });
    await expect(sync.processJob('job-1')).resolves.toBe('not_linked');
    expect(raiseAdminAlert).not.toHaveBeenCalled();
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

  test('a job that keeps failing outside the Stripe call stops as failed with an office alert, never writing', async () => {
    const sync = load({ job: { attempts: 8 }, customers: [cust()] });
    state.throwOn = 'customer_merge_journal';
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_x' }));
    await expect(sync.drainDue()).resolves.toEqual({ error: 1 });
    expect(state.jobs[0]).toMatchObject({ status: 'failed', result: 'worker_error', attempts: 9 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(updateEmail).not.toHaveBeenCalled();
  });

  test('a job changed since the failed try keeps its schedule (push-back matches the seen version only)', async () => {
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

  test('a give-up alert that cannot be written keeps the job pending; the next try retries only the alert, never Stripe', async () => {
    let sync = load({ job: { attempts: 5 }, customers: [cust()], stripeResult: new Error('x') });
    raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
    await expect(sync.processJob('job-1')).resolves.toBe('alert_retry');
    expect(state.jobs[0]).toMatchObject({ status: 'pending', attempts: 6 });
    expect(updateEmail).toHaveBeenCalledTimes(1);
    const after = state.jobs[0];
    sync = load({ job: { ...after, due: true }, customers: [cust()] });
    await expect(sync.processJob('job-1')).resolves.toBe('gave_up');
    expect(updateEmail).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(state.jobs[0]).toMatchObject({ status: 'failed', result: 'gave_up' });
  });

  test('no Stripe key on this process leaves the job untouched (no attempt, same schedule), and drainDue claims nothing', async () => {
    const sync = load({ customers: [cust()], owner: null });
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
    expect(raiseAdminAlert.mock.calls[0][2].detail).toMatch(/First confirm in Stripe that the profile belongs to this customer/);
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

  test('every confirm inserts its own job on the caller handle (even with one pending)', async () => {
    const { enqueue } = load();
    const { trx, calls } = handle(true);
    await enqueue(trx, 'c1', 'new@example.test', 'app_email_change');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['insert', 'stripe_email_sync_jobs', { customer_id: 'c1', email: 'new@example.test', source: 'app_email_change' }]);
  });
});
