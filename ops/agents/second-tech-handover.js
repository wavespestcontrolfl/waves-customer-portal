#!/usr/bin/env node
// READ-ONLY
//
// second-tech-handover.js — plans the ONE-TIME handover of service lines to the
// new technician (second-tech plan, build 6; owner 2026-10-25: "move every pest,
// rodent and mosquito series to the new tech the weekend before the first solo
// week ... skip lawn, the termite-bait customers and any old grouped visits").
//
// THIS SCRIPT ONLY PLANS. It has no write path: every query is a SELECT inside a
// read-only transaction on a read-only session. A later PR adds `--execute`
// after the owner has read this output.
//
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node ops/agents/second-tech-handover.js \
//     --from <technician uuid> [--to <technician uuid>] [--start YYYY-MM-DD] \
//     [--lines general,rodent,mosquito] [--list] [--json]
//   node ops/agents/second-tech-handover.js --list-techs     # id, role, work days only
//
//   --from   the owner's technician row (required).
//   --to     the hire's row. Optional: the row may not exist yet. Without it the
//            plan says "target: not set" and assumes Mon-Thu (1,2,3,4).
//   --start  first solo day (default: next Monday, Eastern time). Visits dated
//            before it are never touched.
//   --lines  subset of general,rodent,mosquito (default all three). Lawn / tree &
//            shrub and termite / WDO are never movable here.
//   --list   adds the series ids and visit ids that would change. Ids only.
//   --json   machine-readable output.
//
// What the plan decides (all from the real columns):
//   NESTED   the outer run gives DATABASE_PUBLIC_URL, the inner run the portal's
//            GATE_* variables, so the template overlay below reads production's gate.
//   SERIES   scheduled_services parent rows: is_recurring, recurring_parent_id IS
//            NULL, status <> 'cancelled'. ACTIVE = recurring_ongoing, or at least
//            one open visit (below) on or after today (the app's own test,
//            recurring-appointment-seeder findActiveRecurringSeries).
//   ON FROM  the series technician the app gives NEW children: the template
//            (recurring_technician_id) when recurring_technician_override, else
//            recurring_technician_id, else the parent's technician_id
//            (admin-schedule recurringTemplateTechnicianId).
//   LINE     serviceLineFor() from services/scheduling/line-technician.js on the
//            series' CURRENT service: the parent's service_id / service_key_snapshot
//            / service_type with recurring_template_overrides laid over them (the
//            completed first visit keeps its original service; the schedulers apply
//            the same gated overlay, recurring-template-overrides.js). Bait
//            detection reads the same overlaid fields.
//   VISITS   the parent row (when still ahead) plus its children
//            (recurring_parent_id = parent). OPEN = status pending | confirmed |
//            rescheduled (the app's "not started" set) and track_state not
//            en_route / on_property / complete / cancelled. Completed, cancelled,
//            skipped, no_show, en_route and on_site are never open.
//   MOVES    an open visit dated >= --start whose technician_id is --from. A visit
//            with NO technician stays unassigned (auto-dispatch places it by the
//            service-line map), and a visit held by someone else stays with them.
//   GROUPED  scheduled_services.visit_id points at a service_visits row that is not
//            'dissolved' (visit grouping was removed by #6479; the 2026-10-22
//            migration dissolved every group that could be undone cleanly).
//   BAIT     a customer with an ACTIVE termite-line series that is a bait or
//            monitoring program: services key in TERMITE_BAIT_KEYS, or the label
//            matches /bait|monitor/. Every series of that customer is skipped.
//   OFF DAY  the target's work_days (or Mon-Thu when --to is not set). A visit on a
//            target day off STAYS with --from (owner decision still open: move the
//            date, or keep with the owner; default = keep).
//
// Output carries counts, technician ids the operator typed, series ids and visit
// ids only — no customer names, addresses, phones or emails are selected.
const path = require('path');

