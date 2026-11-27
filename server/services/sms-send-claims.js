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

const crypto = require('crypto');
const db = require('../models/db');

const WEEKLY_CLAIM_PREFIXES = ['bi_briefing_sms:'];
// Keyed push dedupe leases & per-device partial-delivery markers
// (notification-triggers.js): retained 30 days so webhook/call replays across
// the full replay window stay single-shot even after daily SMS claim cleanup runs.
const MONTHLY_CLAIM_PREFIXES = ['notif_push_dedupe:', 'notif_push_sub:'];

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
// column: unique 'pending:<16hex>' owner token with a 5-minute recoverable
// lease, or 'delivered' once all attempted devices finished without failures).
// Returns:
//   { state: 'acquired', ownerToken } — caller owns the pending lease
//   { state: 'delivered', ownerToken: null } — previous attempt confirmed full delivery
//   { state: 'in_flight', ownerToken: null } — another attempt holds a fresh lease
async function acquirePushDedupeLease(claimKey, { leaseMinutes = 5 } = {}, conn = db) {
  const ownerToken = `pending:${crypto.randomBytes(8).toString('hex')}`;
  const inserted = await conn.raw(
    `INSERT INTO sms_send_claims (claim_key, outcome) VALUES (?, ?)
     ON CONFLICT (claim_key) DO NOTHING
     RETURNING id`,
    [claimKey, ownerToken],
  );
  if ((inserted?.rows || []).length > 0) return { state: 'acquired', ownerToken };

  const reclaimed = await conn.raw(
    `UPDATE sms_send_claims
        SET created_at = NOW(), outcome = ?
      WHERE claim_key = ?
        AND (outcome = 'pending' OR outcome LIKE 'pending:%')
        AND created_at < NOW() - (? * interval '1 minute')
      RETURNING id`,
    [ownerToken, claimKey, leaseMinutes],
  );
  if ((reclaimed?.rows || []).length > 0) return { state: 'acquired', ownerToken };

  const existing = await conn('sms_send_claims').where({ claim_key: claimKey }).first('outcome');
  if (existing?.outcome === 'delivered') return { state: 'delivered', ownerToken: null };
  return { state: 'in_flight', ownerToken: null };
}

async function isPushDedupeLeaseOwner(claimKey, ownerToken, conn = db) {
  if (!claimKey || !ownerToken) return false;
  const row = await conn('sms_send_claims')
    .where({ claim_key: claimKey, outcome: ownerToken })
    .first('id');
  return Boolean(row);
}

async function markPushDedupeDelivered(claimKey, ownerToken, conn = db) {
  if (!claimKey || !ownerToken) return false;
  const updated = await conn('sms_send_claims')
    .where({ claim_key: claimKey, outcome: ownerToken })
    .update({ outcome: 'delivered', created_at: conn.fn ? conn.fn.now() : new Date() });
  return Number(updated) > 0;
}

async function releasePushDedupeLease(claimKey, ownerToken, conn = db) {
  if (!claimKey || !ownerToken) return false;
  const deleted = await conn('sms_send_claims')
    .where({ claim_key: claimKey, outcome: ownerToken })
    .del();
  return Number(deleted) > 0;
}

function pushSubClaimPrefix(claimKey) {
  const hash = crypto.createHash('sha256').update(String(claimKey)).digest('hex').slice(0, 16);
  return `notif_push_sub:${hash}:`;
}

// Per-device partial-delivery marker stored in sms_send_claims (retained 30d)
// so a retry after a partial fan-out skips devices that already accepted the
// push without double-notifying them.
async function recordPushDedupeSubDelivered(claimKey, subscriptionId, conn = db) {
  if (!claimKey || !subscriptionId) return;
  const subKey = `${pushSubClaimPrefix(claimKey)}${subscriptionId}`;
  await conn.raw(
    `INSERT INTO sms_send_claims (claim_key, outcome) VALUES (?, 'delivered')
     ON CONFLICT (claim_key) DO NOTHING`,
    [subKey],
  );
}

async function listPushDedupeDeliveredSubs(claimKey, conn = db) {
  if (!claimKey) return [];
  const prefix = pushSubClaimPrefix(claimKey);
  const rows = await conn('sms_send_claims')
    .whereRaw('left(claim_key, ?) = ?', [prefix.length, prefix])
    .select('claim_key');
  return (rows || []).map((r) => String(r.claim_key).slice(prefix.length)).filter(Boolean);
}

module.exports = {
  pruneSmsSendClaims, takeSendClaim, releaseSendClaim,
  acquirePushDedupeLease, isPushDedupeLeaseOwner, markPushDedupeDelivered, releasePushDedupeLease,
  recordPushDedupeSubDelivered, listPushDedupeDeliveredSubs, pushSubClaimPrefix,
  WEEKLY_CLAIM_PREFIXES, MONTHLY_CLAIM_PREFIXES,
};
