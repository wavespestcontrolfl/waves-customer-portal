#!/usr/bin/env node
// READ-ONLY. This script never writes: there is no execute mode, it calls no
// provider and no payment service, and every read for the customer runs inside
// one `SET TRANSACTION READ ONLY` transaction that is always rolled back, so
// Postgres itself refuses a write.
//
// Customer-level overdue reminders: for the canary review, print ONE
// customer's whole reminder history in time order so the office can see what
// the customer actually received and why:
//   - every overdue-reminder attempt on the collections contact ledger (the
//     sources and purposes the spacing rule counts), with its time (UTC and
//     Eastern), source, channel, whether it was delivered, and the gap in days
//     since the previous reminder the 7-day spacing rule counts (its own
//     collapseDunningReminderEvents), flagging any gap under 7 days;
//   - the customer's per-invoice follow-up sequences,
//   - the customer's reminder schedule rows (customer_dunning_schedules),
//   - the customer's collections holds,
//   - the combined-reminder staff presses (activity_log combined_reminders_*).
//
// Prints ids, codes, times and counts only. A customer name, phone, email,
// address, message body or free-text reason is never selected, and a reason
// column is printed only when it is a machine code.
//
// Usage (repo root):
//   railway run --service Postgres -- node server/scripts/dunning-customer-timeline.js --customer <uuid> [--days 120]

const path = require('path');
const {
  OVERDUE_SOURCES, OVERDUE_PURPOSES, isOverdueReminderRow, collapseDunningReminderEvents,
} = require(path.join(__dirname, '..', 'services', 'collections', 'dunning-spacing'));

const TAG = '[dunning-customer-timeline]';
const DAY_MS = 24 * 60 * 60 * 1000;
const SPACING_DAYS = 7;
const SIBLING_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_DAYS = 120;
const MAX_DAYS = 3650;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };

// Fail closed: without a usable URL the knex config would fall back to
// whatever local/dev database is reachable (same guard as
// dunning-customer-schedule-dry-run.js).
function prepareDatabaseEnv() {
  if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
    console.error(`${TAG} DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node server/scripts/dunning-customer-timeline.js --customer <uuid>`);
    process.exit(1);
  }
  if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) Reflect.deleteProperty(process.env, 'DATABASE_PUBLIC_URL');
  // The app's knex reads DATABASE_URL; railway run injects the internal host,
  // unreachable from a local machine — prefer the public proxy, with TLS.
  if (process.env.DATABASE_PUBLIC_URL) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
    if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
  }
}

/** { ok: true, customer, days } or { ok: false, message }. Pure. */
function parseArgs(argv = []) {
  let customer = null;
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--customer') { customer = argv[i + 1]; i += 1; } else if (arg === '--days') {
      const raw = argv[i + 1];
      i += 1;
      if (!/^[1-9]\d*$/.test(String(raw || '')) || Number(raw) > MAX_DAYS) {
        return { ok: false, message: `--days needs a whole number from 1 to ${MAX_DAYS}, got ${JSON.stringify(raw ?? null)}` };
      }
      days = Number(raw);
    } else {
      return { ok: false, message: `unknown argument ${JSON.stringify(arg)} (usage: --customer <uuid> [--days N])` };
    }
  }
  if (!customer || !UUID.test(String(customer))) {
    return { ok: false, message: '--customer <uuid> is required and must be a customer id (usage: --customer <uuid> [--days N])' };
  }
  return { ok: true, customer: String(customer).toLowerCase(), days };
}

// ── formatting (pure) ─────────────────────────────────────────────────────

const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

const asDate = (value) => (value == null ? null : new Date(value));
const validDate = (value) => { const d = asDate(value); return d && !Number.isNaN(d.getTime()) ? d : null; };

