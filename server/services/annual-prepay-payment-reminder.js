const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

// The invoice follow-up engine (send-anchored dunning) and the annual-prepay
// reminder both quote the same invoice. This one decision is shared by the
// producer and deferred Email replay so their pause and spacing rules cannot
// drift.
const PAYMENT_REMINDER_DUNNING_SUPPRESS_MS = 20 * 60 * 60 * 1000;

async function invoiceDunningActiveToday(invoiceId, {
  now = new Date(), todayYmd = null, database = db, rethrow = false,
} = {}) {
  try {
    const row = await database('invoice_followup_sequences')
      .where({ invoice_id: invoiceId })
      .first('status', 'last_touch_at', 'next_touch_at');
    if (!row) return false;
    // A real recent send suppresses regardless of status: the final step
    // stamps last_touch_at while changing the sequence to completed.
    if (row.last_touch_at && (now - new Date(row.last_touch_at)) < PAYMENT_REMINDER_DUNNING_SUPPRESS_MS) return true;
    // Deliberate controls also pause the visit-anchored reminder.
    if (['paused', 'autopay_hold', 'stopped'].includes(row.status)) return true;
    // An exhausted sequence leaves this reminder as the remaining nudge.
    if (row.status !== 'active') return false;
    if (row.next_touch_at) {
      // Due follow-up work suppresses only on Tue–Fri, when that cron can run.
      const followupConfig = require('../config/invoice-followups');
      const sendDays = new Set(followupConfig?.sendWindow?.daysOfWeek || []);
      const today = todayYmd || etDateString(now);
      const todayEtDow = new Date(`${today}T12:00:00Z`).getUTCDay();
      if (sendDays.has(todayEtDow)) {
        const endOfTodayEt = parseETDateTime(`${today} 23:59:59`);
        if (new Date(row.next_touch_at) <= endOfTodayEt) return true;
      }
    }
    return false;
  } catch (err) {
    if (rethrow) throw err;
    // Producer behavior stays fail-open so a transient read does not silence
    // the only visit-anchored nudge. Replay callers request rethrow and fail
    // closed because an already-frozen Email can safely wait.
    logger.warn(`[annual-prepay] dunning suppression check failed for invoice ${invoiceId}: ${err.message}`);
    return false;
  }
}

module.exports = { invoiceDunningActiveToday };
