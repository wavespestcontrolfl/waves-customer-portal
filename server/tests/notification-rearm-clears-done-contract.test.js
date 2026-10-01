// Read is not done (docs/admin-notifications.md §4): the bell and the unread count leave
// done rows out, so a writer that re-arms an admin alert by clearing read_at alone leaves
// a row someone marked Done hidden for good (setup-fee reconcile restoring a voided
// invoice's alert, a ringing digest rewrite). Every `read_at: null` write in server code
// must clear the done fields on the same line too.
const fs = require('fs');
const path = require('path');

const ROOTS = ['services', 'routes', 'jobs'].map((d) => path.join(__dirname, '..', d));
// A synthetic in-memory overlay row, never written to notifications.
const EXEMPT = new Set(['services/dashboard-alerts.js']);

function* jsFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

test('every read_at: null write also clears done_at / done_by / resolution', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of jsFiles(root)) {
      const rel = path.relative(path.join(__dirname, '..'), file);
      if (EXEMPT.has(rel)) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*\/\//.test(line) || !/read_at: null\b/.test(line)) return;
        if (!/done_at: null/.test(line) && !/DONE_CLEARED/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
  }
  expect(offenders).toEqual([]);
});
