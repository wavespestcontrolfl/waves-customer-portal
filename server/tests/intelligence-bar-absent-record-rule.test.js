// 10-22: the bar told the owner a real invoice (SHAKEDOWN-0001) "doesn't exist"
// because its number did not look like WPC-2026-NNNN, and called a gated-off
// void "not a capability". The system prompt rule must keep naming invoices,
// the format trap, and how to word a missing action.
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');
const rule = source.split('\n').find((line) => line.startsWith('- Never claim a property, address, message, note, invoice'));

test('the absent-record rule covers invoices, number formats and missing actions', () => {
  expect(rule).toBeDefined();
  expect(rule).toMatch(/invoice, customer or visit is absent unless its sources were checked/);
  expect(rule).toMatch(/its format alone never proves it absent/);
  // Codex #6422 r1: an action off the page list may still be discoverable; search before refusing.
  expect(rule).toMatch(/look for it first \(discover_capabilities or tool search, when you have them\); only when that search does not find it, say the bar cannot do it here/);
  expect(rule).toMatch(/not that the record or the action does not exist/);
});
