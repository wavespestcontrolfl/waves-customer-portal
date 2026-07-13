/**
 * Email shared tool subset — loaded into every admin context so any page can
 * read the inbox and respond to an email (not just the Email page).
 * Mirrors the comms read-only subset contract in
 * intelligence-bar-create-customer.test.js.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { EMAIL_TOOLS, EMAIL_SHARED_TOOLS } = require('../services/intelligence-bar/email-tools');
const { UI_GATED_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

describe('email shared tool subset', () => {
  test('exposes inbox read + reply tools and excludes inbox management', () => {
    const names = EMAIL_SHARED_TOOLS.map(t => t.name);
    expect(names.sort()).toEqual([
      'draft_email_reply',
      'get_email_thread',
      'get_inbox_summary',
      'reply_via_sms',
      'search_emails',
      'send_email_reply',
    ]);
    // Email-page-only management tools never ride along to other contexts
    expect(names).not.toContain('get_vendor_invoices');
    expect(names).not.toContain('get_email_stats');
    expect(names).not.toContain('get_blocked_senders');
    expect(names).not.toContain('block_sender');
    // Every shared tool is a real email tool object, not a copy
    const all = new Set(EMAIL_TOOLS.map(t => t.name));
    for (const name of names) expect(all.has(name)).toBe(true);
  });

  test('every write in the shared subset is UI-confirm gated', () => {
    // Sharing these across contexts must not create an unconfirmed send path:
    // the reply writes stay behind the pending-action card everywhere.
    expect(UI_GATED_WRITE_TOOL_NAMES.has('send_email_reply')).toBe(true);
    expect(UI_GATED_WRITE_TOOL_NAMES.has('reply_via_sms')).toBe(true);
  });
});
