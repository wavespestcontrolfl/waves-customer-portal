#!/usr/bin/env node
/** READ-ONLY: replay operator-supplied visit/promise timelines. No database,
 * provider, or production access. Writes a local JSON + Markdown report.
 * node ops/agents/replay-no-show-detector.js --input export.json --output .tmp/no-show-replay
 * Input: { synthetic?:boolean, from, to, visits:[{ id, initial:{status,...},
 * events:[{at,patch:{status,...}}], promises:[{start_at,communicated_at,source}],
 * outcome:'missed'|'late'|'on_time'|'tracking_gap'|'unknown', complaint_at? }] }
 * A final-row snapshot alone is invalid: future terminal state must not hide
 * an alert that would have been raised earlier.
 */
const fs = require('fs');
const path = require('path');
const { evaluateNoShow, latestPromises, promisedStartAt, LIVE_STATUSES } = require('../../server/services/no-show-detector');
const { etDateString } = require('../../server/utils/datetime-et');

// One visit's timeline at one threshold. Returns the alerts it would have
// emitted and whether a usable promised window ever existed at a decision
// point — split out of replay() so the per-tick rules, the validation and the
// aggregation can be reviewed independently (codex P2).
function replayVisit(item, { from, to, threshold }) {
  if (!item.id || !item.initial?.status || !Array.isArray(item.events) || !Array.isArray(item.promises)) throw new Error('Each visit needs initial state, dated events, and promises');
  const events = item.events.map((event) => {
    const at = new Date(event.at).getTime();
    if (!Number.isFinite(at)) throw new Error('Every state change needs a valid timestamp');
    return { ...event, at };
  }).sort((a, b) => a.at - b.at);
  const promises = item.promises.map((p) => ({ ...p, visit_id: item.id }));
  const state = { id: item.id, ...item.initial };
  const alerts = [];
  const emitted = new Set();
  let eventIndex = 0;
  let covered = false;
  let knownBeforeThreshold = false;
  for (let at = Math.ceil(from.getTime() / 300000) * 300000; at <= to.getTime(); at += 300000) {
    const now = new Date(at);
    while (eventIndex < events.length && events[eventIndex].at <= at) {
      Object.assign(state, events[eventIndex].patch);
      eventIndex += 1;
    }
    const promise = latestPromises(promises, now).get(String(item.id));
    // Coverage is measured AT THE DECISION POINTS, not from the final state
    // at `to`: a promise backfilled or communicated after this visit's
    // thresholds passed leaves every production tick before it with nothing
    // usable — reading the end-of-window state instead reported such a visit
    // as covered and understated missing_promise_visits, which is exactly
    // the number that says whether a no-alert backtest means "nothing was
    // wrong" or "we had no evidence to judge with" (codex P1, round 4).
    // A live status is required for the same reason evaluateNoShow requires
    // one: a promise that only lands after the visit is completed/cancelled
    // was never available to judge against. Coverage is judged with the
    // detector's OWN evidence rule (promisedStartAt) at an ALERT-RELEVANT
    // tick — one at or past the stage-1 threshold — not merely at any live
    // tick: a known window present before its own window opens, replaced by
    // an unknown-window notice before either threshold, left every real
    // decision point with nothing usable while an early pre-window tick had
    // already marked the visit covered, understating missing_promise_visits
    // and making an evidence-poor activation replay look complete (codex P1
    // round 8). promisedStartAt also rejects a null start_at before any Date
    // conversion — new Date(null).getTime() is 0, a finite instant — which is
    // what keeps the unknown-window case (a legacy move notice) counted as
    // missing rather than covered (codex P1 af4925f71).
    if (!covered && LIVE_STATUSES.includes(state.status)) {
      const start = promisedStartAt({ promise, now, ignoreHorizon: true });
      // A known window held while the visit was still live, but before the
      // first threshold. On its own that is not coverage — the window can
      // still be replaced by an unknown one before any decision point (the
      // case above). It BECOMES coverage if the visit leaves LIVE_STATUSES
      // before any threshold is reached: an on-time short visit completed at
      // 09:30 against a 09:00 window never needed a decision at all, and
      // counting it as missing evidence inflated the very denominator the
      // rollout report is read for (codex P2 round 9).
      // Recomputed every tick, never latched: a known window held early and
      // then REPLACED by an unknown-window notice leaves the visit with
      // nothing usable, and a latched flag would let the earlier window
      // vouch for coverage the visit no longer had when it completed (codex
      // P1 round 9, guarding the round-8 rule this exception sits beside).
      knownBeforeThreshold = start != null && at < start + threshold * 60000;
      if (start != null && at >= start + threshold * 60000) covered = true;
    } else if (!covered && knownBeforeThreshold) covered = true;
    const alert = evaluateNoShow({ visit: state, promise, now, stage1Minutes: threshold });
    if (!alert) continue;
    const key = `${alert.promised_window.start_at}:${alert.stage}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const complaint = new Date(item.complaint_at).getTime();
    alerts.push({ visit_id: item.id, stage: alert.stage, at: now.toISOString(), day: etDateString(now),
      warning_minutes_before_complaint: Number.isFinite(complaint) ? Math.round((complaint - at) / 60000) : null });
  }
  return { alerts, covered };
}

function replay(input) {
  const from = new Date(input.from), to = new Date(input.to);
  if (!Array.isArray(input.visits) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('A bounded timeline export is required');
  const reports = [];
  for (const threshold of [45, 60]) {
    const alerts = [], days = {}, counts = { route_attention: 0, tracking_gap: 0, on_time: 0, unknown: 0 };
    let missingPromise = 0;
    for (const item of input.visits) {
      const { alerts: visitAlerts, covered } = replayVisit(item, { from, to, threshold });
      if (!covered) missingPromise += 1;
      const bucket = ['missed', 'late'].includes(item.outcome) ? 'route_attention'
        : ['tracking_gap', 'on_time'].includes(item.outcome) ? item.outcome : 'unknown';
      for (const alert of visitAlerts) {
        counts[bucket] += 1;
        days[alert.day] ||= { stage1: 0, stage2: 0 };
        days[alert.day][`stage${alert.stage}`] += 1;
        const { day: _day, ...row } = alert;
        alerts.push({ ...row, outcome: bucket });
      }
    }
    reports.push({ stage1_minutes: threshold, counts, missing_promise_visits: missingPromise,
      stage1_alerts: alerts.filter((a) => a.stage === 1).length, stage2_alerts: alerts.filter((a) => a.stage === 2).length,
      before_complaint: alerts.filter((a) => a.warning_minutes_before_complaint > 0).length, by_day: days, alerts });
  }
  return { synthetic: input.synthetic === true, from: from.toISOString(), to: to.toISOString(),
    coverage_days: (to - from) / 86400000, visits: input.visits.length, thresholds: reports };
}

function markdown(report) {
  return `# No-show detector replay\n\n${report.synthetic ? 'Synthetic examples. This does not satisfy the production backtest.' : 'Operator-supplied timeline export; inspect unknown outcomes before activation.'}\n\n` +
    `${report.visits} visits over ${report.coverage_days.toFixed(1)} days. Counts reflect what was known at each five-minute tick.\n\n` +
    '| Stage 1 threshold | Stage 1 alerts | Stage 2 alerts | Route attention | Tracking gaps | On-time alerts | Unknown | Before complaint | Missing promise |\n|---|---|---|---|---|---|---|---|---|\n' +
    report.thresholds.map((r) => `| ${r.stage1_minutes} min | ${r.stage1_alerts} | ${r.stage2_alerts} | ${r.counts.route_attention} | ${r.counts.tracking_gap} | ${r.counts.on_time} | ${r.counts.unknown} | ${r.before_complaint} | ${r.missing_promise_visits} |`).join('\n') +
    '\n\nThe JSON contains daily counts, visit ids, and warning time for review. Alert volume alone is not evidence of a false alert.\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inputPath = args[args.indexOf('--input') + 1], outputPath = args[args.indexOf('--output') + 1];
  if (!args.includes('--input') || !args.includes('--output') || !inputPath || !outputPath) throw new Error('Use --input export.json --output local-report-prefix');
  const report = replay(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(`${outputPath}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outputPath}.md`, markdown(report));
  process.stdout.write(`Replayed ${report.visits} visits at 45 and 60 minutes; ${report.synthetic ? 'synthetic' : 'operator-supplied'} evidence.\n`);
}
module.exports = { replay, replayVisit, markdown };
