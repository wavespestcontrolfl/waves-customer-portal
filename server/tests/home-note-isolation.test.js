// "About this home" is staff-only free text. services/home-note.js is the ONLY file that reads or writes the table, so
// no customer portal payload, service report, public token page, email or text can carry it, and no model call sees it.
// A new reader of home_notes must be added here on purpose, with the reason it stays staff-only.
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const ALLOWED = new Set([
  'services/home-note.js', // the one reader and writer
  'services/customer-dedupe.js', // a customer merge repoints the table's customer_id (never reads a body)
]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'models'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('only the home-note service (and the customer merge) mention the home_notes table', () => {
  const readers = sourceFiles(SERVER)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('home_notes'))
    .map((file) => path.relative(SERVER, file));
  expect(readers.filter((file) => !ALLOWED.has(file))).toEqual([]);
});

test('only the staff routes load the home-note service; no customer, report, public or model file does', () => {
  const loaders = sourceFiles(SERVER)
    .filter((file) => /services\/home-note|\.\/home-note/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SERVER, file))
    .sort();
  expect(loaders).toEqual(['routes/admin-customers.js', 'routes/admin-schedule.js']);
});

test('the service never logs or audits the note body', () => {
  const src = fs.readFileSync(path.join(SERVER, 'services/home-note.js'), 'utf8');
  expect(src).not.toMatch(/logger\./);
  const audit = src.slice(src.indexOf('recordAuditEvent({'), src.indexOf('return { status: 200, note: text'));
  expect(audit).not.toMatch(/body/);
});
