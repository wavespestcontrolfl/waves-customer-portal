/**
 * Backdated quiet completion (`backfill: true` on POST /:serviceId/complete).
 * Unit-tests the past-date guard + service-date source via the exported
 * backfillCompletionPlan, then pins the route wiring with source contracts:
 * the giant completion route can't be exercised end-to-end here, but the
 * load-bearing lines — backdated completionServiceDate, forced comms/review
 * suppression (initial AND post-resume re-derivation), the structured_notes
 * freeze, the near-term invoice due date, the admin-only authz gate, the
 * quiet card mint, the account-credit skip, the prepaid-credit skip (the
 * rail mutates the invoice — reduces it, books a payments row, can flip it
 * paid — so it is GATED like the other money rails, not "safe by nature"),
 * the fully-prepaid review-invoice mint (out-of-band coverage must not
 * suppress the promised open invoice — behavioral via the exported
 * shouldAutoInvoiceCompletion), the no-fabricated-durations policy, and the
 * labor-costing guard — must not be refactored away silently.
 */
const fs = require('fs');
const path = require('path');
const {
  backfillCompletionPlan,
  applyBackfillDurationPolicy,
  backfillTimeOnSiteMinutes,
  BACKFILL_MAX_TIME_ON_SITE_MINUTES,
  shouldAutoInvoiceCompletion,
} = require('../routes/admin-dispatch')._test;
const { buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');

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

describe('applyBackfillDurationPolicy — no fabricated durations (Codex P1, fix round)', () => {
  // A stale on_site row: checked in weeks ago, closed out from the office
  // today. The shared lifecycle helper's timestamp fallback would book the
  // whole gap as the service duration.
  const STALE_SVC = {
    status: 'on_site',
    actual_start_time: '2026-06-20T14:00:00Z',
    check_in_time: '2026-06-20T14:00:00Z',
  };
  const CLOSEOUT_AT = new Date('2026-07-19T16:00:00Z'); // 29 days later

  test('the hazard is real: without the policy, the helper books the stale gap as duration', () => {
    const raw = buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT);
    expect(raw.service_time_minutes).toBeGreaterThan(24 * 60); // weeks, not a visit
  });

  test('no explicit timeOnSite → duration keys stripped, columns stay unknown (never elapsed math)', () => {
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT),
      undefined,
    );
    expect(updates).not.toHaveProperty('service_time_minutes');
    expect(updates).not.toHaveProperty('actual_duration_minutes');
    // The audit timestamps survive — only the derived duration is dropped.
    expect(updates.actual_end_time).toEqual(CLOSEOUT_AT);
    expect(updates.check_out_time).toEqual(CLOSEOUT_AT);
  });

  test('explicit timeOnSite is honored in every shape the completion body sends', () => {
    for (const [input, expected] of [[45, 45], ['45', 45], ['0:45:00', 45], ['90 min', 90]]) {
      const updates = applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: input }),
        input,
      );
      expect(updates.service_time_minutes).toBe(expected);
      expect(updates.actual_duration_minutes).toBe(expected);
    }
  });

  // Codex P1 (PR #2897): the pre-fix panel auto-submitted its running
  // elapsed — the stale span itself, relabeled as "explicit" input. A
  // provided value is only explicit within a workday; beyond the cap it is
  // treated as absent (columns stay unknown), never a 400.
  test('an auto-elapsed-sized timeOnSite (2 weeks) is rejected by the workday cap — duration keys stripped', () => {
    for (const oversized of [20160, '20160', '336:00:00']) { // 2 weeks as number, string, H:MM:SS
      const updates = applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: oversized }),
        oversized,
      );
      expect(updates).not.toHaveProperty('service_time_minutes');
      expect(updates).not.toHaveProperty('actual_duration_minutes');
    }
  });

  test('the cap boundary: a full workday (720) is honored, one minute past it is not', () => {
    const atCap = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: 720 }),
      720,
    );
    expect(atCap.service_time_minutes).toBe(BACKFILL_MAX_TIME_ON_SITE_MINUTES);
    const pastCap = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: 721 }),
      721,
    );
    expect(pastCap).not.toHaveProperty('service_time_minutes');
    expect(pastCap).not.toHaveProperty('actual_duration_minutes');
  });

  test('garbage timeOnSite is not a fabrication license — falls back to unknown, not to the stale span', () => {
    for (const junk of ['', '  ', 'abc', -5, 0, null]) {
      const updates = applyBackfillDurationPolicy(
        buildCompletionLifecycleUpdates(STALE_SVC, CLOSEOUT_AT, { elapsed: junk }),
        junk,
      );
      expect(updates).not.toHaveProperty('service_time_minutes');
      expect(updates).not.toHaveProperty('actual_duration_minutes');
    }
  });

  test('a never-checked-in stale row (pending/confirmed) stays unknown too', () => {
    const updates = applyBackfillDurationPolicy(
      buildCompletionLifecycleUpdates({ status: 'pending' }, CLOSEOUT_AT),
      undefined,
    );
    expect(updates).not.toHaveProperty('service_time_minutes');
    expect(updates).not.toHaveProperty('actual_duration_minutes');
  });
});

