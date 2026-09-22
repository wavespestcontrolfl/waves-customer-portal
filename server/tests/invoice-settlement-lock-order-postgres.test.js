// Real PostgreSQL, two independent connections/transactions from the same
// pool, driven concurrently — a deterministic proof of a lock-ORDER
// invariant needs genuine cross-session contention; a single-connection
// nested transaction (the pattern most other *-postgres suites use) cannot
// produce it, since a knex/PostgreSQL savepoint never blocks against its
// own parent.
//
// settleZeroBalance (server/services/invoice.js) used to lock the invoice
// row, then the customer row. Most of the rest of the packet-invoice send/
// claim machinery — resolvePacketOwnershipLocked, claimPacketInvoiceForSend,
// and admin-schedule.js's Bill-To edit ("OWNERSHIP ROWS FIRST for a Bill-To
// edit") — locks the customer row first. A concurrent pair taking opposite
// orders on the SAME two rows is a textbook PostgreSQL deadlock (40P01):
// each session holds what the other wants. #4634 deferred the reorder to
// this slice (invoice.js ~1385) rather than patch it inline.
//
// This suite proves both halves: (1) the mismatched shape genuinely
// deadlocks — so this test rig would have caught the bug before the fix —
// and (2) the fixed shape (both sides customer-then-invoice, matching
// settleZeroBalance's current order) never does, for the identical pair of
// rows and the identical interleaving.
const { randomUUID } = require('crypto');
const knex = require('knex');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

// Structural tie-back: the two-connection tests above prove the GENERAL
// invariant (matched order never deadlocks); this ties it to the actual
// function, so a future edit reverting settleZeroBalance's order back to
// invoice-then-customer is caught even without a live database available.
// Runs unconditionally (no DATABASE_URL gate).
test('settleZeroBalance source locks the customer row before the invoice row', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
  const fnAt = source.indexOf('async settleZeroBalance(id, database = db, { requireDueBy = null } = {}) {');
  expect(fnAt).toBeGreaterThan(-1);
  const fnBody = source.slice(fnAt, fnAt + 3000);
  const customerLockAt = fnBody.indexOf('trx("customers").where({ id: preCustomer.customer_id }).forUpdate()');
  const invoiceLockAt = fnBody.indexOf('trx("invoices").where({ id }).forUpdate()');
  expect(customerLockAt).toBeGreaterThan(-1);
  expect(invoiceLockAt).toBeGreaterThan(customerLockAt);
});

// Codex pre-push P1 (round 1, sibling-caller sweep): settleZeroBalance
// fixing its OWN internal lock order is not enough on its own — a caller
// that passes an EXISTING transaction (one that already locked rows in
// the old order before settleZeroBalance ever runs on that same trx) still
// establishes the order PostgreSQL sees. Grep-swept every production
// caller of .settleZeroBalance( in the repo (not just server/services/):
// server/services/estimate-deposits.js and settleZeroDueVisitInvoice
// (invoice.js itself) both call with no `database` argument, so
// settleZeroBalance opens its OWN transaction and its own internal order
// governs — no external caller lock precedes it, nothing to fix there.
// server/services/visit-completion-payment.js's collectVisitCompletionInvoice
// is the ONE caller that passes an existing trx with rows already locked —
// checked below.
test('the one sibling caller that passes an existing transaction (visit-completion-payment.js) also locks customer before invoice', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/visit-completion-payment.js'), 'utf8');
  const fnAt = source.indexOf("const settlement = await database.transaction(async (trx) => {");
  expect(fnAt).toBeGreaterThan(-1);
  const fnBody = source.slice(fnAt, fnAt + 2000);
  const customerLockAt = fnBody.indexOf("trx('customers').where({ id: invoice.customer_id }).forUpdate()");
  const invoiceLockAt = fnBody.indexOf("trx('invoices').where({ id: invoice.id }).forUpdate()");
  expect(customerLockAt).toBeGreaterThan(-1);
  expect(invoiceLockAt).toBeGreaterThan(customerLockAt);
  // The customer-id mismatch guard travels with the reorder here too —
  // same reasoning as settleZeroBalance's own guard, ported to this
  // caller's own pre-lock/lock pair, using the outer (pre-transaction)
  // invoice.customer_id snapshot rather than a second in-transaction read
  // (a prior reorder attempt added one, and its extra invoice query
  // regressed lock-timing tests elsewhere — see the source comment).
  expect(fnBody).toMatch(/if \(locked\.customer_id !== invoice\.customer_id\) throw new Error\(/);
});

