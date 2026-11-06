/**
 * Ratchet: each billing rule (and the pg DATE read) lives in one home module.
 *
 * Code outside the home calls the home function instead of writing the rule
 * again. A copy drifts from its home, and Codex then finds the gap one PR at a
 * time: the cash forecast (#7632) re-derived combined-invoice coverage, dues
 * coverage, the monthly-rate fallback, payer-withdrawn invoices and the payer
 * resolver, and 6 of its 11 findings were those copies. CLAUDE.md rule 22.
 *
 * Each rule below is the code signature of a rule written outside its home.
 * fixtures/billing-rule-homes.json is an upper bound per rule and per file: a
 * file may not gain a match, and a new file may not have one. A file that
 * loses matches passes as it is; lower its number when you are in there.
 * Comment lines do not count. Deterministic, filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'billing-rule-homes.json');
const SKIP_DIRS = new Set([
  'node_modules', 'tests', '__tests__', '__mocks__', 'fixtures', 'contract-tests',
  'migrations', 'seeds', 'coverage', 'dist',
]);

const RULES = [
  {
    id: 'combined-invoice-coverage',
    signature: /\bfirst_application_invoice_id\b/g,
    homes: [
      'services/billing-lane.js',
      'services/estimate-converter.js',
      'services/estimate-first-application-invoice.js',
      'services/first-application-sibling-split.js',
    ],
    use: 'Decide whether a combined first-application invoice covers a visit with siblingInvoiceCoverageVerdict (server/services/billing-lane.js). Do not read scheduled_services.first_application_invoice_id yourself.',
  },
  {
    id: 'payer-withdrawn-stamp',
    signature: /(?:['"`]|\/\^)payer_billed:/g,
    homes: [
      'services/invoice-helpers.js',
      'services/open-balance.js',
      'services/visit-completion-packets.js',
      'services/visit-linked-invoice-withdrawal.js',
    ],
    use: 'Leave out invoices withdrawn to a third-party payer with applyOpenSelfPayPredicates (server/services/open-balance.js) in a query, or invoiceWithdrawnFromCustomer (server/services/invoice-helpers.js) for one invoice. Do not match the payer_billed: stamp yourself.',
  },
  {
    id: 'pg-date-string-slice',
    signature: /\bString\([^()]*(?:\([^()]*\))?[^()]*\)\.slice\(\s*0\s*,\s*10\s*\)/g,
    homes: ['utils/date-only.js', 'utils/datetime-et.js'],
    use: "Read a date-only value (a pg DATE column or 'YYYY-MM-DD' text) with dateOnlyString (server/utils/date-only.js). On Railway a DATE column arrives as a UTC-midnight Date, and String(date).slice(0, 10) returns 'Mon Oct 05'.",
  },
];

// Helpers with one definition. A second copy drifts: the three dateOnlyString
// copies already disagree on an invalid Date and on text that is not a date.
const HELPER_HOMES = {
  dateOnlyString: 'utils/date-only.js',
  completionInvoiceAmount: 'services/billing-lane.js',
  membershipDuesCoverVisit: 'services/billing-lane.js',
  siblingInvoiceCoverageVerdict: 'services/billing-lane.js',
  applyOpenSelfPayPredicates: 'services/open-balance.js',
  resolveForInvoice: 'services/payer.js',
  computeChargeAmount: 'services/stripe-pricing.js',
};
const HELPER_DEFINITION = new RegExp(
  `(?:\\bfunction\\s+|\\b(?:const|let|var)\\s+)(${Object.keys(HELPER_HOMES).join('|')})\\b(?!\\s*=\\s*require)`, 'g',
);
RULES.push({
  id: 'home-helper-copy',
  countLine: (rel, line) => [...line.matchAll(HELPER_DEFINITION)].filter((m) => HELPER_HOMES[m[1]] !== rel).length,
  homes: [],
  use: `Import the helper from its home instead of defining a copy: ${Object.entries(HELPER_HOMES).map(([name, home]) => `${name} (server/${home})`).join(', ')}.`,
});

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const codeLines = (source) => source.split('\n').filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line));
const signatureCount = (signature) => (rel, line) => (line.match(signature) || []).length;

const SOURCES = walk(SERVER_ROOT).map((file) => ({
  rel: path.relative(SERVER_ROOT, file).split(path.sep).join('/'),
  lines: codeLines(fs.readFileSync(file, 'utf8')),
}));

function countsFor(rule) {
  const countLine = rule.countLine || signatureCount(rule.signature);
  const counts = {};
  for (const { rel, lines } of SOURCES) {
    if (rule.homes.includes(rel)) continue;
    const n = lines.reduce((sum, line) => sum + countLine(rel, line), 0);
    if (n) counts[rel] = n;
  }
  return counts;
}

describe('billing rules stay in their home module', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  test.each(RULES.map((rule) => [rule.id, rule]))('%s: no file gains a copy', (id, rule) => {
    const was = baseline[id] || {};
    const grew = Object.entries(countsFor(rule))
      .filter(([rel, n]) => n > (was[rel] || 0))
      .map(([rel, n]) => `${id} ${rel}: ${n} (baseline ${was[rel] || 0})`);
    expect(grew.length ? `${rule.use}\n  ${grew.join('\n  ')}` : '').toBe('');
  });

  test('every home file exists, so no message names a moved file', () => {
    const homes = [...RULES.flatMap((rule) => rule.homes), ...Object.values(HELPER_HOMES)];
    expect(homes.filter((home) => !fs.existsSync(path.join(SERVER_ROOT, home)))).toEqual([]);
  });
});