describe('backfillTimeOnSiteMinutes — the shared workday-cap sanitizer (Codex P1, PR #2897)', () => {
  // One function feeds BOTH the persisted duration (applyBackfillDurationPolicy)
  // and the job-costing explicitLaborMinutes forward — so "rejected" here IS
  // "no explicit labor minutes forwarded" (calcLaborCost treats null as no
  // data and, with untrustedLifecycleSpan, books zero labor rather than the
  // stale span).
  test('a plausible visit duration passes through, in every completion-body shape', () => {
    expect(backfillTimeOnSiteMinutes(45)).toBe(45);
    expect(backfillTimeOnSiteMinutes('45')).toBe(45);
    expect(backfillTimeOnSiteMinutes('0:45:00')).toBe(45);
    expect(backfillTimeOnSiteMinutes('90 min')).toBe(90);
    expect(backfillTimeOnSiteMinutes(720)).toBe(720);
  });

  test('an auto-elapsed-sized value (2 weeks) or anything past a workday → null, never forwarded', () => {
    expect(backfillTimeOnSiteMinutes(20160)).toBeNull();
    expect(backfillTimeOnSiteMinutes('336:00:00')).toBeNull();
    expect(backfillTimeOnSiteMinutes(721)).toBeNull();
  });

  test('absent/zero/garbage → null', () => {
    for (const junk of [null, undefined, '', '  ', 0, -5, 'abc']) {
      expect(backfillTimeOnSiteMinutes(junk)).toBeNull();
    }
  });
});

