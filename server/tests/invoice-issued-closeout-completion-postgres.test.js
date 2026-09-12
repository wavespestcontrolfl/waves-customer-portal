/** Invoice issued ⇒ visit completed, driven through the CANONICAL completion against a migrated database. */
process.env.GATE_INVOICE_ISSUED_CLOSES_VISIT = 'true'; // the gate table is built at module load
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
// The post-service review ask and the LLM recap are both suppressed for an
// invoice-issued closeout: spied, never mocked away, so a regression that
// reaches either shows up as a call.
jest.mock('../services/review-request', () => {
  const actual = jest.requireActual('../services/review-request');
  return { ...actual, enrollPostService: jest.fn(actual.enrollPostService) };
});
jest.mock('../services/completion-recap', () => {
  const actual = jest.requireActual('../services/completion-recap');
  return { ...actual, generateRecap: jest.fn(actual.generateRecap) };
});
// Race injection: a test may run a hook right before the completion claim
// (after the unlocked visit read, before the record transaction's locks).
const mockRace = { beforeClaim: null };
jest.mock('../services/completion-attempts', () => {
  const actual = jest.requireActual('../services/completion-attempts');
  return {
    ...actual,
    claimCompletionAttempt: async (...args) => {
      if (mockRace.beforeClaim) { const hook = mockRace.beforeClaim; mockRace.beforeClaim = null; await hook(); }
      return actual.claimCompletionAttempt(...args);
    },
  };
});
// Annual-prepay coverage is stamped rows + a live term; one test forces the
// coverage verdict to exercise the settlement branch without that fixture.
const mockAnnualPrepay = { covers: false };
jest.mock('../services/annual-prepay-renewals', () => {
  const actual = jest.requireActual('../services/annual-prepay-renewals');
  return { ...actual, annualPrepayCoversVisit: async (...args) => (mockAnnualPrepay.covers ? true : actual.annualPrepayCoversVisit(...args)) };
});

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const { closeOutVisitForIssuedInvoice } = require('../services/invoice-issued-closeout');
const ReviewService = require('../services/review-request');
const CompletionRecap = require('../services/completion-recap');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg; // the per-test transaction while a test runs; the pool between tests
let f;
jest.setTimeout(90000);

