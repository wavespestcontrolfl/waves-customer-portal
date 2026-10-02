// Every staff reply surface goes through the interlocked manual-send wrapper
// (send-manual-customer-sms.js), so a staff reply can never cross an automatic
// reply on the same thread (Codex #5609 r2 P1: the dashboard inbox bypassed it).
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// [route file, entryPoint of its staff-typed reply]
const SURFACES = [
  ['routes/admin-dashboard-ops.js', 'admin_dashboard_ops_inbox_reply'],
  ['routes/ai-assistant.js', 'ai_assistant_admin_reply'],
  ['routes/admin-leads.js', 'admin_leads_send_sms'],
  ['routes/admin-drafts.js', 'admin_draft_approve'],
  ['routes/admin-drafts.js', 'admin_draft_revise'],
];

describe('staff reply surfaces use the interlocked wrapper', () => {
  test.each(SURFACES)('%s (%s)', (file, entryPoint) => {
    const src = read(file);
    const at = src.indexOf(`entryPoint: '${entryPoint}'`);
    expect(at).toBeGreaterThan(-1);
    // the nearest send call before the entryPoint is the wrapper
    const before = src.slice(0, at);
    const wrapper = before.lastIndexOf('sendManualCustomerSms(');
    const direct = before.lastIndexOf('sendCustomerMessage(');
    expect(wrapper).toBeGreaterThan(direct);
  });
});
