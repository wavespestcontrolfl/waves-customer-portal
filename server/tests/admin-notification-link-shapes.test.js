/**
 * The admin app has no /admin/customers/:id, /admin/invoices/:id or bare
 * /admin/estimates/:id page (the client redirects them now, but only as a
 * safety net for stored rows). New links must use the query form each page
 * reads: /admin/customers?customerId=, /admin/invoices?invoice=,
 * /admin/estimates?estimateId=. Customer links must not use /billing (the
 * portal Billing tab is /?tab=billing).
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const SKIP = new Set(['tests', '__tests__', 'node_modules', 'migrations']);

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const DEAD_SHAPES = [
  /\/admin\/customers\/\$\{[^}]+\}(?=[`)'"])/,
  /\/admin\/invoices\/\$\{[^}]+\}(?=[`)'"])/,
  /\/admin\/estimates\/\$\{[^}]+\}(?=[`)'"])/,
  /(?:publicPortalUrl\(\)|\$\{domain\})\/billing`/,
];

test('no server file builds an admin detail link or portal link the app cannot route', () => {
  const offenders = [];
  for (const file of sources(SERVER)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (DEAD_SHAPES.some((re) => re.test(line))) offenders.push(`${path.relative(SERVER, file)}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});
