/**
 * Tax deadline bells (GATE_TAX_DEADLINE_BELLS, owner 2026-10-30, "All tax deadlines ring").
 *
 * The 8:23 ET tax deadline job used to text the owner phone. That text is an owner-phone
 * internal alert, which twilio.js turns into the internal_admin_alert trigger, and the bell
 * policy denies that trigger: from 2026-09-01 the owner got nothing while the job still
 * marked every row reminded. With the gate on, each reminder is an admin bell instead,
 * raised through raiseAdminAlert (docs/admin-notifications.md) in category `tax` with
 * `bellDefault: true`: it rings by default and a saved Settings override still wins.
 *
 * Stages (a payroll row is `source_key` 'payroll:%'; status not filed or paid):
 *   d14      due within 14 days
 *   d3       due within 3 days
 *   d1       the business day before the due date (weekends and the row's holidays skipped)
 *   overdue  every morning after the due date until the owner marks the row
 * Any other row (sales tax, estimated tax) rings once, at d14, and never after its due date,
 * because the owner does not mark those rows. A row first seen inside a window gets only the
 * latest stage due. Stages sent are kept in tax_filing_calendar.reminder_stages.
 *
 * A bell is done when its row is marked filed or paid (closeBellsForFiling, called by the
 * filing PUT route, and the sweep at the end of each run). The sweep also keeps one open
 * bell per row: a newer stage replaces the older ones. Sends nothing to a customer.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { fitAction } = require('./admin-alert-names');
const payrollCalendar = require('./payroll-tax-calendar');

const CATEGORY = 'tax';
const KEY_PREFIX = 'tax-deadline:';
const LINK = '/admin/tax?tab=filings';
const STAGE_ORDER = ['d14', 'd3', 'd1', 'overdue'];
const DONE_STATUSES = ['filed', 'paid'];
const DAY_MS = 24 * 60 * 60 * 1000;
const FLORIDA_TYPES = new Set(['payroll_rt6', 'payroll_new_hire']);

const isPayroll = (row) => String(row.source_key || '').startsWith('payroll:');
const dayNumber = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);
const daysBetween = (fromYmd, toYmd) => dayNumber(toYmd) - dayNumber(fromYmd);

function previousBusinessDay(row, due) {
  return FLORIDA_TYPES.has(row.filing_type)
    ? payrollCalendar.previousBusinessDayFlorida(due)
    : payrollCalendar.previousBusinessDayIrs(due);
}

// The stage a row is in on `today` (YYYY-MM-DD, ET), ignoring what was already sent. Pure.
function currentStage(row, today) {
  const due = dateOnlyString(row.due_date);
  const away = daysBetween(today, due);
  if (isPayroll(row)) {
    if (away < 0) return 'overdue';
    if (today >= previousBusinessDay(row, due)) return 'd1';
    if (away <= 3) return 'd3';
    return away <= 14 ? 'd14' : null;
  }
  return away >= 0 && away <= 14 ? 'd14' : null;
}

function sentStages(row) {
  const raw = row.reminder_stages;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// The stage to ring now, or null. A stage rings once and only when it is newer than every
// stage already sent; the overdue stage rings again each ET day.
function stageToRing(row, today) {
  const stage = currentStage(row, today);
  if (!stage) return null;
  const sent = sentStages(row);
  if (stage === 'overdue') {
    const last = sent.overdue ? etDateString(new Date(sent.overdue)) : null;
    return last === today ? null : stage;
  }
  const newest = Math.max(-1, ...Object.keys(sent).map((s) => STAGE_ORDER.indexOf(s)));
  return STAGE_ORDER.indexOf(stage) > newest ? stage : null;
}

const dedupeKeyFor = (row, stage, today) => (stage === 'overdue'
  ? `${KEY_PREFIX}${row.id}:overdue:${today}`
  : `${KEY_PREFIX}${row.id}:${stage}`);

const dayLabel = (ymd) => new Date(`${ymd}T12:00:00Z`)
  .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const moneyOf = (row) => {
  const n = row.amount_due == null || row.amount_due === '' ? NaN : Number(row.amount_due);
  return Number.isFinite(n) && n > 0 ? ` for $${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}` : '';
};

// One sentence, at most 110 characters, no dates in ISO form (docs/admin-notifications.md).
function whyFor(row, stage, today) {
  const due = dateOnlyString(row.due_date);
  const away = daysBetween(today, due);
  const when = dayLabel(due);
  const amount = moneyOf(row);
  if (stage === 'overdue') return `Was due ${when}, ${plural(-away, 'day')} ago${amount}; it rings each morning until you mark it.`;
  if (stage === 'd1' && away === 0) return `Due today${amount}.`;
  // The special wording is for the day the payment must be started. A row first seen later (a weekend or a
  // holiday between that day and the due date) gets the plain count of days.
  if (stage === 'd1' && today === previousBusinessDay(row, due)) {
    if (row.filing_type === 'payroll_rt6') return `Start the Florida payment by 5 PM ET today, due ${when}${amount}.`;
    if (row.filing_type === 'payroll_941_deposit') {
      return `Pay today: EFTPS needs the payment started by 8 PM ET today, due ${when}${amount}.`;
    }
    return away === 1 ? `Due tomorrow${amount}.` : `Due ${when}, the next business day${amount}.`;
  }
  return `Due ${when}, in ${plural(away, 'day')}${amount}.`;
}

function verbFor(row, stage) {
  if (stage === 'd14' || stage === 'd3') return 'prepare';
  if (row.filing_type === 'payroll_941_deposit' || row.filing_type === 'payroll_futa_alert') return 'pay';
  return row.filing_type === 'payroll_rt6' ? 'file and pay' : 'file';
}

// The alert spec for one row and stage. Pure.
function specFor(row, stage, today) {
  const name = String(row.title || 'tax filing').replace(/\s+—\s+/g, ' ');
  const verb = verbFor(row, stage);
  return {
    area: 'Billing',
    action: fitAction('Billing', name, [(n) => `${verb} ${n}`]),
    why: whyFor(row, stage, today),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: `tax-filing:${row.id}` },
    doneWhen: 'filing_marked_done',
    who: 'person',
  };
}

async function raiseReminder(row, stage, today, raise) {
  const result = await raise(CATEGORY, specFor(row, stage, today), {
    dedupeKey: dedupeKeyFor(row, stage, today),
    bellDefault: true,
    ...(row.notes ? { detail: String(row.notes) } : {}),
    metadata: { filingId: row.id, stage, dueDate: dateOnlyString(row.due_date), reminder: 'tax_deadline' },
  });
  return Boolean(result && result.id);
}

async function recordStage(row, stage, now) {
  const stamp = { [stage]: now.toISOString() };
  const update = {
    reminder_stages: db.raw("COALESCE(reminder_stages, '{}'::jsonb) || ?::jsonb", [JSON.stringify(stamp)]),
  };
  // The first stage also sets the old columns, so nothing else that reads them drifts.
  if (!row.reminder_sent || !row.reminder_sent_at) Object.assign(update, { reminder_sent: true, reminder_sent_at: now });
  await db('tax_filing_calendar').where({ id: row.id }).update(update);
}

function openRowsQuery(today, horizon) {
  return db('tax_filing_calendar')
    .whereNotIn('status', DONE_STATUSES)
    .where(function dueSoonOrPayrollOverdue() {
      this.where(function dueSoon() {
        this.where('due_date', '>=', today).where('due_date', '<=', horizon);
      }).orWhere(function payrollOverdue() {
        this.where('due_date', '<', today).where('source_key', 'like', 'payroll:%');
      });
    })
    .orderBy('due_date');
}

// A bell's dedupe key: tax-deadline:<row id>:<stage>[:<ET date>].
function parseKey(key) {
  const [, id, stage, date] = String(key).split(':');
  return { id, stage, date: date || null };
}

// Closes bells whose row is marked, gone, or (a row the owner never marks) past its due date,
// and keeps one open bell per row: a newer stage replaces the older ones.
async function sweepBells({ today, closeKeys, openKeys, conn = db }) {
  const keys = await openKeys(conn, KEY_PREFIX);
  if (!keys.length) return 0;
  const parsed = keys.map((key) => ({ key, ...parseKey(key) }));
  const rows = await conn('tax_filing_calendar')
    .whereIn('id', [...new Set(parsed.map((p) => p.id))])
    .select('id', 'status', 'due_date', 'source_key');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rank = (p) => STAGE_ORDER.indexOf(p.stage) * 1e9 + (p.date ? dayNumber(p.date) : 0);
  const newest = new Map();
  for (const p of parsed) if (!newest.has(p.id) || rank(p) > rank(newest.get(p.id))) newest.set(p.id, p);
  const groups = new Map();
  const add = (resolution, key) => groups.set(resolution, [...(groups.get(resolution) || []), key]);
  for (const p of parsed) {
    const row = byId.get(p.id);
    if (!row || DONE_STATUSES.includes(row.status)) add('The filing was marked paid or filed', p.key);
    else if (!isPayroll(row) && dateOnlyString(row.due_date) < today) add('The due date has passed', p.key);
    else if (newest.get(p.id).key !== p.key) add('A newer reminder for this filing replaced it', p.key);
  }
  let closed = 0;
  for (const [resolution, list] of groups) {
    closed += Number(await closeKeys(conn, list, 'tax_deadline_settled', { resolution })) || 0;
  }
  return closed;
}

/**
 * The gate-on body of the 8:23 ET job. Never throws for one bad row. Returns counts.
 * Injectable: now, raise (raiseAdminAlert), episodes (closeAdminAlertKeys/openAdminAlertKeys).
 */