const root = path.join(__dirname, '..', '..', 'server');
const { serviceLineFor } = require(path.join(root, 'services', 'scheduling', 'line-technician'));
const { normalizeWorkDays, dayOfWeekOfDate } = require(path.join(root, 'services', 'technician-eligibility'));
const { etDateString, etWeekStart, addETDays, parseETDateTime } = require(path.join(root, 'utils', 'datetime-et'));
const { overlayRecurringTemplateOverrides } = require(path.join(root, 'services', 'recurring-template-overrides'));
const { isEnabled } = require(path.join(root, 'config', 'feature-gates'));

const MOVABLE_LINES = ['general', 'rodent', 'mosquito'];
const OPEN_STATUSES = ['pending', 'confirmed', 'rescheduled'];
const STOPPED_TRACK_STATES = ['en_route', 'on_property', 'complete', 'cancelled'];
const ASSUMED_WORK_DAYS = [1, 2, 3, 4];
// services.service_key values of the termite bait programs (visit-facts-contract
// termite_bait catalogKeys) — the label test below catches renamed rows.
const TERMITE_BAIT_KEYS = new Set([
  'termite_bait', 'termite_active_annual', 'termite_active_bait_quarterly',
  'termite_monitoring', 'termite_cartridge_replacement', 'termite_installation_setup',
]);
const TERMITE_BAIT_LABEL = /bait|monitor/i;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dayOf = (value) => (value == null ? null : String(value).slice(0, 10));

function isRealCalendarDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** First solo day when --start is not given: the next Monday after today, ET. */
function defaultStart(now = new Date()) {
  return etDateString(addETDays(parseETDateTime(`${etWeekStart(now)}T12:00:00`), 7));
}

const USAGE = 'usage: node ops/agents/second-tech-handover.js --from <uuid> [--to <uuid>] [--start YYYY-MM-DD] [--lines general,rodent,mosquito] [--list] [--json]\n'
  + '       node ops/agents/second-tech-handover.js --list-techs';
const BOOLEAN_FLAGS = { '--list': 'list', '--list-techs': 'listTechs', '--json': 'json' };
const technicianFlag = (name) => (v) => (UUID.test(v)
  ? { [name]: v.toLowerCase() }
  : `--${name} needs a technician uuid, got ${JSON.stringify(v)}`);
// Each value flag: its parsed fields, or the error text.
const VALUE_FLAGS = {
  '--from': technicianFlag('from'),
  '--to': technicianFlag('to'),
  '--start': (v) => (isRealCalendarDate(v) ? { start: v } : `--start needs a real YYYY-MM-DD calendar date, got ${JSON.stringify(v)}`),
  '--lines': (v) => {
    const lines = [...new Set(v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const ok = lines.length && lines.every((l) => MOVABLE_LINES.includes(l));
    return ok ? { lines } : `--lines takes ${MOVABLE_LINES.join(', ')} only (lawn and termite are never handed over), got ${JSON.stringify(v)}`;
  },
};

function parseArgs(argv) {
  const args = { from: null, to: null, start: null, lines: [...MOVABLE_LINES], list: false, listTechs: false, json: false };
  const fail = (msg) => { console.error(msg); process.exit(2); };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const k = eq > 0 ? raw.slice(0, eq) : raw;
    if (k === '--help' || k === '-h') { console.log(USAGE); process.exit(0); }
    if (BOOLEAN_FLAGS[k]) { args[BOOLEAN_FLAGS[k]] = true; continue; }
    const parse = VALUE_FLAGS[k];
    if (!parse) fail(`unknown flag ${raw}`);
    const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (v === undefined || v === '' || String(v).startsWith('--')) fail(`${k} needs a value`);
    const out = parse(v);
    if (typeof out === 'string') fail(out);
    Object.assign(args, out);
  }
  if (!args.listTechs && !args.from) fail('--from <technician uuid> is required (use --list-techs to see ids)');
  if (args.from && args.to && args.from === args.to) fail('--from and --to are the same technician');
  return args;
}

// ---- the planner (pure) -----------------------------------------------------

/** The technician the app gives NEW children of this series (admin-schedule recurringTemplateTechnicianId). */
function seriesTechnicianId(parent) {
  if (parent.recurring_technician_override) return parent.recurring_technician_id || null;
  return parent.recurring_technician_id || parent.technician_id || null;
}

/** Open = not started and not finished: status in OPEN_STATUSES and a tracker that is not live or done. */
function isOpenVisit(v) {
  if (!OPEN_STATUSES.includes(String(v.status))) return false;
  return !(v.track_state && STOPPED_TRACK_STATES.includes(String(v.track_state)));
}

/** A visit still tied to a visit group (#6479 removed grouping; old rows may keep visit_id). */
function isGroupedVisit(v) {
  return !!v.visit_id && String(v.group_status || '') !== 'dissolved';
}

const isBaitSeries = (p) => p.line === 'termite'
  && (TERMITE_BAIT_KEYS.has(String(p.service_key_snapshot || '')) || TERMITE_BAIT_LABEL.test(String(p.service_type || '')));

const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };

/** The weekdays the target works, and where that came from (no --to = the ruled Mon-Thu). */
function targetWorkDays(to) {
  if (!to) return { workDays: ASSUMED_WORK_DAYS, workDaysSource: 'assumed_mon_thu' };
  const days = normalizeWorkDays(to.work_days);
  return days
    ? { workDays: days, workDaysSource: 'technician_row' }
    : { workDays: [0, 1, 2, 3, 4, 5, 6], workDaysSource: 'technician_row_every_day' };
}

/**
 * Build the plan. Pure: no database, no clock beyond `today`.
 *   from      technician id the lines move away from
 *   to        { id, work_days } | null   (null = target not set)
 *   start     YYYY-MM-DD, first solo day
 *   today     YYYY-MM-DD (ET)
 *   lines     lines to move (subset of MOVABLE_LINES)
 *   parents   [{ id, customer_id, line, service_key_snapshot, service_type, technician_id,
 *               recurring_technician_id, recurring_technician_override, recurring_ongoing }]
 *             `line` is serviceLineFor's answer (null when unknown)
 *   visits    [{ id, series_id, scheduled_date, status, track_state, technician_id, visit_id, group_status }]
 *             series_id = the parent's id (a parent row is its own series_id)
 */
function buildPlan({ from, to = null, start, today, lines = MOVABLE_LINES, parents, visits }) {
  const bySeries = new Map();
  for (const v of visits) {
    if (!bySeries.has(v.series_id)) bySeries.set(v.series_id, []);
    bySeries.get(v.series_id).push({ ...v, scheduled_date: dayOf(v.scheduled_date) });
  }
  const liveAhead = (v) => isOpenVisit(v) && (v.status === 'rescheduled' || v.scheduled_date >= today);
  const isActive = (p) => p.recurring_ongoing === true || (bySeries.get(p.id) || []).some(liveAhead);
  const active = parents.filter(isActive);

  const baitCustomers = new Set(active.filter(isBaitSeries).map((p) => p.customer_id));

  const { workDays, workDaysSource } = targetWorkDays(to);

  const plan = {
    mode: 'read-only',
    from,
    target: to ? to.id : 'not set',
    start,
    today,
    lines: [...lines],
    target_work_days: workDays.map((d) => WEEKDAYS[d]),
    target_work_days_source: workDaysSource,
    off_day_policy: 'keep_with_owner',
    series: { active: active.length, on_from: 0, in_lines: 0, retemplate: 0, with_visits_to_move: 0 },
    would_change: { series: 0, visits: 0, by_line: {}, by_weekday: {} },
    stays_off_day: { visits: 0, by_weekday: {} },
    skipped: {},
    notices_to_suppress: 0,
    ids: { series: [], visits: [] },
  };
  const bucket = (reason) => plan.skipped[reason] || (plan.skipped[reason] = { series: 0, visits: 0, _ids: new Set() });
  // One visit stays: its series counts once per reason.
  const skip = (reason, seriesId) => {
    const s = bucket(reason);
    if (!s._ids.has(seriesId)) { s._ids.add(seriesId); s.series += 1; }
    s.visits += 1;
  };
  // A whole series stays, with the visits it would have moved.
  const seriesSkip = (reason, seriesId, candidates) => {
    const s = bucket(reason);
    s.series += 1; s._ids.add(seriesId); s.visits += candidates;
  };
  // Why an in-scope visit stays where it is: the first rule it meets. None = it moves
  // (or stays with --from on a target day off).
  const visitStays = [
    ['not_open', (v) => !isOpenVisit(v)],
    ['before_start', (v) => v.scheduled_date < start],
    ['grouped', isGroupedVisit],
    ['unassigned_left', (v) => !v.technician_id],
    ['other_technician', (v) => v.technician_id !== from],
    ['bad_date', (v) => dayOfWeekOfDate(v.scheduled_date) === null],
  ];
  const baitHit = new Set();

  for (const p of active) {
    if (seriesTechnicianId(p) !== from) continue;
    plan.series.on_from += 1;
    const members = bySeries.get(p.id) || [];
    // What this series would have moved if it were in scope: open, on/after start, held by --from.
    const candidates = members.filter((v) => isOpenVisit(v) && v.scheduled_date >= start && v.technician_id === from).length;

    if (!p.line) { seriesSkip('no_line', p.id, candidates); continue; }
    if (!lines.includes(p.line)) { seriesSkip('other_line', p.id, candidates); continue; }
    plan.series.in_lines += 1;
    if (baitCustomers.has(p.customer_id)) {
      seriesSkip('termite_bait_customer', p.id, candidates);
      baitHit.add(p.customer_id);
      continue;
    }
    plan.series.retemplate += 1;

    let moved = 0;
    for (const v of members) {
      const stay = visitStays.find(([, test]) => test(v));
      if (stay) { skip(stay[0], p.id); continue; }
      const dow = dayOfWeekOfDate(v.scheduled_date);
      if (!workDays.includes(dow)) {
        plan.stays_off_day.visits += 1;
        bump(plan.stays_off_day.by_weekday, WEEKDAYS[dow]);
        continue;
      }
      moved += 1;
      plan.would_change.visits += 1;
      bump(plan.would_change.by_weekday, WEEKDAYS[dow]);
      const byLine = plan.would_change.by_line[p.line] || (plan.would_change.by_line[p.line] = { series: 0, visits: 0 });
      byLine.visits += 1;
      plan.ids.visits.push(v.id);
    }
    if (moved) {
      plan.series.with_visits_to_move += 1;
      plan.would_change.series += 1;
      plan.would_change.by_line[p.line].series += 1;
      plan.ids.series.push(p.id);
    }
  }
  if (plan.skipped.termite_bait_customer) plan.skipped.termite_bait_customer.customers = baitHit.size;
  for (const s of Object.values(plan.skipped)) delete s._ids;
  // One per-visit technician notice would fire for each visit whose technician changes.
  plan.notices_to_suppress = plan.would_change.visits;
  plan.series_note = 'retemplate = series whose technician template moves (future visits seed to the target); with_visits_to_move = series with at least one visit that changes now';
  return plan;
}

