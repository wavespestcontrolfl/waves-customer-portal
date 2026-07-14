/**
 * Estimate view sessionizer.
 *
 * Groups estimate_views rows (one per real customer open; bot/admin traffic
 * filtered at insert time by estimate-public's shouldCountView) into
 * SESSIONS: consecutive views less than SESSION_GAP_MINUTES apart are one
 * visit. Engagement rules trigger on session boundaries, never raw views —
 * five clicks in ten minutes is one visit; coming back after the gap is a
 * new one (owner: multi-clicks within a sitting must not double-fire).
 */

const db = require('../models/db');

const SESSION_GAP_MINUTES = 30;

// Pure. `viewRows` = [{ viewed_at }] in ANY order; returns sessions sorted
// oldest-first: [{ startedAt, endedAt, viewCount }]. Rows with unparseable
// timestamps are dropped.
function sessionize(viewRows, gapMinutes = SESSION_GAP_MINUTES) {
  const gapMs = gapMinutes * 60000;
  const times = (viewRows || [])
    // Guard the falsy case explicitly: new Date(null) is the epoch (finite),
    // so a null viewed_at would otherwise sessionize as 1970.
    .map((r) => (r && r.viewed_at ? new Date(r.viewed_at).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const sessions = [];
  for (const t of times) {
    const current = sessions[sessions.length - 1];
    if (current && t - current.endedAt.getTime() < gapMs) {
      current.endedAt = new Date(t);
      current.viewCount += 1;
    } else {
      sessions.push({ startedAt: new Date(t), endedAt: new Date(t), viewCount: 1 });
    }
  }
  return sessions;
}

async function sessionsForEstimate(estimateId, { gapMinutes = SESSION_GAP_MINUTES, dbh = db } = {}) {
  const rows = await dbh('estimate_views')
    .where({ estimate_id: estimateId })
    .orderBy('viewed_at', 'asc')
    .select('viewed_at');
  return sessionize(rows, gapMinutes);
}

module.exports = { sessionize, sessionsForEstimate, SESSION_GAP_MINUTES };
