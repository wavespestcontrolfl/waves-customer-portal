/**
 * Same-trip first-application billing ALERT — periodic SWEEP over STAMPED
 * PROVENANCE (owner ruling, 2026-09-27; supersedes the #5021 round-3..9
 * "alert from every writer" design AND the round-10..r8 structural-guessing
 * sweep). A reserved-accept slot selling two-or-more recurring programs
 * mints ONE combined "First service application" invoice; every covered
 * member — the reserved anchor AND each promoted same-day sibling — is
 * stamped, once, with that invoice's id
 * (scheduled_services.first_application_invoice_id) inside the SAME
 * transaction that mints the invoice
 * (estimate-converter.js stampCombinedFirstApplicationInvoiceCoverage). A
 * one-time backfill migration stamped the small number of live historical
 * pairs using the OLD text-based recognition
 * (estimate-first-application-invoice.js backfillFirstApplicationInvoiceStamps).
 * The sweep (server/services/scheduler.js) NEVER guesses membership any
 * more: it reads the stamp, groups by invoice, re-derives each group's
 * state fresh, and opens/refreshes or clears ONE durable admin alert
 * (notification-service.notifyAdmin, category 'billing') per invoice group
 * — it never touches the invoice's money, never holds collection, never
 * takes a new lock beyond notifyAdmin's own dedupe advisory lock. The
 * office splits the invoice by hand.
 *
 * Real PostgreSQL verification; run with
 * SIBLING_RESPLIT_TEST_DATABASE_URL pointing to a disposable local, managed
 * worktree QA, or isolated CI database. Every fixture rolls back.
 */
jest.setTimeout(60000);
const { randomUUID } = require('crypto');

const testUrl = process.env.SIBLING_RESPLIT_TEST_DATABASE_URL;
const local = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname)
  && new URL(testUrl).pathname.includes('sibling_resplit');
const managed = testUrl && process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
  && testUrl === process.env.DATABASE_URL
  && new URL(testUrl).pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
const ci = testUrl && process.env.CI === 'true' && testUrl === process.env.DATABASE_URL
  && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname) && new URL(testUrl).pathname === '/waves_test';
if (testUrl && !local && !managed && !ci) {
  throw new Error('Sibling-split tests require a dedicated local sibling_resplit, managed worktree QA, or isolated CI database.');
}
const suite = local || managed || ci ? describe : describe.skip;

