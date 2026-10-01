// Read is not done (docs/admin-notifications.md §4): the bell and the unread count leave
// done rows out, so a writer that re-arms an admin alert by clearing read_at alone leaves
// a row someone marked Done hidden for good (setup-fee reconcile restoring a voided
// invoice's alert, a ringing digest rewrite). Every `read_at: null` write in server code
// must clear the done fields on the same line too.
const fs = require('fs');
const path = require('path');

const ROOTS = ['services', 'routes', 'jobs'].map((d) => path.join(__dirname, '..', d));
const EXEMPT = new Set([
  'services/dashboard-alerts.js', // a synthetic in-memory overlay row, never written to notifications
  'services/conversations.js', // writes the messages table's own read_at, not notifications
]);

function* jsFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

// The object literal a `read_at: null` sits in: from its enclosing `{` to the
// matching `}`, so a write spread over several lines is judged as one object.
function enclosingObject(text, at) {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i -= 1) {
    if (text[i] === '}') depth += 1;
    else if (text[i] === '{') {
      if (depth === 0) { open = i; break; }
      depth -= 1;
    }
  }
  if (open < 0) return text.slice(Math.max(0, at - 200), at + 200);
  depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

test('every read_at: null write also clears done_at / done_by / resolution, on one line or many', () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const file of jsFiles(root)) {
      const rel = path.relative(path.join(__dirname, '..'), file);
      if (EXEMPT.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      // Any read_at value that can be null: a literal, a ternary arm, or a
      // CASE … NULL expression.
      for (const m of text.matchAll(/read_at:([^,\n}]*)/g)) {
        if (!/\bnull\b/i.test(m[1])) continue;
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        if (/^\s*\/\//.test(text.slice(lineStart, m.index))) continue; // a comment
        const object = enclosingObject(text, m.index);
        if (!/done_at:\s*null/.test(object) && !/DONE_CLEARED/.test(object)) {
          offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test('the scan judges a multi-line update object as a whole', () => {
  const bad = "x.update({\n  title: 't',\n  read_at: null,\n  body: 'b',\n})";
  const good = "x.update({\n  read_at: null,\n  done_at: null, done_by: null, resolution: null,\n})";
  expect(/done_at:\s*null/.test(enclosingObject(bad, bad.indexOf('read_at')))).toBe(false);
  expect(/done_at:\s*null/.test(enclosingObject(good, good.indexOf('read_at')))).toBe(true);
  // A ternary arm that can un-read is a re-arm too.
  expect(/read_at:([^,\n}]*)/.exec("x.update({ read_at: ok ? prior : null,")[1]).toMatch(/\bnull\b/);
});
