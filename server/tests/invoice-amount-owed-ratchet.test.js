/**
 * Ratchet: code that reads credit_applied next to an invoice total must also read amount_paid.
 *
 * Partial payments (owner 2026-10-29): what a customer owes on an invoice is
 * total - credit_applied - amount_paid, floored at 0. invoiceAmountDue
 * (server/services/invoice-helpers.js) is the one function for it; SQL and client code that
 * cannot call it carry the same subtraction. A new copy that subtracts credit_applied from a
 * total and forgets amount_paid would charge, remind or report the pre-payment amount.
 *
 * The scan: every non-comment line under server/ and client/src that names credit_applied or
 * creditApplied, with `total` within 4 lines before or 4 after it, and no amount_paid or
 * amountPaid from 4 lines before to 14 after. Such a line is a candidate copy. Each file may
 * hold at most the count in fixtures/credit-applied-not-owed-sites.json, the reviewed sites
 * that mean something other than an owed amount (a version pin, cash received, a credit line
 * on a receipt, a payment writer), each with its reason. The count is an upper bound, like
 * admin-alert-raw-callsite-ratchet: removing a site never needs a baseline edit.
 * Deterministic, filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ROOTS = ['server', 'client/src'];
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist', 'fixtures']);
const SOURCE_FILE = /\.(js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\./;
const ALLOWLIST_PATH = path.join(__dirname, 'fixtures', 'credit-applied-not-owed-sites.json');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Line numbers (1-based) of candidate owed-amount copies in one file's source.
function candidateLines(source) {
  const lines = source.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
    if (!/\bcredit_applied\b|\bcreditApplied\b/.test(line)) return;
    if (/amount_paid|amountPaid/.test(lines.slice(Math.max(0, i - 4), i + 15).join('\n'))) return;
    if (!/\btotal\b/i.test(lines.slice(Math.max(0, i - 4), i + 5).join('\n'))) return;
    found.push(i + 1);
  });
  return found;
}

describe('invoice amount owed subtracts amount_paid everywhere credit_applied is netted off a total', () => {
  test('the scan flags a copy without amount_paid and passes one with it', () => {
    const bare = "db.raw('SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) as owed')";
    const paid = "db.raw('SUM(GREATEST(total - COALESCE(credit_applied, 0) - COALESCE(amount_paid, 0), 0)) as owed')";
    expect(candidateLines(bare)).toEqual([1]);
    expect(candidateLines(paid)).toEqual([]);
    expect(candidateLines("// total - credit_applied is in a comment\nconst x = 1;")).toEqual([]);
    expect(candidateLines("const select = ['total', 'credit_applied'];")).toEqual([1]);
    expect(candidateLines("const select = ['total', 'credit_applied', 'amount_paid'];")).toEqual([]);
    expect(candidateLines('const creditApplied = Number(row.creditApplied) || 0;')).toEqual([]);
  });

  test('the owed-amount readers this change fixed carry amount_paid', () => {
    for (const rel of [
      'server/services/invoice-helpers.js',
      'server/services/open-balance.js',
      'server/routes/billing-v2.js',
      'server/routes/admin-customers.js',
      'server/services/intelligence-bar/dashboard-tools.js',
      'server/services/intelligence-bar/tax-tools.js',
    ]) {
      expect(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).toMatch(/amount_paid/);
    }
  });

  test('no file gains an unreviewed copy of the owed-amount arithmetic', () => {
    const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
    const counts = {};
    for (const root of ROOTS) {
      for (const file of walk(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        const n = candidateLines(fs.readFileSync(file, 'utf8')).length;
        if (n) counts[rel] = n;
      }
    }
    const grew = Object.keys(counts)
      .filter((rel) => counts[rel] > (allowlist[rel]?.max || 0))
      .map((rel) => `${rel}: ${counts[rel]} line(s) read credit_applied beside a total with no amount_paid, reviewed ${allowlist[rel]?.max || 0}`);
    expect(grew.length
      ? `Subtract amount_paid wherever you subtract credit_applied from an invoice total (invoiceAmountDue in server/services/invoice-helpers.js, or the same arithmetic in SQL). If the new line is not an owed amount, add its file to server/tests/fixtures/credit-applied-not-owed-sites.json with the reason:\n  ${grew.join('\n  ')}`
      : '').toBe('');
  });

  test('every allowlisted file exists and states a reason', () => {
    const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
    for (const [rel, entry] of Object.entries(allowlist)) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(Number.isInteger(entry.max) && entry.max > 0).toBe(true);
    }
  });
});