describe('source contracts', () => {
  const fs = require('fs');
  const path = require('path');
  test('the issued invoice is re-checked LOCKED inside the record transaction and a miss 409s without committing', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(source).toMatch(/const persistRecord = async \(trx\) => \{[\s\S]{0,6000}if \(issuedInvoiceCloseout\) \{[\s\S]{0,3200}?const issuedNow = await trx\('invoices'\)\.where\(\{ id: issuedInvoiceCloseout\.invoiceId \}\)\.forUpdate\(\)/);
    expect(source).toMatch(/if \(err && err\.code === 'issued_invoice_not_reusable'\) \{\s*\n\s*await CompletionAttempts\.markCompletionAttemptFailed\(completionAttempt, err, db\);/);
  });
  test('the operator\'s resend-receipt route is the reachable retry for the payment-triggered closeout, ahead of both legs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-invoices.js'), 'utf8');
    expect(source).toMatch(/router\.post\('\/:id\/send-receipt'[\s\S]{0,1200}receipt can only be sent for paid invoices[\s\S]{0,900}closeOutVisitForIssuedInvoice\(\{ invoiceId: id, trigger: 'paid', actorTechnicianId: req\.technicianId \|\| null \}\);[\s\S]{0,400}const \{ sendReceiptEmail \} = require/);
  });
  test('the recovered-delivery branch of sendViaSMS runs the closeout too — a recovered send is a durable send', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    // Codex r12 follow-on P1 #4131 round 3: this recovery branch was
    // extracted out of sendViaSMS's catch into its own named function
    // (recoverPostDeliverySmsBookkeeping) — sendViaSMS's outer try/finally
    // guard was pushing the branch's existing nesting past max-depth. The
    // behavior is unchanged: this branch still routes here, and the
    // closeout still runs before the same durable-send return. Pre-push
    // Codex P1 #4131 (this round) widened the guard's condition to also
    // catch a provider-accepted send that THREW before smsDelivered could
    // be assigned (sendCustomerMessage's own post-send-audit-write throw) —
    // the routing destination and its `err` payload are unchanged.
    expect(source).toMatch(/if \(smsDelivered \|\| err\.providerOutcome\?\.sent === true\) \{[\s\S]{0,1200}?return await recoverPostDeliverySmsBookkeeping\(\{[\s\S]{0,300}?err,[\s\S]{0,50}?\}\);/);
    expect(source).toMatch(/async function recoverPostDeliverySmsBookkeeping\([\s\S]{0,5000}?closeOutVisitForIssuedInvoice\(\{ invoiceId, trigger: "sent", actorTechnicianId \}\);[\s\S]{0,600}?return \{ sent: true, payUrl, finalizeError: err\.message \};/);
  });
  test('every hand-payment writer reaches the closeout: /payments/reconcile after its commit, the prepaid receipt on both the newly-paid and already-paid legs (GitHub r4 P1)', () => {
    const reconcile = fs.readFileSync(path.join(__dirname, '../routes/admin-payments-reconcile.js'), 'utf8');
    const commitAt = reconcile.indexOf('txResult = await db.transaction(async (trx) => {');
    const closeoutAt = reconcile.indexOf("closeOutVisitForIssuedInvoice({ invoiceId, trigger: 'paid', actorTechnicianId: req.technicianId || null })");
    expect(commitAt).toBeGreaterThan(-1);
    expect(closeoutAt).toBeGreaterThan(commitAt);
    // …and after the conflict / zero-row refusals, never on a refused reconcile.
    expect(closeoutAt).toBeGreaterThan(reconcile.indexOf("while reconciling — no changes applied"));
    const schedule = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const fn = schedule.slice(schedule.indexOf('async function generatePrepaidReceiptForService('), schedule.indexOf('// POST /api/admin/schedule/:id/prepaid'));
    expect(fn).toMatch(/closeOutVisitForIssuedInvoice\(\{ invoiceId: invoice\.id, trigger: 'paid', actorTechnicianId, actorRole \}\)/);
    expect(fn).toMatch(/if \(\['paid', 'prepaid'\]\.includes\(invoice\.status\)\) \{\s*\n\s*await closeOutOnPaid\(\);/);
    expect(fn).toMatch(/await closeOutOnPaid\(\);\s*\n\s*\n\s*return sendPrepaidReceiptForInvoice\(outcome\.invoice/);
    // The route hands the operator through, WITH its authenticated staff
    // role (GitHub r7 P2 #4127) — a technician (requireTechOrAdmin admits
    // both) must be audited as 'technician', never folded into 'admin'.
    expect(schedule).toMatch(/generatePrepaidReceiptForService\(req\.params\.id, \{ operatorInitiated: true, actorTechnicianId: req\.technicianId \|\| null, actorRole: req\.techRole \|\| null \}\)/);
  });
  test('the pre-claim issued-invoice refusal is skipped for a COMMITTED attempt (pre-push P1 r7)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(source).toMatch(/if \(completionInput\.issuedInvoiceCloseout\s*\n\s*&& !\(await failSoftRead\(db, \(k\) => CompletionAttempts\.hasCommittedCompletionAttempt\(svc\.id, k\), false\)\)\) \{/);
  });
  test('both delivery-side review decisions consult the record provenance (issuedCloseoutOwnsRecord) before enrolling (pre-push P1 r7)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    // sendViaSMSAndEmail: provenance check sits between the payment deferral and the enrollment.
    expect(source).toMatch(/\} else if \(inv && await issuedCloseoutOwnsRecord\(inv\.service_record_id\)\) \{[\s\S]*?\} else if \(inv\) \{\s*\n\s*await ReviewService\.enrollPostService\(\{\s*\n\s*customerId: inv\.customer_id,/);
    // markDeliverySent: same order on the durable linkage.
    expect(source).toMatch(/\} else if \(await issuedCloseoutOwnsRecord\(linkage\.service_record_id\)\) \{[\s\S]*?\} else \{\s*\n\s*const ReviewService = require\("\.\/review-request"\);\s*\n\s*await ReviewService\.enrollPostService\(\{\s*\n\s*customerId: invoice\.customer_id,\s*\n\s*serviceRecordId: linkage\.service_record_id/);
  });
  test('GitHub r7 P2 set: ownership re-read after the gate, revertMerge takes the gate, batch receipts retry the closeout, post-commit failures are released for resume', () => {
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    // The gate, then the ownership re-read, then the mint lock and the invoice row.
    // Gate per observed owner, re-read until stable, then the mint lock and the invoice row.
    expect(completion).toMatch(/let gateOwner = String\(svc\.customer_id\);\s*for \(let hop = 0; ; hop \+= 1\) \{\s*await trx\.raw\(\s*'SELECT pg_advisory_xact_lock\(hashtext\(\?\), hashtext\(\?::text\)\)',\s*\['invoice-issued-closeout', gateOwner\],\s*\);\s*const gatedOwner = await trx\('scheduled_services'\)\.where\(\{ id: svc\.id \}\)\.first\('customer_id'\);[\s\S]{0,700}?svc\.customer_id = gatedOwner\.customer_id;\s*gateOwner = observedOwner;\s*\}\s*(?:\s*\/\/[^\n]*\n)*\s*const ScheduledInvoiceMint = require\('\.\.\/services\/scheduled-invoice-mint'\);\s*await ScheduledInvoiceMint\.acquireScheduledInvoiceMintLock\(trx, svc\.id\);/);
    // The companion photo gate skips the closeout like the legacy form gate.
    expect(completion).toMatch(/const treeShrubPhotoGateRequired = treeShrubCloseoutRequired\s*\|\| \(\(typedFindingsType === 'tree_shrub' \|\| hasTreeShrubCompanion\) && !isIncompleteVisit && !issuedInvoiceCloseout\);/);
    // Committed-then-failed: released to side_effects_pending before the rethrow.
    expect(completion).toMatch(/if \(!markedSucceeded && completionAttempt\) \{\s*await CompletionAttempts\.releaseCompletionAttemptForResume\(completionAttempt, err\);\s*\}\s*logger\.error\(\s*`\[dispatch\] Post-commit error/);
    const dedupe = fs.readFileSync(path.join(__dirname, '../services/customer-dedupe.js'), 'utf8');
    const revert = dedupe.slice(dedupe.indexOf('async function revertMerge('));
    const gateAt = revert.indexOf("['invoice-issued-closeout', custId]");
    const rowsAt = revert.indexOf("const locked = await trx('customers').whereIn('id', [winnerId, loserId]).forUpdate()");
    expect(gateAt).toBeGreaterThan(-1);
    expect(rowsAt).toBeGreaterThan(gateAt);
    const invoices = fs.readFileSync(path.join(__dirname, '../routes/admin-invoices.js'), 'utf8');
    const batch = invoices.slice(invoices.indexOf("router.post('/batch/send-receipts'"), invoices.indexOf("router.post('/:id/send-receipt'"));
    const retryAt = batch.indexOf("closeOutVisitForIssuedInvoice({ invoiceId, trigger: 'paid', actorTechnicianId: req.technicianId || null })");
    expect(retryAt).toBeGreaterThan(batch.indexOf("skipped.push({ invoiceId, reason: `status=${invoice.status}` })"));
    expect(retryAt).toBeLessThan(batch.indexOf('sendReceiptEmail(invoiceId)'));
  });
  test('GitHub r9: statement delivery + settlement run the closeout for linked children AFTER commit; the locked recheck re-resolves project ownership', () => {
    const email = fs.readFileSync(path.join(__dirname, '../services/payer-statement-email.js'), 'utf8');
    expect(email).toMatch(/await database\('payer_statements'\)[\s\S]{0,1200}?closeOutVisitsForStatement\(statementId, \{ trigger: 'sent', actorTechnicianId, actorRole, conn: database \}\);\s*\}/);
    const payers = fs.readFileSync(path.join(__dirname, '../routes/admin-payers.js'), 'utf8');
    const settleAt = payers.indexOf("{ database: trx, allowedStatuses: PAYABLE_STATEMENT_STATUSES });");
    const closeAt = payers.indexOf("closeOutVisitsForStatement(owned.id, { trigger: 'paid', actorTechnicianId: req.technicianId || null, actorRole: req.techRole || null })");
    expect(settleAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(settleAt);
    const webhook = fs.readFileSync(path.join(__dirname, '../routes/stripe-webhook.js'), 'utf8');
    expect(webhook).toMatch(/if \(settledNow\) \{[\s\S]{0,400}?closeOutVisitsForStatement\(statementId, \{ trigger: 'paid' \}\)/);
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toMatch(/code: 'issued_visit_rescheduled' \}\);\s*\}[\s\S]{0,3350}?const lockedProfile = await resolveLockedProfile\(lockedSvcRow, trx, \{ strict: true \}\);\s*if \(lockedProfile\?\.requiresProject \|\| lockedProfile\?\.projectBacked\) \{\s*throw Object\.assign\(new Error\([^)]*\), \{ code: 'project_required_completion' \}\);/);
    expect(completion).toMatch(/if \(err && err\.code === 'project_required_completion' && issuedInvoiceCloseout\) \{\s*await CompletionAttempts\.markCompletionAttemptFailed\(completionAttempt, err, db\);/);
    // The office-only status set is re-checked on the locked row, ahead of the profile re-resolve.
    // Codex round 16 P2 #4131: the string-only check was replaced by the
    // shared null-tolerant isLiveVisitStatus predicate (a legacy NULL-status
    // visit the resolver had just admitted used to throw here instead).
    expect(completion).toMatch(/code: 'issued_visit_rescheduled' \}\);\s*\}[\s\S]{0,900}?if \(!isLiveVisitStatus\(lockedSvcRow\?\.status\)\) \{\s*throw Object\.assign\(new Error\([^)]*\), \{ code: 'issued_visit_in_progress' \}\);[\s\S]{0,2350}?const lockedProfile = await resolveLockedProfile/);
  });
  test('the issued-invoice recheck locks the invoice FIRST — behind the mint advisory lock, ahead of the customer and visit rows (invoice → customer, the reversal paths\' order; GitHub r6 P2)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const persistAt = source.indexOf('const persistRecord = async (trx) => {');
    const advisoryAt = source.indexOf('await ScheduledInvoiceMint.acquireScheduledInvoiceMintLock(trx, svc.id);', persistAt);
    const invoiceLockAt = source.indexOf("const issuedNow = await trx('invoices').where({ id: issuedInvoiceCloseout.invoiceId }).forUpdate()", persistAt);
    const customerLockAt = source.indexOf(".forShare()", persistAt);
    const visitLockAt = source.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();", persistAt);
    expect(persistAt).toBeGreaterThan(-1);
    expect(advisoryAt).toBeGreaterThan(persistAt);
    expect(invoiceLockAt).toBeGreaterThan(advisoryAt);
    expect(customerLockAt).toBeGreaterThan(invoiceLockAt);
    expect(visitLockAt).toBeGreaterThan(customerLockAt);
    // …and the locked visit row's day is re-validated after the visit lock.
    expect(source.indexOf("{ code: 'issued_visit_rescheduled' }", visitLockAt)).toBeGreaterThan(visitLockAt);
  });
  test('GitHub r10: the locked status is the transition source; the zero-price conversion takes the mint advisory lock after the occupancy rung and before any row lock; the settled-statement retry runs on the daily statement tick', () => {
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toMatch(/let fromStatus = svc\.status;/);
    // Codex round 16 P2 #4131: fromStatus keeps the locked row's ACTUAL
    // value (never String()-coerced) — a legacy NULL-status row's null
    // must reach transitionJobStatus's atomic `{ status: fromStatus }`
    // guard as real null (which Knex compiles to `status IS NULL`), not
    // the literal text "null", which no row's status column ever holds.
    expect(completion).toMatch(/\{ code: 'issued_visit_in_progress' \}\);\s*\}[\s\S]{0,800}?fromStatus = lockedSvcRow\.status;[\s\S]{0,2600}?const \{ resolveCompletionProfileForScheduledService: resolveLockedProfile \}/);
    const schedule = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const detailsTrxAt = schedule.indexOf("const commsPeek = await trx('scheduled_services')");
    const occupancyAt = schedule.indexOf('await acquireOccupancyLock(trx, occupancyDateKey);', detailsTrxAt);
    const mintAt = schedule.indexOf('if (reServiceConversionZeroPrice) {\n        const { acquireScheduledInvoiceMintLock } = require(\'../services/scheduled-invoice-mint\');\n        await acquireScheduledInvoiceMintLock(trx, req.params.id);', detailsTrxAt);
    const firstRowLockAt = schedule.indexOf('.forUpdate()', detailsTrxAt);
    const conversionVoidAt = schedule.indexOf('await voidConversionInvoicesRestoringCredits({ trx, ids: nonAccruedIds, voidUpdate });', detailsTrxAt);
    expect(detailsTrxAt).toBeGreaterThan(-1);
    expect(occupancyAt).toBeGreaterThan(detailsTrxAt);
    expect(mintAt).toBeGreaterThan(occupancyAt);
    expect(firstRowLockAt).toBeGreaterThan(mintAt);
    expect(conversionVoidAt).toBeGreaterThan(firstRowLockAt);
    // r11: identity / assignment drift under the lock refuses; the quiet closeout writes no tech-attributed activity or job_complete push.
    expect(completion).toMatch(/fromStatus = lockedSvcRow\.status;[\s\S]{0,1200}?const driftedField = ISSUED_CLOSEOUT_IDENTITY_FIELDS\.find\([\s\S]{0,300}?\{ code: 'issued_visit_identity_changed' \}\);/);
    expect(completion).toMatch(/if \(err && err\.code === 'issued_visit_identity_changed'\) \{\s*await CompletionAttempts\.markCompletionAttemptFailed\(completionAttempt, err, db\);/);
    expect(completion).toMatch(/if \(\(!resumingCommittedCompletion \|\| packetEffects\) && !issuedInvoiceCloseout\) \{\s*try \{\s*const writeActivity = async/);
    // r12: a settled issued invoice releases a live card hold instead of parking it; the referral credit posts quietly; the card mint runs on the silent backfill path.
    expect(completion).toMatch(/\} else if \(isBackfillCompletion\) \{[\s\S]{0,1600}?if \(liveHold && issuedInvoiceCloseout && \['paid', 'prepaid'\]\.includes\(String\(invoice\.status\)\)\) \{\s*const release = await CardHolds\.releaseCardHold\(\{ scheduledServiceId: svc\.id, reason: 'issued_invoice_settled' \}\);/);
    expect(completion).toMatch(/const referralVisitPerformed = closedDealVisitPerformed && \(!isBackfillCompletion \|\| !!issuedInvoiceCloseout\);[\s\S]{0,400}?creditReferralOnFirstService\(\{ customerId: svc\.customer_id, serviceId: svc\.id, notify: !issuedInvoiceCloseout \}\)/);
    expect(completion).toMatch(/if \(!packetEffects && \(!isInternalOnlyCompletion \|\| issuedInvoiceCloseout\) && cardMintOutcomePerformed\) \{/);
    const referral = fs.readFileSync(path.join(__dirname, '../services/referral-engine.js'), 'utf8');
    expect(referral).toMatch(/async function creditReferralOnFirstService\(\{ customerId, serviceId, notify = true \}\)[\s\S]*?if \(notify && outcome\.referral\.promoter_id\) \{/);
    const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(scheduler).toMatch(/StatementFollowups\.runPending\(\);[\s\S]{0,600}?retrySettledStatementCloseouts\(\);/);
    // Statement delivery carries the operator through to the child closeouts.
    const payers = fs.readFileSync(path.join(__dirname, '../routes/admin-payers.js'), 'utf8');
    expect(payers.match(/sendStatementEmail\(statement\.id, \{[^}]*actorTechnicianId: req\.technicianId \|\| null, actorRole: req\.techRole \|\| null \}\)/g)).toHaveLength(2);
    const comms = fs.readFileSync(path.join(__dirname, '../routes/admin-communications.js'), 'utf8');
    expect(comms.match(/markStatementsSent\(statementLinkIds, \{ actorTechnicianId: req\.technicianId \|\| null, actorRole: req\.techRole \|\| null \}\)/g)).toHaveLength(2);
  });
});

// A SEND closes out a visit whose day has PASSED, never one scheduled today
// (invoice-issued-closeout `visit_scheduled_today`, Codex P1 r7 #4131): the
// office invoice picker links pre-completion invoices to open visits and
// sends them before the tech arrives, so a same-day send would complete the
// visit early. Every send-trigger fixture below is therefore dated
// YESTERDAY; the same-day contract has its own test at the end of the file,
// and `paid` still closes a visit dated today.
const yesterdayET = () => etDateString(addETDays(new Date(), -1));

postgres('invoice issued ⇒ visit completed through the canonical completion (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    mockPg = database;
  });
  // Every fixture graph (customer, technician, catalog row, visit, invoice,
  // and whatever the completion writes) lives inside one transaction that
  // is rolled back — the catalog row in particular must never outlive the
  // test: the serial CI run's completion-lane coverage contract reads the
  // migrated catalog next and fails on a leaked `fixture_*` service.
  beforeEach(async () => { jest.clearAllMocks(); mockPg = await database.transaction(); });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  // `day` defaults to YESTERDAY (see the note above the describe): a send
  // leaves a visit scheduled TODAY open. The same-day test passes it
  // explicitly; expectQuietCompletion reads it back off `f` to decide which
  // end-instant the backfill should have stamped.
  async function fixture({ serviceType, category = 'pest_control', profile = null, customer = {}, day = yesterdayET() }) {
    f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), invoiceId: randomUUID(), key: `fixture_${randomUUID().slice(0, 8)}`, day };
    const date = day;
    await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Issued', phone: '+12025550123',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application', ...customer });
    await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
    await mockPg('services').insert({ id: f.catalogId, name: serviceType, service_key: f.key, category, is_active: true });
    if (profile) await mockPg('service_completion_profiles').insert({ service_key: f.key, ...profile });
    await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
      service_type: serviceType, scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'confirmed',
      estimated_price: 117, estimated_duration_minutes: 60, create_invoice_on_complete: true });
    await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId, invoice_number: `TST-${f.invoiceId.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'sent', total: 117, subtotal: 117, service_date: date, service_type: serviceType,
      sent_at: new Date(), line_items: JSON.stringify([{ description: serviceType, amount: 117, quantity: 1, unit_price: 117 }]) });
    return f;
  }

  // backfillCompletionEndInstant's two branches, asserted per service day:
  //  - the visit's day IS today (only 'paid' reaches a closeout there now):
  //    the visit ended at the closeout itself, never at an ET noon still
  //    hours away (GitHub r2 P2).
  //  - an earlier day keeps the honest day-scale ET-noon instant — the same
  //    backdated-instant convention every other backfill closeout uses.
  function expectBackfillEndInstant(completedAt, serviceDay) {
    const at = new Date(completedAt);
    expect(Number.isFinite(at.getTime())).toBe(true);
    if (serviceDay === etDateString()) {
      expect(at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(at.getTime()).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
      return;
    }
    expect(etDateString(at)).toBe(serviceDay);
    expect(at.getTime()).toBeLessThan(Date.now());
  }

  async function expectQuietCompletion(out) {
    expect(out).toMatchObject({ closed: true, visitId: f.serviceId, resumed: false });
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.status).toBe('completed');
    expectBackfillEndInstant(visit.completed_at, f.day);
    const records = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
    expect(records).toHaveLength(1);
    expect(records[0].structured_notes).toMatchObject({ backfill: true, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' } });
    // No customer report exists for a closeout without findings: delivery
    // frozen disabled, no report token / PDF / HTML on the record.
    expect(records[0].structured_notes).toMatchObject({ typedReportDelivery: 'disabled' });
    expect(records[0].report_view_token).toBeFalsy();
    expect(records[0].report_pdf_url).toBeFalsy();
    expect(records[0].report_html_storage_key).toBeFalsy();
    // The sent invoice is the visit's invoice — reused and back-linked, none minted.
    const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].service_record_id).toBe(records[0].id);
    expect(invoices[0].status).toBe('sent');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    // No form, no application evidence — no LLM recap is generated or frozen
    // (GitHub r4 P2), and no review outreach is enrolled (GitHub r4 P1).
    expect(CompletionRecap.generateRecap).not.toHaveBeenCalled();
    expect(records[0].structured_notes.customerRecap ?? null).toBeNull();
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
    expect(await mockPg('review_requests').where({ customer_id: f.customerId })).toHaveLength(0);
  }

  test('a pest visit closes quietly on its sent invoice', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  // Codex round 16 P2 #4131: a legacy NULL-status visit is a live visit by
  // this repository's convention (the resolver already admits it) — the
  // locked recheck used to accept only the string statuses and threw
  // issued_visit_in_progress on exactly this row, refusing a closeout the
  // resolver had just approved. Both now share isLiveVisitStatus.
  test('a legacy NULL-status visit closes quietly too — the locked recheck no longer refuses it as issued_visit_in_progress', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: null });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a Tree & Shrub visit closes without the closeout form (no tree_shrub_closeout_lockout)', async () => {
    await fixture({ serviceType: 'Tree & Shrub Care Service', category: 'tree_shrub' });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a typed-findings service (rodent trapping) closes without its findings form', async () => {
    await fixture({ serviceType: 'Fixture Rodent Trapping Service', category: 'rodent',
      profile: { completion_mode: 'service_report', project_type: 'rodent_trapping', creates_service_record: true } });
    // The panel path still demands the typed form for this profile…
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const panel = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', sendCompletionSms: false, requestReview: false, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null } });
    expect(panel).toMatchObject({ status: 422, body: { code: 'typed_findings_required' } });
    // …while the issued-invoice closeout records the billed visit as done.
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a profile with companion sections closes without them (no companion_findings_required)', async () => {
    await fixture({ serviceType: 'Fixture Rodent Trapping Service', category: 'rodent',
      profile: { completion_mode: 'service_report', project_type: 'rodent_trapping', creates_service_record: true,
        companion_types: JSON.stringify([{ type: 'rodent_exclusion' }]) } });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a lawn profile with a tree_shrub COMPANION closes on its invoice — the companion photo gate does not apply to the closeout (GitHub r7 P1)', async () => {
    await fixture({ serviceType: 'Fixture Monthly Lawn Care Service', category: 'lawn',
      profile: { completion_mode: 'service_report', creates_service_record: true,
        companion_types: JSON.stringify([{ type: 'tree_shrub' }]) } });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a delivery finalized through markDeliverySent (deferred / report-with-invoice rails) closes the visit too — and a scheduled review ask on it is never enrolled', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    // A pre-completion invoice scheduled WITH a review ask: before the
    // closeout it has no service_record_id, so a review decision taken
    // ahead of the closeout would read it as standalone and enroll an
    // at-delivery ask (GitHub r4 P1).
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'sending', sent_at: null, scheduled_request_review: true, scheduled_review_delay_minutes: 120 });
    const InvoiceService = require('../services/invoice');
    await InvoiceService.markDeliverySent(f.invoiceId, { sms: true, source: 'scheduled_send' });
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.status).toBe('completed');
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).status).toBe('sent');
    const records = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
    expect(records).toHaveLength(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
    expect(await mockPg('review_requests').where({ customer_id: f.customerId })).toHaveLength(0);
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBe(records[0].id);
    expect(records[0].structured_notes).toMatchObject({ requestReview: false });
    // An automated trigger closes the visit out as the system: the visit's
    // technician is neither the transition actor nor the audit actor
    // (GitHub r2 P2) — the service record still carries the technician.
    const transition = await mockPg('job_status_history').where({ job_id: f.serviceId, to_status: 'completed' }).first();
    expect(transition).toBeTruthy();
    expect(transition.transitioned_by).toBeNull();
    expect(records[0].technician_id).toBe(f.techId);
    expect(await mockPg('audit_log').where({ resource_id: f.serviceId, action: 'visit.completed_on_invoice_issued' }).first()).toMatchObject({ actor_type: 'system', actor_id: null });
  });

  test('a closeout that already committed its record owns the review decision even when a later invocation reports closed: false and the invoice is paid (pre-push P1 r7)', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const { issuedCloseoutOwnsRecord } = require('../services/invoice-issued-closeout');
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
    const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
    // Durable provenance on the committed record…
    expect(await issuedCloseoutOwnsRecord(record.id, mockPg)).toBe(true);
    expect(await issuedCloseoutOwnsRecord(randomUUID(), mockPg)).toBe(false);
    expect(await issuedCloseoutOwnsRecord(null, mockPg)).toBe(false);
    // …decides the ask: the invoice is PAID by the time of the delivery's
    // fresh linkage read and the closeout now reports closed: false (the
    // visit is already completed), which used to fall through to the
    // at-delivery enrollment against the record that froze requestReview: false.
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'paid', paid_at: new Date(), scheduled_request_review: true, scheduled_review_delay_minutes: 120 });
    const again = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(again).toMatchObject({ closed: false, reason: 'visit_completed' });
    const InvoiceService = require('../services/invoice');
    await InvoiceService.markDeliverySent(f.invoiceId, { sms: true, source: 'scheduled_send' });
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
    expect(await mockPg('review_requests').where({ customer_id: f.customerId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(1);
  });

  test('an annual-prepay-covered visit keeps its SENT invoice intact — add-ons and all; the closeout never settles or voids it', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const lines = [
      { description: 'Fixture Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 },
      { description: 'Wasp nest removal (add-on)', amount: 45, quantity: 1, unit_price: 45 },
    ];
    await mockPg('invoices').where({ id: f.invoiceId }).update({ line_items: JSON.stringify(lines), subtotal: 162, total: 162 });
    mockAnnualPrepay.covers = true;
    try {
      const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
      expect(out).toMatchObject({ closed: true, visitId: f.serviceId });
    } finally {
      mockAnnualPrepay.covers = false;
    }
    const inv = await mockPg('invoices').where({ id: f.invoiceId }).first();
    expect(inv.status).toBe('sent');
    expect(Number(inv.total)).toBe(162);
    const items = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : inv.line_items;
    expect(items).toHaveLength(2);
    expect(inv.service_record_id).toBe((await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first()).id);
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
  });

  test('with two live invoices linked to the visit, the ISSUED one is reused and back-linked — never the newest draft', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const draftId = randomUUID();
    await mockPg('invoices').insert({ id: draftId, customer_id: f.customerId, scheduled_service_id: f.serviceId, invoice_number: `TST-${draftId.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'draft', total: 45, subtotal: 45, service_date: f.day, service_type: 'Fixture Quarterly Pest Control Service',
      created_at: new Date(Date.now() + 60 * 1000), line_items: JSON.stringify([{ description: 'Add-on', amount: 45, quantity: 1, unit_price: 45 }]) });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(out).toMatchObject({ closed: true, visitId: f.serviceId });
    const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBe(record.id);
    expect((await mockPg('invoices').where({ id: draftId }).first()).service_record_id).toBeNull();
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(2);
  });

  test('an invoice voided after the send never closes the visit and never mints a replacement', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(out).toMatchObject({ closed: false, reason: 'invoice_void', visitId: f.serviceId });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
  });

  test('an invoice re-pointed away from the visit between the send and the closeout is refused before any write', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await mockPg('invoices').where({ id: f.invoiceId }).update({ scheduled_service_id: null });
    const result = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', backfill: true, sendCompletionSms: false, requestReview: false, invoiceAlreadySent: true, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null }, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' } });
    expect(result).toMatchObject({ status: 409, body: { code: 'issued_invoice_not_reusable' } });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
  });

  test('a COMMITTED closeout whose invoice is voided after the commit still reaches its resume through the wrapper — never invoice_void / not-reusable (pre-push P1 r7)', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const idempotencyKey = `invoice-issued:${f.invoiceId}`;
    // The completion committed (record + status) and still owes side effects.
    await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'completed' });
    await mockPg('service_completion_attempts').insert({ id: randomUUID(), service_id: f.serviceId, idempotency_key: idempotencyKey, status: 'side_effects_pending', request_hash: 'x' });
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    // The wrapper recognised its own committed attempt and handed it to the
    // canonical completion's resume; the pre-claim invoice check no longer
    // stands in the way. Whatever the resume claim then decides, no
    // replacement invoice is minted.
    expect(out).toMatchObject({ visitId: f.serviceId, resumed: true });
    expect(out.reason).not.toBe('invoice_void');
    expect(out.reason).not.toBe('issued_invoice_not_reusable');
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
    // A void with NO committed attempt of its own still closes nothing.
    await mockPg('service_completion_attempts').where({ service_id: f.serviceId }).del();
    await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'confirmed' });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg })).toMatchObject({ closed: false, reason: 'invoice_void', visitId: f.serviceId });
  });

  test('a technician who starts the visit between the unlocked read and the record transaction wins — the locked status refuses the closeout (pre-push P1 r9)', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    // The wrapper resolved the visit as 'confirmed'; by the time the record
    // transaction locks the row the technician is on site.
    await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'on_site' });
    const result = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', backfill: true, sendCompletionSms: false, requestReview: false, invoiceAlreadySent: true, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null }, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' } });
    expect(result).toMatchObject({ status: 409, body: { code: 'issued_visit_in_progress' } });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
  });

  test('a reschedule that lands between the unlocked read and the record transaction refuses the closeout — the locked day decides (GitHub r6 P2)', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mockRace.beforeClaim = () => mockPg('scheduled_services').where({ id: f.serviceId }).update({ scheduled_date: tomorrow });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(out).toMatchObject({ closed: false, reason: 'issued_visit_rescheduled', visitId: f.serviceId });
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.status).toBe('confirmed');
    expect((await mockPg.raw("SELECT to_char(scheduled_date, 'YYYY-MM-DD') AS d FROM scheduled_services WHERE id = ?", [f.serviceId])).rows[0].d).toBe(tomorrow);
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBeNull();
    expect(await mockPg('audit_log').where({ resource_id: f.serviceId, action: 'visit.completion_on_invoice_issued_refused' }).first()).toMatchObject({ metadata: expect.objectContaining({ code: 'issued_visit_rescheduled' }) });
  });

  test('a void racing the closeout: the closeout queues behind the invoice-first void instead of deadlocking, then refuses (GitHub r6 P2)', async () => {
    // Two real sessions, so the fixture graph is COMMITTED for this test
    // and removed in finally (no catalog row is created — the visit's
    // service_type resolves to the synthesized generic profile).
    const outer = mockPg;
    mockPg = database;
    const ids = { customerId: randomUUID(), serviceId: randomUUID(), invoiceId: randomUUID() };
    const date = yesterdayET();
    let voider = null;
    try {
      await database('customers').insert({ id: ids.customerId, first_name: 'Race', last_name: 'Fixture', phone: '+12025550199',
        email: `${ids.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
      await database('scheduled_services').insert({ id: ids.serviceId, customer_id: ids.customerId, service_type: 'Quarterly Pest Control Service',
        scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'confirmed', estimated_price: 117 });
      await database('invoices').insert({ id: ids.invoiceId, customer_id: ids.customerId, scheduled_service_id: ids.serviceId, invoice_number: `TST-${ids.invoiceId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''), status: 'sent', total: 117, subtotal: 117, credit_applied: 20, service_date: date, service_type: 'Quarterly Pest Control Service',
        sent_at: new Date(), line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]) });
      // voidInvoice's lock order: the invoice row first…
      voider = await database.transaction();
      await voider('invoices').where({ id: ids.invoiceId }).forUpdate().first('id');
      // …while the closeout runs concurrently and must queue behind it.
      const closeout = closeOutVisitForIssuedInvoice({ invoiceId: ids.invoiceId, trigger: 'sent', actorTechnicianId: null, conn: database });
      const deadline = Date.now() + 15000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const { rows } = await database.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()");
        waiting = rows[0].n;
        if (waiting > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBeGreaterThan(0);
      // …then restoreAccountCreditForVoidedInvoice locks the customer. With
      // the closeout holding the customer share lock and waiting on the
      // invoice this was the ABBA deadlock; now it acquires immediately.
      await voider.raw("SET LOCAL lock_timeout = '4000ms'");
      await voider('customers').where({ id: ids.customerId }).forUpdate().first('id');
      await voider('invoices').where({ id: ids.invoiceId }).update({ status: 'void', credit_applied: 0, updated_at: new Date() });
      await voider.commit();
      voider = null;
      const out = await closeout;
      expect(out).toMatchObject({ closed: false, reason: 'issued_invoice_not_reusable', visitId: ids.serviceId });
      expect((await database('scheduled_services').where({ id: ids.serviceId }).first()).status).toBe('confirmed');
      expect(await database('service_records').where({ scheduled_service_id: ids.serviceId })).toHaveLength(0);
    } finally {
      if (voider) await voider.rollback().catch(() => {});
      for (const [table, where] of [
        ['service_completion_attempts', { service_id: ids.serviceId }],
        ['audit_log', { resource_id: ids.serviceId }],
        ['job_status_history', { job_id: ids.serviceId }],
        ['activity_log', { customer_id: ids.customerId }],
        ['invoices', { id: ids.invoiceId }],
        ['scheduled_services', { id: ids.serviceId }],
        ['customers', { id: ids.customerId }],
      ]) {
        await database(table).where(where).del().catch(() => {});
      }
      mockPg = outer;
    }
  });

  test('a customer merge racing the closeout: the merge-race gate lock keeps both queued in order, never deadlocked (GitHub r7 P2)', async () => {
    // Two real sessions, same fixture/cleanup pattern as the void race
    // above. executeMerge's OWN lock order is customer-row-first, then (via
    // its FK sweep) an UPDATE that needs this invoice's row lock — the
    // exact opposite of this closeout's invoice-first order. Reproduced
    // here with the merge's two concrete lock acquisitions (its gate lock,
    // then its customer forUpdate) rather than standing up a full merge
    // fixture — customer-dedupe.js takes the identical gate lock (same
    // namespace, same sorted customer ids) before that same customer lock.
    const outer = mockPg;
    mockPg = database;
    const ids = { customerId: randomUUID(), serviceId: randomUUID(), invoiceId: randomUUID() };
    const date = yesterdayET();
    let merger = null;
    try {
      await database('customers').insert({ id: ids.customerId, first_name: 'Race', last_name: 'Merge', phone: '+12025550198',
        email: `${ids.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
      await database('scheduled_services').insert({ id: ids.serviceId, customer_id: ids.customerId, service_type: 'Quarterly Pest Control Service',
        scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'confirmed', estimated_price: 117 });
      await database('invoices').insert({ id: ids.invoiceId, customer_id: ids.customerId, scheduled_service_id: ids.serviceId, invoice_number: `TST-${ids.invoiceId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''), status: 'sent', total: 117, subtotal: 117, service_date: date, service_type: 'Quarterly Pest Control Service',
        sent_at: new Date(), line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]) });
      // executeMerge's lock order: the gate lock, then the customer row…
      merger = await database.transaction();
      await merger.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['invoice-issued-closeout', String(ids.customerId)]);
      await merger('customers').where({ id: ids.customerId }).forUpdate().first('id');
      // …while the closeout runs concurrently and must queue behind the
      // SAME gate lock — never reaching its own invoice row lock while
      // blocked (the old hazard: it would hold that row and wait on the
      // customer the merge already holds, an ABBA cycle).
      const closeout = closeOutVisitForIssuedInvoice({ invoiceId: ids.invoiceId, trigger: 'sent', actorTechnicianId: null, conn: database });
      const deadline = Date.now() + 15000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const { rows } = await database.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()");
        waiting = rows[0].n;
        if (waiting > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBeGreaterThan(0);
      // Proof there is no cycle: the invoice row is still free — the
      // merge's own transaction can lock it immediately (it never blocked
      // on the closeout, because the closeout never got past the gate).
      await merger.raw("SET LOCAL lock_timeout = '4000ms'");
      await merger('invoices').where({ id: ids.invoiceId }).forUpdate().first('id');
      await merger.commit();
      merger = null;
      // Once the merge's transaction ends, the gate releases and the
      // closeout proceeds normally — completing the visit.
      const out = await closeout;
      expect(out).toMatchObject({ closed: true, visitId: ids.serviceId });
      expect((await database('scheduled_services').where({ id: ids.serviceId }).first()).status).toBe('completed');
    } finally {
      if (merger) await merger.rollback().catch(() => {});
      for (const [table, where] of [
        ['service_completion_attempts', { service_id: ids.serviceId }],
        ['audit_log', { resource_id: ids.serviceId }],
        ['job_status_history', { job_id: ids.serviceId }],
        ['activity_log', { customer_id: ids.customerId }],
        ['service_records', { scheduled_service_id: ids.serviceId }],
        ['invoices', { id: ids.invoiceId }],
        ['scheduled_services', { id: ids.serviceId }],
        ['customers', { id: ids.customerId }],
      ]) {
        await database(table).where(where).del().catch(() => {});
      }
      mockPg = outer;
    }
  });

  test('a lawn visit with an unconfirmed assessment closes — the assessment form gate is a panel gate', async () => {
    await fixture({ serviceType: 'Fixture Monthly Lawn Care Service', category: 'lawn' });
    await mockPg('lawn_assessments').insert({ id: randomUUID(), customer_id: f.customerId, service_id: f.serviceId, service_date: f.day, confirmed_by_tech: false });
    // The panel path is blocked by the unconfirmed assessment…
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const panel = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', sendCompletionSms: false, requestReview: false, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null } });
    expect(panel).toMatchObject({ status: 400, body: { code: 'lawn_assessment_unconfirmed' } });
    // …while the issued-invoice closeout records the billed visit as done.
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a visit grouped into a stop AFTER the unlocked resolve is refused under the claim lock — never completed alone', async () => {
    await fixture({ serviceType: 'Quarterly Pest Control Service' });
    // The grouping lands between resolveVisitForIssuedInvoice and the
    // completion's claim: drive the completion exactly as the closeout does,
    // with the row already a member of a two-visit open stop.
    const visitId = randomUUID();
    await mockPg('service_visits').insert({ id: visitId, customer_id: f.customerId, scheduled_date: f.day, stop_base_key: `stop-${visitId.slice(0, 8)}`, created_by: 'test' });
    await mockPg('scheduled_services').insert({ id: randomUUID(), customer_id: f.customerId, technician_id: f.techId, service_type: 'Mosquito Barrier Treatment',
      scheduled_date: f.day, window_start: '09:00', window_end: '10:00', status: 'confirmed', visit_id: visitId });
    await mockPg('scheduled_services').where({ id: f.serviceId }).update({ visit_id: visitId });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const idempotencyKey = `invoice-issued:${f.invoiceId}`;
    const out = await completeScheduledService({
      serviceId: f.serviceId,
      body: { visitOutcome: 'completed', backfill: true, sendCompletionSms: false, requestReview: false, invoiceAlreadySent: true, idempotencyKey },
      actor: { techRole: 'admin', technicianId: null, technician: null },
      idempotencyKey,
      issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' },
    });
    expect(out).toMatchObject({ status: 409, body: { code: 'visit_grouped', visitId } });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
    expect(await mockPg('service_completion_attempts').where({ service_id: f.serviceId })).toHaveLength(0);
  });

  test('a WaveGuard lawn visit closes with NO lawn protocol completion and no protocol assignment — there is no application evidence', async () => {
    await fixture({ serviceType: 'Fixture Monthly Lawn Care Service', category: 'lawn', customer: { waveguard_tier: 'Gold' } });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
    expect(await mockPg('lawn_protocol_service_completions').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.lawn_protocol_key).toBeNull();
    expect(visit.lawn_protocol_assignment_source).toBeNull();
    // The issued invoice's record link is written in the completion
    // transaction itself, never left to the post-commit lookup.
    const [record] = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBe(record.id);
    expect(new Date(record.structured_notes.issuedInvoiceCloseout.completedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('a second send is idempotent — the visit is already completed, nothing else changes', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
    const again = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(again).toMatchObject({ closed: false, reason: 'visit_completed' });
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(1);
  });

  // The rule every fixture above is dated around (Codex P1 r7 #4131). The
  // office picker links a pre-completion invoice to TODAY's open visit and
  // texts it before the tech arrives, so a send proves nothing about that
  // visit: it stays open, audited with `visit_scheduled_today`. Money in
  // hand still proves it happened, so 'paid' closes the very same row — the
  // #4127 contract is narrowed by trigger, not withdrawn.
  test('a visit scheduled TODAY is left open by a send (visit_scheduled_today) and closed by a payment', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service', day: etDateString() });
    const sent = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(sent).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: f.serviceId });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBeNull();
    // The refusal is audited like every other one, so rollout diagnostics
    // tell this intentional no-op from a failure.
    expect(await mockPg('audit_log').where({ resource_id: f.serviceId, action: 'visit.completion_on_invoice_issued_refused' }).first())
      .toMatchObject({ metadata: expect.objectContaining({ code: 'visit_scheduled_today' }) });

    // …and the payment that follows closes it, same day, same invoice.
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'paid', paid_at: new Date() });
    const paid = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'paid', actorTechnicianId: f.techId, conn: mockPg });
    expect(paid).toMatchObject({ closed: true, visitId: f.serviceId, resumed: false });
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.status).toBe('completed');
    // Same-day closeout: the visit ended at the closeout itself, never at an
    // ET noon still hours away (GitHub r2 P2).
    expectBackfillEndInstant(visit.completed_at, f.day);
    const records = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
    expect(records).toHaveLength(1);
    expect(records[0].structured_notes).toMatchObject({ backfill: true, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'paid' } });
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBe(records[0].id);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
  });
});
