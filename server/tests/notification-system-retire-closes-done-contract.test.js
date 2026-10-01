// Read is not done (docs/admin-notifications.md section 4): the bell list and the
// needs-me reader show admin rows with done_at IS NULL, so a SYSTEM writer that
// retires an alert (the condition cleared, a newer bell replaced it, a batch
// absorbed it) by setting read_at alone leaves it looking like open work forever.
// Every write that sets read_at to a real value in server code must either close
// the row as done on the same object (spread NotificationService._private
// .doneColumns, which COALESCEs read_at so a person's earlier read stands) or be
// a PERSON's own read / a different table, named below with its reason.
//
// The mirror of notification-rearm-clears-done-contract.test.js, which holds the
// other direction (a re-arm that clears read_at must clear done too).
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const ROOTS = ['services', 'routes', 'jobs'].map((d) => path.join(SERVER, d));

// file -> [{ includes, reason }]. `includes` must appear in the write's context:
// the text from its enclosing function's header to the end of the write. A
// stable name or comment, never a line number. Each entry must still match a
// write (the last test), so a deleted or rewritten writer cannot leave a stale
// exemption behind.
const PERSON_OR_OTHER_TABLE = {
  'routes/admin-notifications.js': [
    { includes: "'dashboard_alert'", reason: 'a person dismissing a live dashboard alert marks its bell read; dismissing is their acknowledgment, not the alert resolving' },
  ],
  'routes/twilio-webhook.js': [
    { includes: 'is_read: true', reason: 'writes the messages table (an inbound text marked read), not notifications' },
  ],
  'services/conversations.js': [
    { includes: 'isRead', reason: 'writes the messages table read_at, not notifications' },
  ],
  'services/inbound-sms-read.js': [
    { includes: 'read_by_admin_user_id', reason: 'writes the messages table (a person opened the thread), not notifications' },
    { includes: 'retargetOrClearUnknownSenderBell', reason: 'a person opened the thread in Communications; the unknown-sender bell is read, not done' },
  ],
  'services/notification-service.js': [
    { includes: 'async markRead(', reason: 'a customer (or a person) marking one notification read' },
    { includes: 'async markReadAdmin(', reason: 'a person marking one admin bell read' },
    { includes: 'async markAllReadAdmin(', reason: 'a person marking every admin bell read' },
    { includes: 'async markInboundSmsReadAdmin(', reason: 'a person opening a customer thread reads its inbound_sms bells' },
    { includes: 'async markApplicantRepliesReadAdmin(', reason: 'a person opening an application reads its applicant-reply bells' },
    { includes: 'async markAllReadCustomer(', reason: 'a customer marking their own notifications read' },
  ],
  'services/sms-operational-actions.js': [
    { includes: 'Any other staff update', reason: 'a staff edit or snooze leaves the promise open, so its bell is only read (dismiss and fulfill close it done)' },
  ],
};

function* jsFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

// The object literal a `read_at:` sits in: from its enclosing `{` to the
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

const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);

// From the nearest named function/method header above the write to the end of
// the write: what an allowlist entry's `includes` is matched against.
function writeContext(text, at) {
  const header = /(?:^|\n)[ \t]*(?:async[ \t]+)?(?:function[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^\n]*\)[ \t]*\{[ \t]*(?=\n)/g;
  let start = 0;
  for (let m = header.exec(text); m && m.index < at; m = header.exec(text)) {
    if (!NOT_FUNCTIONS.has(m[1])) start = m.index;
  }
  const end = text.indexOf('\n', at);
  return text.slice(start, end < 0 ? text.length : end);
}

const DONE = /\bdone_at\b|\bdoneColumns\b|\bDONE_CLEARED\b/;

// Writes that give read_at a real value: `read_at: <value>` with no null in it
// (a null or a CASE ... NULL is an un-read, the re-arm contract's business) and
// a `.read_at = <value>` assignment.
function scan(text, rel, allow = {}) {
  const offenders = [];
  const used = new Set();
  const patterns = [/\bread_at:([^,\n}]*)/g, /\.read_at\s*=(?!=)([^;\n]*)/g];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (/\bnull\b/i.test(m[1])) continue;
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*)/.test(text.slice(lineStart, m.index + 2))) continue; // a comment
      const object = re === patterns[0] ? enclosingObject(text, m.index) : writeContext(text, m.index);
      if (DONE.test(object)) continue;
      const context = writeContext(text, m.index);
      const entry = (allow[rel] || []).find((e) => context.includes(e.includes));
      if (entry) { used.add(`${rel}::${entry.includes}`); continue; }
      offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  return { offenders, used };
}

