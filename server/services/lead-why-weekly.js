'use strict';

/**
 * "Why we win and lose" — ONE weekly admin bell for the owner (owner ruling 2026-11-25,
 * "record why on every lead", option A, PR 2). Read-only: it sends nothing to a customer,
 * calls no paid API, and writes only one admin notification row.
 *
 * Every Monday 8:15 AM ET (scheduler.js, runExclusive) it reads the leads created in the
 * Monday-to-Sunday Eastern week that just ended and reports:
 *   - how many leads came in, how many won, how many were not booked;
 *   - the top reasons callers left their last provider (leads.switch_reason);
 *   - the top rivals they are leaving (leads.previous_company);
 *   - the top reasons a lead did not book (leads.not_booked_reason);
 *   - the leads where Waves promised a quote or a callback and it is still owed: the Owed
 *     queue's own read (call-commitments listOpenCommitments, party waves, kinds
 *     send_estimate + callback, past its deadline, vendor/spam/applicant calls left out),
 *     scoped to each lead by the same call link the Owed tab uses. Fails open: when that
 *     read breaks, the line is left out and the card still goes out.
 *
 * Those fields are filled by the nightly lead-why-fill job (lead-why-fill.js); a lead whose
 * why is still empty counts in the totals only, and each list says how many leads it knows.
 * No customer names anywhere: leads appear as an id and a created date.
 *
 * Delivery (docs/admin-notifications.md): the monday-review-bell pattern. Category
 * 'system', needs-you, raised through raiseAdminAlert with bell: true. dedupeKey is
 * lead-why-weekly:<ET Monday of the week reported>, so a rerun writes nothing and no
 * dedupeOpenOnly (so no RERING entry). A week with no leads raises nothing. Last week's
 * open row closes when this week's is raised. Kill switch LEAD_WHY_WEEKLY=off, read in
 * scheduler.js. Not a GATE_* (admin-only notice, no customer contact, no spend).
 */

