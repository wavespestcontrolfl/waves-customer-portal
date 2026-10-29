#!/usr/bin/env node
// MUTATES (dry-run default: only `--execute --plan <id>` or `--rollback <file>` writes, through second-tech-handover-execute.js)
//
// second-tech-handover.js — plans the ONE-TIME handover of service lines to the
// new technician (second-tech plan, build 6; owner 2026-10-25: "move every pest,
// rodent and mosquito series to the new tech the weekend before the first solo
// week ... skip lawn, the termite-bait customers and any old grouped visits").
//
// WITHOUT `--execute` THIS SCRIPT ONLY PLANS. This file has no write path: every
// query here is a SELECT inside a read-only transaction on a read-only session. The
// dry run prints a PLAN ID. `--execute --plan <id>` hands the same flags to
// second-tech-handover-execute.js, which recomputes the plan inside its write
// transaction and writes only when the PLAN ID is identical (header there).
//
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node ops/agents/second-tech-handover.js \
//     --from <technician uuid> [--to <technician uuid>] [--start YYYY-MM-DD] \
//     [--lines general,rodent,mosquito] [--list] [--json]
//   node ops/agents/second-tech-handover.js --list-techs     # id, role, work days only
//   ... --to <hire> --start <day> --lines <...> --execute --plan <PLAN ID from the dry run>
//   ... --rollback <file the execute wrote> [--out-dir <dir>]
//
//   --from   the owner's technician row (required).
//   --to     the hire's row. Optional: the row may not exist yet. Without it the
//            plan says "target: not set" and assumes Mon-Thu (1,2,3,4).
//   --start  first solo day (default: next Monday, Eastern time). Visits dated
//            before it are never touched.
//   --lines  subset of general,rodent,mosquito (default all three). Lawn / tree &
//            shrub and termite / WDO are never movable here.
//   --list   adds the series ids and visit ids that would change. Ids only.
//   --json   machine-readable output (includes planId).
//   --execute  write the plan the dry run printed (needs --to and --plan).
//   --plan   the PLAN ID line of the dry run: sha256 over the sorted (series id, visit id,
//            visit date, from technician) rows the run would change plus --from, --to,
//            --start and --lines. A different id refuses the run, with no writes.
//   --rollback  restore the rows a prior execute changed (the rollback file it wrote).
//   --out-dir  where execute writes its rollback file (default ~/handover-runs).
//
//   PG_CA_FILE  REQUIRED for the public proxy: a pinned copy of the database's own
//            root certificate (Railway's Postgres signs its server certificate with a
//            self-signed root, CN=root-ca, that no public CA vouches for). The chain is
//            verified against it, so an impostor proxy cannot read the password.
//            Fetch it once and keep it outside the repo:
//              railway run --service Postgres -- sh -c 'echo | openssl s_client -starttls postgres
//                -connect "${DATABASE_PUBLIC_URL#*@}" -showcerts' (cut the host:port at the "/"),
//            and save the LAST certificate block as the file. That first fetch is
//            trust-on-first-use, so the login does not rely on it alone: the script
//            allows only SCRAM-SHA-256-PLUS (see scramPlusOnly), which never sends the
//            password and binds the login to this TLS session.
//
// What the plan decides (all from the real columns):
//   NESTED   the outer run gives DATABASE_PUBLIC_URL, the inner run the portal's
//            GATE_* variables, so the template overlay below reads production's gate.
//   SERIES   scheduled_services parent rows: is_recurring, recurring_parent_id IS
//            NULL, ANY status: the parent row is the first visit, and cancelling it
//            does not end the series (2026-10-25: 273 open future visits sat under a
//            cancelled parent). ACTIVE = recurring_ongoing on a parent that is not
//            cancelled, or a LIVE
//            row by the seeder's own test (findActiveRecurringSeries, through
//            customer-lifecycle-guard whereVisitRowLive: open on or after today,
//            rescheduled, or in progress at any date). Activity is not the same
//            as "can move": an in-progress visit keeps its series active but
//            never moves.
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
//   BAIT     a customer with an ACTIVE series that is a termite bait plan, or whose
//            visits carry a termite bait ADD-ON (scheduled_service_addons: how the
//            pest-plus-bait customers are sold). Series: a termite-line series that is a bait or
//            monitoring program: its catalog key (services.service_key by
//            service_id) or key snapshot in TERMITE_BAIT_KEYS, or the label
//            matches /bait|monitor/. Every series of that customer is skipped.
//   OFF DAY  the target's work_days (or Mon-Thu when --to is not set). Owner
//            2026-10-28 (Tech 2 & 3 Roadmap, question 1 = C): the weekend customers stay
//            with the owner for 60 days, then a second handover run moves them. A WEEKEND
//            CUSTOMER = a customer with a visit this run would otherwise move (open, dated
//            >= --start, held by --from, in --lines, not grouped, not bait) on a target day
//            off within OFF_DAY_CUSTOMER_DAYS (13 weeks) of --start: the window the roadmap
//            counted its 80 weekend pest customers over. That customer stays WHOLE with
//            --from: no series of theirs changes template and none of their visits move
//            (skipped as off_day_customer). Any later visit on a target day off also stays
//            with --from (stays_off_day). The second run must move those dates to a
//            target work day as well, which this planner does not do.
//
// Output carries counts, technician ids the operator typed, series ids and visit
// ids only — no customer names, addresses, phones or emails are selected.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'server');
const { serviceLineFor } = require(path.join(root, 'services', 'scheduling', 'line-technician'));
const { normalizeWorkDays, dayOfWeekOfDate } = require(path.join(root, 'services', 'technician-eligibility'));
const {
  etDateString, etWeekStart, addETDays, parseETDateTime, validCalendarDate,
} = require(path.join(root, 'utils', 'datetime-et'));
const { overlayRecurringTemplateOverrides } = require(path.join(root, 'services', 'recurring-template-overrides'));
const { isEnabled } = require(path.join(root, 'config', 'feature-gates'));
const { whereVisitRowLive } = require(path.join(root, 'services', 'customer-lifecycle-guard'));

