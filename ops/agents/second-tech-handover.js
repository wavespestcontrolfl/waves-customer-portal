#!/usr/bin/env node
// MUTATES (dry-run default: only `--execute --plan <id>` or `--rollback <file>` writes, through second-tech-handover-execute.js)
//
// second-tech-handover.js — plans the ONE-TIME handover of service lines to the
// new technician (second-tech plan, build 6; owner 2026-10-25: "move every pest,
// rodent and mosquito series to the new tech the weekend before the first solo
// week ... skip lawn, the termite-bait customers and any old grouped visits").
// Owner 2026-10-30: "termite and WDO follow the territory". Owner 2026-11-21 ("all rec"):
// termite and WDO work goes to the second technician in every ZIP, bait-station customers
// too, so a plain run moves termite as well; see --lines and BAIT.
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
//     [--lines general,rodent,mosquito,termite] [--zips 34293,34285] [--weekend-move] [--list] [--json]
//   node ops/agents/second-tech-handover.js --list-techs     # id, role, work days only
//   ... --to <hire> --start <day> --lines <...> --execute --plan <PLAN ID from the dry run>
//   ... --rollback <file the execute wrote> [--out-dir <dir>]
//
//   --from   the owner's technician row (required).
//   --to     the hire's row. Optional: the row may not exist yet. Without it the
//            plan says "target: not set" and assumes Mon-Thu (1,2,3,4).
//   --start  first solo day (default: next Monday, Eastern time). Visits dated
//            before it are never touched.
//   --lines  subset of general,rodent,mosquito,termite (default all four, with or without
//            --zips; the same four lines as services/territory.js TERRITORY_LINES). Lawn /
//            tree & shrub and rodent exclusion (the `exclusion` line: sealing, sanitation,
//            the rodent inspection, the general rodent visit; owner 2026-11-21 "you seal, he
//            traps") are never movable here. `termite` is termite and WDO series
//            (the catalog category first, then the name, serviceLineFor). Owner 2026-11-21:
//            the default run moves termite too, and termite BAIT customers move with it
//            (see BAIT). A run with --lines general,rodent,mosquito leaves termite out and
//            keeps every bait customer whole with the owner, as the 2026-10-25 run did.
//            One-time visits (a WDO inspection booked once) are not series and stay as
//            booked: new bookings already route by territory.
//            Capability: when --to's technician_capabilities row for a line that has a
//            series to move reads Off (technician-capabilities stateOf), the run is refused
//            (TARGET_CAPABILITY_OFF) before any write, for every line alike.
//   --zips   territories by ZIP (owner 2026-10-30, build 6): only series whose service ZIP
//            (the parent row's service_address_zip, else the customer's zip) is listed move,
//            and --execute also makes --to the territory technician of every listed ZIP
//            (territory_zips.technician_id), in the same transaction, with its own undo in
//            the rollback file. Each ZIP must be a territory_zips row. Without --zips: today's run.
//   --weekend-move  the DAY-60 second run (owner 2026-10-28, question 1 = C): the weekend customers the first run kept
//            with the owner move to --to, and each of their live visits dated >= --start that sits on a --to day off
//            moves to a --to work day on or after --start (±5 days, the flex tier's bound; the time and window stay), with no customer
//            message. Needs --to; --start must be at least 4 days after today (START_TOO_SOON). The rules, the
//            re-anchor of month-based series (so top-up keeps the new weekday) and the "kept whole" reasons are in
//            the header of second-tech-handover-weekend.js. Without it, a weekend customer stays whole as before.
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
//            A VISIT moves by its OWN line (its own service_id / service_key_snapshot /
//            service_type): staff can change one appointment of a series to another
//            service ("this appointment only"). A visit of an in-scope series whose own
//            line is not in --lines (a pest series visit changed to lawn or to rodent
//            exclusion) stays with --from (visit_other_line). A visit whose own line
//            moves under another movable line adds that line to the capability check.
//            An ADD-ON is work of its own line too (scheduled_service_addons, read by
//            its own service): a visit with an add-on of a line not in --lines stays
//            with --from (visit_other_line); a series whose PARENT row has one stays
//            whole (addon_other_line: the scheduler copies the parent row's add-ons
//            onto each new visit); the add-on lines that move join the capability check.
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
//            matches /bait|monitor/. A run that includes termite (the default, owner 2026-11-21)
//            moves these customers like any other: their bait series, their pest series, the
//            combined pest + bait plan, and the pest series whose visits carry a bait add-on
//            (or have one appointment ahead whose own service is bait work);
//            the plan counts them as bait_customers_moving. A bait customer's bait work
//            reaches --to with the series (the combined plan and a bait add-on move under the
//            general line), so a run that moves ANY series of a bait customer needs the termite
//            capability: --to set to Off for termite refuses it (plan.capability_lines), and
//            leaving termite out keeps those customers whole with the owner. A run that
//            leaves termite out (--lines without termite) skips every series of that customer
//            (termite_bait_customer), the 2026-10-25 rule, and counts every bait customer it
//            keeps as bait_customers_kept (a bait-only customer stays as other_line).
//   OFF DAY  the target's work_days (or Mon-Thu when --to is not set). Owner
//            2026-10-28 (Tech 2 & 3 Roadmap, question 1 = C): the weekend customers stay
//            with the owner for 60 days, then a second handover run moves them. A WEEKEND
//            CUSTOMER = a customer with a visit this run would otherwise move (open, dated
//            >= --start, held by --from, in --lines, not grouped, not kept as a bait customer) on a target day
//            off within OFF_DAY_CUSTOMER_DAYS (13 weeks) of --start: the window the roadmap
//            counted its 80 weekend pest customers over. That customer stays WHOLE with
//            --from: no series of theirs changes template and none of their visits move
//            (skipped as off_day_customer). Any later visit on a target day off also stays
//            with --from (stays_off_day). The second run (--weekend-move, ~day 60) plans these
//            customers instead of skipping them: it moves their dates to a target work day (header
//            of second-tech-handover-weekend.js) and re-anchors their month-based series.
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
const { normalizeZip } = require(path.join(root, 'services', 'territory'));
const { stateOf } = require(path.join(root, 'services', 'technician-capabilities'));
const weekendMoves = require('./second-tech-handover-weekend');

