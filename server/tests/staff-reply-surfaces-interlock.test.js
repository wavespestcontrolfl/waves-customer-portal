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

describe('staff SMS surfaces use the interlocked wrapper', () => {
  test('operator routes were found', () => {
    expect(OPERATOR_ROUTES.length).toBeGreaterThan(20);
  });

  test.each(OPERATOR_ROUTES.filter((f) => !OWN_LIFECYCLE.has(f)))('%s sends no SMS around the wrapper', (file) => {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    expect(src.match(/\bsendCustomerMessage\(/g) || []).toEqual([]);
  });

  test.each([
    ['admin-dashboard-ops.js', 'admin_dashboard_ops_inbox_reply'],
    ['ai-assistant.js', 'ai_assistant_admin_reply'],
    ['admin-leads.js', 'admin_leads_send_sms'],
    ['admin-drafts.js', 'admin_draft_approve'],
    ['admin-estimates.js', 'admin_estimate_follow_up'],
    ['admin-estimates.js', 'admin_estimate_send_booking_link'],
  ])('%s %s sends through sendManualCustomerSms', (file, entryPoint) => {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    const at = src.indexOf(`entryPoint: '${entryPoint}'`);
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(0, at).lastIndexOf('sendManualCustomerSms(')).toBeGreaterThan(-1);
  });
});
