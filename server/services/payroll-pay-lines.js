/**
 * Payroll pay lines (owner ruling 2026-10-29, D5 part 1 of the first-technician
 * pay plan: "Build the payroll pieces now, switched off"). Dark behind
 * GATE_PAYROLL_PAY_LINES (the route checks it; payroll-runs.js asks payLinesOn()).
 *
 * A pay line is one amount the owner wants paid on a W-2 technician's check on
 * top of the hours: a review bonus, a sales commission, a monthly health
 * allowance, or an employer HSA contribution. A line waits 'open' until a pay
 * run that reaches its earned week is FINALIZED, then it is 'paid' and keeps the
 * check that paid it. Voiding the run reopens it. A paid line cannot be edited
 * or deleted (a trigger in the migration enforces it; the service answers 409
 * first). Part 3 (the commission ledger and the review-bonus import) will write
 * lines with a source_type and source_id; the table already refuses a repeat.
 *
 * This file holds the admin reads and writes and the three pay run helpers:
 * openLinesFor (which lines a run pays), priceLines (the federal regular-rate
 * overtime they cause, read from the approved hours of every week they cover),
 * and totalsOf (the check columns). The math itself is payroll-regular-rate.js.
 *
 * Audit events carry ids and the kind, never an amount or a note.
 */
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { PayrollError } = require('./payroll-w4');
const { lineOvertimePremium, weeksOfLine } = require('./payroll-regular-rate');
const { markPayoutsPaid, reopenPayoutsOfRun } = require('./payroll-review-bonuses');
const { payrollPayLinesLive } = require('../config/feature-gates');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The kinds an admin can add by hand. The Tech Rewards Plan kinds (season bonus, stay bonus, December gift) are never added or
// removed by hand: the pay run works them out, and a hand-made one would pay a bonus the plan never earned.
const KINDS = ['review_bonus', 'commission', 'health_allowance', 'hsa_employer'];
const TECH_REWARD_KINDS = ['season_bonus', 'stay_bonus', 'december_gift'];
// source_type of the lines the pay run's Tech Rewards sync writes (tech-rewards-pay-lines.js).
const TECH_REWARDS_SOURCE = 'tech_rewards';
// The kinds that sync writes, each with the form of its key (the last part of the source id). The season bonus comes later.
//   december_gift   the year of the gift, 4 digits
//   stay_bonus      the years of service of the milestone: 1, 3 or 5. One key for a milestone whatever its date, so a hire
//                   date corrected after the bonus was paid never pays the same milestone again.
const TECH_REWARDS_KEYS = { december_gift: { length: 4, pattern: '^[0-9]{4}$' }, stay_bonus: { length: 1, pattern: '^[135]$' } };
const TECH_REWARDS_SYNC_KINDS = Object.keys(TECH_REWARDS_KEYS);
// The source id of the sync's line for one technician and one key.
const techRewardsSourceId = (kind, technicianId, key) => `${kind}:${technicianId}:${key}`;

/**
 * OWNERSHIP of a Tech Rewards line: the one rule for every place that pays, moves, removes or counts one. The sync owns a
 * line only when its WHOLE source key is the sync's: the Tech Rewards source type, a kind the sync writes, and a source id
 * that is exactly techRewardsSourceId(the row's own kind, the row's own technician id as PostgreSQL prints it, a key of the
 * kind's form). The comparison is exact, case included: the unique source key is case-sensitive text, so a key in another
 * case is another key. Any other row (no source, another source type, or the Tech Rewards source type with any other source
 * id) is a line somebody made by hand. It carries forward and is paid like every manual line, and the sync never matches,
 * moves or removes it.
 * techRewardsOwnKey(line): { kind, key } or null, for a row with technician_id, kind, source_type and source_id. Pure.
 * techRewardsOwnedSql(alias): the same test as SQL text for payroll_pay_lines, a boolean that is never null (so NOT is safe
 * on a row with no source). It holds no value from a request: constants and column names only.
 */
