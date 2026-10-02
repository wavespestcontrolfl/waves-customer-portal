// Every staff-triggered SMS goes through the interlocked manual-send wrapper
// (send-manual-customer-sms.js), so it never crosses an automatic reply on the
// same thread (Codex #5609 r2/r4). Discovered, not listed: any direct
// sendCustomerMessage( in an operator route fails this test unless the route
// owns the same reservation lifecycle itself.
const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '..', 'routes');
// Routes that run reserveHumanReply / the composer reservation themselves.
const OWN_LIFECYCLE = new Set(['admin-communications.js', 'tech-line.js']);
const OPERATOR_ROUTES = fs.readdirSync(routesDir)
  .filter((f) => /^admin-.*\.js$/.test(f) || f === 'ai-assistant.js' || f === 'tech-line.js');

// Notifications and nudges, not replies: a receipt, a delivered document or a
// follow-up nudge landing next
// to an automatic answer is not a double answer, several of these callers
// cannot surface a refusal (a charge receipt is logged and dropped), and while
// the lane can claim they already publish a provider-handoff reservation on
// the thread (provider-handoff-reservation.js), which the claim respects.
const NOTIFICATION_SENDS = new Set([
  'admin-billing-health.js:purpose=payment_receipt', // charge-now receipt: no entryPoint, keyed by purpose
  'admin-customer-intel.js:admin_customer_intel_retention_approve',
  'admin-estimates.js:admin_estimate_send',
  // outbound nudges: the wrapper would park the customer's open question as
  // answered by staff and log a false 'ignored' outcome (pre-push audit, r6)
  'admin-estimates.js:admin_estimate_follow_up',
  'admin-estimates.js:admin_estimate_send_booking_link',
  'admin-pricing-strategy.js:admin_pricing_strategy_upsell',
  'admin-projects.js:admin_project_report_send',
  'admin-projects.js:project_report_hold_release',
  'admin-projects.js:admin_project_report_with_invoice',
  'admin-service-outlines.js:admin_lawn_service_outline_send',
]);

function directSends(file, src) {
  return [...src.matchAll(/\bsendCustomerMessage\(/g)].map((m) => {
    const call = src.slice(m.index, m.index + 1200);
    const ep = call.match(/entryPoint: '([a-z_]+)'/);
    const purpose = call.match(/purpose: '([a-z_]+)'/);
    return `${file}:${ep ? ep[1] : `purpose=${purpose ? purpose[1] : 'unknown'}`}`;
  });
}

describe('staff SMS surfaces use the interlocked wrapper', () => {
  test('operator routes were found', () => {
    expect(OPERATOR_ROUTES.length).toBeGreaterThan(20);
  });

  test.each(OPERATOR_ROUTES.filter((f) => !OWN_LIFECYCLE.has(f)))('%s: every direct send is a listed notification', (file) => {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const unlisted = directSends(file, src).filter((key) => !NOTIFICATION_SENDS.has(key));
    expect(unlisted).toEqual([]);
  });

  test.each([
    ['admin-dashboard-ops.js', 'admin_dashboard_ops_inbox_reply'],
    ['ai-assistant.js', 'ai_assistant_admin_reply'],
    ['admin-leads.js', 'admin_leads_send_sms'],
    ['admin-drafts.js', 'admin_draft_approve'],
  ])('%s %s sends through sendManualCustomerSms', (file, entryPoint) => {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const at = src.indexOf(`entryPoint: '${entryPoint}'`);
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(0, at).lastIndexOf('sendManualCustomerSms(')).toBeGreaterThan(-1);
  });
});
