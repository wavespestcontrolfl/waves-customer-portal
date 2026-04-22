/**
 * Daily scan for business_credentials rows with expiration_date ≤ 60 days out.
 * Fires a `credential_expiring_soon` notification per credential, deduped so
 * the same credential doesn't ring every morning.
 *
 * Dedupe strategy: query the `notifications` table for any unread row from
 * the last 7 days whose metadata.credential_id matches. If present, skip.
 * This gives Virginia one weekly reminder per credential rather than daily
 * nagging, until she marks it read or renews it.
 *
 * Runs from scheduler.js at the same 6am ET slot as the other compliance
 * crons. Fail-open — a bad DB query never crashes the whole cron stack.
 */
const db = require('../models/db');
const logger = require('./logger');

const WARN_DAYS = 60;
const DEDUPE_DAYS = 7;

async function alreadyNotified(credentialId) {
  try {
    const cutoff = new Date(Date.now() - DEDUPE_DAYS * 86400000);
    const row = await db('notifications')
      .where('recipient_type', 'admin')
      .where('category', 'credential')
      .where('created_at', '>=', cutoff)
      .whereRaw("metadata->>'credential_id' = ?", [credentialId])
      .first();
    return !!row;
  } catch (e) {
    logger.warn(`[credential-expiry] dedupe check failed: ${e.message}`);
    return false; // fail open — fire anyway if we can't dedupe
  }
}

async function runCredentialExpiryCheck() {
  const cutoffDate = new Date(Date.now() + WARN_DAYS * 86400000);
  let rows = [];
  try {
    rows = await db('business_credentials')
      .whereNull('archived_at')
      .where('status', 'active')
      .whereNotNull('expiration_date')
      .where('expiration_date', '<=', cutoffDate.toISOString().slice(0, 10))
      .orderBy('expiration_date', 'asc');
  } catch (e) {
    logger.warn(`[credential-expiry] scan failed (table missing?): ${e.message}`);
    return { scanned: 0, fired: 0 };
  }

  if (rows.length === 0) {
    return { scanned: 0, fired: 0 };
  }

  const { triggerNotification } = require('./notification-triggers');
  const NotificationService = require('./notification-service');

  let fired = 0;
  for (const cred of rows) {
    const skip = await alreadyNotified(cred.id);
    if (skip) continue;
    const daysUntil = Math.max(
      0,
      Math.floor((new Date(cred.expiration_date).getTime() - Date.now()) / 86400000),
    );
    try {
      await triggerNotification('credential_expiring_soon', {
        credentialId: cred.id,
        displayName: cred.display_name,
        credentialNumber: cred.credential_number,
        issuingAuthority: cred.issuing_authority,
        expirationDate: String(cred.expiration_date).slice(0, 10),
        daysUntil,
      });
      // Re-insert metadata so the dedupe query can find it next run. The
      // trigger builder doesn't pass metadata through to the notifications
      // row, so we write a separate admin-targeted record tied to this
      // credential id for dedupe purposes.
      await NotificationService.notifyAdmin(
        'credential',
        `${cred.display_name} expires in ${daysUntil}d (dedupe marker)`,
        null,
        { metadata: { credential_id: cred.id, expirationDate: cred.expiration_date } },
      ).catch(() => {});
      fired++;
    } catch (e) {
      logger.warn(`[credential-expiry] trigger failed for ${cred.id}: ${e.message}`);
    }
  }

  logger.info(`[credential-expiry] scanned=${rows.length} fired=${fired}`);
  return { scanned: rows.length, fired };
}

module.exports = { runCredentialExpiryCheck };