// The default for every run, with or without --zips (owner 2026-11-21, "all rec"): the same four lines as services/territory.js TERRITORY_LINES.
const MOVABLE_LINES = ['general', 'rodent', 'mosquito', 'termite'];
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

/** A refusal the planner raises for a flag combination or target it cannot plan; the writer turns it into a Refusal. */
class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

const { changeLabel } = weekendMoves;
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

const USAGE = 'usage: node ops/agents/second-tech-handover.js --from <uuid> [--to <uuid>] [--start YYYY-MM-DD] [--lines general,rodent,mosquito,termite] [--zips 34293,34285] [--weekend-move] [--list] [--json]\n'
  + '       node ops/agents/second-tech-handover.js --from <uuid> --to <uuid> [--start ...] [--lines ...] [--zips ...] --execute --plan <PLAN ID> [--out-dir <dir>]\n'
  + '       node ops/agents/second-tech-handover.js --rollback <rollback file> [--out-dir <dir>]\n'
  + '       node ops/agents/second-tech-handover.js --list-techs';
const BOOLEAN_FLAGS = { '--list': 'list', '--list-techs': 'listTechs', '--json': 'json', '--execute': 'execute', '--weekend-move': 'weekendMove' };
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
    return ok ? { lines } : `--lines takes ${MOVABLE_LINES.join(', ')} only (lawn and rodent exclusion are never handed over), got ${JSON.stringify(v)}`;
  },
  '--zips': (v) => {
    const zips = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))].sort();
    return zips.length && zips.every((z) => /^\d{5}$/.test(z)) ? { zips } : `--zips takes 5-digit ZIPs, comma-separated, got ${JSON.stringify(v)}`;
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
  [(a) => a.weekendMove && !a.to, '--weekend-move needs --to <the hire\'s technician uuid>'],
  [(a) => a.weekendMove && a.rollback, '--rollback stands alone: do not combine it with --weekend-move'],
];