postgres('settleZeroBalance customer-then-invoice lock order (#4131 slice 5, #4634 deferral)', () => {
  let database;
  let customerId;
  let invoiceId;

  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
  });
  afterAll(async () => { if (database) await database.destroy(); });

  beforeEach(async () => {
    customerId = randomUUID();
    invoiceId = randomUUID();
    await database('customers').insert({
      id: customerId, first_name: 'Lock', last_name: 'Order',
      phone: '+12025550188', email: `${customerId}@example.invalid`,
    });
    await database('invoices').insert({
      id: invoiceId, customer_id: customerId, invoice_number: `TEST-LOCK-${invoiceId.slice(0, 8)}`,
      token: randomUUID(), status: 'draft', total: 117, subtotal: 117, line_items: '[]',
    });
  });
  afterEach(async () => {
    await database('invoices').where({ id: invoiceId }).del().catch(() => {});
    await database('customers').where({ id: customerId }).del().catch(() => {});
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const lockCustomer = (trx) => trx('customers').where({ id: customerId }).forUpdate().first('id');
  const lockInvoice = (trx) => trx('invoices').where({ id: invoiceId }).forUpdate().first('id');

  test('mismatched order (session A: invoice-then-customer, session B: customer-then-invoice — the pre-fix shape) genuinely deadlocks', async () => {
    const trxA = await database.transaction(); // plays settleZeroBalance's OLD order
    const trxB = await database.transaction(); // plays admin-schedule's Bill-To order (unchanged)
    try {
      await lockInvoice(trxA); // A holds invoice
      await lockCustomer(trxB); // B holds customer
      const aWantsCustomer = lockCustomer(trxA);
      // Let A's request actually register and block on B before B reaches
      // for the invoice — otherwise both requests could race in either
      // order and the cycle might not form on every run.
      await sleep(200);
      const bWantsInvoice = lockInvoice(trxB);
      const results = await Promise.allSettled([aWantsCustomer, bWantsInvoice]);
      const rejected = results.filter((r) => r.status === 'rejected');
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      // PostgreSQL's deadlock detector aborts exactly one side (40P01) and
      // lets the other proceed once the cycle breaks.
      expect(rejected).toHaveLength(1);
      expect(fulfilled).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('40P01');
    } finally {
      await trxA.rollback().catch(() => {});
      await trxB.rollback().catch(() => {});
    }
  });

  test('matched order (both sessions customer-then-invoice — the fixed shape) never deadlocks, same rows and interleaving', async () => {
    const trxA = await database.transaction(); // plays settleZeroBalance's NEW order
    const trxB = await database.transaction(); // plays admin-schedule's Bill-To order
    try {
      await lockCustomer(trxA); // A holds customer first, exactly like B would
      // B wants the SAME first resource A already holds — it queues behind
      // A rather than reaching for the invoice out of order. Deliberately
      // not awaited yet: this is the moment a mismatched B would instead
      // have grabbed the invoice and formed the cycle above.
      const bWantsCustomer = lockCustomer(trxB);
      await sleep(200);
      // A proceeds to its second resource — uncontended, since B is still
      // queued on the first and holds nothing of its own yet.
      await lockInvoice(trxA);
      await trxA.commit();
      // A's release lets B's queued customer lock resolve; B then reaches
      // for the invoice too, now uncontended.
      await bWantsCustomer;
      await lockInvoice(trxB);
      await trxB.commit();
    } catch (err) {
      await trxA.rollback().catch(() => {});
      await trxB.rollback().catch(() => {});
      throw err;
    }
  });
});

