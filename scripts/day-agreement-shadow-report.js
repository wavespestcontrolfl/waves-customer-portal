#!/usr/bin/env node
'use strict';

/**
 * Day-only agreement shadow report (owner 2026-10-20, PR 1 of 2). READ ONLY.
 *
 * Scores the rows the shadow sweep wrote (day_agreement_decisions) against
 * what staff really did afterwards, so a week of shadow can show whether the
 * agent would have booked or moved the right day:
 *
 *   node scripts/day-agreement-shadow-report.js --from 2026-10-21 --to 2026-10-28
 *
 * --from / --to are ET dates, both inclusive, on the row's created_at.
 * Connects with DATABASE_PUBLIC_URL (or DATABASE_URL on a dev database), puts
 * the session in default_transaction_read_only and checks it took, and
 * writes nothing. Prints counts and id8 rows only: no names, phones, texts
 * or transcripts.
 *
 * For each would_book / would_move row it asks what happened to that
 * customer's visits after the agreement:
 *   staff_acted_on_day   a live visit of the customer, created or changed
 *                        after the agreement, sits on the agreed day
 *                        (same_hour = it starts at the hour the picker chose)
 *   staff_other_day      staff booked a different day (a new visit on another
 *                        day, or the visit a move named now sits elsewhere)
 *   nothing              no visit was created or changed
 */

const DEAD_STATUSES = ['cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled'];
const ACTED = 'staff_acted_on_day';
const OTHER = 'staff_other_day';
const NOTHING = 'nothing';

const ms = (value) => (value == null ? NaN : new Date(value).getTime());
const hhmm = (value) => (value == null ? null : String(value).slice(0, 5));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(out.from || '') || !iso.test(out.to || '')) throw new Error('usage: --from YYYY-MM-DD --to YYYY-MM-DD (ET dates, inclusive)');
  if (out.from > out.to) throw new Error('--from is after --to');
  return out;
}

/**
 * What happened after one decision. Pure.
 * @param decision  a day_agreement_decisions row (target_date as 'YYYY-MM-DD')
 * @param visits    the customer's visits ({ id, d, status, window_start,
 *                  created_at, updated_at }); d = 'YYYY-MM-DD'
 */
const OBSERVE_MS = 14 * 24 * 3600 * 1000;

function classifyOutcome(decision, visits) {
  const agreed = ms(decision.agreed_at);
  const live = visits.filter((v) => !DEAD_STATUSES.includes(String(v.status || '').toLowerCase()));
  // Staff action is direct evidence only (pre-push audit): a visit CREATED
  // after the agreement, or the very visit a move named now sitting on the
  // target day. A bare updated_at also moves on a status change (a visit
  // completed as planned), so it is never read as a booking or a move.
  // Only a booking someone made within the observation window counts: a
  // series top-up (recurring_parent_id) or a visit created weeks later is not
  // this agreement's outcome (pre-push audit).
  const created = live.filter((v) => !v.recurring_parent_id && ms(v.created_at) > agreed && ms(v.created_at) <= agreed + OBSERVE_MS);
  const movedHere = live.filter((v) => decision.from_visit_id && v.id === decision.from_visit_id && v.d === decision.target_date);
  // A move is scored only on the visit it named; a new visit only on new bookings.
  const touched = decision.from_visit_id ? movedHere : created;
  const onDay = touched.filter((v) => v.d === decision.target_date);
  if (onDay.length) {
    const sameHour = onDay.some((v) => hhmm(v.window_start) !== null && hhmm(v.window_start) === hhmm(decision.chosen_window_start));
    return { outcome: ACTED, sameHour };
  }
  const bookedElsewhere = touched.some((v) => v.d !== decision.target_date && ms(v.created_at) > agreed);
  const movedElsewhere = decision.from_visit_id
    && live.some((v) => v.id === decision.from_visit_id && v.d !== decision.target_date && v.d !== decision.from_day);
  return { outcome: bookedElsewhere || movedElsewhere ? OTHER : NOTHING, sameHour: false };
}

const bump = (map, key, by = 1) => { map[key] = (map[key] || 0) + by; };
const id8 = (value) => String(value || '').slice(0, 8);

// The key one agreement counts under: a would_* row by customer + day + verdict,
// an action-shaped skip (the model said act and a rule or the picker said no) by
// customer + day + the model's kind, so a re-judged agreement counts once.
function dedupeKey(d) {
  if (d.verdict === 'would_book' || d.verdict === 'would_move') return `${d.customer_id}|${d.target_date}|${d.verdict}`;
  if (d.verdict === 'skip' && d.judged && d.judged.act === true && d.customer_id && d.target_date) {
    return `skip|${d.customer_id}|${d.target_date}|${d.judged.kind || ''}`;
  }
  return null;
}

/**
 * Counts and rows for a set of decisions. Pure.
 * @param decisions  rows, each with `from_day` read from judged
 * @param visitsOf   (decision) => the customer's visits
 */