function parseArgs(argv) {
  const args = {
    from: null, to: null, start: null, lines: [...MOVABLE_LINES], zips: null, list: false, listTechs: false, json: false,
    execute: false, weekendMove: false, plan: null, rollback: null, outDir: null,
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

/** Is this series termite bait WORK: a bait plan in any line (the combined pest + bait plan reads general), a bait add-on on its visits, or a visit that is itself bait work (the ids given). */
function baitSeriesTest(baitAddonSeriesIds, visits = []) {
  // One appointment ahead whose OWN service is bait work (a pest series visit changed to the combined pest + bait
  // service) marks its series too. A cancelled one marks nothing.
  const baitVisits = visits.filter((v) => v.status !== 'cancelled' && isBaitSeries(v)).map((v) => v.series_id);
  const marked = new Set([...(baitAddonSeriesIds || []), ...baitVisits]);
  return (p) => isBaitSeries(p) || marked.has(p.id);
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
function planIdOf({ from, to, start, lines, retemplate, moves, zips = null, territory = [], anchors = [], weekendMove = false }) {
  const rows = [
    ...retemplate.map((seriesId) => [seriesId, '', '', from]),
    // A date move names both dates; a technician-only move is the row it always was.
    ...moves.map((m) => [m.series_id, m.visit_id, m.to_date ? `${m.date}>${m.to_date}` : m.date, from]),
    // --weekend-move: each parent anchor stamp (new and old nth / weekday).
    ...anchors.map((a) => [`anchor:${a.series_id}`, `${a.nth}/${a.weekday}`, `${a.old_nth}/${a.old_weekday}`, from]),
    // --zips: each listed ZIP and the territory technician it has now (a change since the dry run changes the id).
    ...territory.map((t) => [`zip:${t.zip}`, '', '', t.technician_id || '']),
  ].map((r) => JSON.stringify(r)).sort();
  // Without --zips the body is the same as before build 6, so a plan's id does not change.
  const body = JSON.stringify({ v: 1, from, to: to || null, start, lines: [...lines].sort(), rows, ...(zips ? { zips: [...zips].sort() } : {}), ...(weekendMove ? { weekend: true } : {}) });
  return crypto.createHash('sha256').update(body).digest('hex');
}

// ---- --weekend-move helpers (pure) ------------------------------------------

/** Why a series of a weekend customer stays with --from, or null (it is planned). Without --weekend-move it is the first run's rule. */
function weekendStayReason({ weekendMove, weekend, customerId, isWeekend }) {
  if (!isWeekend) return null;
  if (!weekendMove) return 'off_day_customer';
  const why = weekend && weekend.kept.get(customerId);
  return why ? `weekend_kept_${why}` : null;
}

/**
 * What one in-scope visit does: 'stay_off' (kept with --from on a day off), 'skip', 'tech' (technician only) or 'date'
 * (new date + technician; its date is null in the first read, before the decisions).
 */
function visitKind({ weekendMove, weekend, v, outcome }) {
  // A visit of a line this run does not move never changes date or technician (the day-60 resolver gives it no date:
  // second-tech-handover-weekend.js stayStillReason).
  if (outcome === 'visit_other_line') return 'skip';
  if (weekend && weekend.newDates.has(v.id)) return 'date';
  if (outcome === 'off_day') return weekendMove && !weekend ? 'date' : 'stay_off';
  return outcome === 'move' ? 'tech' : 'skip';
}

/** The weekend customers a first read found, with their in-scope series. */
function noteCandidate(byCustomer, p, isCandidate) {
  if (!isCandidate) return;
  const entry = byCustomer.get(p.customer_id) || { customer_id: p.customer_id, series_ids: [] };
  entry.series_ids.push(p.id);
  byCustomer.set(p.customer_id, entry);
}

/** The lines of the work one moved row carries: its add-ons', and for a visit its own. */
const workLines = (row, own) => [...(own ? [row.line] : []), ...(row.addon_lines || [])];

/** The dry run's per-line counter: series under their template line, visits under their OWN line. */
const lineCount = (plan, line) => plan.would_change.by_line[line] || (plan.would_change.by_line[line] = { series: 0, visits: 0 });

/** One visit the run changes: counted by weekday and line, listed in the moves (a date move also names the new day). */
function recordMove(plan, p, v, kind, { weekend, dateMoveCustomers }) {
  plan.would_change.visits += 1;
  bump(plan.would_change.by_weekday, WEEKDAYS[dayOfWeekOfDate(v.scheduled_date)]);
  // A visit changed to another service counts under its own line (a row with no line field: its series' line).
  lineCount(plan, v.line || p.line).visits += 1;
  plan.ids.visits.push(v.id);
  const move = { series_id: p.id, visit_id: v.id, date: v.scheduled_date };
  if (kind === 'date') {
    move.to_date = weekend ? weekend.newDates.get(v.id) : null;
    plan.date_changes.visits += 1;
    dateMoveCustomers.add(p.customer_id);
    if (move.to_date) bump(plan.date_changes.by_change, changeLabel(v.scheduled_date, move.to_date));
  }
  plan.ids.moves.push(move);
}

/** The decisions of the second read: the parent anchors to stamp and the customers kept whole (ids and reasons). */
function recordWeekendDecisions(plan, weekend) {
  if (!weekend) return;
  plan.ids.anchors = weekend.anchors.filter((a) => plan.ids.retemplate.includes(a.series_id));
  plan.ids.kept = [...weekend.kept].map(([customerId, reason]) => ({ customer_id: customerId, reason }))
    .sort((a, b) => (a.customer_id < b.customer_id ? -1 : 1));
}

/**
 * Build the plan. Pure: no database, no clock beyond `today`.
 *   from      technician id the lines move away from
 *   to        { id, work_days } | null   (null = target not set)
 *   start     YYYY-MM-DD, first solo day
 *   today     YYYY-MM-DD (ET)
 *   liveSeriesIds  series ids with a LIVE row (the reader's whereVisitRowLive query)
 *   baitAddonSeriesIds  series ids with a termite bait add-on on a visit (the reader's add-on query)
 *   parents and visits may carry `addon_lines`: the lines of their add-ons (the same query; null = unknown service)
 *   lines     lines to move (subset of MOVABLE_LINES)
 *   parents   [{ id, status, customer_id, line, catalog_key, service_key_snapshot, service_type, technician_id,
 *               recurring_technician_id, recurring_technician_override, recurring_ongoing }]
 *             `line` is serviceLineFor's answer (null when unknown)
 *   visits    [{ id, series_id, scheduled_date, status, track_state, technician_id, visit_id, group_status }]
 *             series_id = the parent's id (a parent row is its own series_id)
 */
// --zips: the plan's ZIP fields, and the series rule (a series outside the list stays whole).
const zipFields = (zips, territory) => (zips
  ? { zips: [...zips].sort(), territory: territory.map((t) => ({ zip: t.zip, area: t.area || null, technician_id: t.technician_id || null })) }
  : { zips: null, territory: [] });
const outsideZips = (zips) => (p) => Array.isArray(zips) && !zips.includes(p.zip);

/**
 * The bait figures of a plan (owner 2026-11-21: bait customers move with termite).
 *   bait_customers_moving  bait customers with a series this run hands over (0 when it leaves termite out).
 *   bait_customers_kept    bait customers a run WITHOUT termite keeps, whatever rule their series met first: a customer
 *                          whose only series is the bait plan itself stays as other_line, and is kept all the same.
 *                          A --zips run counts its ZIPs only.
 *   capability_lines       the lines --to must be able to take: each line with a series to move, the own line of
 *                          each visit that moves (a visit changed to another service), and termite when ANY
 *                          series of a bait customer moves. A bait customer's bait work reaches --to with the series,
 *                          now or at a later visit: the combined pest + bait plan and a pest series with a bait add-on
 *                          move as general, and the scheduler decides visit by visit which add-ons are due
 *                          (admin-schedule.js auto-extend copies the parent row's due add-ons). The planner does not
 *                          re-derive that. The customer mark decides, as it does for a run that leaves termite out:
 *                          a hire set to Off for termite takes no bait customer.
 */
function baitFigures({ onFrom, moving, baitCustomers, termiteOut, zips, movingLines }) {
  const baitCustomerCount = (rows) => new Set(rows.filter((p) => baitCustomers.has(p.customer_id)).map((p) => p.customer_id)).size;
  const outside = outsideZips(zips);
  const movingBaitCustomers = baitCustomerCount(moving);
  return {
    bait_customers_moving: movingBaitCustomers,
    bait_customers_kept: termiteOut ? baitCustomerCount(onFrom.filter((p) => !outside(p))) : 0,
    capability_lines: [...new Set([...movingLines, ...(movingBaitCustomers ? ['termite'] : [])])].sort(),
  };
}

function buildPlan({
  from, to = null, start, today, lines = MOVABLE_LINES, parents, visits, liveSeriesIds, baitAddonSeriesIds, zips, territory,
  weekendMove, weekend,
}) {
  const bySeries = new Map();
  for (const v of visits) {
    if (!bySeries.has(v.series_id)) bySeries.set(v.series_id, []);
    bySeries.get(v.series_id).push({ ...v, scheduled_date: dayOf(v.scheduled_date) });
  }
  const live = new Set(liveSeriesIds);
  const isActive = (p) => (p.recurring_ongoing === true && p.status !== 'cancelled') || live.has(p.id);
  const active = parents.filter(isActive);

  // Customers with an active bait plan, a bait add-on on an active series, or one appointment ahead whose OWN service
  // is bait work (a pest series visit changed to the combined pest + bait service). A run that leaves termite out keeps
  // every series of theirs with the owner.
  const carriesBait = baitSeriesTest(baitAddonSeriesIds, visits);
  const baitCustomers = new Set(active.filter(carriesBait).map((p) => p.customer_id));
  const termiteOut = !lines.includes('termite');
  const onFrom = active.filter((series) => seriesTechnicianId(series) === from);

  const { workDays, workDaysSource } = targetWorkDays(to);

  const plan = {
    mode: 'read-only',
    from,
    target: to ? to.id : 'not set',
    start,
    today,
    lines: [...lines],
    ...zipFields(zips, territory),
    target_work_days: workDays.map((d) => WEEKDAYS[d]),
    target_work_days_source: workDaysSource,
    off_day_policy: 'weekend_customer_stays_whole',
    off_day_customer_until: etDateString(addETDays(parseETDateTime(`${start}T12:00:00`), OFF_DAY_CUSTOMER_DAYS)),
    series: { active: active.length, on_from: 0, in_lines: 0, retemplate: 0, with_visits_to_move: 0 },
    retemplate_by_line: {},
    would_change: { series: 0, visits: 0, by_line: {}, by_weekday: {} },
    stays_off_day: { visits: 0, by_weekday: {} },
    weekend_move: weekendMove === true,
    date_changes: { visits: 0, customers: 0, by_change: {} },
    skipped: {},
    notices_to_suppress: 0,
    bait_customers_moving: 0,
    bait_customers_kept: 0,
    capability_lines: [],
    ids: { retemplate: [], series: [], visits: [], moves: [], anchors: [], kept: [] },
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
    // After the line rules, so `in_lines` below still counts every series of these lines.
    ['outside_zips', outsideZips(zips)],
    // Owner 2026-11-21: bait customers move with termite. Only a run that leaves termite out keeps them whole (2026-10-25 rule).
    ['termite_bait_customer', (p) => termiteOut && baitCustomers.has(p.customer_id)],
    // An add-on on the parent row is copied onto each new visit: one of a line this run does not move keeps the
    // series. After the bait rule, so a bait customer is still counted as one.
    ['addon_other_line', (p) => (p.addon_lines || []).some((line) => !lines.includes(line))],
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
    // Last: only a visit that would otherwise move. Its own line, or an add-on's (the reader sets both; null =
    // unknown), is not a line this run moves. A row with no `line` field goes with its series.
    ['visit_other_line', (v) => weekendMoves.carriesOtherLine(v, lines)],
  ];
  // What happens to one visit of an in-scope series: the first rule it stays for, 'off_day' (it stays with --from on a
  // target day off) or 'move'. The weekend-customer test and the moves read the same answer.
  const visitOutcome = (v) => {
    const stay = visitStays.find(([, test]) => test(v));
    if (stay) return stay[0];
    return workDays.includes(dayOfWeekOfDate(v.scheduled_date)) ? 'move' : 'off_day';
  };
  const inScope = [];
  const movedVisitLines = new Set();

  // Pass 1: each series on --from gets its skip reason, or joins the in-scope list with its visits' outcomes.
  for (const p of onFrom) {
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
  // An off-day visit of a line this run does not move counts too (as on main, which read no visit line): the visit
  // stays with --from, but it shows the series' weekday, and its template must not seed that weekday to --to. The
  // day-60 resolver never re-dates it, so that customer stays whole (weekend_kept_visit_other_line).
  const offDay = (v) => !workDays.includes(dayOfWeekOfDate(v.scheduled_date));
  const marksWeekend = ({ v, outcome }) => outcome === 'off_day' || (outcome === 'visit_other_line' && offDay(v));
  const weekendCustomers = new Set(inScope
    .filter(({ outcomes }) => outcomes.some((o) => marksWeekend(o) && (weekendMove || o.v.scheduled_date < plan.off_day_customer_until)))
    .map(({ p }) => p.customer_id));
  // --weekend-move (the day-60 run): weekend customers are planned, not skipped. A first read (no decisions yet) lists them;
  // the decisions then keep some customers whole and give every other change its new date (second-tech-handover-weekend.js).
  const dateMoveCustomers = new Set();
  const candidatesByCustomer = new Map();

  // Pass 2: every series of a weekend customer stays; any other series changes template and moves its work-day visits.
  for (const { p, candidates, outcomes } of inScope) {
    const stayReason = weekendStayReason({ weekendMove, weekend, customerId: p.customer_id, isWeekend: weekendCustomers.has(p.customer_id) });
    if (stayReason) { seriesSkip(stayReason, p, candidates); continue; }
    noteCandidate(candidatesByCustomer, p, weekendMove && weekendCustomers.has(p.customer_id));
    plan.series.retemplate += 1;
    bump(plan.retemplate_by_line, p.line);
    plan.ids.retemplate.push(p.id);
    // The parent row's add-ons seed onto the visits --to gets: their lines are work --to must be able to take.
    workLines(p, false).forEach((line) => movedVisitLines.add(line));

    let moved = 0;
    for (const { v, outcome } of outcomes) {
      const kind = visitKind({ weekendMove, weekend, v, outcome });
      if (kind === 'stay_off') {
        plan.stays_off_day.visits += 1;
        bump(plan.stays_off_day.by_weekday, WEEKDAYS[dayOfWeekOfDate(v.scheduled_date)]);
      } else if (kind === 'skip') {
        skip(outcome, p.id);
      } else {
        moved += 1;
        workLines(v, true).forEach((line) => movedVisitLines.add(line));
        recordMove(plan, p, v, kind, { weekend, dateMoveCustomers });
      }
    }
    if (moved) {
      plan.series.with_visits_to_move += 1;
      plan.would_change.series += 1;
      lineCount(plan, p.line).series += 1;
      plan.ids.series.push(p.id);
    }
  }
  for (const [reason, s] of Object.entries(plan.skipped)) {
    if (CUSTOMER_SKIPS.has(reason) || reason.startsWith('weekend_kept_')) s.customers = s._customers.size;
    delete s._ids;
    delete s._customers;
  }
  const retemplated = new Set(plan.ids.retemplate);
  Object.assign(plan, baitFigures({
    onFrom, moving: onFrom.filter((p) => retemplated.has(p.id)), baitCustomers, termiteOut, zips,
    movingLines: [...Object.keys(plan.retemplate_by_line), ...movedVisitLines].filter(Boolean),
  }));
  // One per-visit technician notice would fire for each visit whose technician changes.
  plan.notices_to_suppress = plan.would_change.visits;
  plan.date_changes.customers = dateMoveCustomers.size;
  plan.weekend_candidates = [...candidatesByCustomer.values()].sort((a, b) => (a.customer_id < b.customer_id ? -1 : 1));
  recordWeekendDecisions(plan, weekend);
  plan.planId = planIdOf({
    from, to: to ? to.id : null, start, lines, retemplate: plan.ids.retemplate, moves: plan.ids.moves, zips: plan.zips, territory: plan.territory,
    anchors: plan.ids.anchors, weekendMove,
  });
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
    // scheduled_date: a month walk with no stored recurring_weekday lands on the parent's own weekday (--weekend-move).
    .select('id', 'status', 'customer_id', 'service_id', 'service_key_snapshot', 'service_type', 'technician_id',
      db.raw('scheduled_date::text as scheduled_date'),
      'recurring_technician_id', 'recurring_technician_override', 'recurring_ongoing',
      ...(cols.service_address_zip ? ['service_address_zip'] : []),
      ...['recurring_pattern', 'recurring_nth', 'recurring_weekday', 'recurring_interval_days', 'skip_weekends', 'weekend_shift']
        .filter((c) => cols[c]),
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
        'ss.track_state', 'ss.technician_id', 'ss.visit_id', 'sv.status as group_status',
        // The visit's OWN service: one appointment of a series can be another service (LINE).
        'ss.service_id', 'ss.service_key_snapshot', 'ss.service_type',
        // --weekend-move: what the day-60 run needs to move a date (second-tech-handover-weekend.js).
        'ss.is_recurring', 'ss.window_start', 'ss.window_end', 'ss.estimated_duration_minutes', 'ss.customer_confirmed',
        'ss.auto_dispatch_locked', 'ss.auto_dispatch_excluded', 'ss.date_exception', 'ss.recurring_dispatch_due_date', 'ss.auto_dispatch_change_count',
        db.raw('ss.date_exception_cadence_date::text as date_exception_cadence_date'));
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

// Every ADD-ON on the series' non-cancelled visits, or on their PARENT row in any status: the scheduler copies the
// parent row's due add-ons onto each new visit (admin-schedule.js auto-extend), and a series whose parent row was
// cancelled can still be live through its children. `id` = the visit (or parent) row the add-on is on.
async function loadAddons(db, parentIds) {
  const out = [];
  for (const ids of chunks(parentIds, 1000)) {
    out.push(...await db('scheduled_service_addons as a')
      .join('scheduled_services as s', 's.id', 'a.scheduled_service_id')
      .leftJoin('services as cat', 'cat.id', 'a.service_id')
      .where(function inSeries() { this.whereIn('s.recurring_parent_id', ids).orWhereIn('s.id', ids); })
      .where(function countedRow() { this.whereNot('s.status', 'cancelled').orWhereIn('s.id', ids); })
      .select('s.id', 's.recurring_parent_id', 'a.service_id', 'a.service_key_snapshot', 'a.service_name', 'cat.service_key as catalog_key'));
  }
  return out;
}

/**
 * What the planner needs from the add-ons: the series with a termite bait add-on (the customer mark), and each row's
 * add-on lines (an add-on is read by its own service, like a visit; null = unknown service).
 */
async function loadAddonFacts(db, parentIds, lineOf) {
  const addons = await loadAddons(db, parentIds);
  const lines = new Map();
  for (const a of addons) {
    const line = await lineOf({ service_id: a.service_id, service_key_snapshot: a.service_key_snapshot, service_type: a.service_name });
    lines.set(a.id, (lines.get(a.id) || new Set()).add(line));
  }
  return {
    baitAddonSeriesIds: [...new Set(addons.filter(isTermiteBaitAddon).map((a) => a.recurring_parent_id || a.id))],
    addonLinesOf: (rowId) => [...(lines.get(rowId) || [])],
  };
}

/** Read everything the planner needs and plan. `db` is a knex handle (or transaction). Reads only. */
/**
 * --zips: the listed territory_zips rows (each must exist) and every parent's service ZIP
 * (`p.zip`: its service_address_zip, else its customer's zip, 5 digits). No --zips: [] and no read.
 */
async function loadZipScope(db, zips, parents) {
  if (!zips) return [];
  const territory = await db('territory_zips').whereIn('zip', zips).select('zip', 'area', 'technician_id').orderBy('zip');
  const missing = zips.filter((z) => !territory.some((t) => t.zip === z));
  if (missing.length) throw new Error(`--zips: not a territory ZIP: ${missing.join(', ')}`);
  const customerZip = new Map();
  for (const ids of chunks([...new Set(parents.map((p) => p.customer_id).filter(Boolean))], 1000)) {
    for (const r of await db('customers').whereIn('id', ids).select('id', 'zip')) customerZip.set(r.id, r.zip);
  }
  for (const p of parents) p.zip = normalizeZip(p.service_address_zip) || normalizeZip(customerZip.get(p.customer_id)) || null;
  return territory;
}

/**
 * The lines among `lines` that `toId` is set Off for (technician_capabilities, the editor's Off state: a hard
 * drop in auto-dispatch). One rule for every line; a line with no row reads 'unset' and is allowed.
 */
async function offCapabilityLines(db, toId, lines) {
  if (!toId || !lines.length) return [];
  const rows = await db('technician_capabilities').where({ technician_id: toId }).whereIn('service_category', lines)
    .select('service_category', 'capability_level', 'active');
  return rows.filter((r) => stateOf(r) === 'off').map((r) => r.service_category).sort();
}

/**
 * Refuse when the hire is set to Off for a line this run hands over (plan.capability_lines: a line with a series to
 * move, and termite when a series of a bait customer moves). A line with nothing to move does not count.
 */
async function assertTargetTakesLines(db, toId, plan) {
  const off = await offCapabilityLines(db, toId, plan.capability_lines);
  if (off.length) {
    throw new PlanError('TARGET_CAPABILITY_OFF', `--to is set to Off for ${off.join(', ')} (Team tab, capabilities): turn it on, or leave the line out with --lines. Nothing was changed.`);
  }
}

/** Flag combinations the planner cannot plan, refused before any read. */
function assertRunFlags({ weekendMove, start, today }) {
  // The day-60 run moves dates, so every new date must clear the 73 h reminder freeze: --start is at least 4 days out.
  if (weekendMove && start < etDateString(addETDays(parseETDateTime(`${today}T12:00:00`), weekendMoves.MIN_DAYS_OUT))) {
    throw new PlanError('START_TOO_SOON', `--weekend-move moves dates: --start must be at least ${weekendMoves.MIN_DAYS_OUT} days after today (${today}), outside the 73 h freeze`);
  }
}

/** buildPlan, and for --weekend-move the second pass that gives each weekend customer its new dates (or keeps it whole). */
async function planWithWeekend(db, input, { weekendMove, now, lockNeighbors }) {
  const plan = buildPlan({ ...input, weekendMove });
  if (!weekendMove) return plan;
  const toId = input.to.id;
  const decisions = await weekendMoves.decideWeekend(db, {
    plan, parents: input.parents, visits: input.visits, from: input.from, to: toId, workDays: targetWorkDays(input.to).workDays,
    start: input.start, today: input.today, now, lockNeighbors,
  });
  return buildPlan({ ...input, weekendMove, weekend: decisions });
}

async function planHandover(db, {
  from, to = null, start, today = etDateString(), lines = MOVABLE_LINES, zips, weekendMove, now, lockNeighbors,
}) {
  assertRunFlags({ weekendMove, start, today });
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
  // The line of a row's own service (a series' current template, or one visit), read once per service.
  const lineOf = async (row) => {
    const key = [row.service_id || '', row.service_key_snapshot || '', row.service_type || ''].join('|');
    if (!cache.has(key)) {
      cache.set(key, (await serviceLineFor(db, {
        serviceId: row.service_id, serviceKey: row.service_key_snapshot, serviceType: row.service_type,
      })).line || null);
    }
    return cache.get(key);
  };
  for (const p of parents) {
    p.catalog_key = (p.service_id && catalogKeys.get(p.service_id)) || null;
    p.line = await lineOf(p);
  }
  const territory = await loadZipScope(db, zips, parents);
  const parentIds = parents.map((p) => p.id);
  const visits = await loadVisits(db, parentIds, today);
  const visitServiceIds = [...new Set(visits.map((v) => v.service_id).filter((id) => id && !catalogKeys.has(id)))];
  for (const ids of chunks(visitServiceIds, 1000)) {
    for (const r of await db('services').whereIn('id', ids).select('id', 'service_key')) catalogKeys.set(r.id, r.service_key);
  }
  for (const v of visits) {
    v.catalog_key = (v.service_id && catalogKeys.get(v.service_id)) || null;
    v.line = await lineOf(v);
  }
  const liveSeriesIds = await loadLiveSeriesIds(db, parentIds, today);
  const { baitAddonSeriesIds, addonLinesOf } = await loadAddonFacts(db, parentIds, lineOf);
  [...parents, ...visits].forEach((row) => { row.addon_lines = addonLinesOf(row.id); });
  const plan = await planWithWeekend(db, {
    from, to: toRow ? { id: toRow.id, work_days: toRow.work_days } : null, start, today, lines, parents, visits,
    liveSeriesIds, baitAddonSeriesIds, zips, territory,
  }, { weekendMove, now, lockNeighbors });
  // A line the hire is Off for cannot be handed to the hire.
  await assertTargetTakesLines(db, to, plan);
  // The overlay follows GATE_EDIT_APPT_PRICE_SERVICE_SCOPE, as in the app.
  plan.template_overrides = isEnabled('editApptPriceServiceScope') ? 'applied' : 'not_applied_gate_off';
  return plan;
}

// ---- output -----------------------------------------------------------------

function weekdayLine(map) {
  const parts = WEEKDAY_ORDER.filter((d) => map[WEEKDAYS[d]]).map((d) => `${WEEKDAYS[d]} ${map[WEEKDAYS[d]]}`);
  return parts.length ? parts.join(', ') : 'none';
}

// --weekend-move: the date changes by weekday, the customers moved, the customers kept whole by reason. Counts only.
function printWeekendMove(plan, out) {
  const d = plan.date_changes;
  out.push(`DAY-60 RUN (--weekend-move): ${d.visits} visits of ${d.customers} customers change day; ${plan.ids.anchors.length} series get a new parent anchor (recurring_nth / recurring_weekday)`);
  for (const [label, n] of Object.entries(d.by_change).sort()) out.push(`  ${label}: ${n} visits`);
  const kept = Object.entries(plan.skipped).filter(([reason]) => reason.startsWith('weekend_kept_'));
  out.push(`Customers kept whole with the owner (no legal clean move): ${plan.ids.kept.length}`);
  for (const [reason, s] of kept) out.push(`  ${reason.slice('weekend_kept_'.length)}: ${s.customers} customers, ${s.series} series, ${s.visits} visits`);
  out.push('  (a date change sends no customer message; the reminder row follows the new date and the normal reminders run for it)');
  out.push('');
}

/** The dry run's bait line: the customers a run with termite hands over, or every bait customer a run without it keeps. */
function baitLine(plan) {
  if (plan.lines.includes('termite')) return `Termite bait customers that move with this run (owner 2026-11-21): ${plan.bait_customers_moving} customers`;
  const head = 'Termite bait customers kept whole with the owner (this run leaves termite out): ';
  if (!plan.bait_customers_kept) return `${head}none`;
  // Then what the bait rule alone held back: a bait-only customer's series stays as other_line and is not in these counts.
  const held = plan.skipped.termite_bait_customer;
  return `${head}${plan.bait_customers_kept} customers${held ? `; held back by this rule: ${held.series} series, ${held.visits} visits` : ''}`;
}

function printPlan(plan, { list }) {
  const out = [];
  out.push('Second-technician handover plan (DRY RUN: nothing was changed)');
  out.push(`  from:    ${plan.from}`);
  out.push(`  target:  ${plan.target}`);
  out.push(`  first solo day: ${plan.start}   (plan read on ${plan.today})`);
  out.push(`  lines:   ${plan.lines.join(', ')}`);
  if (plan.zips) {
    out.push(`  zips:    ${plan.zips.join(', ')}`);
    out.push(`  territory: --execute makes the target the territory technician of these ${plan.territory.length} ZIPs (now: ${plan.territory.map((t) => `${t.zip}=${t.technician_id || 'none'}`).join(', ')})`);
  }
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
  if (plan.weekend_move) printWeekendMove(plan, out);
  const weekend = plan.skipped.off_day_customer;
  out.push(`Weekend customers kept whole with the owner until ${plan.off_day_customer_until} (question 1 = C): `
    + `${weekend ? `${weekend.customers} customers, ${weekend.series} series, ${weekend.visits} visits` : 'none'}`);
  out.push(baitLine(plan));
  out.push(`Later visits on a target day off, kept with the owner (stays_off_day): ${plan.stays_off_day.visits}`);
  out.push(`  by weekday: ${weekdayLine(plan.stays_off_day.by_weekday)}`);
  out.push('  (the second handover run, --weekend-move, moves these customers and their dates)');
  out.push('');
  out.push('Skipped, by reason (series / visits):');
  const reasons = ['other_line', 'no_line', 'outside_zips', 'addon_other_line', 'termite_bait_customer', 'off_day_customer', ...Object.keys(plan.skipped).filter((r) => r.startsWith('weekend_kept_')), 'visit_other_line', 'grouped', 'not_open', 'before_start', 'other_technician', 'unassigned_left', 'bad_date'];
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
    if (plan.weekend_move) {
      out.push(`Date changes (${plan.date_changes.visits}): visit id, old date -> new date`);
      for (const m of plan.ids.moves.filter((x) => x.to_date)) out.push(`  ${m.visit_id}  ${m.date} -> ${m.to_date}`);
      out.push(`Parent anchors (${plan.ids.anchors.length}): series id, nth / weekday (old -> new)`);
      for (const a of plan.ids.anchors) out.push(`  ${a.series_id}  ${a.old_nth}/${a.old_weekday} -> ${a.nth}/${a.weekday}`);
      out.push(`Customers kept whole (${plan.ids.kept.length}): customer id, reason`);
      for (const k of plan.ids.kept) out.push(`  ${k.customer_id}  ${k.reason}`);
    }
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
      const plan = await planHandover(trx, { from: args.from, to: args.to, start, today, lines: args.lines, zips: args.zips, weekendMove: args.weekendMove });
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
  assertRunFlags, MOVABLE_LINES, PlanError, offCapabilityLines, OPEN_STATUSES, STOPPED_TRACK_STATES, TERMITE_BAIT_KEYS,
  parseArgs, defaultStart, seriesTechnicianId, isOpenVisit, isGroupedVisit, isBaitSeries, isTermiteBaitAddon,
  buildPlan, planIdOf, planHandover, printPlan, readOnlyConn, tlsFor, connectionFields, scramPlusOnly,
};

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
