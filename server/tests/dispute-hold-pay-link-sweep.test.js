/**
 * Sweep guard (owner ruling 2026-09-30, PR #5424 round 8): while a customer has an ACTIVE
 * collections dispute hold no AUTOMATED billing follow-up carrying a pay or update-card link
 * reaches them. The customer-message boundary (send-customer-message.js step 1.5) gates the
 * purposes and dunning entry points below, and the billing email authority gates the dunning email
 * templates, so every sender that uses one must be classified here on purpose. A new sender fails
 * this test until it is classified, instead of slipping past the hold.
 *
 * Source scans only: no database, nothing sends.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function sourceFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });
}
const RUNTIME = [...sourceFiles('services'), ...sourceFiles('routes')];
const filesMatching = (re) => RUNTIME.filter((f) => re.test(read(f))).sort();

describe('customer-message purposes gated by the dispute hold at the send boundary', () => {
  // (?<![_a-z]) keeps `replay_purpose: 'payment_failure'` (a stored-row label) out of the scan.
  const GATED_PURPOSE = /(?<![_a-zA-Z])purpose:\s*'(payment_failure|autopay)'/;

  test('every sender of a hold-gated purpose is classified', () => {
    expect(filesMatching(GATED_PURPOSE)).toEqual([
      // machine-initiated card-expiry / pre-charge notices (purpose autopay): gated at the boundary,
      // COLLECTION_HOLD_SUPPRESSED treated as a wait (skipped, nothing stamped, retried next sweep)
      'routes/stripe-webhook.js', // sendBillingSms: gated; customerInitiated only from the PI's own markers
      'services/autopay-notifications.js',
      'services/billing-cron.js', // failure / retry notices: gated, never customerInitiated
      'services/complete-scheduled-service.js', // decline notice: gated + promoted to the invoice hand-over
      'services/termite-annual-renewal-charge.js', // renewal-charge failure notice: gated
      'services/workflows/payment-expiry.js',
    ]);
  });

  test('the boundary gates the machine-initiated payment_failure / autopay purposes and the dunning entry points, with the operator and customer exemptions', () => {
    const src = read('services/messaging/send-customer-message.js');
    expect(src).toMatch(/HOLD_GATED_MESSAGE_PURPOSES = Object\.freeze\(\['payment_failure', 'autopay'\]\)/);
    expect(src).toMatch(/HOLD_GATED_MESSAGE_PURPOSES\.includes\(input\.purpose\)\) return true/);
    expect(src).toMatch(/HOLD_GATED_DUNNING_ENTRY_POINTS\.has\(String\(input\.entryPoint/);
    // ONE predicate (billingHoldBlock) carries the gate + both exemptions, and runs twice: step 1.5
    // and again inside providerPreparationCheck, the last pre-provider callback (round-11 P1).
    expect(src).toMatch(/if \(!isHoldGatedBillingMessage\(input\)\) return null;\s*const ignoreDisputeHold = input\.customerInitiated === true \|\| collectionHold\.holdExemptionApplies\(input\.holdExempt\);/);
    expect(src.match(/await billingHoldBlock\(/g) || []).toHaveLength(2);
    const prep = src.slice(src.indexOf('const providerPreparationCheck'), src.indexOf('providerPreparationCheck.isStillValid'));
    expect(prep).toMatch(/await billingHoldBlock\(sendInput, handoffDb\)/);
    expect(prep).toMatch(/'collection_hold_boundary'/);
  });

  test('only the Stripe webhook (from the PaymentIntent\'s own markers) and the payment-failed email assert customerInitiated on these notices', () => {
    const asserting = RUNTIME.filter((f) => /customerInitiated:\s*true|\.\.\.\(customerInitiated \? \{ customerInitiated: true \}/.test(read(f))
      && GATED_PURPOSE.test(read(f)));
    expect(asserting).toEqual(['routes/stripe-webhook.js']);
  });

  test('the callers that get COLLECTION_HOLD_SUPPRESSED treat it as a wait, never a failure', () => {
    for (const file of ['services/autopay-notifications.js', 'services/workflows/payment-expiry.js']) {
      expect(read(file)).toMatch(/COLLECTION_HOLD_SUPPRESSED/);
    }
    // the completion decline notice promotes it to the invoice hand-over
    expect(read('services/complete-scheduled-service.js'))
      .toMatch(/failResult\.code === 'COLLECTION_HOLD_SUPPRESSED'\) payLinkHeldByDisputeHold = true/);
  });
});

describe('lifecycle (payment.*) emails that carry a pay / update-card link', () => {
  test('one shared template set feeds the fresh-send guard and the stored-copy paths', () => {
    const Hold = require('../services/collections/collection-hold');
    expect([...Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES].sort()).toEqual(['payment.failed', 'payment.method_expiring', 'payment.retry_notice']);
    // the guard's set is the lifecycle set plus the machine-initiated dunning templates (below)
    for (const templateKey of Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES) expect(Hold.HOLD_GATED_EMAIL_TEMPLATES.has(templateKey)).toBe(true);
    expect(read('services/payment-lifecycle-email.js')).toMatch(/HOLD_GATED_TEMPLATES = require\('\.\/collections\/collection-hold'\)\.HOLD_GATED_EMAIL_TEMPLATES/);
  });

  test('every path that re-sends a STORED email snapshot to a customer asks the hold first', () => {
    // A stored snapshot re-sent through sendgrid.sendOne without going back through the lifecycle
    // guard: the provider-block retry rail and bounce recovery. Both call storedLifecycleEmailHeld.
    const storedSnapshotSenders = filesMatching(/sendgrid\.sendOne\([\s\S]{0,400}html_snapshot|html:\s*message\.html_snapshot|html:\s*bouncedMessage\.html_snapshot/);
    expect(storedSnapshotSenders).toEqual(['services/email-bounce-recovery.js', 'services/transactional-email-provider-retry.js']);
    for (const file of storedSnapshotSenders) expect(read(file)).toMatch(/storedLifecycleEmailHeld|holdGateLifecycleRetry/);
    expect(read('services/transactional-email-provider-retry.js')).toMatch(/holdGateLifecycleRetry\(message\)/);
  });

  test('every sender of a hold-gated lifecycle email is classified (all go through sendLifecycleTemplate\'s guard)', () => {
    expect(filesMatching(/\.sendPaymentRetryNotice\(|\.sendPaymentMethodExpiring\(|\.sendPaymentFailed\(/)).toEqual([
      'routes/stripe-webhook.js', // sendPaymentFailed: customerInitiated from the PI's own markers
      'services/autopay-notifications.js', // sendPaymentMethodExpiring
      'services/billing-cron.js', // sendPaymentRetryNotice (via billing-retry-email-obligation)
      'services/billing-retry-email-obligation.js',
      'services/workflows/payment-expiry.js',
    ]);
  });

  test('the payment-failed automation sequence re-checks the hold and never floods the runner page', () => {
    const src = read('services/automation-runner.js');
    expect(src).toMatch(/deferPaymentFailedForHold/);
    expect(src).toMatch(/whereNot\('e\.template_key', 'payment_failed'\)/);
    expect(src).toMatch(/collectionHoldExistsSql\(this, 'e\.customer_id'\)/);
  });
});


// ---------------------------------------------------------------------------------------------
// The MACHINE-INITIATED DUNNING senders (PR #5424 round 9). Their preflight consults the hold, then
// they await credit application, link shortening, ledger writes and rendering, so the hold is also
// enforced at the provider-side chokepoints: the customer-message boundary (Text / App, keyed on the
// entry point because 'payment_link' / 'billing' are shared purposes) and the billing email
// authority (Email, keyed on the dunning template). Each is a WAIT for its caller.
// ---------------------------------------------------------------------------------------------
describe('machine-initiated dunning senders are gated at the send boundaries', () => {
  const Hold = require('../services/collections/collection-hold');

  // Shared purposes: every sendCustomerMessage caller of 'payment_link' / 'billing' is either a
  // dunning sender (gated by its entry point) or classified exempt here with its reason.
  const SHARED_PURPOSE = /(?<![_a-zA-Z])purpose:\s*['"](payment_link|billing)['"]/;
  test('every sender using the shared payment_link / billing purposes is classified', () => {
    expect(filesMatching(SHARED_PURPOSE)).toEqual([
      // --- machine-initiated dunning: gated at the boundary by HOLD_GATED_DUNNING_ENTRY_POINTS ---
      'routes/admin-projects.js', // EXEMPT: an operator's own click (operatorInitiated), not automated follow-up
      'services/annual-prepay-renewals.js', // EXEMPT: the termite renewal NOTICE (dates, fee, cancel terms), no pay link
      'services/invoice-followups.js', // GATED: Day 3-90 ladder (invoice_followup_sequence); send-now passes holdExempt 'operator'
      'services/invoice.js', // EXEMPT: the invoice sender itself (invoice_send_via_sms): its own default-on hold check
      'services/late-payment-checker.js', // GATED: late_payment_checker / late_payment_checker_microdeposit
      'services/previsit-balance-reminder.js', // GATED: previsit_balance_reminder
      'services/price-change-notices.js', // EXEMPT: an operator-confirmed price-change notice, no pay link
      'services/workflows/balance-reminder.js', // GATED: balance_reminder_workflow / balance_reminder_late_payment_check
    ]);
  });

  test('every entry point the dunning senders use is gated or classified as a non-pay-link notice', () => {
    const gated = [...Hold.HOLD_GATED_DUNNING_ENTRY_POINTS].sort();
    expect(gated).toEqual([
      'balance_reminder_late_payment_check', 'balance_reminder_workflow', 'invoice_followup_sequence',
      'late_payment_checker', 'late_payment_checker_microdeposit', 'previsit_balance_reminder',
    ]);
    // thank-you / receipt texts carry no pay link (a payment was just received)
    const NON_PAY_LINK_ENTRY_POINTS = ['invoice_followup_thank_you', 'balance_reminder_payment_received'];
    for (const file of ['services/invoice-followups.js', 'services/late-payment-checker.js',
      'services/previsit-balance-reminder.js', 'services/workflows/balance-reminder.js']) {
      const literals = [...read(file).matchAll(/entryPoint:\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]);
      expect(literals.length).toBeGreaterThan(0);
      for (const literal of literals) {
        expect([file, [...gated, ...NON_PAY_LINK_ENTRY_POINTS].includes(literal)]).toEqual([file, true]);
      }
    }
    // late-payment-checker passes its entry point through a variable: every value it is given is gated
    const checkerValues = [...read('services/late-payment-checker.js').matchAll(/entryPoint:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(checkerValues.sort()).toEqual(['late_payment_checker', 'late_payment_checker_microdeposit']);
  });

  test('every file that consults the rail guard for a billing reminder is classified', () => {
    expect(filesMatching(/require\(['"](\.\/|\.\.\/)(collections\/)?rail-guard['"]\)/)).toEqual([
      'services/billing-reminder-delivery.js', // gated via its senders' boundaries; a suppressed leg is RELEASED (no failed row), episode stays open
      'services/collections/outbound-voice/collections-conversation.js', // EXEMPT: customer-requested pay link (holdExempt 'customer')
      'services/invoice-followups.js', // GATED (early consult + both boundaries); send-now = holdExempt 'operator'
      'services/late-payment-checker.js', // GATED
      'services/messaging/billing-email-replay-eligibility.js', // replay eligibility: waits with holdDefer
      'services/messaging/deferred-replay-registry.js', // queued replays: disputeHoldRecheck waits (retryAt), sends after release
      'services/previsit-balance-reminder.js', // GATED
      'services/workflows/balance-reminder.js', // GATED
    ]);
  });

  test('every consumer of the shared reminder-delivery helper is a classified dunning sender', () => {
    expect(filesMatching(/require\(['"](\.\/|\.\.\/)billing-reminder-delivery['"]\)/)).toEqual([
      'services/invoice-followups.js', // verdict helpers only
      'services/late-payment-checker.js', // verdict helpers only
      'services/previsit-balance-reminder.js', // sendReminderChannels: a suppressed leg is released, episode stays open
      'services/workflows/balance-reminder.js', // sendReminderChannels: same
    ]);
  });

  test('the dunning email templates are one list shared with the sender-rendered set, and cover every template the senders name', () => {
    const InvoiceFollowUps = require('../services/invoice-followups');
    const dunning = Hold.HOLD_GATED_DUNNING_EMAIL_TEMPLATES;
    expect(dunning).toBe(require('../services/billing-email-no-replay').SENDER_RENDERED_TEMPLATES);
    for (const templateKey of Object.values(InvoiceFollowUps.FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID)) expect(dunning.has(templateKey)).toBe(true);
    const balanceKeys = [...read('services/workflows/balance-reminder.js').matchAll(/templateKey:\s*"(billing_late_payment_\d+_day)"/g)].map((m) => m[1]);
    expect(balanceKeys).toHaveLength(5);
    for (const templateKey of balanceKeys) expect(dunning.has(templateKey)).toBe(true);
    expect(read('services/microdeposit-verification-email.js')).toMatch(/TEMPLATE_KEY = 'payment\.microdeposit_verification'/);
    expect(dunning.has('payment.microdeposit_verification')).toBe(true);
    expect(read('services/previsit-balance-reminder.js')).toMatch(/EMAIL_TEMPLATE_KEY = 'billing\.previsit_balance'/);
    expect(dunning.has('billing.previsit_balance')).toBe(true);
    // ... and the lifecycle set is unchanged, both feeding the one HOLD_GATED_EMAIL_TEMPLATES
    expect([...Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES].sort()).toEqual(['payment.failed', 'payment.method_expiring', 'payment.retry_notice']);
    for (const templateKey of [...Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES, ...dunning]) expect(Hold.HOLD_GATED_EMAIL_TEMPLATES.has(templateKey)).toBe(true);
    expect(Hold.HOLD_GATED_EMAIL_TEMPLATES.size).toBe(Hold.HOLD_GATED_LIFECYCLE_EMAIL_TEMPLATES.size + dunning.size);
  });

  test('a dunning email template literal anywhere in the runtime must be in the gated set (a new template cannot slip past)', () => {
    const literal = /['"](invoice\.followup_[a-z0-9_]+|billing_late_payment_[a-z0-9_]+|payment\.microdeposit_verification|billing\.previsit_balance)['"]/g;
    const seen = new Set();
    for (const file of RUNTIME) for (const m of read(file).matchAll(literal)) seen.add(m[1]);
    // routes/admin-email-templates.js lists the protected keys; that list must equal what is gated
    for (const key of seen) expect([key, Hold.HOLD_GATED_DUNNING_EMAIL_TEMPLATES.has(key)]).toEqual([key, true]);
  });

  test('the billing email authority reads the hold for those templates at the provider boundary, twice, honouring the exemptions', () => {
    const src = read('services/billing-channel-email-authority.js');
    expect(src).toMatch(/HOLD_GATED_EMAIL_TEMPLATES\.has\(templateKey\)/);
    expect(src).toMatch(/invoice\?\.payer_id \|\| !input\?\.customerId/);
    // before dispatch AND at the final provider-boundary check
    expect(src.match(/dunningHoldBlock\(/g)).toHaveLength(3); // definition + two call sites
    expect(src).toMatch(/code, held\.reason|HOLD_DEFER_CODE/);
  });

  test('every sender that goes through the billing email authority is classified', () => {
    expect(filesMatching(/dispatchUnderBillingEmailAuthority\(/)).toEqual([
      'services/account-membership-email.js', // GATED by template (billing.previsit_balance)
      'services/automation-runner.js', // payment-failed automation: its own up-front + locked hold check (COLLECTION_HOLD_DEFER)
      'services/billing-channel-email-authority.js', // the authority itself (the definition, not a sender)
      'services/billing-channel-email.js', // the routed billing.notice leg: gated a step earlier at the customer-message boundary
      'services/billing-email-provider-replay.js', // stored-copy replay: its own hold check
      'services/invoice-email.js', // the invoice email itself: its own provider-boundary hold check
      'services/invoice-followups.js', // GATED by template
      'services/microdeposit-verification-email.js', // GATED by template
      'services/workflows/balance-reminder.js', // GATED by template
    ]);
  });

  test('every hold-suppression the callers meet is treated as a WAIT: released reservation, no failed stamp, touch stays due', () => {
    // one classification per caller: the reservation is released (never stamped failed) on a suppression
    const RELEASES = {
      'services/billing-reminder-delivery.js': /isHoldSuppression\(result\)\) \{\s*await ContactLedger\.releaseHeldReservation\(entry\)/,
      'services/invoice-followups.js': /heldByDisputeHold\(sendResult\)[\s\S]{0,400}releaseHeldReservation\(smsLedger\)/,
      'services/late-payment-checker.js': /isHoldSuppression\(result\)\) \{\s*await ContactLedger\.releaseHeldReservation\(ledger\)/,
      'services/previsit-balance-reminder.js': /isHoldSuppression\(result\)\) await ContactLedger\.releaseHeldReservation\(smsLedger\)/,
      'services/workflows/balance-reminder.js': /isHoldSuppression\(sendResult\)\) \{[\s\S]{0,400}releaseHeldReservation\(ledgerEntry\)/,
    };
    for (const [file, pattern] of Object.entries(RELEASES)) expect([file, pattern.test(read(file))]).toEqual([file, true]);
    expect(read('services/invoice-followups.js')).toMatch(/if \(heldByDisputeHold\(result\)\) \{\s*await ContactLedger\.releaseHeldReservation\(ledger\);\s*return true;/);
    // the operator "send now" text carries the trusted exemption; automated ladder touches carry none
    expect(read('services/invoice-followups.js')).toMatch(/\.\.\.\(operatorInitiated \? \{ holdExempt: 'operator' \} : \{\}\)/);
    // the voice "text me the link" tool: rail-guard consult and send both carry the customer exemption
    expect(read('services/collections/outbound-voice/collections-conversation.js')).toMatch(/holdExempt: 'customer',\s*\}\);/);
    expect(read('services/collections/outbound-voice/collections-conversation.js')).toMatch(/sendViaSMS\(invoiceId, \{ operatorInitiated: true, holdExempt: 'customer' \}\)/);
  });
});

// Codex #5424 round 13: MESSAGING waits on any active collection_hold (dispute or wrong-number /
// wrong-party fallback); CHARGING stops on a dispute only. The two predicates must not drift: every
// module that still reads the dispute-only readers is a money / charge / lapse lane, listed here on
// purpose. A messaging lane that reads them would let a restored fallback hold through.
describe('messaging hold predicate vs charging hold predicate (round 13)', () => {
  test('only the charge / lapse / credit lanes read the dispute-only readers; no messaging module does', () => {
    expect(filesMatching(/customerHasActiveCollectionHold|collectionHoldInvoiceIds|disputeHoldExistsSql|activeDisputeHolds/)
      .filter((f) => f !== 'services/collections/collection-hold.js')).toEqual([
      'services/annual-prepay-renewals.js', // card-expiry exemption: a charge lane
      'services/completion-balance-sweep.js', // off-session charge sweep
      'services/customer-credit.js', // account-credit auto-apply (D9): a money lane
      'services/termite-annual-renewal-charge.js', // renewal charge / lapse / withdrawal (its pay-link legs read the messaging predicate)
      'services/termite-annual-signature-charge.js', // signature charge
    ]);
  });

  test('the old dispute-only messaging name is gone: one shared predicate, messagingHeldByCollectionHold', () => {
    expect(filesMatching(/dueInvoiceHeldByDisputeHold/)).toEqual([]);
    const consumers = filesMatching(/messagingHeldByCollectionHold/);
    for (const f of [
      'services/billing-channel-email-authority.js', 'services/invoice-email.js', 'services/invoice.js',
      'services/messaging/send-customer-message.js', 'services/messaging/deferred-replay-registry.js',
      'services/messaging/invoice-send-replay-eligibility.js', 'services/collections/rail-guard.js',
      'services/payment-lifecycle-email.js', 'services/automation-runner.js', 'services/recurring-card-on-file.js',
      'services/billing-retry-email-obligation.js',
    ]) expect(consumers).toContain(f);
  });

  test('the sender due queries skip ANY active hold (collectionHoldExistsSql), not the dispute-only subquery', () => {
    expect(read('services/invoice.js')).toMatch(/noActiveCollectionHold[\s\S]{0,300}collectionHoldExistsSql\(this, "invoices\.customer_id"\)/);
    expect(read('services/automation-runner.js')).toMatch(/collectionHoldExistsSql\(this, 'e\.customer_id'\)/);
  });

  test('a trusted exemption is passed as ignoreDisputeHold at every messaging boundary - never a skipped read (a fallback hold still waits)', () => {
    expect(read('services/invoice.js')).toMatch(/\{ ignoreDisputeHold: HOLD_EXEMPT_CALLERS\.has\(holdExempt\) \}/);
    expect(read('services/invoice-email.js')).toMatch(/ignoreDisputeHold: collectionHold\.holdExemptionApplies\(options\.holdExempt\)/);
    expect(read('services/billing-channel-email-authority.js')).toMatch(/ignoreDisputeHold: collectionHold\.holdExemptionApplies\(holdExempt\)/);
    expect(read('services/collections/rail-guard.js')).toMatch(/ignoreDisputeHold: collectionHold\.holdExemptionApplies\(holdExempt\)/);
    expect(read('services/payment-lifecycle-email.js')).toMatch(/ignoreDisputeHold: customerInitiated === true/);
    expect(read('services/messaging/deferred-replay-registry.js')).toMatch(/ignoreDisputeHold: Boolean\(meta && meta\.customer_initiated === true\)/);
    expect(read('services/collections/collection-hold.js')).toMatch(/ignoreDisputeHold: exempt/);
  });

  test('every final provider-boundary hold read reuses the handoff connection (round 13 P1: no root-pool read under a held transaction)', () => {
    expect(read('services/payment-lifecycle-email.js')).toMatch(/holdBoundaryCheck = holdApplies \? async \(\{ database: handoffDb \} = \{\}\) => \{\s*const heldNow = await require\('\.\/collections\/collection-hold'\)\.messagingHeldByCollectionHold\(customer\.id, handoffDb, holdOpts\)/);
    expect(read('services/transactional-email-provider-retry.js')).toMatch(/state\.holdBoundaryCheck = async \(\{ database: handoffDb \} = \{\}\) => \{\s*const heldNow = await collectionHold\.storedLifecycleEmailHeld\(message, handoffDb\)/);
    expect(read('services/email-bounce-recovery.js')).toMatch(/async \(\{ database: handoffDb \} = \{\}\) => \{\s*const heldNow = await require\('\.\/collections\/collection-hold'\)\.storedLifecycleEmailHeld\(bouncedMessage, handoffDb\)/);
    // the dunning authority, the invoice email leg, the automation step and the replay eligibility already read on the locked handle
    expect(read('services/billing-channel-email-authority.js')).toMatch(/messagingHeldByCollectionHold\(input\.customerId, database,/);
    expect(read('services/invoice-email.js')).toMatch(/messagingHeldByCollectionHold\(current\.customer_id, trx,/);
    expect(read('services/automation-runner.js')).toMatch(/messagingHeldByCollectionHold\(enrollment\.customer_id, database\)/);
    expect(read('services/messaging/invoice-send-replay-eligibility.js')).toMatch(/messagingHeldByCollectionHold\(invoice\.customer_id, database\)/);
  });

  test('the scheduler hands a pay-link-only replay over through ONE transaction (no separate hand-over then terminal write)', () => {
    const scheduler = read('services/scheduler.js');
    expect(scheduler).toMatch(/blockPayLinkOnlyReplay\(\{/);
    expect(scheduler).not.toMatch(/handOverHeldInvoiceToSender/);
  });
});