// ---- the readers (SELECT only) ---------------------------------------------

async function loadTechnician(db, id) {
  const row = await db('technicians').where({ id }).first('id', 'role', 'employment_status', 'field_dispatchable', 'work_days');
  return row || null;
}

const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

// Each series with its CURRENT service template laid over the parent's own fields.
async function loadParents(db) {
  const cols = await db('scheduled_services').columnInfo();
  const rows = await db('scheduled_services')
    .where({ is_recurring: true })
    .whereNull('recurring_parent_id')
    .whereNot('status', 'cancelled')
    .select('id', 'customer_id', 'service_id', 'service_key_snapshot', 'service_type', 'technician_id',
      'recurring_technician_id', 'recurring_technician_override', 'recurring_ongoing',
      ...(cols.recurring_template_overrides ? ['recurring_template_overrides'] : []));
  return rows.map((p) => overlayRecurringTemplateOverrides(p, cols));
}

async function loadVisits(db, parentIds, today) {
  const out = [];
  for (const ids of chunks(parentIds, 1000)) {
    const rows = await db('scheduled_services as ss')
      .leftJoin('service_visits as sv', 'sv.id', 'ss.visit_id')
      .where(function inSeries() { this.whereIn('ss.recurring_parent_id', ids).orWhereIn('ss.id', ids); })
      .where(function aheadOrWaiting() { this.where('ss.scheduled_date', '>=', today).orWhere('ss.status', 'rescheduled'); })
      .select('ss.id', 'ss.recurring_parent_id', db.raw('ss.scheduled_date::text as scheduled_date'), 'ss.status',
        'ss.track_state', 'ss.technician_id', 'ss.visit_id', 'sv.status as group_status');
    for (const r of rows) out.push({ ...r, series_id: r.recurring_parent_id || r.id });
  }
  return out;
}