// Codex pre-push P1 (round 1 of the owner's audit): the customer-first
// reorder above reads customer_id UNLOCKED, then locks that customer,
// THEN locks the invoice — a customer merge repointing invoices.customer_id
// in the gap between the two reads would lock the WRONG (retired)
// customer and settle an invoice the SURVIVOR now owns without ever
// holding the survivor's own lock. This drives the REAL settleZeroBalance
// function (via the app's own db singleton, not a private connection —
// it always opens its own top-level transaction) through that exact gap
// using the same blocking-lock interleaving technique as the deadlock
// proof above, and asserts it fails closed instead of settling under the
// wrong lock.
postgres('settleZeroBalance re-verifies the customer after locking (Codex pre-push P1, round 1)', () => {
  let database; // raw, for fixture setup/teardown and the interleaving lock
  let Invoice;
  let customerAId;
  let customerBId;
  let invoiceId;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
    // The app's own db singleton — settleZeroBalance's default `database`
    // param — connects via the SAME DATABASE_URL from process.env, so it
    // reaches the identical physical database as `database` above.
    Invoice = require('../services/invoice');
  });
  afterAll(async () => { if (database) await database.destroy(); });

  beforeEach(async () => {
    customerAId = randomUUID();
    customerBId = randomUUID();
    invoiceId = randomUUID();
    await database('customers').insert([
      { id: customerAId, first_name: 'Owner', last_name: 'Original', phone: '+12025550171', email: `${customerAId}@example.invalid` },
      { id: customerBId, first_name: 'Owner', last_name: 'Survivor', phone: '+12025550172', email: `${customerBId}@example.invalid` },
    ]);
    await database('invoices').insert({
      id: invoiceId, customer_id: customerAId, invoice_number: `TEST-OWNER-${invoiceId.slice(0, 8)}`,
      token: randomUUID(), status: 'draft', total: 117, subtotal: 117, line_items: '[]',
    });
  });
  afterEach(async () => {
    await database('invoices').where({ id: invoiceId }).del().catch(() => {});
    await database('customers').whereIn('id', [customerAId, customerBId]).del().catch(() => {});
  });

  test('a customer repointing the invoice between the unlocked pre-read and the customer lock is caught — fails closed and retryable, never settles under the wrong customer', async () => {
    // Hold customer A locked so settleZeroBalance's OWN customer-lock
    // attempt (which will read customer A from its unlocked pre-check)
    // blocks on it — the exact window a real merge would land in.
    const trxA = await database.transaction();
    try {
      await trxA('customers').where({ id: customerAId }).forUpdate().first('id');

      const settlePromise = Invoice.settleZeroBalance(invoiceId);
      // Let settleZeroBalance's unlocked preCustomer read (customer A) and
      // its subsequent customer-lock attempt actually register and block
      // on trxA before the "merge" commits underneath it.
      await sleep(200);

      // The "merge": repoint the invoice to the survivor customer B and
      // commit, from a separate, unrelated connection — customer B isn't
      // locked by anyone, and the invoice itself isn't locked yet either
      // (settleZeroBalance hasn't reached its own invoice FOR UPDATE).
      await database('invoices').where({ id: invoiceId }).update({ customer_id: customerBId });

      // Release trxA — settleZeroBalance's blocked customer-A lock now
      // resolves (a stale lock: A is no longer this invoice's owner), and
      // it proceeds to lock + re-read the invoice, which now points to B.
      await trxA.commit();

      const result = await settlePromise;
      expect(result).toMatchObject({ settled: false, reason: 'owner_changed', retryable: true });
      expect(result.invoice).toMatchObject({ id: invoiceId, customer_id: customerBId });
    } finally {
      await trxA.rollback().catch(() => {});
    }

    // Confirmed NOT settled — no write of any kind happened to the invoice
    // beyond the "merge" update itself.
    const after = await database('invoices').where({ id: invoiceId }).first('status', 'customer_id');
    expect(after).toMatchObject({ status: 'draft', customer_id: customerBId });
  });

  test('control: no merge in the gap settles normally (the guard never fires on the ordinary path)', async () => {
    await database('invoices').where({ id: invoiceId }).update({ total: 0, subtotal: 0, credit_applied: 0 });
    const result = await Invoice.settleZeroBalance(invoiceId);
    expect(result.reason).not.toBe('owner_changed');
  });
});

