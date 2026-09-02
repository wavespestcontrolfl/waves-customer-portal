/**
 * Call-processing stall watchdog.
 *
 * Why this exists: on 2026-08-31 a hot new-lead call sat unprocessed for 18
 * minutes — a processing pass claimed the row and died, the owner's manual
 * retry was silently rejected, and the caller rang back to chase his
 * estimate before the pipeline touched the first call. Another row had been
 * wedged in 'processing' since 2026-07-10 with nothing anywhere alarming on
 * it. The ingest watchdog proves a call REACHED call_log and the
 * booking-miss watchdog inspects calls that finished extraction; nothing
 * watched the gap between them — recorded but never reaching a terminal
 * processing state.
 *
 * What counts as stalled: a call_log row with a real recording (or a
 * PAN-quarantined MASKED TRANSCRIPT, which processes without one), duration above
 * the processing floor, older than the grace period, whose
 * processing_status is still NULL / 'pending' / 'processing'. Terminal
 * states are fine whatever they are: processed/voicemail/spam did the work,
 * no_transcription and extraction_failed have their own retry/triage lanes.
 *
 * Alerting mirrors call-ingest-watchdog: one bell per call per DAY, deduped
 * via the notifications dedupeKey; a burst above the aggregate threshold
 * means the processor itself is down and collapses into one loud bell.
 * `bell: true` on both, for the same reason the twilio_failure lane keeps
 * ringing under GATE_ADMIN_BELL_POLICY: category 'alert' is silenced by
 * default, and a watchdog whose whole job is to surface an invisible
 * failure cannot itself be invisible. A silenced or failed write is
 * reported as `unannounced`, never as `alerted`.
 *
 * A crash-reclaim LOOP — a pass that dies before writing any status, whose
 * row the 5-minute sweep reclaims every 10 minutes — is caught by sampling,
 * not by a single observation: the claim is stale only during the tail of
 * each reclaim cycle. That is why the cron period is 7 minutes and not a
 * multiple of 5 — a 5-minute cadence phase-locks to the sweep and observes
 * the claim at the same age forever, so the loop could evade it
 * indefinitely. It is deliberately NOT
 * caught by overriding a live claim on age or on a lifetime pass counter:
 * both misfire on a legitimate reprocess of an old row. Instead the
 * staleness threshold sits just under the processor's, which is safe
 * precisely because the bell is per-day rather than permanent: a false
 * positive costs one bell that stops on its own.
 *
 * Dark behind GATE_CALL_PROCESSING_STALL_WATCHDOG. Read-only except admin
 * notifications.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { recordingReadyAt } = require('../utils/call-timeline');
const { isInternalTestCustomerId } = require('./internal-test-customers');

// Below this the processor's own eligibility filter skips the row by design.
const MIN_DURATION_SECONDS = 11;
// The pipeline legitimately takes minutes (CDN settle + transcription +
// extraction); the sweep itself only picks fresh rows up after 10. Alert
// only past the point where every built-in retry lane has had its shot.
const GRACE_MINUTES = 20;
// A CLAIMED row is aged from its claim, against the processor's OWN
// threshold: processAllPending reclaims any claim older than 10 minutes
// (`COALESCE(processing_started_at, updated_at) < NOW() - INTERVAL '10
// minutes'`), i.e. the pipeline itself already treats a claim this old as
// dead. Matching it exactly is what makes a crash-reclaim LOOP visible: the
// 5-minute sweep resets processing_started_at every cycle, so a claim age
// measured against the 20-minute grace never once looked stale and the
// 2026-08-31 wedge would have gone unalerted by this very watchdog. A claim
// younger than this is a pass genuinely in flight and is always honoured.
// Deliberately UNDER the processor's 10: a perfectly-phased crash loop
// reclaims exactly as the claim hits 10 minutes, so a claim age never
// observed above 10 lets the loop evade every sampling cadence (codex r14
// P1). At 8 the watchdog calls a claim dead two minutes before the pipeline
// does, which is safe because the bell is no longer permanent — see the
// per-day dedupe below.
//
// A claim is aged from its HEARTBEAT, matching every reclaim predicate in
// processAllPending: the owning pass bumps processing_heartbeat_at while it
// works, so "stale" means STOPPED BEATING, not "started long ago". Without
// that, a healthy five-minute transcription aged past this threshold on
// processing_started_at alone and rang a false stall on a pass that was
// working perfectly. Falls back to processing_started_at for rows claimed
// before the column existed.
const CLAIM_STALE_MINUTES = 8;
// The heartbeat is a TIMER, so it keeps beating while a pass is alive even
// when the work is hung on a provider socket. The processor bounds that with
// an absolute ceiling on how long any claim may be held, DERIVED from the
// provider timeout budgets; the watchdog reads the same derivation, so a
// hung-but-beating pass is a stall here rather than a call that silently
// never rings — and so tuning a provider timeout moves both together.
const { alertCeilingMinutes } = require('../utils/claim-ceiling');
// One bell per call per DAY, not one per call forever. Permanence was what
// made an aggressive staleness threshold dangerous: a single false positive
// on a slow-but-healthy pass would have settled that SID for good and
// silenced its real wedge later. Per-day, a false positive costs one bell
// that stops on its own (the row goes terminal and leaves the scan), and a
// call that is genuinely still stuck tomorrow says so again. The day is the
// ET calendar day, not UTC — a UTC boundary falls at 8pm ET and would both
// let a call ring twice in one of Adam's days and then go quiet across his
// actual midnight.
const dayKey = (now) => require('../utils/datetime-et').etDateString(now);
// No age cutoff on the scan: the row wedged in 'processing' since 07-10 is
// exactly the case a 24h window would hide forever, and a stall missed
// while the gate or scheduler is down must still ring once. A single
// capped query cannot express that — unsettled but INELIGIBLE rows (dead-air
// blips, recording-less rows, calls still inside the grace window) never
// settle, so once enough of them exist they own the cap and an older wedge
// is hidden forever (codex r3 P1). So the scan PAGES through candidates,
// oldest first, and eligibility stays where it is testable: in
// computeStalledCalls, the one classifier, never duplicated into SQL.
const PAGE_SIZE = 500;
// Work ceiling for one run: 10k candidate rows. Reachable only in an
// outage — every candidate that survives the SQL prefilter either gets
// alerted (and settles forever) or is still inside the grace window, so
// there is no class of row that can accumulate ahead of the ceiling.
const MAX_PAGES = 20;
// Enough stalls to prove the processor is down; stop paging there so a
// pathological backlog cannot run the cron long or bloat the bell's sid list.
const COLLECT_CAP = 100;
// More than this many stalls at once = the processor is down, not the calls.
const AGGREGATE_THRESHOLD = 3;

const STALLED_STATUSES = new Set(['pending', 'processing']);

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Pure classifier, exported for tests. Rows are plain call_log objects.
function computeStalledCalls(rows, { now = new Date() } = {}) {
  const graceCutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);
  const claimCutoff = new Date(now.getTime() - CLAIM_STALE_MINUTES * 60 * 1000);
  // The BELL ceiling, deliberately earlier than the processor's reclaim
  // ceiling: a hung-but-beating pass should ring long before a peer is
  // allowed to take its claim away.
  const ceilingCutoff = new Date(now.getTime() - alertCeilingMinutes() * 60 * 1000);
  const stalled = [];
  for (const r of rows) {
    const readyAt = recordingReadyAt(r);
    if (!readyAt || readyAt > graceCutoff) continue;
    const status = r.processing_status == null ? null : String(r.processing_status);
    if (status !== null && !STALLED_STATUSES.has(status)) continue;
    // A call processAllPending JUST reclaimed is working, not wedged: age a
    // live claim from the claim, not from the call, and honour it however
    // old the call is — a force-reprocess of a months-old row is a pass in
    // flight. Stale is the processor's own 10-minute reclaim threshold, not
    // the grace window: measured against the grace window a crash-reclaim
    // loop refreshed the claim faster than it could ever look stale.
    if (status === 'processing') {
      // A beat only speaks for the claim that WROTE it: one left behind by a
      // previous pass is older than this claim's start, and reading it as
      // this claim's silence rings a false stall on a freshly claimed row
      // during a rolling deploy. Same rule as the processor's reclaim
      // predicate (codex P2).
      const started = r.processing_started_at ? new Date(r.processing_started_at) : null;
      const rawBeat = r.processing_heartbeat_at ? new Date(r.processing_heartbeat_at) : null;
      const currentBeat = rawBeat && !Number.isNaN(rawBeat.getTime())
        && (!started || Number.isNaN(started.getTime()) || rawBeat >= started)
        ? rawBeat : null;
      const beat = currentBeat || r.processing_started_at;
      const claimed = beat ? new Date(beat) : null;
      const beating = claimed && !Number.isNaN(claimed.getTime()) && claimed > claimCutoff;
      const withinCeiling = !started || Number.isNaN(started.getTime()) || started > ceilingCutoff;
      if (beating && withinCeiling) continue;
    }
    const hasRecording = !!String(r.recording_url || '').trim();
    const panQuarantined = (() => {
      try {
        const meta = typeof r.transcription_metadata === 'string'
          ? JSON.parse(r.transcription_metadata)
          : (r.transcription_metadata || {});
        // processAllPending's quarantine branch is `pan_detected = true AND
        // transcription IS NOT NULL` — a PAN row without its masked
        // transcript cannot enter processing at all, so alerting on one
        // would be a false stall (codex r12 P1).
        return String(meta?.pan_detected) === 'true' && !!r.transcription;
      } catch { return false; }
    })();
    if (!hasRecording && !panQuarantined) continue;
    // COALESCE semantics, matching processAllPending's own eligibility SQL:
    // a recorded duration of 0 is AUTHORITATIVE, not absent, so a 0-second
    // recording never borrows the longer overall call duration and gets
    // alerted on a call the processor deliberately skips.
    const seconds = Number(r.recording_duration_seconds ?? r.duration_seconds ?? 0) || 0;
    if (!panQuarantined && seconds < MIN_DURATION_SECONDS) continue;
    stalled.push(r);
  }
  return stalled;
}

// A silenced-by-policy or failed write is NOT an alert: create() returns a
// truthy {id:null, suppressed:true} sentinel and notifyAdmin returns null on
// failure. Counting either as fired would let the watchdog report health it
// does not have.
function persisted(notif) {
  return !!(notif && notif.id && !notif.suppressed);
}

// A SID is settled by its own bell or by membership in a prior aggregate.
// Applied as a NOT EXISTS *inside* the scan query, before the page cap: a
// backlog larger than one page must not let already-alerted rows occupy
// every slot and hide the unalerted ones behind them forever (codex r2 P1).
// No bindings — pure column references, so no bare-? hazard in the raw.
function excludeSettledSids(builder, today) {
  builder.whereNotExists(function settled() {
    this.select(db.raw('1'))
      .from('notifications')
      // Today's bells only — the dedupe is per-day, so a call still stuck
      // tomorrow re-enters the scan and rings again. ET midnight, not UTC:
      // `date AT TIME ZONE` reads the bare date IN that zone.
      .whereRaw("notifications.created_at >= ((?)::date AT TIME ZONE 'America/New_York')", [today])
      .where('notifications.recipient_type', 'admin')
      .whereRaw(
        "(notifications.metadata->>'dedupeKey' = 'call-stall:' || call_log.twilio_call_sid || ?"
        + " OR notifications.metadata->'stalled_call_sids' @> to_jsonb(call_log.twilio_call_sid))",
        [`:${today}`],
      );
  });
}

async function runCallProcessingStallWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callProcessingStallWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('call-processing-stall-watchdog', () => runInner({ now }));
}

async function runInner({ now = new Date() } = {}) {
  const today = dayKey(now);
  const candidates = () => db('call_log')
    .where(function stalledStatus() {
      this.whereNull('processing_status').orWhereIn('processing_status', [...STALLED_STATUSES]);
    })
    // A row with no SID cannot be reprocessed and cannot be settled by a
    // dedupeKey — it would ring forever.
    .whereNotNull('twilio_call_sid')
    // The two TIME-INDEPENDENT halves of computeStalledCalls, mirrored here
    // so they filter BEFORE the page cap. Without them, rows that can never
    // become eligible and can never settle (dead-air blips, recording-less
    // rows) accumulate at the front of the oldest-first order until they
    // exhaust the whole page budget and hide real stalls behind them
    // (codex r4 P1). INVARIANT: these must stay no stricter than the
    // classifier — it, not this prefilter, decides what is stalled, and the
    // time-dependent tests (grace, claim age, ceiling) stay there alone.
    // Predicates copied from processAllPending's eligibility block.
    .where(function longEnoughToProcess() {
      this.whereRaw('COALESCE(recording_duration_seconds, duration_seconds, 0) > ?', [MIN_DURATION_SECONDS - 1])
        .orWhere(function panQuarantined() {
          this.whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'")
            .whereNotNull('transcription');
        });
    })
    .where(function somethingToProcess() {
      this.whereRaw("NULLIF(btrim(recording_url), '') IS NOT NULL")
        .orWhere(function panQuarantined() {
          this.whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'")
            .whereNotNull('transcription');
        });
    })
    .modify((b) => excludeSettledSids(b, today))
    .select(
      'id', 'twilio_call_sid', 'customer_id', 'from_phone', 'to_phone', 'created_at',
      'processing_status', 'processing_started_at', 'processing_heartbeat_at',
      'updated_at', 'metadata', 'recording_url',
      'recording_duration_seconds', 'duration_seconds',
      'transcription', 'transcription_metadata',
    )
    // Oldest first, with an id tiebreak so the page boundary is stable: the
    // long-wedged rows are the ones a cap must never be able to hide.
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]);

  const fresh = [];
  let scanned = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidates().limit(PAGE_SIZE).offset(page * PAGE_SIZE);
    scanned += rows.length;
    // The demo/App Store review account never rings the admin bell. The
    // central suppression in notification-service keys on a customer id in
    // the notification metadata, which an aggregate bell cannot carry — so
    // these rows are dropped here, before they can pull a whole batch of
    // real calls into a bell that gets suppressed, or form an all-test
    // aggregate that is not suppressed at all.
    fresh.push(...computeStalledCalls(rows, { now }).filter((c) => !isInternalTestCustomerId(c.customer_id)));
    if (rows.length < PAGE_SIZE || fresh.length >= COLLECT_CAP) break;
  }
  const truncated = fresh.length > COLLECT_CAP;
  if (truncated) fresh.length = COLLECT_CAP;
  const stalled = fresh.length;

  if (!fresh.length) {
    return { skipped: false, scanned, stalled, alerted: 0 };
  }

  const et = (v) => (v ? new Date(v).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'unknown time');
  const describe = (c) => `${c.from_phone || 'unknown caller'} → ${c.to_phone || '?'} at ${et(c.created_at)} ET (status: ${c.processing_status || 'never claimed'})`;
  const describeMasked = (c) => `${maskPhone(c.from_phone)} → ${maskPhone(c.to_phone)} at ${et(c.created_at)} ET (status: ${c.processing_status || 'never claimed'})`;

  if (fresh.length > AGGREGATE_THRESHOLD) {
    // Keyed on the BATCH, not the clock. A clock key (the hour) silently
    // swallowed the second batch of an ongoing outage: every SID here is
    // unsettled by construction, so a same-hour re-fire is always a set of
    // NEW lost calls that deserves its own bell — and the old key skipped
    // the write while still reporting `alerted: 1` (codex GH round P1).
    // notifyAdmin's advisory lock on this key still makes an identical
    // batch at-most-once.
    const sids = fresh.map((c) => c.twilio_call_sid);
    // The day is part of the key, not just the SID set: notifyAdmin dedupes
    // a key across ALL history, so an unchanged stuck batch that re-enters
    // the scan tomorrow would otherwise return yesterday's row and be
    // counted as a fresh alert (codex r15 P1).
    const batchKey = crypto.createHash('sha1').update([...sids].sort().join(',')).digest('hex').slice(0, 16);
    const notif = await NotificationService.notifyAdmin(
      'alert',
      `Call processing may be DOWN — ${truncated ? 'over ' : ''}${fresh.length} recorded calls stuck without extraction`,
      `${truncated ? 'At least ' : ''}${fresh.length} recorded calls never reached a terminal processing state — no extraction, no lead. `
      + `Oldest still stuck: ${describe(fresh[0])}. Check the Railway logs for [call-proc] errors and the OpenAI/provider status.`,
      {
        link: '/admin/communications#tab=calls',
        dedupeKey: `call-stall-outage:${today}:${batchKey}`,
        bell: true,
        metadata: { stalled_call_sids: sids },
      },
    );
    if (!persisted(notif)) {
      logger.error('[call-stall-watchdog] aggregate alert did NOT persist — stalled calls are unannounced');
      return { skipped: false, scanned, stalled, alerted: 0, unannounced: fresh.length, aggregate: true };
    }
    logger.error(`[call-stall-watchdog] ${fresh.length} stalled calls — aggregate alert fired`);
    return { skipped: false, scanned, stalled, alerted: 1, aggregate: true };
  }

  let alerted = 0;
  let unannounced = 0;
  for (const c of fresh) {
    const notif = await NotificationService.notifyAdmin(
      'alert',
      'Recorded call stuck — no lead, no extraction',
      `${describe(c)} has a recording but never finished processing. `
      + 'Open the call log and hit Process; if that reports a conflict twice, check the Railway logs.',
      {
        link: '/admin/communications#tab=calls',
        dedupeKey: `call-stall:${c.twilio_call_sid}:${today}`,
        bell: true,
        metadata: { call_sid: c.twilio_call_sid, from_phone: c.from_phone },
      },
    );
    if (!persisted(notif)) {
      unannounced += 1;
      logger.error(`[call-stall-watchdog] stalled call ${c.twilio_call_sid} alert did NOT persist — unannounced`);
      continue;
    }
    alerted += 1;
    logger.warn(`[call-stall-watchdog] stalled call ${c.twilio_call_sid} (${describeMasked(c)}) — alert fired`);
  }
  return { skipped: false, scanned, stalled, alerted, unannounced };
}

module.exports = {
  runCallProcessingStallWatchdog,
  computeStalledCalls,
  MIN_DURATION_SECONDS,
  GRACE_MINUTES,
  CLAIM_STALE_MINUTES,
  PAGE_SIZE,
  MAX_PAGES,
  COLLECT_CAP,
  AGGREGATE_THRESHOLD,
};
