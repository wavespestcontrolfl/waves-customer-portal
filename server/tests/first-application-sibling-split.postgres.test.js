/**
 * Same-trip first-application billing ALERT — periodic sweep (owner
 * ruling, 2026-09-27 redesign; supersedes the #5021 round-3..9 "alert from
 * every writer" design). A reserved-accept slot selling two recurring
 * programs mints ONE draft invoice for the combined same-day total, linked
 * to the reserved (priced) row; the promoted sibling is left
 * estimated_price NULL on purpose (covered by that invoice while the two
 * visits share a date). A periodic sweep (server/services/scheduler.js)
 * re-derives every open first-application invoice's estimate group fresh
 * and opens/refreshes or clears ONE durable admin alert
 * (notification-service.notifyAdmin, category 'billing') per estimate —
 * it never touches the invoice's money, never holds collection, never
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
    groupCandidatesByEstimate,
    evaluateEstimateCandidates,
    clearStandingAlerts,
  } = require('../services/first-application-sibling-split');

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
  // programs into one reserved slot. `matchInvoiceText: false` mints an
  // invoice whose title/notes do NOT match the auto-generated
  // pay-per-application pattern (never a sweep candidate). `invoiceStatus`
  // lets a test mint an already-settled invoice.
  const SAME_DATE = '2026-10-01';
  async function fixture(trx, {
    reservedPrice = 153.60,
    sameDate = SAME_DATE,
    matchInvoiceText = true,
    noInvoice = false,
    invoiceStatus = 'draft',
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
    }
    return {
      customerId, estimateId, pestId, lawnId, invoiceId,
    };
  }

  async function readBell(conn, dedupeKey) {
    return conn('notifications').where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first();
  }

  // Runs the sweep's own candidate-discovery + per-estimate evaluation on
  // ONE connection (the test's own transaction) — the same two calls
  // runFirstApplicationSiblingSplitSweep makes per estimate, just without
  // the outer runExclusive lock or the per-estimate transaction split
  // (rollbackTest already isolates the whole test in one transaction).
  // Every candidate row for this estimate is evaluated TOGETHER (see the
  // module header) — never a picked-by-heuristic representative.
  async function sweepOnce(trx, estimateId) {
    const candidates = await loadCandidates(trx);
    const groups = groupCandidatesByEstimate(candidates);
    const mine = groups.find((g) => g[0].source_estimate_id === estimateId);
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

  // Codex round-1 P1 on the pre-push fix: a divergence the SWEEP ITSELF
  // auto-cleared (realigned) that recurs on the EXACT SAME date must still
  // reopen — its fingerprint and notification content match the pre-clear
  // alert exactly, so plain fingerprint dedupe would otherwise leave it
  // silently cleared even though the problem is back.
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

  // Real-data manual-split detection (pre-push P1 fix): the office's own
  // instructed fix — giving the moved sibling its own live invoice linked
  // to its own scheduled_service_id — must stop the alert on its own,
  // without relying on any invoice title/notes text.
  //
  // Signal (a) alone — has_own_live_invoice — DELIBERATELY, not signal (b)
  // (a dollar comparison against the combined invoice's total/lines):
  // pre-push rounds 4-7 tried progressively narrower dollar reconciliation
  // (a raw-total reduction, then a per-sibling attributable sum, then an
  // application-only figure excluding setup fees, then accounting for
  // plan-credit discounts) and each fix closed one gap in the invoice's
  // open-ended composition (setup fees, rodent-bait fees, plan-credit
  // slices, taxes, ...) only to open the next — exactly the "fall back to
  // (a) if (b) is not reliable" contingency the task's own instructions
  // anticipated. See the module header for the full history.
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

  // Codex round-1 P1 on the pre-push fix: void alone was excluded, so a
  // cancelled sibling invoice (no replacement charge ever billed) could
  // falsely clear the alert.
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

  // Codex round-3 P1 on the pre-push fix: the ALERTED (anchor's own)
  // invoice is voided and re-minted for the SAME anchor visit while the
  // group is STILL diverging. loadCandidates now returns two rows for this
  // one estimate — the live replacement (from the primary non-settled
  // scan) and the stale voided original (pulled in only because the
  // standing alert still names it) — and evaluating both independently
  // let the voided row's 'invoice_settled' clear verdict wipe out the
  // live row's 'alert' verdict for the very same group.
  test('the alerted invoice is voided and replaced — the live replacement governs, not the stale voided row', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // The original invoice is voided...
    await trx('invoices').where({ id: ids.invoiceId }).update({ status: 'void' });
    // ...and re-minted for the SAME anchor visit (pestId) — same shared-
    // invoice pattern, still open, the group still genuinely diverging.
    const replacementInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: replacementInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.pestId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${ids.estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 }]),
      subtotal: 153.60, total: 153.60,
    });

    const results = await sweepOnce(trx, ids.estimateId);
    // Only ONE representative evaluated for this estimate — the live
    // replacement — never a second, contradictory 'cleared' verdict from
    // the stale voided row.
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('alerted');

    const stillOpen = await readBell(trx, dedupeKey);
    expect(stillOpen.read_at).toBeNull();
    const metadata = typeof stillOpen.metadata === 'string' ? JSON.parse(stillOpen.metadata) : stillOpen.metadata;
    expect(metadata.invoiceId).toBe(replacementInvoiceId);
  }));

  // Dismissal semantics (pre-push P1 fix): a dismissed alert must not
  // reopen on the next tick unless the state materially changed.
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

  // Codex round-2 P1 on the pre-push fix: a PLAIN human dismissal (read_at
  // set, no autoCleared) followed by a GENUINE realignment must still
  // record the resolution (clearStandingAlerts previously skipped an
  // already-read row entirely), so a later recurrence onto the EXACT SAME
  // original date is recognized as a real recurrence and reopens — not
  // silently left dismissed forever.
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

  // PR #5021 Codex r6 (head 2168cb0877): candidacy is structural now, not
  // text-matched — InvoiceService.update lets staff freely edit an unpaid
  // invoice's title/notes, and a copy edit made before the FIRST sweep ever
  // ran used to drop the invoice out of every future candidate scan
  // forever (no standing alert yet existed to carry it through the
  // stale-invoice fallback). A hand-edited title/notes must not matter.
  test('invoice text unrecognizable — still a candidate (candidacy is structural, not text-matched)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { matchInvoiceText: false });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  test('no first-application invoice at all — never a sweep candidate, no alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { noInvoice: true });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results).toEqual([]);
  }));

  // False-positive coverage for the structural candidacy signal (PR #5021
  // Codex r6, head 2168cb0877): a normal single-program estimate has no
  // sibling top-level visit at all, so it must never become a candidate —
  // even when its invoice's own title/notes WOULD have matched the old
  // text pattern.
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
    // Move the visit's own date around — a single-program estimate has no
    // sibling to diverge from in the first place.
    await trx('scheduled_services').where({ id: soloId }).update({ scheduled_date: '2026-10-09' });
    const results = await sweepOnce(trx, estimateId);
    expect(results).toEqual([]);
  }));

  // False-positive coverage: two SEPARATE recurring programs off one
  // estimate, each independently priced AND independently invoiced from
  // day one (never sharing one combined invoice), must never be read as a
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
    // One of the two visits moves — a real divergence between two
    // independently billed programs, not a shared-invoice conflict.
    await trx('scheduled_services').where({ id: lawnId }).update({ scheduled_date: '2026-10-02' });
    const results = await sweepOnce(trx, estimateId);
    expect(results).toEqual([]);
  }));

  // A THREE-program group (A anchor + B + C). B and C both diverge; staff
  // then price and separately invoice B ONLY (a partial split), leaving C
  // still unpriced and un-invoiced. B's own new invoice legitimately
  // registers as a second candidate for this estimate too (see the module
  // header — this is by design now, not a bug to prevent), but
  // evaluateEstimateCandidates evaluating both together must still keep
  // the real alert open (naming C, still uncovered by A's combined
  // invoice) — never silently cleared by B's own narrow 'clear' verdict.
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
    // Explicit, distinct created_at values (real acceptance vs a later
    // hand-split are always separate requests/transactions in production,
    // so their created_at values are naturally ordered — this test sets
    // them explicitly rather than relying on the fixture's single shared
    // transaction, whose default now() would otherwise tie them).
    const anchorInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: anchorInvoiceId, customer_id: customerId, scheduled_service_id: anchorId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
      subtotal: 200, total: 200, created_at: new Date('2026-09-01T00:00:00Z'),
    });

    // B and C both diverge from the anchor onto the SAME new day — the
    // exact shape where B's own narrow view, once split off, would read C
    // as "aligned" with it (same date as B) rather than diverging.
    await trx('scheduled_services').where({ id: bId }).update({ scheduled_date: '2026-10-02' });
    await trx('scheduled_services').where({ id: cId }).update({ scheduled_date: '2026-10-02' });
    const [firstResult] = await sweepOnce(trx, estimateId);
    expect(firstResult.action).toBe('alerted');
    expect(firstResult.divergingSiblingIds).toEqual([bId, cId].map(String).sort());
    const dedupeKey = DEDUPE_KEY(estimateId, [bId, cId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office splits B only: prices it and mints its own live invoice —
    // well AFTER the anchor's own invoice, exactly like a real hand-split
    // done days later.
    await trx('scheduled_services').where({ id: bId }).update({ estimated_price: 60 });
    const bInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: bInvoiceId, customer_id: customerId, scheduled_service_id: bId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
      subtotal: 60, total: 60, created_at: new Date('2026-09-05T00:00:00Z'),
    });

    // loadCandidates now returns ONLY the true anchor's own invoice for
    // this estimate — never B's own new invoice too — because the first
    // sweep already ESTABLISHED anchorId=A in the standing alert's own
    // metadata, and every later tick re-derives that SAME known anchor
    // directly instead of re-running the (ambiguous, once a split exists)
    // structural scan. B's own invoice is not even discovered here.
    const candidates = await loadCandidates(trx);
    const mine = candidates.filter((c) => c.source_estimate_id === estimateId);
    expect(mine.map((c) => c.invoice_id)).toEqual([anchorInvoiceId]);

    const [result] = await sweepOnce(trx, estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([cId]);

    // The alert for the now-narrower diverging set (just C, since B
    // resolved) is open and unread — never wiped by a bogus clear from B's
    // own invoice's point of view, which would have marked THIS row read
    // too (clearStandingAlerts with no exceptKey clears every dedupeKey
    // under the estimate's prefix).
    const newDedupeKey = DEDUPE_KEY(estimateId, [cId]);
    const stillOpen = await readBell(trx, newDedupeKey);
    expect(stillOpen.read_at).toBeNull();

    // Now the anchor's OWN invoice is voided and reissued (a fresh #2 for
    // the SAME anchor visit), minted AFTER B's own split invoice — the
    // exact combination that broke an earlier "earliest invoice wins"
    // heuristic (Codex on head daf724131f): the reissue is "younger" than
    // B's own invoice, so age alone can't tell them apart. C is still
    // uncovered throughout.
    await trx('invoices').where({ id: anchorInvoiceId }).update({ status: 'void' });
    const anchorReplacementId = randomUUID();
    await trx('invoices').insert({
      id: anchorReplacementId, customer_id: customerId, scheduled_service_id: anchorId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 200, amount: 200 }]),
      subtotal: 200, total: 200, created_at: new Date('2026-09-10T00:00:00Z'),
    });

    const [afterReissue] = await sweepOnce(trx, estimateId);
    expect(afterReissue.action).toBe('alerted');
    expect(afterReissue.divergingSiblingIds).toEqual([cId]);
    const stillOpenAfterReissue = await readBell(trx, newDedupeKey);
    expect(stillOpenAfterReissue.read_at).toBeNull();
    const meta = typeof stillOpenAfterReissue.metadata === 'string' ? JSON.parse(stillOpenAfterReissue.metadata) : stillOpenAfterReissue.metadata;
    expect(meta.invoiceId).toBe(anchorReplacementId);
  }));

  // Codex on head 5531a784ac: the opposite failure mode from the tests
  // above. A THREE-program group where C stays ALIGNED with the true
  // anchor A the whole time — only B moves and gets split off. Evaluating
  // B AS an anchor (the union-of-all-candidates fix) computes divergence
  // BACKWARDS from B's own (moved) date: it reads C, which never moved at
  // all, as "diverging FROM B" and manufactures a false alert about a
  // sibling that needs no action whatsoever. The established-anchor
  // mechanism must never let B become a reference frame in the first
  // place once A is already established.
  test('C stays aligned with A after B splits off — never a false alert about C', () => rollbackTest(async (trx) => {
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
    const bogusCAlert = await readBell(trx, DEDUPE_KEY(estimateId, [cId]));
    expect(bogusCAlert).toBeUndefined();
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

  // PR #5021 Codex r6 (head 2168cb0877): a completed sibling used to be
  // excluded from divergence on the theory that completion is a "settled
  // fact" — but completing a visit never settles or rewrites the
  // still-open COMBINED invoice, so the office lost the alert the moment
  // the moved sibling finished. A completed sibling now still alerts.
  test('a completed sibling still alerts — completion never settles the still-open combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', completed_at: new Date() });
    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);
  }));

  // The ONLY exclusion divergingSiblings still relies on (Codex round-6 P1
  // at head 2168cb0877): a CANCELLED sibling was never going to be
  // serviced, so it drops out of the group entirely at loadGroupMembers's
  // own query level — never treated as diverging, never alerted on.
  test('a cancelled sibling is excluded from the group entirely — no alert even though its date diverges', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', status: 'cancelled' });
    const results = await sweepOnce(trx, ids.estimateId);
    // The cancelled sibling drops out at loadGroupMembers, leaving only the
    // anchor — fewer than two members, so the group itself dissolves
    // ('no_group'), never an 'alerted' verdict.
    expect(results.every((r) => r.action !== 'alerted')).toBe(true);
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

  test('an alert-write failure surfaces per-candidate — the failing estimate is reported, never silently dropped', () => rollbackTest(async (trx) => {
    const notificationService = require('../services/notification-service');
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const spy = jest.spyOn(notificationService, 'notifyAdmin').mockRejectedValueOnce(new Error('injected notifyAdmin failure'));
    try {
      const candidates = await loadCandidates(trx);
      const mine = candidates.filter((c) => c.source_estimate_id === ids.estimateId);
      await expect(evaluateEstimateCandidates(trx, mine)).rejects.toThrow('injected notifyAdmin failure');
    } finally {
      spy.mockRestore();
    }
  }));
});