function techRewardsOwnKey(line) {
  const form = line.source_type === TECH_REWARDS_SOURCE ? TECH_REWARDS_KEYS[line.kind] : null;
  if (!form) return null;
  const key = String(line.source_id || '').slice(-form.length);
  if (!new RegExp(form.pattern).test(key)) return null;
  return line.source_id === techRewardsSourceId(line.kind, line.technician_id, key) ? { kind: line.kind, key } : null;
}

function techRewardsOwnedSql(alias = null) {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const ofKind = ([kind, { length, pattern }]) => `(${col('kind')} = '${kind}' AND right(${col('source_id')}, ${length}) ~ '${pattern}'`
    + ` AND ${col('source_id')} = ${col('kind')} || ':' || ${col('technician_id')}::text || ':' || right(${col('source_id')}, ${length}))`;
  return `(${col('source_type')} IS NOT NULL AND ${col('source_type')} = '${TECH_REWARDS_SOURCE}'`
    + ` AND (${Object.entries(TECH_REWARDS_KEYS).map(ofKind).join(' OR ')}))`;
}
const STATUSES = ['open', 'paid', 'voided'];
const KIND_WORDS = {
  review_bonus: 'Review bonus',
  commission: 'Commission',
  health_allowance: 'Health allowance',
  hsa_employer: 'HSA from Waves',
  season_bonus: 'Season bonus',
  stay_bonus: 'Stay bonus',
  december_gift: 'December gift',
};
const MAX_NOTE = 500;
const MAX_AMOUNT_CENTS = 10000000;
const MAX_SPAN_DAYS = 366;
const MAX_LISTED = 500;

// GATE_PAYROLL_PAY_LINES, read at call time. The typeof guard keeps a test mock of
// feature-gates that lacks the reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

const requireUuid = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw new PayrollError(404, `${what} not found.`);
  return String(id);
};
const actorOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;

// A dollar amount typed by an admin -> whole cents. Cents arrive as a whole number.
const amountSchema = Joi.number().integer().min(1).max(MAX_AMOUNT_CENTS).required()
  .messages({
    'any.required': 'Enter the amount',
    'number.base': 'Amount must be a whole number of cents',
    'number.integer': 'Amount must be a whole number of cents',
    'number.min': 'Amount must be more than $0.00',
    'number.max': `Amount must be at most $${MAX_AMOUNT_CENTS / 100}`,
  });
const dateField = (label) => Joi.string().trim().custom((value, helpers) => (
  validCalendarDate(value) ? value : helpers.message(`${label} must be a real date (YYYY-MM-DD)`)
));

const createSchema = Joi.object({
  kind: Joi.string().valid(...KINDS).required()
    .messages({ 'any.only': 'Pick a kind of pay line', 'any.required': 'Pick a kind of pay line', 'string.base': 'Pick a kind of pay line' }),
  technicianId: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a technician', 'string.empty': 'Pick a technician', 'string.base': 'Pick a technician' }),
  amountCents: amountSchema,
  earnedWeekStart: dateField('Week').required()
    .messages({ 'any.required': 'Pick a week', 'string.empty': 'Pick a week', 'string.base': 'Pick a week' }),
  coversFrom: dateField('Covers from').optional().allow('', null),
  coversTo: dateField('Covers to').optional().allow('', null),
  note: Joi.string().trim().max(MAX_NOTE).allow('', null).default(null)
    .messages({ 'string.max': `Note must be at most ${MAX_NOTE} characters`, 'string.base': 'Note must be text' }),
});

const listSchema = Joi.object({
  technicianId: Joi.string().trim().allow('', null).optional(),
  status: Joi.string().valid(...STATUSES).allow('', null).optional()
    .messages({ 'any.only': 'Status must be open, paid or voided' }),
});

// ---- Reading

const lineColumns = (conn) => [
  'l.id', 'l.technician_id', 'l.kind', 'l.amount_cents', 'l.note', 'l.status', 'l.check_id', 'l.created_at', 't.name',
  conn.raw("to_char(l.earned_week_start, 'YYYY-MM-DD') as earned_week_start"),
  conn.raw("to_char(l.covers_from, 'YYYY-MM-DD') as covers_from"),
  conn.raw("to_char(l.covers_to, 'YYYY-MM-DD') as covers_to"),
];

