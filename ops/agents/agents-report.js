/**
 * agents-report.js — READ-ONLY
 *
 * The Agents hub Control center, printed in a terminal. Owner ruling
 * 2026-10-02: the terminal is the cockpit for the portal's AI and the Admin →
 * Agents UI is frozen, so the per-lane readout lives here instead of a screen.
 *
 *   railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/agents-report.js
 *     --window=today|7d|30d   (default 7d)
 *     --all                   idle lanes too
 *     --json
 *   (`~/.claude/bin/agents-report` is that command.)
 *
 * NESTED on purpose: the outer run supplies DATABASE_PUBLIC_URL (only the
 * Postgres service has it — the portal's DATABASE_URL is the unreachable
 * internal host, so it is remapped onto the app's knexfile), the inner run
 * supplies the portal's own variables — every GATE_* and MODEL_* pin — so the
 * app's gate readers and the model switchboard resolve exactly what
 * production resolves. Run without the portal service the script still
 * works but says so: gate lines read "unknown", the typed-decision and
 * approval queues are not counted, and --json carries no model fields.
 *
 * One snapshot: hub-read.js loadHub (the Control center's own read of the
 * call ledger + switchboard) feeds BOTH the area and the lane view, exactly
 * as readAreas / readLanes build them, so the two cannot disagree and the
 * production reads run once. Cost (estimated spend, unpriced calls) comes
 * from llm-cost.js through the same path. Then two "waiting on you" counts:
 * unlabeled typed-decision reviews (the daily review item's own ET window)
 * and content email approvals that went out and await a reply — each only
 * while its surface is live by the app's own gate reader.
 *
 * Read gates: the hub modules read the ops queue, the Activity feed, the cost
 * table and the stored chain rows only under their gates. The portal's live
 * values are captured first (and printed), then those four are switched on
 * for this read-only process so every stored row is read whatever the
 * recorder does — each only decides whether this process reads that source.
 * Nothing here writes.
 */

if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/agents-report.js');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
// Modules load at `error` (push providers, GBP and the like announce
// themselves as warnings); the level returns to `warn` for the reads, where
// hub-read / ops-queue report an unreadable source only as a warning and
// that warning is the report's own signal.
process.env.LOG_LEVEL = 'error';

// stdout is the report only (with --json, one document a consumer parses).
// App modules print at load and inside reads with console.log as well as the
// winston logger, so console output goes to stderr for the whole process and
// the report writes to stdout directly.
const out = (line = '') => process.stdout.write(`${line}\n`);
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

const path = require('path');
const SERVER = path.join(__dirname, '..', '..', 'server');
// The logger first, every record routed to stderr BEFORE any other app
// module loads, so no module-load line can reach stdout.
const logger = require(path.join(SERVER, 'services', 'logger'));
for (const t of logger.transports) if (t.name === 'console') t.stderrLevels = Object.fromEntries(Object.keys(logger.levels).map((l) => [l, true]));

// Whether this process carries the portal's variables (the inner nested run).
const PORTAL_ENV = process.env.RAILWAY_SERVICE_NAME === 'waves-customer-portal';
// Live gate state through the app's own readers — exact production semantics
// (contentEmailApprovals is the exact string 'true'; the ledger gates take
// 1/true/on) — captured BEFORE the read gates below are switched on.
const featureGates = require(path.join(SERVER, 'config', 'feature-gates'));
const live = PORTAL_ENV ? {
  ledgerRecording: featureGates.gateEnvValue('GATE_LLM_CALL_LEDGER'),
  chainRecording: featureGates.gateEnvValue('GATE_LLM_DISPATCH_METRICS'),
  typedDecisions: featureGates.typedDecisionsLive(),
  contentEmailApprovals: featureGates.isEnabled('contentEmailApprovals'),
} : { ledgerRecording: null, chainRecording: null, typedDecisions: null, contentEmailApprovals: null };
for (const gate of ['GATE_LLM_COST_TRACKING', 'GATE_LLM_DISPATCH_METRICS', 'GATE_ADMIN_OPS_QUEUE', 'GATE_AGENT_ACTIVITY']) process.env[gate] = 'true';

