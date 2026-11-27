/**
 * Housekeeping for sms_send_claims, the shared cross-process send gate
 * (tech-line, estimate-public, outbound-voicemail, admin-communications,
 * the BI briefing), and the claim and release the once-a-day admin banners
 * share (morning-banner.js, estimate-call-today-push.js).
 *
 * Most claims only matter for minutes (a send window) or a day (a
 * per-phone daily cap), so the routes prune rows older than a day after a
 * delivered text. The Monday BI briefing's claim covers a whole ET WEEK
 * (bi-briefing-sms.js). Pruning it on Tuesday would let a re-run text the
 * owner a second briefing that week, so weekly claims are kept for 8 days.
 * Every prune goes through here so no route deletes another lane's
 * longer-lived claims.
 */

const db = require('../models/db');

const WEEKLY_CLAIM_PREFIXES = ['bi_briefing_sms:'];
// Bell-less keyed push dedupe claims (notification-triggers.js): retained 30 days
// so webhook/call replays across the full replay window stay single-shot even after
// daily SMS claim cleanup runs.
const MONTHLY_CLAIM_PREFIXES = ['notif_push_dedupe:'];

// async: a sync throw while building the query becomes a rejection, which
// the routes' fire-and-forget `.catch(() => {})` already swallows.
async function pruneSmsSendClaims(conn = db) {
  const longerPrefixes = [...WEEKLY_CLAIM_PREFIXES, ...MONTHLY_CLAIM_PREFIXES];
  return conn('sms_send_claims')
    .where((q) => {
      q.where((daily) => {
        daily.where('created_at', '<', conn.raw("NOW() - interval '1 day'"));
        for (const prefix of longerPrefixes) daily.whereRaw('left(claim_key, ?) <> ?', [prefix.length, prefix]);
      });
      for (const prefix of WEEKLY_CLAIM_PREFIXES) {
        q.orWhere((weekly) => {
          weekly.whereRaw('left(claim_key, ?) = ?', [prefix.length, prefix]);
          weekly.where('created_at', '<', conn.raw("NOW() - interval '8 days'"));
        });
      }
      for (const prefix of MONTHLY_CLAIM_PREFIXES) {
        q.orWhere((monthly) => {
          monthly.whereRaw('left(claim_key, ?) = ?', [prefix.length, prefix]);
          monthly.where('created_at', '<', conn.raw("NOW() - interval '30 days'"));
        });
      }
    })
    .del();
}

// One run's claim on a one-time send (a daily banner): true when this call inserted the row, false when another run
// already holds the key. The caller owns the key's shape and when to give the claim back.
async function takeSendClaim(claimKey, conn = db) {
  const claim = await conn.raw(
    `INSERT INTO sms_send_claims (claim_key) VALUES (?)
     ON CONFLICT (claim_key) DO NOTHING
     RETURNING id`,
    [claimKey],
  );
  return (claim?.rows || []).length > 0;
}

// Give a claim back so a later run may send. Throws when the delete fails: the row then still blocks a retry, and
// only the caller knows whether to report that.
async function releaseSendClaim(claimKey, conn = db) {
  await conn('sms_send_claims').where({ claim_key: claimKey }).del();
}

// Lease-backed keyed push claim in sms_send_claims (uses existing `outcome`
// column: 'pending' with a 5-minute recoverable lease, or 'delivered' once at
// least one device accepted the push).
// Returns:
//   'acquired'  — caller owns the pending lease and may dispatch push
//   'delivered' — a previous attempt already confirmed delivery (caller settles)
//   'in_flight' — another attempt holds a fresh pending lease (skip without claiming delivered)
async function acquirePushDedupeLease(claimKey, { leaseMinutes = 5 } = {}, conn = db) {
  const inserted = await conn.raw(
    `INSERT INTO sms_send_claims (claim_key, outcome) VALUES (?, 'pending')
     ON CONFLICT (claim_key) DO NOTHING
     RETURNING id`,
    [claimKey],
  );
  if ((inserted?.rows || []).length > 0) return 'acquired';

  const reclaimed = await conn.raw(
    `UPDATE sms_send_claims
        SET created_at = NOW(), outcome = 'pending'
      WHERE claim_key = ?
        AND outcome = 'pending'
        AND created_at < NOW() - (? * interval '1 minute')
      RETURNING id`,
    [claimKey, leaseMinutes],
  );
  if ((reclaimed?.rows || []).length > 0) return 'acquired';

  const existing = await conn('sms_send_claims').where({ claim_key: claimKey }).first('outcome');
  if (existing?.outcome === 'delivered') return 'delivered';
  return 'in_flight';
}

async function markPushDedupeDelivered(claimKey, conn = db) {
  await conn('sms_send_claims')
    .where({ claim_key: claimKey })
    .update({ outcome: 'delivered', created_at: conn.fn ? conn.fn.now() : new Date() });
}

async function releasePushDedupeLease(claimKey, conn = db) {
  await conn('sms_send_claims')
    .where({ claim_key: claimKey, outcome: 'pending' })
    .del();
}

module.exports = {
  pruneSmsSendClaims, takeSendClaim, releaseSendClaim,
  acquirePushDedupeLease, markPushDedupeDelivered, releasePushDedupeLease,
  WEEKLY_CLAIM_PREFIXES, MONTHLY_CLAIM_PREFIXES,
};
