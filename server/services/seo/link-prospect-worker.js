/**
 * Link Prospect Worker contract (Backlink Manager M3a)
 *
 * The machine-to-machine boundary the Hermes (Docker) acquisition agent uses.
 * Hermes is "the hands" — it claims unworked prospects, executes the signup/
 * outreach, and reports back. It NEVER writes canonical truth: a report only
 * moves a prospect to `placed`; the nightly verifier + indexer confirm and
 * promote to `live`/`indexed` ("verify, don't trust").
 */
const db = require('../../models/db');
const logger = require('../logger');

const WORKER = 'hermes';
const SIGNUP_TYPES = ['directory', 'citation', 'social'];
const OUTREACH_TYPES = ['editorial', 'resource', 'guest_post', 'haro'];
const MAX_ATTEMPTS = 4;

/**
 * Lease up to n unworked prospects of a lane, atomically. FOR UPDATE SKIP LOCKED
 * so parallel Hermes subagents never grab the same row.
 */
async function claim({ n = 10, type = 'signup' } = {}) {
  const types = type === 'outreach' ? OUTREACH_TYPES : SIGNUP_TYPES;
  const limit = Math.min(Math.max(parseInt(n, 10) || 1, 1), 50);

  return db.transaction(async (trx) => {
    const rows = await trx('seo_link_prospects')
      .where({ status: 'prospect' })
      .whereIn('link_type', types)
      .whereNull('claimed_at')
      .orderByRaw("CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END")
      .orderBy('domain_rating', 'desc')
      .limit(limit)
      .forUpdate()
      .skipLocked();

    if (rows.length === 0) return [];
    const now = new Date();
    await trx('seo_link_prospects')
      .whereIn('id', rows.map((r) => r.id))
      .update({ claimed_at: now, claimed_by: WORKER, updated_at: now });

    return rows.map((r) => ({ ...r, claimed_at: now, claimed_by: WORKER }));
  });
}

/**
 * Map a worker outcome to a DB patch. Pure (no I/O) → unit-testable.
 * Always releases the lease. `placed` never goes straight to `live`.
 */
function mapReportToPatch(outcome, body = {}) {
  const now = new Date();
  const release = { claimed_at: null, claimed_by: null, updated_at: now };

  if (outcome === 'placed') {
    return {
      ...release,
      status: 'placed',
      live_url: body.live_url || null,
      anchor_text: body.claimed_anchor || null,
      evidence_url: body.evidence_url || null,
      notes: body.notes || null,
    };
  }
  if (outcome === 'skipped') {
    return { ...release, status: 'rejected', notes: body.notes || 'worker skipped' };
  }
  // failed: leave it claimable again (status unchanged) for a retry next sweep.
  return { ...release, notes: body.notes || null };
}

async function report({ prospect_id, outcome, ...body }) {
  const prospect = await db('seo_link_prospects').where({ id: prospect_id }).first();
  if (!prospect) return { ok: false, error: 'prospect not found' };

  const attempts = (prospect.attempts || 0) + 1;
  const patch = mapReportToPatch(outcome, body);
  // Cap retries so a permanently-failing prospect doesn't churn forever.
  if (outcome === 'failed' && attempts >= MAX_ATTEMPTS) patch.status = 'rejected';

  await db('seo_link_prospects').where({ id: prospect_id }).update({ ...patch, attempts });
  logger.info(`[link-worker] report ${prospect_id} outcome=${outcome} attempts=${attempts} -> ${patch.status || prospect.status}`);
  return { ok: true, status: patch.status || prospect.status, attempts };
}

/** Reclaim leases older than maxHours back to the pool (stuck-worker recovery). */
async function sweepExpiredClaims(maxHours = 6) {
  const cutoff = new Date(Date.now() - maxHours * 3600 * 1000);
  const released = await db('seo_link_prospects')
    .whereNotNull('claimed_at')
    .where('claimed_at', '<', cutoff)
    .where({ status: 'prospect' }) // only release ones still unworked
    .update({ claimed_at: null, claimed_by: null, updated_at: new Date() });
  if (released) logger.info(`[link-worker] released ${released} stale claim(s)`);
  return { released };
}

module.exports = {
  claim, report, sweepExpiredClaims, mapReportToPatch,
  WORKER, SIGNUP_TYPES, OUTREACH_TYPES, MAX_ATTEMPTS,
};
