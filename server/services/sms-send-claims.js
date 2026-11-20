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

// async: a sync throw while building the query becomes a rejection, which
// the routes' fire-and-forget `.catch(() => {})` already swallows.
async function pruneSmsSendClaims(conn = db) {
  return conn('sms_send_claims')
    .where((q) => {
      q.where((daily) => {
        daily.where('created_at', '<', conn.raw("NOW() - interval '1 day'"));
        for (const prefix of WEEKLY_CLAIM_PREFIXES) daily.whereRaw('left(claim_key, ?) <> ?', [prefix.length, prefix]);
      });
      for (const prefix of WEEKLY_CLAIM_PREFIXES) {
        q.orWhere((weekly) => {
          weekly.whereRaw('left(claim_key, ?) = ?', [prefix.length, prefix]);
          weekly.where('created_at', '<', conn.raw("NOW() - interval '8 days'"));
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

module.exports = { pruneSmsSendClaims, takeSendClaim, releaseSendClaim, WEEKLY_CLAIM_PREFIXES };
