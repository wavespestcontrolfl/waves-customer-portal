/**
 * Resolution-artifact sync — incremental, idempotent sweep that maps
 * unprocessed calls and visits into resolution_artifacts. Runs inside the
 * nightly knowledge-index job (before the embedding sync, so new artifacts
 * are chunked+embedded the same night) and from the backfill script.
 *
 * "Unprocessed" = no resolution_artifacts row for (source, source_id).
 * Tombstones are deliberately NOT used for null-mapped rows (spam, nothing
 * resolved): the mapper is cheap and deterministic, and a later triage
 * resolution can turn a previously-null call into an artifact. The call
 * sweep keyset-paginates so re-examined nulls can't starve the backlog.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { mapCall, mapVisit } = require('./resolution-mapper');
const { preferredRouteDecisionForFeedback } = require('../call-route-decisions');
const { applyCustomerVisibleServiceRecordFilter } = require('../pest-pressure/history-filter');

const DEFAULT_BATCH = 500;
const PAGE_SIZE = 200;
const REFRESH_BATCH = 200;

// Upsert-merge (NOT ignore): a call artifacted before staff closes its
// triage card must pick up the later resolution_note — the refresh pass
// re-maps such calls and this merge applies the new content. The embedding
// layer's hash-diff then re-embeds only genuinely changed chunks.
async function upsertArtifact(artifact) {
  await db('resolution_artifacts')
    .insert({
      source: artifact.source,
      source_id: artifact.sourceId,
      customer_id: artifact.customerId,
      question: artifact.question,
      situation: artifact.situation,
      resolution: artifact.resolution,
      outcome: JSON.stringify(artifact.outcome || {}),
      systems: JSON.stringify(artifact.systems || []),
      occurred_at: artifact.occurredAt,
    })
    .onConflict(['source', 'source_id'])
    .merge(['customer_id', 'question', 'situation', 'resolution', 'outcome', 'systems', 'occurred_at', 'updated_at']);
}

// Batch-load triage notes + the production-representative route action for a
// set of call ids. Route rows use the same preference the feedback path uses
// (enforce over shadow, newer decision versions, then newest) instead of a
// bare created_at sort that could crown a shadow/replay row.
async function loadCallSideData(callIds) {
  // Only RESOLVED cards carry a real corrective resolution — dismissed
  // means no action was needed, open/in_progress aren't outcomes yet.
  const triageRows = await db('triage_items')
    .whereIn('call_log_id', callIds)
    .where({ status: 'resolved' })
    .select('call_log_id', 'reason_code', 'resolution_note');
  const triageByCall = new Map();
  for (const t of triageRows) {
    if (!triageByCall.has(t.call_log_id)) triageByCall.set(t.call_log_id, []);
    triageByCall.get(t.call_log_id).push(t);
  }
  const routeRows = await db('route_decisions')
    .whereIn('call_log_id', callIds)
    .select('call_log_id', 'mode', 'decision_version', 'created_at', 'final_action_taken');
  const routesByCall = new Map();
  for (const r of routeRows) {
    if (!routesByCall.has(r.call_log_id)) routesByCall.set(r.call_log_id, []);
    routesByCall.get(r.call_log_id).push(r);
  }
  const actionByCall = new Map();
  for (const [callId, rows] of routesByCall) {
    const preferred = preferredRouteDecisionForFeedback(rows);
    // Shadow-mode rows record hypothetical candidates (shadow_*_candidate),
    // not actions taken — only enforce-mode decisions are real outcomes.
    if (preferred?.mode === 'enforce' && preferred?.final_action_taken) {
      actionByCall.set(callId, preferred.final_action_taken);
    }
  }
  return { triageByCall, actionByCall };
}

/**
 * Keyset-paginates over ALL unmapped candidates (null-mapped rows have no
 * tombstone and are re-examined by design — a later triage resolution can
 * turn one into an artifact). `limit` caps MAPPED inserts per run, not
 * examined rows, so a prefix of unmappable calls can never starve the rest
 * of the backlog. exhausted=true ⇢ the whole candidate set was examined.
 */
