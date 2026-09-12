#!/usr/bin/env node
/** READ-ONLY: replay operator-supplied visit/promise timelines. No database,
 * provider, or production access. Writes a local JSON + Markdown report.
 * node ops/agents/replay-no-show-detector.js --input export.json --output .tmp/no-show-replay
 * Input: { synthetic?:boolean, from, to, visits:[{ id, stop_id?, initial:{status,...},
 * events:[{at,patch:{status,...}}], promises:[{start_at,communicated_at,source}],
 * outcome:'missed'|'late'|'on_time'|'tracking_gap'|'unknown', complaint_at? }] }
 * A final-row snapshot alone is invalid: future terminal state must not hide
 * an alert that would have been raised earlier.
 */
const fs = require('fs');
const path = require('path');
const { evaluateNoShow, promisedStartAt, stopState, stopPromise, LIVE_STATUSES } = require('../../server/services/no-show-detector');
const { etDateString } = require('../../server/utils/datetime-et');

// Was usable promise evidence in hand when a decision was actually required?
// Pure, and separated from the tick loop so the two rules it balances stay
// readable (and replayVisit stays inside the repo's complexity budget):
//   - coverage counts only at an ALERT-RELEVANT tick — at or past the stage-1
//     threshold — so a known window replaced by an unknown-window notice
//     before either threshold does not vouch for a decision point that had
//     nothing usable (codex P1 round 8);
//   - but a visit that leaves LIVE_STATUSES before any threshold, holding a
//     known window at its last live tick, never needed a decision at all and
//     is not missing evidence (codex P2 round 9). That flag is recomputed
//     each tick, never latched, so a superseded window cannot resurrect it
//     (codex P1 round 9).
// promisedStartAt also rejects a null start_at before any Date conversion —
// new Date(null).getTime() is 0, a finite instant — which is what keeps the
// unknown-window case counted as missing (codex P1 af4925f71).
function coverageAt({ covered, knownBeforeThreshold, liveNow, promise, now, at, threshold }) {
  if (covered) return { covered, knownBeforeThreshold };
  if (!liveNow) return { covered: knownBeforeThreshold, knownBeforeThreshold };
  const start = promisedStartAt({ promise, now, ignoreHorizon: true });
  if (start == null) return { covered: false, knownBeforeThreshold: false };
  if (at >= start + threshold * 60000) return { covered: true, knownBeforeThreshold: false };
  return { covered: false, knownBeforeThreshold: true };
}