// Codex pre-push P2 (round 2 of the owner's audit): postCreditMovement
// (server/services/customer-credit.js) locks the customer row — a caller
// that ALSO locks an invoice row in the SAME transaction, invoice-first,
// establishes the reversed order that deadlocks against settleZeroBalance's
// now customer-first order (proven above with the general two-connection
// harness — that proof covers this exact mechanism regardless of WHICH
// caller triggers it, so it is not re-derived per caller here). Every
// production caller of postCreditMovement was swept
// (`grep -rn "postCreditMovement(" --include="*.js" . | grep -v node_modules
// | grep -v /tests/`): most either open their own transaction (no external
// caller lock precedes them) or already lock the customer/a non-invoice row
// first (services/referral-engine.js, services/inspection-credit.js,
// services/annual-prepay-renewals.js's five call sites, routes/admin-
// customers.js's plain credit-issuance route) — those are unaffected and
// not listed below. Seven callers DID lock an invoice first and are fixed
// here, each a minimal reorder (an already-known customer_id — a function
// parameter, an outer unlocked read, or a new one added for this fix — locked
// before the invoice, mirroring settleZeroBalance's own fix). Two deeper,
// foundational functions in customer-credit.js itself are NOT included:
// applyAccountCreditToInvoice, returnAppliedCreditOnRefund, and
// reverseAppliedCredit (three, not two — see the "Not fixed" note below)
// have their OWN explicit, documented invoice-then-customer convention and
// are used throughout the codebase (auto-apply-on-send, void/refund
// reversal) — reordering them is a repo-wide lock-order decision, not a
// one-line caller fix, and is reported rather than changed here.
test('every production caller of postCreditMovement that locks an invoice first now locks the customer first (Codex pre-push P2, round 2)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  const cases = [
    {
      file: 'routes/admin-invoices.js', label: 'POST /:id/apply-credit',
      anchor: "outcome = await db.transaction(async (trx) => {",
      customerLock: "await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');",
      invoiceLock: "const locked = await trx('invoices').where({ id }).forUpdate().first();",
    },
    {
      file: 'routes/admin-invoices.js', label: 'POST /:id/reverse-prepaid',
      anchor: "if (preCustomer) await trx('customers').where({ id: preCustomer.customer_id }).forUpdate().first('id');",
      customerLock: "if (preCustomer) await trx('customers').where({ id: preCustomer.customer_id }).forUpdate().first('id');",
      invoiceLock: "const locked = await trx('invoices').where({ id }).forUpdate().first();",
    },
    {
      file: 'routes/admin-projects.js', label: 'reverseProjectCreditOnAbort',
      anchor: "if (preCustomer) await trx('customers').where({ id: preCustomer.customer_id }).forUpdate().first('id');\n        const locked = await trx('invoices').where({ id: claimedInvoice.id }).forUpdate().first();",
      customerLock: "if (preCustomer) await trx('customers').where({ id: preCustomer.customer_id }).forUpdate().first('id');",
      invoiceLock: "const locked = await trx('invoices').where({ id: claimedInvoice.id }).forUpdate().first();",
    },
    {
      file: 'services/stripe.js', label: 'resolveFailedInvoiceSavedCardChargeAttempt',
      anchor: "await trx('customers').where({ id: customerId }).forUpdate().first('id');\n    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();",
      customerLock: "await trx('customers').where({ id: customerId }).forUpdate().first('id');",
      invoiceLock: "const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();",
    },
    {
      file: 'services/stripe.js', label: 'persistSavedCardChargeCreditDelta',
      anchor: "await trx('customers').where({ id: customerId }).forUpdate().first('id');\n    const locked = await trx('invoices').where({ id: invoiceId }).forUpdate().first();",
      customerLock: "await trx('customers').where({ id: customerId }).forUpdate().first('id');",
      invoiceLock: "const locked = await trx('invoices').where({ id: invoiceId }).forUpdate().first();",
    },
    {
      file: 'routes/stripe-webhook.js', label: 'succeeded-PI fallback handler',
      anchor: "await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');\n      const lockedInvoice = await trx('invoices')",
      customerLock: "await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');",
      invoiceLock: "const lockedInvoice = await trx('invoices')",
    },
    {
      file: 'routes/stripe-webhook.js', label: 'ACH processing handler',
      anchor: "if (invoice.customer_id) await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');\n    const lockedInvoice = await trx('invoices')",
      customerLock: "if (invoice.customer_id) await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');",
      invoiceLock: "const lockedInvoice = await trx('invoices')",
    },
  ];

  for (const { file, label, anchor, customerLock, invoiceLock } of cases) {
    const source = read(file);
    expect(source.includes(anchor)).toBe(true);
    const customerAt = source.indexOf(customerLock);
    const invoiceAt = source.indexOf(invoiceLock, customerAt);
    if (customerAt === -1) throw new Error(`${file} (${label}): customer lock string not found`);
    if (!(invoiceAt > customerAt)) throw new Error(`${file} (${label}): invoice lock not found after customer lock`);
  }
});

