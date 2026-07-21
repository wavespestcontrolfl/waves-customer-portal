/**
 * Every customer-creation site must wire the account layer.
 *
 * Portal login's refresh session (customer_refresh_tokens.account_id) is a
 * NOT NULL FK onto customer_accounts, so a customers row inserted without an
 * account is login-broken until the lazy adoption in middleware/auth.js
 * repairs it at first login (and until then it is invisible to account-level
 * grouping: select-property, admin Customer 360 siblings, phone de-dup).
 * Creation paths must attach-or-create the account up front
 * (ensureCustomerAccount, or an explicit customer_accounts insert like the
 * Intelligence Bar's create_customer) and stamp account_id on the new row.
 *
 * This source scan fails when a NEW insert site skips that — the exact gap
 * that shipped seven login-broken creation paths between 2026-05-04 and
 * 2026-07-21 (public estimate accept, self-book, public quote, lead/twilio
 * webhooks, call pipeline, add-service requests).
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['routes', 'services'].map((dir) => path.join(SERVER_ROOT, dir));

// Chars of the insert call inspected for account_id. Compliant sites stamp
// account_id in the first few payload lines, so this stays tight enough not
// to be satisfied by unrelated account_id mentions further down the file.
const PAYLOAD_WINDOW = 400;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

test('every customers-table insert in routes/services carries account_id', () => {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    for (const file of jsFiles(root)) {
      const src = fs.readFileSync(file, 'utf8');
      const insertRe = /\(['"]customers['"]\)\s*\.insert\(/g;
      let match;
      while ((match = insertRe.exec(src)) !== null) {
        const payload = src.slice(match.index, match.index + PAYLOAD_WINDOW);
        if (!payload.includes('account_id')) {
          const line = src.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(SERVER_ROOT, file)}:${line}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});