function summarize(decisions, visitsOf) {
  const report = {
    total: decisions.length, byVerdict: {}, skipReasons: {}, wouldOutcomes: {}, sameHour: 0, wouldTotal: 0,
    missedOpportunities: {}, rows: [],
  };
  // One agreement can be judged again from a later snapshot of the same text
  // thread ("See you Tuesday"): count each customer + day + kind once (pre-push audit).
  const seen = new Set();
  for (const d of decisions) {
    const wouldKey = dedupeKey(d);
    if (wouldKey && seen.has(wouldKey)) { report.duplicates = (report.duplicates || 0) + 1; continue; }
    if (wouldKey) seen.add(wouldKey);
    bump(report.byVerdict, d.verdict);
    if (d.verdict === 'skip') bump(report.skipReasons, d.skip_reason);
    const wouldAct = d.verdict === 'would_book' || d.verdict === 'would_move';
    const modelSaidAct = d.judged && d.judged.act === true && d.target_date && d.customer_id;
    if (!wouldAct && !(modelSaidAct && d.skip_reason !== 'staff_already_acted')) continue;
    const result = classifyOutcome(d, visitsOf(d));
    if (wouldAct) {
      report.wouldTotal += 1;
      bump(report.wouldOutcomes, result.outcome);
      if (result.sameHour) report.sameHour += 1;
      report.rows.push({
        id: id8(d.id), kind: d.source_kind, verdict: d.verdict, target: d.target_date,
        chose: hhmm(d.chosen_window_start), outcome: result.outcome, sameHour: result.sameHour,
      });
    } else if (result.outcome === ACTED) {
      // The model wanted to act, a rule said skip, and staff booked that day anyway.
      bump(report.missedOpportunities, d.skip_reason);
    }
  }
  return report;
}

function format(report, range) {
  const lines = [`Day-only agreement shadow ${range.from} to ${range.to} (ET)`, `decisions: ${report.total}`];
  const section = (title, map) => {
    lines.push('', title);
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (!entries.length) lines.push('  (none)');
    for (const [key, count] of entries) lines.push(`  ${key}: ${count}`);
  };
  section('by verdict', report.byVerdict);
  section('skip reasons', report.skipReasons);
  section(`would_book / would_move outcomes (${report.wouldTotal} rows; chosen hour matched staff: ${report.sameHour})`, report.wouldOutcomes);
  section('skipped although the model said act, and staff booked that day anyway (by skip reason)', report.missedOpportunities);
  lines.push('', 'would_book / would_move rows (id8, source, verdict, day, picked hour, outcome)');
  if (!report.rows.length) lines.push('  (none)');
  for (const r of report.rows) lines.push(`  ${r.id} ${r.kind} ${r.verdict} ${r.target} ${r.chose || '-'} ${r.outcome}${r.sameHour ? ' same_hour' : ''}`);
  return lines.join('\n');
}

async function loadDecisions(client, { from, to }) {
  const { rows } = await client.query(
    `SELECT id, source_kind, customer_id, agreed_at, judged, verdict, skip_reason,
            to_char(target_date, 'YYYY-MM-DD') AS target_date, from_visit_id,
            to_char(chosen_window_start, 'HH24:MI') AS chosen_window_start
       FROM day_agreement_decisions
      WHERE (created_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
      ORDER BY created_at`,
    [from, to],
  );
  return rows.map((r) => ({ ...r, judged: typeof r.judged === 'string' ? JSON.parse(r.judged) : r.judged, from_day: null }))
    .map((r) => ({ ...r, from_day: r.judged?.from_day || null }));
}

async function loadVisits(client, decisions) {
  const customers = [...new Set(decisions.map((d) => d.customer_id).filter(Boolean))];
  const fromVisits = [...new Set(decisions.map((d) => d.from_visit_id).filter(Boolean))];
  if (!customers.length) return [];
  const earliest = decisions.map((d) => ms(d.agreed_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const { rows } = await client.query(
    `SELECT id, customer_id, status, window_start, created_at, updated_at, recurring_parent_id,
            to_char(scheduled_date, 'YYYY-MM-DD') AS d
       FROM scheduled_services
      WHERE (customer_id = ANY($1::uuid[]) AND (created_at >= $2 OR updated_at >= $2))
         OR id = ANY($3::uuid[])`,
    [customers, new Date(earliest || Date.now()), fromVisits],
  );
  return rows;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const range = parseArgs(argv);
  const url = env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_PUBLIC_URL (or DATABASE_URL on a dev database) is not set');
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    // Read-only by construction: set, then check it took.
    await client.query('SET default_transaction_read_only = on');
    const check = await client.query('SHOW default_transaction_read_only');
    if (check.rows?.[0]?.default_transaction_read_only !== 'on') throw new Error('could not put the session in read-only mode - aborting');
    const decisions = await loadDecisions(client, range);
    const visits = await loadVisits(client, decisions);
    const report = summarize(decisions, (d) => visits.filter((v) => v.customer_id === d.customer_id || v.id === d.from_visit_id));
    console.log(format(report, range));
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`day-agreement-shadow-report: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, classifyOutcome, summarize, format, main };
