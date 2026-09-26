/**
 * Housekeeping for sms_send_claims, the shared cross-process send gate
 * (tech-line, estimate-public, outbound-voicemail, admin-communications,
 * the BI briefing).
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

module.exports = { pruneSmsSendClaims, WEEKLY_CLAIM_PREFIXES };
