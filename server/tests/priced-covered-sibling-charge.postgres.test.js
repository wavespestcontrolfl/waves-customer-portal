/**
 * Priced COVERED-MEMBER sibling — no double charge (Codex round 21 P1 on
 * PR #5021, deferred to this follow-up PR by the owner).
 *
 * PR #5021 records same-trip coverage durably: a combined first-application
 * invoice's own scheduled_service_id names its ANCHOR, and
 * scheduled_services.first_application_invoice_id is stamped on the anchor
 * AND every covered member (estimate-converter.js
 * stampCombinedFirstApplicationInvoiceCoverage). But every mint path's own
 * sibling-coverage GATE (isSiblingCoverageEligibleVisit, billing-lane.js)
 * required `!hasOwnPrice` — so a member staff priced AFTER the combined
 * invoice already existed (a legitimate, ordinary office action: "let's
 * charge lawn separately going forward") made the visit look ineligible for
 * the sibling-coverage lookup, and Charge Now / completion's own REFUSE
 * AFTER A VOID guard fell straight through to the visit's OWN price —
 * minting a SECOND charge beside the sibling's already-paid invoice, or
 * skipping the void hold entirely.
 *
 * This suite proves the fix against a REAL, migrated Postgres database
 * (schema, columns, and the real firstApplicationCandidateQuery SQL — not a
 * hand-typed mock): a priced NON-ANCHOR row stamped to another row's
 * invoice must reach the exact same verdict the unpriced path always
 * reached (paid/open → refuse; void with no live replacement → REFUSE
 * AFTER A VOID), while the ANCHOR's own priced mint and an unrelated
 * unstamped priced row under the same estimate stay byte-identical.
 *
 * Run with SIBLING_RESPLIT_TEST_DATABASE_URL (+ DATABASE_URL, same value)
 * pointing to a disposable local, managed worktree QA, or isolated CI
 * database — mirrors first-application-sibling-split.postgres.test.js's own
 * gating verbatim. Every fixture rolls back.
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
  throw new Error('Priced-covered-sibling tests require a dedicated local sibling_resplit, managed worktree QA, or isolated CI database.');
}
const suite = local || managed || ci ? describe : describe.skip;

suite('priced covered-member sibling — no double charge (Codex r21 P1, PR #5021 follow-up)', () => {
  let db;
  const { resolveScheduledServiceCharge, siblingCoverageRecheckInTrx } = require('../routes/admin-schedule')._test;
  const { perApplicationCompletionVoidHold, siblingCoverageForSchedule } = require('../services/billing-lane');
  const {
    findFirstApplicationInvoiceForEstimateService, isPricedCoveredMemberVisit, pricedCoveredMemberOwnRefundHold,
    refuseCoveredMemberMintInTrx, stampGroupRevalidated,
  } = require('../services/estimate-first-application-invoice');
  const { acquireScheduledMintLockChain } = require('../services/scheduled-invoice-mint');
  const { completionTerminalInvoiceLookup } = require('../services/completion-invoice-candidate');

  beforeAll(() => { db = require('knex')({ client: 'pg', connection: testUrl }); });
  afterAll(async () => { await db?.destroy(); await require('../models/db').destroy(); });

  async function rollbackTest(fn) {
    const trx = await db.transaction();
    try { await fn(trx); } finally { await trx.rollback(); }
  }

  const SAME_DATE = '2026-10-01';
  const RESERVED_PRICE = 153.60;

  // A reserved pest anchor (priced — the invoice-holder) + a promoted lawn
  // sibling, accepted together off the same estimate/day, mirroring a
  // genuine same-trip accept. Both stamped to the SAME combined invoice,
  // exactly like estimate-converter.js's own accept-time write. `siblingPrice`
  // (default a positive number) models staff pricing the covered sibling
  // AFTER the fact — the exact shape this fix widens for; pass `null` to
  // leave it the ordinary unpriced covered member.
  async function fixture(trx, { invoiceStatus = 'paid', siblingPrice = 65 } = {}) {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic priced-covered-member fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted' });
    await trx('scheduled_services').insert({
      id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: 'Quarterly Pest Control', status: 'confirmed', is_recurring: true,
      estimated_price: RESERVED_PRICE,
    });
    await trx('scheduled_services').insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: 'Lawn Care', status: 'confirmed', is_recurring: true,
      estimated_price: null,
    });
    const invoiceId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: pestId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: invoiceStatus,
      title: 'First Service Application',
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: RESERVED_PRICE, amount: RESERVED_PRICE }]),
      subtotal: RESERVED_PRICE, total: RESERVED_PRICE,
    });
    // Mirrors estimate-converter.js stampCombinedFirstApplicationInvoiceCoverage:
    // the anchor AND every covered member are stamped, once, inside the
    // accept transaction.
    await trx('scheduled_services').whereIn('id', [pestId, lawnId]).update({ first_application_invoice_id: invoiceId });
    if (siblingPrice != null) {
      // Staff price the covered sibling AFTER the stamp already exists —
      // the exact shape this fix widens isSiblingCoverageEligibleVisit for.
      await trx('scheduled_services').where({ id: lawnId }).update({ estimated_price: siblingPrice });
    }
    return {
      customerId, estimateId, pestId, lawnId, invoiceId,
    };
  }

  function chargeNow(svc, dbConn) {
    return resolveScheduledServiceCharge({
      estimatedPrice: svc.estimated_price, isCallback: false, monthlyRate: null, billingMode: 'per_application',
      serviceType: svc.service_type, svc, dbConn,
    });
  }

  test('Charge Now refuses a second charge for a priced covered sibling with a PAID combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const result = await chargeNow(lawn, trx);
    expect(result).toEqual({
      refused: true,
      reason: 'sibling_invoice_covered',
      message: expect.stringMatching(/combined trip invoice/i),
    });
    // Codex r5 P2: a PAID combined invoice is never "collect on that invoice".
    expect(result.message).toMatch(/already paid — do not collect again/);
    expect(result.message).not.toMatch(/collect on that invoice/);
  }));

  test('...and Charge Now refuses the same way for a still-OPEN (sent) combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const result = await chargeNow(lawn, trx);
    expect(result).toMatchObject({ refused: true, reason: 'sibling_invoice_covered' });
    expect(result.message).toMatch(/collect on that invoice/);
  }));

  test('...and Charge Now refuses with REFUSE AFTER A VOID when the combined invoice is void with no live replacement', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'void' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const result = await chargeNow(lawn, trx);
    expect(result).toMatchObject({ refused: true, reason: 'sibling_invoice_needs_review' });
  }));

  // #5237 review P2s: the priced refusal never tells staff to "set a price"
  // (it already has one); a stamped sibling the office split off by hand
  // (its own live base-application invoice) is no longer a covered member;
  // and (r2 P2) the copy never points at the Invoices page's manual-create
  // endpoint to "split it off" — that endpoint only links via
  // serviceRecordId, which a pre-completion visit has none of yet, so the
  // instruction was a dead end that would just 409 on the next Charge Now.
  // A still-collectible (sent) combined invoice: the only state whose copy
  // says to collect on it (Codex r5 P2 — a paid one says "already paid").
  test('the priced covered refusal copy never offers "set a price" or the dead-end "Invoices page" split, and stays honest', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const result = await chargeNow(lawn, trx);
    expect(result.message).not.toMatch(/set a price/i);
    expect(result.message).not.toMatch(/invoices page/i);
    expect(result.message).toMatch(/combined trip invoice/i);
    expect(result.message).toMatch(/adjust the combined invoice/i);
  }));

  test('a stamped priced sibling split off by hand (own live base-application invoice) is not refused and is not a covered member', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid' });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent', title: 'Lawn Care',
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 65, amount: 65 }]),
      subtotal: 65, total: 65,
    });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    expect(await isPricedCoveredMemberVisit(lawn, trx)).toBe(false);
    expect(await chargeNow(lawn, trx)).toBe(65);
  }));

  test('a VOID own invoice on the sibling is not split evidence — still refused', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid' });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'void', title: 'Lawn Care',
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 65, amount: 65 }]),
      subtotal: 65, total: 65,
    });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    expect(await chargeNow(lawn, trx)).toMatchObject({ refused: true, reason: 'sibling_invoice_covered' });
  }));

  test('the PRICED ANCHOR row is never refused — mints its own priced amount unchanged', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid' });
    const pest = await trx('scheduled_services').where({ id: ids.pestId }).first();
    const result = await chargeNow(pest, trx);
    expect(result).toBe(RESERVED_PRICE);
  }));

  test('an UNSTAMPED priced row under the same estimate is never refused — unchanged', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid', siblingPrice: null });
    // A third, unrelated priced visit under the SAME estimate that was
    // never part of the combined-invoice group at all (never stamped).
    const otherId = randomUUID();
    await trx('scheduled_services').insert({
      id: otherId, customer_id: ids.customerId, source_estimate_id: ids.estimateId, scheduled_date: '2026-11-15',
      service_type: 'Tree & Shrub', status: 'confirmed', is_recurring: true, estimated_price: 40,
    });
    const other = await trx('scheduled_services').where({ id: otherId }).first();
    const result = await chargeNow(other, trx);
    expect(result).toBe(40);
  }));

  test('completion\'s own void hold (perApplicationCompletionVoidHold) fires for the priced covered sibling when the combined invoice is void with no live replacement', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'void' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const hold = await perApplicationCompletionVoidHold({
      isCallback: false, serviceType: lawn.service_type, svc: lawn, dbConn: trx,
    });
    expect(hold?.id).toBe(ids.invoiceId);
  }));

  test('completion\'s own void hold never fires for the PRICED ANCHOR row, even for that same voided invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'void' });
    const pest = await trx('scheduled_services').where({ id: ids.pestId }).first();
    const hold = await perApplicationCompletionVoidHold({
      isCallback: false, serviceType: pest.service_type, svc: pest, dbConn: trx,
    });
    expect(hold).toBeNull();
  }));

  // Not a regression test — completion's PRIMARY mint decision
  // (findFirstApplicationInvoiceForEstimateService) was never gated on
  // price at all, so it already reused a live sibling invoice for a priced
  // covered member before this fix. Pinned here against a real DB so this
  // fix's Charge Now / void-hold widening can never drift from it.
  test('completion already reuses the PAID combined invoice for a priced covered sibling (confirms existing correct behaviour)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const found = await findFirstApplicationInvoiceForEstimateService(lawn, trx);
    expect(found.invoice?.id).toBe(ids.invoiceId);
  }));

  test('isPricedCoveredMemberVisit against real rows: true for the sibling, false for the anchor', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'paid' });
    const [pest, lawn] = await Promise.all([
      trx('scheduled_services').where({ id: ids.pestId }).first(),
      trx('scheduled_services').where({ id: ids.lawnId }).first(),
    ]);
    await expect(isPricedCoveredMemberVisit(lawn, trx)).resolves.toBe(true);
    await expect(isPricedCoveredMemberVisit(pest, trx)).resolves.toBe(false);
  }));

  // #5237 review r2 P1: siblingCoverageRecheckInTrx's outer sync gate used
  // to predict "maybe a covered member" off svc's OWN pre-lock
  // first_application_invoice_id column — stale the moment a stamp lands
  // between the route's read and the mint transaction's own row lock
  // (reconcileRecentUnstampedAccepts / stampGroupRevalidated can commit
  // right there). Proven against a REAL DB: read svc BEFORE the stamp
  // exists, stamp it (mirroring that reconciliation write), then run the
  // in-lock recheck against the SAME pre-lock svc snapshot.
  test('a stamp committed AFTER svc was read is still caught by the in-lock recheck (real DB)', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    // svc as the route would have read it BEFORE the sibling was stamped —
    // clear the stamp first, capture that pre-lock snapshot, then commit
    // the stamp (the race window this fix closes).
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ first_application_invoice_id: null });
    const preLockSvc = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    expect(preLockSvc.first_application_invoice_id).toBeNull();
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ first_application_invoice_id: ids.invoiceId });

    const recheckInTrx = siblingCoverageRecheckInTrx(preLockSvc);
    expect(typeof recheckInTrx).toBe('function');
    await expect(recheckInTrx(trx)).rejects.toMatchObject({ code: 'SIBLING_COVERAGE_CHANGED' });
  }));

  test('...and the ANCHOR\'s own pre-lock snapshot closure is STILL a no-op under the same real-DB lock', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent' });
    const preLockPest = await trx('scheduled_services').where({ id: ids.pestId }).first();
    const recheckInTrx = siblingCoverageRecheckInTrx(preLockPest);
    await expect(recheckInTrx(trx)).resolves.toBeUndefined();
  }));

  // #5237 review r2 P2: a priced covered member whose OWN base-application
  // invoice is REFUNDED (the combined invoice stays LIVE) must reach
  // 'needs_review' — the SAME verdict completion's own classifier
  // (completionTerminalInvoiceLookup) reaches by checking this visit's own
  // refund FIRST — on all three surfaces, proven together against a real
  // DB so they can never drift apart.
  // Codex r3 P2 on #5237: an own REFUNDED invoice beside a LIVE replacement
  // is still review (completion parks on the coexistence — the refund may
  // fail and restore the original payment), never "split off, collect".
  test('own refunded invoice + a live replacement: Charge Now and the schedule sheet still hold for review', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    const line = JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 65, amount: 65 }]);
    for (const status of ['refunded', 'sent']) {
      await trx('invoices').insert({
        id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
        token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status, title: 'Lawn Care',
        line_items: line, subtotal: 65, total: 65,
      });
    }
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    expect(await isPricedCoveredMemberVisit(lawn, trx)).toBe(true);
    expect(await chargeNow(lawn, trx)).toMatchObject({ refused: true, reason: 'sibling_invoice_needs_review' });
    const { coverage } = await siblingCoverageForSchedule({ svc: lawn, dbConn: trx });
    expect(coverage.state).toBe('review');
  }));

  // Codex r3 P1 on #5237: completion loaded the visit BEFORE the sweep
  // stamped it and the sibling has since moved off the anchor's date. A
  // stale NULL on svc is re-read by id, so the stamped lookup still finds the
  // combined invoice instead of date-matching nothing and minting again.
  test('a stale NULL stamp on a moved sibling is re-read: completion\'s lookup still finds the combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    await trx('scheduled_services').where({ id: ids.lawnId }).update({ scheduled_date: '2026-10-09' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const staleSnapshot = { ...lawn, first_application_invoice_id: null };
    const found = await findFirstApplicationInvoiceForEstimateService(staleSnapshot, trx);
    expect(found.invoice?.id).toBe(ids.invoiceId);
    expect(await isPricedCoveredMemberVisit(staleSnapshot, trx)).toBe(true);
  }));

  test('a priced covered member with its OWN refunded base-application invoice agrees across Charge Now, schedule prediction, and completion\'s own classifier', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    const ownRefundId = randomUUID();
    await trx('invoices').insert({
      id: ownRefundId, customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`,
      status: 'refunded', title: 'Lawn Care',
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 65, amount: 65 }]),
      subtotal: 65, total: 65,
    });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();

    // Completion's own classifier — the source of truth this fix mirrors.
    const completionSeesRefund = await completionTerminalInvoiceLookup(trx, { scheduledServiceId: ids.lawnId });
    expect(completionSeesRefund?.id).toBe(ownRefundId);

    // pricedCoveredMemberOwnRefundHold reuses that SAME classifier.
    const ownRefundHold = await pricedCoveredMemberOwnRefundHold(lawn, trx);
    expect(ownRefundHold?.id).toBe(ownRefundId);

    // Charge Now.
    const chargeNowResult = await resolveScheduledServiceCharge({
      estimatedPrice: lawn.estimated_price, isCallback: false, monthlyRate: null, billingMode: 'per_application',
      serviceType: lawn.service_type, svc: lawn, dbConn: trx,
    });
    expect(chargeNowResult).toMatchObject({ refused: true, reason: 'sibling_invoice_needs_review' });

    // Schedule prediction.
    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: lawn, dbConn: trx });
    expect(coverage.state).toBe('review');
    expect(prediction.kind).toBe('sibling_needs_review');
  }));

  // Codex r4 P1 on #5237 — completion's mint lock and the stamper lock the
  // SAME scheduled_services row, so whichever commits first decides. Half 1:
  // a stamp that committed before the mint lock is seen under it and refuses.
  test('completion mint guard: a stamp committed after the pre-lock lookup refuses the mint under the visit lock', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    await acquireScheduledMintLockChain(trx, { scheduledServiceId: ids.lawnId, customerId: ids.customerId });
    await expect(refuseCoveredMemberMintInTrx(trx, ids.lawnId)).rejects.toMatchObject({
      code: 'FIRST_APPLICATION_COVERED', status: 409,
    });
  }));

  test('completion mint guard never refuses the ANCHOR, an unstamped visit, or a member split off by hand', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    await expect(refuseCoveredMemberMintInTrx(trx, ids.pestId)).resolves.toBeUndefined();
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent', title: 'Lawn Care',
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 65, amount: 65 }]),
      subtotal: 65, total: 65,
    });
    await expect(refuseCoveredMemberMintInTrx(trx, ids.lawnId)).resolves.toBeUndefined();
    const other = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: 65 });
    await trx('scheduled_services').where({ id: other.lawnId }).update({ first_application_invoice_id: null });
    await expect(refuseCoveredMemberMintInTrx(trx, other.lawnId)).resolves.toBeUndefined();
  }));

  // Half 2: a mint that committed first leaves the visit its own live
  // invoice, and the stamper (which locks the same rows) then skips it.
  test('the stamper never stamps a sibling whose own invoice was minted first', () => rollbackTest(async (trx) => {
    // Control: the same unstamped group WITHOUT an own invoice is stamped.
    const control = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: null });
    await trx('scheduled_services').whereIn('id', [control.pestId, control.lawnId]).update({ first_application_invoice_id: null });
    expect(await stampGroupRevalidated(trx, { invoiceId: control.invoiceId, anchorId: control.pestId, siblingIds: [control.lawnId] })).toBe(2);

    const ids = await fixture(trx, { invoiceStatus: 'sent', siblingPrice: null });
    await trx('scheduled_services').whereIn('id', [ids.pestId, ids.lawnId]).update({ first_application_invoice_id: null });
    await trx('invoices').insert({
      id: randomUUID(), customer_id: ids.customerId, scheduled_service_id: ids.lawnId,
      token: randomUUID(), invoice_number: `WPC-TEST-${randomUUID().slice(0, 8)}`, status: 'sent', title: 'Lawn Care',
      line_items: JSON.stringify([{ client_id: `scheduled_${ids.lawnId}_primary`, description: 'Lawn Care', quantity: 1, unit_price: 65, amount: 65 }]),
      subtotal: 65, total: 65,
    });
    expect(await stampGroupRevalidated(trx, { invoiceId: ids.invoiceId, anchorId: ids.pestId, siblingIds: [ids.lawnId] })).toBe(0);
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first('first_application_invoice_id');
    expect(lawn.first_application_invoice_id).toBeNull();
  }));
});
