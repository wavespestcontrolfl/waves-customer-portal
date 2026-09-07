/**
 * The canonical run shape every read adapter under sources/ produces and
 * run-index.js merges. One vocabulary (taxonomy.js) whatever the ledger:
 * a legacy row (autonomous_runs, message_drafts, call_log …) is projected
 * onto the same fields an agent_runs row carries, so the Runs tab and the
 * watchdog read one thing.
 *
 *   {
 *     key: '<source>:<id>', source, id, sourceSystem, sourceRunId,
 *     laneId, workflowId, area, title, subtitle,
 *     lifecycle, result, verification, disposition,
 *     failureClass, errorCode, errorMessage,
 *     createdAt, startedAt, finishedAt, lastHeartbeatAt, lastProgressAt,
 *     pagedAt (the IMMUTABLE stamp run-index orders and pages on — a
 *       source's creation / recording time, never its active span, which
 *       moves when a run resumes or a decision is scheduled; default
 *       createdAt. A TEXT stamp at microsecond precision, YYYY-MM-DDTHH:MM:SS.ffffffZ,
 *       so the cursor compares against the raw column and its index —
 *       see pagedAtColumn),
 *     progressSequence, durationMs, attempts, maxAttempts,
 *     stepsDone, stepsTotal, toolCalls, steps: [{ key, label, status, detail, ms, toolName }],
 *     sideEffectClass, riskTier, link, detail, entity: { type, id } | null,
 *     workItemId, traceId, canonical: bool
 *   }
 *
 * health / attention are added by run-index (health.js) at read time.
 */

const { LANE_AREA } = require('../../model-switchboard');
const { policyFor } = require('../lane-policies');
const { riskTierFor, LIFECYCLE, RESULT, VERIFICATION, DISPOSITION } = require('../taxonomy');

