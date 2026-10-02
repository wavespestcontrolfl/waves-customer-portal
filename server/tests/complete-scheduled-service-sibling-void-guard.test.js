/**
 * complete-scheduled-service.js — REFUSE AFTER A VOID (owner ruling, the
 * completion-side half of the fix).
 *
 * findFirstApplicationInvoiceForEstimateService's own query EXCLUDES 'void'
 * entirely, so a voided combined first-application invoice — and a
 * recognized CANCELED one with no setup-fee line — are both invisible to it
 * AND to the existing canceledSetupFee park. Without this guard, completing
 * the still-unpriced sibling after its estimate's combined invoice died
 * would auto-mint the per-application fee on top of the combined amount the
 * PRICED reserved row still (correctly) bills once — the same double charge
 * admin-schedule-charge-now-sibling-refusal.test.js pins for the Charge Now
 * path. This is the SAME rule (billing-lane.js combinedInvoiceVoidedWithoutLiveReplacement),
 * reused via the EXISTING terminal-invoice park/alert machinery — no new
 * completion-side mint/split logic.
 *
 * A full behavioral drive of completeScheduledService needs a migrated
 * Postgres database and this file's own enormous fixture surface (completion
 * attempts, service records, transactions) — mirrors
 * invoice-issued-closeout-completion-postgres.test.js's own "source
 * contracts" precedent for pinning THIS SAME giant file's integration
 * points without one.
 */
const fs = require('fs');
const path = require('path');