function serializeLine(row) {
  return {
    id: row.id,
    technicianId: row.technician_id,
    name: row.name,
    kind: row.kind,
    kindWord: KIND_WORDS[row.kind] || row.kind,
    amountCents: Number(row.amount_cents),
    earnedWeekStart: row.earned_week_start,
    coversFrom: row.covers_from || null,
    coversTo: row.covers_to || null,
    note: row.note || null,
    status: row.status,
    checkId: row.check_id || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function listPayLines(query, conn = db) {
  const v = validate(listSchema, query);
  const q = conn('payroll_pay_lines as l')
    .join('technicians as t', 't.id', 'l.technician_id')
    .orderBy([{ column: 'l.earned_week_start', order: 'desc' }, { column: 'l.created_at', order: 'desc' }, { column: 'l.id' }])
    .limit(MAX_LISTED);
  if (v.technicianId) q.where('l.technician_id', requireUuid(v.technicianId, 'Technician'));
  if (v.status) q.where('l.status', v.status);
  return (await q.select(lineColumns(conn))).map(serializeLine);
}

/**
 * The employees a line can be for: every W-2 technician, one who has left too (a
 * commission paid after the last day). The payroll settings list holds current
 * employees only, so the add form reads this one. Current employees first, then by name.
 */
async function listPayLineTechnicians(conn = db) {
  const rows = await conn('technicians')
    .where({ employment_type: 'w2' })
    .orderByRaw("CASE WHEN employment_status = 'inactive' THEN 1 ELSE 0 END")
    .orderBy([{ column: 'name' }, { column: 'id' }])
    .select('id', 'name', 'employment_status');
  return rows.map((row) => ({ id: row.id, name: row.name, employmentStatus: row.employment_status }));
}

// ---- Writing

function checkSpan(v) {
  const hasFrom = v.coversFrom != null && v.coversFrom !== '';
  const hasTo = v.coversTo != null && v.coversTo !== '';
  if (hasFrom !== hasTo) throw new PayrollError(400, 'Give both dates the pay covers, or neither');
  if (!hasFrom) return { coversFrom: null, coversTo: null };
  if (v.coversFrom > v.coversTo) throw new PayrollError(400, 'The first covered date cannot be after the last');
  if (addStaffWorkDays(v.coversFrom, MAX_SPAN_DAYS) < v.coversTo) {
    throw new PayrollError(400, `The pay can cover at most ${MAX_SPAN_DAYS} days`);
  }
  if (v.earnedWeekStart < staffWeekStartForWorkDate(v.coversTo)) {
    throw new PayrollError(400, 'Pick the week that holds the last covered date, or a later week');
  }
  return { coversFrom: v.coversFrom, coversTo: v.coversTo };
}

async function createPayLine(input, actor, conn = db) {
  const v = validate(createSchema, input);
  requireUuid(v.technicianId, 'Technician');
  if (staffWeekStartForWorkDate(v.earnedWeekStart) !== v.earnedWeekStart) throw new PayrollError(400, 'The week must start on a Monday');
  const today = etDateString();
  if (v.earnedWeekStart < '2020-01-01' || v.earnedWeekStart > addStaffWorkDays(today, 400)) {
    throw new PayrollError(400, 'Week must be 2020 or later and within the next 400 days');
  }
  const span = checkSpan(v);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    const tech = await trx('technicians').where({ id: v.technicianId }).forUpdate().first('id', 'employment_type');
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (tech.employment_type !== 'w2') throw new PayrollError(409, 'Pay lines are for W-2 employees.');
    const [inserted] = await trx('payroll_pay_lines').insert({
      technician_id: v.technicianId,
      kind: v.kind,
      amount_cents: v.amountCents,
      earned_week_start: v.earnedWeekStart,
      covers_from: span.coversFrom,
      covers_to: span.coversTo,
      note: v.note || null,
      created_by: actorId,
    }).returning('id');
    const id = inserted && inserted.id ? inserted.id : inserted;
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.pay_line_created', resource_type: 'payroll_pay_lines', resource_id: id,
      metadata: { pay_line_id: id, technician_id: v.technicianId, kind: v.kind },
    });
    const row = await trx('payroll_pay_lines as l').join('technicians as t', 't.id', 'l.technician_id').where('l.id', id).first(lineColumns(trx));
    return serializeLine(row);
  });
}

