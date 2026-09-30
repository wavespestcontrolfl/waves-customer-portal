/**
 * Bill-by-invoice (invoice-mode) public accept — ROUTE-LEVEL, against a REAL
 * migrated Postgres database (schema, columns, the real router, the real
 * EstimateConverter.convertEstimate, and the real
 * EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage — not a
 * hand-typed mock, and not a mocked convertEstimate).
 *
 * Gap this closes: server/routes/estimate-public.js's public accept mints
 * the invoice-mode ("bill by invoice") first-application invoice BEFORE
 * EstimateConverter.convertEstimate() runs. For a multi-program accept with
 * no pre-existing linked visit (acceptLinkedSsId null — a brand-new slot),
 * the invoice is minted with NO scheduled_service_id at all; only AFTER
 * convertEstimate() creates the anchor row does the route attach the
 * invoice to it (invoiceModeAnchorId = acceptLinkedSsId ||
 * standardConversionResult.firstScheduledServiceId) and call
 * EstimateConverter.stampCombinedFirstApplicationInvoiceCoverage(trx, {
 * invoiceId, anchorId, memberIds: standardConversionResult.
 * combinedInvoiceMemberIds }) (estimate-public.js ~12278-12291,
 * estimate-converter.js:2048). Every existing test either mocks
 * convertEstimate + the stamper entirely (estimate-public-accept-
 * atomicity.test.js's Codex-round-15 case only proves the ROUTE calls the
 * mocked stamper with the right ids) or hand-writes the post-accept row
 * shape directly with no real accept ever run (first-application-sibling-
 * split.postgres.test.js). Nothing drives a REAL successful invoice-mode
 * mint through the real converter and asserts the REAL stamped columns.
 *
 * Fixture: a customer with an already-linked estimate (customer_id set, so
 * the route's customer-resolution branch is a no-op) opted into
 * bill_by_invoice, offering two DIFFERENT recurring programs (Pest Control +
 * Lawn Care) with no stored pricing bundle/frequency ladder — the accept
 * handler's pricing fallback (resolveRecurringFirstVisitAmount, reading each
 * service row's own mo/visitsPerYear/perTreatment fields) resolves the
 * combined first-application amount without needing the full estimator
 * pricing-bundle machinery. recurringUnitCount === 2 leaves BOTH auto-
 * scheduled rows unpriced (estimated_price NULL) — the real converter's
 * P1-B branch (isAutoScheduledCombinedInvoiceSibling) then pushes the
 * second program's row into combinedInvoiceMemberIds, and the anchor is the
 * first program's row (firstScheduledServiceId). No slotId, no
 * existingAppointmentId ⇒ acceptLinkedSsId is null (branch (a) in the task:
 * no pre-linked visit / new slot).
 *
 * A second suite of tests below covers branch (b): a two-program accept
 * where the estimate ALREADY has a reserved/linked visit at accept time
 * (acceptLinkedSsId non-null). The fixture seeds a real scheduled_services
 * row with source_estimate_id = the estimate, a real customer_id and no
 * reservation_expires_at — the exact shape a committed reservation (or an
 * adopted existing appointment) leaves behind, and the same shape
 * linkedScheduledServiceId's own findLinkedUpcomingAppointment query and
 * convertEstimate's own `existingFromReservation` probe both key on. With
 * that row present, the accept handler's acceptLinkedSsId resolves to it
 * BEFORE the invoice mints, so the invoice is attached to it directly (never
 * re-attached after convertEstimate runs), and convertEstimate takes its
 * "reservationRowsExist" branch: the reserved row is the anchor
 * (firstScheduledServiceId), and the estimate's second recurring program
 * (Lawn Care) — which cannot combine onto the same visit — is PROMOTED onto
 * its own new same-trip row (estimate-converter.js's promotedLawnPalmUnits)
 * and pushed into combinedInvoiceMemberIds at the moment of insertion.
 *
 * Only genuine side-effect modules are mocked (SMS/email/Stripe-adjacent/
 * short-url/logger/notifications) — EstimateConverter, InvoiceService, and
 * every DB read/write run for real against Postgres, inside a single test
 * transaction that always rolls back (mirrors billing-recovery-sibling-
 * coverage.postgres.test.js's db mock: jest.mock('../models/db') routed to
 * a per-test knex transaction, with db.schema mirrored so the route's own
 * schema probes never fall back silently).
 *
 * Run with SIBLING_RESPLIT_TEST_DATABASE_URL (+ DATABASE_URL, same value)
 * pointing to a disposable local, managed worktree QA, or isolated CI
 * database. Every fixture rolls back.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
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
  throw new Error('Invoice-mode accept-stamp tests require a dedicated local sibling_resplit, managed worktree QA, or isolated CI database.');
}
const suite = local || managed || ci ? describe : describe.skip;

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  database.fn = { now: () => new Date() };
  // Several routes (this one included) probe db.schema (hasColumn/hasTable)
  // to decide whether a migration has landed — without mirroring it the
  // probe throws and the route silently falls back to legacy behavior.
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});

// Side-effect modules only (SMS/email/Stripe-adjacent/short-url/logger/
// notifications) — EstimateConverter and InvoiceService run for REAL.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  createShortCode: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  createTrackedShortLink: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  resolveShortCode: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({})),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
// NOT mocked: '../services/new-recurring-welcome-sms' — estimate-converter.js
// destructure-imports isNewRecurringSignupCandidate from it directly (a bare
// stub with only sendNewRecurringWelcome breaks that real call), and its own
// send path already routes through the mocked sendCustomerMessage below (it
// only ever QUEUES a DB row for the scheduler to deliver later — no network
// call happens inside the accept transaction either way).
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({})),
}));
jest.mock('../services/appointment-tagger', () => ({
  onServiceScheduled: jest.fn(async () => ({})),
}));
jest.mock('../services/lead-estimate-link', () => ({
  markLinkedLeadEstimateAccepted: jest.fn(async () => ({})),
  markLinkedLeadEstimateViewed: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: false, enforced: false })),
  verifyCardHoldIntent: jest.fn(async () => ({ ok: false })),
  recordCardHoldHeld: jest.fn(async () => ({})),
  attachCardHoldPaymentMethod: jest.fn(async () => ({})),
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({})),
}));
// NOT mocked: '../services/payer' — DB-only (no network side effects), and
// several real callers (services/invoice.js's InvoiceService.create among
// them) destructure its resolved object directly, so a bare `null` stub
// throws inside the real invoice mint this suite needs to run for real.

const express = require('express');
const knex = require('knex');

suite('invoice-mode public accept — real Postgres route + real converter + real stamp', () => {
  let db;
  let server;
  let baseUrl;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    const router = require('../routes/estimate-public');
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', router);
    // Mirror the real error middleware's contract for next(err): 5xx JSON.
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ error: err.message });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => { mockTransaction = await db.transaction(); });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  // Two DIFFERENT recurring programs, each carrying its own explicit
  // visitsPerYear + perTreatment so the accept handler's price fallback
  // (recurringServiceFirstVisitPrice) resolves a real per-visit amount with
  // no stored pricing bundle/frequency ladder at all — anchorPrice comes
  // straight off the row (svc.perTreatment), sidestepping the estimator's
  // full pricing-bundle derivation, which this suite has no need to drive.
  const PEST_PER_VISIT = 45;
  const LAWN_PER_VISIT = 35;
  const COMBINED_FIRST_VISIT = PEST_PER_VISIT + LAWN_PER_VISIT;
  // 9 visits/year = the 'enhanced' lawn tier (every_6_weeks) — the 6x
  // 'standard' tier is hidden/retired (LAWN_TIERS.standard.hidden === true,
  // owner 2026-08-04) and would 409 the accept up front with
  // retired_lawn_cadence_requote before ever reaching the invoice mint.
  const LAWN_VISITS_PER_YEAR = 9;

  async function fixture(trx, { customerId = randomUUID(), estimateId = randomUUID() } = {}) {
    const token = randomUUID().replace(/-/g, '');
    await trx('customers').insert({
      id: customerId,
      first_name: 'Synthetic invoice-mode fixture',
      phone: `qa-${customerId.slice(0, 8)}`,
      email: `qa-${customerId.slice(0, 8)}@example.test`,
      active: true,
    });
    await trx('estimates').insert({
      id: estimateId,
      customer_id: customerId,
      status: 'sent',
      token,
      customer_name: 'Synthetic invoice-mode fixture',
      customer_phone: `qa-${customerId.slice(0, 8)}`,
      customer_email: `qa-${customerId.slice(0, 8)}@example.test`,
      address: '123 Synthetic Ave, Bradenton, FL',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      show_one_time_option: false,
      bill_by_invoice: true,
      category: 'RESIDENTIAL',
      estimate_data: JSON.stringify({
        result: {
          recurring: {
            discount: 0,
            services: [
              {
                name: 'Pest Control', service: 'pest_control', mo: 15,
                visitsPerYear: 4, perTreatment: PEST_PER_VISIT,
              },
              {
                name: 'Lawn Care', service: 'lawn_care', mo: 26.25,
                visitsPerYear: LAWN_VISITS_PER_YEAR, perTreatment: LAWN_PER_VISIT,
              },
            ],
          },
          oneTime: { items: [], membershipFee: 0 },
        },
      }),
    });
    return { customerId, estimateId, token };
  }

  const putAccept = (token, body = {}) => fetch(`${baseUrl}/api/estimates/${token}/accept`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('a two-program invoice-mode accept with no pre-linked visit mints ONE combined invoice, attaches it to the converter\'s anchor, and stamps every same-trip sibling', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);

    const res = await putAccept(token);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.invoiceMode).toBe(true);

    // Exactly ONE invoice-mode invoice exists for this estimate.
    const invoices = await mockTransaction('invoices').where({ customer_id: customerId });
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0];
    expect(Number(invoice.total)).toBeCloseTo(COMBINED_FIRST_VISIT, 2);

    // Both recurring programs were auto-scheduled on the same accept.
    const visits = await mockTransaction('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .orderBy('created_at', 'asc');
    expect(visits).toHaveLength(2);
    // The converter's own catalog naming ("Quarterly Pest Control Service")
    // differs from the estimate line's raw name ("Pest Control") — match
    // loosely rather than assume an exact echo.
    const pestVisit = visits.find((v) => /pest/i.test(v.service_type));
    const lawnVisit = visits.find((v) => /lawn/i.test(v.service_type));
    expect(pestVisit).toBeTruthy();
    expect(lawnVisit).toBeTruthy();

    // invoices.scheduled_service_id = the anchor visit (the FIRST unit the
    // converter inserted — acceptLinkedSsId was null, so the route attached
    // the invoice-mode invoice to the converter's own anchor after the fact).
    expect(invoice.scheduled_service_id).toBeTruthy();
    const anchorId = invoice.scheduled_service_id;
    expect([pestVisit.id, lawnVisit.id]).toContain(anchorId);
    const siblingVisit = anchorId === pestVisit.id ? lawnVisit : pestVisit;

    // scheduled_services.first_application_invoice_id is stamped on the
    // anchor AND on the same-trip sibling program — both point at the SAME
    // combined invoice.
    expect(pestVisit.first_application_invoice_id).toBe(invoice.id);
    expect(lawnVisit.first_application_invoice_id).toBe(invoice.id);
    expect(anchorId).toBeTruthy();
    expect(siblingVisit.first_application_invoice_id).toBe(invoice.id);

    // Both rows were left unpriced by the converter (P1-B: a multi-program
    // accept leaves every auto-scheduled row's estimated_price NULL because
    // the combined invoice — not either row — carries the first-visit
    // amount).
    expect(pestVisit.estimated_price == null).toBe(true);
    expect(lawnVisit.estimated_price == null).toBe(true);
  });

  // The stamper's own single-program guard (estimate-converter.js
  // stampCombinedFirstApplicationInvoiceCoverage: "no memberIds (or none
  // that verify) means no sibling to cover") — proven here against the SAME
  // real accept path, not just the pure-function unit coverage in
  // estimate-converter-combined-invoice-siblings.test.js. A single-program
  // invoice-mode accept mints its invoice, attaches it to the one visit it
  // created, and stamps NOTHING (first_application_invoice_id stays NULL —
  // the sweep's own membership query never sees a "group of one").
  test('control: a SINGLE-program invoice-mode accept stamps nothing (single-program guard)', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    await mockTransaction('estimates').where({ id: estimateId }).update({
      estimate_data: JSON.stringify({
        result: {
          recurring: {
            discount: 0,
            services: [{
              name: 'Pest Control', service: 'pest_control', mo: 15,
              visitsPerYear: 4, perTreatment: PEST_PER_VISIT,
            }],
          },
          oneTime: { items: [], membershipFee: 0 },
        },
      }),
    });

    const res = await putAccept(token);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.invoiceMode).toBe(true);

    const invoices = await mockTransaction('invoices').where({ customer_id: customerId });
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0];
    expect(Number(invoice.total)).toBeCloseTo(PEST_PER_VISIT, 2);

    const visits = await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId });
    expect(visits).toHaveLength(1);
    expect(invoice.scheduled_service_id).toBe(visits[0].id);
    expect(visits[0].first_application_invoice_id == null).toBe(true);
  });

  // Branch (b): the estimate already has a reserved/linked visit at accept
  // time, so acceptLinkedSsId resolves NON-NULL before the invoice mints.
  // Seeds the exact row shape a committed reservation (or an adopted
  // existing appointment) leaves behind — a real scheduled_services row
  // with source_estimate_id = the estimate, a real customer_id, and no
  // reservation_expires_at — which is what BOTH linkedScheduledServiceId's
  // own findLinkedUpcomingAppointment query (acceptLinkedSsId) and
  // convertEstimate's own `existingFromReservation` probe key on. No
  // production write is invented here: this is the durable state either
  // path leaves, not a synthetic shortcut.
  async function reserveAnchorVisit(trx, { customerId, estimateId, serviceType = 'Pest Control' }) {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const reservedId = randomUUID();
    const scheduledDate = etDateString(addETDays(new Date(), 3));
    await trx('scheduled_services').insert({
      id: reservedId,
      customer_id: customerId,
      source_estimate_id: estimateId,
      scheduled_date: scheduledDate,
      window_start: '09:00:00',
      window_end: '11:00:00',
      status: 'confirmed',
      service_type: serviceType,
      is_recurring: false, // the seeder's own markParentRecurring stamps this true once accept seeds its follow-ups
      estimated_price: null, // invoice-mode: the combined invoice bills the trip, never the visit row itself
      reservation_expires_at: null,
    });
    return { reservedId, scheduledDate };
  }

  test('a two-program invoice-mode accept onto an already-reserved visit keeps the invoice on ITS OWN anchor and stamps the promoted sibling', async () => {
    const { customerId, estimateId, token } = await fixture(mockTransaction);
    const { reservedId } = await reserveAnchorVisit(mockTransaction, { customerId, estimateId });

    // Pin the branch (Codex r1 P2 on #5350): the converter would also find
    // the seeded row by source_estimate_id and the route's post-conversion
    // fallback would attach + stamp it, so the end state alone cannot tell
    // the pre-linked branch from the no-pre-link one. Only the pre-linked
    // branch mints the invoice ALREADY carrying the reserved visit
    // (InvoiceService.create's scheduledServiceId = acceptLinkedSsId).
    // Spy, never replace: the real create still runs.
    const InvoiceService = require('../services/invoice');
    const createSpy = jest.spyOn(InvoiceService, 'create');
    let res;
    let mintCalls;
    try {
      res = await putAccept(token);
      // Read before mockRestore(), which clears the recorded calls.
      mintCalls = createSpy.mock.calls.map(([params]) => params);
    } finally {
      createSpy.mockRestore();
    }
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.invoiceMode).toBe(true);
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0].scheduledServiceId).toBe(reservedId);

    // Exactly ONE invoice-mode invoice exists for this estimate.
    const invoices = await mockTransaction('invoices').where({ customer_id: customerId });
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0];
    expect(Number(invoice.total)).toBeCloseTo(COMBINED_FIRST_VISIT, 2);

    // invoices.scheduled_service_id is the PRE-LINKED reserved visit — the
    // invoice keeps its own anchor from mint time; the route's
    // "attach to the converter's anchor" update only fires when
    // acceptLinkedSsId was null, which it was NOT here.
    expect(invoice.scheduled_service_id).toBe(reservedId);

    // The converter promoted the second recurring program (Lawn Care) onto
    // its own new same-trip row, since it cannot combine onto the reserved
    // pest visit — exactly two rows total for this estimate.
    const visits = await mockTransaction('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .orderBy('created_at', 'asc');
    expect(visits).toHaveLength(2);
    const anchorVisit = visits.find((v) => v.id === reservedId);
    const siblingVisit = visits.find((v) => v.id !== reservedId);
    expect(anchorVisit).toBeTruthy();
    expect(siblingVisit).toBeTruthy();
    expect(/lawn/i.test(siblingVisit.service_type)).toBe(true);

    // scheduled_services.first_application_invoice_id is stamped on BOTH
    // the pre-linked anchor AND the promoted same-trip sibling, pointing at
    // the SAME combined invoice.
    expect(anchorVisit.first_application_invoice_id).toBe(invoice.id);
    expect(siblingVisit.first_application_invoice_id).toBe(invoice.id);

    // The promoted sibling is left unpriced (its own row) — the combined
    // invoice, not the row, carries its first-visit amount — and it was
    // stamped recurring by the same seeding step every promoted parent goes
    // through (RecurringAppointmentSeeder.markParentRecurring).
    expect(siblingVisit.estimated_price == null).toBe(true);
    expect(siblingVisit.is_recurring).toBe(true);
  });
});