suite('first-application-sibling-split — periodic sweep', () => {
  let db;
  const {
    loadCandidates,
    groupCandidatesByInvoice,
    evaluateEstimateCandidates,
    clearStandingAlerts,
    loadSweepCursor,
    saveSweepCursor,
  } = require('../services/first-application-sibling-split');
  const { stampCombinedFirstApplicationInvoiceCoverage } = require('../services/estimate-converter');
  const { backfillFirstApplicationInvoiceStamps } = require('../services/estimate-first-application-invoice');

  beforeAll(() => { db = require('knex')({ client: 'pg', connection: testUrl }); });
  afterAll(async () => { await db?.destroy(); await require('../models/db').destroy(); });

  async function rollbackTest(fn) {
    const trx = await db.transaction();
    try { await fn(trx); } finally { await trx.rollback(); }
  }

  const DEDUPE_KEY = (estimateId, siblingIds) => `first_application_sibling_divergence:${estimateId}:${[...siblingIds].map(String).sort().join(',')}`;

  // A reserved pest row (priced — the invoice-holder) + a promoted lawn
  // parent (unpriced sibling), both accepted off the same estimate on the
  // same day, exactly like a same-day accept that sold two recurring
  // programs into one reserved slot. `stamp: false` mints the invoice
  // WITHOUT stamping either member — models an invoice that predates this
  // feature, or one created off some other path, so the pair must never be
  // discovered by mere resemblance. `matchInvoiceText: false` mints an
  // invoice whose title/notes do NOT match the OLD auto-generated
  // pay-per-application pattern — under the stamp design this must have NO
  // bearing on candidacy at all. `invoiceStatus` lets a test mint an
  // already-settled invoice.
  const SAME_DATE = '2026-10-01';
  async function fixture(trx, {
    reservedPrice = 153.60,
    sameDate = SAME_DATE,
    matchInvoiceText = true,
    noInvoice = false,
    invoiceStatus = 'draft',
    stamp = true,
  } = {}) {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic sibling-split fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true,
      estimated_price: reservedPrice,
    });
    await trx('scheduled_services').insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: sameDate,
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
      estimated_price: null,
    });
    let invoiceId = null;
    if (!noInvoice) {
      invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: invoiceStatus,
        title: matchInvoiceText ? 'First Service Application' : 'Custom invoice title',
        notes: matchInvoiceText
          ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`
          : 'A hand-edited note with nothing recognizable in it.',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: reservedPrice, amount: reservedPrice }]),
        subtotal: reservedPrice, total: reservedPrice,
      });
      if (stamp) {
        // Mirrors estimate-converter.js's own
        // stampCombinedFirstApplicationInvoiceCoverage write — done here in
        // the SAME (fixture) transaction as the mint, exactly like the real
        // accept path stamps inside its own invoice-mint transaction. The
        // stamp IS the membership signal now (owner ruling 2026-09-27); a
        // test that wants to model an unstamped historical invoice passes
        // `stamp: false`.
        await trx('scheduled_services').whereIn('id', [pestId, lawnId]).update({ first_application_invoice_id: invoiceId });
      }
    }
    return {
      customerId, estimateId, pestId, lawnId, invoiceId,
    };
  }

  async function readBell(conn, dedupeKey) {
    return conn('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first();
  }

  // Runs the sweep's own candidate-discovery + per-invoice-group evaluation
  // on ONE connection (the test's own transaction) — the same two calls
  // runFirstApplicationSiblingSplitSweep makes per group, just without the
  // outer runExclusive lock or the per-group transaction split
  // (rollbackTest already isolates the whole test in one transaction).
  // Groups are now keyed by the stamped first_application_invoice_id, never
  // an estimate-keyed guess — "mine" is whichever group contains a member
  // under this estimate.
  async function sweepOnce(trx, estimateId) {
    const candidates = await loadCandidates(trx);
    const groups = groupCandidatesByInvoice(candidates);
    const mine = groups.find((g) => g.some((m) => String(m.source_estimate_id) === String(estimateId)));
    if (!mine) return [];
    return [await evaluateEstimateCandidates(trx, mine)];
  }

  test('a diverging unpriced sibling raises exactly one durable alert row — invoice/visit money untouched', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.estimateId).toBe(ids.estimateId);
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

    const [pest, lawn, invoice] = await Promise.all([
      trx('scheduled_services').where({ id: ids.pestId }).first(),
      trx('scheduled_services').where({ id: ids.lawnId }).first(),
      trx('invoices').where({ id: ids.invoiceId }).first(),
    ]);
    // Never touched: neither visit's price moved, nor the invoice total.
    expect(Number(pest.estimated_price)).toBe(153.60);
    expect(lawn.estimated_price).toBeNull();
    expect(Number(invoice.total)).toBe(153.60);

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bells = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
    expect(bells).toHaveLength(1);
    expect(bells[0].link).toBe(`/admin/invoices?invoice=${ids.invoiceId}`);
    expect(bells[0].body).toContain('split it by hand');
    expect(bells[0].body).toContain('Invoice');
    expect(bells[0].read_at).toBeNull();
    const metadata = typeof bells[0].metadata === 'string' ? JSON.parse(bells[0].metadata) : bells[0].metadata;
    // P2 fix: metadata carries customerId so NotificationService's
    // demo/App-Store-review test-account suppression can apply.
    expect(metadata.customerId).toBe(ids.customerId);
    expect(metadata.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('the SAME still-open divergence, swept again, never opens a second alert row', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    await sweepOnce(trx, ids.estimateId);

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bells = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
    expect(bells).toHaveLength(1);
  }));

  test('realigned on a later tick — the standing alert is auto-cleared (marked read)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // The sibling moves back onto the anchor's day.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('realigned');

    const cleared = await readBell(trx, dedupeKey);
    expect(cleared.read_at).not.toBeNull();
    const metadata = typeof cleared.metadata === 'string' ? JSON.parse(cleared.metadata) : cleared.metadata;
    expect(metadata.autoCleared).toBe(true);
  }));

  test('the invoice settles (paid) on a later tick — the standing alert is auto-cleared even though the visits still diverge', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('invoice_settled');
    expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
  }));

  // Codex P2 (PR #5021 r7): a card charge landing 'processing' between the
  // last tick and this one must clear the standing alert too — the
  // canonical INVOICE_UNCOLLECTIBLE_STATUSES (invoice-helpers.js) already
  // treats 'processing' as uncollectible everywhere else in the app, and
  // this module's own settled set now reuses that list directly.
  test("the invoice moves to 'processing' on a later tick — the standing alert clears too", () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'processing' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('invoice_settled');
    expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
  }));

  // Codex P2 (PR #5021 r7): loadCandidates' invoice status is read OUTSIDE
  // this group's own evaluation transaction (plain `db`, before any
  // per-group `db.transaction` opens), so it can already be stale by the
  // time evaluateEstimateCandidates runs. Simulates that race directly: use
  // a candidate group loadCandidates already returned while the invoice was
  // still 'draft', then settle the invoice, then feed that STALE group into
  // evaluateEstimateCandidates — it must re-read the invoice fresh under
  // FOR UPDATE and clear, never alert off the stale status.
  test('evaluateEstimateCandidates re-reads the invoice fresh — a settle that lands after loadCandidates still clears', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });

    const staleCandidates = await loadCandidates(trx);
    const staleGroup = groupCandidatesByInvoice(staleCandidates).find((g) => String(g[0].invoice_id) === String(ids.invoiceId));
    expect(staleGroup).toBeTruthy();
    expect(staleGroup).toHaveLength(2);

    // The invoice settles AFTER loadCandidates already read the group.
    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid' });

    const result = await evaluateEstimateCandidates(trx, staleGroup);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('invoice_settled');
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect(await readBell(trx, dedupeKey)).toBeUndefined();
  }));

  // Codex round-10 P2: membersForInvoice's own dates/statuses (not just
  // loadCandidates' invoice status, covered above) are also a snapshot
  // taken OUTSIDE this group's own evaluation transaction. A schedule edit
  // committing after that snapshot but before this group's own turn in the
  // sweep must be picked up by evaluateEstimateCandidates re-reading the
  // MEMBER rows fresh, not just the invoice row.
  describe('evaluateEstimateCandidates re-reads MEMBER rows fresh', () => {
    test('a divergence that appears AFTER loadCandidates still raises the alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx); // both members start aligned on SAME_DATE
      const staleCandidates = await loadCandidates(trx);
      const staleGroup = groupCandidatesByInvoice(staleCandidates).find((g) => String(g[0].invoice_id) === String(ids.invoiceId));
      expect(staleGroup).toBeTruthy();
      expect(staleGroup).toHaveLength(2);

      // The sibling moves onto a different date AFTER loadCandidates
      // already read the (still-aligned) group.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });

      const result = await evaluateEstimateCandidates(trx, staleGroup);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
    }));

    test('a realignment that lands AFTER loadCandidates still clears the alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId); // raises the standing alert
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      const staleCandidates = await loadCandidates(trx); // still diverged in this snapshot
      const staleGroup = groupCandidatesByInvoice(staleCandidates).find((g) => String(g[0].invoice_id) === String(ids.invoiceId));
      expect(staleGroup).toBeTruthy();

      // The sibling moves BACK onto the anchor's date AFTER loadCandidates
      // already read the (still-diverged) group.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });

      const result = await evaluateEstimateCandidates(trx, staleGroup);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('realigned');
      expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
    }));

    test('a status change (cancelled) that lands AFTER loadCandidates is still seen', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx); // both members aligned on SAME_DATE
      const staleCandidates = await loadCandidates(trx);
      const staleGroup = groupCandidatesByInvoice(staleCandidates).find((g) => String(g[0].invoice_id) === String(ids.invoiceId));
      expect(staleGroup).toBeTruthy();
      expect(staleGroup.find((m) => String(m.id) === String(ids.lawnId)).status).toBe('confirmed');

      // The sibling is cancelled AFTER loadCandidates already read the
      // group as a plain 'confirmed' row.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });

      const result = await evaluateEstimateCandidates(trx, staleGroup);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
    }));
  });

  // A divergence the SWEEP ITSELF auto-cleared (realigned) that recurs on
  // the EXACT SAME date must still reopen — its fingerprint and
  // notification content match the pre-clear alert exactly, so plain
  // fingerprint dedupe would otherwise leave it silently cleared even
  // though the problem is back.
  test('a divergence the sweep auto-cleared, recurring on the SAME date, reopens rather than staying cleared', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    // Realign — the SWEEP auto-clears it (not a human dismissal).
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    const [clearResult] = await sweepOnce(trx, ids.estimateId);
    expect(clearResult.action).toBe('cleared');
    const autoCleared = await readBell(trx, dedupeKey);
    expect(autoCleared.read_at).not.toBeNull();

    // Diverge again onto the EXACT SAME date as the original alert.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');

    const reopened = await readBell(trx, dedupeKey);
    expect(reopened.id).toBe(firstBell.id);
    expect(reopened.read_at).toBeNull();
    const metadata = typeof reopened.metadata === 'string' ? JSON.parse(reopened.metadata) : reopened.metadata;
    expect(metadata.autoCleared).toBe(false);
  }));

  test('recurrence reopens the bell — dismissed by the office while still-open, then a genuine new divergence reopens it unread', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    // Office reads/dismisses it while the divergence is still technically
    // present, then the sibling realigns (clearing it the system's own
    // way) and diverges again — the SAME estimate, the SAME diverging
    // sibling id, a genuine recurrence.
    await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    await sweepOnce(trx, ids.estimateId);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-03' });
    await sweepOnce(trx, ids.estimateId);

    const reopened = await readBell(trx, dedupeKey);
    expect(reopened.id).toBe(firstBell.id);
    expect(reopened.read_at).toBeNull();
  }));

  // Real-data manual-split detection: the office's own instructed fix —
  // giving the moved sibling its own live invoice linked to its own
  // scheduled_service_id — must stop the alert on its own, without relying
  // on any invoice title/notes text.
  //
  // Signal (a) alone — has_own_live_invoice — DELIBERATELY, not signal (b)
  // (a dollar comparison against the combined invoice's total/lines): see
  // the module header for the full history of why a dollar reconciliation
  // proved unreliable across three independent design rounds.
  test('a manual split with both invoices still unpaid → no alert, and an existing alert is cleared', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office completes the instructed manual split: the sibling visit gets
    // its OWN live invoice, linked to its own scheduled_service_id — same
    // linkage findFirstApplicationInvoiceForEstimateService uses elsewhere.
    // Both invoices stay unpaid — ownership is the signal, not settlement.
    const lawnInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: lawnInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('split_completed');

    const cleared = await readBell(trx, dedupeKey);
    expect(cleared.read_at).not.toBeNull();
    const metadata = typeof cleared.metadata === 'string' ? JSON.parse(cleared.metadata) : cleared.metadata;
    expect(metadata.autoCleared).toBe(true);

    // Neither original invoice's money moved — the sweep never touches it.
    const [pest, sharedInvoice] = await Promise.all([
      trx('scheduled_services').where({ id: ids.pestId }).first(),
      trx('invoices').where({ id: ids.invoiceId }).first(),
    ]);
    expect(Number(pest.estimated_price)).toBe(153.60);
    expect(Number(sharedInvoice.total)).toBe(153.60);
  }));

  test('a voided "split" invoice does not count — still alerts (void is not a real split)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);

    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'void', title: 'Lawn Care', notes: 'Voided draft — never actually billed.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('a cancelled "split" invoice does not count either — still alerts', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);

    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'cancelled', title: 'Lawn Care', notes: 'Cancelled draft — no replacement charge.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  // Dismissal semantics: a dismissed alert must not reopen on the next tick
  // unless the state materially changed.
  test('dismissed alert + unchanged state → stays dismissed', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    // Office dismisses it while the divergence is still technically open —
    // nothing about the dates or the invoice changes.
    await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });

    // Sweep again with NO change at all.
    await sweepOnce(trx, ids.estimateId);

    const stillDismissed = await readBell(trx, dedupeKey);
    expect(stillDismissed.id).toBe(firstBell.id);
    expect(stillDismissed.read_at).not.toBeNull();
  }));

  test('dismissed alert + a new date change → reopens', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });

    // The sibling moves AGAIN to a different date — same estimate, same
    // diverging sibling id, but the dates tuple materially changed.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-09' });
    await sweepOnce(trx, ids.estimateId);

    const reopened = await readBell(trx, dedupeKey);
    expect(reopened.id).toBe(firstBell.id);
    expect(reopened.read_at).toBeNull();
  }));

  test('dismiss → complete the split → sweep → void the split invoice → sweep reopens the recurrence', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    // Staff dismiss it by hand WHILE it is still genuinely diverging.
    await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });

    // THEN they complete the instructed split: lawn gets its own price and
    // its own live invoice. Note: under the stamp design lawn's
    // first_application_invoice_id is untouched by this — the group stays
    // the same two-member stamped pair; only has_own_live_invoice changes.
    const lawnInvoiceId = randomUUID();
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ estimated_price: 42 });
    await trx('invoices').insert({
      id: lawnInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });

    const [afterSplit] = await sweepOnce(trx, ids.estimateId);
    expect(afterSplit.action).toBe('cleared');
    expect(afterSplit.reason).toBe('split_completed');
    const confirmedClear = await readBell(trx, dedupeKey);
    expect(confirmedClear.id).toBe(firstBell.id);
    const clearMeta = typeof confirmedClear.metadata === 'string' ? JSON.parse(confirmedClear.metadata) : confirmedClear.metadata;
    expect(clearMeta.autoCleared).toBe(true);

    // Staff void the split invoice — the SAME divergence genuinely recurs
    // (lawn is still on 2026-10-02, still diverging from pest, and no
    // longer has a live invoice of its own).
    await trx('invoices').where({ id: lawnInvoiceId }).update({ status: 'void' });
    const [afterVoid] = await sweepOnce(trx, ids.estimateId);
    expect(afterVoid.action).toBe('alerted');
    expect(afterVoid.divergingSiblingIds).toEqual([ids.lawnId]);

    const reopened = await readBell(trx, dedupeKey);
    expect(reopened.id).toBe(firstBell.id);
    expect(reopened.read_at).toBeNull();
  }));

  test('dismissed while diverging, then a genuine realignment, then recurrence onto the SAME original date reopens', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const firstBell = await readBell(trx, dedupeKey);
    expect(firstBell.read_at).toBeNull();

    // Office dismisses it by hand while the divergence is still open.
    await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });

    // The visits GENUINELY realign — the sweep must record this resolution
    // even though the alert row is already marked read.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: SAME_DATE });
    const [clearResult] = await sweepOnce(trx, ids.estimateId);
    expect(clearResult.action).toBe('cleared');
    expect(clearResult.reason).toBe('realigned');
    const afterRealign = await readBell(trx, dedupeKey);
    const afterRealignMeta = typeof afterRealign.metadata === 'string' ? JSON.parse(afterRealign.metadata) : afterRealign.metadata;
    expect(afterRealignMeta.autoCleared).toBe(true);
    expect(afterRealign.read_at).not.toBeNull();

    // Diverges again onto the EXACT SAME original date.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');

    const reopened = await readBell(trx, dedupeKey);
    expect(reopened.id).toBe(firstBell.id);
    expect(reopened.read_at).toBeNull();
  }));

  // ---------------------------------------------------------------------
  // Voided stamped invoice + a LIVE REPLACEMENT on the SAME anchor visit
  // (Charge Now / completion re-minting the combined amount on
  // invoices.scheduled_service_id) — Codex round 7 P1 on the prior
  // structural-guessing design: the stamp is never rewritten (owner ruling:
  // accept-time-only), so once the stamped invoice goes terminal,
  // evaluateEstimateCandidates must resolve the current LIVE replacement as
  // the GOVERNING invoice instead of letting the dead stamped row keep
  // clearing (or hiding) the alert while the replacement still charges both
  // programs. Codex round-9 P1: governance is durable-evidence-only (the
  // scheduled_service_id linkage) — NO title/notes text recognition any
  // more, since InvoiceService.update lets a live replacement's title/notes
  // be renamed on an unpaid invoice, and this alert is advisory: the office
  // needs to look regardless of what the anchor's live invoice actually is.
  // ---------------------------------------------------------------------
  describe('voided stamped invoice with a live replacement on the anchor', () => {
    // Mints a live invoice recognized as a first-application invoice,
    // linked to the SAME anchor scheduled_service_id as the (about to be
    // voided) stamped invoice — models Charge Now / completion re-minting
    // the combined amount on the reserved row after the original is voided.
    async function mintRecognizedReplacement(trx, { anchorId, customerId, total = 153.60, status = 'sent' }) {
      const id = randomUUID();
      await trx('invoices').insert({
        id, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status,
        title: 'First Service Application',
        notes: 'Auto-generated from accepted estimate. Customer selected pay per application — first application only.',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: total, amount: total }]),
        subtotal: total, total,
      });
      return id;
    }

    test('void + recognized live replacement while DIVERGED → alert stays, naming the replacement invoice', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      // The original combined invoice is voided and a live replacement is
      // minted on the SAME anchor (pest) visit.
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = await mintRecognizedReplacement(trx, { anchorId: ids.pestId, customerId: ids.customerId });

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

      const bell = await readBell(trx, dedupeKey);
      expect(bell.read_at).toBeNull();
      expect(bell.link).toBe(`/admin/invoices?invoice=${replacementId}`);
      const metadata = typeof bell.metadata === 'string' ? JSON.parse(bell.metadata) : bell.metadata;
      // The alert's invoice reference is the GOVERNING (replacement)
      // invoice, never the dead voided stamped row — this is what
      // loadCandidates' own alert-recovery EXISTS reads back too.
      expect(metadata.invoiceId).toBe(replacementId);
      // The STAMPED (voided) invoice's own id is written alongside it (P2)
      // so a LATER hand-off — this replacement itself later going
      // terminal — can still recover the alert.
      expect(metadata.stampedInvoiceId).toBe(ids.invoiceId);
      expect(bell.body).toMatch(/charge now sits on invoice/i);
    }));

    test('void + replacement while ALIGNED → no alert; group re-enters discovery with no standing alert once it later diverges', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      // Never diverged — both visits stay on SAME_DATE throughout.
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      await mintRecognizedReplacement(trx, { anchorId: ids.pestId, customerId: ids.customerId });

      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      const [alignedResult] = await sweepOnce(trx, ids.estimateId);
      expect(alignedResult.action).toBe('cleared');
      expect(await readBell(trx, dedupeKey)).toBeUndefined();

      // Now it diverges — the group must be freshly discoverable (via the
      // live-replacement clause, with NO standing alert to recover) and
      // alert off the replacement.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);
      const [divergedResult] = await sweepOnce(trx, ids.estimateId);
      expect(divergedResult.action).toBe('alerted');
      expect(divergedResult.divergingSiblingIds).toEqual([ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();
    }));

    test('void + NO live replacement → clears exactly like today', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      const cleared = await readBell(trx, dedupeKey);
      expect(cleared.read_at).not.toBeNull();
    }));

    test('void + an unrecognized-looking live anchor invoice (an unrelated hand invoice) → STILL governs and alerts (Codex round-9 P1: no text recognition)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      // A live invoice sharing the anchor's scheduled_service_id, with no
      // first-application recognition at all — a repair or one-off charge
      // that happens to reuse the same row. This now governs anyway: the
      // pair is still genuinely diverged, and this advisory alert must
      // point staff at whatever invoice actually sits on the anchor rather
      // than clear silently.
      const handInvoiceId = randomUUID();
      await trx('invoices').insert({
        id: handInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'Sprinkler head repair', notes: 'One-off hand invoice, unrelated to the estimate.',
        line_items: JSON.stringify([{ description: 'Repair', quantity: 1, unit_price: 45, amount: 45 }]),
        subtotal: 45, total: 45,
      });

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
      const bell = await readBell(trx, dedupeKey);
      expect(bell.read_at).toBeNull();
      expect(bell.link).toBe(`/admin/invoices?invoice=${handInvoiceId}`);
      const metadata = typeof bell.metadata === 'string' ? JSON.parse(bell.metadata) : bell.metadata;
      expect(metadata.invoiceId).toBe(handInvoiceId);
      // The stamped (voided) invoice's own id is preserved separately so a
      // LATER governing-invoice change can still recover this alert (P2).
      expect(metadata.stampedInvoiceId).toBe(ids.invoiceId);
      expect(bell.body).toMatch(/charge now sits on invoice/i);
    }));

    test('a dismissed alert reopens once the split invoice is voided and a recognized replacement is reissued', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      const firstBell = await readBell(trx, dedupeKey);
      expect(firstBell.read_at).toBeNull();

      // Staff dismiss it by hand while still genuinely diverging.
      await trx('notifications').where({ id: firstBell.id }).update({ read_at: new Date() });

      // The combined invoice is voided and reissued live on the same
      // anchor — the SAME divergence, but now governed by a DIFFERENT
      // invoice id, which must be enough to reopen the dismissed bell on
      // its own (the fingerprint's invoiceId changed).
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = await mintRecognizedReplacement(trx, { anchorId: ids.pestId, customerId: ids.customerId });

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');

      const reopened = await readBell(trx, dedupeKey);
      expect(reopened.id).toBe(firstBell.id);
      expect(reopened.read_at).toBeNull();
      const metadata = typeof reopened.metadata === 'string' ? JSON.parse(reopened.metadata) : reopened.metadata;
      expect(metadata.invoiceId).toBe(replacementId);
      expect(metadata.autoCleared).toBe(false);
    }));

    test('the replacement invoice itself later settles (paid) → clears, even though the visits still diverge', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = await mintRecognizedReplacement(trx, { anchorId: ids.pestId, customerId: ids.customerId });
      const [alerted] = await sweepOnce(trx, ids.estimateId);
      expect(alerted.action).toBe('alerted');

      await trx('invoices').where({ id: replacementId }).update({ status: 'paid' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
    }));

    // Codex round-9 P2: raiseDivergenceAlert stores the GOVERNING invoice's
    // id in metadata.invoiceId, and loadCandidates' alert-recovery EXISTS
    // matched only that field — so once a GOVERNING REPLACEMENT itself also
    // goes terminal (void/refunded/cancelled), with no further live invoice
    // on the anchor, neither that recovery clause (invoiceId is the dead
    // replacement's id, not the stamped invoice's) nor the live-replacement
    // clause (nothing live left) could find the group on any future sweep
    // — the standing alert stayed open forever with no way to ever
    // re-evaluate or clear it. Fix: metadata.stampedInvoiceId (the fixed,
    // never-rewritten stamped id) is always ALSO written, and the recovery
    // clause matches on it too.
    test('replacement itself later voided too → next sweep still finds the group (stampedInvoiceId recovery) and clears it', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = await mintRecognizedReplacement(trx, { anchorId: ids.pestId, customerId: ids.customerId });
      const [alerted] = await sweepOnce(trx, ids.estimateId);
      expect(alerted.action).toBe('alerted');
      const alertedBell = await readBell(trx, dedupeKey);
      const alertedMeta = typeof alertedBell.metadata === 'string' ? JSON.parse(alertedBell.metadata) : alertedBell.metadata;
      expect(alertedMeta.invoiceId).toBe(replacementId);
      expect(alertedMeta.stampedInvoiceId).toBe(ids.invoiceId);

      // The replacement now ALSO goes void — no live invoice left on the
      // anchor at all.
      await trx('invoices').where({ id: replacementId }).update({ status: 'void' });
      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      const cleared = await readBell(trx, dedupeKey);
      expect(cleared.id).toBe(alertedBell.id);
      expect(cleared.read_at).not.toBeNull();
      const clearedMeta = typeof cleared.metadata === 'string' ? JSON.parse(cleared.metadata) : cleared.metadata;
      expect(clearedMeta.autoCleared).toBe(true);
    }));
  });

  // ---------------------------------------------------------------------
  // Candidacy semantics (owner ruling 2026-09-27): the stamp is the ONLY
  // membership signal now. No text match, no structural guess (an unpriced
  // sibling, no live invoice of its own, ...) ever makes a pair a
  // candidate on its own.
  // ---------------------------------------------------------------------

  // Replaces the old structural-guessing "invoice text unrecognizable —
  // still a candidate (candidacy is structural, not text-matched)" test:
  // under the stamp design the invoice's own title/notes were NEVER read by
  // candidate discovery in the first place, so a stamped pair is a
  // candidate regardless of what its invoice happens to say.
  test('a stamped pair with unrecognizable invoice text IS a candidate — the stamp is the only signal, never the text', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { matchInvoiceText: false });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  // New: the mirror image — an invoice that WOULD match the old text
  // pattern (or even one with genuinely first-application-shaped text) but
  // was never stamped must never be discovered. This is the case a
  // hand-edited invoice, or one minted by any path other than
  // estimate-converter.js's own accept-time stamp, actually produces.
  test('an unstamped pair is never a candidate, even with matching invoice text', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { stamp: false });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [pest, lawn] = await Promise.all([
      trx('scheduled_services').where({ id: ids.pestId }).first('first_application_invoice_id'),
      trx('scheduled_services').where({ id: ids.lawnId }).first('first_application_invoice_id'),
    ]);
    expect(pest.first_application_invoice_id).toBeNull();
    expect(lawn.first_application_invoice_id).toBeNull();
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results).toEqual([]);
  }));

  // Codex round-11 P2 on PR #5021: a stamped group whose partner has since
  // lost its stamp (the FK's ON DELETE SET NULL firing, or a manual
  // correction) collapses to a group of one. groupCandidatesByInvoice no
  // longer drops it — it IS evaluated, every tick, exactly like any other
  // group — but a lone stamped member can never diverge from itself, so it
  // never alerts; it only ever clears (see the fresh-re-read
  // "freshMembers.length < 2" branch in evaluateEstimateCandidates).
  test('a stamped group whose partner is unstamped (group of one) is evaluated and never alerts', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ first_application_invoice_id: null, scheduled_date: '2026-10-02' });

    // The pest row alone still shows up in the raw candidate scan (its own
    // stamp is untouched)...
    const candidates = await loadCandidates(trx);
    const mine = candidates.filter((c) => String(c.source_estimate_id) === String(ids.estimateId));
    expect(mine.map((c) => c.id)).toEqual([ids.pestId]);

    // ...and grouping keeps the now-solo stamp as a group of one, which IS
    // evaluated — never alerted, cleared instead since fewer than 2 current
    // members can never be a diverging pair.
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('not_a_pair');
  }));

  // Codex round-11 P2 on PR #5021: before this fix, a group that collapsed
  // to one stamped member was dropped entirely by groupCandidatesByInvoice,
  // so a standing alert for that estimate could never auto-clear once its
  // partner's stamp was manually nulled — it stood forever. Now the
  // singleton IS evaluated and the fresh-re-read clear path fires.
  test('an alerted pair whose partner stamp is later nulled has its standing alert autoCleared on the next sweep', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [alerted] = await sweepOnce(trx, ids.estimateId);
    expect(alerted.action).toBe('alerted');
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const before = await readBell(trx, dedupeKey);
    expect(before).toBeTruthy();
    expect(before.read_at).toBeNull();

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ first_application_invoice_id: null });
    const [cleared] = await sweepOnce(trx, ids.estimateId);
    expect(cleared.action).toBe('cleared');
    expect(cleared.reason).toBe('not_a_pair');

    const after = await readBell(trx, dedupeKey);
    expect(after.read_at).not.toBeNull();
    let meta = after.metadata;
    if (typeof meta === 'string') meta = JSON.parse(meta);
    expect(meta.autoCleared).toBe(true);
  }));

  test('no first-application invoice at all — never a sweep candidate, no alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { noInvoice: true });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results).toEqual([]);
  }));

  // Under the stamp design, loadCandidates' own SQL has NO alignment
  // filter any more (that filtering moved entirely to
  // evaluateGroupDivergence) — a stamped, never-diverged, non-cancelled
  // group on a long-open invoice IS returned as a candidate and evaluated
  // every tick, but it never alerts.
  test('an ALIGNED, never-diverged, non-cancelled stamped group is a candidate but never alerts, even with a long-open invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'overdue' });
    const candidates = await loadCandidates(trx);
    expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('cleared');
    expect(results[0].reason).toBe('realigned');
  }));

  // A normal single-program estimate has no same-day top-level recurring
  // sibling to stamp alongside it — stampCombinedFirstApplicationInvoiceCoverage
  // bails out with nothing stamped, so the anchor's own
  // first_application_invoice_id stays NULL forever, regardless of what its
  // own invoice's title/notes happen to say.
  test('a normal single-program estimate is never a candidate, even with first-application-shaped invoice text', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const soloId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic single-program fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: soloId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 99,
    });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: soloId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 99, amount: 99 }]),
      subtotal: 99, total: 99,
    });
    // No stamp is ever written here — a single-program accept never gets
    // one. Move the visit's own date around — a single-program estimate has
    // no sibling to diverge from in the first place.
    await trx('scheduled_services').where({ id: soloId }).update({ scheduled_date: '2026-10-09' });
    const solo = await trx('scheduled_services').where({ id: soloId }).first('first_application_invoice_id');
    expect(solo.first_application_invoice_id).toBeNull();
    const results = await sweepOnce(trx, estimateId);
    expect(results).toEqual([]);
  }));

  // Two SEPARATE recurring programs off one estimate, each independently
  // priced AND independently invoiced from day one (never sharing one
  // combined invoice, never stamped), must never be read as a
  // reserved-accept split just because they share an estimate.
  test('two independently priced-and-invoiced programs from one estimate are never a candidate', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic two-separate-programs fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert([
      {
        id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 100,
      },
      {
        id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: 80,
      },
    ]);
    await trx('invoices').insert([
      {
        id: randomUUID(), customer_id: customerId, scheduled_service_id: pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'Quarterly Pest Control', notes: 'Standard invoice.',
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 100, amount: 100 }]),
        subtotal: 100, total: 100,
      },
      {
        id: randomUUID(), customer_id: customerId, scheduled_service_id: lawnId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'Lawn Care', notes: 'Standard invoice.',
        line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 80, amount: 80 }]),
        subtotal: 80, total: 80,
      },
    ]);
    // Neither row is ever stamped — nothing minted a COMBINED invoice here.
    // One of the two visits moves — a real divergence between two
    // independently billed programs, not a shared-invoice conflict.
    await trx('scheduled_services').where({ id: lawnId }).update({ scheduled_date: '2026-10-02' });
    const results = await sweepOnce(trx, estimateId);
    expect(results).toEqual([]);
  }));

  // A THREE-member stamped group (A anchor + B + C, all stamped with the
  // SAME invoice at accept time). B and C both diverge; staff then price
  // and separately invoice B ONLY (a partial split), leaving C still
  // unpriced and un-invoiced. Because the stamp is permanent and shared, B
  // and C are STILL grouped with A on every future tick — B's own new
  // invoice never changes B's own first_application_invoice_id — so the
  // group evaluation must correctly resolve B (has_own_live_invoice) while
  // keeping the real alert open for C.
  test('a partially completed THREE-program split (B priced + invoiced, C still uncovered) keeps the real alert open', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const anchorId = randomUUID();
    const bId = randomUUID();
    const cId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic three-program partial-split fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert([
      {
        id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200,
      },
      {
        id: bId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null,
      },
      {
        id: cId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
      },
    ]);
    const anchorInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: anchorInvoiceId, customer_id: customerId, scheduled_service_id: anchorId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
      subtotal: 200, total: 200,
    });
    // All three stamped together at accept time — exactly what
    // stampCombinedFirstApplicationInvoiceCoverage writes for a 3-program
    // reserved accept.
    await trx('scheduled_services').whereIn('id', [anchorId, bId, cId]).update({ first_application_invoice_id: anchorInvoiceId });

    // B and C both diverge from the anchor onto the SAME new day.
    await trx('scheduled_services').where({ id: bId }).update({ scheduled_date: '2026-10-02' });
    await trx('scheduled_services').where({ id: cId }).update({ scheduled_date: '2026-10-02' });
    const [firstResult] = await sweepOnce(trx, estimateId);
    expect(firstResult.action).toBe('alerted');
    expect(firstResult.divergingSiblingIds).toEqual([bId, cId].map(String).sort());
    const dedupeKey = DEDUPE_KEY(estimateId, [bId, cId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office splits B only: prices it and mints its own live invoice —
    // B's own first_application_invoice_id stays pointed at the anchor's
    // invoice; this new invoice is a SEPARATE row linked via
    // invoices.scheduled_service_id, never a re-stamp.
    await trx('scheduled_services').where({ id: bId }).update({ estimated_price: 60 });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: bId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
      subtotal: 60, total: 60,
    });

    // The group is still all three members, keyed by the one stamped
    // invoice id — never narrowed by B's own new invoice.
    const candidates = await loadCandidates(trx);
    const mine = candidates.filter((c) => String(c.source_estimate_id) === String(estimateId));
    expect(mine.map((c) => c.id).sort()).toEqual([anchorId, bId, cId].sort());
    expect(mine.every((c) => String(c.invoice_id) === String(anchorInvoiceId))).toBe(true);

    const [result] = await sweepOnce(trx, estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([cId]);

    // The alert for the now-narrower diverging set (just C, since B
    // resolved) is open and unread.
    const newDedupeKey = DEDUPE_KEY(estimateId, [cId]);
    const stillOpen = await readBell(trx, newDedupeKey);
    expect(stillOpen.read_at).toBeNull();
  }));

  // The opposite shape: a THREE-program group where C stays ALIGNED with
  // the anchor the whole time — only B moves and gets split off.
  // evaluateGroupDivergence computes every member's divergence against the
  // SAME anchor, always, so C (which never moved) must never be reported
  // even after B resolves, across repeated sweeps and a dismissal.
  test('C stays aligned with A after B splits off — never a false alert about C, even across repeated sweeps and a dismissal', () => rollbackTest(async (trx) => {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const anchorId = randomUUID();
    const bId = randomUUID();
    const cId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic aligned-sibling fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert([
      {
        id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200,
      },
      {
        id: bId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null,
      },
      {
        id: cId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
      },
    ]);
    const anchorInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: anchorInvoiceId, customer_id: customerId, scheduled_service_id: anchorId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
      subtotal: 200, total: 200,
    });
    await trx('scheduled_services').whereIn('id', [anchorId, bId, cId]).update({ first_application_invoice_id: anchorInvoiceId });

    // Only B moves. C stays put, aligned with A, the whole time.
    await trx('scheduled_services').where({ id: bId }).update({ scheduled_date: '2026-10-02' });
    const [firstResult] = await sweepOnce(trx, estimateId);
    expect(firstResult.action).toBe('alerted');
    expect(firstResult.divergingSiblingIds).toEqual([bId]);
    const dedupeKey = DEDUPE_KEY(estimateId, [bId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office splits B: prices it and mints its own live invoice. C never
    // moved, so the group is now genuinely, fully resolved.
    await trx('scheduled_services').where({ id: bId }).update({ estimated_price: 60 });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: bId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
      subtotal: 60, total: 60,
    });

    const [result] = await sweepOnce(trx, estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('split_completed');

    const cleared = await readBell(trx, dedupeKey);
    expect(cleared.read_at).not.toBeNull();

    // No NEW alert about C was ever raised.
    const cDedupeKey = DEDUPE_KEY(estimateId, [cId]);
    expect(await readBell(trx, cDedupeKey)).toBeUndefined();

    // Repeated sweeps — with the original alert both left alone (still
    // cleared) and explicitly re-dismissed — must never resurrect a bogus
    // alert about C.
    for (let tick = 0; tick < 3; tick += 1) {
      const [repeat] = await sweepOnce(trx, estimateId);
      expect(repeat.action).toBe('cleared');
      expect(await readBell(trx, cDedupeKey)).toBeUndefined();
    }

    await trx('notifications').where({ id: cleared.id }).update({ read_at: new Date() });
    const [afterDismiss] = await sweepOnce(trx, estimateId);
    expect(afterDismiss.action).toBe('cleared');
    expect(await readBell(trx, cDedupeKey)).toBeUndefined();
  }));

  test('a priced (but still diverging) sibling still alerts (Codex P1 fix)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02', estimated_price: 42 });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('siblings realigned and both priced — no alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ estimated_price: 42 });
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results.every((r) => r.action !== 'alerted')).toBe(true);
  }));

  test('a completed sibling still alerts — completion never settles the still-open combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', completed_at: new Date() });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('a cancelled sibling still alerts — its charge is still on the combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', status: 'cancelled' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bell = await readBell(trx, dedupeKey);
    expect(bell.body).toContain('was cancelled');
    expect(bell.body).toContain('remove its charge from the combined invoice');
    // Never the hand-a-visit-off phrasing — there is no visit left to move.
    expect(bell.body).not.toContain('split it by hand');
  }));

  test('a sibling cancelled on the SAME day as the anchor (never diverged by date) still alerts', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).body).toContain('remove its charge from the combined invoice');
  }));

  test('a dismissed cancelled-sibling alert stays dismissed while unchanged, reopens once the charge is actually moved off', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const original = await readBell(trx, dedupeKey);
    await trx('notifications').where({ id: original.id }).update({ read_at: new Date() });

    // Unchanged state — another tick must not reopen it.
    const [unchanged] = await sweepOnce(trx, ids.estimateId);
    expect(unchanged.action).toBe('alerted');
    expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();

    // The office actually splits the charge off the cancelled sibling.
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Charge removed from the combined invoice and rebilled standalone.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });
    const [resolved] = await sweepOnce(trx, ids.estimateId);
    expect(resolved.action).toBe('cleared');
    expect(resolved.reason).toBe('split_completed');
    expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
  }));

  test.each(['skipped', 'no_show'])('a %s sibling still alerts — its charge is still on the combined invoice', (status) => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ status });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const bell = await readBell(trx, dedupeKey);
    expect(bell.body).toContain('remove its charge from the combined invoice');
    expect(bell.body).not.toContain('split it by hand');
  }));

  // Corrects the old "drops out of candidate discovery once autoCleared"
  // framing: loadCandidates' own SQL excludes a group ONLY when its invoice
  // is settled OR (its invoice is open AND its alert is already confirmed
  // autoCleared) — there is no more "no own live invoice" gate at the
  // discovery layer. A resolved-but-still-open group therefore STAYS a
  // candidate every tick (harmlessly re-evaluating to 'cleared' each time)
  // until the underlying invoice itself actually settles.
  test('a resolved unpriced sibling (own live invoice, never priced) stops alerting but stays a candidate while its combined invoice is still open', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    // Diverge first so an alert actually gets raised.
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [alerted] = await sweepOnce(trx, ids.estimateId);
    expect(alerted.action).toBe('alerted');

    // The office splits the charge off WITHOUT ever pricing the sibling row
    // itself — estimated_price stays NULL, only its own invoice appears.
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    expect(lawn.estimated_price).toBeNull();
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });
    const [resolved] = await sweepOnce(trx, ids.estimateId);
    expect(resolved.action).toBe('cleared');
    expect(resolved.reason).toBe('split_completed');

    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    const cleared = await readBell(trx, dedupeKey);
    const clearedMeta = typeof cleared.metadata === 'string' ? JSON.parse(cleared.metadata) : cleared.metadata;
    expect(clearedMeta.autoCleared).toBe(true);

    // The combined invoice is STILL open (never paid) — the stamped group
    // remains in loadCandidates (the stamp never expires), and sweeping
    // again re-evaluates to the same harmless 'cleared' verdict, never a
    // fresh alert.
    const stillOpenInvoice = await trx('invoices').where({ id: ids.invoiceId }).first('status');
    expect(['draft', 'sent', 'viewed', 'overdue']).toContain(stillOpenInvoice.status);
    const candidatesAfter = await loadCandidates(trx);
    expect(candidatesAfter.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);
    const [resweep] = await sweepOnce(trx, ids.estimateId);
    expect(resweep.action).toBe('cleared');
    expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
  }));

  // Continuation: once the combined invoice ITSELF settles too (paid,
  // void, ...), the group finally drops out of loadCandidates entirely —
  // the alert is already confirmed autoCleared, so the standing-alert
  // recovery clause does not rescue it either.
  test('once the combined invoice itself settles, a resolved group drops out of candidate discovery entirely', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });
    const [resolved] = await sweepOnce(trx, ids.estimateId);
    expect(resolved.action).toBe('cleared');
    expect(resolved.reason).toBe('split_completed');

    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid' });
    const candidatesAfter = await loadCandidates(trx);
    expect(candidatesAfter.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(false);
  }));

  // Replaces the old loadGroupMembers-based coverage (that export no longer
  // exists): a one-time (non-recurring) appointment under the same
  // estimate is never stamped by stampCombinedFirstApplicationInvoiceCoverage
  // (it requires is_recurring = true), so it can never appear in a
  // candidate group at all — confirmed directly against loadCandidates.
  test('a one-time (non-recurring) appointment under the same estimate is never a stamped member', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const oneTimeId = randomUUID();
    await trx('scheduled_services').insert({
      id: oneTimeId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: '2026-11-20',
      service_type: 'One-Time Initial Cleanup', status: 'confirmed', is_recurring: false, estimated_price: 75,
    });
    // Both recurring programs stay aligned — only the one-time add-on sits
    // on a wildly different date, which must never itself trigger an
    // alert (it is not a same-trip stamped member at all).
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results.every((r) => r.action !== 'alerted')).toBe(true);

    const candidates = await loadCandidates(trx);
    const mine = candidates.filter((c) => String(c.source_estimate_id) === String(ids.estimateId));
    expect(mine.map((c) => c.id).sort()).toEqual([ids.lawnId, ids.pestId].sort());
    expect(mine.some((c) => c.id === oneTimeId)).toBe(false);
    const oneTime = await trx('scheduled_services').where({ id: oneTimeId }).first('first_application_invoice_id');
    expect(oneTime.first_application_invoice_id).toBeNull();
  }));

  test('the priced (invoice-holding) row itself moving off the sibling\'s date raises the same alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.pestId }).update({ scheduled_date: '2026-10-05' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('a rolled-back sweep leaves no alert behind', async () => {
    const outer = await db.transaction();
    let ids;
    let dedupeKey;
    try {
      ids = await fixture(outer);
      await outer('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      const [result] = await sweepOnce(outer, ids.estimateId);
      expect(result.action).toBe('alerted');
      dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
      expect(await readBell(outer, dedupeKey)).toBeTruthy();
    } finally {
      await outer.rollback();
    }
    // A FRESH connection, outside the rolled-back transaction — nothing
    // persisted: neither the fixture rows nor the alert.
    expect(await readBell(db, dedupeKey)).toBeUndefined();
    expect(await db('scheduled_services').where({ id: ids.lawnId }).first()).toBeUndefined();
  });

  test('clearStandingAlerts is idempotent — clearing with nothing open is a no-op', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    const cleared = await clearStandingAlerts(trx, `first_application_sibling_divergence:${ids.estimateId}:`);
    expect(cleared).toBe(0);
  }));

  test('an alert-write failure surfaces per-candidate — the failing group is reported, never silently dropped', () => rollbackTest(async (trx) => {
    const notificationService = require('../services/notification-service');
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const spy = jest.spyOn(notificationService, 'notifyAdmin').mockRejectedValueOnce(new Error('injected notifyAdmin failure'));
    try {
      const candidates = await loadCandidates(trx);
      const mine = candidates.filter((c) => String(c.source_estimate_id) === String(ids.estimateId));
      await expect(evaluateEstimateCandidates(trx, mine)).rejects.toThrow('injected notifyAdmin failure');
    } finally {
      spy.mockRestore();
    }
  }));

  test('the sweep cursor round-trips through the real table and is restored on rollback', () => rollbackTest(async (trx) => {
    const before = await loadSweepCursor(trx);
    const sentinel = randomUUID();
    await saveSweepCursor(trx, sentinel);
    expect(await loadSweepCursor(trx)).toBe(sentinel);
    // Never observable outside this rolled-back transaction.
    expect(await loadSweepCursor(db)).toBe(before);
  }));

  // Codex round-11 P2 on PR #5021: saveSweepCursor used to be a plain
  // UPDATE of the id=1 singleton row. loadSweepCursor already treats a
  // missing row as recoverable ("start from the beginning"), but a plain
  // UPDATE silently no-ops once that row is gone — every tick would then
  // restart from a null cursor forever. saveSweepCursor must upsert the
  // singleton back into existence.
  test('saveSweepCursor recreates the singleton row when it has been deleted', () => rollbackTest(async (trx) => {
    await trx('first_application_sibling_split_sweep_cursor').where({ id: 1 }).del();
    expect(await trx('first_application_sibling_split_sweep_cursor').where({ id: 1 }).first()).toBeUndefined();

    const sentinel = randomUUID();
    await saveSweepCursor(trx, sentinel);

    const row = await trx('first_application_sibling_split_sweep_cursor').where({ id: 1 }).first();
    expect(row).toBeTruthy();
    expect(row.id).toBe(1);
    expect(row.last_estimate_id).toBe(sentinel);
    expect(await loadSweepCursor(trx)).toBe(sentinel);
  }));

  // ---------------------------------------------------------------------
  // stampCombinedFirstApplicationInvoiceCoverage (estimate-converter.js) —
  // the writer that records the stamp at accept time, inside the SAME
  // transaction that mints the combined invoice.
  // ---------------------------------------------------------------------
  describe('stampCombinedFirstApplicationInvoiceCoverage', () => {
    async function seedProgram(trx, {
      customerId, estimateId, scheduledDate = SAME_DATE, isRecurring = true, recurringParentId = null, estimatedPrice = null,
    } = {}) {
      const id = randomUUID();
      await trx('scheduled_services').insert({
        id, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: scheduledDate,
        service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: isRecurring,
        recurring_parent_id: recurringParentId, estimated_price: estimatedPrice,
      });
      return id;
    }

    async function seedCustomerAndEstimate(trx, label) {
      const customerId = randomUUID();
      const estimateId = randomUUID();
      await trx('customers').insert({
        id: customerId, first_name: `Synthetic ${label} fixture`, phone: `qa-${customerId.slice(0, 8)}`, active: true,
      });
      await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
      return { customerId, estimateId };
    }

    test('stamps the anchor + a promoted same-day top-level recurring sibling, both, inside the trx', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-pair');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const siblingId = await seedProgram(trx, { customerId, estimateId });
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'First Service Application', notes: 'n/a',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
        subtotal: 200, total: 200,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId });

      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBe(invoiceId);
      expect(sibling.first_application_invoice_id).toBe(invoiceId);
    }));

    test('a single-program anchor (no sibling) leaves the column NULL', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-solo');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 99 });
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'Quarterly Pest Control', notes: 'n/a',
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 99, amount: 99 }]),
        subtotal: 99, total: 99,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId });

      const anchor = await trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id');
      expect(anchor.first_application_invoice_id).toBeNull();
    }));

    test('a CHILD occurrence (recurring_parent_id set) on the same day is NOT stamped', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-child');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const siblingParentId = await seedProgram(trx, { customerId, estimateId });
      const childId = await seedProgram(trx, { customerId, estimateId, recurringParentId: siblingParentId });
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'First Service Application', notes: 'n/a',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
        subtotal: 200, total: 200,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId });

      const [siblingParent, child] = await Promise.all([
        trx('scheduled_services').where({ id: siblingParentId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: childId }).first('first_application_invoice_id'),
      ]);
      expect(siblingParent.first_application_invoice_id).toBe(invoiceId);
      expect(child.first_application_invoice_id).toBeNull();
    }));

    test('a non-recurring one-time row on the same day is NOT stamped', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-onetime');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const oneTimeId = await seedProgram(trx, { customerId, estimateId, isRecurring: false, estimatedPrice: 75 });
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'First Service Application', notes: 'n/a',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
        subtotal: 200, total: 200,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId });

      const [anchor, oneTime] = await Promise.all([
        trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: oneTimeId }).first('first_application_invoice_id'),
      ]);
      // The one-time row alone never qualifies as "the sibling that
      // justifies a pair" — the anchor itself is therefore left unstamped
      // too (single-program-equivalent: no recurring sibling exists).
      expect(anchor.first_application_invoice_id).toBeNull();
      expect(oneTime.first_application_invoice_id).toBeNull();
    }));

    test('a sibling on a DIFFERENT date is NOT stamped', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-different-date');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const laterId = await seedProgram(trx, { customerId, estimateId, scheduledDate: '2026-11-01' });
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'First Service Application', notes: 'n/a',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
        subtotal: 200, total: 200,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId });

      const [anchor, later] = await Promise.all([
        trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: laterId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBeNull();
      expect(later.first_application_invoice_id).toBeNull();
    }));
  });

  // ---------------------------------------------------------------------
  // backfillFirstApplicationInvoiceStamps
  // (estimate-first-application-invoice.js) — the one-time, idempotent
  // historical backfill (also the one the schema migration itself calls),
  // using the OLD text-based recognition on existing data.
  // ---------------------------------------------------------------------
  describe('backfillFirstApplicationInvoiceStamps', () => {
    async function seedHistoricalPair(trx, {
      matchInvoiceText = true, invoiceStatus = 'sent', siblingPriced = false,
    } = {}) {
      const customerId = randomUUID();
      const estimateId = randomUUID();
      const anchorId = randomUUID();
      const siblingId = randomUUID();
      await trx('customers').insert({
        id: customerId, first_name: 'Synthetic backfill fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
      });
      await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
      await trx('scheduled_services').insert([
        {
          id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
          service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200,
        },
        {
          id: siblingId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
          service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
          estimated_price: siblingPriced ? 60 : null,
        },
      ]);
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: invoiceStatus,
        title: matchInvoiceText ? 'First Service Application' : 'Custom invoice title',
        notes: matchInvoiceText
          ? `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`
          : 'A hand-edited note with nothing recognizable in it.',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
        subtotal: 200, total: 200,
      });
      return {
        customerId, estimateId, anchorId, siblingId, invoiceId,
      };
    }

    test('stamps a historical text-recognized pair', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx);
      const result = await backfillFirstApplicationInvoiceStamps(trx);
      expect(result.stamped).toBeGreaterThanOrEqual(2);
      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
      expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
    }));

    test('skips a single-program invoice (no unpriced same-day top-level recurring sibling)', () => rollbackTest(async (trx) => {
      const customerId = randomUUID();
      const estimateId = randomUUID();
      const anchorId = randomUUID();
      await trx('customers').insert({
        id: customerId, first_name: 'Synthetic backfill solo fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
      });
      await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
      await trx('scheduled_services').insert({
        id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
        service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 99,
      });
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'First Service Application',
        notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 99, amount: 99 }]),
        subtotal: 99, total: 99,
      });

      await backfillFirstApplicationInvoiceStamps(trx);

      const anchor = await trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id');
      expect(anchor.first_application_invoice_id).toBeNull();
    }));

    test('skips a void invoice', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx, { invoiceStatus: 'void' });
      await backfillFirstApplicationInvoiceStamps(trx);
      const anchor = await trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id');
      expect(anchor.first_application_invoice_id).toBeNull();
    }));

    test('skips an unrecognizable-text invoice', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx, { matchInvoiceText: false });
      await backfillFirstApplicationInvoiceStamps(trx);
      const anchor = await trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id');
      expect(anchor.first_application_invoice_id).toBeNull();
    }));

    test('leaves an already-priced sibling out (single-program-equivalent — never stamped)', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx, { siblingPriced: true });
      await backfillFirstApplicationInvoiceStamps(trx);
      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBeNull();
      expect(sibling.first_application_invoice_id).toBeNull();
    }));

    test('idempotent — a second run returns the same mapping, with no change', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx);
      const first = await backfillFirstApplicationInvoiceStamps(trx);
      const second = await backfillFirstApplicationInvoiceStamps(trx);
      expect(second.stamped).toBe(first.stamped);
      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
      expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
    }));

    test('returns { scanned, stamped }', () => rollbackTest(async (trx) => {
      await seedHistoricalPair(trx);
      const result = await backfillFirstApplicationInvoiceStamps(trx);
      expect(typeof result.scanned).toBe('number');
      expect(typeof result.stamped).toBe('number');
      expect(result.scanned).toBeGreaterThanOrEqual(1);
      expect(result.stamped).toBeGreaterThanOrEqual(2);
    }));

    // -----------------------------------------------------------------
    // Codex round-9 P1 (superseded by round-11 P2 below): the original
    // rule required the sibling's CURRENT scheduled_date to still match
    // the anchor's — so a pair that had ALREADY diverged before this
    // migration ever ran (the exact state this feature exists to surface)
    // was never stamped. Widened to accept ACCEPTANCE-TIME evidence
    // instead: a sibling created within 120 seconds of the INVOICE's own
    // created_at — the same-transaction birth instant a genuine promoted
    // sibling always shares with the invoice, regardless of where either
    // row's scheduled_date has since moved to.
    //
    // Codex round-11 P2: a later same-CURRENT-date match (the original (a)
    // branch, and every reschedule_log branch that only ever proved a
    // sibling or anchor once shared a date) is REMOVED — it stamped any
    // unpriced top-level recurring row that merely happened to share the
    // anchor's date today, including a wholly separate program staff added
    // later under the same estimate. The created_at window above is the
    // ONLY same-trip evidence now: a row created at accept qualifies
    // regardless of where it has moved since, and a row created later
    // never qualifies no matter what date it currently shows.
    // -----------------------------------------------------------------
    describe('accept-time created_at window eligibility', () => {
      async function seedAcceptanceEvidencePair(trx, {
        anchorCreatedAt = new Date('2026-08-01T10:00:00Z'),
        siblingCreatedAt = new Date('2026-08-01T10:00:00Z'),
        // Defaults to the anchor's own created_at: these fixtures model the
        // ORDINARY (non-reserved) same-instant accept, where the invoice is
        // minted at the very same moment the anchor and sibling rows are
        // inserted — evidence (b) below now compares the sibling against
        // the INVOICE's created_at (pre-push P1), so the invoice needs an
        // explicit created_at here too, not the real `now()` its insert
        // would otherwise default to. The RESERVED-anchor shape, where the
        // anchor predates the invoice by days, has its own fixture
        // (seedReservedAnchorPair below).
        invoiceCreatedAt = anchorCreatedAt,
        siblingScheduledDate = '2026-09-15',
        siblingEstimatedPrice = null,
        siblingOwnLiveInvoice = false,
      } = {}) {
        const customerId = randomUUID();
        const estimateId = randomUUID();
        const anchorId = randomUUID();
        const siblingId = randomUUID();
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic backfill acceptance-evidence fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
        });
        await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
        await trx('scheduled_services').insert([
          {
            id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200,
            created_at: anchorCreatedAt,
          },
          {
            id: siblingId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: siblingScheduledDate,
            service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
            estimated_price: siblingEstimatedPrice,
            created_at: siblingCreatedAt,
          },
        ]);
        const invoiceId = randomUUID();
        await trx('invoices').insert({
          id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
          status: 'sent', title: 'First Service Application',
          notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
          line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
          subtotal: 200, total: 200,
          created_at: invoiceCreatedAt,
        });
        if (siblingOwnLiveInvoice) {
          await trx('invoices').insert({
            id: randomUUID(), customer_id: customerId, scheduled_service_id: siblingId,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'Lawn Care', notes: 'Hand-split lawn invoice',
            line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
            subtotal: 60, total: 60,
          });
        }
        return {
          customerId, estimateId, anchorId, siblingId, invoiceId,
        };
      }

      test('an already-diverged pair created in the SAME accept (shared created_at, different current dates) IS stamped', () => rollbackTest(async (trx) => {
        const sharedInstant = new Date('2026-08-01T10:00:03Z'); // within 120s of the anchor's
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: sharedInstant,
          siblingScheduledDate: '2026-11-20', // long since moved off the anchor's date
        });
        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.stamped).toBeGreaterThanOrEqual(2);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
        expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
      }));

      // Codex round-11 P2 — the exact bug: a separate program staff added
      // LATER under the same estimate, that simply happens to share the
      // anchor's date TODAY, must never be swept up as though it shared the
      // accept trip. Same current date, but created well outside the
      // window ⇒ not stamped.
      test('a same-day sibling added later (created 2 hours after the invoice) is NOT stamped — the P2 case', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-01T10:00:00Z');
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: invoiceCreatedAt,
          invoiceCreatedAt,
          siblingCreatedAt: new Date('2026-08-01T12:00:00Z'), // 2 hours later — outside the 120s window
          siblingScheduledDate: SAME_DATE, // still shares the anchor's CURRENT date today
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));

      test('a same-estimate program from a genuinely SEPARATE, later accept (different day, no shared created_at instant) is NOT stamped', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-09-10T14:00:00Z'), // a much later, independent accept
          siblingScheduledDate: '2026-11-20',
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        // Single-program-equivalent: the sole other row never qualifies as
        // the sibling that justifies a pair, so the anchor is left
        // unstamped too, exactly like the plain "skips a single-program
        // invoice" case above.
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));

      test('a same-estimate program from a separate accept that already picked up its OWN price is NOT stamped', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-08-01T10:00:03Z'), // even within the shared-instant window
          siblingScheduledDate: SAME_DATE, // even still on the anchor's own current date
          siblingEstimatedPrice: 60, // already priced — hand-split, never re-absorbed
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));

      test('a same-estimate program that already has its OWN live invoice is NOT stamped, even with a shared created_at instant', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-08-01T10:00:03Z'),
          siblingScheduledDate: '2026-11-20',
          siblingOwnLiveInvoice: true,
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));

      test('rerun is idempotent for an already-diverged, shared-instant pair', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-08-01T10:00:03Z'),
          siblingScheduledDate: '2026-11-20',
        });
        const first = await backfillFirstApplicationInvoiceStamps(trx);
        const second = await backfillFirstApplicationInvoiceStamps(trx);
        expect(second.stamped).toBe(first.stamped);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
        expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
      }));
    });

    // -----------------------------------------------------------------
    // Pre-push P1 (Codex auditor on f7d5c6ea75), still true under round-11
    // P2: a RESERVED anchor row is minted when the slot is reserved, often
    // DAYS before acceptance, while the converter inserts the invoice AND
    // the promoted sibling together, AT acceptance. Comparing the
    // sibling's created_at against the ANCHOR's own created_at would fail
    // for exactly this shape, which is why the window compares against the
    // INVOICE's own created_at instead — the sibling and the invoice are
    // always born in the same accept transaction even when the anchor
    // predates both by days, and it makes no difference where the anchor
    // (or the sibling) has since moved to: the window is the only
    // evidence, so a row's CURRENT scheduled_date never enters the
    // decision either way.
    // -----------------------------------------------------------------
    describe('reserved-anchor evidence: invoice created_at window', () => {
      async function seedReservedAnchorPair(trx, {
        invoiceCreatedAt,
        anchorCreatedAt,
        siblingCreatedAt,
        anchorScheduledDate = SAME_DATE,
        siblingScheduledDate = '2026-11-20',
      }) {
        const customerId = randomUUID();
        const estimateId = randomUUID();
        const anchorId = randomUUID();
        const siblingId = randomUUID();
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic backfill reserved-anchor fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
        });
        await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
        await trx('scheduled_services').insert([
          {
            id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: anchorScheduledDate,
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200,
            created_at: anchorCreatedAt,
          },
          {
            id: siblingId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: siblingScheduledDate,
            service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null,
            created_at: siblingCreatedAt,
          },
        ]);
        const invoiceId = randomUUID();
        await trx('invoices').insert({
          id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
          status: 'sent', title: 'First Service Application',
          notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
          line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
          subtotal: 200, total: 200,
          created_at: invoiceCreatedAt,
        });
        return {
          customerId, estimateId, anchorId, siblingId, invoiceId,
        };
      }

      // (b) from the assignment: the reserved-anchor-moved shape still
      // stamps purely on the created_at window, with no reschedule_log
      // evidence needed at all — the anchor having moved off the shared
      // date days after accept makes no difference, since the window only
      // ever compares the sibling's created_at against the invoice's.
      test('reserved anchor created days before the invoice, sibling created at invoice time, anchor later moved off the shared date — stamped purely on the window', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'), // reserved 3 days before accept
          siblingCreatedAt: invoiceCreatedAt, // promoted sibling inserted in the SAME accept transaction as the invoice
          anchorScheduledDate: '2026-09-20', // the anchor later moved off the shared date
          siblingScheduledDate: '2026-09-15', // the sibling stayed on the original shared date
        });
        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.stamped).toBeGreaterThanOrEqual(2);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
        expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
      }));

      // (a) from the assignment (the P2 case, reserved-anchor shape): a
      // sibling created 2 hours after the invoice — well outside the 120s
      // window — is NOT stamped, even though the anchor was genuinely
      // reserved days ahead of accept. No reschedule_log evidence exists
      // to fall back on any more.
      test('same reserved-anchor shape, but the sibling was created 2 hours after the invoice — NOT stamped (a genuinely separate later booking)', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'),
          siblingCreatedAt: new Date('2026-08-04T11:00:00Z'), // 2 hours after the invoice — outside the 120s window
          anchorScheduledDate: SAME_DATE,
          siblingScheduledDate: '2026-11-20',
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));

      // (c) from the assignment: idempotent rerun for the reserved-anchor
      // shape.
      test('rerun is idempotent for the reserved-anchor invoice-created_at window shape', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'),
          siblingCreatedAt: invoiceCreatedAt,
          anchorScheduledDate: '2026-09-20',
          siblingScheduledDate: '2026-09-15',
        });
        const first = await backfillFirstApplicationInvoiceStamps(trx);
        const second = await backfillFirstApplicationInvoiceStamps(trx);
        expect(second.stamped).toBe(first.stamped);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
        expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
      }));
    });
  });
});
