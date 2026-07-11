/**
 * Call-ingest completeness watchdog.
 *
 * Why this exists: a 2026-07-11 reconciliation of Twilio's own call ledger
 * against call_log found that EVERY significant inbound call from Feb–Mar
 * 2026 (391 completed calls ≥20s) was silently never ingested, plus 11
 * stragglers in Apr–May — including real booked-on-the-call jobs that ended
 * up with no customer, lead, or visit anywhere in the system. Nothing
 * alerted, because call_log can only report on calls it received. Twilio is
 * the ground truth; this cron diffs it against call_log so an ingest break
 * (webhook outage, misrouted number, signature failure) surfaces as an admin
 * bell within the hour instead of months later.
 *
 * What counts as a miss: an INBOUND parent call, status completed, duration
 * ≥ MIN_DURATION_SECONDS, older than the grace period (the webhook +
 * processing pipeline needs time), where NO member of its call family —
 * the parent SID or any child dial-leg SID — appears in call_log's
 * twilio_call_sid / call_sid / recording_sid columns. Family-aware matching
 * matters: call_log rows can store the forwarded child leg's SID, and
 * recordings attach to child legs, so parent-only matching overcounts.
 *
 * Alerting: one bell per missed call, deduped forever via the notifications
 * metadata dedupeKey (same pattern as the appointment no-channel alert) so
 * restarts and window overlaps never re-ring. A run that finds many misses
 * (ingest actually down) collapses into ONE aggregate bell instead of a
 * flood.
 *
 * Dark by default behind GATE_CALL_INGEST_WATCHDOG. Read-only against
 * Twilio; writes nothing but admin notifications.
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');

const MIN_DURATION_SECONDS = 20;
// How far back each run looks. Generous overlap with the run cadence so a
// missed tick (deploy, crash) can't open a blind spot; the dedupe makes
// re-scanning cheap.
const LOOKBACK_HOURS = 24;
// Calls younger than this are still legitimately in flight (webhook →
// transcription → extraction can take a while on long recordings).
const GRACE_MINUTES = 60;
// More misses than this in one run = the ingest itself is down; one
// aggregate alert says so better than a bell per call.
const AGGREGATE_THRESHOLD = 3;

// Pure diff, exported for tests: which inbound parent calls have no family
// member in call_log? `twilioCalls` are plain objects ({ sid, parentCallSid,
// direction, status, duration, startTime, from, to }); `knownSids` is a Set
// of every twilio_call_sid / call_sid / recording_sid in the window.
function computeMissedCalls(twilioCalls, knownSids, { now = new Date() } = {}) {
  const graceCutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);
  const childrenByParent = new Map();
  for (const c of twilioCalls) {
    if (!c.parentCallSid) continue;
    if (!childrenByParent.has(c.parentCallSid)) childrenByParent.set(c.parentCallSid, []);
    childrenByParent.get(c.parentCallSid).push(c);
  }
  const missed = [];
  for (const c of twilioCalls) {
    if (c.direction !== 'inbound') continue;
    if (c.status !== 'completed') continue;
    if (Number(c.duration || 0) < MIN_DURATION_SECONDS) continue;
    const started = c.startTime ? new Date(c.startTime) : null;
    if (!started || started > graceCutoff) continue;
    const family = [c.sid, ...(childrenByParent.get(c.sid) || []).map((k) => k.sid)];
    if (family.some((sid) => knownSids.has(sid))) continue;
    missed.push(c);
  }
  return missed;
}

async function loadKnownCallLogSids(since) {
  const rows = await db('call_log')
    .where('created_at', '>=', since)
    .select('twilio_call_sid', 'call_sid', 'recording_sid');
  const known = new Set();
  for (const r of rows) {
    for (const k of ['twilio_call_sid', 'call_sid', 'recording_sid']) {
      if (r[k]) known.add(r[k]);
    }
  }
  return known;
}

// Has this exact miss already rung the bell (any time in the past)? Uses the
// notifications metadata dedupeKey pattern — restart-safe, no new table.
async function alreadyAlerted(dedupeKey) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first('id')
    .catch(() => null);
  return !!existing;
}

async function runCallIngestWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callIngestWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    logger.warn('[call-ingest-watchdog] Twilio credentials missing; skipping');
    return { skipped: true, reason: 'no_twilio_creds' };
  }

  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const calls = await client.calls.list({ startTimeAfter: windowStart, limit: 1000 });
  const plain = calls.map((c) => ({
    sid: c.sid,
    parentCallSid: c.parentCallSid || null,
    direction: c.direction,
    status: c.status,
    duration: Number(c.duration || 0),
    startTime: c.startTime || null,
    from: c.from || null,
    to: c.to || null,
  }));

  // Slack on the DB window: a call near the window edge may have been
  // ingested slightly before/after its Twilio startTime.
  const known = await loadKnownCallLogSids(new Date(windowStart.getTime() - 2 * 3600 * 1000));
  const missed = computeMissedCalls(plain, known, { now });

  // Filter to misses not already alerted.
  const fresh = [];
  for (const c of missed) {
    if (!(await alreadyAlerted(`call-ingest-miss:${c.sid}`))) fresh.push(c);
  }
  if (!fresh.length) {
    return { skipped: false, scanned: plain.length, missed: missed.length, alerted: 0 };
  }

  const describe = (c) => {
    const when = c.startTime ? new Date(c.startTime).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'unknown time';
    return `${c.from || 'unknown caller'} → ${c.to || '?'} at ${when} ET (${c.duration}s)`;
  };

  if (fresh.length > AGGREGATE_THRESHOLD) {
    // Ingest is likely down — one loud aggregate bell, deduped per run-hour
    // so a persistent outage re-rings at most hourly.
    const hourKey = now.toISOString().slice(0, 13);
    const dedupeKey = `call-ingest-outage:${hourKey}`;
    if (!(await alreadyAlerted(dedupeKey))) {
      await NotificationService.notifyAdmin(
        'alert',
        `Call ingest may be DOWN — ${fresh.length} answered calls missing from the pipeline`,
        `${fresh.length} completed inbound calls in the last ${LOOKBACK_HOURS}h never reached call_log. ` +
        `Newest: ${describe(fresh[0])}. Check the Twilio voice webhook and recent deploys.`,
        { link: '/admin/communications', metadata: { dedupeKey, missed_call_sids: fresh.map((c) => c.sid).slice(0, 25) } },
      );
    }
    logger.error(`[call-ingest-watchdog] ${fresh.length} un-ingested calls in window — aggregate alert fired`);
    return { skipped: false, scanned: plain.length, missed: missed.length, alerted: 1, aggregate: true };
  }

  let alerted = 0;
  for (const c of fresh) {
    const dedupeKey = `call-ingest-miss:${c.sid}`;
    await NotificationService.notifyAdmin(
      'alert',
      'Answered call never reached the call pipeline',
      `${describe(c)} completed on Twilio but has no call_log record — no transcription, no extraction, no lead. ` +
      'Listen to the recording in the Twilio console and check the voice webhook.',
      { link: '/admin/communications', metadata: { dedupeKey, call_sid: c.sid, from_phone: c.from } },
    );
    alerted += 1;
    logger.warn(`[call-ingest-watchdog] Un-ingested call ${c.sid} (${describe(c)}) — alert fired`);
  }
  return { skipped: false, scanned: plain.length, missed: missed.length, alerted };
}

module.exports = {
  runCallIngestWatchdog,
  computeMissedCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
  LOOKBACK_HOURS,
  AGGREGATE_THRESHOLD,
};