// One visit's timeline at one threshold. Returns the alerts it would have
// emitted and whether a usable promised window ever existed at a decision
// point — split out of replay() so the per-tick rules, the validation and the
// aggregation can be reviewed independently (codex P2).
function replayVisit(item, { from, to, threshold }) {
  // A grouped stop keeps its members SEPARATE and merges them at every tick,
  // exactly as production does: each member advances its own state from its
  // own events, and the stop's state/promise come from the detector's own
  // stopState/stopPromise. Folding the members into one synthetic row instead
  // would let a cancelled sibling's status patch cancel the whole stop and
  // lose the other members' arrival stamps (codex P1 round 12).
  const members = (item.members || [item]).map((member) => {
    if (!member.id || !member.initial?.status || !Array.isArray(member.events) || !Array.isArray(member.promises)) throw new Error('Each visit needs initial state, dated events, and promises');
    return {
      id: member.id,
      // The member's OWN id wins over anything in the exported snapshot: it is
      // what its promises are keyed by, and what stopPromise looks up.
      state: { ...member.initial, id: member.id },
      events: member.events.map((event) => {
        const at = new Date(event.at).getTime();
        if (!Number.isFinite(at)) throw new Error('Every state change needs a valid timestamp');
        return { ...event, at };
      }).sort((a, b) => a.at - b.at),
      promises: member.promises.map((p) => ({ ...p, visit_id: member.id })),
      eventIndex: 0,
    };
  });
  const alerts = [];
  const emitted = new Set();
  let covered = false;
  let knownBeforeThreshold = false;
  // Bumped whenever the visit leaves the live statuses, so a cancel -> reopen
  // (or complete -> reopen) cycle can alert again, exactly as production's
  // supersession stamp allows.
  let lifecycle = 0;
  // Whether a card is currently standing, so its automatic supersession can
  // free the key the way production's superseded_at stamp does.
  let alerting = false;
  let lastShape = null;
  let wasLive = members.some((m) => LIVE_STATUSES.includes(m.state.status));
  for (let at = Math.ceil(from.getTime() / 300000) * 300000; at <= to.getTime(); at += 300000) {
    const now = new Date(at);
    for (const member of members) {
      while (member.eventIndex < member.events.length && member.events[member.eventIndex].at <= at) {
        Object.assign(member.state, member.events[member.eventIndex].patch);
        member.eventIndex += 1;
      }
    }
    const memberStates = members.map((m) => m.state);
    // Event LISTS per member, the shape stopPromise needs: it has to see a
    // grouped send even when a later per-service notice displaced it as that
    // member's latest (codex P1 round 24).
    const perMember = new Map(members.map((m) => [String(m.id), m.promises]));
    const promise = stopPromise(memberStates, perMember, now);
    const stop = stopState(memberStates, { now, since: promise?.start_at });
    const liveNow = LIVE_STATUSES.includes(stop.status);
    if (wasLive && !liveNow) lifecycle += 1;
    wasLive = liveNow;
    ({ covered, knownBeforeThreshold } = coverageAt({ covered, knownBeforeThreshold, liveNow, promise, now, at, threshold }));
    // Coverage is measured AT THE DECISION POINTS, not from the final state
    // at `to`: a promise backfilled or communicated after this visit's
    // thresholds passed leaves every production tick before it with nothing
    // usable — reading the end-of-window state instead reported such a visit
    // as covered and understated missing_promise_visits, which is exactly
    // the number that says whether a no-alert backtest means "nothing was
    // wrong" or "we had no evidence to judge with" (codex P1, round 4).
    const alert = evaluateNoShow({ visit: stop, promise, now, stage1Minutes: threshold });
    if (!alert) {
      // Production auto-resolves the card the moment the shape stops
      // matching (an arrival, a changed promise, a stage that no longer
      // applies) and stamps it superseded, which frees the SAME key to be
      // raised again later. Keeping the key suppressed for the rest of the
      // export understated the alert volume a rollout decision is made on
      // (codex P1 round 10) — the same reason the recipient and the live
      // lifecycle are in the key.
      if (alerting) lifecycle += 1;
      alerting = false;
      continue;
    }
    // A SHAPE change while a card is standing is also a supersession in
    // production: the old alert is resolved (stamped) and a new one created,
    // so a later return to the earlier shape is a fresh card, not a
    // duplicate. Shape includes the RECIPIENT, because trackingKey does — an
    // A -> B -> A reassignment gives A a fresh card in production, and a key
    // suppressed for the export hid the second one (codex P1 round 10).
    const shape = `${alert.promised_window.start_at}:${alert.stage}:${stop.technician_id || 'unassigned'}`;
    if (alerting && lastShape && shape !== lastShape) lifecycle += 1;
    lastShape = shape;
    alerting = true;
    // Production's own identity, not a window/stage pair: trackingKey folds
    // in the RECIPIENT, so a reassignment from tech A to B with the same
    // promise and stage mints a fresh card for B (and reconciles A's), and a
    // visit that leaves and re-enters LIVE_STATUSES gets a fresh one too.
    // Deduping on window+stage alone suppressed both and understated the
    // alert volume a rollout decision is made on (codex P2 round 10).
    const key = `${shape}:${lifecycle}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const complaint = new Date(item.complaint_at).getTime();
    alerts.push({ visit_id: item.id, stage: alert.stage, at: now.toISOString(), day: etDateString(now),
      warning_minutes_before_complaint: Number.isFinite(complaint) ? Math.round((complaint - at) / 60000) : null });
  }
  return { alerts, covered };
}

// Production collapses scheduled_services rows sharing a service_visits row
// into ONE stop: one card, one merged tracking state, the latest promise
// across members (no-show-detector.js's groupedStops/stopState/stopPromise).
// An export that carries the constituent rows must be collapsed the same way
// or the report counts duplicate alerts for one truck visit and marks the
// non-owner siblings as missing evidence (codex P2 round 12). Rows carry the
// grouping as `stop_id`; without it each row is its own stop, which is every
// row while GATE_VISIT_GROUPS is off.
function collapseStops(visits = []) {
  const byStop = new Map();
  for (const item of visits) {
    const key = item.stop_id ? `stop:${item.stop_id}` : `row:${item.id}`;
    if (!byStop.has(key)) byStop.set(key, []);
    byStop.get(key).push(item);
  }
  return [...byStop.values()].map((members) => {
    if (members.length === 1) return members[0];
    const ordered = [...members].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const base = ordered[0];
    // The members stay separate — replayVisit merges them at every tick, the
    // way production does — and only the stop-level labels are folded: the
    // outcome any member recorded, and the earliest complaint (they all
    // describe the same physical visit).
    return { id: base.id, initial: base.initial, events: base.events, promises: base.promises, members: ordered,
      outcome: ordered.find((m) => m.outcome && m.outcome !== 'unknown')?.outcome || base.outcome,
      // Earliest by INSTANT, not by string: equivalent times written with
      // different offsets ('…-04:00' vs '…Z') do not sort chronologically as
      // text, which would overstate warning_minutes_before_complaint (codex
      // P2 round 14).
      complaint_at: ordered.map((m) => m.complaint_at).filter((at) => Number.isFinite(new Date(at).getTime()))
        .sort((a, b) => new Date(a) - new Date(b))[0] || null };
  });
}

function replay(input) {
  const from = new Date(input.from), to = new Date(input.to);
  if (!Array.isArray(input.visits) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('A bounded timeline export is required');
  const stops = collapseStops(input.visits);
  const reports = [];
  for (const threshold of [45, 60]) {
    const alerts = [], days = {}, counts = { route_attention: 0, tracking_gap: 0, on_time: 0, unknown: 0 };
    let missingPromise = 0;
    for (const item of stops) {
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
    coverage_days: (to - from) / 86400000, visits: stops.length, thresholds: reports };
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
module.exports = { replay, replayVisit, collapseStops, markdown };