async function syncCallArtifacts({ limit = DEFAULT_BATCH } = {}) {
  const stats = { examined: 0, mapped: 0, skipped: 0, exhausted: false };
  let cursor = null; // { created_at, id }

  while (stats.mapped < limit) {
    let query = db('call_log as c')
      .leftJoin('customers as cu', 'cu.id', 'c.customer_id')
      .whereNotNull('c.ai_extraction_enriched')
      // Schema-failed V2 payloads persist in ai_extraction_enriched for
      // audit; only 'valid' rows may drive behavior (same contract as the
      // estimator context-builder). NULL = legacy pre-V2 rows written by the
      // v1 path — the explicitly trusted fallback.
      .where(function () {
        this.where('c.v2_extraction_status', 'valid').orWhereNull('c.v2_extraction_status');
      })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('resolution_artifacts as ra')
          .whereRaw("ra.source = 'call'").whereRaw('ra.source_id = c.id');
      })
      .orderBy('c.created_at', 'asc')
      .orderBy('c.id', 'asc')
      .limit(PAGE_SIZE)
      .select('c.id', 'c.customer_id', 'c.created_at', 'c.call_summary', 'c.disposition', 'c.ai_extraction_enriched',
        'cu.first_name', 'cu.last_name', 'cu.phone');
    if (cursor) query = query.whereRaw('(c.created_at, c.id) > (?, ?)', [cursor.created_at, cursor.id]);
    const calls = await query;
    if (!calls.length) { stats.exhausted = true; break; }
    cursor = { created_at: calls[calls.length - 1].created_at, id: calls[calls.length - 1].id };

    const { triageByCall, actionByCall } = await loadCallSideData(calls.map((c) => c.id));

    for (const call of calls) {
      if (stats.mapped >= limit) break;
      stats.examined += 1;
      const artifact = mapCall({
        call,
        extraction: call.ai_extraction_enriched,
        triageNotes: triageByCall.get(call.id) || [],
        finalAction: actionByCall.get(call.id) || null,
        context: { first_name: call.first_name, last_name: call.last_name, phone: call.phone },
      });
      if (!artifact) { stats.skipped += 1; continue; }
      await upsertArtifact(artifact);
      stats.mapped += 1;
    }
    if (calls.length < PAGE_SIZE && stats.mapped < limit) { stats.exhausted = true; break; }
  }
  return stats;
}

/**
 * Refresh pass: calls whose triage/route rows changed AFTER their artifact
 * was written get re-mapped, so institutional memory records the actual
 * resolution, not the preliminary disposition. Bounded per run.
 */
