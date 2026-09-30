/**
 * Sweep guard (owner ruling 2026-09-30, PR #5424 round 8): while a customer has an ACTIVE
 * collections dispute hold no AUTOMATED billing follow-up carrying a pay or update-card link
 * reaches them. The customer-message boundary (send-customer-message.js step 1.5) gates the
 * purposes below, so every sender that uses one must be classified here on purpose. A new
 * sender fails this test until it is classified, instead of slipping past the hold.
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

  test('the boundary gates exactly the machine-initiated payment_failure and autopay purposes', () => {
    const src = read('services/messaging/send-customer-message.js');
    expect(src).toMatch(/HOLD_GATED_MESSAGE_PURPOSES = Object\.freeze\(\['payment_failure', 'autopay'\]\)/);
    expect(src).toMatch(/HOLD_GATED_MESSAGE_PURPOSES\.includes\(input\.purpose\) && input\.customerId\s*&& input\.customerInitiated !== true/);
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
    expect([...Hold.HOLD_GATED_EMAIL_TEMPLATES].sort()).toEqual(['payment.failed', 'payment.method_expiring', 'payment.retry_notice']);
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
    expect(src).toMatch(/disputeHoldExistsSql\(this, 'e\.customer_id'\)/);
  });
});
