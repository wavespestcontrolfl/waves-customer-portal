/**
 * Backdated quiet completion (`backfill: true` on POST /:serviceId/complete).
 * Unit-tests the past-date guard + service-date source via the exported
 * backfillCompletionPlan, then pins the route wiring with source contracts:
 * the giant completion route can't be exercised end-to-end here, but the
 * load-bearing lines — backdated completionServiceDate, forced comms/review
 * suppression (initial AND post-resume re-derivation), the structured_notes
 * freeze, the near-term invoice due date, the admin-only authz gate, the
 * quiet card mint, and the account-credit skip — must not be refactored away
 * silently.
 */
const fs = require('fs');
const path = require('path');
const { backfillCompletionPlan } = require('../routes/admin-dispatch')._test;

const TODAY = '2026-07-19';

describe('backfillCompletionPlan', () => {
  test('absent/false flag → inactive, no error', () => {
    expect(backfillCompletionPlan({ scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
    expect(backfillCompletionPlan({ backfill: false, scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
  });

  test('only boolean true activates — truthy strings do not backdate', () => {
    expect(backfillCompletionPlan({ backfill: 'true', scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
    expect(backfillCompletionPlan({ backfill: 1, scheduledDate: '2026-07-01', today: TODAY })).toEqual({ active: false });
  });

  test('past-dated row + admin → active, serviceDate comes from the row (not today)', () => {
    const plan = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-07-01', today: TODAY, role: 'admin' });
    expect(plan.active).toBe(true);
    expect(plan.serviceDate).toBe('2026-07-01');
  });

  test('normalizes a pg Date-object scheduled_date to the calendar date', () => {
    const plan = backfillCompletionPlan({
      backfill: true,
      scheduledDate: new Date('2026-07-01T00:00:00Z'),
      today: TODAY,
      role: 'admin',
    });
    expect(plan.active).toBe(true);
    expect(plan.serviceDate).toBe('2026-07-01');
  });

  test("today's visit is rejected — same-day completions stay on the normal path", () => {
    const plan = backfillCompletionPlan({ backfill: true, scheduledDate: TODAY, today: TODAY, role: 'admin' });
    expect(plan.active).toBe(false);
    expect(plan.error.code).toBe('backfill_not_past');
  });

  test('future-dated and missing scheduled_date are rejected', () => {
    expect(backfillCompletionPlan({ backfill: true, scheduledDate: '2026-08-01', today: TODAY, role: 'admin' }).error.code)
      .toBe('backfill_not_past');
    expect(backfillCompletionPlan({ backfill: true, scheduledDate: null, today: TODAY, role: 'admin' }).error.code)
      .toBe('backfill_not_past');
  });

  // Backfill is a financial/comms override (suppresses charges + customer
  // sends) on a requireTechOrAdmin route — a technician token must not be
  // able to invoke it.
  test('technician role → 403 backfill_admin_only, even for a valid past date', () => {
    const plan = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-07-01', today: TODAY, role: 'technician' });
    expect(plan.active).toBe(false);
    expect(plan.status).toBe(403);
    expect(plan.error.code).toBe('backfill_admin_only');
  });

  test('missing/unknown role fail-closes to 403 (authz checked before date validation)', () => {
    const missing = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-07-01', today: TODAY });
    expect(missing.status).toBe(403);
    expect(missing.error.code).toBe('backfill_admin_only');
    // Even an invalid date fails on authz first — no validation oracle for techs.
    const techFuture = backfillCompletionPlan({ backfill: true, scheduledDate: '2026-08-01', today: TODAY, role: 'technician' });
    expect(techFuture.error.code).toBe('backfill_admin_only');
  });

  test('non-backfill requests never hit the role gate — techs complete visits normally', () => {
    expect(backfillCompletionPlan({ scheduledDate: '2026-07-01', today: TODAY, role: 'technician' })).toEqual({ active: false });
    expect(backfillCompletionPlan({ backfill: false, scheduledDate: '2026-07-01', today: TODAY, role: 'technician' })).toEqual({ active: false });
  });
});

describe('completion route wiring (source contracts)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

  test('route feeds the requester role into the plan and honors the 403 status', () => {
    expect(source).toMatch(/backfillCompletionPlan\(\{ backfill, scheduledDate: svc\.scheduled_date, role: req\.techRole \}\)/);
    expect(source).toMatch(/res\.status\(backfillPlan\.status \|\| 400\)\.json\(backfillPlan\.error\)/);
  });

  test('completionServiceDate is backdated from the plan under backfill', () => {
    expect(source).toMatch(/const completionServiceDate = isBackfillCompletion\s*\n\s*\? backfillPlan\.serviceDate\s*\n\s*: etDateString\(completionEndedAt\)/);
  });

  test('backfill forces customer comms off, including AFTER the frozen-posture re-derivation', () => {
    const forced = source.match(/if \(isBackfillCompletion\) \{\s*\n\s*suppressTypedCustomerComms = true;\s*\n\s*effectiveSendCompletionSms = false;\s*\n\s*\}/g) || [];
    // Once at the initial delivery-posture derivation, once after the
    // resume-path re-derivation (which could otherwise un-suppress).
    expect(forced.length).toBe(2);
  });

  test('backfill freezes review-request OFF and its own flag in structured_notes', () => {
    expect(source).toMatch(/requestReview: \(isIncompleteVisit \|\| isInternalOnlyCompletion \|\| isBackfillCompletion\) \? false : requestReview !== false/);
    expect(source).toMatch(/\.\.\.\(isBackfillCompletion \? \{ backfill: true \} : \{\}\)/);
    // And the resume path recovers the frozen flag.
    expect(source).toMatch(/parseJsonObject\(record\.structured_notes\)\?\.backfill === true/);
  });

  test('backfill invoices stay due near-term instead of minting instantly overdue', () => {
    expect(source).toMatch(/dueDate: isBackfillCompletion \? etDateString\(\) : serviceDateOnly\(record\.service_date\)/);
  });

  test('backfill suppresses the decline notice and the payer AP send', () => {
    expect(source).toMatch(/&& !invoice\.payer_id\s*\n\s*\/\/ Backfill closeouts are quiet end-to-end[\s\S]{0,200}&& !isBackfillCompletion\)/);
    expect(source).toMatch(/invoice\.payer_id && !payerInvoiceAlreadyDelivered && !isBackfillCompletion/);
  });

  test('backfill + saved payment method never auto-charges (per-application rail gated off)', () => {
    // The per-application saved-card/ACH rail — and with it the receipt
    // enqueue and combined-receipt arming that only happen inside it — runs
    // exclusively for non-backfill completions. Invoice minting is untouched
    // (shouldInvoice runs earlier), so a backfill invoice still mints, open
    // and uncharged, for operator collection.
    expect(source).toMatch(/if \(!isBackfillCompletion\n\s*&& perApplicationBilling && visitPerformed && invoice\?\.id && !alreadyPaid && !invoice\.payer_id/);
    // autoChargedReceiptPending starts false and is only ever set inside the
    // gated rail — no charge, no combined receipt claim.
    expect(source).toMatch(/let autoChargedReceiptPending = false;/);
  });

  test('backfill mints the digital card quietly — card.issued email suppressed', () => {
    // The mint call passes the quiet flag straight off the completion's
    // backfill state…
    expect(source).toMatch(/ensureCardForCompletion\(\{\s*\n\s*customerId: svc\.customer_id,\s*\n\s*serviceRecordId: record\.id,\s*\n\s*scheduledServiceId: svc\.id,\s*\n\s*suppressIssuedEmail: isBackfillCompletion,/);
    // …and the service honors it: the email leg is gated, everything before
    // it (card row / promoter enroll / short link) still runs.
    const cardSource = fs.readFileSync(path.join(__dirname, '../services/customer-card.js'), 'utf8');
    expect(cardSource).toMatch(/async function ensureCardForCompletion\(\{ customerId, serviceRecordId = null, scheduledServiceId = null, suppressIssuedEmail = false \}\)/);
    expect(cardSource).toMatch(/if \(!suppressIssuedEmail\) \{\s*\n\s*await maybeSendCardEmail\(card, customer\);\s*\n\s*\}/);
  });

  test('backfill never auto-applies account credit — invoice stays open for operator review', () => {
    // The auto-apply block is gated on !isBackfillCompletion BEFORE the
    // applyAccountCreditToInvoice call, so a backfilled invoice can neither
    // consume existing credit nor flip itself prepaid.
    expect(source).toMatch(/if \(!isBackfillCompletion\s*\n\s*&& invoice\?\.id && !alreadyPaid && !invoice\.payer_id\s*\n\s*&& !\['paid', 'prepaid'\][\s\S]{0,200}autoApplyAccountCredit\) \{[\s\S]{0,400}applyAccountCreditToInvoice\(\{ invoiceId: invoice\.id \}\)/);
  });

  test('backfill + card hold parks for review instead of charging', () => {
    // The card-hold rail takes a dedicated backfill branch BEFORE the charge
    // path: bell the office about the live hold, leave it held, and never
    // call the charge helpers.
    const backfillHoldBranch = source.match(/\} else if \(isBackfillCompletion\) \{([\s\S]*?)\} else try \{/);
    expect(backfillHoldBranch).not.toBeNull();
    expect(backfillHoldBranch[1]).toContain('heldCardForScheduledService');
    expect(backfillHoldBranch[1]).not.toContain('chargeCardHoldOnCompletion');
    expect(backfillHoldBranch[1]).not.toContain('chargeInvoiceWithSavedCard');
    // The real charge call survives, unreachable for backfill completions.
    expect(source).toMatch(/\} else try \{\s*\n\s*const CardHolds = require\('\.\.\/services\/estimate-card-holds'\);\s*\n\s*const holdCharge = await CardHolds\.chargeCardHoldOnCompletion/);
  });

  test('backfill never credits a referral — no $25 to either party, no referrer SMS/email', () => {
    // creditReferralOnFirstService posts real account credits to BOTH the
    // referrer and the referee AND messages the referrer, so the quiet path
    // must not reach it. The guard also protects the reward's single-use
    // idempotency: firing here would burn it on a visit nobody announced.
    expect(source).toMatch(/const referralVisitPerformed = closedDealVisitPerformed && !isBackfillCompletion;/);
    const referralBlock = source.match(/if \(referralVisitPerformed\) \{([\s\S]*?)\n {4}\}/);
    expect(referralBlock).not.toBeNull();
    expect(referralBlock[1]).toContain('creditReferralOnFirstService');
  });

  test('backfill never opens the mobile in-person payment sheet', () => {
    // invoicePaymentActionRequired drives DispatchPageV2's in-person payment
    // handoff. A backfilled closeout leaves its invoice for office review by
    // contract, so the flag must be forced false before any other condition
    // can turn it on.
    expect(source).toMatch(/const invoicePaymentActionRequired = !!invoice\s*\n(\s*\/\/[^\n]*\n)*\s*&& !isBackfillCompletion/);
  });

  test('lead conversion still runs on a backfill — pure data write, and there is no later completion', () => {
    // convertLeadFromEvent only resolves the originating lead and calls
    // leadAttribution.markConverted — no SMS/email/money anywhere in that
    // path — so it is NOT part of the quiet-path contract. It must stay OUT
    // of the referral guard: a stale-sweep closeout is the last completion
    // these rows ever get, so gating it would strand the lead open forever.
    expect(source).toMatch(/if \(closedDealVisitPerformed\) \{[\s\S]{0,600}convertLeadFromEvent\(\{ source: 'service_completed'/);
    // And the shared predicate itself carries no backfill term.
    expect(source).toMatch(/const closedDealVisitPerformed = visitOutcome !== 'inspection_only'\s*\n\s*&& visitOutcome !== 'customer_declined'\s*\n\s*&& !isIncompleteVisit;/);
    // Belt-and-braces: the referral engine is never reached from that block.
    const leadBlock = source.match(/if \(closedDealVisitPerformed\) \{([\s\S]*?)\n {4}\}/);
    expect(leadBlock[1]).not.toContain('creditReferralOnFirstService');
  });

  test('every post-commit backfill gate sits AFTER the crash-resume re-derivation', () => {
    // isBackfillCompletion is re-derived from the FROZEN structured_notes so a
    // crash-resumed retry (which may arrive without the body flag) stays
    // quiet. Any post-commit gate placed above that line would read a stale
    // `false` on resume and leak. Pin the ordering, not just the presence.
    const rederivation = source.indexOf("parseJsonObject(record.structured_notes)?.backfill === true");
    expect(rederivation).toBeGreaterThan(-1);
    const postCommitGates = [
      // account-credit auto-apply
      'if (!isBackfillCompletion\n      && invoice?.id && !alreadyPaid && !invoice.payer_id',
      // per-application saved-card / ACH auto-charge
      'if (!isBackfillCompletion\n      && perApplicationBilling && visitPerformed',
      // card-hold charge
      '} else if (isBackfillCompletion) {',
      // digital-business-card issued email
      'suppressIssuedEmail: isBackfillCompletion,',
      // payment-decline notice SMS
      '&& !isBackfillCompletion) {',
      // payer AP invoice email
      'invoice.payer_id && !payerInvoiceAlreadyDelivered && !isBackfillCompletion',
      // referral credit
      'const referralVisitPerformed = closedDealVisitPerformed && !isBackfillCompletion;',
    ];
    for (const gate of postCommitGates) {
      const at = source.indexOf(gate);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(rederivation);
    }
  });

  test('backfill is reachable ONLY through POST /complete — the other completion entry points ignore it', () => {
    // Backfill is a body flag on POST /:serviceId/complete. PUT
    // /:serviceId/status and admin-schedule's bare completed flip each run
    // their own (ungated) referral/review rails, so the sweep must never be
    // able to route through them. Neither destructures `backfill`.
    const statusRoute = source.slice(
      source.indexOf("router.put('/:serviceId/status'"),
      source.indexOf("router.get('/:serviceId/complete-preview'"),
    );
    expect(statusRoute.length).toBeGreaterThan(0);
    expect(statusRoute).not.toContain('backfill');

    const scheduleSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(scheduleSource).not.toMatch(/backfill\s*=\s*false|backfill\s*,/);
  });
});