const MISSING_TABLE_SQLSTATE = '42P01';
const UNDEFINED_COLUMN_SQLSTATE = '42703';

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function humanize(value) {
  return String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "model · prompt_version" for a step detail, or null when the row has no
// model stamp (used by every adapter whose ledger records one).
function modelLabel(row, modelKey = 'model', versionKey = 'prompt_version') {
  const model = row[modelKey];
  if (!model) return null;
  const version = row[versionKey];
  return version ? `${model} · ${version}` : model;
}

function durationBetween(startedAt, finishedAt) {
  const a = startedAt ? new Date(startedAt).getTime() : NaN;
  const b = finishedAt ? new Date(finishedAt).getTime() : NaN;
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
}

function areaFor(laneId) {
  return laneId ? LANE_AREA[laneId] || 'office' : 'office';
}

function oneOf(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}

// Every optional field a projection may omit; spread under the caller's
// fields (undefined values stripped first, so an adapter can pass a
// column straight through) — no per-field `|| null`.
const FIELD_DEFAULTS = Object.freeze({
  laneId: null, workflowId: null, area: null, title: null, subtitle: null,
  lifecycle: 'terminal', result: null, verification: 'unjudged', disposition: null,
  failureClass: null, errorCode: null, errorMessage: null,
  createdAt: null, startedAt: null, finishedAt: null, lastHeartbeatAt: null, lastProgressAt: null, pagedAt: null,
  progressSequence: 0, durationMs: null, attempts: null, maxAttempts: 1,
  stepsDone: null, stepsTotal: null, toolCalls: 0, steps: [],
  sideEffectClass: null, link: null, detail: null, entity: null, workItemId: null, traceId: null, canonical: false,
});

function defined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

// null = no limit the producer applies (a call's transcription retry has no cap)
const optionalNumber = (v) => (v == null ? null : Number(v));
const orElse = (v, fallback) => (v == null ? fallback : v);

// The page stamp an adapter selects beside its paging column: that column
// at MICROsecond precision as text (UTC). The cursor carries it back as
// text and the adapter compares the RAW column against it, so the plain
// created_at index serves the keyset scan. A JS Date truncates to ms, and
// the date_trunc'd column that once matched it could not use an index
// (date_trunc on timestamptz is not IMMUTABLE) (Codex r15).
const PAGE_STAMP = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const PAGE_STAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
function pagedAtColumn(db, column) {
  return db.raw(`to_char(?? AT TIME ZONE 'UTC', '${PAGE_STAMP}') AS paged_at`, [column]);
}
// Normalizes a Date / ISO string to the same six-digit form, so stamps from
// every source (and the JS-stamped agent_runs rows) order as one key.
function pageStamp(value) {
  if (typeof value === 'string' && PAGE_STAMP_RE.test(value)) return value;
  const s = iso(value);
  return s && s.replace('Z', '000Z');
}

function canonicalRun(fields) {
  const f = { ...FIELD_DEFAULTS, ...defined(fields) };
  const source = String(f.source);
  const id = String(f.id);
  // policyFor(null) is the default policy, which names no side-effect class
  const sideEffectClass = f.sideEffectClass ?? policyFor(f.laneId).side_effect_class ?? null;
  const lifecycle = oneOf(LIFECYCLE, f.lifecycle, 'terminal');
  const startedAt = orElse(f.startedAt, f.createdAt);
  const entity = f.entity && f.entity.type ? { type: String(f.entity.type), id: f.entity.id == null ? null : String(f.entity.id) } : null;
  return {
    key: `${source}:${id}`,
    source,
    id,
    sourceSystem: f.sourceSystem ?? source,
    sourceRunId: f.sourceRunId ?? id,
    laneId: f.laneId,
    workflowId: f.workflowId,
    area: f.area ?? areaFor(f.laneId),
    title: f.title ?? (humanize(f.laneId ?? f.workflowId) || 'Run'),
    subtitle: f.subtitle,
    lifecycle,
    result: lifecycle === 'terminal' ? oneOf(RESULT, f.result, null) : null,
    verification: oneOf(VERIFICATION, f.verification, 'unjudged'),
    disposition: oneOf(DISPOSITION, f.disposition, null),
    failureClass: f.failureClass,
    errorCode: f.errorCode,
    errorMessage: f.errorMessage,
    createdAt: iso(f.createdAt),
    startedAt: iso(startedAt),
    finishedAt: iso(f.finishedAt),
    lastHeartbeatAt: iso(f.lastHeartbeatAt),
    lastProgressAt: iso(f.lastProgressAt),
    pagedAt: pageStamp(orElse(f.pagedAt, f.createdAt)),
    progressSequence: Number(f.progressSequence),
    durationMs: f.durationMs == null ? durationBetween(startedAt, f.finishedAt) : Number(f.durationMs),
    attempts: Number(f.attempts ?? (lifecycle === 'queued' ? 0 : 1)),
    maxAttempts: optionalNumber(f.maxAttempts),
    stepsDone: Number(f.stepsDone ?? f.steps.filter((s) => s.status === 'done').length),
    stepsTotal: Number(f.stepsTotal ?? f.steps.length),
    toolCalls: Number(f.toolCalls),
    steps: f.steps,
    sideEffectClass,
    riskTier: sideEffectClass ? riskTierFor(sideEffectClass) : null,
    link: f.link,
    detail: f.detail,
    entity,
    workItemId: f.workItemId,
    traceId: f.traceId,
    canonical: !!f.canonical,
  };
}

// Keyset paging every adapter applies the same way: rows order by (`start`
// DESC, id DESC) — `start` is the source's IMMUTABLE paging COLUMN, raw
// (the row's pagedAt: its creation / recording stamp, selected beside it
// by pagedAtColumn), never the active span the row displays as startedAt:
// a span moves (a resume, a scheduled send, a publishing claim), and a
// row that moved across the cursor would repeat on the next page or
// vanish from it (Codex r14). A `cursor` = { at, id } (the last row a
// previous page
// consumed) selects only rows strictly after it in that order. `start` is
// the adapter's start expression truncated to milliseconds so the JS Date
// the cursor carries compares exactly (timestamptz keeps microseconds).
function keyset(query, { start, id, cursor, limit }) {
  if (cursor) {
    query.where((q) => {
      q.where(start, '<', cursor.at);
      q.orWhere((w) => w.where(start, '=', cursor.at).andWhere(id, '<', cursor.id));
    });
  }
  return query.orderBy([{ column: start, order: 'desc' }, { column: id, order: 'desc' }]).limit(limit);
}

// Legacy rows a canonical agent_runs row already mirrors (same
// source_system + source_run_id, S5.x dual-write) are excluded in SQL —
// page-independent, so a mirror and its legacy row can never both appear
// however the pages fall. `idColumn` is the legacy row's id, TABLE-QUALIFIED
// (a bare `id` inside the subquery resolves to agent_runs.id).
function notMirrored(query, { source, idColumn }) {
  return query.whereNotExists(function mirror() {
    this.select(this.client.raw('1')).from('agent_runs')
      .where('agent_runs.source_system', source)
      .whereRaw(`agent_runs.source_run_id = ${idColumn}::text`);
  });
}

// A source that has not been migrated on this deployment (or whose columns
// predate this reader) contributes nothing, reported as unavailable; any
// other failure is thrown — a monitoring surface must never present an
// outage as "nothing ran" (the agent-activity rule).
function isMissingSchema(err) {
  return !!err && (err.code === MISSING_TABLE_SQLSTATE || err.code === UNDEFINED_COLUMN_SQLSTATE);
}

module.exports = { canonicalRun, defined, keyset, notMirrored, pagedAtColumn, pageStamp, iso, humanize, modelLabel, areaFor, isMissingSchema, MISSING_TABLE_SQLSTATE };