describe('shouldAutoInvoiceCompletion — backfill review-invoice override (Codex P1)', () => {
  // The reported shape: a priced backfill visit whose operator recorded an
  // out-of-band prepaid_amount (cash/Zelle) fully covering the bill. The
  // route derives the composite prepaidCovered=true via the OUT-OF-BAND leg
  // (annualPrepayCovered=false) — which used to return false here and mint
  // no invoice at all, leaving the recorded prepayment with nothing to
  // reconcile against. The minted invoice lands OPEN ('draft' from
  // InvoiceService.create) with the prepayment UNAPPLIED — both pinned by
  // the prepaid-credit-skip source contract below.
  const prepaidBackfill = {
    recapReviewOnly: false,
    alreadyPaid: false,
    prepaidCovered: true,
    autopayCoversVisit: false,
    preMintedInvoice: null,
    existingCompletionInvoice: null,
    createInvoiceOnComplete: true,
    waveguardTier: null,
    hasVisitPrice: true,
    invoiceAmount: 129,
    autoInvoicePricedVisits: false,
    serviceType: 'Quarterly Pest Control Service',
    isCallback: false,
    visitPerformed: true,
    isBackfillCompletion: true,
    annualPrepayCovered: false,
  };

  test('backfill: a fully-covering out-of-band prepaid_amount no longer suppresses — the open review invoice mints', () => {
    expect(shouldAutoInvoiceCompletion(prepaidBackfill)).toBe(true);
  });

  test('non-backfill control: the same fully prepaid visit still mints NO invoice (live behavior unchanged)', () => {
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, isBackfillCompletion: false })).toBe(false);
    // …and a caller that never passes the new inputs (the pre-change shape)
    // gets the identical suppression — defaults are inert.
    const legacyShape = { ...prepaidBackfill };
    delete legacyShape.isBackfillCompletion;
    delete legacyShape.annualPrepayCovered;
    expect(shouldAutoInvoiceCompletion(legacyShape)).toBe(false);
  });

  test('annual-prepay coverage is EXCLUDED from the override — settled plan money never re-bills', () => {
    // annualPrepayCoversVisit feeds the same composite prepaidCovered flag,
    // but that money is genuinely settled on the annual prepay invoice (its
    // own paper trail via settleInvoiceAsAnnualPrepayCovered) — a fresh
    // collectible invoice would double-bill covered plan work.
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, annualPrepayCovered: true })).toBe(false);
  });

  test('autopay dues coverage is untouched by the override', () => {
    expect(shouldAutoInvoiceCompletion({
      ...prepaidBackfill, prepaidCovered: false, autopayCoversVisit: true,
    })).toBe(false);
  });

  test('every other suppressor still holds under backfill — already-billed work never double-mints', () => {
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, alreadyPaid: true })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, preMintedInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, existingCompletionInvoice: { id: 'inv' } })).toBe(false);
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, recapReviewOnly: true })).toBe(false);
  });

  test('the override removes only the prepaid suppression — an otherwise-unbillable visit still mints nothing', () => {
    expect(shouldAutoInvoiceCompletion({ ...prepaidBackfill, invoiceAmount: 0 })).toBe(false);
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

  test('backfill never auto-applies the prepaid credit — invoice mutation stays with the reviewer', () => {
    // applyPrepaidCreditToInvoice reduces the invoice total, inserts a
    // payments row, and can flip the invoice paid. Recording money the
    // operator already collected is still invoice mutation on the quiet
    // path, so the rail is gated INSIDE the helper — covering BOTH call
    // sites (fresh completion invoice and pre-minted Tap-to-Pay invoice) —
    // with a log line pointing review at the prepaid_amount on file.
    const helper = source.match(/const applyPrepaidCreditToInvoice = async \(invoiceRow\) => \{([\s\S]*?)\n {4}\};/);
    expect(helper).not.toBeNull();
    const gateAt = helper[1].indexOf('if (isBackfillCompletion) {');
    expect(gateAt).toBeGreaterThan(-1);
    // The gate returns the invoice untouched BEFORE the crediting transaction.
    expect(helper[1].indexOf('db.transaction')).toBeGreaterThan(gateAt);
    expect(helper[1]).toContain('prepaid credit NOT auto-applied');
    expect(helper[1]).toContain('prepaid_amount');
    // Both call sites still route through the gated helper.
    expect(source).toMatch(/invoice = await applyPrepaidCreditToInvoice\(invoice\);/);
    expect(source).toMatch(/preMintedInvoice = await applyPrepaidCreditToInvoice\(preMintedInvoice\);/);
  });

  test('fully prepaid backfill still mints the open review invoice — override wired into the invoice decision', () => {
    // The route feeds the backfill flag AND the annual-prepay leg into
    // shouldAutoInvoiceCompletion (behavioral coverage above): out-of-band
    // prepaid coverage stops suppressing, annual-prepay coverage keeps
    // suppressing.
    expect(source).toMatch(/const shouldInvoice = shouldAutoInvoiceCompletion\(\{[\s\S]*?visitPerformed,[\s\S]*?isBackfillCompletion,\s*\n\s*annualPrepayCovered,\s*\n\s*\}\);/);
    // And the structured_notes resume re-derivation sits BEFORE the invoice
    // decision, so a crash-resumed retry (body flag absent) reaches the same
    // override instead of silently re-suppressing the invoice.
    const rederivation = source.indexOf("parseJsonObject(record.structured_notes)?.backfill === true");
    const invoiceDecision = source.indexOf('const shouldInvoice = shouldAutoInvoiceCompletion({');
    expect(rederivation).toBeGreaterThan(-1);
    expect(invoiceDecision).toBeGreaterThan(rederivation);
    // The minted invoice is OPEN by construction ('draft' from
    // InvoiceService.create; near-term due date pinned above) and the
    // prepayment stays UNAPPLIED via the gated prepaid rail (contract
    // above) — reconciliation is the reviewer's explicit step.
  });

  test('backfill durations come from the policy, not the stale lifecycle timestamps', () => {
    // The route builds lifecycle updates from the shared helper, then under
    // backfill immediately re-derives the duration through the policy
    // (sanitized timeOnSite or unknown — behavioral coverage above).
    expect(source).toMatch(/const lifecycleUpdates = buildCompletionLifecycleUpdates\(svc, completionEndedAt, \{ elapsed: effectiveTimeOnSite \}\);[\s\S]{0,400}if \(isBackfillCompletion\) applyBackfillDurationPolicy\(lifecycleUpdates, effectiveTimeOnSite\);/);
  });

  test('timeOnSite is sanitized ONCE at intake — every consumer reads the same value or absence', () => {
    // Under backfill the raw body value is replaced by the workday-capped
    // minutes (or null); non-backfill completions pass through untouched.
    expect(source).toMatch(/const effectiveTimeOnSite = isBackfillCompletion\s*\n\s*\? backfillTimeOnSiteMinutes\(timeOnSite\)\s*\n\s*: timeOnSite;/);
    // A rejected value logs a note — the closeout still succeeds (no 400
    // path exists between the sanitation and the log).
    expect(source).toMatch(/if \(isBackfillCompletion && effectiveTimeOnSite == null && timeOnSite != null && timeOnSite !== ''\) \{\s*\n\s*logger\.warn\([\s\S]{0,300}recorded as unknown/);
    // The structured_notes stamp — the report's on-site metric reads it via
    // computeOnSiteMin — carries the sanitized value, never the raw span.
    expect(source).toMatch(/timeOnSite: effectiveTimeOnSite \|\| null,/);
    // And no other consumer still reads the raw body value: `timeOnSite`
    // appears only in the destructure, the sanitation, and the helpers'
    // definitions/comments — never as a bare argument past the intake.
    const afterIntake = source.slice(source.indexOf('const effectiveTimeOnSite = isBackfillCompletion'));
    expect(afterIntake).not.toMatch(/\{ elapsed: timeOnSite \}/);
    expect(afterIntake).not.toMatch(/applyBackfillDurationPolicy\(lifecycleUpdates, timeOnSite\)/);
    expect(afterIntake).not.toMatch(/minutesFromElapsed\(timeOnSite\)/);
  });

  test('backfill job costing never derives labor from the stale span (or the clock-in window over it)', () => {
    // The completion route flags the span untrusted and forwards the
    // operator's explicit minutes through the SAME workday-cap sanitizer
    // the duration policy uses — an oversized value forwards null, so
    // persisted duration and costed labor can never disagree…
    expect(source).toMatch(/JobCosting\.calculateJobCost\(svc\.id, undefined, isBackfillCompletion\s*\n\s*\? \{ untrustedLifecycleSpan: true, explicitLaborMinutes: backfillTimeOnSiteMinutes\(effectiveTimeOnSite\) \}\s*\n\s*: \{\}\)/);
    // …and calcLaborCost honors it: the technician clock-in-window fallback
    // and the actual_start/end span fallback are both skipped for untrusted
    // bounds; only direct job entries or the explicit minutes may count.
    const costingSource = fs.readFileSync(path.join(__dirname, '../services/job-costing.js'), 'utf8');
    expect(costingSource).toMatch(/if \(!minutes && !untrustedLifecycleSpan && technicianId && startTime && endTime\) \{/);
    expect(costingSource).toMatch(/if \(!minutes && untrustedLifecycleSpan\) \{\s*\n\s*const explicit = Number\(explicitLaborMinutes\);\s*\n\s*if \(Number\.isFinite\(explicit\) && explicit > 0\) minutes = Math\.round\(explicit\);\s*\n\s*\}/);
    expect(costingSource).toMatch(/if \(!minutes && !untrustedLifecycleSpan && startTime && endTime\) \{/);
    // calculateJobCost threads the options through to calcLaborCost.
    expect(costingSource).toMatch(/\{ untrustedLifecycleSpan, explicitLaborMinutes \},\s*\n\s*\);/);
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
      // prepaid-credit application (gate lives inside the helper, defined
      // and called after the re-derivation)
      'prepaid credit NOT auto-applied',
      // job-costing labor guard
      'untrustedLifecycleSpan: true',
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
