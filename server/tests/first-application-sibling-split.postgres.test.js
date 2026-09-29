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
    loadCandidateInvoiceIdPage,
    loadSweepBatchInvoiceIds,
  } = require('../services/first-application-sibling-split');
  const { stampCombinedFirstApplicationInvoiceCoverage } = require('../services/estimate-converter');
  const { backfillFirstApplicationInvoiceStamps } = require('../services/estimate-first-application-invoice');

  beforeAll(() => { db = require('knex')({ client: 'pg', connection: testUrl }); });
  afterAll(async () => { await db?.destroy(); await require('../models/db').destroy(); });

  async function rollbackTest(fn) {
    const trx = await db.transaction();
    try { await fn(trx); } finally { await trx.rollback(); }
  }

  const DEDUPE_KEY = (estimateId, stampedInvoiceId, siblingIds) => `first_application_sibling_divergence:${estimateId}:${stampedInvoiceId}:${[...siblingIds].map(String).sort().join(',')}`;
  // P1-C: the paid_never_ran alert's dedupeKey carries a 'refund:' marker
  // right after the stamped-invoice prefix, distinct from the ordinary
  // DEDUPE_KEY above, so the two alert kinds never collide for the same
  // member set (see evaluateEstimateCandidates in the service module).
  const REFUND_DEDUPE_KEY = (estimateId, stampedInvoiceId, siblingIds) => `first_application_sibling_divergence:${estimateId}:${stampedInvoiceId}:refund:${[...siblingIds].map(String).sort().join(',')}`;
  // Codex round 14 P1: the ACH-still-settling ('processing') variant carries
  // its own 'pending:' marker.
  const PENDING_DEDUPE_KEY = (estimateId, stampedInvoiceId, siblingIds) => `first_application_sibling_divergence:${estimateId}:${stampedInvoiceId}:pending:${[...siblingIds].map(String).sort().join(',')}`;
  const metaOf = (bell) => (typeof bell.metadata === 'string' ? JSON.parse(bell.metadata) : bell.metadata);

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

    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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

    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
    const bells = await trx('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
    expect(bells).toHaveLength(1);
  }));

  test('realigned on a later tick — the standing alert is auto-cleared (marked read)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
  // Codex round 21 P2: raiseDivergenceAlert's own dedupeKey advisory lock is
  // purely cooperative — it only excludes another caller that takes the
  // SAME advisory lock, and markReadAdmin (an office dismissal) never does.
  // Before the fix, raiseDivergenceAlert read the existing notification row
  // with a plain SELECT, so a dismissal landing between THAT READ and
  // notifyAdmin's refresh write (inside notification-service.js's
  // dedupeAndInsert) could be silently undone: the refresh's unconditional
  // read_at:null overwrote the dismissal's read_at, and the alert
  // "resurrected" even though the office had just dismissed it. The
  // vulnerable window is the gap between raiseDivergenceAlert's own read
  // and the moment notifyAdmin's UPDATE actually executes (an UPDATE always
  // takes a row lock the instant it runs, fix or no fix — the fix moves
  // that lock earlier, onto the READ, so nothing can land in between at
  // all). To hit that exact window deterministically (not by timing luck),
  // notifyAdmin itself is spied on to insert a delay BEFORE calling through
  // to the real implementation — landing the delay precisely between
  // raiseDivergenceAlert's read (line ~705) and notifyAdmin's own write.
  // These tests drive TWO genuinely separate sessions — the sweep's own
  // trx-based `db` (this file's own instance) and notification-service's
  // module-level `../models/db` (what markReadAdmin actually writes
  // through) — so the proof is real PostgreSQL row-lock blocking, not a
  // mocked ordering. Fixture rows are inserted and cleaned up by hand: a
  // real race needs both sessions to see already-COMMITTED state, so this
  // suite cannot run inside rollbackTest's single shared transaction.
  // ---------------------------------------------------------------------
  // markReadAdmin writes through notification-service's module-level db,
  // configured from DATABASE_URL, so these run only when that IS the fixture
  // database — otherwise the dismissal would target another database
  // (Codex r1 P2 on #5226).
  const describeSameDb = process.env.DATABASE_URL === testUrl ? describe : describe.skip;
  describeSameDb('raiseDivergenceAlert refresh vs. a concurrent dismissal (Codex round 21 P2)', () => {
    const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const notificationService = require('../services/notification-service');
    const { markReadAdmin } = notificationService;

    async function cleanupFixture(ids) {
      await db('notifications').whereRaw("metadata->>'dedupeKey' LIKE ?", [`first_application_sibling_divergence:${ids.estimateId}:%`]).del();
      // scheduled_services references estimates (no cascade there), so it
      // must go first; scheduled_services and invoices both cascade off
      // customers, but estimates does not, so it's deleted explicitly too.
      await db('scheduled_services').whereIn('id', [ids.pestId, ids.lawnId]).del();
      await db('estimates').where({ id: ids.estimateId }).del();
      await db('customers').where({ id: ids.customerId }).del(); // cascades invoices
    }

    test('a dismissal landing between raiseDivergenceAlert\'s read and notifyAdmin\'s write is not undone by the refresh', async () => {
      const ids = await fixture(db); // committed, real rows — not rolled back
      const realNotifyAdmin = notificationService.notifyAdmin.bind(notificationService);
      // Delays ONLY the call raiseDivergenceAlert makes into notifyAdmin —
      // landing squarely between its own read of `existing` and notifyAdmin's
      // actual dedupe read + write, which is exactly the window Codex found.
      // raiseDivergenceAlert calls notifyAdmin only AFTER its FOR UPDATE read,
      // so reaching the spy means the row lock is held: the dismissal starts
      // on that signal, never on elapsed time (Codex r1 P2 on #5226). The
      // first tick below is a fresh insert and also passes through here, so
      // only the refresh tick's call is armed.
      let armed = false;
      let signalLockHeld;
      const lockHeld = new Promise((resolve) => { signalLockHeld = resolve; });
      const spy = jest.spyOn(notificationService, 'notifyAdmin').mockImplementation(async (...args) => {
        if (!armed) return realNotifyAdmin(...args);
        signalLockHeld();
        await sleep(300);
        return realNotifyAdmin(...args);
      });
      try {
        // First tick: the sibling moves to a different day — raises the
        // ordinary "split it by hand" alert. (Runs before the spy matters —
        // this is a fresh insert, not a refresh.)
        await db('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
        await sweepOnce(db, ids.estimateId);
        const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
        const initial = await readBell(db, dedupeKey);
        expect(initial.read_at).toBeNull();

        // The sibling ALSO goes never-ran — same dedupeKey (same diverging
        // member), but genuinely different copy/fingerprint, so the next
        // tick's raiseDivergenceAlert call is a REFRESH of this exact row,
        // not a fresh insert.
        await db('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });

        // Session A: the sweep's refresh tick. raiseDivergenceAlert's own
        // read happens almost immediately; the mocked 300ms delay then sits
        // between that read and notifyAdmin's actual write, all inside this
        // one open transaction.
        armed = true;
        const refreshDone = db.transaction((trx) => sweepOnce(trx, ids.estimateId));

        // Session B: a genuinely separate connection (notification-service's
        // own db module) — the office dismissing the SAME bell — starts
        // once session A's read has certainly already happened, and races
        // the still-open refresh transaction.
        const dismissDone = (async () => {
          await lockHeld;
          const startedAt = Date.now();
          await markReadAdmin(initial.id);
          return Date.now() - startedAt;
        })();

        const [[refreshResult], dismissMs] = await Promise.all([refreshDone, dismissDone]);
        expect(refreshResult.action).toBe('alerted');

        // The dismissal must have genuinely WAITED on session A's row lock
        // rather than applying instantly — proof this is real row-lock
        // blocking, not a coincidence of timing (an unlocked dismiss here
        // would complete in a few ms, well under 100).
        expect(dismissMs).toBeGreaterThan(150);

        // The last action to actually commit — the dismissal, which only
        // unblocks and re-applies AFTER session A's refresh commits — must
        // be what the row ends up holding. Never read_at:null (the
        // refresh's own unconditional write) silently overwriting it.
        const final = await readBell(db, dedupeKey);
        expect(final.id).toBe(initial.id);
        expect(final.read_at).not.toBeNull();
      } finally {
        spy.mockRestore();
        await cleanupFixture(ids);
      }
    });

    test('a dismissal that fully precedes the refresh is visible to it — refresh still resurfaces a genuinely changed alert', async () => {
      // Sequential (not racing): the dismissal FULLY commits, and only then
      // does the refresh evaluate — this is the pre-existing, legitimate
      // "content genuinely changed since the human dismissed it" resurface
      // behavior (unrelated to the race), which the round-21 P2 fix must
      // not disturb.
      const ids = await fixture(db);
      try {
        await db('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
        await sweepOnce(db, ids.estimateId);
        const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
        const initial = await readBell(db, dedupeKey);

        await markReadAdmin(initial.id);
        expect((await readBell(db, dedupeKey)).read_at).not.toBeNull();

        await db('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
        const [result] = await sweepOnce(db, ids.estimateId);
        expect(result.action).toBe('alerted');

        const final = await readBell(db, dedupeKey);
        expect(final.read_at).toBeNull();
      } finally {
        await cleanupFixture(ids);
      }
    });
  });

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
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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

      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      const cleared = await readBell(trx, dedupeKey);
      expect(cleared.read_at).not.toBeNull();
    }));

    // Codex round-9 P1 removed TEXT recognition from the governing choice;
    // Codex r18 P1 requires DURABLE evidence instead: a live anchor invoice
    // governs (and can carry refund instructions) only when a positive line
    // bills the base application (client_id `scheduled_<id>_primary`, which
    // every service mint writes). An unrelated hand invoice — a repair — that
    // merely shares the anchor's row never becomes "the combined invoice".
    test('void + an unrelated hand invoice on the anchor (no base-application line) → the voided stamped invoice still governs → cleared as settled', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'Sprinkler head repair', notes: 'One-off hand invoice, unrelated to the estimate.',
        line_items: JSON.stringify([{ description: 'Repair', quantity: 1, unit_price: 45, amount: 45 }]),
        subtotal: 45, total: 45,
      });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
    }));

    test('void + a RENAMED replacement on the anchor that carries a base-application line → governs and alerts, naming that invoice', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = randomUUID();
      await trx('invoices').insert({
        id: replacementId, customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'Custom title', notes: 'Edited by the office.',
        line_items: JSON.stringify([{ client_id: `scheduled_${ids.pestId}_primary`, description: 'Quarterly Pest Control', quantity: 1, unit_price: 153.6, amount: 153.6 }]),
        subtotal: 153.6, total: 153.6,
      });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
      const bell = await readBell(trx, dedupeKey);
      expect(bell.read_at).toBeNull();
      expect(bell.link).toBe(`/admin/invoices?invoice=${replacementId}`);
      const metadata = typeof bell.metadata === 'string' ? JSON.parse(bell.metadata) : bell.metadata;
      expect(metadata.invoiceId).toBe(replacementId);
      expect(metadata.stampedInvoiceId).toBe(ids.invoiceId);
      expect(bell.body).toMatch(/charge now sits on invoice/i);
    }));

    test('a dismissed alert reopens once the split invoice is voided and a recognized replacement is reissued', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);

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
      const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);

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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
        line_items: JSON.stringify([{ client_id: `scheduled_${lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 80, amount: 80 }]),
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
    const dedupeKey = DEDUPE_KEY(estimateId, anchorInvoiceId, [bId, cId]);
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
      line_items: JSON.stringify([{ client_id: `scheduled_${bId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
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
    const newDedupeKey = DEDUPE_KEY(estimateId, anchorInvoiceId, [cId]);
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
    const dedupeKey = DEDUPE_KEY(estimateId, anchorInvoiceId, [bId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office splits B: prices it and mints its own live invoice. C never
    // moved, so the group is now genuinely, fully resolved.
    await trx('scheduled_services').where({ id: bId }).update({ estimated_price: 60 });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: customerId, scheduled_service_id: bId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ client_id: `scheduled_${bId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
      subtotal: 60, total: 60,
    });

    const [result] = await sweepOnce(trx, estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('split_completed');

    const cleared = await readBell(trx, dedupeKey);
    expect(cleared.read_at).not.toBeNull();

    // No NEW alert about C was ever raised.
    const cDedupeKey = DEDUPE_KEY(estimateId, anchorInvoiceId, [cId]);
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

  // Two SEPARATE stamped combined-invoice groups under the SAME estimate —
  // two acceptances of the estimate on different dates, each minting its
  // own combined first-application invoice for its own reserved
  // pest+lawn pair. Codex round-12 P1: the dedupe prefix used to be
  // estimate-wide (`first_application_sibling_divergence:${estimateId}:`),
  // so evaluating one group's clear-standing-alerts-before-raise (or any
  // settle/realign/not_a_pair/invoice_missing/no_anchor clear) wiped out
  // the OTHER group's still-valid standing alert. The prefix is now scoped
  // to the group's own fixed stamped-invoice id, so each group's alert
  // lives under its own prefix and can never step on the other's.
  describe('two stamped groups under one estimate', () => {
    async function mintGroup(trx, { customerId, estimateId, day }) {
      const anchorId = randomUUID();
      const siblingId = randomUUID();
      await trx('scheduled_services').insert([
        {
          id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: day,
          service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 150,
        },
        {
          id: siblingId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: day,
          service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null,
        },
      ]);
      const invoiceId = randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'First Service Application',
        notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 150, amount: 150 }]),
        subtotal: 150, total: 150,
      });
      await trx('scheduled_services').whereIn('id', [anchorId, siblingId]).update({ first_application_invoice_id: invoiceId });
      return {
        anchorId, siblingId, invoiceId,
      };
    }

    // Evaluates exactly ONE invoice's group directly — unlike sweepOnce
    // (which finds the FIRST group matching an estimate), this lets a test
    // drive two same-estimate groups in a chosen order.
    async function evaluateInvoiceGroup(trx, invoiceId) {
      const candidates = await loadCandidates(trx);
      const groups = groupCandidatesByInvoice(candidates);
      const group = groups.find((g) => String(g[0].invoice_id) === String(invoiceId));
      return evaluateEstimateCandidates(trx, group);
    }

    async function twoDivergingGroups(trx) {
      const customerId = randomUUID();
      const estimateId = randomUUID();
      await trx('customers').insert({
        id: customerId, first_name: 'Synthetic two-group fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
      });
      await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
      const groupA = await mintGroup(trx, { customerId, estimateId, day: '2026-10-01' });
      const groupB = await mintGroup(trx, { customerId, estimateId, day: '2026-11-01' });
      await trx('scheduled_services').where({ id: groupA.siblingId }).update({ scheduled_date: '2026-10-02' });
      await trx('scheduled_services').where({ id: groupB.siblingId }).update({ scheduled_date: '2026-11-02' });
      return {
        estimateId, groupA, groupB,
      };
    }

    test('both diverging groups raise their own standing alert, evaluated A then B', () => rollbackTest(async (trx) => {
      const { estimateId, groupA, groupB } = await twoDivergingGroups(trx);
      const resultA = await evaluateInvoiceGroup(trx, groupA.invoiceId);
      const resultB = await evaluateInvoiceGroup(trx, groupB.invoiceId);
      expect(resultA.action).toBe('alerted');
      expect(resultB.action).toBe('alerted');

      const keyA = DEDUPE_KEY(estimateId, groupA.invoiceId, [groupA.siblingId]);
      const keyB = DEDUPE_KEY(estimateId, groupB.invoiceId, [groupB.siblingId]);
      expect(keyA).not.toBe(keyB);
      const [bellA, bellB] = await Promise.all([readBell(trx, keyA), readBell(trx, keyB)]);
      expect(bellA).toBeTruthy();
      expect(bellA.read_at).toBeNull();
      expect(bellB).toBeTruthy();
      expect(bellB.read_at).toBeNull();
    }));

    test('both diverging groups raise their own standing alert, evaluated B then A (order-independent)', () => rollbackTest(async (trx) => {
      const { estimateId, groupA, groupB } = await twoDivergingGroups(trx);
      const resultB = await evaluateInvoiceGroup(trx, groupB.invoiceId);
      const resultA = await evaluateInvoiceGroup(trx, groupA.invoiceId);
      expect(resultA.action).toBe('alerted');
      expect(resultB.action).toBe('alerted');

      const keyA = DEDUPE_KEY(estimateId, groupA.invoiceId, [groupA.siblingId]);
      const keyB = DEDUPE_KEY(estimateId, groupB.invoiceId, [groupB.siblingId]);
      const [bellA, bellB] = await Promise.all([readBell(trx, keyA), readBell(trx, keyB)]);
      expect(bellA).toBeTruthy();
      expect(bellA.read_at).toBeNull();
      expect(bellB).toBeTruthy();
      expect(bellB.read_at).toBeNull();
    }));

    test('resolving group A clears only A\'s alert — B\'s standing alert survives', () => rollbackTest(async (trx) => {
      const { estimateId, groupA, groupB } = await twoDivergingGroups(trx);
      await evaluateInvoiceGroup(trx, groupA.invoiceId);
      await evaluateInvoiceGroup(trx, groupB.invoiceId);
      const keyA = DEDUPE_KEY(estimateId, groupA.invoiceId, [groupA.siblingId]);
      const keyB = DEDUPE_KEY(estimateId, groupB.invoiceId, [groupB.siblingId]);
      expect((await readBell(trx, keyA)).read_at).toBeNull();
      expect((await readBell(trx, keyB)).read_at).toBeNull();

      // Realign group A's sibling back onto the anchor's date — a genuine
      // resolution for A alone.
      await trx('scheduled_services').where({ id: groupA.siblingId }).update({ scheduled_date: '2026-10-01' });
      const resultA = await evaluateInvoiceGroup(trx, groupA.invoiceId);
      expect(resultA.action).toBe('cleared');

      const [bellA, bellB] = await Promise.all([readBell(trx, keyA), readBell(trx, keyB)]);
      expect(bellA.read_at).not.toBeNull();
      // B was never touched by A's clear-standing-alerts call — its own
      // alert must still be open.
      expect(bellB.read_at).toBeNull();
    }));

    test('dismissing group B\'s alert does not affect group A\'s still-open alert', () => rollbackTest(async (trx) => {
      const { estimateId, groupA, groupB } = await twoDivergingGroups(trx);
      await evaluateInvoiceGroup(trx, groupA.invoiceId);
      await evaluateInvoiceGroup(trx, groupB.invoiceId);
      const keyA = DEDUPE_KEY(estimateId, groupA.invoiceId, [groupA.siblingId]);
      const keyB = DEDUPE_KEY(estimateId, groupB.invoiceId, [groupB.siblingId]);

      // Office dismisses B's bell (read_at set), B is still diverging.
      const bellBBefore = await readBell(trx, keyB);
      await trx('notifications').where({ id: bellBBefore.id }).update({ read_at: new Date() });

      // A re-sweep of A (still diverging, unchanged) must never touch B's
      // dismissal, and A's own alert must stay open/unread.
      const resultA = await evaluateInvoiceGroup(trx, groupA.invoiceId);
      expect(resultA.action).toBe('alerted');
      const [bellA, bellBAfter] = await Promise.all([readBell(trx, keyA), readBell(trx, keyB)]);
      expect(bellA.read_at).toBeNull();
      expect(bellBAfter.read_at).not.toBeNull();
      const bAfterMeta = typeof bellBAfter.metadata === 'string' ? JSON.parse(bellBAfter.metadata) : bellBAfter.metadata;
      expect(bAfterMeta.autoCleared).not.toBe(true);
    }));
  });

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

    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).body).toContain('remove its charge from the combined invoice');
  }));

  test('a dismissed cancelled-sibling alert stays dismissed while unchanged, reopens once the charge is actually moved off', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
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

    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });
    const [resolved] = await sweepOnce(trx, ids.estimateId);
    expect(resolved.action).toBe('cleared');
    expect(resolved.reason).toBe('split_completed');

    const dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
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
      dedupeKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
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
    const cleared = await clearStandingAlerts(trx, `first_application_sibling_divergence:${ids.estimateId}:${ids.invoiceId}:`);
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
  // P1-C (Codex round 13 on PR #5021): a PAID (collected) governing
  // invoice does not clear unconditionally any more — a stamped member
  // that invoice's payment covers, but that will never run (cancelled/
  // skipped/no-show) and has no own live invoice, needs a refund/credit
  // alert. Every test here goes through loadCandidates + evaluateEstimate-
  // Candidates via sweepOnce, so the new loadCandidates OR clause (paid
  // invoice + a never-ran covered member with no own live invoice) is what
  // actually admits the group as a sweep candidate — not just the pure
  // evaluateGroupDivergence predicate (covered separately in
  // first-application-sibling-split.test.js).
  // ---------------------------------------------------------------------
  describe('paid_never_ran (P1-C)', () => {
    test('(a) paid invoice + covered sibling cancelled, no standing alert beforehand → the group IS a candidate and a refund alert is raised', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });

      // The new loadCandidates OR clause is what admits this group — a
      // paid invoice is otherwise excluded (it's in SETTLED_INVOICE_STATUSES)
      // and there is no standing alert yet for the recovery clause to match.
      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

      const dedupeKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      const bell = await readBell(trx, dedupeKey);
      expect(bell).toBeTruthy();
      const meta = typeof bell.metadata === 'string' ? JSON.parse(bell.metadata) : bell.metadata;
      expect(meta.stampedInvoiceId).toBe(ids.invoiceId);
      expect(meta.alertKind).toBe('paid_never_ran');
      expect(bell.body.toLowerCase()).toContain('already been paid');
      expect(bell.body.toLowerCase()).toMatch(/refund or credit/);
      expect(bell.body).not.toContain('split it by hand');
    }));

    test('(b) paid invoice + every member still active or completed → not a sweep candidate, no alert raised', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'completed', completed_at: new Date() });

      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(false);

      const result = await sweepOnce(trx, ids.estimateId);
      expect(result).toEqual([]);
      const dedupeKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      expect(await readBell(trx, dedupeKey)).toBeUndefined();
    }));

    test('(c) a dismissed refund alert stays dismissed while the state is unchanged', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      const original = await readBell(trx, dedupeKey);
      expect(original.read_at).toBeNull();
      await trx('notifications').where({ id: original.id }).update({ read_at: new Date() });

      const [unchanged] = await sweepOnce(trx, ids.estimateId);
      expect(unchanged.action).toBe('alerted');
      const bell = await readBell(trx, dedupeKey);
      expect(bell.read_at).not.toBeNull();
      // Still the SAME dismissal timestamp/row — a human dismissal on
      // unchanged state is never reopened.
      expect(bell.id).toBe(original.id);
    }));

    test('(d) reactivating the cancelled member (back to confirmed) auto-clears the refund alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'confirmed' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      const cleared = await readBell(trx, dedupeKey);
      expect(cleared.read_at).not.toBeNull();
      const clearedMeta = typeof cleared.metadata === 'string' ? JSON.parse(cleared.metadata) : cleared.metadata;
      expect(clearedMeta.autoCleared).toBe(true);
    }));

    test('(e) the paid invoice becomes refunded → next sweep auto-clears the refund alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      await sweepOnce(trx, ids.estimateId);
      const dedupeKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'refunded' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect((await readBell(trx, dedupeKey)).read_at).not.toBeNull();
    }));

    test('(f) the ordinary diverging alert and the refund alert use DIFFERENT dedupeKeys for the same member — paying the invoice raises the refund alert under its own key and clears the ordinary one', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx); // open (draft) invoice by default
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      const [first] = await sweepOnce(trx, ids.estimateId);
      expect(first.action).toBe('alerted');

      const ordinaryKey = DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      const refundKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      expect(ordinaryKey).not.toBe(refundKey);
      const ordinaryBell = await readBell(trx, ordinaryKey);
      expect(ordinaryBell).toBeTruthy();
      expect(ordinaryBell.read_at).toBeNull();
      expect(await readBell(trx, refundKey)).toBeUndefined();

      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid' });
      const [second] = await sweepOnce(trx, ids.estimateId);
      expect(second.action).toBe('alerted');

      const refundBell = await readBell(trx, refundKey);
      expect(refundBell).toBeTruthy();
      expect(refundBell.read_at).toBeNull();
      const staleOrdinaryBell = await readBell(trx, ordinaryKey);
      expect(staleOrdinaryBell.read_at).not.toBeNull();
      const staleMeta = typeof staleOrdinaryBell.metadata === 'string' ? JSON.parse(staleOrdinaryBell.metadata) : staleOrdinaryBell.metadata;
      expect(staleMeta.autoCleared).toBe(true);
    }));

    test.each(['skipped', 'no_show'])('(g) paid invoice + a %s covered member behaves like cancelled — alert raised under the refund key', (status) => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      const dedupeKey = REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]);
      const bell = await readBell(trx, dedupeKey);
      expect(bell).toBeTruthy();
      expect(bell.body.toLowerCase()).toMatch(/refund or credit/);
    }));
  });

  // ---------------------------------------------------------------------
  // Codex round 14 P1: 'processing' (an ACH debit still in flight) is not
  // collected money — a never-ran covered member gets a "wait for the payment
  // to settle" alert under its own dedupe marker, never refund/credit copy.
  // ---------------------------------------------------------------------
  describe('payment_pending_never_ran (processing)', () => {
    async function pendingFixture(trx) {
      const ids = await fixture(trx, { invoiceStatus: 'processing' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      return ids;
    }

    test('processing + a cancelled covered member → candidate, pending alert with wait-for-settlement copy', () => rollbackTest(async (trx) => {
      const ids = await pendingFixture(trx);
      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result).toEqual({ estimateId: ids.estimateId, action: 'alerted', divergingSiblingIds: [ids.lawnId] });
      const bell = await readBell(trx, PENDING_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(bell.read_at).toBeNull();
      expect(metaOf(bell).alertKind).toBe('payment_pending_never_ran');
      expect(bell.title).toMatch(/payment still processing/);
      expect(bell.body).toContain('still processing');
      expect(bell.body).not.toMatch(/\bACH\b/);
      expect(bell.body).toMatch(/Wait for that payment to settle, fail, or be reconciled/);
      expect(bell.body).not.toMatch(/refund or credit/);
      expect(bell.body).not.toContain('already been paid');
      expect(await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).toBeUndefined();
    }));

    test('processing → paid: the pending alert auto-clears and the refund alert takes over', () => rollbackTest(async (trx) => {
      const ids = await pendingFixture(trx);
      await sweepOnce(trx, ids.estimateId);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'paid' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      const pending = await readBell(trx, PENDING_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(pending.read_at).not.toBeNull();
      expect(metaOf(pending).autoCleared).toBe(true);
      const refund = await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(refund.read_at).toBeNull();
      expect(refund.body).toMatch(/refund or credit/);
    }));

    test.each(['refunded', 'void'])('processing → %s: the pending alert auto-clears', (status) => rollbackTest(async (trx) => {
      const ids = await pendingFixture(trx);
      await sweepOnce(trx, ids.estimateId);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      const pending = await readBell(trx, PENDING_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(metaOf(pending).autoCleared).toBe(true);
    }));

    test('the cancelled member is reactivated while processing → the pending alert auto-clears', () => rollbackTest(async (trx) => {
      const ids = await pendingFixture(trx);
      await sweepOnce(trx, ids.estimateId);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'confirmed' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      const pending = await readBell(trx, PENDING_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(metaOf(pending).autoCleared).toBe(true);
    }));

    test('a bounced ACH (back to sent) → the pending alert clears and the ordinary remove-the-charge alert opens', () => rollbackTest(async (trx) => {
      const ids = await pendingFixture(trx);
      await sweepOnce(trx, ids.estimateId);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'sent' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(metaOf(await readBell(trx, PENDING_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).autoCleared).toBe(true);
      const ordinary = await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(ordinary.read_at).toBeNull();
      expect(ordinary.body).toContain('remove that charge');
    }));

    test('processing + a cancelled ANCHOR → pending alert naming the anchor', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'processing' });
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.divergingSiblingIds).toEqual([ids.pestId]);
      expect(await readBell(trx, PENDING_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]))).toBeTruthy();
    }));
  });

  // ---------------------------------------------------------------------
  // Codex round 14 P1: a cancelled PAID anchor. The combined invoice bills
  // the anchor's own share too, and sits on the anchor's own
  // scheduled_service_id — so "has its own live invoice" must never count the
  // combined invoice itself, and a separate live invoice on the anchor is not
  // evidence the combined charge moved.
  // ---------------------------------------------------------------------
  describe('paid combined invoice + never-ran ANCHOR', () => {
    test('paid + anchor cancelled (sibling active) → candidate, refund alert naming the anchor', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result).toEqual({ estimateId: ids.estimateId, action: 'alerted', divergingSiblingIds: [ids.pestId] });
      const bell = await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]));
      expect(bell.read_at).toBeNull();
      expect(bell.body).toContain(`visit ${ids.pestId} was cancelled — refund or credit its share of the already-paid invoice`);
    }));

    test('paid + anchor cancelled + a genuinely separate live invoice on the anchor → still alerts (the combined charge never moved)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'Repair charge', notes: 'A one-off hand invoice.',
        line_items: JSON.stringify([{ description: 'Repair', quantity: 1, unit_price: 40, amount: 40 }]),
        subtotal: 40, total: 40,
      });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.pestId]);
      const bell = await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]));
      expect(bell.link).toBe(`/admin/invoices?invoice=${ids.invoiceId}`);
    }));

    test('paid + anchor AND sibling cancelled → one refund alert naming both', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').whereIn('id', [ids.pestId, ids.lawnId]).update({ status: 'cancelled' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.divergingSiblingIds).toEqual([ids.pestId, ids.lawnId].map(String).sort());
      expect(await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId, ids.lawnId]))).toBeTruthy();
    }));

    test('the paid invoice is refunded → the anchor refund alert auto-clears', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      await sweepOnce(trx, ids.estimateId);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'refunded' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(metaOf(await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]))).autoCleared).toBe(true);
    }));
  });

  // ---------------------------------------------------------------------
  // Codex round 19 P2: voidOpenInvoicesForCancelledService (job-status.js)
  // is fired-and-forget off the anchor's own cancel/skip/no-show — when
  // that void fails (or simply hasn't landed yet), a still-OPEN combined
  // invoice keeps charging for an anchor that will never run.
  // neverRanCoveredMembers now includes the anchor for the OPEN-invoice
  // verdict the same way it already did for paid/processing, so this shape
  // raises (or keeps) the alert instead of reading the group as realigned
  // and silently clearing it.
  // ---------------------------------------------------------------------
  describe('open combined invoice + never-ran ANCHOR (Codex round 19 P2)', () => {
    test('open invoice + anchor cancelled (sibling active) → candidate, alert naming the anchor', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx); // default invoiceStatus: 'draft' — still open
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      const candidates = await loadCandidates(trx);
      expect(candidates.some((c) => String(c.source_estimate_id) === String(ids.estimateId))).toBe(true);

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result).toEqual({ estimateId: ids.estimateId, action: 'alerted', divergingSiblingIds: [ids.pestId] });
      const bell = await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]));
      expect(bell.read_at).toBeNull();
      expect(bell.body).toContain(`visit ${ids.pestId} was cancelled — remove its charge from the combined invoice`);
      expect(bell.body).toContain('still charges for it — remove that charge.');
    }));

    test.each(['skipped', 'no_show'])('open invoice + a %s anchor behaves exactly like cancelled — alert raised', (status) => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.pestId]);
      expect(await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]))).toBeTruthy();
    }));

    test('open invoice + anchor cancelled + a genuinely separate live invoice on the anchor → still alerts (the combined charge never moved)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'Repair charge', notes: 'A one-off hand invoice.',
        line_items: JSON.stringify([{ description: 'Repair', quantity: 1, unit_price: 40, amount: 40 }]),
        subtotal: 40, total: 40,
      });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(result.divergingSiblingIds).toEqual([ids.pestId]);
      const bell = await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]));
      expect(bell.link).toBe(`/admin/invoices?invoice=${ids.invoiceId}`);
    }));

    test('open invoice + anchor AND sibling cancelled → one alert naming both', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').whereIn('id', [ids.pestId, ids.lawnId]).update({ status: 'cancelled' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.divergingSiblingIds).toEqual([ids.pestId, ids.lawnId].map(String).sort());
      expect(await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId, ids.lawnId]))).toBeTruthy();
    }));

    test('the anchor is reactivated → the alert auto-clears (the only resolution while the invoice stays open)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      await sweepOnce(trx, ids.estimateId);
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'confirmed' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(metaOf(await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]))).autoCleared).toBe(true);
    }));

    test('the open invoice is voided (the void that should have fired eventually lands) → the alert auto-clears', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.pestId }).update({ status: 'cancelled' });
      await sweepOnce(trx, ids.estimateId);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('invoice_settled');
      expect(metaOf(await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.pestId]))).autoCleared).toBe(true);
    }));
  });

  // ---------------------------------------------------------------------
  // Codex round 14 P1: with the stamped invoice terminal, the governing
  // invoice is the OLDEST still-collectible live invoice on the anchor — a
  // newer, unrelated, already-paid invoice on the same visit must not hide it.
  // ---------------------------------------------------------------------
  describe('several live invoices on a terminal-stamped anchor', () => {
    async function anchorInvoice(trx, ids, { status, createdAt, title = 'First Service Application' }) {
      const id = randomUUID();
      await trx('invoices').insert({
        id, customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status, title, notes: 'Synthetic anchor invoice.',
        line_items: JSON.stringify([{ description: title, quantity: 1, unit_price: 90, amount: 90 }]),
        subtotal: 90, total: 90, created_at: createdAt,
      });
      return id;
    }

    test('older SENT replacement + newer PAID unrelated invoice → the alert stays and names the older invoice', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-09' });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const olderSent = await anchorInvoice(trx, ids, { status: 'sent', createdAt: new Date('2026-09-02T10:00:00Z') });
      await anchorInvoice(trx, ids, { status: 'paid', createdAt: new Date('2026-09-05T10:00:00Z'), title: 'Repair charge' });

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      const bell = await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(bell.link).toBe(`/admin/invoices?invoice=${olderSent}`);
      expect(metaOf(bell).invoiceId).toBe(olderSent);
    }));

    test('older PAID replacement + newer SENT invoice → the newer collectible one governs', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-09' });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      await anchorInvoice(trx, ids, { status: 'paid', createdAt: new Date('2026-09-02T10:00:00Z') });
      const newerSent = await anchorInvoice(trx, ids, { status: 'sent', createdAt: new Date('2026-09-05T10:00:00Z') });

      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      const bell = await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(metaOf(bell).invoiceId).toBe(newerSent);
    }));

    test('every live anchor invoice settled → the newest settled governs and a merely-diverged pair clears', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-09' });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      await anchorInvoice(trx, ids, { status: 'paid', createdAt: new Date('2026-09-02T10:00:00Z') });
      await anchorInvoice(trx, ids, { status: 'paid', createdAt: new Date('2026-09-05T10:00:00Z') });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result).toMatchObject({ action: 'cleared', reason: 'invoice_settled' });
    }));
  });

  // ---------------------------------------------------------------------
  // The structural fix (Codex round 14 P1, "keep paid divergent visits under
  // billing review"): the shared lookup completion and Charge Now use finds
  // the combined invoice by the member's STAMP, so a covered sibling that
  // moved to another day still sees the (paid) combined invoice and never
  // mints a second charge. This is what makes clearing a paid,
  // merely-diverged group safe.
  // ---------------------------------------------------------------------
  describe('findFirstApplicationInvoiceForEstimateService honours the stamp', () => {
    const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');

    test('paid combined invoice, sibling moved to a later day → the lookup on the sibling returns that paid invoice', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-20' });
      const sibling = await trx('scheduled_services').where({ id: ids.lawnId }).first();
      const found = await findFirstApplicationInvoiceForEstimateService(sibling, trx);
      expect(found.invoice?.id).toBe(ids.invoiceId);
      expect(found.invoice.status).toBe('paid');
      expect(found.liveBeside).toBeNull();

      // lockRows / noWait take the same row lock on the widened query.
      const locked = await findFirstApplicationInvoiceForEstimateService(sibling, trx, { lockRows: true, noWait: true });
      expect(locked.invoice?.id).toBe(ids.invoiceId);
    }));

    test('a narrow svc (no stamp column) reads the stamp by id and still finds it', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-20' });
      const narrow = await trx('scheduled_services').where({ id: ids.lawnId })
        .first('id', 'customer_id', 'source_estimate_id', 'scheduled_date');
      expect(narrow.first_application_invoice_id).toBeUndefined();
      const found = await findFirstApplicationInvoiceForEstimateService(narrow, trx);
      expect(found.invoice?.id).toBe(ids.invoiceId);
    }));

    test('the stamped invoice with edited (unrecognizable) text is still found by the stamp', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { matchInvoiceText: false });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-20' });
      const sibling = await trx('scheduled_services').where({ id: ids.lawnId }).first();
      expect((await findFirstApplicationInvoiceForEstimateService(sibling, trx)).invoice?.id).toBe(ids.invoiceId);
    }));

    test('stamped invoice voided + recognized live replacement on the anchor, sibling moved → the replacement is returned', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-20' });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = randomUUID();
      await trx('invoices').insert({
        id: replacementId, customer_id: ids.customerId, scheduled_service_id: ids.pestId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'First Service Application',
        notes: `Auto-generated from accepted estimate #${ids.estimateId}. Customer selected pay per application — first application only.`,
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 153.6, amount: 153.6 }]),
        subtotal: 153.6, total: 153.6,
      });
      const sibling = await trx('scheduled_services').where({ id: ids.lawnId }).first();
      const found = await findFirstApplicationInvoiceForEstimateService(sibling, trx);
      expect(found).toEqual({ invoice: expect.objectContaining({ id: replacementId, status: 'sent' }), liveBeside: null });
    }));

    test('an UNSTAMPED moved sibling keeps today\'s date-only behaviour (no match off-date)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid', stamp: false });
      const aligned = await trx('scheduled_services').where({ id: ids.lawnId }).first();
      expect((await findFirstApplicationInvoiceForEstimateService(aligned, trx)).invoice?.id).toBe(ids.invoiceId);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-20' });
      const moved = await trx('scheduled_services').where({ id: ids.lawnId }).first();
      expect(await findFirstApplicationInvoiceForEstimateService(moved, trx)).toEqual({ invoice: null, liveBeside: null });
    }));
  });

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

    async function mintInvoice(trx, { invoiceId, customerId, anchorId, amount = 200 }) {
      await trx('invoices').insert({
        id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'First Service Application', notes: 'n/a',
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: amount, amount }]),
        subtotal: amount, total: amount,
      });
    }

    // Codex round-12 P2: memberIds is now the caller's OWN authoritative
    // promoted-ids list — never a same-day reconstruction. A pre-existing
    // same-day top-level recurring row that is NOT in memberIds (a
    // separately accepted or already-priced program that merely shares the
    // date) must never be swept up into the stamp any more.
    test('stamps the anchor + every id in memberIds, and leaves an un-listed same-day bystander untouched', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-pair');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const siblingId = await seedProgram(trx, { customerId, estimateId });
      // A pre-existing same-day top-level recurring row from some OTHER
      // acceptance — same customer/estimate/date, but never passed in
      // memberIds. Regression coverage for the exact P2 bug: the old
      // same-date reconstruction would have swept this in too.
      const bystanderId = await seedProgram(trx, { customerId, estimateId });
      const invoiceId = randomUUID();
      await mintInvoice(trx, { invoiceId, customerId, anchorId });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId, memberIds: [siblingId] });

      const [anchor, sibling, bystander] = await Promise.all([
        trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: siblingId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: bystanderId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBe(invoiceId);
      expect(sibling.first_application_invoice_id).toBe(invoiceId);
      expect(bystander.first_application_invoice_id).toBeNull();
    }));

    test('no memberIds (single-program accept) leaves the column NULL', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-solo');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 99 });
      const invoiceId = randomUUID();
      await mintInvoice(trx, {
        invoiceId, customerId, anchorId, amount: 99,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId });

      const anchor = await trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id');
      expect(anchor.first_application_invoice_id).toBeNull();
    }));

    test('an empty memberIds array is the same as none — never stamped', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-empty');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 99 });
      const invoiceId = randomUUID();
      await mintInvoice(trx, {
        invoiceId, customerId, anchorId, amount: 99,
      });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId, memberIds: [] });

      const anchor = await trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id');
      expect(anchor.first_application_invoice_id).toBeNull();
    }));

    test('a CHILD occurrence (recurring_parent_id set) passed in memberIds is NOT stamped', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-child');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const siblingParentId = await seedProgram(trx, { customerId, estimateId });
      const childId = await seedProgram(trx, { customerId, estimateId, recurringParentId: siblingParentId });
      const invoiceId = randomUUID();
      await mintInvoice(trx, { invoiceId, customerId, anchorId });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, {
        invoiceId, anchorId, memberIds: [siblingParentId, childId],
      });

      const [siblingParent, child] = await Promise.all([
        trx('scheduled_services').where({ id: siblingParentId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: childId }).first('first_application_invoice_id'),
      ]);
      expect(siblingParent.first_application_invoice_id).toBe(invoiceId);
      expect(child.first_application_invoice_id).toBeNull();
    }));

    test('a non-recurring one-time row passed in memberIds is NOT stamped (and, alone, never justifies a pair)', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-onetime');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const oneTimeId = await seedProgram(trx, { customerId, estimateId, isRecurring: false, estimatedPrice: 75 });
      const invoiceId = randomUUID();
      await mintInvoice(trx, { invoiceId, customerId, anchorId });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, { invoiceId, anchorId, memberIds: [oneTimeId] });

      const [anchor, oneTime] = await Promise.all([
        trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: oneTimeId }).first('first_application_invoice_id'),
      ]);
      // The one-time row alone never qualifies as "the sibling that
      // justifies a pair" — the anchor itself is therefore left unstamped
      // too (single-program-equivalent: no VERIFIED recurring sibling
      // exists once the bad id is thrown out).
      expect(anchor.first_application_invoice_id).toBeNull();
      expect(oneTime.first_application_invoice_id).toBeNull();
    }));

    // Codex round-12 P2: a bad id passed by a caller can never stamp an
    // unrelated row — every memberId is independently re-verified here,
    // never trusted blindly. A GENUINE sibling in the same call still
    // stamps normally alongside the two rejected ids.
    test('a memberId belonging to another customer/estimate, or already priced, is ignored — a genuine sibling in the same call still stamps', () => rollbackTest(async (trx) => {
      const { customerId, estimateId } = await seedCustomerAndEstimate(trx, 'stamp-mixed');
      const anchorId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 200 });
      const siblingId = await seedProgram(trx, { customerId, estimateId });
      const pricedId = await seedProgram(trx, { customerId, estimateId, estimatedPrice: 60 });
      const { customerId: otherCustomerId, estimateId: otherEstimateId } = await seedCustomerAndEstimate(trx, 'stamp-mixed-other');
      const foreignId = await seedProgram(trx, { customerId: otherCustomerId, estimateId: otherEstimateId });
      const invoiceId = randomUUID();
      await mintInvoice(trx, { invoiceId, customerId, anchorId });

      await stampCombinedFirstApplicationInvoiceCoverage(trx, {
        invoiceId, anchorId, memberIds: [siblingId, pricedId, foreignId],
      });

      const [anchor, sibling, priced, foreign] = await Promise.all([
        trx('scheduled_services').where({ id: anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: siblingId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: pricedId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: foreignId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBe(invoiceId);
      expect(sibling.first_application_invoice_id).toBe(invoiceId);
      expect(priced.first_application_invoice_id).toBeNull();
      expect(foreign.first_application_invoice_id).toBeNull();
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

    // Codex r20 P1: a sibling's CURRENT price is mutable (a staff price edit)
    // and does not shrink or replace the combined invoice — price alone never
    // excludes a member. Only a live invoice of its own that bills the base
    // application (the shared client_id `scheduled_<id>_primary` identity)
    // proves the split, exactly as the live sweep decides it.
    // Codex r20 P1 vs. the pre-push P0 on d8f1c92da1: a PRICED row is never
    // INFERRED into a group (a separately priced program bills itself, and a
    // false stamp would suppress its charge); a covered member priced later
    // by staff is stamped only when the invoice's own line items name it.
    // Codex pre-push P1 on 671efec4fe: pass 1 reads eligibility outside any
    // transaction, so the write re-checks each group under lock. These drive
    // the revalidating stamper directly with state that changed after pass 1.
    describe('stampGroupRevalidated — membership re-checked under lock before the write', () => {
      const { stampGroupRevalidated } = require('../services/estimate-first-application-invoice');
      const stampsOf = async (trx, ids) => Promise.all([ids.anchorId, ids.siblingId].map(
        (id) => trx('scheduled_services').where({ id }).first('first_application_invoice_id').then((r) => r.first_application_invoice_id),
      ));

      test('baseline: an unchanged unpriced pair is stamped', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId] })).toBe(2);
        expect(await stampsOf(trx, ids)).toEqual([ids.invoiceId, ids.invoiceId]);
      }));

      test('a sibling priced after the eligibility read is dropped — nothing stamped', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        await trx('scheduled_services').where({ id: ids.siblingId }).update({ estimated_price: 60 });
        expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId] })).toBe(0);
        expect(await stampsOf(trx, ids)).toEqual([null, null]);
      }));

      test('a sibling that got its own live base-application invoice after the read is dropped', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        await trx('invoices').insert({
          id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.siblingId,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent', title: 'Lawn Care',
          line_items: JSON.stringify([{ client_id: `scheduled_${ids.siblingId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
          subtotal: 60, total: 60,
        });
        expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId] })).toBe(0);
        expect(await stampsOf(trx, ids)).toEqual([null, null]);
      }));

      test('an anchor stamped to ANOTHER invoice after the read stops the whole group — the sibling is never stamped alone', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        const otherInvoiceId = randomUUID();
        await trx('invoices').insert({
          id: otherInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.anchorId,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'void', title: 'Other',
          line_items: JSON.stringify([]), subtotal: 0, total: 0,
        });
        await trx('scheduled_services').where({ id: ids.anchorId }).update({ first_application_invoice_id: otherInvoiceId });
        expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId] })).toBe(0);
        expect(await stampsOf(trx, ids)).toEqual([otherInvoiceId, null]);
      }));

      test('an invoice voided after the read stamps nothing', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
        expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId] })).toBe(0);
        expect(await stampsOf(trx, ids)).toEqual([null, null]);
      }));

      test('an anchor already stamped to THIS invoice extends only on the unbounded run', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        await trx('scheduled_services').where({ id: ids.anchorId }).update({ first_application_invoice_id: ids.invoiceId });
        expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId] })).toBe(0);
        expect(await stampGroupRevalidated(trx, {
          invoiceId: ids.invoiceId, anchorId: ids.anchorId, siblingIds: [ids.siblingId], extendPartialGroups: true,
        })).toBe(1);
        expect(await stampsOf(trx, ids)).toEqual([ids.invoiceId, ids.invoiceId]);
      }));
    });

    test('a priced sibling with no itemized line and no own invoice is NOT inferred — left for hand review', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx, { siblingPriced: true });
      await backfillFirstApplicationInvoiceStamps(trx);
      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBeNull();
      expect(sibling.first_application_invoice_id).toBeNull();
    }));

    test('a priced sibling the invoice itemizes (client_id scheduled_<id>_primary) IS stamped — a later price edit does not un-cover it', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx, { siblingPriced: true });
      await trx('invoices').where({ id: ids.invoiceId }).update({
        line_items: JSON.stringify([
          { client_id: `scheduled_${ids.anchorId}_primary`, description: 'Quarterly Pest Control', quantity: 1, unit_price: 100, amount: 100 },
          { client_id: `scheduled_${ids.siblingId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 },
        ]),
      });
      await backfillFirstApplicationInvoiceStamps(trx);
      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
      expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
    }));

    test('a priced sibling WITH its own live base-application invoice was split off — left out (single-program result, nothing stamped)', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx, { siblingPriced: true });
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.siblingId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent',
        title: 'Lawn Care', notes: 'Split from the combined invoice.',
        line_items: JSON.stringify([{ client_id: `scheduled_${ids.siblingId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
        subtotal: 60, total: 60,
      });
      await backfillFirstApplicationInvoiceStamps(trx);
      const [anchor, sibling] = await Promise.all([
        trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
        trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
      ]);
      expect(anchor.first_application_invoice_id).toBeNull();
      expect(sibling.first_application_invoice_id).toBeNull();
    }));

    // P1-A: idempotence now means "never overwrite, final state unchanged"
    // rather than "recompute and rewrite the same value every time" — once
    // the anchor and sibling are stamped, the NEVER-OVERWRITE guard
    // (first_application_invoice_id IS NULL) excludes both from candidacy
    // on every later run, so a rerun's OWN stamped count is 0 (nothing NEW
    // to stamp) while the DB state it already committed stays exactly as
    // it was.
    test('idempotent — a second run stamps nothing NEW, and the first run\'s stamps are unchanged', () => rollbackTest(async (trx) => {
      const ids = await seedHistoricalPair(trx);
      const first = await backfillFirstApplicationInvoiceStamps(trx);
      expect(first.stamped).toBeGreaterThanOrEqual(2);
      const second = await backfillFirstApplicationInvoiceStamps(trx);
      expect(second.stamped).toBe(0);
      expect(second.ambiguous).toBe(0);
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
    // Shared by 'accept-time created_at window eligibility' below AND the
    // 'P1-A: original-date evidence' describe further down — hoisted to
    // this scope so both can build on the same ordinary (non-reserved)
    // same-instant accept fixture.
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
          line_items: JSON.stringify([{ client_id: `scheduled_${siblingId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
          subtotal: 60, total: 60,
        });
      }
      return {
        customerId, estimateId, anchorId, siblingId, invoiceId,
      };
    }

    describe('accept-time created_at window eligibility', () => {
      // P1-A (Codex round 13): the created_at window ALONE is no longer
      // enough — this pair also needs reschedule_log evidence that the
      // sibling's ORIGINAL date was the anchor's date, since a window
      // match by itself cannot tell a genuine diverged sibling apart from
      // a same-accept row that was never on the anchor's day to begin with
      // (the very next describe block covers that failure mode). See
      // 'P1-A: original-date evidence' below for the reschedule_log-backed
      // version of this exact scenario.
      test('an already-diverged pair created in the SAME accept, but with NO reschedule_log evidence of a shared original date, is NOT stamped', () => rollbackTest(async (trx) => {
        const sharedInstant = new Date('2026-08-01T10:00:03Z'); // within 120s of the anchor's
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: sharedInstant,
          siblingScheduledDate: '2026-11-20', // its ORIGINAL date too — never actually the anchor's day
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
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

      // Codex r20 P1: price alone is not split evidence — within the shared
      // instant and on the anchor's date, a priced row with no
      // base-application invoice of its own is still a covered member (the
      // next test is the real exclusion: an own live base-application invoice).
      // Pre-push P0 on d8f1c92da1: a separately PRICED same-estimate program
      // created in the same window, on the same date, with no own invoice
      // yet, bills itself at completion — inferring it into the group would
      // make the stamp-aware lookup reuse the combined invoice for it and
      // suppress that charge. Never stamped without an itemized line, on the
      // unbounded run AND on the bounded runtime reconciliation.
      test('a separately priced same-accept program with no itemized line is NEVER inferred — unbounded run and bounded reconciliation alike', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-08-01T10:00:03Z'),
          siblingScheduledDate: SAME_DATE,
          siblingEstimatedPrice: 60,
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        let [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
        await trx('invoices').where({ id: ids.invoiceId }).update({ created_at: new Date() });
        await trx('scheduled_services').whereIn('id', [ids.anchorId, ids.siblingId]).update({ created_at: new Date() });
        await backfillFirstApplicationInvoiceStamps(trx, { sinceDays: 14 });
        [anchor, sibling] = await Promise.all([
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

      // P1-A: rerun idempotence for a pair with NO reschedule_log evidence
      // — stays unstamped on every rerun, never flips to stamped later.
      test('rerun is idempotent for an already-diverged pair with no original-date evidence — stays unstamped', () => rollbackTest(async (trx) => {
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
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
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
    // predates both by days. P1-A (Codex round 13) layers the ORIGINAL-date
    // requirement on top of this window: where either row's CURRENT
    // scheduled_date has moved to since no longer matters on its own, but a
    // move now needs a reschedule_log row recording what the ORIGINAL date
    // actually was — anchorOriginalDate below defaults to
    // anchorScheduledDate (no move at all) and a fixture that wants to
    // model a genuine post-accept move passes a different value, which
    // seeds the matching reschedule_log row.
    // -----------------------------------------------------------------
    describe('reserved-anchor evidence: invoice created_at window', () => {
      async function seedReservedAnchorPair(trx, {
        invoiceCreatedAt,
        anchorCreatedAt,
        siblingCreatedAt,
        anchorScheduledDate = SAME_DATE,
        siblingScheduledDate = '2026-11-20',
        anchorOriginalDate = anchorScheduledDate,
        // When the anchor's logged move happened. Defaults to a day AFTER the
        // invoice (a post-accept move, as every test below describes) —
        // Codex round 14 P1 judges each row where it stood at invoice
        // creation, so the move's timing now matters.
        anchorMovedAt = null,
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
        if (anchorOriginalDate !== anchorScheduledDate) {
          // The anchor genuinely moved after accept — record where it stood
          // before that move, so the date-at-invoice evidence can prove this
          // is still the same trip the sibling was created in. (Before Codex
          // round 14 this log row was stamped anchorCreatedAt + 1 day, which
          // is BEFORE the invoice in these fixtures — a pre-accept move that
          // contradicted the tests' own "moved after accept" description and
          // only passed under the old earliest-original-date rule.)
          await trx('reschedule_log').insert({
            id: randomUUID(), scheduled_service_id: anchorId, customer_id: customerId,
            original_date: anchorOriginalDate, new_date: anchorScheduledDate,
            reason_code: 'customer_request', initiated_by: 'admin',
            created_at: anchorMovedAt || new Date(invoiceCreatedAt.getTime() + 86400000),
          });
        }
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

      // (b) from the assignment, updated for P1-A: the reserved-anchor-
      // moved shape still stamps on the created_at window PLUS a
      // reschedule_log row proving the anchor's ORIGINAL date was the
      // shared date — the anchor having moved off the shared date days
      // after accept makes no difference now that its true original date
      // is on record, exactly like a genuinely diverged pair.
      test('reserved anchor created days before the invoice, sibling created at invoice time, anchor later moved off the shared date (reschedule_log-backed) — stamped', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'), // reserved 3 days before accept
          siblingCreatedAt: invoiceCreatedAt, // promoted sibling inserted in the SAME accept transaction as the invoice
          anchorScheduledDate: '2026-09-20', // the anchor's CURRENT date, after moving
          anchorOriginalDate: '2026-09-15', // the anchor's TRUE original date, on record via reschedule_log
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
      // shape (reschedule_log-backed, per the updated (b) above).
      test('rerun is idempotent for the reserved-anchor invoice-created_at window shape', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'),
          siblingCreatedAt: invoiceCreatedAt,
          anchorScheduledDate: '2026-09-20',
          anchorOriginalDate: '2026-09-15',
          siblingScheduledDate: '2026-09-15',
        });
        // P1-A: never-overwrite idempotence — the second run stamps
        // nothing NEW (both rows are already claimed), and the first run's
        // stamps stay exactly as committed.
        const first = await backfillFirstApplicationInvoiceStamps(trx);
        expect(first.stamped).toBeGreaterThanOrEqual(2);
        const second = await backfillFirstApplicationInvoiceStamps(trx);
        expect(second.stamped).toBe(0);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBe(ids.invoiceId);
        expect(sibling.first_application_invoice_id).toBe(ids.invoiceId);
      }));

      // Codex round 14 P1: judge each row where it stood WHEN THE INVOICE WAS
      // MINTED, not where it was first booked. A reserved anchor moved
      // BEFORE acceptance (Oct 1 → Oct 5), then the accept creates the
      // sibling on Oct 5 and mints the invoice; the sibling later diverges.
      test('reserved anchor moved BEFORE accept, sibling created on the moved day and diverged after accept — stamped', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'),
          siblingCreatedAt: invoiceCreatedAt,
          anchorOriginalDate: '2026-10-01',
          anchorScheduledDate: '2026-10-05',
          anchorMovedAt: new Date('2026-08-02T09:00:00Z'), // before the invoice
          siblingScheduledDate: '2026-10-20', // current, diverged after accept
        });
        await trx('reschedule_log').insert({
          id: randomUUID(), scheduled_service_id: ids.siblingId, customer_id: ids.customerId,
          original_date: '2026-10-05', new_date: '2026-10-20',
          reason_code: 'customer_request', initiated_by: 'admin',
          created_at: new Date('2026-08-10T09:00:00Z'),
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

      // The mirror case the old earliest-original-date rule got wrong the
      // other way: the anchor was first booked Oct 1 but moved to Oct 5
      // before accept, and the accept created a row on Oct 1 — never on the
      // anchor's day when the invoice was minted.
      test('a sibling that was never on the anchor\'s day at accept (only on the anchor\'s pre-accept date) — NOT stamped', () => rollbackTest(async (trx) => {
        const invoiceCreatedAt = new Date('2026-08-04T09:00:00Z');
        const ids = await seedReservedAnchorPair(trx, {
          invoiceCreatedAt,
          anchorCreatedAt: new Date('2026-08-01T09:00:00Z'),
          siblingCreatedAt: invoiceCreatedAt,
          anchorOriginalDate: '2026-10-01',
          anchorScheduledDate: '2026-10-05',
          anchorMovedAt: new Date('2026-08-02T09:00:00Z'),
          siblingScheduledDate: '2026-10-01',
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));
    });

    // -----------------------------------------------------------------
    // Codex round 14 P1: the rerun must be able to EXTEND a group the frozen
    // first migration partially stamped (three-program history: anchor +
    // aligned sibling stamped, the moved third member not), while still
    // never overwriting any stamp and never adopting an anchor stamped to a
    // different invoice.
    // -----------------------------------------------------------------
    describe('rerun extends a partially stamped group', () => {
      async function seedThreeProgramGroup(trx) {
        const customerId = randomUUID();
        const estimateId = randomUUID();
        const anchorId = randomUUID();
        const alignedId = randomUUID();
        const movedId = randomUUID();
        const acceptedAt = new Date('2026-08-01T10:00:00Z');
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic three-program fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
        });
        await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
        await trx('scheduled_services').insert([
          {
            id: anchorId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200, created_at: acceptedAt,
          },
          {
            id: alignedId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
            service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: acceptedAt,
          },
          {
            id: movedId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-10-20',
            service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: acceptedAt,
          },
        ]);
        await trx('reschedule_log').insert({
          id: randomUUID(), scheduled_service_id: movedId, customer_id: customerId,
          original_date: SAME_DATE, new_date: '2026-10-20',
          reason_code: 'customer_request', initiated_by: 'admin', created_at: new Date('2026-08-10T10:00:00Z'),
        });
        const invoiceId = randomUUID();
        await trx('invoices').insert({
          id: invoiceId, customer_id: customerId, scheduled_service_id: anchorId,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
          status: 'sent', title: 'First Service Application',
          notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
          line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
          subtotal: 200, total: 200, created_at: acceptedAt,
        });
        return {
          customerId, estimateId, anchorId, alignedId, movedId, invoiceId,
        };
      }
      const stampOf = async (trx, id) => (await trx('scheduled_services').where({ id }).first('first_application_invoice_id')).first_application_invoice_id;

      // `stamped` is database-wide, so each exact-count test first drains
      // anything else the backfill would stamp in this database.
      test('anchor + aligned sibling already stamped → the rerun adds the moved member, leaves existing stamps, counts only the new one', () => rollbackTest(async (trx) => {
        await backfillFirstApplicationInvoiceStamps(trx);
        const ids = await seedThreeProgramGroup(trx);
        // What the frozen first migration left behind.
        await trx('scheduled_services').whereIn('id', [ids.anchorId, ids.alignedId]).update({ first_application_invoice_id: ids.invoiceId });
        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.stamped).toBe(1);
        expect(await stampOf(trx, ids.anchorId)).toBe(ids.invoiceId);
        expect(await stampOf(trx, ids.alignedId)).toBe(ids.invoiceId);
        expect(await stampOf(trx, ids.movedId)).toBe(ids.invoiceId);
        // And a further rerun is a no-op.
        expect((await backfillFirstApplicationInvoiceStamps(trx)).stamped).toBe(0);
      }));

      test('a fresh (unstamped) three-program group counts all three', () => rollbackTest(async (trx) => {
        await backfillFirstApplicationInvoiceStamps(trx);
        const ids = await seedThreeProgramGroup(trx);
        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.stamped).toBe(3);
        for (const id of [ids.anchorId, ids.alignedId, ids.movedId]) expect(await stampOf(trx, id)).toBe(ids.invoiceId);
      }));

      test('an anchor stamped to a DIFFERENT invoice is still refused — nothing is stamped for this invoice', () => rollbackTest(async (trx) => {
        await backfillFirstApplicationInvoiceStamps(trx);
        const ids = await seedThreeProgramGroup(trx);
        // Some other (void, so it claims nothing else) invoice elsewhere.
        const otherVisit = randomUUID();
        await trx('scheduled_services').insert({
          id: otherVisit, customer_id: ids.customerId, scheduled_date: '2026-12-01',
          service_type: 'One-time', status: 'confirmed', is_recurring: false,
        });
        const otherInvoice = randomUUID();
        await trx('invoices').insert({
          id: otherInvoice, customer_id: ids.customerId, scheduled_service_id: otherVisit,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
          status: 'void', title: 'Other', notes: 'Other.',
          line_items: JSON.stringify([]), subtotal: 0, total: 0,
        });
        await trx('scheduled_services').where({ id: ids.anchorId }).update({ first_application_invoice_id: otherInvoice });
        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.stamped).toBe(0);
        expect(await stampOf(trx, ids.anchorId)).toBe(otherInvoice);
        expect(await stampOf(trx, ids.alignedId)).toBeNull();
        expect(await stampOf(trx, ids.movedId)).toBeNull();
      }));
    });

    // -----------------------------------------------------------------
    // P1-A (Codex round 13 on PR #5021): the accept-time created_at window
    // is not membership evidence on its own — (1) two acceptances under the
    // SAME estimate close enough together put every row from BOTH accepts
    // inside EACH OTHER's window, and (2) the converter also creates
    // unpriced recurring parents at accept that are NOT same-trip (a
    // seasonal roll, a companion outside the reservation), which land
    // inside the window too. A sibling now also needs its date AT THE
    // INVOICE'S created_at (Codex round 14 P1 — dateAtInstant: the latest
    // reschedule_log move at or before that instant, else the original_date
    // of the first move after it, else the current scheduled_date) to equal
    // the anchor's date at that same instant.
    // -----------------------------------------------------------------
    describe('P1-A: original-date evidence required alongside the created_at window', () => {
      async function insertRescheduleLog(trx, {
        scheduledServiceId, customerId, originalDate, newDate, createdAt,
      }) {
        await trx('reschedule_log').insert({
          id: randomUUID(),
          scheduled_service_id: scheduledServiceId,
          customer_id: customerId,
          original_date: originalDate,
          new_date: newDate,
          reason_code: 'customer_request',
          initiated_by: 'admin',
          created_at: createdAt,
        });
      }

      // Models a same-accept row that was NEVER on the anchor's day to
      // begin with (e.g. a seasonal unit rolled to a later month at accept
      // time, or a companion outside the reservation) — created in the
      // SAME transaction/window as the invoice, but its ORIGINAL date
      // (no reschedule_log — this IS its original date) never matched.
      test('a same-accept row created inside the window, but on a DIFFERENT original date from day one, is NOT stamped', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-08-01T10:00:02Z'), // inside the 120s window
          siblingScheduledDate: '2027-02-01', // its ORIGINAL date — never the anchor's day
        });
        await backfillFirstApplicationInvoiceStamps(trx);
        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        expect(anchor.first_application_invoice_id).toBeNull();
        expect(sibling.first_application_invoice_id).toBeNull();
      }));

      // The genuine case P1-A restores: a sibling that WAS on the anchor's
      // day at accept and has since diverged, PROVEN by a reschedule_log
      // row recording its true original date.
      test('a genuine pair already diverged, proven by a reschedule_log row on the sibling, IS stamped', () => rollbackTest(async (trx) => {
        const ids = await seedAcceptanceEvidencePair(trx, {
          anchorCreatedAt: new Date('2026-08-01T10:00:00Z'),
          siblingCreatedAt: new Date('2026-08-01T10:00:03Z'),
          siblingScheduledDate: '2026-11-20', // current, diverged date
        });
        await insertRescheduleLog(trx, {
          scheduledServiceId: ids.siblingId,
          customerId: ids.customerId,
          originalDate: SAME_DATE,
          newDate: '2026-11-20',
          createdAt: new Date('2026-08-10T00:00:00Z'),
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

      // Problem (1) from the header comment: two acceptances under ONE
      // estimate only 60 seconds apart put every row from BOTH accepts
      // inside EACH OTHER's 120-second window. Original-date evidence
      // disambiguates them (different first-visit days) so each accept's
      // own anchor+sibling pair is stamped to its OWN invoice — never
      // cross-stamped or merged.
      test('two acceptances under one estimate within 60 seconds each keep their own members', () => rollbackTest(async (trx) => {
        const customerId = randomUUID();
        const estimateId = randomUUID();
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic backfill dual-accept fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
        });
        await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });

        const accept1At = new Date('2026-08-01T10:00:00Z');
        const accept2At = new Date(accept1At.getTime() + 60000); // 60s later — inside each other's 120s window

        const anchor1 = randomUUID();
        const sibling1 = randomUUID();
        const anchor2 = randomUUID();
        const sibling2 = randomUUID();
        await trx('scheduled_services').insert([
          {
            id: anchor1, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-10-01',
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200, created_at: accept1At,
          },
          {
            id: sibling1, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-10-01',
            service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: accept1At,
          },
          {
            id: anchor2, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-11-05',
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 150, created_at: accept2At,
          },
          {
            id: sibling2, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-11-05',
            service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: accept2At,
          },
        ]);
        const invoice1 = randomUUID();
        const invoice2 = randomUUID();
        await trx('invoices').insert([
          {
            id: invoice1, customer_id: customerId, scheduled_service_id: anchor1,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'First Service Application',
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
            line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
            subtotal: 200, total: 200, created_at: accept1At,
          },
          {
            id: invoice2, customer_id: customerId, scheduled_service_id: anchor2,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'First Service Application',
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
            line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 150, amount: 150 }]),
            subtotal: 150, total: 150, created_at: accept2At,
          },
        ]);

        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.ambiguous).toBe(0);
        const rows = await trx('scheduled_services').whereIn('id', [anchor1, sibling1, anchor2, sibling2])
          .select('id', 'first_application_invoice_id');
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.first_application_invoice_id]));
        expect(byId[anchor1]).toBe(invoice1);
        expect(byId[sibling1]).toBe(invoice1);
        expect(byId[anchor2]).toBe(invoice2);
        expect(byId[sibling2]).toBe(invoice2);
      }));

      // A single sibling row satisfying BOTH candidate invoices' window AND
      // original-date criteria at once (the genuinely irresolvable case —
      // e.g. two accepts that both independently landed on the exact same
      // first-visit day) is stamped to NEITHER: the backfill fails toward
      // NOT stamping and counts it as ambiguous for hand review.
      test('a sibling matching two candidate invoices at once (same original date) is left unstamped and counted as ambiguous', () => rollbackTest(async (trx) => {
        const customerId = randomUUID();
        const estimateId = randomUUID();
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic backfill ambiguous fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
        });
        await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });

        const accept1At = new Date('2026-08-01T10:00:00Z');
        const accept2At = new Date(accept1At.getTime() + 60000);

        const anchor1 = randomUUID();
        const anchor2 = randomUUID();
        const sibling = randomUUID();
        await trx('scheduled_services').insert([
          {
            id: anchor1, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200, created_at: accept1At,
          },
          {
            id: anchor2, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
            service_type: 'Termite', status: 'confirmed', is_recurring: true, estimated_price: 150, created_at: accept2At,
          },
          {
            // Created at accept1At — within 120s of BOTH invoices' created_at
            // (accept1At exactly, and accept2At 60s later) — and on the SAME
            // original date as both anchors, so it genuinely satisfies both.
            id: sibling, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
            service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: accept1At,
          },
        ]);
        const invoice1 = randomUUID();
        const invoice2 = randomUUID();
        await trx('invoices').insert([
          {
            id: invoice1, customer_id: customerId, scheduled_service_id: anchor1,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'First Service Application',
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
            line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
            subtotal: 200, total: 200, created_at: accept1At,
          },
          {
            id: invoice2, customer_id: customerId, scheduled_service_id: anchor2,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'First Service Application',
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
            line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 150, amount: 150 }]),
            subtotal: 150, total: 150, created_at: accept2At,
          },
        ]);

        const result = await backfillFirstApplicationInvoiceStamps(trx);
        expect(result.ambiguous).toBe(1);
        const rows = await trx('scheduled_services').whereIn('id', [anchor1, anchor2, sibling])
          .select('id', 'first_application_invoice_id');
        for (const row of rows) expect(row.first_application_invoice_id).toBeNull();
      }));

      // Never overwrite: a row already stamped (a real accept-time stamp,
      // or a prior backfill run) keeps its EXISTING value even if it would
      // otherwise also satisfy a different invoice's window+original-date
      // criteria — and its anchor, left with no eligible sibling, is
      // treated as single-program-equivalent rather than reassigned.
      test('an existing stamp is never overwritten, even when the row would otherwise also match a different invoice', () => rollbackTest(async (trx) => {
        const ids = await seedHistoricalPair(trx);
        const otherInvoiceId = randomUUID();
        await trx('invoices').insert({
          id: otherInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.siblingId,
          token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
          status: 'sent', title: 'Lawn Care', notes: 'An unrelated, already-existing invoice on the sibling.',
          line_items: JSON.stringify([{ client_id: `scheduled_${ids.siblingId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
          subtotal: 60, total: 60,
        });
        // Simulate a pre-existing stamp (a real accept-time write, or a
        // prior backfill run) pointing the sibling at that OTHER invoice.
        await trx('scheduled_services').where({ id: ids.siblingId }).update({ first_application_invoice_id: otherInvoiceId });

        await backfillFirstApplicationInvoiceStamps(trx);

        const [anchor, sibling] = await Promise.all([
          trx('scheduled_services').where({ id: ids.anchorId }).first('first_application_invoice_id'),
          trx('scheduled_services').where({ id: ids.siblingId }).first('first_application_invoice_id'),
        ]);
        // The existing stamp is untouched.
        expect(sibling.first_application_invoice_id).toBe(otherInvoiceId);
        // The anchor's only candidate sibling is already claimed elsewhere,
        // so the anchor is left unstamped too — single-program-equivalent.
        expect(anchor.first_application_invoice_id).toBeNull();
      }));

      test('idempotent rerun of the two-acceptances-within-60-seconds shape keeps each accept\'s own members, with no new ambiguity', () => rollbackTest(async (trx) => {
        const customerId = randomUUID();
        const estimateId = randomUUID();
        await trx('customers').insert({
          id: customerId, first_name: 'Synthetic backfill dual-accept rerun fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
        });
        await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
        const accept1At = new Date('2026-08-01T10:00:00Z');
        const accept2At = new Date(accept1At.getTime() + 60000);
        const anchor1 = randomUUID();
        const sibling1 = randomUUID();
        const anchor2 = randomUUID();
        const sibling2 = randomUUID();
        await trx('scheduled_services').insert([
          {
            id: anchor1, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-10-01',
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 200, created_at: accept1At,
          },
          {
            id: sibling1, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-10-01',
            service_type: 'Lawn Care', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: accept1At,
          },
          {
            id: anchor2, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-11-05',
            service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 150, created_at: accept2At,
          },
          {
            id: sibling2, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: '2026-11-05',
            service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null, created_at: accept2At,
          },
        ]);
        const invoice1 = randomUUID();
        const invoice2 = randomUUID();
        await trx('invoices').insert([
          {
            id: invoice1, customer_id: customerId, scheduled_service_id: anchor1,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'First Service Application',
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
            line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
            subtotal: 200, total: 200, created_at: accept1At,
          },
          {
            id: invoice2, customer_id: customerId, scheduled_service_id: anchor2,
            token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
            status: 'sent', title: 'First Service Application',
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
            line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 150, amount: 150 }]),
            subtotal: 150, total: 150, created_at: accept2At,
          },
        ]);

        // P1-A: never-overwrite idempotence — the second run stamps
        // nothing NEW (every row from both accepts is already claimed by
        // its own genuine invoice), and neither run ever produces ambiguity.
        const first = await backfillFirstApplicationInvoiceStamps(trx);
        expect(first.stamped).toBe(4);
        expect(first.ambiguous).toBe(0);
        const second = await backfillFirstApplicationInvoiceStamps(trx);
        expect(second.stamped).toBe(0);
        expect(second.ambiguous).toBe(0);
        const rows = await trx('scheduled_services').whereIn('id', [anchor1, sibling1, anchor2, sibling2])
          .select('id', 'first_application_invoice_id');
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.first_application_invoice_id]));
        expect(byId[anchor1]).toBe(invoice1);
        expect(byId[sibling1]).toBe(invoice1);
        expect(byId[anchor2]).toBe(invoice2);
        expect(byId[sibling2]).toBe(invoice2);
      }));
    });
  });
  // Codex round 15 (PR #5021): the last gates that still ignored the stamp.
  describe('round 15: stamp-aware void guard, fail-closed replacement, runtime reconciliation, backfill ownership', () => {
    const { combinedInvoiceVoidedWithoutLiveReplacement, siblingInvoiceCoverageVerdict } = require('../services/billing-lane');
    const {
      findFirstApplicationInvoiceForEstimateService, backfillFirstApplicationInvoiceStamps,
    } = require('../services/estimate-first-application-invoice');
    const { reconcileRecentUnstampedAccepts, RECENT_STAMP_RECONCILE_DAYS } = require('../services/first-application-sibling-split');
    const MOVED = '2026-10-09';
    const row = (trx, id) => trx('scheduled_services').where({ id }).first();
    const anchorInvoice = (trx, ids, over = {}) => trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.pestId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent',
      title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${ids.estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 153.6, amount: 153.6 }]),
      subtotal: 153.6, total: 153.6, ...over,
    }).returning('id').then((r) => r[0].id || r[0]);

    test('void guard: a STAMPED sibling moved to another day + voided combined invoice + no replacement → hold (the voided row)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const held = await combinedInvoiceVoidedWithoutLiveReplacement(await row(trx, ids.lawnId), trx);
      expect(held?.id).toBe(ids.invoiceId);
      // and the ordinary lookup (void-excluded) finds nothing — the guard is the fallback
      expect((await findFirstApplicationInvoiceForEstimateService(await row(trx, ids.lawnId), trx)).invoice).toBeNull();
    }));

    test('void guard: same shape + a RECOGNIZED live replacement on the anchor → no hold (the replacement governs)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementId = await anchorInvoice(trx, ids);
      expect(await combinedInvoiceVoidedWithoutLiveReplacement(await row(trx, ids.lawnId), trx)).toBeNull();
      // the lookup sees the recognized replacement through the stamped anchor
      expect((await findFirstApplicationInvoiceForEstimateService(await row(trx, ids.lawnId), trx)).invoice?.id).toBe(replacementId);
    }));

    test('fail closed: a RENAMED (unrecognized) live invoice on the anchor is neither coverage nor "none" — the guard holds and the verdict is needs_review', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      await anchorInvoice(trx, ids, { title: 'Custom invoice title', notes: 'Renamed by the office, nothing recognizable.' });
      const lawn = await row(trx, ids.lawnId);
      expect((await findFirstApplicationInvoiceForEstimateService(lawn, trx)).invoice).toBeNull();
      expect((await combinedInvoiceVoidedWithoutLiveReplacement(lawn, trx))?.id).toBe(ids.invoiceId);
      const verdict = await siblingInvoiceCoverageVerdict(lawn, trx);
      expect(verdict.status).toBe('needs_review');
    }));

    test('void guard: an UNSTAMPED moved sibling keeps the legacy date-only behaviour (nothing found)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      expect(await combinedInvoiceVoidedWithoutLiveReplacement(await row(trx, ids.lawnId), trx)).toBeNull();
    }));

    test('void guard: a stamped sibling whose row was read with a narrow select still holds (fallback stamp read)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const narrow = await trx('scheduled_services').where({ id: ids.lawnId })
        .first('id', 'customer_id', 'source_estimate_id', 'scheduled_date');
      expect(narrow.first_application_invoice_id).toBeUndefined();
      expect((await combinedInvoiceVoidedWithoutLiveReplacement(narrow, trx))?.id).toBe(ids.invoiceId);
    }));

    test('runtime reconciliation: an accept nobody stamped (old pod during cutover) is stamped by the sweep tick and then alerts when it diverges', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBeNull();
      const result = await reconcileRecentUnstampedAccepts(trx);
      expect(RECENT_STAMP_RECONCILE_DAYS).toBe(14);
      expect(result.stamped).toBeGreaterThanOrEqual(2);
      expect((await row(trx, ids.pestId)).first_application_invoice_id).toBe(ids.invoiceId);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      const [outcome] = await sweepOnce(trx, ids.estimateId);
      expect(outcome.action).toBe('alerted');
      expect(await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).toBeTruthy();
    }));

    test('runtime reconciliation: the sinceDays bound leaves an OLD unstamped invoice alone (the one-time migrations own history)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      const old = new Date(Date.now() - 40 * 86400000);
      await trx('invoices').where({ id: ids.invoiceId }).update({ created_at: old });
      await trx('scheduled_services').whereIn('id', [ids.pestId, ids.lawnId]).update({ created_at: old });
      await backfillFirstApplicationInvoiceStamps(trx, { sinceDays: RECENT_STAMP_RECONCILE_DAYS });
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBeNull();
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
    }));

    // Codex r16 P1: "any live invoice on the sibling's row" is not split
    // evidence — an add-on or repair invoice must not clear the alert.
    test('split evidence: an UNRELATED live invoice on the diverged sibling (no base-application line) does not clear the alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'sent', title: 'Mosquito add-on', notes: 'One-off add-on billed separately.',
        line_items: JSON.stringify([{ description: 'Mosquito add-on treatment', quantity: 1, unit_price: 35, amount: 35 }]),
        subtotal: 35, total: 35,
      });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(await readBell(trx, DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).toBeTruthy();
    }));

    test('split evidence: an own live invoice that bills the base application (client_id scheduled_<id>_primary) DOES resolve the sibling', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'Lawn Care', notes: 'Split from the combined invoice.',
        line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
        subtotal: 42, total: 42,
      });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('cleared');
      expect(result.reason).toBe('split_completed');
    }));

    // Codex pre-push P1 on 15bb180830: the bounded runtime reconciliation
    // must never widen an accept-time (authoritative) group.
    test('reconciliation never adds an unlisted same-day bystander to an accept-time stamped group; only the unbounded historical run repairs partial groups', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx); // stamped at "accept": pest + lawn
      const bystanderId = randomUUID();
      await trx('scheduled_services').insert({
        id: bystanderId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: '2026-10-01',
        service_type: 'Mosquito Misting', status: 'confirmed', is_recurring: true, estimated_price: null,
      });
      await reconcileRecentUnstampedAccepts(trx);
      expect((await row(trx, bystanderId)).first_application_invoice_id).toBeNull();
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
      // The migrations' unbounded run is the historical repair path and is
      // allowed to extend a partially stamped group (documented contract).
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, bystanderId)).first_application_invoice_id).toBe(ids.invoiceId);
    }));

    // Codex r17: the base-application identity is the ONLY split/ownership
    // evidence everywhere — discovery, backfill and the lookup agree.
    const addOnInvoice = (trx, ids, visitId, over = {}) => trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: visitId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent',
      title: 'Mosquito add-on', notes: 'One-off add-on billed separately.',
      line_items: JSON.stringify([{ description: 'Mosquito add-on treatment', quantity: 1, unit_price: 35, amount: 35 }]),
      subtotal: 35, total: 35, ...over,
    });

    test('paid-group discovery: a PAID combined invoice + cancelled sibling that also has an unrelated add-on invoice still gets the refund alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      await addOnInvoice(trx, ids, ids.lawnId);
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      expect(await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).toBeTruthy();
    }));

    test('paid-group discovery: the same shape with a genuine base-application split invoice on the cancelled sibling → no refund alert', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      await addOnInvoice(trx, ids, ids.lawnId, {
        title: 'Lawn Care',
        line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      });
      const results = await sweepOnce(trx, ids.estimateId);
      expect(results.some((r) => r.action === 'alerted')).toBe(false);
      expect(await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).toBeFalsy();
    }));

    test('backfill ownership: an unrelated live add-on invoice on the anchor or the sibling is not an ownership claim — the pair is still stamped', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await addOnInvoice(trx, ids, ids.pestId);
      await addOnInvoice(trx, ids, ids.lawnId);
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.pestId)).first_application_invoice_id).toBe(ids.invoiceId);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
    }));

    test('backfill ownership: a sibling whose application a live base-application invoice already bills was split off — not stamped', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await addOnInvoice(trx, ids, ids.lawnId, {
        title: 'Lawn Care',
        line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBeNull();
      // single-program result: the anchor alone is never stamped as a pair
      expect((await row(trx, ids.pestId)).first_application_invoice_id).toBeNull();
    }));

    test('lookup: a stamped sibling rescheduled onto ANOTHER group\'s day (same customer + estimate) finds its OWN stamped invoice, never the other group\'s', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      // A second combined-invoice group under the same customer + estimate on
      // a different day (a later acceptance), also stamped.
      const otherDate = '2026-10-15';
      const otherAnchor = randomUUID();
      const otherSibling = randomUUID();
      await trx('scheduled_services').insert([
        { id: otherAnchor, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: otherDate, service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true, estimated_price: 120 },
        { id: otherSibling, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: otherDate, service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null },
      ]);
      const otherInvoiceId = randomUUID();
      await trx('invoices').insert({
        id: otherInvoiceId, customer_id: ids.customerId, scheduled_service_id: otherAnchor,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent',
        title: 'First Service Application',
        notes: `Auto-generated from accepted estimate #${ids.estimateId}. Customer selected pay per application — first application only.`,
        line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }]),
        subtotal: 120, total: 120,
      });
      await trx('scheduled_services').whereIn('id', [otherAnchor, otherSibling]).update({ first_application_invoice_id: otherInvoiceId });
      // Our lawn sibling moves onto the other group's day.
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: otherDate });
      const found = await findFirstApplicationInvoiceForEstimateService(await row(trx, ids.lawnId), trx);
      expect(found.invoice?.id).toBe(ids.invoiceId);
      // and the other group's own sibling still finds ITS invoice
      const otherFound = await findFirstApplicationInvoiceForEstimateService(await row(trx, otherSibling), trx);
      expect(otherFound.invoice?.id).toBe(otherInvoiceId);
    }));

    // Codex r18 P1: a settled invoice on the anchor drives refund instructions
    // only with base-application evidence.
    test('refund instructions: stamped invoice REFUNDED + unrelated PAID add-on on the anchor + cancelled sibling → no refund alert (cleared as refunded)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'refunded' });
      await addOnInvoice(trx, ids, ids.pestId, { status: 'paid' });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      const results = await sweepOnce(trx, ids.estimateId);
      expect(results.some((r) => r.action === 'alerted')).toBe(false);
      expect(await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]))).toBeFalsy();
    }));

    test('refund instructions: stamped invoice VOID + a PAID base-application replacement on the anchor + cancelled sibling → refund alert naming the replacement', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx);
      await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
      const replacementNumber = `WPC-TEST-${randomUUID().slice(0, 8)}`;
      await addOnInvoice(trx, ids, ids.pestId, {
        status: 'paid', invoice_number: replacementNumber, title: 'Quarterly Pest Control',
        line_items: JSON.stringify([{ client_id: `scheduled_${ids.pestId}_primary`, description: 'Quarterly Pest Control', quantity: 1, unit_price: 153.6, amount: 153.6 }]),
        subtotal: 153.6, total: 153.6,
      });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ status: 'cancelled' });
      const [result] = await sweepOnce(trx, ids.estimateId);
      expect(result.action).toBe('alerted');
      const bell = await readBell(trx, REFUND_DEDUPE_KEY(ids.estimateId, ids.invoiceId, [ids.lawnId]));
      expect(bell).toBeTruthy();
      expect(`${bell.title} ${bell.body || bell.message || ''}`).toContain(replacementNumber);
    }));

    // Codex pre-push P1 on a0a05a61e6: invoice-mode recurring accepts write
    // different notes; the backfill must recognize them too.
    test('backfill recognizer: an INVOICE-MODE recurring accept invoice ("(invoice-mode recurring)" notes) is stamped by the migration run and by the runtime reconciliation', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await trx('invoices').where({ id: ids.invoiceId }).update({
        title: 'Quarterly Pest Control + Lawn Care',
        notes: `Auto-generated from accepted estimate #${ids.estimateId} (invoice-mode recurring). Monthly equivalent: $61.20/mo.`,
      });
      await reconcileRecentUnstampedAccepts(trx);
      expect((await row(trx, ids.pestId)).first_application_invoice_id).toBe(ids.invoiceId);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
      // idempotent on the unbounded (migration) run too
      const again = await backfillFirstApplicationInvoiceStamps(trx);
      expect(again.stamped).toBe(0);
    }));

    test('backfill recognizer: an unrecognizable hand invoice on the anchor is still never a candidate', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false, matchInvoiceText: false });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBeNull();
    }));

    // Codex r20 P1s: a later staff price edit does not un-cover a sibling; an
    // itemized invoice line is acceptance-time evidence that needs no
    // reschedule history.
    test('backfill: a covered sibling priced LATER by staff is stamped only when the invoice itemizes it; unitemized it is left for hand review', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ estimated_price: 42 });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBeNull();
      await trx('invoices').where({ id: ids.invoiceId }).update({
        line_items: JSON.stringify([
          { client_id: `scheduled_${ids.pestId}_primary`, description: 'Quarterly Pest Control', quantity: 1, unit_price: 97.2, amount: 97.2 },
          { client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 56.4, amount: 56.4 },
        ]),
      });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
    }));

    test('backfill: a moved sibling with NO reschedule_log row is still stamped when the invoice\'s own line items itemize it (client_id scheduled_<id>_primary)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await trx('invoices').where({ id: ids.invoiceId }).update({
        line_items: JSON.stringify([
          { client_id: `scheduled_${ids.pestId}_primary`, description: 'Quarterly Pest Control', quantity: 1, unit_price: 97.2, amount: 97.2 },
          { client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 56.4, amount: 56.4 },
        ]),
      });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
      expect((await row(trx, ids.pestId)).first_application_invoice_id).toBe(ids.invoiceId);
    }));

    test('backfill: a moved sibling with NO reschedule_log row and NO itemized line stays unstamped (logged for hand review)', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: MOVED });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBeNull();
    }));

    test('backfill ownership: an old REFUNDED invoice attached to the anchor is dead, not a live claim — the pair is still stamped', () => rollbackTest(async (trx) => {
      const ids = await fixture(trx, { stamp: false });
      await anchorInvoice(trx, ids, { status: 'refunded', title: 'Old refunded visit invoice', notes: 'refunded' });
      await backfillFirstApplicationInvoiceStamps(trx);
      expect((await row(trx, ids.pestId)).first_application_invoice_id).toBe(ids.invoiceId);
      expect((await row(trx, ids.lawnId)).first_application_invoice_id).toBe(ids.invoiceId);
    }));
  });

  // Codex r14 P2 on #5021: the sweep pages candidate invoice ids in SQL
  // before loading members, so a tick's read is bounded by the batch size.
  describe('keyset paging of candidate invoices', () => {
    async function seedCandidates(trx, n) {
      const ids = [];
      for (let i = 0; i < n; i += 1) ids.push((await fixture(trx, { invoiceStatus: 'sent' })).invoiceId);
      return ids.sort();
    }

    test('a page is ascending, strictly after the cursor, and bounded by the limit', () => rollbackTest(async (trx) => {
      const own = await seedCandidates(trx, 5);
      const page = await loadCandidateInvoiceIdPage(trx, { afterId: own[1], limit: 2 });
      expect(page).toHaveLength(2);
      expect(page.every((id) => id > own[1])).toBe(true);
      expect([...page].sort()).toEqual(page);
    }));

    test('a settled invoice with nothing to review is not a candidate', () => rollbackTest(async (trx) => {
      const settled = await fixture(trx, { invoiceStatus: 'paid' });
      const all = await loadCandidateInvoiceIdPage(trx, { limit: 100000 });
      expect(all).not.toContain(settled.invoiceId);
    }));

    test('ticks round-robin over every candidate, wrap at the end, and never repeat inside a batch', () => rollbackTest(async (trx) => {
      const own = await seedCandidates(trx, 5);
      const total = (await loadCandidateInvoiceIdPage(trx, { limit: 100000 })).length;
      const limit = 2;
      const seen = new Set();
      let cursor = null;
      for (let tick = 0; tick < Math.ceil(total / limit); tick += 1) {
        const batch = await loadSweepBatchInvoiceIds(trx, { cursor, limit });
        expect(new Set(batch).size).toBe(batch.length);
        expect(batch.length).toBe(Math.min(limit, total));
        batch.forEach((id) => seen.add(id));
        cursor = batch[batch.length - 1];
      }
      expect(seen.size).toBe(total);
      own.forEach((id) => expect(seen).toContain(id));
    }));

    test('a cursor past the last candidate wraps to the start', () => rollbackTest(async (trx) => {
      await seedCandidates(trx, 3);
      const all = await loadCandidateInvoiceIdPage(trx, { limit: 100000 });
      const batch = await loadSweepBatchInvoiceIds(trx, { cursor: 'ffffffff-ffff-ffff-ffff-ffffffffffff', limit: 2 });
      expect(batch).toEqual(all.slice(0, 2));
    }));
  });
});