async function runTaxDeadlineReminders({
  now = new Date(),
  raise = require('./admin-alert-compose').raiseAdminAlert,
  episodes = require('./admin-alert-episodes'),
} = {}) {
  const today = etDateString(now);
  const horizon = etDateString(addETDays(now, 14));
  const tally = { rung: 0, skipped: 0, failed: 0, closed: 0 };
  const rows = await openRowsQuery(today, horizon);
  for (const row of rows) {
    try {
      const stage = stageToRing(row, today);
      if (!stage) { tally.skipped += 1; continue; }
      // Not recorded when nothing was written (the owner's Settings silenced the category, or the
      // insert failed): the next morning tries again, and the old silent mark-as-sent never returns.
      if (await raiseReminder(row, stage, today, raise)) {
        await recordStage(row, stage, now);
        tally.rung += 1;
      } else tally.skipped += 1;
    } catch (err) {
      tally.failed += 1;
      logger.error(`[tax-deadline-bells] reminder failed for a filing: ${err.message}`);
    }
  }
  try {
    tally.closed = await sweepBells({ today, closeKeys: episodes.closeAdminAlertKeys, openKeys: episodes.openAdminAlertKeys });
  } catch (err) {
    logger.error(`[tax-deadline-bells] bell sweep failed: ${err.message}`);
  }
  logger.info(`[tax-deadline-bells] rung ${tally.rung}, skipped ${tally.skipped}, failed ${tally.failed}, closed ${tally.closed}`);
  return tally;
}

// Called by PUT /api/admin/tax/filings/:id when a row becomes filed or paid. Never throws.
async function closeBellsForFiling(filingId, { conn = db, episodes = require('./admin-alert-episodes') } = {}) {
  try {
    const keys = (await episodes.openAdminAlertKeys(conn, `${KEY_PREFIX}${filingId}:`));
    if (!keys.length) return 0;
    return Number(await episodes.closeAdminAlertKeys(conn, keys, 'tax_filing_marked', {
      resolution: 'The filing was marked paid or filed',
    })) || 0;
  } catch (err) {
    logger.warn(`[tax-deadline-bells] could not close bells for a filing: ${err.message}`);
    return 0;
  }
}

module.exports = {
  CATEGORY, KEY_PREFIX, LINK, STAGE_ORDER,
  currentStage, stageToRing, specFor, dedupeKeyFor, sweepBells,
  runTaxDeadlineReminders, closeBellsForFiling,
};
