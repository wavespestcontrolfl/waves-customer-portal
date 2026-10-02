// The read-only one-customer reminder timeline script (server/scripts/dunning-customer-timeline.js): its pure
// pieces and its refusals, with no database. The same script is read back against real tables by
// customer-dunning-timeline-postgres.test.js.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Timeline = require('../scripts/dunning-customer-timeline');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'dunning-customer-timeline.js');
const CUSTOMER = '11111111-2222-4333-8444-555555555555';
const INVOICE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const INVOICE_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ADMIN = 'cccccccc-0000-4000-8000-000000000003';
const at = (iso) => new Date(iso);

let nextId = 0;
// A collections_contact_ledger row. `meta` rides the metadata column; every field the real column set carries is present.
function ledger({ when, channel = 'email', source = 'invoice_followups_customer', purpose = 'late_payment', meta = {}, invoices = [INVOICE_A, INVOICE_B] }) {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    customer_id: CUSTOMER,
    source,
    purpose,
    channel,
    occurred_at: at(when),
    invoice_ids: JSON.stringify(invoices),
    metadata: JSON.stringify(meta),
  };
}
const delivered = (key, extra = {}) => ({ notificationEventKey: key, delivered: true, ...extra });

describe('parseArgs', () => {
  test('a customer id and an optional day count', () => {
    expect(Timeline.parseArgs(['--customer', CUSTOMER])).toEqual({ ok: true, customer: CUSTOMER, days: 120 });
    expect(Timeline.parseArgs(['--customer', CUSTOMER.toUpperCase(), '--days', '30'])).toEqual({ ok: true, customer: CUSTOMER, days: 30 });
  });

  test.each([
    [[]],
    [['--customer']],
    [['--customer', 'not-a-uuid']],
    [['--customer', '12345']],
    [['--customer', CUSTOMER, '--days', '0']],
    [['--customer', CUSTOMER, '--days', '-3']],
    [['--customer', CUSTOMER, '--days', 'many']],
    [['--customer', CUSTOMER, '--days', '99999']],
    [['--customer', CUSTOMER, '--execute']],
    [['--customer', CUSTOMER, '--include-names']],
  ])('refuses %j', (argv) => {
    const out = Timeline.parseArgs(argv);
    expect(out.ok).toBe(false);
    expect(out.message).toEqual(expect.any(String));
  });
});

describe('the command line', () => {
  // The refusals happen before the script touches the database module, so no database is needed.
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000,
  });

  test('a missing --customer exits non-zero and says what is wrong', () => {
    const out = run([]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/--customer <uuid> is required/);
    expect(out.stdout).toBe('');
  });

  test('a customer that is not a uuid exits non-zero', () => {
    const out = run(['--customer', 'Test Customer']);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/must be a customer id/);
  });

  test('a bad --days exits non-zero', () => {
    const out = run(['--customer', CUSTOMER, '--days', 'forever']);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/--days needs a whole number/);
  });

  test('valid arguments with no database url abort without connecting anywhere (fail closed)', () => {
    const out = run(['--customer', CUSTOMER]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/DATABASE_PUBLIC_URL \(or DATABASE_URL\) not set/);
    const blank = run(['--customer', CUSTOMER], { DATABASE_URL: 'undefined', DATABASE_PUBLIC_URL: 'null' });
    expect(blank.status).toBe(1);
    expect(blank.stderr).toMatch(/not set/);
  });
});