/** "2026-07-08T14:16:00.000Z | 2026-07-08 10:16 EDT", or "-" for a missing time. */
function formatTimes(value) {
  const d = validDate(value);
  if (!d) return '-';
  const p = Object.fromEntries(ET_FORMAT.formatToParts(d).map((part) => [part.type, part.value]));
  return `${d.toISOString()} | ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/**
 * For columns only the system writes from a fixed vocabulary (step id, variant, hold flag, staff-press
 * action): printed when it is shaped like a machine code, withheld otherwise.
 */
function codeOnly(value) {
  if (value == null || value === '') return null;
  return CODE.test(String(value)) ? String(value) : '[text withheld]';
}

// The reason codes the reminder engines themselves write. A reason column can also hold what a person
// typed (a pause or stop reason) or a provider error string, and a single typed token ("Jane.Doe",
// "555-0100") is shaped exactly like a code, so shape proves nothing: only these are ever printed.
const KNOWN_REASON_CODES = new Set([
  'admin_paused', 'no_channel_delivered',
  'member_paused', 'member_autopay_hold', 'account_credit_available', 'delivered_evidence_unreadable',
  'over_cap', 'no_reachable_channel', 'all_channels_terminal', 'customer_deleted', 'collection_hold',
  'COLLECTIONS_POLICY', 'REMINDER_OUTCOME_UNCONFIRMED', 'prefs_unreadable', 'progress_unreadable',
  'autopay_unreadable', 'autopay_hold', 'balance_cleared', 'no_active_member', 'final_notice_delivered',
  'released_admin', 'released_gate_off', 'released_prereq_off', 'released_final_notice_unreadable',
  'released_past_final_step',
]);

/** A reason column: printed only when it is one of the engines' own codes; everything else is withheld. */
function knownReason(value) {
  if (value == null || value === '') return null;
  return KNOWN_REASON_CODES.has(String(value)) ? String(value) : '[text withheld]';
}

const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const metadataOf = (row) => {
  const meta = parseJson(row?.metadata, {});
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
};

const invoiceIdsOf = (row) => {
  const ids = parseJson(row?.invoice_ids, []);
  return Array.isArray(ids) ? ids.map(String).filter((id) => UUID.test(id)).sort() : [];
};

/** delivered | failed | refused | unconfirmed (a reservation with no outcome stamp). */
function deliveryState(row) {
  const meta = metadataOf(row);
  if (meta.delivered === true) return 'delivered';
  if (meta.send_failed === true) return 'failed';
  if (meta.resolved === true) return 'refused';
  return 'unconfirmed';
}

const compareRows = (a, b) => {
  const byTime = new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime();
  if (byTime) return byTime;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
};

/**
 * Group ledger rows into TOUCHES the way the spacing rule does: the legs of one
 * touch share a notificationEventKey; a keyless row joins the earlier keyless
 * touch of the same source and invoice set that began within 15 minutes.
 */
function groupTouches(sortedRows) {
  const byKey = new Map();
  const keyless = new Map();
  const touches = [];
  for (const row of sortedRows) {
    const rawKey = metadataOf(row).notificationEventKey;
    const key = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : null;
    let touch;
    if (key) {
      touch = byKey.get(key);
      if (!touch) { touch = { rows: [] }; byKey.set(key, touch); touches.push(touch); }
    } else {
      const siblingKey = JSON.stringify([row.source, invoiceIdsOf(row)]);
      const open = keyless.get(siblingKey);
      if (open && new Date(row.occurred_at).getTime() - new Date(open.rows[0].occurred_at).getTime() <= SIBLING_WINDOW_MS) touch = open;
      else { touch = { rows: [] }; keyless.set(siblingKey, touch); touches.push(touch); }
    }
    touch.rows.push(row);
  }
  return touches;
}

/**
 * Annotate overdue-reminder ledger rows with their delivery state, touch, and
 * the gap in days since the previous reminder THE SPACING RULE COUNTS. The
 * events and their times come from dunning-spacing.js's own
 * collapseDunningReminderEvents (Codex #5599 r1 P1), never a second reading of
 * it here: a row counts unless it is stamped failed (an unstamped send counts),
 * and a touch with several legs is timed by its latest counted leg. A gap under
 * 7 days is flagged. Pure: rows in, annotated rows out, in time order.
 */
function annotateAttempts(rows) {
  const sorted = [...(rows || [])].filter((row) => validDate(row.occurred_at) && isOverdueReminderRow(row)).sort(compareRows);
  const touches = groupTouches(sorted);
  const touchOf = new Map();
  for (const [index, touch] of touches.entries()) {
    touch.number = index + 1;
    for (const row of touch.rows) touchOf.set(row, touch);
  }
  const gapByLead = new Map();
  let previousAt = null;
  for (const event of collapseDunningReminderEvents(sorted)) {
    const eventAt = new Date(event.occurred_at);
    gapByLead.set(event, previousAt ? (eventAt.getTime() - previousAt.getTime()) / DAY_MS : null);
    previousAt = eventAt;
  }
  const countedTouches = new Set([...gapByLead.keys()].map((row) => touchOf.get(row)));
  return sorted.map((row) => {
    const isLead = gapByLead.has(row);
    const gapDays = isLead ? gapByLead.get(row) : null;
    return {
      row,
      touch: touchOf.get(row).number,
      state: deliveryState(row),
      counted: isLead,
      gapDays,
      underSpacing: isLead && gapDays != null && gapDays < SPACING_DAYS,
      sameTouch: !isLead && countedTouches.has(touchOf.get(row)),
    };
  });
}

const gapText = (a) => {
  if (a.sameTouch) return 'same touch';
  if (!a.counted) return '-';
  if (a.gapDays == null) return 'first counted';
  return `gap ${a.gapDays.toFixed(1)}d${a.underSpacing ? '  ** UNDER 7 DAYS **' : ''}`;
};

function attemptLine(a) {
  const meta = metadataOf(a.row);
  const bits = [];
  if (meta.step_id) bits.push(`step=${codeOnly(meta.step_id)}`);
  if (meta.variant) bits.push(`variant=${codeOnly(meta.variant)}`);
  bits.push(`invoices=${invoiceIdsOf(a.row).length}`);
  return `attempt  touch#${a.touch}  ${a.row.source}  ${a.row.channel}  ${a.state}  ${bits.join(' ')}  ${gapText(a)}`;
}