describe('complete-scheduled-service.js — REFUSE AFTER A VOID completion-side guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('imports combinedInvoiceVoidedWithoutLiveReplacement + isSiblingCoverageEligibleVisit + hasAuthoritativeZeroPrice from billing-lane.js', () => {
    const importLine = source.match(/const \{[^}]*\} = require\('\.\.\/services\/billing-lane'\);/)?.[0];
    expect(importLine).toBeTruthy();
    expect(importLine).toContain('combinedInvoiceVoidedWithoutLiveReplacement');
    expect(importLine).toContain('isSiblingCoverageEligibleVisit');
    expect(importLine).toContain('hasAuthoritativeZeroPrice');
  });

  test('the sibling-first-application block asks the void guard only after existingCompletionInvoice, the terminal split, and canceledSetupFee all come back empty', () => {
    const anchor = source.indexOf("const siblingFirstApplication = await findFirstApplicationInvoiceForEstimateService(svc, db);");
    expect(anchor).toBeGreaterThan(-1);
    const block = source.slice(anchor, anchor + 6000);
    // Order: split.terminal (refunded/canceled-with-setup-fee) first, THEN
    // canceledSetupFee, THEN (only if still nothing) the new void guard —
    // never ahead of the existing checks.
    const splitAt = block.indexOf('if (split.terminal)');
    const canceledSetupFeeAt = block.indexOf('siblingFirstApplication.canceledSetupFee');
    const voidGuardAt = block.indexOf('combinedInvoiceVoidedWithoutLiveReplacement(svc, db)');
    expect(splitAt).toBeGreaterThan(-1);
    expect(canceledSetupFeeAt).toBeGreaterThan(splitAt);
    expect(voidGuardAt).toBeGreaterThan(canceledSetupFeeAt);
    // Gated behind the SAME isSiblingCoverageEligibleVisit shape Charge Now
    // uses (unpriced, estimate-linked, non-callback, non-always-free) —
    // never the priced reserved row (owner ruling: completing/charging it
    // bills the combined amount once, which is correct).
    expect(block).toMatch(/isSiblingCoverageEligibleVisit\(\{\s*\n\s*sourceEstimateId: svc\.source_estimate_id, hasOwnPrice, isCallback: svc\.is_callback, serviceType: svc\.service_type,/);
    // Sets terminalCompletionInvoice from the voided invoice found — reuses
    // the EXISTING park/alert machinery (shouldAutoInvoiceCompletion's
    // terminalInvoiceOnVisit suppressor + the manual-billing bell below),
    // never a new completion-side mint/split path.
    expect(block).toMatch(/terminalCompletionInvoice = \{\s*\n\s*id: voidedCombined\.id, invoice_number: voidedCombined\.invoice_number, status: voidedCombined\.status,/);
  });

  test('terminalInvoiceOnVisit (fed by terminalCompletionInvoice) suppresses the auto-invoice gate — the ONLY reason setting it here is safe', () => {
    // shouldAutoInvoiceCompletion's own contract: this is what makes
    // terminalCompletionInvoice a real refusal, not just an alert with a
    // silent mint beside it.
    expect(source).toMatch(/if \(terminalInvoiceOnVisit\) return false;/);
    expect(source).toMatch(/terminalInvoiceOnVisit: !!terminalCompletionInvoice,/);
  });
});

// Codex r4 P1 on #5237 (+ its pre-push follow-ups): completion's in-lock
// covered-member refusal reaches BOTH mint lanes, is shape-gated like every
// other sibling-coverage check, and createFromService runs it on every
// linked mint under the visit row lock — not only the replay lane.
describe('complete-scheduled-service.js — in-lock covered-member mint guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const invoiceSource = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');

  test('the guard is shape-gated and passed to both completion mint lanes', () => {
    expect(source).toMatch(/const coveredMemberMintGuard = isSiblingCoverageEligibleVisit\(\{\s*\n\s*sourceEstimateId: svc\.source_estimate_id, hasOwnPrice: false, isCallback: svc\.is_callback, serviceType: svc\.service_type,/);
    expect(source).toContain('? (trx) => refuseCoveredMemberMintInTrx(trx, svc.id)');
    expect(source.match(/recheckInTrx: coveredMemberMintGuard,/g)).toHaveLength(2);
  });

  test('a covered-member refusal releases for resume (the retry reuses the combined invoice) and never rings the manual-billing bell', () => {
    expect(source).toContain("const coveredByCombined = invErr?.code === 'FIRST_APPLICATION_COVERED' && !invoice?.id;");
    expect(source).toContain('if (!coveredByCombined && !setupFeeInFlight && backfillReviewMintRequired && !invoice?.id) {');
    const branchAt = source.indexOf('if (coveredByCombined) {');
    const bellAt = source.indexOf("logger.error(`[dispatch] Auto-invoice failed (non-blocking): ${invErr.message}`);");
    expect(branchAt).toBeGreaterThan(-1);
    expect(bellAt).toBeGreaterThan(branchAt);
    const branch = source.slice(branchAt, bellAt);
    expect(branch).toContain('} else {');
    // Codex r5 P1: never a quiet finalize without the combined invoice.
    expect(branch).toContain('await CompletionAttempts.releaseCompletionAttemptForResume(completionAttempt, invErr);');
    expect(branch).toContain("code: 'first_application_coverage_changed',");
    expect(branch).toMatch(/return \(\{ status: 503,/);
  });

  test('createFromService runs recheckInTrx on every linked mint, taking the visit lock chain first on non-replay lanes', () => {
    const at = invoiceSource.indexOf('if (recheckInTrx && conn && sr.scheduled_service_id) {');
    expect(at).toBeGreaterThan(-1);
    const block = invoiceSource.slice(at, at + 500);
    const chainAt = block.indexOf('await acquireScheduledMintLockChain(conn, {');
    const recheckAt = block.indexOf('await recheckInTrx(conn);');
    expect(block).toContain('if (!replayFromScheduled) {');
    expect(chainAt).toBeGreaterThan(-1);
    expect(recheckAt).toBeGreaterThan(chainAt);
    // Runs before the line build, never after create().
    expect(invoiceSource.indexOf('const scheduledInvoice = replayFromScheduled', at)).toBeGreaterThan(at);
  });
});
