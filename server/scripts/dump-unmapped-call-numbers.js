#!/usr/bin/env node
/**
 * Dump every distinct call_log.to_phone that lacks a matching
 * lead_sources.twilio_phone_number row — i.e. the values rendered as
 * "Unmapped — <phone>" in the Dashboard's "Calls by Source" widget.
 *
 * Read-only. Safe to run against prod.
 *
 * Usage:
 *   node server/scripts/dump-unmapped-call-numbers.js
 *   node server/scripts/dump-unmapped-call-numbers.js --period=mtd
 *   node server/scripts/dump-unmapped-call-numbers.js --period=all
 *
 * --period defaults to "mtd" and uses the same ET-day boundaries as the
 * Dashboard widget (resolveAttributionWindow in admin-dashboard.js), so
 * counts reconcile across UTC date rollovers. Accepts today | wtd | mtd
 * | ytd | all. Windows are floored at the attribution fresh start exactly
 * like the widget (ATTRIBUTION_FRESH_START env overrides/disables — see
 * utils/attribution-fresh-start.js) so reconciliation keeps lining up.
 * Pass "all" to see every unmapped number ever seen in call_log with NO
 * floor (useful for deciding which to seed vs. mark is_active=false).
 *
 * For prod: export DATABASE_URL to the prod DB before running, e.g.:
 *   export DATABASE_URL="$(railway variables --kv --service Postgres \
 *     | awk -F= '/^DATABASE_PUBLIC_URL=/ { sub(/^DATABASE_PUBLIC_URL=/,""); print }')"
 */

const db = require('../models/db');
const { etDateString, etMonthStart, etYearStart, etWeekStart } = require('../utils/datetime-et');
const { resolveAttributionFreshStart, applyAttributionFreshStart } = require('../utils/attribution-fresh-start');

const periodArg = (process.argv.find((a) => a.startsWith('--period=')) || '').split('=')[1] || 'mtd';

const ATTRIBUTION_FRESH_START = resolveAttributionFreshStart();

// Mirror resolveAttributionWindow() in server/routes/admin-dashboard.js so
// reconciliation numbers line up with the widget — including its fresh-start
// floor (the widget excludes pre-baseline calls; without the same clip a
// --period=ytd run would send operators chasing numbers the dashboard never
// shows). "all" stays raw on purpose: it's the seed-vs-deactivate census.
// Day boundaries follow America/New_York, not UTC.
function windowFor(period) {
  if (period === 'all') return null;
  const today = etDateString();
  let win;
  switch (String(period).toLowerCase()) {
    case 'today': win = { from: today,           to: today }; break;
    case 'wtd':   win = { from: etWeekStart(),   to: today }; break;
    case 'ytd':   win = { from: etYearStart(),   to: today }; break;
    case 'mtd':   win = { from: etMonthStart(),  to: today }; break;
    default:
      throw new Error(`unknown --period=${period} (use today|wtd|mtd|ytd|all)`);
  }
  return applyAttributionFreshStart(win, ATTRIBUTION_FRESH_START);
}

(async () => {
  const win = windowFor(periodArg);

  let q = db('call_log as c')
    .leftJoin('lead_sources as s', 'c.to_phone', 's.twilio_phone_number')
    .where('c.direction', 'inbound')
    .whereNull('s.id')
    .select(
      'c.to_phone',
      db.raw('COUNT(*)::int as calls'),
      db.raw('COUNT(DISTINCT c.from_phone)::int as unique_callers'),
      db.raw('MIN(c.created_at) as first_seen'),
      db.raw('MAX(c.created_at) as last_seen'),
    )
    .groupBy('c.to_phone')
    .orderByRaw('COUNT(*) DESC');

  if (win) {
    q = q.whereRaw("c.created_at >= ?::timestamp AT TIME ZONE 'America/New_York'", [`${win.from}T00:00:00`])
         .whereRaw("c.created_at <  (?::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/New_York'", [`${win.to}T00:00:00`]);
  }

  const rows = await q;

  const totalCalls = rows.reduce((acc, r) => acc + r.calls, 0);
  const periodLabel = win
    ? `${win.from} → ${win.to}${win.freshStart ? ` (floored at attribution fresh start ${win.freshStart})` : ''}`
    : 'all time';

  console.log(`\nUnmapped inbound to_phone values — ${periodLabel}`);
  console.log(`${rows.length} distinct number(s), ${totalCalls} call(s) total\n`);

  if (rows.length === 0) {
    console.log('  (none — every inbound call resolved to a lead_sources row)');
    await db.destroy();
    return;
  }

  const w = (s, n) => String(s ?? '').padEnd(n);
  console.log(`  ${w('to_phone', 18)} ${w('calls', 7)} ${w('unique', 7)} ${w('first_seen', 21)} ${w('last_seen', 21)}`);
  console.log(`  ${'-'.repeat(18)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(21)} ${'-'.repeat(21)}`);
  for (const r of rows) {
    console.log(
      `  ${w(r.to_phone, 18)} ${w(r.calls, 7)} ${w(r.unique_callers, 7)} ${w(new Date(r.first_seen).toISOString().slice(0, 19), 21)} ${w(new Date(r.last_seen).toISOString().slice(0, 19), 21)}`,
    );
  }

  // Categorize for the operator
  const nonE164 = rows.filter((r) => !/^\+1\d{10}$/.test(r.to_phone || ''));
  if (nonE164.length) {
    console.log(`\n  ⚠ ${nonE164.length} row(s) are NOT in canonical E.164 (+1XXXXXXXXXX) — backfill may have missed them:`);
    for (const r of nonE164) console.log(`     ${r.to_phone}  (${r.calls} calls)`);
  }

  console.log('');
  await db.destroy();
})().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