async function deletePayLine(id, actor, conn = db) {
  requireUuid(id, 'Pay line');
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    const line = await trx('payroll_pay_lines').where({ id }).forUpdate().first('id', 'status', 'kind', 'technician_id');
    if (!line) throw new PayrollError(404, 'Pay line not found.');
    if (TECH_REWARD_KINDS.includes(line.kind)) {
      throw new PayrollError(409, 'The pay run works this line out by itself. It cannot be removed here.');
    }
    if (line.status !== 'open') throw new PayrollError(409, 'Only a pay line that is not paid yet can be removed. Void its pay run first.');
    await trx('payroll_pay_lines').where({ id }).del();
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.pay_line_deleted', resource_type: 'payroll_pay_lines', resource_id: id,
      metadata: { pay_line_id: id, technician_id: line.technician_id, kind: line.kind },
    });
  });
  return { deleted: true };
}

// ---- Pay run helpers (payroll-runs.js)

/**
 * The open lines a pay run for the week ending `end` pays: W-2 technicians only,
 * earned in or before that week. Map of technician id -> { tech, lines }, where
 * tech carries what a lines-only check needs. With lock, the line rows are locked
 * FOR UPDATE, so a delete waits for the finalize (and then sees a paid line).
 */
async function openLinesFor(conn, end, { lock = false } = {}) {
  const query = conn('payroll_pay_lines as l')
    .join('technicians as t', 't.id', 'l.technician_id')
    .where('l.status', 'open')
    .where('l.earned_week_start', '<=', end)
    // A line the Tech Rewards sync owns (techRewardsOwnedSql: its whole source key) is paid by the run of its own earned week
    // only (the run that wrote it): a later run never picks up one that belongs to an earlier week
    // (tech-rewards-pay-lines.js). Every other line carries forward as before, whatever its kind: one with no source, and
    // also a hand-made row that carries the Tech Rewards source type with a source id that is not the sync's.
    .where(function ownWeekOnly() {
      this.whereRaw(`NOT ${techRewardsOwnedSql('l')}`).orWhere('l.earned_week_start', addStaffWorkDays(end, -6));
    })
    .where('t.employment_type', 'w2')
    .orderBy([{ column: 'l.earned_week_start' }, { column: 'l.created_at' }, { column: 'l.id' }]);
  if (lock) query.forUpdate('l');
  const rows = await query.select(
    'l.id', 'l.technician_id', 'l.kind', 'l.amount_cents',
    't.name', 't.pay_rate', 't.pay_method', 't.flsa_overtime_covered',
    conn.raw("to_char(l.earned_week_start, 'YYYY-MM-DD') as earned_week_start"),
    conn.raw("to_char(l.covers_from, 'YYYY-MM-DD') as covers_from"),
    conn.raw("to_char(l.covers_to, 'YYYY-MM-DD') as covers_to"),
  );
  const byTech = new Map();
  for (const row of rows) {
    const entry = byTech.get(row.technician_id) || {
      tech: {
        technician_id: row.technician_id, name: row.name, pay_rate: row.pay_rate, pay_method: row.pay_method,
        flsa_overtime_covered: row.flsa_overtime_covered,
      },
      lines: [],
    };
    entry.lines.push({
      id: row.id,
      kind: row.kind,
      amountCents: Number(row.amount_cents),
      earnedWeekStart: row.earned_week_start,
      coversFrom: row.covers_from || null,
      coversTo: row.covers_to || null,
    });
    byTech.set(row.technician_id, entry);
  }
  return byTech;
}

const lineSpan = (line) => (line.coversFrom ? { coversFrom: line.coversFrom, coversTo: line.coversTo } : { weekStart: line.earnedWeekStart });