const db = require('../models/db');
const logger = require('./logger');
const { scopeToProspects } = require('./lead-statuses');
const { bookedLeadIds } = require('./lead-why-fill');
const { raiseAdminAlert, cutAtWord, MAX_WHY_CHARS, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');
const {
  etWeekStart, etDateString, addETDays, parseETDateTime, formatETDayDate,
} = require('../utils/datetime-et');

const KEY_PREFIX = 'lead-why-weekly:';
const CATEGORY = 'system';
const AREA = 'Leads';
const LINK = '/admin/leads';
const OWED_PAGE = 20;
const PAGE = 500; // leads are read in pages, so a big week is still counted in full
const TOP_N = 3;
const LIST_LIMIT = 10;
const PROMISE_KINDS = ['send_estimate', 'callback'];
const NOT_BOOKED_STATUSES = ['lost', 'unresponsive'];
const REPLACED = "Replaced by this week's card";

// Plain words for each code the filler writes (lead-why-fill.js lists). A value
// that is not on a list (an older row) shows as stored.
const SWITCH_LABELS = {
  moved: 'moved house',
  pests_came_back: 'pests came back',
  no_show: 'old company missed visits',
  no_callback: 'old company never called back',
  contract: 'locked-in contract',
  bundle: 'wanted lawn and pest together',
  price_creep: 'price kept going up',
};
const NOT_BOOKED_LABELS = {
  spouse: 'had to ask a spouse or partner',
  one_visit: 'wanted one visit only',
  no_plan: 'did not want a plan',
  wants_a_look: 'wanted a look in person first',
  price: 'price too high',
  timing: 'not the right time',
  no_response: 'never answered us',
};

const plural = (n, one, many) => (n === 1 ? one : many);
const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const labelOf = (labels, code) => labels[code] || code.replace(/_/g, ' ');

// The Eastern Monday-to-Sunday week before the one `now` falls in.
function reportWeek(now = new Date()) {
  const start = etWeekStart(addETDays(now, -7));
  const next = etWeekStart(now);
  return {
    start,
    from: parseETDateTime(`${start}T00:00:00`),
    to: parseETDateTime(`${next}T00:00:00`),
    sunday: etDateString(addETDays(parseETDateTime(`${start}T12:00:00`), 6)),
  };
}

// "Nov 18" for an instant, on the Eastern calendar.
const shortDay = (value) => formatETDayDate(new Date(value)).replace(/^\w+, /, '');
// "Nov 16" for an ET calendar date (YYYY-MM-DD), taken at noon so no zone shifts the day.
const shortDate = (ymd) => shortDay(parseETDateTime(`${ymd}T12:00:00`));

// Count a field across rows: [{ value, count }] most common first, ties by name, top n.
function topCounts(rows, field, n = TOP_N) {
  const counts = new Map();
  for (const r of rows) {
    const v = clean(r[field]);
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, n);
}

const known = (rows, field) => rows.filter((r) => clean(r[field])).length;

// Not booked = status lost / unresponsive, never converted, and no booking the nightly filler sees
// (bookedLeadIds: a linked visit or a booked / completed funnel row). The loss reasons are counted over these same leads, so a
// lead won after the nightly fill never adds a stale reason. The rest are open or closed another way.
const notBookedRows = (rows) => rows.filter((r) => NOT_BOOKED_STATUSES.includes(r.status) && !r.converted_at && !r.booked);
function weekTotals(rows) {
  const won = rows.filter((r) => r.status === 'won').length;
  const notBooked = notBookedRows(rows).length;
  return { total: rows.length, won, notBooked, other: rows.length - won - notBooked };
}

/**
 * Pure: the week's leads (+ the owed-promise leads) in, the numbers out.
 * `owed` is null when the promise read failed (the line is then left out), else
 * [{ id, created_at }] of the leads with a promised quote or callback still owed.
 */
function summarizeWeek(rows, owed = null) {
  const lostRows = notBookedRows(rows);
  return {
    ...weekTotals(rows),
    switchReasons: topCounts(rows, 'switch_reason'),
    switchKnown: known(rows, 'switch_reason'),
    rivals: topCounts(rows, 'previous_company'),
    rivalsKnown: known(rows, 'previous_company'),
    notBookedReasons: topCounts(lostRows, 'not_booked_reason'),
    notBookedKnown: known(lostRows, 'not_booked_reason'),
    owed,
  };
}

const countLine = (items, labels) => items.map(({ value, count }) => `${labels ? labelOf(labels, value) : value} ${count}`).join(', ');

function listLine(title, items, knownCount, total, labels) {
  if (!items.length) return `${title}: nothing recorded yet (0 of ${total} leads).`;
  return `${title} (${knownCount} of ${total} leads): ${countLine(items, labels)}.`;
}

function owedLine(owed) {
  if (owed === null) return null;
  if (!owed.length) return 'Quote or callback promised and still owed: none.';
  const shown = owed.slice(0, LIST_LIMIT).map((l) => `${l.id} (${shortDay(l.created_at)})`).join(', ');
  const more = owed.length > LIST_LIMIT ? `, and ${owed.length - LIST_LIMIT} more` : '';
  return `Quote or callback promised and still owed: ${owed.length} ${plural(owed.length, 'lead', 'leads')} - ${shown}${more}.`;
}

function buildDetail(week, s) {
  const range = `${shortDate(week.start)} to ${shortDate(week.sunday)}`;
  return [
    `Why we win and lose, ${range} (Monday to Sunday, Eastern). This card sent nothing to a customer.`,
    `Leads: ${s.total}. Won: ${s.won}. Not booked: ${s.notBooked}. Still open or closed another way: ${s.other}.`,
    listLine('Why they left their last company', s.switchReasons, s.switchKnown, s.total, SWITCH_LABELS),
    listLine('Companies they are leaving', s.rivals, s.rivalsKnown, s.total, null),
    listLine('Why they did not book', s.notBookedReasons, s.notBookedKnown, s.notBooked, NOT_BOOKED_LABELS),
    owedLine(s.owed),
    'The reasons come from the calls, filled in each night. A lead with no reason yet counts only in the totals.',
  ].filter(Boolean).join('\n');
}

function whyLine(s) {
  const bits = [`${s.total} new ${plural(s.total, 'lead', 'leads')}, ${s.won} won, ${s.notBooked} not booked`];
  if (s.switchReasons.length) bits.push(`top switch reason: ${labelOf(SWITCH_LABELS, s.switchReasons[0].value)}`);
  if (s.owed && s.owed.length) bits.push(`${s.owed.length} promised ${plural(s.owed.length, 'follow-up', 'follow-ups')} still owed`);
  const text = `${bits.join('; ')}.`;
  return text.length <= MAX_WHY_CHARS ? text : `${cutAtWord(text.replace(/\.$/, ''), MAX_WHY_CHARS - 1)}.`;
}

// The composeAdminAlert spec and the detail text for a week.
function composeWeekly(week, summary) {
  const action = `read why we win and lose, week of ${shortDate(week.start)}`;
  if (`${AREA} — ${action}`.length > MAX_HEADLINE_CHARS) throw new Error('lead why weekly headline too long');
  const spec = {
    area: AREA,
    action,
    why: whyLine(summary),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: 'lead-why-weekly' },
    doneWhen: 'reviewed',
    who: 'person',
  };
  return { spec, detail: buildDetail(week, summary) };
}