// Local pre-push audit P1 (round 2, Claude fallback): several of the round-2
// customer-first reorders above sourced customer_id from an UNLOCKED
// pre-transaction read with no post-lock re-verify against a customer
// merge — the exact bug class settleZeroBalance's own owner-changed guard
// (proven above) exists to close. Three of the five flagged callers now
// re-verify the locked invoice's customer_id against the value the
// customer lock was taken on, with a response shaped to that caller's own
// posture: the two admin-invoices.js routes throw a 409 (an interactive
// request, safe to surface to the operator and retry); reverseProjectCreditOnAbort
// logs and skips (already a best-effort, no-rethrow cleanup path). The
// other two flagged callers — both in stripe-webhook.js — are deliberately
// NOT given a matching guard: see the comments at each site (and the
// "not guarded" test below) for why a throw there would be a regression,
// not a fix.
test('the three customer-first reorders above whose downstream writes actually key off the stale pre-lock value now re-verify it under the invoice lock (local pre-push audit P1, round 2)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  const cases = [
    {
      file: 'routes/admin-invoices.js', label: 'POST /:id/apply-credit',
      guard: "if (locked.customer_id !== invoice.customer_id) {\n          const err = new Error('This invoice\\'s owner changed — retry applying credit');\n          err.statusCode = 409; err.isOperational = true; throw err;\n        }",
    },
    {
      file: 'routes/admin-invoices.js', label: 'POST /:id/reverse-prepaid',
      guard: "if (preCustomer && locked.customer_id !== preCustomer.customer_id) {\n          const err = new Error('This invoice\\'s owner changed — retry reversing the applied credit');\n          err.statusCode = 409; err.isOperational = true; throw err;\n        }",
    },
    {
      file: 'routes/admin-projects.js', label: 'reverseProjectCreditOnAbort',
      guard: "if (preCustomer && locked && locked.customer_id !== preCustomer.customer_id) {\n          logger.error(`[projects] credit-reversal abort-cleanup skipped for invoice ${claimedInvoice.id} — owner changed between the pre-read and the lock; reconcile the $${appliedProjectCredit} applied credit manually`);\n          return;\n        }",
    },
  ];

  for (const { file, label, guard } of cases) {
    const source = read(file);
    if (!source.includes(guard)) {
      throw new Error(`${file} (${label}): expected post-lock customer-merge re-verify guard not found`);
    }
  }
});