test('every non-null read_at write also closes the row done, or is a named person / other-table write', () => {
  const offenders = [];
  const used = new Set();
  for (const root of ROOTS) {
    for (const file of jsFiles(root)) {
      const rel = path.relative(SERVER, file);
      const result = scan(fs.readFileSync(file, 'utf8'), rel, PERSON_OR_OTHER_TABLE);
      offenders.push(...result.offenders);
      result.used.forEach((u) => used.add(u));
    }
  }
  expect(offenders).toEqual([]);
  // No exemption outlives its writer.
  const stale = [];
  for (const [rel, entries] of Object.entries(PERSON_OR_OTHER_TABLE)) {
    for (const e of entries) if (!used.has(`${rel}::${e.includes}`)) stale.push(`${rel}::${e.includes}`);
  }
  expect(stale).toEqual([]);
  for (const entries of Object.values(PERSON_OR_OTHER_TABLE)) {
    for (const e of entries) expect(e.reason.length).toBeGreaterThan(10);
  }
});

test('the scan fails a bare system retire and passes a done close, an un-read, or a named person write', () => {
  const bad = "async function retire(trx) {\n  await trx('notifications').whereNull('done_at').update({ read_at: new Date() });\n}\n";
  expect(scan(bad, 'services/x.js').offenders).toEqual(['services/x.js:2']);
  // The same on several lines, with an unrelated key beside it.
  const badMulti = "async function retire(trx) {\n  await trx('notifications').update({\n    title: 't',\n    read_at: trx.fn.now(),\n    body: 'b',\n  });\n}\n";
  expect(scan(badMulti, 'services/x.js').offenders).toEqual(['services/x.js:4']);
  // An assignment is judged too.
  expect(scan("function f(patch) {\n  patch.read_at = new Date();\n}\n", 'services/x.js').offenders).toEqual(['services/x.js:2']);

  const done = "async function retire(trx) {\n  await trx('notifications').update({\n    ...NotificationService._private.doneColumns({ by: 'x', resolution: 'y', keepExisting: true, conn: trx }),\n    read_at: trx.fn.now(),\n  });\n}\n";
  expect(scan(done, 'services/x.js').offenders).toEqual([]);
  const explicitDone = "async function retire(trx) {\n  await trx('notifications').update({ read_at: now, done_at: now, done_by: 'x' });\n}\n";
  expect(scan(explicitDone, 'services/x.js').offenders).toEqual([]);
  // An un-read is the re-arm contract's business.
  expect(scan("async function f() {\n  await q.update({ read_at: null });\n}\n", 'services/x.js').offenders).toEqual([]);

  const person = "  async markReadAdmin(id) {\n    return q.update({ read_at: new Date() });\n  },\n";
  const allow = { 'services/x.js': [{ includes: 'async markReadAdmin(', reason: 'a person marks one bell read' }] };
  expect(scan(person, 'services/x.js', allow).offenders).toEqual([]);
  expect(scan(person, 'services/x.js', allow).used).toEqual(new Set(['services/x.js::async markReadAdmin(']));
  // The exemption is per file and per writer.
  expect(scan(person, 'services/y.js', allow).offenders).toEqual(['services/y.js:2']);
  expect(scan(person.replace('markReadAdmin', 'sweepRetire'), 'services/x.js', allow).offenders).toEqual(['services/x.js:2']);
});
