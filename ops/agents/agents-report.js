/**
 * agents-report.js — READ-ONLY
 *
 * The Agents hub Control center, printed in a terminal. Owner ruling
 * 2026-10-02: the terminal is the cockpit for the portal's AI and the Admin →
 * Agents UI is frozen, so the per-lane readout lives here instead of a screen.
 *
 *   railway run --service Postgres node ops/agents/agents-report.js
 *   railway run --service Postgres node ops/agents/agents-report.js --window=today   (today | 7d | 30d)
 *   railway run --service Postgres node ops/agents/agents-report.js --all           (idle lanes too)
 *   railway run --service Postgres node ops/agents/agents-report.js --json
 *
 * Reads exactly what the Control center reads, through the same modules —
 * server/services/agent-control/hub-read.js (readAreas / readLanes over the
 * call ledger + the model switchboard) and services/llm-cost.js (estimated
 * spend, unpriced calls) — so the numbers here and in the hub can never
 * disagree. Then two "waiting on you" counts: unlabeled typed-decision
 * reviews (decision_reviews, the daily review item's own window) and content
 * email approvals still awaiting a reply.
 *
 * Connection: run under `railway run --service Postgres`, where DATABASE_URL
 * is the unreachable internal host — the script points the app's knexfile at
 * DATABASE_PUBLIC_URL (ops/agents/README.md recipe). The Postgres service does
 * not carry the portal's GATE_* variables, so this process sets the four READ
 * gates the hub modules consult for itself — cost tracking, dispatch metrics,
 * the ops queue and the Activity feed (the last two are where a lane's
 * "needs attention" reasons come from; without them a failed run would read
 * as merely active): that changes nothing in production — each only decides
 * whether this process reads that source. Nothing here writes.
 */

if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/agents-report.js');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
// The app's module-load warnings (push providers not configured, …) are noise here.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.GATE_LLM_COST_TRACKING = 'true';
process.env.GATE_LLM_DISPATCH_METRICS = 'true';
process.env.GATE_ADMIN_OPS_QUEUE = 'true';
process.env.GATE_AGENT_ACTIVITY = 'true';

const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
const db = require(path.join(SERVER, 'models', 'db'));
const { readAreas, readLanes } = require(path.join(SERVER, 'services', 'agent-control', 'hub-read'));
const { REVIEW_WINDOW_DAYS } = require(path.join(SERVER, 'services', 'typed-decisions', 'daily-review-item'));
const { etDateString, addETDays, parseETDateTime } = require(path.join(SERVER, 'utils', 'datetime-et'));

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const WINDOW = ['today', '7d', '30d'].includes(args.window) ? args.window : '7d';
const SHOW_ALL = args.all === true;
const JSON_OUT = args.json === true;

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const ms = (v) => (v == null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const usd = (v) => (v == null ? '—' : v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));
const pad = (s, w, right = false) => { s = String(s); return right ? s.padStart(w) : s.padEnd(w); };

function table(headers, rows, rightCols = new Set()) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i], rightCols.has(i))).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

async function waitingOnYou(now) {
  // The daily review item's own cutoff: ET midnight, REVIEW_WINDOW_DAYS calendar
  // days back — so this count and the owner's review queue agree on the boundary day.
  const since = parseETDateTime(`${etDateString(addETDays(now, -REVIEW_WINDOW_DAYS))}T00:00:00`);
  const [typed, approvals] = await Promise.all([
    db('decision_reviews').where({ label_status: 'unreviewed' }).whereIn('sampled_for', ['disagreement', 'random_audit'])
      .where('created_at', '>=', since).count({ n: '*' }).first().then((r) => Number(r?.n || 0)).catch(() => null),
    db('content_email_approvals').where({ status: 'awaiting_reply' }).count({ n: '*' }).first()
      .then((r) => Number(r?.n || 0)).catch(() => null),
  ]);
  return { typedDecisionLabels: typed, contentEmailApprovals: approvals };
}

async function main() {
  const now = new Date();
  const [areas, lanes, waiting] = await Promise.all([readAreas({ window: WINDOW, now }), readLanes({ window: WINDOW, now }), waitingOnYou(now)]);
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ window: WINDOW, generatedAt: now.toISOString(), basis: lanes.basis, areas: areas.areas, lanes: lanes.lanes, waiting }, null, 2)}\n`);
    return;
  }
  const basis = lanes.basis || {};
  const costNote = basis.cost == null ? 'cost: unavailable' : basis.cost.priced === false ? 'cost: waiting for the first price pull' : null;
  console.log(`Agents report — ${WINDOW} — ${now.toISOString()}${costNote ? `  (${costNote})` : ''}`);
  console.log(`lanes: ${lanes.counts.active} active, ${lanes.counts.attention} need attention, ${lanes.counts.idle} idle\n`);

  const areaRows = areas.areas.filter((a) => a.calls > 0 || SHOW_ALL).map((a) => [
    a.label, a.calls, pct(a.okRate), pct(a.fallbackRate), ms(a.p95LatencyMs), usd(a.estCostUsd),
    Object.entries(a.attention).filter(([, n]) => n > 0).map(([p, n]) => `${p}:${n}`).join(' ') || '',
  ]);
  console.log(table(['area', 'calls', 'ok', 'fallback', 'p95', 'est $', 'attention'], areaRows, new Set([1, 2, 3, 4, 5])));

  const laneRows = lanes.lanes.filter((l) => l.status !== 'idle' || SHOW_ALL).map((l) => [
    l.status === 'attention' ? '!' : l.status === 'active' ? '' : '·',
    l.id, l.area, l.calls, pct(l.okRate), pct(l.fallbackRate), ms(l.p50LatencyMs), ms(l.p95LatencyMs),
    `${k(l.tokens.input + l.tokens.cachedInput)}/${k(l.tokens.output)}`,
    usd(l.estCostUsd), l.unpricedCalls == null ? '—' : l.unpricedCalls,
    l.attentionReasons.map((r) => r.detail || r.kind).join('; '),
  ]);
  console.log(`\n${table(['', 'lane', 'area', 'calls', 'ok', 'fb', 'p50', 'p95', 'tok in/out', 'est $', 'unpriced', 'why'], laneRows, new Set([3, 4, 5, 6, 7, 8, 9, 10]))}`);

  const unpriced = lanes.lanes.filter((l) => (l.unpricedCalls || 0) > 0);
  if (unpriced.length) console.log(`\nunpriced calls (model-name matching to check): ${unpriced.map((l) => `${l.id} ${l.unpricedCalls}`).join(', ')}`);

  const w = waiting;
  const items = [];
  if (w.typedDecisionLabels == null) items.push('typed-decision labels: unreadable');
  else if (w.typedDecisionLabels > 0) items.push(`${w.typedDecisionLabels} typed-decision review${w.typedDecisionLabels === 1 ? '' : 's'} unlabeled (last ${REVIEW_WINDOW_DAYS} days)`);
  if (w.contentEmailApprovals == null) items.push('content email approvals: unreadable');
  else if (w.contentEmailApprovals > 0) items.push(`${w.contentEmailApprovals} content email approval${w.contentEmailApprovals === 1 ? '' : 's'} awaiting your reply`);
  console.log(`\nwaiting on you: ${items.length ? items.join('; ') : 'nothing'}`);
}

main()
  .then(() => db.destroy())
  .catch((err) => { console.error(`agents-report failed: ${err.message}`); return db.destroy().finally(() => process.exit(1)); });
