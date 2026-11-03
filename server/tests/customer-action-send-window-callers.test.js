/**
 * Owner rulings 2026-08-29 and 2026-11-02: a text that answers the customer's
 * own action goes out at any hour, not at 8 AM. Three senders take that
 * provenance from their caller:
 *   - InvoiceService.sendViaSMS / sendViaSMSAndEmail  `customerInitiated`
 *   - AppointmentReminders.registerAppointment         `customerInitiated`
 *   - sendNewRecurringWelcome                          `customerActionAt`
 * An automated caller passing one would text customers at night, the
 * incident the 8 AM-8 PM window exists to stop (2026-08-07). So each marker
 * is passed only by the customer-action callers listed here; a new caller
 * fails this test and gets classified on purpose.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function sourceFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });
}

// The argument text of every real call of `callee` in `file` (comment
// mentions and the function's own definition skipped), up to its closing
// parenthesis.
function callArguments(file, callee) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const out = [];
  const re = new RegExp(`${callee}\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lead = src.slice(lineStart, m.index);
    if (/^\s*(\/\/|\*)/.test(lead) || /function\s+$/.test(lead)) continue;
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end += 1) {
      if (src[end] === '(') depth += 1;
      else if (src[end] === ')' && --depth === 0) break;
    }
    out.push(src.slice(m.index, end + 1));
  }
  return out;
}

function callersPassing(callee, marker) {
  return [...sourceFiles('services'), ...sourceFiles('routes')]
    .filter((file) => callArguments(file, callee).some((args) => marker.test(args)))
    .sort();
}

describe('customer-action send-window markers come only from customer-action callers', () => {
  test('invoice pay-link text: only the estimate accept passes customerInitiated', () => {
    // invoice.js forwards the caller's own value through its retries; it never sets one.
    const callers = callersPassing('\\.sendViaSMS(?:AndEmail)?', /customerInitiated: true/);
    expect(callers).toEqual(['routes/estimate-public.js']);
  });

  test('appointment confirmation: only the self-booking passes customerInitiated to registerAppointment', () => {
    expect(callersPassing('\\.registerAppointment', /customerInitiated/)).toEqual(['routes/booking.js']);
  });

  test('new-recurring welcome: only the public estimate accept stamps customerActionAt', () => {
    // The manual "Mark accepted" (estimate-accept-effects.js) and every
    // booking path queue the welcome WITHOUT it, so their texts keep the window.
    expect(callersPassing('sendNewRecurringWelcome', /customerActionAt/)).toEqual(['routes/estimate-public.js']);
  });
});