const MOVABLE_LINES = ['general', 'rodent', 'mosquito'];
const OPEN_STATUSES = ['pending', 'confirmed', 'rescheduled'];
const STOPPED_TRACK_STATES = ['en_route', 'on_property', 'complete', 'cancelled'];
const ASSUMED_WORK_DAYS = [1, 2, 3, 4];
// services.service_key values of the termite bait programs (visit-facts-contract
// termite_bait catalogKeys), plus the combined pest + bait plan, which the catalog files
// under pest_control. The label tests below catch renamed rows.
const TERMITE_BAIT_KEYS = new Set([
  'termite_bait', 'termite_active_annual', 'termite_active_bait_quarterly',
  'termite_monitoring', 'termite_cartridge_replacement', 'termite_installation_setup',
  'pest_termite_bait_quarterly',
]);
const TERMITE_BAIT_LABEL = /bait|monitor/i;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dayOf = (value) => (value == null ? null : String(value).slice(0, 10));
// Owner 2026-10-28, question 1 = C (header, OFF DAY): a target-day-off visit within 13 weeks of --start keeps its customer
// with --from, whole.
const OFF_DAY_CUSTOMER_DAYS = 91;
// Series skip reasons that keep a whole customer: the plan also says how many customers.
const CUSTOMER_SKIPS = new Set(['termite_bait_customer', 'off_day_customer']);

/** First solo day when --start is not given: the next Monday after today, ET. */
function defaultStart(now = new Date()) {
  return etDateString(addETDays(parseETDateTime(`${etWeekStart(now)}T12:00:00`), 7));
}

const USAGE = 'usage: node ops/agents/second-tech-handover.js --from <uuid> [--to <uuid>] [--start YYYY-MM-DD] [--lines general,rodent,mosquito] [--list] [--json]\n'
  + '       node ops/agents/second-tech-handover.js --from <uuid> --to <uuid> [--start ...] [--lines ...] --execute --plan <PLAN ID> [--out-dir <dir>]\n'
  + '       node ops/agents/second-tech-handover.js --rollback <rollback file> [--out-dir <dir>]\n'
  + '       node ops/agents/second-tech-handover.js --list-techs';