/**
 * What finalized checks already paid toward the weeks in `weeks` (Mondays), for the technicians in `ids`. Map of technician
 * id -> { lines, premiums }, the two inputs lineOvertimePremium takes as earlierLines and earlierPremiums:
 * - lines: every PAID pay line whose weeks can touch them. A paid line is on a finalized check; a voided run opens its
 *   lines again, so they are not here.
 * - premiums: the week rows those technicians' finalized checks stored for these weeks (calc_snapshot.lineOvertimeWeeks,
 *   written with every line premium since pay lines began, #6988). A check pays only for its own week or an earlier one, so
 *   checks of an earlier pay week than the first week asked are not read, and neither is a check with no line premium.
 * Two reads for the whole run, whatever the number of technicians. Finalize and void change both tables under the payroll
 * lock, the same lock every pay run evaluation holds, so neither read can see half of a finalize.
 */
async function earlierLinePay(conn, ids, weeks) {
  const byTech = new Map(ids.map((id) => [id, { lines: [], premiums: [] }]));
  if (!ids.length || !weeks.length) return byTech;
  const sorted = [...weeks].sort();
  const first = sorted[0];
  const last = addStaffWorkDays(sorted[sorted.length - 1], 6);
  const wanted = new Set(sorted);
  const paid = await conn('payroll_pay_lines')
    .whereIn('technician_id', ids)
    .where({ status: 'paid' })
    .whereRaw('COALESCE(covers_to, earned_week_start + 6) >= ?::date', [first])
    .whereRaw('COALESCE(covers_from, earned_week_start) <= ?::date', [last])
    .select(
      'technician_id', 'amount_cents',
      conn.raw("to_char(earned_week_start, 'YYYY-MM-DD') as earned_week_start"),
      conn.raw("to_char(covers_from, 'YYYY-MM-DD') as covers_from"),
      conn.raw("to_char(covers_to, 'YYYY-MM-DD') as covers_to"),
    );
  for (const row of paid) {
    byTech.get(row.technician_id).lines.push({
      amountCents: Number(row.amount_cents),
      ...lineSpan({ coversFrom: row.covers_from || null, coversTo: row.covers_to || null, earnedWeekStart: row.earned_week_start }),
    });
  }
  const checks = await conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .whereIn('c.technician_id', ids)
    .where({ 'c.status': 'finalized', 'r.status': 'finalized' })
    .where('c.week_start', '>=', first)
    .where('c.line_overtime_premium_cents', '>', 0)
    .select('c.technician_id', conn.raw("COALESCE(c.calc_snapshot->'lineOvertimeWeeks', '[]'::jsonb) as weeks"));
  for (const check of checks) {
    for (const week of Array.isArray(check.weeks) ? check.weeks : []) {
      const cents = Number(week && week.premiumCents);
      if (week && wanted.has(week.weekStart) && Number.isSafeInteger(cents) && cents > 0) {
        byTech.get(check.technician_id).premiums.push({ weekStart: week.weekStart, premiumCents: cents });
      }
    }
  }
  return byTech;
}

/**
 * lineOvertimePremium for the lines of ONE check (same input, plus `kind` on each of `lines`), with one more figure on the
 * row of every week a Tech Rewards line of the check covers: ordinaryPremiumCents, what the check would have paid for that
 * week WITHOUT its Tech Rewards lines (its other lines priced by the same rule, from the same hours and the same earlier
 * checks). A bonus never feeds a bonus, so a bonus base counts only that part of the week's premium
 * (tech-rewards-scoreboard.js ordinaryPremium). It is stored with the check here, when the check is priced, because it
 * cannot be worked out again later: what earlier checks had paid for a week when this check was priced is not readable
 * from the rows of another day (a check with an earlier pay date can be finalized later, across a tax year, and a voided
 * run's lines are no history). Never over the week's premium. A check with no Tech Rewards line is unchanged. Pure.
 */
