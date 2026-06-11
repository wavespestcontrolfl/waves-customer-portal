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
const { WAVES_LOCATIONS } = require('../../config/locations');

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

    // lease_token = the claim timestamp; the worker echoes it back in /report so
    // a late report from a swept/reclaimed lease can't clobber a newer claim.
    return rows.map((r) => ({ ...r, claimed_at: now, claimed_by: WORKER, lease_token: now.toISOString() }));
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
    // Persist a paid-placement cost (e.g. sponsored post) for funnel ROI; only a
    // valid non-negative number, else null. Accept a real number or a non-blank
    // numeric string ONLY — Number('')/Number('  ')/Number(false)/Number([]) all
    // coerce to 0, which would record a blank field as a bogus free placement.
    const raw = body.cost;
    const isNumericInput = typeof raw === 'number'
      || (typeof raw === 'string' && raw.trim() !== '');
    const n = Number(raw);
    const cost = isNumericInput && Number.isFinite(n) && n >= 0 ? n : null;
    return {
      ...release,
      status: 'placed',
      live_url: body.live_url || null,
      anchor_text: body.claimed_anchor || null,
      evidence_url: body.evidence_url || null,
      cost,
      notes: body.notes || null,
    };
  }
  if (outcome === 'skipped') {
    return { ...release, status: 'rejected', notes: body.notes || 'worker skipped' };
  }
  // failed: leave it claimable again (status unchanged) for a retry next sweep.
  return { ...release, notes: body.notes || null };
}

async function report({ prospect_id, outcome, lease_token, ...body }) {
  // A 'placed' report MUST carry a live_url — otherwise the row lands in 'placed'
  // with live_url=null, which the verifier skips and claim() never re-serves,
  // permanently stranding it.
  if (outcome === 'placed' && !body.live_url) {
    return { ok: false, code: 'live_url_required', error: 'a placed report requires live_url' };
  }
  const leaseDate = lease_token ? new Date(lease_token) : null;
  if (!leaseDate || Number.isNaN(leaseDate.getTime())) {
    return { ok: false, code: 'lease_required', error: 'valid lease_token required (the claimed_at returned by /claim)' };
  }

  const prospect = await db('seo_link_prospects').where({ id: prospect_id }).first();
  if (!prospect) return { ok: false, code: 'not_found', error: 'prospect not found' };

  const attempts = (prospect.attempts || 0) + 1;
  const patch = mapReportToPatch(outcome, body);
  // Cap retries so a permanently-failing prospect doesn't churn forever.
  if (outcome === 'failed' && attempts >= MAX_ATTEMPTS) patch.status = 'rejected';

  // Optimistic concurrency: only apply if THIS lease is still current. If the
  // claim was swept and re-claimed by another worker, claimed_at no longer
  // matches, the update affects 0 rows, and we reject the stale report.
  const updated = await db('seo_link_prospects')
    .where({ id: prospect_id })
    .where('claimed_at', leaseDate)
    .update({ ...patch, attempts });

  if (updated === 0) {
    return { ok: false, code: 'stale_lease', error: 'lease expired or reclaimed; re-claim before reporting' };
  }

  logger.info(`[link-worker] report ${prospect_id} outcome=${outcome} attempts=${attempts} -> ${patch.status || prospect.status}`);
  return { ok: true, status: patch.status || prospect.status, attempts };
}

/**
 * Canonical NAP served with every /claim response so the worker never invents
 * business details on a signup. Citations must match a GBP listing exactly —
 * locations.js addresses/phones ARE the GBP-listed ones — so this maps only
 * the public fields (no account ids, refresh-token env names, or resource names).
 */
function businessProfile() {
  return {
    brand: 'Waves Pest Control',
    website: 'https://wavespestcontrol.com',
    contact_email: process.env.HERMES_SIGNUP_EMAIL || 'contact@wavespestcontrol.com',
    default_location_id: 'bradenton',
    locations: WAVES_LOCATIONS.map((l) => ({
      id: l.id,
      name: l.name,
      address: l.address,
      phone: l.phone,
      google_place_id: l.googlePlaceId,
    })),
    instructions: 'Use the default location for brand-wide directories. Only use another '
      + 'listed location when the prospect targets that city. Never invent or reformat '
      + 'an address, phone, or email — copy them exactly as given.',
  };
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
  claim, report, sweepExpiredClaims, mapReportToPatch, businessProfile,
  WORKER, SIGNUP_TYPES, OUTREACH_TYPES, MAX_ATTEMPTS,
};
