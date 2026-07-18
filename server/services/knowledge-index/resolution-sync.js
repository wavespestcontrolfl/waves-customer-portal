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

const DEFAULT_BATCH = 500;
const PAGE_SIZE = 200;

async function insertArtifact(artifact) {
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
    .ignore();
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
      .whereNotExists(function () {
        this.select(db.raw('1')).from('resolution_artifacts as ra')
          .whereRaw("ra.source = 'call'").whereRaw('ra.source_id = c.id');
      })
      .orderBy('c.created_at', 'asc')
      .orderBy('c.id', 'asc')
      .limit(PAGE_SIZE)
      .select('c.id', 'c.customer_id', 'c.created_at', 'c.call_summary', 'c.ai_extraction_enriched',
        'cu.first_name', 'cu.last_name', 'cu.phone');
    if (cursor) query = query.whereRaw('(c.created_at, c.id) > (?, ?)', [cursor.created_at, cursor.id]);
    const calls = await query;
    if (!calls.length) { stats.exhausted = true; break; }
    cursor = { created_at: calls[calls.length - 1].created_at, id: calls[calls.length - 1].id };

    const callIds = calls.map((c) => c.id);
    const triageRows = await db('triage_items')
      .whereIn('call_log_id', callIds)
      .select('call_log_id', 'reason_code', 'resolution_note');
    const triageByCall = new Map();
    for (const t of triageRows) {
      if (!triageByCall.has(t.call_log_id)) triageByCall.set(t.call_log_id, []);
      triageByCall.get(t.call_log_id).push(t);
    }
    const routeRows = await db('route_decisions')
      .whereIn('call_log_id', callIds)
      .whereNotNull('final_action_taken')
      .orderBy('created_at', 'desc')
      .select('call_log_id', 'final_action_taken');
    const actionByCall = new Map();
    for (const r of routeRows) if (!actionByCall.has(r.call_log_id)) actionByCall.set(r.call_log_id, r.final_action_taken);

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
      await insertArtifact(artifact);
      stats.mapped += 1;
    }
    if (calls.length < PAGE_SIZE && stats.mapped < limit) { stats.exhausted = true; break; }
  }
  return stats;
}

// Visit candidates require an existing recommendation, so every selected
// row maps (mapVisit only nulls when recommendations are absent) — plain
// limited selects can't stall the way call sweeps could. Kept single-page
// per invocation; exhausted=true when a short page comes back.
async function syncVisitArtifacts({ limit = DEFAULT_BATCH } = {}) {
  const stats = { examined: 0, mapped: 0, skipped: 0, exhausted: false };
  const records = await db('service_records as sr')
    .leftJoin('customers as cu', 'cu.id', 'sr.customer_id')
    .whereExists(function () {
      this.select(db.raw('1')).from('service_findings as sf')
        .whereRaw('sf.service_record_id = sr.id').whereNotNull('sf.recommendation');
    })
    .whereNotExists(function () {
      this.select(db.raw('1')).from('resolution_artifacts as ra')
        .whereRaw("ra.source = 'visit'").whereRaw('ra.source_id = sr.id');
    })
    .orderBy('sr.service_date', 'asc')
    .limit(limit)
    .select('sr.id', 'sr.customer_id', 'sr.service_date', 'sr.created_at', 'sr.service_type', 'sr.technician_notes',
      'cu.first_name', 'cu.last_name', 'cu.phone');

  if (!records.length) { stats.exhausted = true; return stats; }
  if (records.length < limit) stats.exhausted = true;

  const recordIds = records.map((r) => r.id);
  const findingRows = await db('service_findings')
    .whereIn('service_record_id', recordIds)
    .select('service_record_id', 'category', 'severity', 'title', 'detail', 'recommendation');
  const findingsByRecord = new Map();
  for (const f of findingRows) {
    if (!findingsByRecord.has(f.service_record_id)) findingsByRecord.set(f.service_record_id, []);
    findingsByRecord.get(f.service_record_id).push(f);
  }
  const summaries = await db('service_report_ai_summaries')
    .whereIn('service_record_id', recordIds)
    .where({ status: 'ready' })
    .select('service_record_id', 'summary_json')
    .catch(() => []);
  const summaryByRecord = new Map(summaries.map((s) => {
    const parsed = typeof s.summary_json === 'string' ? JSON.parse(s.summary_json) : s.summary_json;
    return [s.service_record_id, parsed];
  }));

  for (const record of records) {
    stats.examined += 1;
    const artifact = mapVisit({
      record,
      findings: findingsByRecord.get(record.id) || [],
      aiSummary: summaryByRecord.get(record.id) || null,
      context: { first_name: record.first_name, last_name: record.last_name, phone: record.phone },
    });
    if (!artifact) { stats.skipped += 1; continue; }
    await insertArtifact(artifact);
    stats.mapped += 1;
  }
  return stats;
}

async function syncResolutionArtifacts(options = {}) {
  const calls = await syncCallArtifacts(options);
  const visits = await syncVisitArtifacts(options);
  const summary = { calls, visits };
  logger.info(`[resolution-sync] ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { syncResolutionArtifacts, syncCallArtifacts, syncVisitArtifacts };