// The week's prospects: the Leads analytics scope (scopeToProspects), so a won quote-wizard repeat
// and its won original count as one deal. Read in pages by (created_at, id) so none are cut off.
async function loadWeekLeads(conn, week) {
  const all = [];
  let after = null;
  for (;;) {
    const page = await conn('leads')
      .whereNull('leads.deleted_at')
      .where('leads.created_at', '>=', week.from)
      .where('leads.created_at', '<', week.to)
      .modify((q) => scopeToProspects(q, 'leads'))
      .modify((q) => {
        if (after) q.whereRaw('(leads.created_at, leads.id) > (?::timestamptz, ?)', [after.cursor_at, after.id]);
      })
      .orderBy([{ column: 'leads.created_at', order: 'asc' }, { column: 'leads.id', order: 'asc' }])
      .limit(PAGE)
      // cursor_at keeps Postgres microseconds: a JS Date would drop them and repeat a row.
      .select('leads.id', 'leads.status', 'leads.created_at', 'leads.converted_at', 'leads.customer_id', 'leads.estimate_id', 'leads.switch_reason', 'leads.previous_company', 'leads.not_booked_reason',
        conn.raw('leads.created_at::text as cursor_at'));
    const booked = await bookedLeadIds(conn, page);
    all.push(...page.map((r) => ({ ...r, booked: booked.has(r.id) })));
    if (page.length < PAGE) return all;
    after = page[page.length - 1];
  }
}

/**
 * The leads of the week with a Waves promise still owed: the Owed queue's read per lead, so the
 * call link, the overdue rule and the quiet-call filter are the queue's own. A won lead is read
 * too: a booking does not keep a separate promised callback or quote. Returns null when the read
 * fails (fail open).
 */
async function loadOwedLeads(conn, leads) {
  const { listOpenCommitments } = require('./call-commitments');
  const owed = [];
  try {
    for (const lead of leads) {
      // Page on: the quiet-call filter runs after the read's limit, so one page of quiet rows
      // must not hide an owed promise on the next.
      for (let offset = 0; ; offset += OWED_PAGE) {
        const rows = await listOpenCommitments(conn, { leadId: lead.id, party: 'waves', kinds: PROMISE_KINDS, limit: OWED_PAGE, offset });
        if (rows.some((r) => r.overdue && !r.quiet_call)) { owed.push({ id: lead.id, created_at: lead.created_at }); break; }
        if (rows.length < OWED_PAGE) break;
      }
    }
  } catch (err) {
    logger.warn(`[lead-why-weekly] promised-follow-up line left out: ${err.message}`);
    return null;
  }
  return owed;
}

// Close older weeks' open rows once this week's exists. Keys end in the ET Monday (YYYY-MM-DD), so
// a string compare finds the older weeks; a newer week's row is never touched.
async function closeOlderRows(conn, now, keepKey) {
  const episodes = require('./admin-alert-episodes');
  const keys = (await episodes.openAdminAlertKeys(conn, KEY_PREFIX)).filter((k) => k < keepKey);
  if (!keys.length) return 0;
  return Number(await episodes.closeAdminAlertKeys(conn, keys, 'replaced', { now, resolution: REPLACED })) || 0;
}

/**
 * Monday cron entry point. Returns { leads, outcome }: raised | unchanged | suppressed | no_leads.
 * `loadOwed` replaces the promise reader (tests). A read failure of the leads throws, so
 * runExclusive records it in job_health and nothing is raised.
 */
async function runLeadWhyWeekly({ now = new Date(), conn = db, loadOwed = loadOwedLeads } = {}) {
  const week = reportWeek(now);
  const leads = await loadWeekLeads(conn, week);
  if (!leads.length) {
    logger.info(`[lead-why-weekly] no leads in the week of ${week.start}; no card`);
    return { leads: 0, outcome: 'no_leads' };
  }
  const summary = summarizeWeek(leads, await loadOwed(conn, leads));
  const { spec, detail } = composeWeekly(week, summary);
  const dedupeKey = `${KEY_PREFIX}${week.start}`;
  const result = await raiseAdminAlert(CATEGORY, spec, {
    dedupeKey,
    // GATE_ADMIN_BELL_POLICY drops an admin row that does not ask to ring.
    bell: true,
    detail,
    metadata: {
      leadWhyWeekly: true, weekOf: week.start,
      counts: { leads: summary.total, won: summary.won, notBooked: summary.notBooked, owed: summary.owed ? summary.owed.length : null },
    },
  });
  if (!result) throw new Error('lead why weekly card was not written');
  let outcome = 'raised';
  if (result.suppressed) outcome = 'suppressed';
  else if (result.deduped) outcome = 'unchanged';
  // Also on a dedupe: a retry after a failed cleanup still closes last week's row.
  if (outcome !== 'suppressed') await closeOlderRows(conn, now, dedupeKey);
  logger.info(`[lead-why-weekly] week of ${week.start}: ${summary.total} leads, ${summary.won} won, ${summary.notBooked} not booked (${outcome})`);
  return { leads: summary.total, outcome };
}

module.exports = {
  runLeadWhyWeekly,
  KEY_PREFIX,
  _private: {
    reportWeek, topCounts, summarizeWeek, weekTotals, composeWeekly, buildDetail, whyLine, owedLine, shortDay, shortDate,
    loadOwedLeads, loadWeekLeads, SWITCH_LABELS, NOT_BOOKED_LABELS, REPLACED,
  },
};