function priceCheckLines(pricing) {
  const priced = lineOvertimePremium(pricing);
  const isReward = (line) => TECH_REWARD_KINDS.includes(line.kind);
  const rewardWeeks = new Set(pricing.lines.filter(isReward).flatMap((line) => weeksOfLine(line)));
  if (!rewardWeeks.size) return priced;
  const without = new Map(lineOvertimePremium({ ...pricing, lines: pricing.lines.filter((line) => !isReward(line)) }).weeks
    .map((week) => [week.weekStart, week.premiumCents]));
  return {
    ...priced,
    weeks: priced.weeks.map((week) => (rewardWeeks.has(week.weekStart)
      ? { ...week, ordinaryPremiumCents: Math.min(week.premiumCents, without.get(week.weekStart) || 0) }
      : week)),
  };
}

/**
 * The extra overtime the lines cause, for every technician in `byTech` (the map
 * openLinesFor returns). Each line's weeks are read from the APPROVED weekly
 * timesheets; a week with none counts as no hours worked. Returns a Map of
 * technician id -> { extraPremiumCents, weeks } (payroll-regular-rate.js), plus
 * coveredWeeks: every week the lines cover, and missingWeeks: the covered weeks with
 * no approved timesheet, oldest first. The pay run makes the technician wait when a
 * missing week holds worked time, so a line is never paid without that week's
 * overtime, and holds the check when a covered week has an unreviewed automatic
 * clock-out (GATE_SHIFT_CLOSE_REVIEW).
 * A week that finalized checks already paid line pay for is priced with what they paid (earlierLinePay): this check never
 * pays less than its own lines earn rounded up, and it makes up any shortfall of the week (payroll-regular-rate.js says
 * why). A caller that reads only the weeks, never the premium, passes history: false and skips those two reads.
 * A check with a Tech Rewards line also gets the ordinary part of each week that line covers (priceCheckLines); the pay run
 * stores the week rows with the check (calc_snapshot.lineOvertimeWeeks).
 */
async function priceLines(conn, byTech, { lock = false, history = true } = {}) {
  const priced = new Map();
  if (!byTech.size) return priced;
  const spansByTech = new Map();
  const weekSet = new Set();
  for (const [technicianId, { lines }] of byTech) {
    const priceable = lines.map((line) => ({ kind: line.kind, amountCents: line.amountCents, ...lineSpan(line) }));
    for (const line of priceable) for (const week of weeksOfLine(line)) weekSet.add(week);
    spansByTech.set(technicianId, priceable);
  }
  const query = conn('time_weekly_summary')
    .whereIn('technician_id', [...byTech.keys()])
    .whereIn('week_start', [...weekSet])
    .where('status', 'approved')
    .select('technician_id', 'regular_minutes', 'overtime_minutes', conn.raw("to_char(week_start, 'YYYY-MM-DD') as week_start"));
  if (lock) query.forUpdate();
  const summaries = await query;
  const earlier = history ? await earlierLinePay(conn, [...byTech.keys()], [...weekSet]) : new Map();
  for (const [technicianId, lines] of spansByTech) {
    const rows = summaries.filter((row) => row.technician_id === technicianId);
    const weeks = rows.map((row) => ({ weekStart: row.week_start, regularMinutes: row.regular_minutes, overtimeMinutes: row.overtime_minutes }));
    const approvedWeeks = new Set(rows.map((row) => row.week_start));
    const covered = [...new Set(lines.flatMap((line) => weeksOfLine(line)))].sort();
    priced.set(technicianId, {
      ...priceCheckLines({
        weeks, lines, earlierLines: earlier.get(technicianId)?.lines, earlierPremiums: earlier.get(technicianId)?.premiums,
      }),
      coveredWeeks: covered,
      missingWeeks: covered.filter((week) => !approvedWeeks.has(week)),
    });
  }
  return priced;
}

/**
 * Finalize: marks the lines each check paid as 'paid' with that check. `byTech` is the
 * map openLinesFor returned for the evaluation the run was finalized from (its rows
 * are locked). A line that is no longer open means the lines moved: refuse. The review
 * bonus payouts behind the lines it paid become 'paid' too (payroll-review-bonuses.js);
 * that part is not behind any gate.
 */