const BOOLEAN_FLAGS = { '--list': 'list', '--list-techs': 'listTechs', '--json': 'json', '--execute': 'execute' };
const PLAN_ID = /^[0-9a-f]{64}$/;
const technicianFlag = (name) => (v) => (UUID.test(v)
  ? { [name]: v.toLowerCase() }
  : `--${name} needs a technician uuid, got ${JSON.stringify(v)}`);
// Each value flag: its parsed fields, or the error text.
const VALUE_FLAGS = {
  '--from': technicianFlag('from'),
  '--to': technicianFlag('to'),
  '--start': (v) => (validCalendarDate(v) ? { start: v } : `--start needs a real YYYY-MM-DD calendar date, got ${JSON.stringify(v)}`),
  '--lines': (v) => {
    const lines = [...new Set(v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const ok = lines.length && lines.every((l) => MOVABLE_LINES.includes(l));
    return ok ? { lines } : `--lines takes ${MOVABLE_LINES.join(', ')} only (lawn and termite are never handed over), got ${JSON.stringify(v)}`;
  },
  '--plan': (v) => (PLAN_ID.test(v) ? { plan: v.toLowerCase() } : `--plan needs the 64-character PLAN ID the dry run printed, got ${JSON.stringify(v)}`),
  '--rollback': (v) => ({ rollback: v }),
  '--out-dir': (v) => ({ outDir: v }),
};

// Flag combinations that are refused before any connection: [broken?, message].
const ARG_RULES = [
  [(a) => a.rollback && (a.execute || a.plan), '--rollback stands alone: do not combine it with --execute or --plan'],
  [(a) => !a.listTechs && !a.rollback && !a.from, '--from <technician uuid> is required (use --list-techs to see ids)'],
  [(a) => a.from && a.to && a.from === a.to, '--from and --to are the same technician'],
  [(a) => a.execute && !a.to, '--execute needs --to <the hire\'s technician uuid>'],
  [(a) => a.execute && !a.plan, '--execute needs --plan <PLAN ID>: run the dry run first and pass the id it printed'],
  [(a) => a.plan && !a.execute, '--plan only goes with --execute'],
];

function parseArgs(argv) {
  const args = {
    from: null, to: null, start: null, lines: [...MOVABLE_LINES], list: false, listTechs: false, json: false,
    execute: false, plan: null, rollback: null, outDir: null,
  };
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
  const broken = ARG_RULES.find(([bad]) => bad(args));
  if (broken) fail(broken[1]);
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

const hasBaitKey = (keys) => keys.some((k) => TERMITE_BAIT_KEYS.has(String(k || '')));
// `catalog_key` is services.service_key for the series' service_id: a row linked by
// id may carry no key snapshot and a label without "bait" (e.g. an annual active plan).
// A bait key counts in any line (the combined pest + bait plan reads general).
const isBaitSeries = (p) => hasBaitKey([p.catalog_key, p.service_key_snapshot])
  || (p.line === 'termite' && TERMITE_BAIT_LABEL.test(String(p.service_type || '')));
// Bait sold as an ADD-ON on a pest series' visits (scheduled_service_addons): a bait key,
// or a label naming termite AND bait/monitoring (a rodent bait station is not termite).
const isTermiteBaitAddon = (a) => hasBaitKey([a.catalog_key, a.service_key_snapshot])
  || (/termite/i.test(String(a.service_name || '')) && TERMITE_BAIT_LABEL.test(String(a.service_name || '')));

const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };

/** Customers whose every series stays with the owner: an active bait plan, or a bait add-on on an active series. */
function baitCustomerIds(active, baitAddonSeriesIds) {
  const addon = new Set(baitAddonSeriesIds);
  return new Set(active.filter((p) => isBaitSeries(p) || addon.has(p.id)).map((p) => p.customer_id));
}

/** The weekdays the target works, and where that came from (no --to = the ruled Mon-Thu). */
function targetWorkDays(to) {
  if (!to) return { workDays: ASSUMED_WORK_DAYS, workDaysSource: 'assumed_mon_thu' };
  const days = normalizeWorkDays(to.work_days);
  return days
    ? { workDays: days, workDaysSource: 'technician_row' }
    : { workDays: [0, 1, 2, 3, 4, 5, 6], workDaysSource: 'technician_row_every_day' };
}

/**
 * The PLAN ID: sha256 over the sorted rows a run would change, plus the flags that
 * shaped it. One row per series whose template moves (series id, no visit) and one per
 * visit that moves (series id, visit id, visit date, from technician). Same plan, same
 * id; a different visit, date, target, start or line set gives a different one.
 */
function planIdOf({ from, to, start, lines, retemplate, moves }) {
  const rows = [
    ...retemplate.map((seriesId) => [seriesId, '', '', from]),
    ...moves.map((m) => [m.series_id, m.visit_id, m.date, from]),
  ].map((r) => JSON.stringify(r)).sort();
  const body = JSON.stringify({ v: 1, from, to: to || null, start, lines: [...lines].sort(), rows });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Build the plan. Pure: no database, no clock beyond `today`.
 *   from      technician id the lines move away from
 *   to        { id, work_days } | null   (null = target not set)
 *   start     YYYY-MM-DD, first solo day
 *   today     YYYY-MM-DD (ET)
 *   liveSeriesIds  series ids with a LIVE row (the reader's whereVisitRowLive query)
 *   baitAddonSeriesIds  series ids with a termite bait add-on on a visit (the reader's add-on query)
 *   lines     lines to move (subset of MOVABLE_LINES)
 *   parents   [{ id, status, customer_id, line, catalog_key, service_key_snapshot, service_type, technician_id,
 *               recurring_technician_id, recurring_technician_override, recurring_ongoing }]
 *             `line` is serviceLineFor's answer (null when unknown)
 *   visits    [{ id, series_id, scheduled_date, status, track_state, technician_id, visit_id, group_status }]
 *             series_id = the parent's id (a parent row is its own series_id)
 */
function buildPlan({ from, to = null, start, today, lines = MOVABLE_LINES, parents, visits, liveSeriesIds, baitAddonSeriesIds }) {
  const bySeries = new Map();
  for (const v of visits) {
    if (!bySeries.has(v.series_id)) bySeries.set(v.series_id, []);
    bySeries.get(v.series_id).push({ ...v, scheduled_date: dayOf(v.scheduled_date) });
  }
  const live = new Set(liveSeriesIds);
  const isActive = (p) => (p.recurring_ongoing === true && p.status !== 'cancelled') || live.has(p.id);
  const active = parents.filter(isActive);

  const baitCustomers = baitCustomerIds(active, baitAddonSeriesIds);

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
    off_day_policy: 'weekend_customer_stays_whole',
    off_day_customer_until: etDateString(addETDays(parseETDateTime(`${start}T12:00:00`), OFF_DAY_CUSTOMER_DAYS)),
    series: { active: active.length, on_from: 0, in_lines: 0, retemplate: 0, with_visits_to_move: 0 },
    would_change: { series: 0, visits: 0, by_line: {}, by_weekday: {} },
    stays_off_day: { visits: 0, by_weekday: {} },
    skipped: {},
    notices_to_suppress: 0,
    ids: { retemplate: [], series: [], visits: [], moves: [] },
  };
  const bucket = (reason) => plan.skipped[reason] || (plan.skipped[reason] = { series: 0, visits: 0, _ids: new Set(), _customers: new Set() });
  // One visit stays: its series counts once per reason.
  const skip = (reason, seriesId) => {
    const s = bucket(reason);
    if (!s._ids.has(seriesId)) { s._ids.add(seriesId); s.series += 1; }
    s.visits += 1;
  };
  // A whole series stays, with the visits it would have moved.
  const seriesSkip = (reason, p, candidates) => {
    const s = bucket(reason);
    s.series += 1; s._ids.add(p.id); s._customers.add(p.customer_id); s.visits += candidates;
  };
  // Why a series on --from stays whole: the first rule it meets. None = in scope. A customer-level reason also reports
  // how many customers it kept (CUSTOMER_SKIPS).
  const seriesStays = [
    ['no_line', (p) => !p.line],
    ['other_line', (p) => !lines.includes(p.line)],
    ['termite_bait_customer', (p) => baitCustomers.has(p.customer_id)],
  ];
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
  // What happens to one visit of an in-scope series: the first rule it stays for, 'off_day' (it stays with --from on a
  // target day off) or 'move'. The weekend-customer test and the moves read the same answer.
  const visitOutcome = (v) => {
    const stay = visitStays.find(([, test]) => test(v));
    if (stay) return stay[0];
    return workDays.includes(dayOfWeekOfDate(v.scheduled_date)) ? 'move' : 'off_day';
  };
  const inScope = [];

  // Pass 1: each series on --from gets its skip reason, or joins the in-scope list with its visits' outcomes.
  for (const p of active.filter((series) => seriesTechnicianId(series) === from)) {
    plan.series.on_from += 1;
    const members = bySeries.get(p.id) || [];
    // What this series would have moved if it were in scope: open, on/after start, held by --from.
    const candidates = members.filter((v) => isOpenVisit(v) && v.scheduled_date >= start && v.technician_id === from).length;
    const stay = seriesStays.find(([, test]) => test(p));
    if (stay) { seriesSkip(stay[0], p, candidates); continue; }
    inScope.push({ p, candidates, outcomes: members.map((v) => ({ v, outcome: visitOutcome(v) })) });
  }
  const lineSkipped = ['no_line', 'other_line'].reduce((n, reason) => n + (plan.skipped[reason] ? plan.skipped[reason].series : 0), 0);
  plan.series.in_lines = plan.series.on_from - lineSkipped;
  // Weekend customers (owner 2026-10-28, question 1 = C): an off-day visit inside the window, in any in-scope series.
  const weekendCustomers = new Set(inScope
    .filter(({ outcomes }) => outcomes.some(({ v, outcome }) => outcome === 'off_day' && v.scheduled_date < plan.off_day_customer_until))
    .map(({ p }) => p.customer_id));

  // Pass 2: every series of a weekend customer stays; any other series changes template and moves its work-day visits.
  for (const { p, candidates, outcomes } of inScope) {
    if (weekendCustomers.has(p.customer_id)) { seriesSkip('off_day_customer', p, candidates); continue; }
    plan.series.retemplate += 1;
    plan.ids.retemplate.push(p.id);

    let moved = 0;
    for (const { v, outcome } of outcomes) {
      const dow = dayOfWeekOfDate(v.scheduled_date);
      if (outcome === 'off_day') {
        plan.stays_off_day.visits += 1;
        bump(plan.stays_off_day.by_weekday, WEEKDAYS[dow]);
      } else if (outcome !== 'move') {
        skip(outcome, p.id);
      } else {
        moved += 1;
        plan.would_change.visits += 1;
        bump(plan.would_change.by_weekday, WEEKDAYS[dow]);
        const byLine = plan.would_change.by_line[p.line] || (plan.would_change.by_line[p.line] = { series: 0, visits: 0 });
        byLine.visits += 1;
        plan.ids.visits.push(v.id);
        plan.ids.moves.push({ series_id: p.id, visit_id: v.id, date: v.scheduled_date });
      }
    }
    if (moved) {
      plan.series.with_visits_to_move += 1;
      plan.would_change.series += 1;
      plan.would_change.by_line[p.line].series += 1;
      plan.ids.series.push(p.id);
    }
  }
  for (const [reason, s] of Object.entries(plan.skipped)) {
    if (CUSTOMER_SKIPS.has(reason)) s.customers = s._customers.size;
    delete s._ids;
    delete s._customers;
  }
  // One per-visit technician notice would fire for each visit whose technician changes.
  plan.notices_to_suppress = plan.would_change.visits;
  plan.planId = planIdOf({ from, to: to ? to.id : null, start, lines, retemplate: plan.ids.retemplate, moves: plan.ids.moves });
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
    .select('id', 'status', 'customer_id', 'service_id', 'service_key_snapshot', 'service_type', 'technician_id',
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

// The series with a LIVE row: the seeder's activity test (findActiveRecurringSeries).
async function loadLiveSeriesIds(db, parentIds, today) {
  const cols = await db('scheduled_services').columnInfo();
  const live = new Set();
  for (const ids of chunks(parentIds, 1000)) {
    const rows = await db('scheduled_services')
      .where(function inSeries() { this.whereIn('recurring_parent_id', ids).orWhereIn('id', ids); })
      .where('is_recurring', true)
      .where(function liveRow() { whereVisitRowLive(this, today, { trackState: !!cols.track_state }); })
      .select('id', 'recurring_parent_id');
    for (const r of rows) live.add(r.recurring_parent_id || r.id);
  }
  return [...live];
}

// The series with a termite bait ADD-ON on any of their (non-cancelled) visits.
async function loadBaitAddonSeriesIds(db, parentIds) {
  const out = new Set();
  for (const ids of chunks(parentIds, 1000)) {
    const rows = await db('scheduled_service_addons as a')
      .join('scheduled_services as s', 's.id', 'a.scheduled_service_id')
      .leftJoin('services as cat', 'cat.id', 'a.service_id')
      .where(function inSeries() { this.whereIn('s.recurring_parent_id', ids).orWhereIn('s.id', ids); })
      .whereNot('s.status', 'cancelled')
      .select('s.id', 's.recurring_parent_id', 'a.service_key_snapshot', 'a.service_name', 'cat.service_key as catalog_key');
    for (const r of rows) if (isTermiteBaitAddon(r)) out.add(r.recurring_parent_id || r.id);
  }
  return [...out];
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
  const serviceIds = [...new Set(parents.map((p) => p.service_id).filter(Boolean))];
  const catalogKeys = new Map();
  for (const ids of chunks(serviceIds, 1000)) {
    for (const r of await db('services').whereIn('id', ids).select('id', 'service_key')) catalogKeys.set(r.id, r.service_key);
  }
  const cache = new Map();
  for (const p of parents) {
    p.catalog_key = (p.service_id && catalogKeys.get(p.service_id)) || null;
    const key = [p.service_id || '', p.service_key_snapshot || '', p.service_type || ''].join('|');
    if (!cache.has(key)) {
      cache.set(key, (await serviceLineFor(db, {
        serviceId: p.service_id, serviceKey: p.service_key_snapshot, serviceType: p.service_type,
      })).line || null);
    }
    p.line = cache.get(key);
  }
  const parentIds = parents.map((p) => p.id);
  const visits = await loadVisits(db, parentIds, today);
  const liveSeriesIds = await loadLiveSeriesIds(db, parentIds, today);
  const baitAddonSeriesIds = await loadBaitAddonSeriesIds(db, parentIds);
  const plan = buildPlan({
    from, to: toRow ? { id: toRow.id, work_days: toRow.work_days } : null, start, today, lines, parents, visits,
    liveSeriesIds, baitAddonSeriesIds,
  });
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
  out.push('Second-technician handover plan (DRY RUN: nothing was changed)');
  out.push(`  from:    ${plan.from}`);
  out.push(`  target:  ${plan.target}`);
  out.push(`  first solo day: ${plan.start}   (plan read on ${plan.today})`);
  out.push(`  lines:   ${plan.lines.join(', ')}`);
  out.push(`  PLAN ID: ${plan.planId}`);
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
  const weekend = plan.skipped.off_day_customer;
  out.push(`Weekend customers kept whole with the owner until ${plan.off_day_customer_until} (question 1 = C): `
    + `${weekend ? `${weekend.customers} customers, ${weekend.series} series, ${weekend.visits} visits` : 'none'}`);
  out.push(`Later visits on a target day off, kept with the owner (stays_off_day): ${plan.stays_off_day.visits}`);
  out.push(`  by weekday: ${weekdayLine(plan.stays_off_day.by_weekday)}`);
  out.push('  (a second handover run moves these customers and their dates; it is not built here.)');
  out.push('');
  out.push('Skipped, by reason (series / visits):');
  const reasons = ['other_line', 'no_line', 'termite_bait_customer', 'off_day_customer', 'grouped', 'not_open', 'before_start', 'other_technician', 'unassigned_left', 'bad_date'];
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
  out.push('  (--execute sends none of them: it writes through no notifying path, then sends the hire ONE summary card)');
  if (list) {
    out.push('');
    out.push(`Series whose technician template changes (${plan.ids.retemplate.length}):`);
    for (const id of plan.ids.retemplate) out.push(`  ${id}`);
    out.push(`  of which with visits that change now (${plan.ids.series.length}):`);
    for (const id of plan.ids.series) out.push(`    ${id}`);
    out.push(`Visit ids (${plan.ids.visits.length}):`);
    for (const id of plan.ids.visits) out.push(`  ${id}`);
  }
  console.log(out.join('\n'));
}

// ---- main -------------------------------------------------------------------

// TLS for the connection. A local database needs none. The public proxy's chain is
// verified against the pinned root in PG_CA_FILE; the server certificate names the
// database itself, not the proxy host, so the name check is skipped while the chain
// check (rejectUnauthorized) stays on. No pinned root = no connection.
function tlsFor(connectionString, caFile = process.env.PG_CA_FILE) {
  let host = '';
  try { host = new URL(connectionString).hostname; } catch { /* not a URL: treat as remote */ }
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
  if (!caFile) {
    throw new Error('PG_CA_FILE is not set: pin the database root certificate first (see the header of ops/agents/second-tech-handover.js)');
  }
  return { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true, checkServerIdentity: () => undefined };
}

// The connection as discrete fields. pg would apply TLS options from the URL query
// (sslmode=disable, sslmode=no-verify, ...) over the pinned policy, so the URL itself is
// never handed to pg, and a URL that carries any ssl* option is refused outright.
function connectionFields(connectionString) {
  const u = new URL(connectionString);
  const tlsOptions = [...u.searchParams.keys()].filter((k) => /^ssl/i.test(k));
  if (tlsOptions.length) {
    throw new Error(`refusing TLS options in the database URL (${tlsOptions.join(', ')}): TLS comes from PG_CA_FILE only`);
  }
  return {
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

// The login, even if the pinned root were an impostor's: pg answers a server's cleartext
// or MD5 password request by sending the password (or its MD5), and plain SCRAM can be
// relayed to the real server. Allow only SCRAM-SHA-256-PLUS, whose channel binding ties
// the exchange to this TLS session's certificate (production offers it; checked
// 2026-10-25). Patches this process's pg client; applied only for a remote database.
function scramPlusOnly(pg) {
  const proto = pg.Client.prototype;
  if (proto.scramPlusOnly) return;
  const refuse = (what) => function refuseAuth() {
    this.connection.emit('error', new Error(`refusing ${what}: SCRAM-SHA-256-PLUS only`));
  };
  const sasl = proto._handleAuthSASL;
  proto._handleAuthCleartextPassword = refuse('a cleartext password request');
  proto._handleAuthMD5Password = refuse('an MD5 password request');
  proto._handleAuthSASL = function scramPlus(msg) {
    if (!(msg && Array.isArray(msg.mechanisms) && msg.mechanisms.includes('SCRAM-SHA-256-PLUS'))) {
      return refuse('a login without channel binding').call(this);
    }
    return sasl.call(this, msg);
  };
  proto.scramPlusOnly = true;
}

function readOnlyConn(connectionString) {
  const ssl = tlsFor(connectionString);
  if (ssl) scramPlusOnly(require('pg'));
  return require('knex')({
    client: 'pg',
    connection: { ...connectionFields(connectionString), ssl, ...(ssl ? { enableChannelBinding: true } : {}) },
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
  // The only write path lives in its own file, so this one stays a reader.
  if (args.execute || args.rollback) return require('./second-tech-handover-execute').main(args);
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/second-tech-handover.js --from <uuid>');
    process.exit(2);
  }
  let db;
  try {
    db = readOnlyConn(conn);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
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
  MOVABLE_LINES, OPEN_STATUSES, STOPPED_TRACK_STATES, TERMITE_BAIT_KEYS,
  parseArgs, defaultStart, seriesTechnicianId, isOpenVisit, isGroupedVisit, isBaitSeries, isTermiteBaitAddon,
  buildPlan, planIdOf, planHandover, printPlan, readOnlyConn, tlsFor, connectionFields, scramPlusOnly,
};

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