async function refreshCallArtifacts() {
  const stats = { refreshed: 0, retired: 0 };
  const stale = await db('resolution_artifacts as ra')
    .where('ra.source', 'call')
    .where(function () {
      this.whereExists(function () {
        this.select(db.raw('1')).from('triage_items as ti')
          .whereRaw('ti.call_log_id = ra.source_id')
          .whereRaw('ti.updated_at > ra.updated_at');
      }).orWhereExists(function () {
        this.select(db.raw('1')).from('route_decisions as rd')
          .whereRaw('rd.call_log_id = ra.source_id')
          .whereRaw('rd.created_at > ra.updated_at');
      }).orWhereExists(function () {
        // The call row itself was re-stamped or invalidated (force-reprocess
        // clears ai_extraction_enriched on implausible transcripts) — the
        // null re-map then retires the artifact.
        this.select(db.raw('1')).from('call_log as c')
          .whereRaw('c.id = ra.source_id')
          .where(function () {
            this.whereNull('c.ai_extraction_enriched').orWhereRaw('c.updated_at > ra.updated_at');
          });
      }).orWhereNotExists(function () {
        // Spam-marked calls get their call_log row DELETED — the orphan
        // artifact must retire with it.
        this.select(db.raw('1')).from('call_log as c')
          .whereRaw('c.id = ra.source_id');
      });
    })
    .limit(REFRESH_BATCH)
    .select('ra.source_id');
  if (!stale.length) return stats;

  const calls = await db('call_log as c')
    .leftJoin('customers as cu', 'cu.id', 'c.customer_id')
    .whereIn('c.id', stale.map((r) => r.source_id))
    .select('c.id', 'c.customer_id', 'c.created_at', 'c.call_summary', 'c.disposition', 'c.v2_extraction_status', 'c.ai_extraction_enriched',
      'cu.first_name', 'cu.last_name', 'cu.phone');
  // Deleted call rows (spam purge) orphan their artifacts — retire them.
  const fetchedCallIds = new Set(calls.map((c) => c.id));
  for (const row of stale) {
    if (fetchedCallIds.has(row.source_id)) continue;
    await db('resolution_artifacts').where({ source: 'call', source_id: row.source_id }).del();
    stats.retired += 1;
  }
  const { triageByCall, actionByCall } = await loadCallSideData(calls.map((c) => c.id));
  for (const call of calls) {
    // Fail closed on invalid V2 payloads (schema_failed/parse_failed persist
    // for audit but must not drive behavior) — null extraction retires.
    const extractionValid = call.v2_extraction_status === 'valid' || call.v2_extraction_status == null;
    const artifact = mapCall({
      call,
      extraction: extractionValid ? call.ai_extraction_enriched : null,
      triageNotes: triageByCall.get(call.id) || [],
      finalAction: actionByCall.get(call.id) || null,
      context: { first_name: call.first_name, last_name: call.last_name, phone: call.phone },
    });
    if (!artifact) {
      // Retire: current source data no longer yields an artifact (e.g. a
      // later terminal disposition stamped it spam) — stale memory must not
      // keep serving. The next knowledge-index sync drops its chunks.
      await db('resolution_artifacts').where({ source: 'call', source_id: call.id }).del();
      stats.retired += 1;
      continue;
    }
    await upsertArtifact(artifact);
    stats.refreshed += 1;
  }
  return stats;
}

// ── Visit-side shared helpers ───────────────────────────────────────

// Recommendations live in three homes (verified against the admin-dispatch
// completion flow): service_findings.recommendation (service-report flow),
// structured_notes.recommendations, and service_data.protocol.recommendations
// (ordinary closeouts persist reportRecommendations at BOTH of the latter).
function visitRecommendationPredicate() {
  this.whereExists(function () {
    this.select(db.raw('1')).from('service_findings as sf')
      .whereRaw('sf.service_record_id = sr.id').whereNotNull('sf.recommendation');
  })
    // Type-guarded: legacy rows can store recommendations as a scalar string,
    // and jsonb_array_length on a scalar THROWS. Scalars are admitted (the
    // extractor wraps them); only the array-length test needs the guard.
    .orWhereRaw("(jsonb_typeof(sr.structured_notes->'recommendations') = 'array' AND jsonb_array_length(sr.structured_notes->'recommendations') > 0)")
    .orWhereRaw("jsonb_typeof(sr.structured_notes->'recommendations') = 'string'")
    .orWhereRaw("(jsonb_typeof(sr.service_data->'protocol'->'recommendations') = 'array' AND jsonb_array_length(sr.service_data->'protocol'->'recommendations') > 0)")
    .orWhereRaw("jsonb_typeof(sr.service_data->'protocol'->'recommendations') = 'string'");
}

const parseJsonbMaybe = (v) => {
  if (!v) return {};
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return {}; }
};