describe('annotateAttempts: the gap since the previous reminder the spacing rule counts', () => {
  test('a gap under 7 days is flagged; exactly 7 days and longer are not; a failed attempt does not reset the clock', () => {
    const rows = [
      ledger({ when: '2026-07-08T14:16:00Z', meta: delivered('k1') }),
      ledger({ when: '2026-07-14T14:16:00Z', meta: delivered('k2') }), // 6.0 d after k1
      ledger({ when: '2026-07-16T14:16:00Z', meta: { notificationEventKey: 'k-failed', send_failed: true } }), // never reached them
      ledger({ when: '2026-07-21T14:16:00Z', meta: delivered('k3') }), // exactly 7.0 d after k2
      ledger({ when: '2026-09-02T14:16:00Z', meta: delivered('k4') }), // 43 d
    ];
    const out = Timeline.annotateAttempts(rows);
    expect(out.map((a) => a.gapDays)).toEqual([null, 6, null, 7, 43]);
    expect(out.map((a) => a.underSpacing)).toEqual([false, true, false, false, false]);
    expect(out.map((a) => a.state)).toEqual(['delivered', 'delivered', 'failed', 'delivered', 'delivered']);
  });

  // Pre-push audit P1: touch A's first leg fails, touch B delivers, then A's other leg delivers. Gaps follow
  // delivery order: B is the first delivered, A is measured from B (never a negative gap on B).
  test('gaps follow delivery order when a failed touch delivers after a newer one', () => {
    const rows = [
      ledger({ when: '2026-07-01T14:16:00Z', channel: 'email', meta: { notificationEventKey: 'kA', send_failed: true } }),
      ledger({ when: '2026-07-05T14:16:00Z', channel: 'email', meta: delivered('kB') }),
      ledger({ when: '2026-07-10T14:16:00Z', channel: 'sms', meta: delivered('kA') }),
    ];
    const out = Timeline.annotateAttempts(rows);
    // output stays in attempt-time order
    expect(out.map((a) => a.state)).toEqual(['failed', 'delivered', 'delivered']);
    expect(out.map((a) => a.gapDays)).toEqual([null, null, 5]);
    expect(out.map((a) => a.underSpacing)).toEqual([false, false, true]);
    expect(out.every((a) => a.gapDays == null || a.gapDays >= 0)).toBe(true);
  });

  test('the legs of one touch are one touch: the gap is on the latest leg, as the spacing rule times it, and the other leg says same touch', () => {
    const rows = [
      ledger({ when: '2026-07-08T14:16:01Z', channel: 'sms', meta: delivered('k1') }),
      ledger({ when: '2026-07-08T14:16:00Z', channel: 'email', meta: delivered('k1') }),
      ledger({ when: '2026-07-14T14:16:02Z', channel: 'email', meta: delivered('k2') }),
      ledger({ when: '2026-07-14T14:16:03Z', channel: 'sms', meta: delivered('k2') }),
    ];
    const out = Timeline.annotateAttempts(rows);
    expect(out.map((a) => a.row.channel)).toEqual(['email', 'sms', 'email', 'sms']);
    expect(out.map((a) => a.touch)).toEqual([1, 1, 2, 2]);
    expect(out.map((a) => a.sameTouch)).toEqual([true, false, true, false]);
    expect(out[0].gapDays).toBeNull(); // a leg never shows a 0-day gap to its own sibling
    expect(out[1].gapDays).toBeNull();
    expect(out[3].gapDays).toBeCloseTo(6 + 2 / 86400, 5);
    expect(out[3].underSpacing).toBe(true);
    expect(out[2].underSpacing).toBe(false);
  });

  test('keyless rows (an older rail) group by source and invoice set inside 15 minutes', () => {
    const rows = [
      ledger({ when: '2026-07-01T14:00:00Z', source: 'invoice_followups', purpose: 'invoice_followup', channel: 'email', meta: { delivered: true } }),
      ledger({ when: '2026-07-01T14:03:00Z', source: 'invoice_followups', purpose: 'invoice_followup', channel: 'sms', meta: { delivered: true } }),
      ledger({ when: '2026-07-04T14:00:00Z', source: 'invoice_followups', purpose: 'invoice_followup', channel: 'email', meta: { delivered: true } }),
    ];
    const out = Timeline.annotateAttempts(rows);
    expect(out.map((a) => a.touch)).toEqual([1, 1, 2]);
    expect(out[2].gapDays).toBeCloseTo(3 - 3 / 1440, 5); // from the touch's latest leg (14:03)
    expect(out[2].underSpacing).toBe(true);
  });

  // Codex #5599 r1 P1: the spacing rule counts a send with no outcome stamp; so does the timeline.
  test('a reservation with no outcome stamp is shown as unconfirmed and counts, as the spacing rule counts it', () => {
    const out = Timeline.annotateAttempts([
      ledger({ when: '2026-07-08T14:16:00Z', meta: delivered('k1') }),
      ledger({ when: '2026-07-10T14:16:00Z', meta: { notificationEventKey: 'k-open' } }),
      ledger({ when: '2026-07-16T14:16:00Z', meta: delivered('k3') }),
    ]);
    expect(out.map((a) => a.state)).toEqual(['delivered', 'unconfirmed', 'delivered']);
    expect(out.map((a) => a.gapDays)).toEqual([null, 2, 6]);
    expect(out.map((a) => a.underSpacing)).toEqual([false, true, true]);
  });

  // Codex #5599 r1 P1, its own example: an email delivered on day 0, its same-key replay text delivered on
  // day 3, another reminder on day 8. The rule times the touch by its replay leg: a 5-day gap, flagged.
  test('a replay leg times its touch: email day 0, same-key replay text day 3, next reminder day 8 is a 5-day gap', () => {
    const out = Timeline.annotateAttempts([
      ledger({ when: '2026-07-01T14:00:00Z', channel: 'email', meta: delivered('kA') }),
      ledger({ when: '2026-07-04T14:00:00Z', source: 'invoice_followup_replay', purpose: 'invoice_followup', channel: 'sms', meta: delivered('kA') }),
      ledger({ when: '2026-07-09T14:00:00Z', channel: 'email', meta: delivered('kB') }),
    ]);
    expect(out.map((a) => a.touch)).toEqual([1, 1, 2]);
    expect(out.map((a) => a.sameTouch)).toEqual([true, false, false]);
    expect(out[2].gapDays).toBe(5);
    expect(out[2].underSpacing).toBe(true);
  });

  test('the counted touches and their times are exactly the spacing rule\'s own events', () => {
    const { collapseDunningReminderEvents } = require('../services/collections/dunning-spacing');
    const rows = [
      ledger({ when: '2026-07-01T14:00:00Z', channel: 'email', meta: { notificationEventKey: 'k1', send_failed: true } }),
      ledger({ when: '2026-07-01T14:00:05Z', channel: 'sms', meta: { notificationEventKey: 'k1' } }),
      ledger({ when: '2026-07-03T14:00:00Z', channel: 'email', meta: delivered('k2') }),
      ledger({ when: '2026-07-06T14:00:00Z', source: 'invoice_followup_replay', purpose: 'invoice_followup', channel: 'sms', meta: delivered('k2') }),
      ledger({ when: '2026-07-20T14:00:00Z', source: 'late_payment_checker', channel: 'email', meta: { delivered: true } }),
      ledger({ when: '2026-07-20T14:05:00Z', source: 'late_payment_checker', channel: 'sms', meta: { send_failed: true } }),
    ];
    const out = Timeline.annotateAttempts(rows);
    expect(out.filter((a) => a.counted).map((a) => a.row)).toEqual(collapseDunningReminderEvents(rows));
  });

  test('only overdue-reminder rows are read: another purpose, an exempt source and a bank-verification nudge are dropped', () => {
    const out = Timeline.annotateAttempts([
      ledger({ when: '2026-07-08T14:16:00Z', meta: delivered('k1') }),
      ledger({ when: '2026-07-09T14:16:00Z', purpose: 'payment_receipt', meta: delivered('r1') }),
      ledger({ when: '2026-07-09T15:16:00Z', source: 'collections_voice_paylink', meta: delivered('v1') }),
      ledger({ when: '2026-07-09T16:16:00Z', meta: delivered('n1', { verification_renudge: true }) }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('time ordering across every source', () => {
  const report = {
    customerId: CUSTOMER,
    days: 120,
    now: at('2026-10-02T12:00:00Z'),
    windowStart: at('2026-06-04T12:00:00Z'),
    attempts: Timeline.annotateAttempts([
      ledger({ when: '2026-07-08T14:16:00Z', meta: delivered('k1', { step_id: 'd3_friendly', variant: 'multi' }) }),
      ledger({ when: '2026-08-05T14:16:00Z', meta: delivered('k2', { step_id: 'd30_final', variant: 'multi' }) }),
    ]),
    sequences: [{
      invoice_id: INVOICE_A, status: 'completed', step_index: 6, touches_sent: 2, last_touch_at: at('2026-07-06T08:16:00Z'), next_touch_at: null, paused_reason: null, stopped_reason: null,
    }],
    schedules: [{
      episode: 1, status: 'completed', step_index: 5, touches_sent: 6, last_touch_at: at('2026-10-01T14:16:00Z'), next_touch_at: null,
      created_at: at('2026-07-07T14:16:00Z'), closed_at: at('2026-10-01T14:16:00Z'), closed_reason: 'final_notice_delivered', held_reason: null, paused_reason: null,
    }],
    holds: [{ id: 'dddddddd-0000-4000-8000-000000000004', kind: 'collection_hold', created_at: at('2026-08-04T13:00:00Z'), released_at: at('2026-08-05T13:00:00Z') }],
    controls: [{ created_at: at('2026-09-01T13:00:00Z'), action: 'combined_reminders_pause', admin_user_id: ADMIN }],
    notes: [],
  };

  test('events from the ledger, sequences, schedules, holds and staff presses come out in one time order', () => {
    const events = Timeline.buildEvents(report);
    const times = events.map((e) => e.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(events.map((e) => e.kind)).toEqual([
      'sequence', // Jul 6
      'schedule', // Jul 7 created
      'ledger', // Jul 8
      'hold', // Aug 4 placed
      'hold', // Aug 5 released
      'ledger', // Aug 5
      'staff', // Sep 1
      'schedule', // Oct 1 closed
    ]);
  });

  // Codex #5599 r1 P2: sequences, schedules and active holds are read with no lower bound for their own
  // sections; the timeline keeps only what happened inside --days.
  test('the timeline keeps only events inside the window; the sections still list the older rows', () => {
    const old = at('2026-01-05T12:00:00Z');
    const withOld = {
      ...report,
      sequences: [...report.sequences, { ...report.sequences[0], invoice_id: INVOICE_B, last_touch_at: old }],
      schedules: [...report.schedules, { ...report.schedules[0], episode: 0, created_at: old, closed_at: old }],
      holds: [...report.holds, { id: 'eeeeeeee-0000-4000-8000-000000000005', kind: 'collection_hold', created_at: old, released_at: null }],
    };
    const events = Timeline.buildEvents(withOld);
    expect(events.every((e) => e.at >= report.windowStart && e.at <= report.now)).toBe(true);
    expect(events).toHaveLength(Timeline.buildEvents(report).length);
    const text = Timeline.formatReport(withOld).join('\n');
    expect(text).toContain(`invoice ${INVOICE_B}  status completed`);
    expect(text).toContain('episode 0  status completed');
    expect(text).toContain('released ACTIVE');
  });

  test('a row with no usable time is left out, never placed at the epoch', () => {
    const events = Timeline.buildEvents({ ...report, sequences: [{ ...report.sequences[0], last_touch_at: null }], holds: [{ id: 'x', kind: 'collection_hold', created_at: 'not a date', released_at: null }] });
    expect(events.every((e) => e.at.getTime() > 0)).toBe(true);
    expect(events.some((e) => e.kind === 'sequence' || e.kind === 'hold')).toBe(false);
  });

  test('the printed report carries UTC and Eastern times, the under-7-day flag and every section', () => {
    const lines = Timeline.formatReport({
      ...report,
      attempts: Timeline.annotateAttempts([
        ledger({ when: '2026-07-08T14:16:00Z', meta: delivered('k1') }),
        ledger({ when: '2026-07-14T14:16:00Z', meta: delivered('k2') }),
      ]),
    });
    const text = lines.join('\n');
    expect(text).toContain('2026-07-08T14:16:00.000Z | 2026-07-08 10:16 EDT');
    expect(text).toContain('gap 6.0d  ** UNDER 7 DAYS **');
    expect(text).toContain('touches under 7 days apart: 1');
    for (const heading of ['PER-INVOICE SEQUENCES', 'REMINDER SCHEDULES', 'COLLECTIONS HOLDS', 'STAFF PRESSES']) expect(text).toContain(heading);
    expect(text).toContain(`admin ${ADMIN}`);
    expect(text).toContain('released 2026-08-05T13:00:00.000Z');
  });

  test('winter time prints EST; an empty schedule table and no events are reported, not crashed on', () => {
    expect(Timeline.formatTimes(at('2026-12-01T15:00:00Z'))).toBe('2026-12-01T15:00:00.000Z | 2026-12-01 10:00 EST');
    expect(Timeline.formatTimes(null)).toBe('-');
    const lines = Timeline.formatReport({
      customerId: CUSTOMER, days: 5, now: at('2026-10-02T12:00:00Z'), windowStart: at('2026-09-27T12:00:00Z'), attempts: [], sequences: [], schedules: [], holds: [], controls: [], notes: ['the collections holds could not be read (42P01)'],
    }).join('\n');
    expect(lines).toContain('(no events in the window)');
    expect(lines).toContain('REMINDER SCHEDULES (customer_dunning_schedules)\n  (none)');
    expect(lines).toContain('NOTE: the collections holds could not be read (42P01)');
  });
});

describe('what is never printed', () => {
  const NAME = 'Test Customer Fixture';
  const PHONE = '+15555550100';
  const EMAIL = 'test.customer@example.test';
  const ADDRESS = '100 Fixture Way';
  const BODY = 'Hi Test, your balance is open. Pay at https://portal.example.test/pay/secret-token';
  const FREE_TEXT = 'customer said they will pay Friday, call 555-0100';

  const dirty = () => ({
    customerId: CUSTOMER,
    days: 120,
    now: at('2026-10-02T12:00:00Z'),
    windowStart: at('2026-06-04T12:00:00Z'),
    attempts: Timeline.annotateAttempts([{
      ...ledger({ when: '2026-07-08T14:16:00Z', meta: delivered('k1', { step_id: 'd3_friendly', variant: 'multi' }) }),
      // every PII-shaped field a row could carry
      customer_name: NAME, first_name: 'Test', last_name: 'Customer', phone: PHONE, email: EMAIL, address_line1: ADDRESS, message_body: BODY, body: BODY, to: PHONE, reason: FREE_TEXT,
      metadata: JSON.stringify({
        notificationEventKey: 'k1', delivered: true, step_id: 'd3_friendly', variant: 'multi', customer_name: NAME, phone: PHONE, email: EMAIL, body: BODY, message: BODY, reason: FREE_TEXT, address: ADDRESS,
      }),
    }]),
    sequences: [{
      invoice_id: INVOICE_A, status: 'paused', step_index: 2, touches_sent: 1, last_touch_at: at('2026-07-10T14:00:00Z'), next_touch_at: null,
      paused_reason: FREE_TEXT, stopped_reason: BODY, first_name: 'Test', phone: PHONE, email: EMAIL,
    }, {
      invoice_id: INVOICE_B, status: 'stopped', step_index: 1, touches_sent: 1, last_touch_at: null, next_touch_at: null, paused_reason: 'admin_paused', stopped_reason: 'customer_disputed',
    }],
    schedules: [{
      episode: 1, status: 'paused', step_index: 2, touches_sent: 2, last_touch_at: at('2026-07-14T14:16:00Z'), next_touch_at: null, created_at: at('2026-07-07T14:16:00Z'), closed_at: null, closed_reason: null, held_reason: FREE_TEXT, paused_reason: 'Customer asked us to wait: ' + NAME,
    }],
    holds: [{ id: 'dddddddd-0000-4000-8000-000000000004', kind: 'collection_hold', created_at: at('2026-08-04T13:00:00Z'), released_at: null, reason: `dispute on call: ${FREE_TEXT}` }],
    controls: [{ created_at: at('2026-09-01T13:00:00Z'), action: 'combined_reminders_pause', admin_user_id: ADMIN, description: `Pause pressed. Reason: ${FREE_TEXT}`, metadata: { reason: FREE_TEXT } }],
    notes: [],
  });

  test('no name, phone, email, address, message body or free-text reason reaches the output', () => {
    const text = Timeline.formatReport(dirty()).join('\n');
    for (const secret of [NAME, 'Test', PHONE, EMAIL, ADDRESS, 'balance is open', 'secret-token', 'pay Friday', '555-0100', 'asked us to wait', 'dispute on call']) {
      expect(text).not.toContain(secret);
    }
    // ids and codes still print
    expect(text).toContain(INVOICE_A);
    expect(text).toContain('admin_paused');
    // a typed stop reason shaped like a code is still something a person typed: withheld
    expect(text).not.toContain('customer_disputed');
    expect(text).toContain('collection_hold');
    expect(text).toContain('[text withheld]');
  });

  test('knownReason prints only the engines\' own reason codes: a typed single token shaped like a code is withheld', () => {
    for (const code of ['admin_paused', 'final_notice_delivered', 'balance_cleared', 'released_admin', 'no_channel_delivered']) {
      expect(Timeline.knownReason(code)).toBe(code);
    }
    // what a person can type into a pause / stop reason, or a provider error string
    for (const typed of ['Jane.Doe', '555-0100', 'Jane', 'a@b.test', 'customer said wait', 'payment_plan:1234:prev=active', 'unknown_code']) {
      expect(Timeline.knownReason(typed)).toBe('[text withheld]');
    }
    expect(Timeline.knownReason(null)).toBeNull();
    expect(Timeline.knownReason('')).toBeNull();
  });

  test('the report withholds a single-token name or phone typed as a pause or stop reason, on both tables', () => {
    const report = {
      customerId: '00000000-0000-4000-8000-000000000001', now: new Date('2026-08-01T00:00:00Z'), days: 30,
      windowStart: new Date('2026-07-02T00:00:00Z'), attempts: [], holds: [], controls: [], notes: [],
      sequences: [{ invoice_id: 'inv-1', status: 'paused', step_index: 1, touches_sent: 1, paused_reason: 'Jane.Doe', stopped_reason: '555-0100' }],
      schedules: [{ episode: 1, status: 'paused', step_index: 1, touches_sent: 1, created_at: new Date('2026-07-05T00:00:00Z'), paused_reason: 'Jane', held_reason: 'collection_hold', closed_reason: null }],
    };
    const text = Timeline.formatReport(report).join('\n');
    for (const typed of ['Jane.Doe', '555-0100', 'Jane']) expect(text).not.toContain(typed);
    expect(text).toContain('held_reason collection_hold');
    expect(text).toContain('[text withheld]');
  });

  test('codeOnly prints a machine code and withholds anything else', () => {
    expect(Timeline.codeOnly('admin_paused')).toBe('admin_paused');
    expect(Timeline.codeOnly('final_notice_delivered')).toBe('final_notice_delivered');
    expect(Timeline.codeOnly('customer said wait')).toBe('[text withheld]');
    expect(Timeline.codeOnly('call me at 555-0100')).toBe('[text withheld]');
    expect(Timeline.codeOnly('a@b.test')).toBe('[text withheld]');
    expect(Timeline.codeOnly(null)).toBeNull();
    expect(Timeline.codeOnly('')).toBeNull();
  });
});

describe('the script source stays read-only', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');

  test('no write statement, no execute mode', () => {
    expect(source).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|upsert)\b/i);
    expect(source).not.toMatch(/--execute/);
  });

  test('every read of the customer runs in a READ ONLY transaction that is rolled back', () => {
    expect(source).toMatch(/SET TRANSACTION READ ONLY/);
    expect(source).toMatch(/trx\.rollback\(\)/);
    expect(source).not.toMatch(/\.commit\(/);
    expect(source).toMatch(/inReadOnlyTransaction\(db,/);
  });

  test('it reaches no provider: no payment, text, email or notification module is imported', () => {
    expect(source).not.toMatch(/stripe|twilio|sendgrid|send-customer-message|email-template-library|notification-service|invoice-followups|balance-set|customer-dunning\//i);
  });

  test('the database guard is the dry-run script\'s, and main only runs when invoked directly', () => {
    expect(source).toMatch(/DATABASE_PUBLIC_URL \(or DATABASE_URL\) not set/);
    expect(source).toMatch(/PGSSLMODE = 'no-verify'/);
    expect(source).toMatch(/require\.main === module/);
    expect(typeof Timeline.readTimeline).toBe('function');
  });

  test('the ledger query reuses the spacing rule\'s own sources and purposes', () => {
    expect(source).toMatch(/OVERDUE_SOURCES/);
    expect(source).toMatch(/OVERDUE_PURPOSES/);
    expect(source).toMatch(/collections_contact_ledger/);
  });
});