/**
 * One time-ordered list across every source: { at, kind, text }, inside the
 * report's window. Pure; rows with no usable time are left out (they cannot be placed). Ties keep a stable order
 * by kind then text.
 */
function buildEvents(report) {
  const events = [];
  const push = (at, kind, text) => { const d = validDate(at); if (d) events.push({ at: d, kind, text }); };
  for (const a of report.attempts || []) push(a.row.occurred_at, 'ledger', attemptLine(a));
  for (const s of report.sequences || []) {
    push(s.last_touch_at, 'sequence', `per-invoice touch  invoice ${s.invoice_id}  status ${s.status}  step ${s.step_index}  touches ${s.touches_sent}`);
  }
  for (const s of report.schedules || []) {
    push(s.created_at, 'schedule', `schedule created  episode ${s.episode}`);
    push(s.closed_at, 'schedule', `schedule closed  episode ${s.episode}  status ${s.status}  reason ${knownReason(s.closed_reason) || '-'}`);
  }
  for (const h of report.holds || []) {
    push(h.created_at, 'hold', `hold placed  id ${h.id}  kind ${codeOnly(h.kind) || '-'}`);
    push(h.released_at, 'hold', `hold released  id ${h.id}  kind ${codeOnly(h.kind) || '-'}`);
  }
  for (const c of report.controls || []) {
    push(c.created_at, 'staff', `staff press  ${codeOnly(c.action) || '-'}  admin ${c.admin_user_id || '-'}`);
  }
  // Only the requested window (Codex #5599 r1 P2): sequences, schedules and active holds are read with no
  // lower bound for their own sections, so their older events are left out here.
  const from = validDate(report.windowStart);
  const to = validDate(report.now);
  return events
    .filter((e) => (!from || e.at >= from) && (!to || e.at <= to))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text));
}

const stamp = (value) => (validDate(value) ? validDate(value).toISOString() : '-');

const section = (title, rows, formatRow, empty) => [title, ...(rows.length ? rows.map(formatRow) : [`  ${empty}`]), ''];

const sequenceLine = (s) => `  invoice ${s.invoice_id}  status ${s.status}  step ${s.step_index}  touches ${s.touches_sent}  last ${stamp(s.last_touch_at)}  next ${stamp(s.next_touch_at)}`
  + `  paused_reason ${knownReason(s.paused_reason) || '-'}  stopped_reason ${knownReason(s.stopped_reason) || '-'}`;

const scheduleLine = (s) => `  episode ${s.episode}  status ${s.status}  step ${s.step_index}  touches ${s.touches_sent}  last ${stamp(s.last_touch_at)}  next ${stamp(s.next_touch_at)}`
  + `  closed ${stamp(s.closed_at)} reason ${knownReason(s.closed_reason) || '-'}  held_reason ${knownReason(s.held_reason) || '-'}  paused_reason ${knownReason(s.paused_reason) || '-'}`;

const holdLine = (h) => `  hold ${h.id}  kind ${codeOnly(h.kind) || '-'}  placed ${stamp(h.created_at)}  released ${h.released_at ? stamp(h.released_at) : 'ACTIVE'}`;

const controlLine = (c) => `  ${stamp(c.created_at)}  ${codeOnly(c.action) || '-'}  admin ${c.admin_user_id || '-'}`;

/** The printed report, one string per line. Pure. */
function formatReport(report) {
  const events = buildEvents(report);
  const flagged = (report.attempts || []).filter((a) => a.underSpacing).length;
  return [
    `${TAG} READ ONLY — customer ${report.customerId}  window ${stamp(report.windowStart)} .. ${stamp(report.now)} (${report.days}d)`,
    '',
    'TIMELINE (UTC | Eastern). Gap = days since the previous reminder the spacing rule counts (any send not stamped failed;',
    '  a touch with several legs is timed by its latest one); a gap under 7 days is flagged.',
    ...(events.length ? events.map((e) => `  ${formatTimes(e.at)} | ${e.text}`) : ['  (no events in the window)']),
    `  touches under 7 days apart: ${flagged}`,
    '',
    ...section('PER-INVOICE SEQUENCES', report.sequences || [], sequenceLine, '(none)'),
    ...section('REMINDER SCHEDULES (customer_dunning_schedules)', report.schedules || [], scheduleLine, '(none)'),
    ...section('COLLECTIONS HOLDS', report.holds || [], holdLine, '(none active or in the window)'),
    ...section('STAFF PRESSES (activity_log combined_reminders_*)', report.controls || [], controlLine, '(none)'),
    ...(report.notes || []).map((note) => `NOTE: ${note}`),
  ];
}

