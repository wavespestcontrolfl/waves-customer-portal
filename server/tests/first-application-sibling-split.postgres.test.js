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
    representativeCandidatesByEstimate,
    evaluateCandidate,
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

  // Runs the sweep's own candidate-discovery + per-candidate evaluation on
  // ONE connection (the test's own transaction) — the same two calls
  // runFirstApplicationSiblingSplitSweep makes per candidate, just without
  // the outer runExclusive lock or the per-candidate transaction split
  // (rollbackTest already isolates the whole test in one transaction).
  async function sweepOnce(trx, estimateId) {
    const candidates = await loadCandidates(trx);
    // Same consolidation runFirstApplicationSiblingSplitSweep applies
    // (Codex round-3 P1) — never evaluate a stale/settled invoice candidate
    // and its live replacement as two independent groups.
    const representatives = representativeCandidatesByEstimate(candidates);
    const mine = representatives.filter((c) => c.source_estimate_id === estimateId);
    const results = [];
    for (const candidate of mine) {
      results.push(await evaluateCandidate(trx, candidate));
    }
    return results;
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
  // to its own scheduled_service_id, AND actually reducing the combined
  // invoice's total to stop double-billing the sibling — must stop the
  // alert on its own, without relying on any invoice title/notes text.
  test('a COMPLETE manual split (own invoice + combined total reduced), both unpaid → no alert, existing alert cleared', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office completes the FULL instructed manual split: the sibling visit
    // gets its OWN live invoice, linked to its own scheduled_service_id —
    // same linkage findFirstApplicationInvoiceForEstimateService uses
    // elsewhere — AND the combined invoice is reduced by the sibling's
    // carved-out share (153.60 - 42 = 111.60). Both invoices stay unpaid —
    // ownership + a real reduction are the signal, not settlement.
    const lawnInvoiceId = randomUUID();
    await trx('invoices').insert({
      id: lawnInvoiceId, customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({
      subtotal: 111.60, total: 111.60,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 111.60, amount: 111.60 }]),
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('split_completed');

    const cleared = await readBell(trx, dedupeKey);
    expect(cleared.read_at).not.toBeNull();
    const metadata = typeof cleared.metadata === 'string' ? JSON.parse(cleared.metadata) : cleared.metadata;
    expect(metadata.autoCleared).toBe(true);

    // The visit's OWN price and the invoice split amounts are never
    // touched by the sweep — only the office's own manual edits above.
    const pest = await trx('scheduled_services').where({ id: ids.pestId }).first();
    expect(Number(pest.estimated_price)).toBe(153.60);
  }));

  // Codex round-6 P1: the same auto-generated invoice can ALSO bundle a
  // one-time setup fee beside the application line (estimate-converter.js
  // / routes/estimate-public.js). A raw-total comparison would read this
  // correctly-completed split as still short — or even MORE than the
  // original — since the fee inflates the total above anchor.estimated_price
  // (which is application-only). The reduction must be measured on the
  // application-only portion of the invoice.
  test('a COMPLETE manual split on an invoice that ALSO carries a setup fee → clears correctly', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    // The combined invoice ALSO bills a $100 WaveGuard setup fee beside
    // the $153.60 application — raw total 253.60, application-only 153.60.
    await trx('invoices').where({ id: ids.invoiceId }).update({
      subtotal: 253.60, total: 253.60,
      line_items: JSON.stringify([
        { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 100, amount: 100 },
        { description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 },
      ]),
    });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Office splits: sibling gets its own $42 invoice, and the combined
    // invoice's APPLICATION line drops to 111.60 — the setup fee line is
    // untouched (it was never part of the sibling's charge).
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });
    await trx('invoices').where({ id: ids.invoiceId }).update({
      subtotal: 211.60, total: 211.60,
      line_items: JSON.stringify([
        { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 100, amount: 100 },
        { description: 'First service application', quantity: 1, unit_price: 111.60, amount: 111.60 },
      ]),
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('cleared');
    expect(result.reason).toBe('split_completed');

    const cleared = await readBell(trx, dedupeKey);
    expect(cleared.read_at).not.toBeNull();
  }));

  // Codex round-4 P1: a sibling's own live invoice is proof the office
  // STARTED the split, never proof they FINISHED it — the combined
  // invoice can still carry the sibling's full original charge even after
  // a brand-new sibling invoice exists. That is an unresolved duplicate
  // charge, and the alert must keep ringing until the combined invoice is
  // actually reduced.
  test('a sibling invoice is created but the COMBINED invoice total is left unchanged → still alerts', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await sweepOnce(trx, ids.estimateId);
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // A new $42 sibling invoice exists, but the combined $153.60 invoice
    // is untouched — the sibling's charge is still double-billed.
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 42, amount: 42 }]),
      subtotal: 42, total: 42,
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId]);

    const stillOpen = await readBell(trx, dedupeKey);
    expect(stillOpen.read_at).toBeNull();

    const sharedInvoice = await trx('invoices').where({ id: ids.invoiceId }).first();
    expect(Number(sharedInvoice.total)).toBe(153.60);
  }));

  // Codex round-5 P1: a THREE-program group (one reserved slot selling
  // three recurring programs) where BOTH diverging siblings pick up their
  // own invoice, but the combined invoice is only reduced enough to cover
  // ONE of their amounts. Which sibling the partial reduction actually
  // covers can't be attributed from the numbers alone, so BOTH stay
  // alerted — never a silent partial clear.
  test('a partially completed THREE-program split (two siblings, only one amount removed) keeps alerting on both', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { reservedPrice: 200 });
    // A third program off the same estimate/trip, un-priced like the lawn
    // sibling — the same "promoted parent left estimated_price NULL"
    // pattern the module header describes.
    const treeId = randomUUID();
    await trx('scheduled_services').insert({
      id: treeId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: SAME_DATE,
      service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: null,
    });

    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    await trx('scheduled_services').where({ id: treeId }).update({ scheduled_date: '2026-10-03' });
    const [firstResult] = await sweepOnce(trx, ids.estimateId);
    expect(firstResult.action).toBe('alerted');
    expect(firstResult.divergingSiblingIds).toEqual([ids.lawnId, treeId].map(String).sort());
    const dedupeKey = DEDUPE_KEY(ids.estimateId, [ids.lawnId, treeId]);
    expect((await readBell(trx, dedupeKey)).read_at).toBeNull();

    // Both siblings get their own invoice ($60 lawn, $90 tree — need $150
    // total removed from the combined $200 invoice)...
    await trx('invoices').insert([
      {
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'Lawn Care', notes: 'Hand-split from the combined first-application invoice.',
        line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 60, amount: 60 }]),
        subtotal: 60, total: 60,
      },
      {
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: treeId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
        status: 'draft', title: 'Tree & Shrub', notes: 'Hand-split from the combined first-application invoice.',
        line_items: JSON.stringify([{ description: 'Tree & Shrub', quantity: 1, unit_price: 90, amount: 90 }]),
        subtotal: 90, total: 90,
      },
    ]);
    // ...but the combined invoice is reduced by only $60 (200 → 140), not
    // the full $150 — an unresolved duplicate charge for the tree sibling.
    await trx('invoices').where({ id: ids.invoiceId }).update({
      subtotal: 140, total: 140,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 140, amount: 140 }]),
    });

    const [result] = await sweepOnce(trx, ids.estimateId);
    expect(result.action).toBe('alerted');
    expect(result.divergingSiblingIds).toEqual([ids.lawnId, treeId].map(String).sort());

    const stillOpen = await readBell(trx, dedupeKey);
    expect(stillOpen.read_at).toBeNull();
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

  test('invoice text unrecognizable — never a sweep candidate, no alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { matchInvoiceText: false });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results).toEqual([]);
  }));

  test('no first-application invoice at all — never a sweep candidate, no alert', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { noInvoice: true });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-02' });
    const results = await sweepOnce(trx, ids.estimateId);
    expect(results).toEqual([]);
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

  test('an already-completed sibling is a settled fact, not a diverging candidate', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx);
    await trx('scheduled_services').where({ id: ids.lawnId })
      .update({ scheduled_date: '2026-10-02', completed_at: new Date() });
    const results = await sweepOnce(trx, ids.estimateId);
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
      const mine = candidates.find((c) => c.source_estimate_id === ids.estimateId);
      await expect(evaluateCandidate(trx, mine)).rejects.toThrow('injected notifyAdmin failure');
    } finally {
      spy.mockRestore();
    }
  }));
});