function structuredRecommendationsFor(record) {
  const notes = parseJsonbMaybe(record.structured_notes);
  const serviceData = parseJsonbMaybe(record.service_data);
  const asArray = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v] : []));
  const fromNotes = asArray(notes?.recommendations);
  const fromServiceData = asArray(serviceData?.protocol?.recommendations);
  return [...new Set([...fromNotes, ...fromServiceData].map((r) => String(r || '').trim()).filter(Boolean))];
}

async function loadVisitSideData(recordIds) {
  const findingRows = await db('service_findings')
    .whereIn('service_record_id', recordIds)
    .select('service_record_id', 'category', 'severity', 'title', 'detail', 'recommendation');
  const findingsByRecord = new Map();
  for (const f of findingRows) {
    if (!findingsByRecord.has(f.service_record_id)) findingsByRecord.set(f.service_record_id, []);
    findingsByRecord.get(f.service_record_id).push(f);
  }
  // Writer stores 'fallback' or 'hidden'; table default is 'generated' —
  // there is no 'ready'. Admit everything except hidden.
  // Corrected reports leave several non-hidden summaries per visit — order
  // newest-first and keep the first seen per record (deterministic).
  const summaries = await db('service_report_ai_summaries')
    .whereIn('service_record_id', recordIds)
    .whereNotIn('status', ['hidden'])
    // Treatment-narrative rows share this table (prompt_version
    // treatment_narrative_v1, JSON {text}) but are hero copy, not the visit
    // AI summary — without this filter a newer narrative row shadows the
    // real summary out of resolution search (codex P2 2026-07-22).
    .where((q) => q.whereNull('prompt_version').orWhere('prompt_version', 'not like', 'treatment_narrative%'))
    .orderBy('updated_at', 'desc')
    .select('service_record_id', 'summary_json')
    .catch(() => []);
  const summaryByRecord = new Map();
  for (const s of summaries) {
    if (!summaryByRecord.has(s.service_record_id)) summaryByRecord.set(s.service_record_id, parseJsonbMaybe(s.summary_json));
  }
  return { findingsByRecord, summaryByRecord };
}

const VISIT_SELECT = ['sr.id', 'sr.customer_id', 'sr.service_date', 'sr.created_at', 'sr.service_type', 'sr.technician_notes', 'sr.structured_notes', 'sr.service_data',
  'cu.first_name', 'cu.last_name', 'cu.phone'];

function mapVisitRecord(record, { findingsByRecord, summaryByRecord }) {
  return mapVisit({
    record,
    findings: findingsByRecord.get(record.id) || [],
    structuredRecommendations: structuredRecommendationsFor(record),
    aiSummary: summaryByRecord.get(record.id) || null,
    context: { first_name: record.first_name, last_name: record.last_name, phone: record.phone },
  });
}

/**
 * Keyset-paginated like the call sweep (limit caps MAPPED rows): a page of
 * candidates whose recommendations all clean to empty strings must advance
 * the cursor, never respin the same oldest rows forever.
 */
async function syncVisitArtifacts({ limit = DEFAULT_BATCH } = {}) {
  const stats = { examined: 0, mapped: 0, skipped: 0, exhausted: false };
  let cursor = null;

  while (stats.mapped < limit) {
    let query = db('service_records as sr')
      .leftJoin('customers as cu', 'cu.id', 'sr.customer_id')
      // Same scope every service-history reader uses — an incomplete or
      // office-handoff visit is not a resolved past visit, and internal-only
      // completions (typedReportDelivery frozen non-auto_send) stay hidden.
      .where('sr.status', 'completed')
      .modify((qb) => applyCustomerVisibleServiceRecordFilter(qb, { alias: 'sr' }))
      .where(visitRecommendationPredicate)
      .whereNotExists(function () {
        this.select(db.raw('1')).from('resolution_artifacts as ra')
          .whereRaw("ra.source = 'visit'").whereRaw('ra.source_id = sr.id');
      })
      .orderBy('sr.created_at', 'asc')
      .orderBy('sr.id', 'asc')
      .limit(PAGE_SIZE)
      .select(...VISIT_SELECT);
    if (cursor) query = query.whereRaw('(sr.created_at, sr.id) > (?, ?)', [cursor.created_at, cursor.id]);
    const records = await query;
    if (!records.length) { stats.exhausted = true; break; }
    cursor = { created_at: records[records.length - 1].created_at, id: records[records.length - 1].id };

    const side = await loadVisitSideData(records.map((r) => r.id));
    for (const record of records) {
      if (stats.mapped >= limit) break;
      stats.examined += 1;
      const artifact = mapVisitRecord(record, side);
      if (!artifact) { stats.skipped += 1; continue; }
      await upsertArtifact(artifact);
      stats.mapped += 1;
    }
    if (records.length < PAGE_SIZE && stats.mapped < limit) { stats.exhausted = true; break; }
  }
  return stats;
}