// ── reads (every one inside the read-only transaction) ────────────────────

// One customer, one READ ONLY transaction, always rolled back.
async function inReadOnlyTransaction(db, fn) {
  const trx = await db.transaction();
  try {
    await trx.raw('SET TRANSACTION READ ONLY');
    return await fn(trx);
  } finally {
    await trx.rollback();
  }
}

// A table that is missing or unreadable must not abort the whole read (PostgreSQL
// would refuse every later statement of an aborted transaction): each read runs in
// its own savepoint and reports what it could not read.
async function optionalRead(trx, label, notes, fn) {
  try {
    return await trx.transaction((sp) => fn(sp));
  } catch (err) {
    notes.push(`${label} could not be read (${err.code || 'error'})`);
    return [];
  }
}

/**
 * Read one customer's reminder history. `database` must be a read-only handle
 * (inReadOnlyTransaction). Returns the raw report that formatReport prints.
 */
async function readTimeline(database, customerId, { now = new Date(), days = DEFAULT_DAYS } = {}) {
  const windowStart = new Date(now.getTime() - days * DAY_MS);
  // A gap needs the delivered reminder BEFORE the first one in the window.
  const lookbackStart = new Date(windowStart.getTime() - 30 * DAY_MS);
  const notes = [];

  const ledgerRows = await optionalRead(database, 'the collections contact ledger', notes, (sp) => sp('collections_contact_ledger')
    .where({ customer_id: customerId })
    .whereIn('source', [...OVERDUE_SOURCES])
    .whereIn('purpose', [...OVERDUE_PURPOSES])
    .where('occurred_at', '>=', lookbackStart)
    .where('occurred_at', '<=', now)
    .orderBy([{ column: 'occurred_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('id', 'customer_id', 'source', 'purpose', 'channel', 'occurred_at', 'metadata', 'invoice_ids'));
  const attempts = annotateAttempts(ledgerRows).filter((a) => new Date(a.row.occurred_at) >= windowStart);

  const sequences = await optionalRead(database, 'the per-invoice follow-up sequences', notes, (sp) => sp('invoice_followup_sequences')
    .where({ customer_id: customerId })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'invoice_id', order: 'asc' }])
    .select('invoice_id', 'status', 'step_index', 'touches_sent', 'last_touch_at', 'next_touch_at', 'paused_reason', 'stopped_reason'));

  const schedules = await optionalRead(database, 'the customer reminder schedules', notes, (sp) => sp('customer_dunning_schedules')
    .where({ customer_id: customerId })
    .orderBy('episode', 'asc')
    .select('episode', 'status', 'step_index', 'touches_sent', 'last_touch_at', 'next_touch_at', 'created_at', 'closed_at', 'closed_reason', 'held_reason', 'paused_reason'));

  const holds = await optionalRead(database, 'the collections holds', notes, (sp) => sp('collections_flags')
    .where({ customer_id: customerId })
    .where(function activeOrInWindow() {
      this.whereNull('released_at').orWhere('released_at', '>=', windowStart).orWhere('created_at', '>=', windowStart);
    })
    .orderBy('created_at', 'asc')
    .select('id', 'flag as kind', 'created_at', 'released_at'));

  const controls = await optionalRead(database, 'the staff press log', notes, (sp) => sp('activity_log')
    .where({ customer_id: customerId })
    .whereRaw('action LIKE ?', ['combined\\_reminders\\_%'])
    .where('created_at', '>=', windowStart)
    .orderBy('created_at', 'asc')
    .select('created_at', 'action', 'admin_user_id'));

  return {
    customerId, now, days, windowStart, attempts, sequences, schedules, holds, controls, notes,
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${TAG} ${parsed.message} — aborting`);
    process.exit(1);
  }
  prepareDatabaseEnv();
  // Required only now: models/db reads DATABASE_URL once, at load.
  const db = require(path.join(__dirname, '..', 'models', 'db'));
  try {
    const report = await inReadOnlyTransaction(db, (trx) => readTimeline(trx, parsed.customer, { now: new Date(), days: parsed.days }));
    for (const line of formatReport(report)) console.log(line);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`${TAG} failed:`, e.message); process.exitCode = 1; });
}

module.exports = {
  parseArgs,
  prepareDatabaseEnv,
  formatTimes,
  codeOnly,
  knownReason,
  KNOWN_REASON_CODES,
  deliveryState,
  annotateAttempts,
  buildEvents,
  formatReport,
  inReadOnlyTransaction,
  readTimeline,
  SPACING_DAYS,
};