// Deliberately NOT guarded (local pre-push audit P1, round 2 — a rebuttal,
// not a miss): a first attempt added the same throw-on-mismatch guard here
// too, and it broke tests/stripe-webhook-settlement-ownership.test.js — a
// PRE-EXISTING, pinned contract that a concurrent ownership change must be
// FOLLOWED to its new owner (every write sources customer_id from
// `lockedInvoice`, the post-wait re-read, never from the stale pre-lock
// `invoice`), not refused. Unlike the three callers above, a stale
// pre-lock value here cannot corrupt a write — it can only mean the
// upfront customer lock landed on the previous owner's row instead of the
// current one, a narrow lock-order edge case that Stripe's own webhook
// retry already recovers from. Structural tie-back so a future edit that
// makes these two callers key a write off the stale `invoice` value
// (instead of `lockedInvoice`) is caught.
test('the two stripe-webhook.js reorders left unguarded still source every downstream write from the LOCKED invoice, never the stale pre-lock read', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/stripe-webhook.js'), 'utf8');

  const customerIdWrites = (lockAnchor, fnLabel) => {
    // Start AFTER the upfront customer-lock line itself — that line
    // legitimately reads the stale `invoice.customer_id` (it is only
    // choosing which row to lock, not writing anything) — so the "never
    // the stale read" assertion below is not tripped by its own lock.
    const lockAt = source.indexOf(lockAnchor);
    if (lockAt === -1) throw new Error(`stripe-webhook.js: lock anchor for ${fnLabel} not found`);
    const bodyStart = lockAt + lockAnchor.length;
    const body = source.slice(bodyStart, bodyStart + 8000);
    // Both the payments insert (customer_id: lockedInvoice.customer_id) and
    // postCreditMovement's argument (customerId: lockedInvoice.customer_id)
    // key off the post-wait re-read.
    expect(body).toMatch(/customer_?[Ii]d:\s*lockedInvoice\.customer_id/);
    expect(body).not.toMatch(/customer_?[Ii]d:\s*invoice\.customer_id/);
  };

  customerIdWrites(
    "await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');\n      const lockedInvoice = await trx('invoices')",
    'succeeded-PI fallback handler',
  );
  customerIdWrites(
    "if (invoice.customer_id) await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');\n    const lockedInvoice = await trx('invoices')",
    'ACH processing handler',
  );
});

// Not fixed — reported, not reordered (see the comment above): the three
// widely-used, foundational functions in customer-credit.js that already
// carry their OWN deliberate invoice-then-customer convention. Structural
// tie-back so this stays a live, named finding rather than a stale claim —
// if any of these is ever reordered, this test's job is done and it should
// be deleted along with the "not fixed" framing above.
test("customer-credit.js's three foundational credit functions still use the OLDER invoice-then-customer order — a known, reported, NOT one-line-reorderable conflict", () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/customer-credit.js'), 'utf8');

  const stillInvoiceFirst = (fnSignature, invoiceLock, customerLockOrMovement) => {
    const fnAt = source.indexOf(fnSignature);
    expect(fnAt).toBeGreaterThan(-1);
    const invoiceAt = source.indexOf(invoiceLock, fnAt);
    const laterAt = source.indexOf(customerLockOrMovement, invoiceAt);
    expect(invoiceAt).toBeGreaterThan(fnAt);
    expect(laterAt).toBeGreaterThan(invoiceAt);
  };

  stillInvoiceFirst(
    "async function applyAccountCreditToInvoice(",
    "const invoice = await t('invoices').where({ id: invoiceId }).forUpdate().first();",
    'postCreditMovement(',
  );
  stillInvoiceFirst(
    'async function returnAppliedCreditOnRefund(',
    "const inv = await trx('invoices').where({ id: invoiceId }).forUpdate()",
    'postCreditMovement(',
  );
  stillInvoiceFirst(
    'async function reverseAppliedCredit(',
    "const inv = await t('invoices').where({ id: invoiceId }).forUpdate()",
    'postCreditMovement(',
  );
});