const db = require(path.join(SERVER, 'models', 'db'));
const hub = require(path.join(SERVER, 'services', 'agent-control', 'hub-read'));
const { AREAS } = require(path.join(SERVER, 'services', 'model-switchboard'));
const { REVIEW_WINDOW_DAYS } = require(path.join(SERVER, 'services', 'typed-decisions', 'daily-review-item'));
const { etDateString, addETDays, parseETDateTime } = require(path.join(SERVER, 'utils', 'datetime-et'));

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
// Default only when the flag is absent; an explicit unsupported value fails,
// as the hub readers themselves do, rather than silently reporting 7d.
const WINDOW = args.window == null ? '7d' : args.window;
if (!['today', '7d', '30d'].includes(WINDOW)) {
  console.error(`agents-report: --window must be today, 7d or 30d (got ${JSON.stringify(WINDOW)})`);
  process.exit(2);
}
const SHOW_ALL = args.all === true;
const JSON_OUT = args.json === true;
const STATUS_RANK = { attention: 0, active: 1, idle: 2 };

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const ms = (v) => (v == null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(0)}s` : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const usd = (v) => (v == null ? '—' : v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n));
const pad = (s, w, right = false) => { s = String(s); return right ? s.padStart(w) : s.padEnd(w); };
const gateWord = (v) => (v == null ? 'unknown' : v ? 'on' : 'OFF');
const hasAttention = (att) => Object.values(att || {}).some((n) => n > 0);
const attentionCell = (att) => Object.entries(att || {}).filter(([, n]) => n > 0).map(([p, n]) => `${p}:${n}`).join(' ') || '';

function table(headers, rows, rightCols = new Set()) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i], rightCols.has(i))).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

// The Control center's two views from ONE loadHub snapshot — the same
// assembly readAreas / readLanes do, minus the second read.
async function snapshot(now) {
  const window = hub.resolveWindow(WINDOW, now);
  const { ledger, laneRows, cost, activityUnavailableSources } = await hub.loadHub(window, now);
  ledger.areaLatency = await hub.areaLatency(window.from, window.to, laneRows.map((l) => [l.id, l.area]));
  const areas = hub.buildAreas({ areas: AREAS, laneRows, window, ledger });
  const counts = { all: laneRows.length, active: 0, attention: 0, idle: 0 };
  for (const l of laneRows) counts[l.status] += 1;
  const lanes = [...laneRows].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.calls - a.calls || a.name.localeCompare(b.name));
  return { window, cost, areas, lanes, counts, activityUnavailableSources: activityUnavailableSources || [] };
}

async function waitingOnYou(now) {
  // The daily review item's own cutoff: ET midnight, REVIEW_WINDOW_DAYS calendar
  // days back — so this count and the owner's review queue agree on the boundary day.
  const since = parseETDateTime(`${etDateString(addETDays(now, -REVIEW_WINDOW_DAYS))}T00:00:00`);
  const count = (q) => q.count({ n: '*' }).first().then((r) => Number(r?.n || 0)).catch(() => null);
  const [typed, approvals] = await Promise.all([
    // Dark surface (routes 404, no review item raised) = nothing to act on.
    live.typedDecisions !== true ? live.typedDecisions : count(db('decision_reviews')
      .where({ label_status: 'unreviewed' }).whereIn('sampled_for', ['disagreement', 'random_audit']).where('created_at', '>=', since)),
    // Gate off = replies are never polled or executed; and only approvals whose
    // email actually went out (email_sent_at is stamped after SMTP confirms).
    live.contentEmailApprovals !== true ? live.contentEmailApprovals : count(db('content_email_approvals')
      .where({ status: 'awaiting_reply' }).whereNotNull('email_sent_at')),
  ]);
  return { typedDecisionLabels: typed, contentEmailApprovals: approvals };
}

// Integrations the reads load lazily announce themselves as warnings too
// (push providers, GBP); those are not about a source this report reads.
const STARTUP_NOISE = /^\[(apns|fcm|push|gbp)\]/;
const rawWarn = logger.warn.bind(logger);
logger.warn = (msg, ...rest) => (typeof msg === 'string' && STARTUP_NOISE.test(msg) ? logger : rawWarn(msg, ...rest));

// Switchboard fields resolve from THIS process's env: real only under the
// portal's variables. Without them they are registry defaults, so they are
// left out of --json rather than presented as live.
const MODEL_FIELDS = ['modelNow', 'backup', 'retry', 'selector', 'via', 'envVar'];
const stripModelFields = (lane) => Object.fromEntries(Object.entries(lane).filter(([key]) => !MODEL_FIELDS.includes(key)));

async function main() {
  logger.level = 'warn';
  if (!PORTAL_ENV) logger.warn('[agents-report] portal variables not present (run the nested railway command): gates read unknown, queues not counted, model fields omitted');
  const now = new Date();
  const [snap, waiting] = await Promise.all([snapshot(now), waitingOnYou(now)]);
  const areas = snap.areas.filter((a) => a.calls > 0 || hasAttention(a.attention) || SHOW_ALL);
  const lanes = snap.lanes.filter((l) => l.status !== 'idle' || SHOW_ALL);
  const costNote = snap.cost == null ? 'cost: unavailable' : snap.cost.priced === false ? 'cost: waiting for the first price pull' : null;

  if (JSON_OUT) {
    const basis = {
      window: { key: snap.window.key, from: snap.window.from.toISOString(), to: snap.window.to.toISOString(), unit: snap.window.unit },
      priorAvailable: snap.window.priorAvailable,
      // The portal's live recorder gates (null = not run under the portal service).
      ledgerRecording: live.ledgerRecording,
      chainRecording: live.chainRecording,
      portalEnv: PORTAL_ENV,
      // Activity tables the feed could not read: the Activity half of every
      // attention count is incomplete when this is non-empty.
      activityUnavailableSources: snap.activityUnavailableSources,
      cost: snap.cost ? { estimate: true, priced: snap.cost.priced, pricesFetchedAt: snap.cost.pricesFetchedAt ? new Date(snap.cost.pricesFetchedAt).toISOString() : null } : null,
    };
    out(JSON.stringify({ window: WINDOW, generatedAt: now.toISOString(), basis, counts: snap.counts, areas, lanes: PORTAL_ENV ? lanes : lanes.map(stripModelFields), waiting }, null, 2));
    return;
  }

  out(`Agents report — ${WINDOW} — ${now.toISOString()}${costNote ? `  (${costNote})` : ''}`);
  out(`lanes: ${snap.counts.active} active, ${snap.counts.attention} need attention, ${snap.counts.idle} idle`);
  out(`recording (portal gates): ledger ${gateWord(live.ledgerRecording)}, chains ${gateWord(live.chainRecording)}${live.chainRecording === false ? ' — fallback rates cover only what was recorded' : ''}`);
  if (snap.activityUnavailableSources.length) out(`attention is PARTIAL: Activity feed could not read ${snap.activityUnavailableSources.join(', ')}`);
  out();

  const areaRows = areas.map((a) => [
    a.label, a.calls, pct(a.okRate), pct(a.fallbackRate), ms(a.p95LatencyMs), usd(a.estCostUsd),
    `${attentionCell(a.attention)}${a.tokensUnknownRows > 0 ? ` (+${a.tokensUnknownRows} rows no usage)` : ''}`.trim(),
  ]);
  out(table(['area', 'calls', 'ok', 'fallback', 'p95', 'est $', 'attention'], areaRows, new Set([1, 2, 3, 4, 5])));

  const laneRows = lanes.map((l) => [
    l.status === 'attention' ? '!' : l.status === 'active' ? '' : '·',
    l.id, l.area, l.calls, pct(l.okRate), pct(l.fallbackRate), ms(l.p50LatencyMs), ms(l.p95LatencyMs),
    // The ledger's own counters, never summed: cached input is inside the
    // input count for OpenAI / Gemini and beside it for Anthropic; cache
    // writes and reasoning / thought tokens are recorded apart (llm-cost.js).
    // "+N?" = rows whose usage could not be read; the sums are partial.
    `${k(l.tokens.input)}/${k(l.tokens.cachedInput)}/${k(l.tokens.cacheWrite)}/${k(l.tokens.output)}/${k(l.tokens.reasoning)}${l.tokens.unknownRows > 0 ? ` +${l.tokens.unknownRows}?` : ''}`,
    usd(l.estCostUsd), l.unpricedCalls == null ? '—' : l.unpricedCalls,
    l.attentionReasons.map((r) => r.detail || r.kind).join('; '),
  ]);
  out(`\n${table(['', 'lane', 'area', 'calls', 'ok', 'fb', 'p50', 'p95', 'tok in/cached/cw/out/think', 'est $', 'unpriced', 'why'], laneRows, new Set([3, 4, 5, 6, 7, 8, 9, 10]))}`);

  const noUsage = snap.lanes.filter((l) => l.tokens.unknownRows > 0);
  if (noUsage.length) out(`\ntoken sums are partial (+N? = calls whose usage could not be read): ${noUsage.map((l) => `${l.id} ${l.tokens.unknownRows}`).join(', ')}`);
  const unpriced = snap.lanes.filter((l) => (l.unpricedCalls || 0) > 0);
  if (unpriced.length) out(`\nunpriced calls (model-name matching to check): ${unpriced.map((l) => `${l.id} ${l.unpricedCalls}`).join(', ')}`);

  const w = waiting;
  const items = [];
  if (w.typedDecisionLabels === false) items.push('typed decisions: review surface off (gate off)');
  else if (w.typedDecisionLabels == null) items.push(PORTAL_ENV ? 'typed-decision labels: unreadable' : 'typed decisions: unknown (no portal variables)');
  else if (w.typedDecisionLabels > 0) items.push(`${w.typedDecisionLabels} typed-decision review${w.typedDecisionLabels === 1 ? '' : 's'} unlabeled (last ${REVIEW_WINDOW_DAYS} days)`);
  if (w.contentEmailApprovals === false) items.push('content email approvals: off (gate off)');
  else if (w.contentEmailApprovals == null) items.push(PORTAL_ENV ? 'content email approvals: unreadable' : 'content email approvals: unknown (no portal variables)');
  else if (w.contentEmailApprovals > 0) items.push(`${w.contentEmailApprovals} content email approval${w.contentEmailApprovals === 1 ? '' : 's'} awaiting your reply`);
  out(`\nwaiting on you: ${items.length ? items.join('; ') : 'nothing'}`);
}

main()
  .then(() => db.destroy())
  .catch((err) => { console.error(`agents-report failed: ${err.message}`); return db.destroy().finally(() => process.exit(1)); });