/** Read everything the planner needs and plan. `db` is a knex handle (or transaction). Reads only. */
async function planHandover(db, { from, to = null, start, today = etDateString(), lines = MOVABLE_LINES }) {
  const fromRow = await loadTechnician(db, from);
  if (!fromRow) throw new Error('--from: no technician row with that id');
  let toRow = null;
  if (to) {
    toRow = await loadTechnician(db, to);
    if (!toRow) throw new Error('--to: no technician row with that id (leave --to off while the hire has no row)');
  }
  const parents = await loadParents(db);
  const cache = new Map();
  for (const p of parents) {
    const key = [p.service_id || '', p.service_key_snapshot || '', p.service_type || ''].join('|');
    if (!cache.has(key)) {
      cache.set(key, (await serviceLineFor(db, {
        serviceId: p.service_id, serviceKey: p.service_key_snapshot, serviceType: p.service_type,
      })).line || null);
    }
    p.line = cache.get(key);
  }
  const visits = await loadVisits(db, parents.map((p) => p.id), today);
  const plan = buildPlan({ from, to: toRow ? { id: toRow.id, work_days: toRow.work_days } : null, start, today, lines, parents, visits });
  // The overlay follows GATE_EDIT_APPT_PRICE_SERVICE_SCOPE, as in the app.
  plan.template_overrides = isEnabled('editApptPriceServiceScope') ? 'applied' : 'not_applied_gate_off';
  return plan;
}

// ---- output -----------------------------------------------------------------

function weekdayLine(map) {
  const parts = WEEKDAY_ORDER.filter((d) => map[WEEKDAYS[d]]).map((d) => `${WEEKDAYS[d]} ${map[WEEKDAYS[d]]}`);
  return parts.length ? parts.join(', ') : 'none';
}

