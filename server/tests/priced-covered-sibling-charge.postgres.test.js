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
  const { resolveScheduledServiceCharge } = require('../routes/admin-schedule')._test;
  const { perApplicationCompletionVoidHold } = require('../services/billing-lane');
  const {
    findFirstApplicationInvoiceForEstimateService, isPricedCoveredMemberVisit,
  } = require('../services/estimate-first-application-invoice');

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
  }));

  test('...and Charge Now refuses the same way for a still-OPEN (sent) combined invoice', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'sent' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const result = await chargeNow(lawn, trx);
    expect(result).toMatchObject({ refused: true, reason: 'sibling_invoice_covered' });
  }));

  test('...and Charge Now refuses with REFUSE AFTER A VOID when the combined invoice is void with no live replacement', () => rollbackTest(async (trx) => {
    const ids = await fixture(trx, { invoiceStatus: 'void' });
    const lawn = await trx('scheduled_services').where({ id: ids.lawnId }).first();
    const result = await chargeNow(lawn, trx);
    expect(result).toMatchObject({ refused: true, reason: 'sibling_invoice_needs_review' });
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
});
