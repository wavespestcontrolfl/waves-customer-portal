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
const { evaluateNoShow, latestPromises } = require('../../server/services/no-show-detector');
const { etDateString } = require('../../server/utils/datetime-et');

function replay(input) {
  const from = new Date(input.from), to = new Date(input.to);
  if (!Array.isArray(input.visits) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('A bounded timeline export is required');
  const reports = [];
  for (const threshold of [45, 60]) {
    const alerts = [], days = {}, counts = { route_attention: 0, tracking_gap: 0, on_time: 0, unknown: 0 };
    let missingPromise = 0;
    for (const item of input.visits) {
      if (!item.id || !item.initial?.status || !Array.isArray(item.events) || !Array.isArray(item.promises)) throw new Error('Each visit needs initial state, dated events, and promises');
      const events = item.events.map((event) => {
        const at = new Date(event.at).getTime();
        if (!Number.isFinite(at)) throw new Error('Every state change needs a valid timestamp');
        return { ...event, at };
      }).sort((a, b) => a.at - b.at);
      const promises = item.promises.map((p) => ({ ...p, visit_id: item.id }));
      // Missingness follows the LATEST promise as of the end of the window
      // (production's own selection rule via latestPromises), not the raw
      // array length — a nonempty array whose latest entry has a null/invalid
      // start_at (the unknown-window case latestPromises models for a legacy
      // move notice) is exactly as unusable to evaluateNoShow as no promise
      // at all, and silently reported complete coverage before this fix
      // (codex P1 af4925f71).
      const finalPromise = latestPromises(promises, to).get(String(item.id));
      if (!finalPromise || !Number.isFinite(new Date(finalPromise.start_at).getTime())) missingPromise += 1;
      const state = { id: item.id, ...item.initial };
      let eventIndex = 0;
      const emitted = new Set();
      for (let at = Math.ceil(from.getTime() / 300000) * 300000; at <= to.getTime(); at += 300000) {
        const now = new Date(at);
        while (eventIndex < events.length && events[eventIndex].at <= at) {
          Object.assign(state, events[eventIndex].patch);
          eventIndex += 1;
        }
        const promise = latestPromises(promises, now).get(String(item.id));
        const alert = evaluateNoShow({ visit: state, promise, now, stage1Minutes: threshold });
        if (!alert) continue;
        const key = `${alert.promised_window.start_at}:${alert.stage}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        const bucket = ['missed', 'late'].includes(item.outcome) ? 'route_attention'
          : ['tracking_gap', 'on_time'].includes(item.outcome) ? item.outcome : 'unknown';
        counts[bucket] += 1;
        const day = etDateString(now);
        days[day] ||= { stage1: 0, stage2: 0 };
        days[day][`stage${alert.stage}`] += 1;
        const complaint = new Date(item.complaint_at).getTime();
        alerts.push({ visit_id: item.id, stage: alert.stage, at: now.toISOString(), outcome: bucket,
          warning_minutes_before_complaint: Number.isFinite(complaint) ? Math.round((complaint - at) / 60000) : null });
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
module.exports = { replay, markdown };