async function markLinesPaid(trx, runId, byTech, actorId = null) {
  if (!byTech || !byTech.size) return;
  const checks = await trx('payroll_checks').where({ run_id: runId }).select('id', 'technician_id');
  for (const check of checks) {
    const held = byTech.get(check.technician_id);
    if (!held) continue;
    const ids = held.lines.map((line) => line.id);
    const changed = await trx('payroll_pay_lines').whereIn('id', ids).where({ status: 'open' })
      .update({ status: 'paid', check_id: check.id, updated_at: trx.fn.now() });
    if (changed !== ids.length) throw new PayrollError(409, 'A pay line changed while the run was finalized. Review the new numbers.');
  }
  await markPayoutsPaid(trx, runId, actorId);
}

/** Void: every line a check of this run paid goes back to open, and its review bonus payout back to earned. */
async function reopenLinesOfRun(trx, runId) {
  await reopenPayoutsOfRun(trx, runId);
  await trx('payroll_pay_lines')
    .whereIn('check_id', trx('payroll_checks').where({ run_id: runId }).select('id'))
    .update({ status: 'open', check_id: null, updated_at: trx.fn.now() });
}

// technicians.flsa_overtime_covered: true = federal overtime law covers this employee (W-2
// box 12 code TT is filled), false = it does not, null = not set yet.
const coverageSchema = Joi.object({
  covered: Joi.boolean().allow(null).required()
    .messages({ 'any.required': 'Say whether federal overtime law covers this employee, or clear it', 'boolean.base': 'Covered must be yes, no or cleared' }),
});

async function setFlsaCoverage(technicianId, input, actor, conn = db) {
  requireUuid(technicianId, 'Technician');
  const v = validate(coverageSchema, input);
  const actorId = actorOf(actor);
  return conn.transaction(async (trx) => {
    const tech = await trx('technicians').where({ id: technicianId }).forUpdate().first('id', 'employment_type');
    if (!tech) throw new PayrollError(404, 'Technician not found.');
    if (tech.employment_type !== 'w2') throw new PayrollError(409, 'Overtime coverage is for W-2 employees.');
    await trx('technicians').where({ id: technicianId }).update({ flsa_overtime_covered: v.covered, updated_at: trx.fn.now() });
    await recordAuditEvent({
      trx, critical: true, actor_type: 'admin', actor_id: actorId,
      action: 'payroll.flsa_coverage_changed', resource_type: 'technicians', resource_id: technicianId,
      metadata: { technician_id: technicianId },
    });
    const row = await trx('technicians').where({ id: technicianId }).first('id', 'flsa_overtime_covered');
    return { id: row.id, flsaOvertimeCovered: row.flsa_overtime_covered };
  });
}

/** The check figures for a technician's lines: cents by kind. */
function totalsOf(lines) {
  const sum = (kind) => lines.filter((line) => line.kind === kind).reduce((total, line) => total + line.amountCents, 0);
  return {
    reviewBonusCents: sum('review_bonus'),
    commissionCents: sum('commission'),
    healthAllowanceCents: sum('health_allowance'),
    hsaEmployerCents: sum('hsa_employer'),
    // Only a check that holds such a line carries the key, so any other check is exactly what it was.
    ...(lines.some((line) => TECH_REWARD_KINDS.includes(line.kind))
      ? { techRewardsCents: TECH_REWARD_KINDS.reduce((total, kind) => total + sum(kind), 0) }
      : {}),
  };
}

module.exports = {
  KINDS,
  TECH_REWARD_KINDS,
  TECH_REWARDS_SOURCE,
  TECH_REWARDS_SYNC_KINDS,
  techRewardsSourceId,
  techRewardsOwnKey,
  techRewardsOwnedSql,
  KIND_WORDS,
  payLinesOn,
  priceCheckLines,
  listPayLines,
  listPayLineTechnicians,
  createPayLine,
  deletePayLine,
  setFlsaCoverage,
  openLinesFor,
  priceLines,
  totalsOf,
  markLinesPaid,
  reopenLinesOfRun,
};
