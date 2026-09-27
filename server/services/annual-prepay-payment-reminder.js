const db = require('../models/db');
const logger = require('./logger');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

// The invoice follow-up engine and the annual-prepay reminder quote the same
// invoice. Keep this decision separate from the large renewal orchestrator so
// every live annual reminder uses one dunning rule.
const PAYMENT_REMINDER_DUNNING_SUPPRESS_MS = 20 * 60 * 60 * 1000;

async function invoiceDunningActiveToday(invoiceId, { now = new Date(), todayYmd = null } = {}) {
  try {
    const row = await db('invoice_followup_sequences')
      .where({ invoice_id: invoiceId })
      .first('status', 'last_touch_at', 'next_touch_at');
    if (!row) return false;
    if (row.last_touch_at && (now - new Date(row.last_touch_at)) < PAYMENT_REMINDER_DUNNING_SUPPRESS_MS) return true;
    if (['paused', 'autopay_hold', 'stopped'].includes(row.status)) return true;
    if (row.status !== 'active') return false;
    if (row.next_touch_at) {
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
    // A transient read must not silence the only visit-anchored nudge.
    logger.warn(`[annual-prepay] dunning suppression check failed for invoice ${invoiceId}: ${err.message}`);
    return false;
  }
}

module.exports = { invoiceDunningActiveToday };
