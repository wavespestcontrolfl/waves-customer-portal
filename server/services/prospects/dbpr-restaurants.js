/**
 * Weekly restaurant prospect list from Florida's public restaurant files (DBPR; free, no key; owner approval
 * 2026-11-19), storage half: the four reads and writes on `restaurant_prospects`. The weekly job that downloads the
 * files and calls them is the next change; until it lands, nothing calls this file. It sends nothing and calls no AI.
 *
 * pest_evidence is for inspections: NULL = the public report page is not read yet, true = a 35A pest finding,
 * false = 35B only (outer openings not protected). detail_attempts counts failed report reads.
 */

const db = require('../../models/db');

const REPORT_MAX_ATTEMPTS = 3;
const UPSERT_CHUNK = 500;

// ── Store ───────────────────────────────────────────────────────

// One record per (kind, source_key); a repeated key keeps its last copy. PostgreSQL refuses an upsert that names the
// same row twice in one statement.
function dedupeByKey(records) {
  return [...new Map(records.map((r) => [`${r.kind}|${r.source_key}`, r])).values()];
}

// A re-read of a known row refreshes last_seen_at only: a pest_evidence answer, the findings and the attempt count
// are never overwritten by a later file. Returns the number of rows written.
async function upsertRecords(records) {
  const unique = dedupeByKey(records);
  let n = 0;
  for (let i = 0; i < unique.length; i += UPSERT_CHUNK) {
    const chunk = unique.slice(i, i + UPSERT_CHUNK).map((r) => ({ ...r, detail: JSON.stringify(r.detail) }));
    await db('restaurant_prospects').insert(chunk).onConflict(['kind', 'source_key']).merge({ last_seen_at: db.fn.now() });
    n += chunk.length;
  }
  return n;
}

async function pendingInspections({ cutoff, limit }) {
  const rows = await db('restaurant_prospects')
    .where({ kind: 'inspection' })
    .whereNull('pest_evidence')
    .where('detail_attempts', '<', REPORT_MAX_ATTEMPTS)
    .where('event_date', '>=', cutoff)
    .orderBy('event_date', 'desc')
    .limit(limit)
    .select('id', 'license_id', 'source_key');
  return rows;
}

async function saveReport(id, report) {
  await db('restaurant_prospects')
    .where({ id })
    .whereNull('pest_evidence')
    .update({
      pest_evidence: report.pestEvidence,
      detail: db.raw("COALESCE(detail, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ findings: report.findings })]),
    });
}

async function bumpAttempts(id) {
  await db('restaurant_prospects').where({ id }).increment('detail_attempts', 1);
}

module.exports = { upsertRecords, pendingInspections, saveReport, bumpAttempts };