function printPlan(plan, { list }) {
  const out = [];
  out.push('Second-technician handover plan (READ-ONLY: nothing was changed)');
  out.push(`  from:    ${plan.from}`);
  out.push(`  target:  ${plan.target}`);
  out.push(`  first solo day: ${plan.start}   (plan read on ${plan.today})`);
  out.push(`  lines:   ${plan.lines.join(', ')}`);
  const src = {
    assumed_mon_thu: 'ASSUMED Mon-Thu, because --to is not set',
    technician_row: 'from the target technician row',
    technician_row_every_day: 'target row has no work days: every day',
  }[plan.target_work_days_source];
  out.push(`  target work days: ${plan.target_work_days.join(', ')} (${src})`);
  out.push(plan.template_overrides === 'applied'
    ? '  series templates: current service (recurring_template_overrides applied)'
    : '  series templates: NOT applied: GATE_EDIT_APPT_PRICE_SERVICE_SCOPE is not \'true\' here (run nested with the portal\'s variables to match production)');
  out.push('');
  out.push(`Series: ${plan.series.active} active, ${plan.series.on_from} on the owner, ${plan.series.in_lines} in these lines`);
  out.push(`  ${plan.series.retemplate} series would change technician template (future visits seed to the target)`);
  out.push(`  ${plan.would_change.series} series have visits that change now`);
  out.push('');
  out.push(`Visits that would change technician: ${plan.would_change.visits}`);
  for (const [line, c] of Object.entries(plan.would_change.by_line)) out.push(`  ${line}: ${c.series} series, ${c.visits} visits`);
  out.push(`  by weekday: ${weekdayLine(plan.would_change.by_weekday)}`);
  out.push('');
  out.push(`Visits on a target day off, kept with the owner (stays_off_day): ${plan.stays_off_day.visits}`);
  out.push(`  by weekday: ${weekdayLine(plan.stays_off_day.by_weekday)}`);
  out.push('  (owner decision open: keep with the owner, or move the date. This plan keeps them.)');
  out.push('');
  out.push('Skipped, by reason (series / visits):');
  const reasons = ['other_line', 'no_line', 'termite_bait_customer', 'grouped', 'not_open', 'before_start', 'other_technician', 'unassigned_left', 'bad_date'];
  let any = false;
  for (const r of reasons) {
    const s = plan.skipped[r];
    if (!s) continue;
    any = true;
    out.push(`  ${r}: ${s.series} series / ${s.visits} visits${s.customers != null ? ` (${s.customers} customers)` : ''}`);
  }
  if (!any) out.push('  none');
  out.push('');
  out.push(`Per-visit technician notices the execute step must suppress: ${plan.notices_to_suppress}`);
  if (list) {
    out.push('');
    out.push(`Series ids (${plan.ids.series.length}):`);
    for (const id of plan.ids.series) out.push(`  ${id}`);
    out.push(`Visit ids (${plan.ids.visits.length}):`);
    for (const id of plan.ids.visits) out.push(`  ${id}`);
  }
  console.log(out.join('\n'));
}

// ---- main -------------------------------------------------------------------

function readOnlyConn(connectionString) {
  return require('knex')({
    client: 'pg',
    connection: { connectionString, ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false } },
    pool: {
      min: 1,
      max: 1,
      afterCreate: (pgConn, done) => {
        pgConn.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', (err) => done(err, pgConn));
      },
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/second-tech-handover.js --from <uuid>');
    process.exit(2);
  }
  const db = readOnlyConn(conn);
  try {
    await db.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      if (args.listTechs) {
        const rows = await trx('technicians').select('id', 'role', 'employment_status', 'field_dispatchable', 'work_days').orderBy('employment_status');
        for (const r of rows) console.log(`${r.id}  role=${r.role}  ${r.employment_status}  dispatchable=${r.field_dispatchable}  work_days=${JSON.stringify(r.work_days)}`);
        return;
      }
      const today = etDateString();
      const start = args.start || defaultStart();
      const plan = await planHandover(trx, { from: args.from, to: args.to, start, today, lines: args.lines });
      if (args.json) {
        const copy = { ...plan, ids: args.list ? plan.ids : undefined };
        console.log(JSON.stringify(copy, null, 2));
      } else printPlan(plan, { list: args.list });
    });
  } finally {
    await db.destroy();
  }
}

module.exports = {
  MOVABLE_LINES, OPEN_STATUSES, TERMITE_BAIT_KEYS,
  parseArgs, defaultStart, isRealCalendarDate, seriesTechnicianId, isOpenVisit, isGroupedVisit, isBaitSeries,
  buildPlan, planHandover, printPlan, readOnlyConn,
};

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