/**
 * Visit refresh: artifacts whose report summaries or findings changed after
 * artifacting get re-mapped (summaries generate late; recommendations get
 * corrected). Null re-map retires the artifact, same as calls.
 */
async function refreshVisitArtifacts() {
  const stats = { refreshed: 0, retired: 0 };
  const stale = await db('resolution_artifacts as ra')
    .where('ra.source', 'visit')
    .where(function () {
      this.whereExists(function () {
        this.select(db.raw('1')).from('service_report_ai_summaries as s')
          .whereRaw('s.service_record_id = ra.source_id')
          .whereRaw('s.updated_at > ra.updated_at');
      }).orWhereExists(function () {
        this.select(db.raw('1')).from('service_findings as sf')
          .whereRaw('sf.service_record_id = ra.source_id')
          .whereRaw('sf.created_at > ra.updated_at');
      }).orWhereNotExists(function () {
        // Record deleted, demoted out of completed, or made customer-hidden
        // — enters the stale set so the fetch-miss branch retires it.
        this.select(db.raw('1')).from('service_records as sr')
          .whereRaw('sr.id = ra.source_id')
          .where('sr.status', 'completed')
          .whereRaw("COALESCE(sr.structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'");
      });
    })
    .limit(REFRESH_BATCH)
    .select('ra.source_id');
  if (!stale.length) return stats;

  const records = await db('service_records as sr')
    .leftJoin('customers as cu', 'cu.id', 'sr.customer_id')
    .whereIn('sr.id', stale.map((r) => r.source_id))
    .where('sr.status', 'completed')
    .modify((qb) => applyCustomerVisibleServiceRecordFilter(qb, { alias: 'sr' }))
    .select(...VISIT_SELECT);
  // Stale artifacts whose record fell out of 'completed' scope retire too.
  const fetchedIds = new Set(records.map((r) => r.id));
  for (const row of stale) {
    if (fetchedIds.has(row.source_id)) continue;
    await db('resolution_artifacts').where({ source: 'visit', source_id: row.source_id }).del();
    stats.retired += 1;
  }
  const side = await loadVisitSideData(records.map((r) => r.id));
  for (const record of records) {
    const artifact = mapVisitRecord(record, side);
    if (!artifact) {
      await db('resolution_artifacts').where({ source: 'visit', source_id: record.id }).del();
      stats.retired += 1;
      continue;
    }
    await upsertArtifact(artifact);
    stats.refreshed += 1;
  }
  return stats;
}

async function syncResolutionArtifacts(options = {}) {
  const calls = await syncCallArtifacts(options);
  const visits = await syncVisitArtifacts(options);
  const refresh = await refreshCallArtifacts();
  const visitRefresh = await refreshVisitArtifacts();
  const summary = { calls, visits, refresh, visitRefresh };
  logger.info(`[resolution-sync] ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { syncResolutionArtifacts, syncCallArtifacts, syncVisitArtifacts, refreshCallArtifacts, refreshVisitArtifacts, structuredRecommendationsFor };
