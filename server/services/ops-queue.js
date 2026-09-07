/**
 * Ops queue — one read-only projection of every long-running lane's
 * persisted state: what is pending, what is parked waiting on a human,
 * what failed. Rendered by the Agents hub "Queue" tab (GATE_ADMIN_OPS_QUEUE).
 *
 * Read-only by construction: no lane exposes an action here — approvals stay
 * on their existing paths (email-reply approvals, approve-autonomous-run.js,
 * the IB confirm card, the dispatch board). Each lane is isolated in its own
 * try/catch (rule 6): one missing table or bad column degrades that lane to an
 * error row, never the whole view.
 *
 * Item statuses are normalized to three words the operator can act on:
 *   pending — machinery is working on it, nothing to do
 *   parked  — waiting on a human decision or stuck past its budget
 *   failed  — terminal failure that needs a look
 */

const db = require('../models/db');
const logger = require('./logger');
const { getScheduledJobHealth } = require('./intelligence-bar/job-health-tools');
const { computeStalledCalls, MIN_DURATION_SECONDS } = require('./call-processing-stall-watchdog');
const { EXECUTING_RECOVERY_MINUTES } = require('./content/email-approvals');
const { STALE_CLAIM_MS: DELIVERY_STALE_CLAIM_MS } = require('./service-report/delivery-queue');
const { STALE_CLAIM_MS: PDF_STALE_CLAIM_MS } = require('./service-report/pdf-queue');
// The processor owns the retry budget: extraction_failed under the cap is
// re-run by processAllPending (a retry in flight), only at the cap is it
// terminal. Read from the processor so the two can never disagree.
const { CALL_EXTRACTION_MAX_ATTEMPTS } = require('./call-recording-processor');

const ITEM_LIMIT = 25;
const SCAN_LIMIT = 200;
const RECENT_DAYS = 7;

// Tool names are snake_case identifiers (send_sms, create_estimate); no
// module exports a display label for them, so the view humanizes the name
// itself rather than reaching for a helper that does not exist (GitHub
// Codex r3 P2 — the previous import threw whenever an action was pending).
function toolTitle(name) {
  const words = String(name || '').trim().replace(/_/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Pending action';
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function since(days) {
  return new Date(Date.now() - days * 86400000);
}

function tally(items) {
  const counts = { pending: 0, parked: 0, failed: 0 };
  for (const it of items) if (counts[it.status] !== undefined) counts[it.status] += 1;
  return counts;
}

// `truncated` = the statuses whose scans hit SCAN_LIMIT, so THOSE counts
// are a floor, not a total; the tab renders them as "200+" and leaves the
// statuses whose scans were complete exact. Cheaper and more honest than a
// second count query per lane on a view that refreshes on demand.
function finish(items, { truncated = [], total = null } = {}) {
  const truncatedStatuses = [...new Set(truncated)];
  const rank = { failed: 0, parked: 1, pending: 2 };
  // Lanes scan failed and open sets separately; a row can only be in one
  // state, but dedupe by id defensively so a race between the two reads
  // never double-counts.
  const seen = new Set();
  const unique = items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  const sorted = [...unique].sort((a, b) => {
    const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (r !== 0) return r;
    return String(b.at || '').localeCompare(String(a.at || ''));
  });
  return {
    ...tally(sorted),
    total: total ?? sorted.length,
    truncated: truncatedStatuses.length > 0,
    truncatedStatuses,
    items: sorted.slice(0, ITEM_LIMIT),
  };
}

// The statuses a capped scan could have fed — [] when the scan was complete.
function capped(rows, ...statuses) {
  return Array.isArray(rows) && rows.length >= SCAN_LIMIT ? statuses : [];
}

async function laneScheduledJobs() {
  const health = await getScheduledJobHealth();
  if (health?.error) throw new Error(health.error);
  const items = (health.jobs || [])
    .filter((j) => j.state !== 'healthy')
    .map((j) => ({
      id: j.job,
      title: j.job,
      // `failed` is terminal (failing); stuck and stale are recoverable —
      // the next tick may overwrite a stuck row's state — so they park.
      status: j.state === 'running' ? 'pending' : j.state === 'failing' ? 'failed' : 'parked',
      detail: j.state === 'failing'
        ? `${j.consecutive_failures} consecutive failure${j.consecutive_failures === 1 ? '' : 's'}${j.last_error ? ` — ${String(j.last_error).slice(0, 140)}` : ''}`
        : j.state === 'stuck'
          ? 'marked running for over an hour — likely died mid-run'
          : j.state === 'stale'
            ? `last success ${j.last_success_age_minutes == null ? 'never' : `${Math.round(j.last_success_age_minutes / 1440)} days ago`} — may have stopped firing`
            : 'running',
      at: j.last_started_at || j.last_success_at || null,
    }));
  return finish(items);
}

async function laneCallProcessing() {
  // Open rows (null / pending / processing) carry NO date window — an
  // indefinitely stalled call is exactly what this lane must surface.
  // Only terminal failures are windowed to the recent week.
  // Live rows carry the watchdog's time-independent eligibility prefilter
  // (a SID, something to process, long enough to process) BEFORE the scan
  // cap, exactly as its candidates() query does — otherwise rows that can
  // never become stalls (dead-air blips, SID-less rows) fill the oldest-first
  // page and hide the real ones behind them.
  // Eligibility applies to every retryable state — null / pending /
  // processing AND no_transcription (the processor cannot reclaim an
  // ineligible no_transcription row either; it would sit "pending" forever).
  const eligible = (b) => b
          .whereNotNull('twilio_call_sid')
          .where(function longEnoughToProcess() {
            this.whereRaw('COALESCE(recording_duration_seconds, duration_seconds, 0) > ?', [MIN_DURATION_SECONDS - 1])
              .orWhere(function panQuarantined() {
                this.whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'").whereNotNull('transcription');
              });
          })
          .where(function somethingToProcess() {
            this.whereRaw("NULLIF(btrim(recording_url), '') IS NOT NULL")
              .orWhere(function panQuarantined() {
                this.whereRaw("(transcription_metadata::jsonb ->> 'pan_detected') = 'true'").whereNotNull('transcription');
              });
          });
  // Column set = the watchdog's candidates() select: computeStalledCalls
  // reads metadata (recording-ready time), the SID and the customer id.
  const columns = ['id', 'twilio_call_sid', 'customer_id', 'from_phone', 'to_phone', 'direction', 'processing_status', 'processing_heartbeat_at', 'processing_started_at', 'updated_at', 'created_at', 'extraction_attempts', 'metadata', 'recording_url', 'recording_duration_seconds', 'duration_seconds', 'transcription', 'transcription_metadata'];
  // Live rows (the watchdog's stall candidates: null / pending / processing):
  // oldest claim first — a stuck call is by definition old, and a newest-first
  // cap would hide exactly the rows this lane exists for.
  const live = await eligible(db('call_log')
    .where(function liveStatus() {
      this.whereNull('processing_status').orWhereIn('processing_status', ['pending', 'processing']);
    }))
    .orderByRaw('COALESCE(processing_heartbeat_at, processing_started_at, updated_at, created_at) ASC')
    .limit(SCAN_LIMIT)
    .select(columns);
  // no_transcription retries (prompt, no age fence, never a stall candidate)
  // scanned SEPARATELY: a backlog of old retry rows must never fill the live
  // page ahead of the stalled calls it monitors.
  const retryRows = await eligible(db('call_log').where('processing_status', 'no_transcription'))
    .orderBy('updated_at', 'desc')
    .limit(SCAN_LIMIT)
    .select(columns);
  // extraction_failed: retried while under the attempt cap AND inside the
  // processor's 7-day CREATION fence (PAN-quarantined rows keep recording_url
  // null by design and still retry); at the cap, or created before the fence,
  // it is terminal — processAllPending never resurrects it. Scanned SEPARATELY
  // so a backlog of live rows can never push failures out of the page, and
  // windowed by the FAILURE event (updated_at), not creation: an admin
  // force-reprocess of an old call that fails again is a fresh failure that
  // needs attention, and a creation window would hide it.
  // Same eligibility as the live set: an under-cap retry the processor could
  // never pick up is not "retry scheduled", and at-cap rows are terminal
  // either way.
  const failedRows = await eligible(db('call_log')
    .where('processing_status', 'extraction_failed')
    .where('updated_at', '>', since(RECENT_DAYS)))
    .orderBy('updated_at', 'desc')
    .limit(SCAN_LIMIT)
    .select(columns);
  const rows = [...failedRows, ...live, ...retryRows];
  // One stall definition, the watchdog's (grace window, live-claim heartbeat,
  // alert ceiling, eligibility) — the tab must never disagree with the bell.
  const stalledIds = new Set(computeStalledCalls(rows).map((r) => r.id));
  const items = rows.map((r) => {
    const ps = r.processing_status || 'pending';
    let status = 'pending';
    let detail = ps === 'processing' ? 'transcribing / extracting' : 'waiting for the processor';
    const attempts = Number(r.extraction_attempts) || 0;
    if (ps === 'no_transcription') {
      // Known-failed retry: processAllPending re-runs it on the next tick.
      detail = 'no transcript yet — retry scheduled';
    } else if (ps === 'extraction_failed' && attempts < CALL_EXTRACTION_MAX_ATTEMPTS && new Date(r.created_at) > since(RECENT_DAYS)) {
      detail = `extraction failed, retry scheduled (${attempts}/${CALL_EXTRACTION_MAX_ATTEMPTS})`;
    } else if (ps === 'extraction_failed' && attempts < CALL_EXTRACTION_MAX_ATTEMPTS) {
      // Under the cap but outside the sweep's creation fence: nothing will
      // retry it automatically (a force-reprocess that failed again lands here).
      status = 'failed';
      detail = `extraction failed (${attempts}/${CALL_EXTRACTION_MAX_ATTEMPTS}) — call older than the ${RECENT_DAYS}-day retry window, no automatic retry`;
    } else if (ps === 'extraction_failed') {
      status = 'failed';
      detail = `extraction failed after ${attempts} attempts — triage filed`;
    } else if (stalledIds.has(r.id)) {
      status = 'parked';
      detail = `stalled in ${ps} — the watchdog's stall rule`;
    }
    return {
      id: r.id,
      // The far end: to_phone on an outbound call, from_phone inbound.
      title: `${r.direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${(r.direction === 'outbound' ? r.to_phone : r.from_phone) || 'unknown number'}`,
      status,
      detail,
      // Failures dated by the failure event, live rows by the call.
      at: iso(status === 'failed' ? (r.updated_at || r.created_at) : r.created_at),
      href: '/admin/communications#tab=calls',
    };
  });
  // The extraction_failed scan feeds BOTH statuses (under-cap rows inside the
  // fence classify as pending retries), so a capped scan floors both counts.
  return finish(items, { truncated: [...capped(failedRows, 'failed', 'pending'), ...capped(live, 'parked', 'pending'), ...capped(retryRows, 'pending')] });
}

async function laneContentParks() {
  const { listReviewItems } = require('./content/autonomous-review-queue');
  const result = await listReviewItems({ status: 'pending_review', limit: SCAN_LIMIT });
  if (result?.unavailable) throw new Error('review tables unavailable');
  const reviews = Array.isArray(result?.items) ? result.items : [];
  const items = reviews.map((it) => ({
    id: it.id,
    // buildReviewItem exposes the targeting fields, not the brief object
    // (GitHub Codex r3 P2): keyword first, then the mined query / page.
    title: it.target_keyword || it.query || it.target_url || `Opportunity ${String(it.id).slice(0, 8)}`,
    status: 'parked',
    detail: it.skip_reason ? `parked: ${String(it.skip_reason).replace(/_/g, ' ')}` : 'awaiting review',
    at: iso(it.run?.completed_at || it.run?.claimed_at || it.updated_at || it.mined_at),
    href: '/admin/blog?tab=autopilot',
  }));
  // listReviewItems caps its page (100) below SCAN_LIMIT but returns exact
  // per-status counts alongside — use them for the true total.
  const exact = Number(result?.counts?.pending_review);
  const total = Number.isFinite(exact) ? Math.max(exact, items.length) : items.length;
  // Every pending_review row is a park, so the exact count IS the parked
  // count. The count is exact even when the item page is short — never
  // mark it truncated (that renders as a "150+" floor).
  return { ...finish(items, { total }), parked: total };
}

async function laneEmailApprovals() {
  const cols = ['id', 'token', 'kind', 'status', 'last_error', 'email_sent_at', 'created_at', 'updated_at'];
  // Failures scanned separately (never crowded out by the open set) and
  // timestamped by the failure event, not the original request.
  const failedRows = await db('content_email_approvals')
    .where('status', 'failed').where('updated_at', '>', since(RECENT_DAYS))
    .orderBy('updated_at', 'desc').limit(SCAN_LIMIT).select(cols);
  const openRows = await db('content_email_approvals')
    .whereIn('status', ['awaiting_reply', 'executing'])
    .orderBy('created_at', 'desc').limit(SCAN_LIMIT).select(cols);
  const rows = [...failedRows, ...openRows];
  const staleExecutingBefore = Date.now() - EXECUTING_RECOVERY_MINUTES * 60_000;
  const items = rows.map((r) => {
    let status = 'parked';
    let detail = 'awaiting an email reply';
    if (r.status === 'failed') {
      status = 'failed';
      detail = `approval failed${r.last_error ? ` — ${String(r.last_error).slice(0, 140)}` : ''}`;
    } else if (r.status === 'executing') {
      // Same rule as recoverExecutingRows: an execution older than the
      // recovery window is an orphaned claim (or the poller is down), not
      // healthy work in flight.
      const stale = r.updated_at && new Date(r.updated_at).getTime() < staleExecutingBefore;
      status = stale ? 'parked' : 'pending';
      detail = stale ? `executing for over ${EXECUTING_RECOVERY_MINUTES} minutes — orphaned claim, awaiting recovery` : 'reply received, executing';
    } else if (!r.email_sent_at) {
      // No human has anything to answer yet; the poller retries the send.
      status = 'pending';
      detail = 'approval email not yet sent';
    }
    return {
      id: r.id,
      title: `${r.token} · ${String(r.kind || '').replace(/_/g, ' ')}`,
      status,
      detail,
      at: iso(r.status === 'failed' ? (r.updated_at || r.created_at) : r.created_at),
    };
  });
  return finish(items, { truncated: [...capped(failedRows, 'failed'), ...capped(openRows, 'parked', 'pending')] });
}

async function laneIbPendingActions() {
  const rows = await db('ib_pending_actions')
    .where('status', 'pending')
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'tool_name', 'context', 'expires_at', 'created_at');
  // Title from the tool label only: the card's `summary` flattens display
  // params (an SMS body among them) and never belongs in a metadata view.
  const items = rows.map((r) => ({
    id: r.id,
    title: toolTitle(r.tool_name),
    status: 'parked',
    detail: `awaiting confirmation on the card${r.context ? ` · ${r.context}` : ''} · expires ${iso(r.expires_at)}`,
    at: iso(r.created_at),
  }));
  return finish(items, { truncated: capped(rows, 'parked') });
}

async function laneReportDelivery() {
  const dCols = ['id', 'service_record_id', 'channel', 'status', 'attempts', 'max_attempts', 'next_attempt_at', 'failed_at', 'locked_at', 'created_at'];
  const pCols = ['id', 'service_record_id', 'status', 'failed_at', 'locked_at', 'created_at'];
  // Same rule as each queue's recover-stale-claims sweep: a claim (sending /
  // rendering) whose lock is older than STALE_CLAIM_MS is orphaned — and if
  // the sweep is down, this view is the only place it shows.
  const staleClaim = (r, claimStatus, staleMs) => r.status === claimStatus
    && r.locked_at && new Date(r.locked_at).getTime() <= Date.now() - staleMs;
  // Failed, claimed and queued sets scanned separately so a backlog can never
  // push the failures — or the stale claims — out of the page. Claims scan
  // OLDEST lock first: a stale claim is by definition old, and a newest-first
  // cap would hide exactly the rows the stale rule exists for.
  const dFailed = await db('service_report_deliveries').where('status', 'failed').where('failed_at', '>', since(RECENT_DAYS)).orderBy('failed_at', 'desc').limit(SCAN_LIMIT).select(dCols);
  const dClaimed = await db('service_report_deliveries').where('status', 'sending').orderByRaw('COALESCE(locked_at, created_at) ASC').limit(SCAN_LIMIT).select(dCols);
  const dQueued = await db('service_report_deliveries').where('status', 'queued').orderBy('created_at', 'desc').limit(SCAN_LIMIT).select(dCols);
  const pFailed = await db('service_report_pdf_jobs').where('status', 'failed').where('failed_at', '>', since(RECENT_DAYS)).orderBy('failed_at', 'desc').limit(SCAN_LIMIT).select(pCols);
  const pClaimed = await db('service_report_pdf_jobs').where('status', 'rendering').orderByRaw('COALESCE(locked_at, created_at) ASC').limit(SCAN_LIMIT).select(pCols);
  const pQueued = await db('service_report_pdf_jobs').where('status', 'queued').orderBy('created_at', 'desc').limit(SCAN_LIMIT).select(pCols);
  const deliveries = [...dFailed, ...dClaimed, ...dQueued];
  const pdfs = [...pFailed, ...pClaimed, ...pQueued];
  const items = [
    ...deliveries.map((r) => ({
      id: `delivery:${r.id}`,
      title: `Report ${r.channel || 'email'} delivery · record ${String(r.service_record_id || '').slice(0, 8)}`,
      status: r.status === 'failed' ? 'failed' : staleClaim(r, 'sending', DELIVERY_STALE_CLAIM_MS) ? 'parked' : 'pending',
      detail: r.status === 'failed'
        ? `failed after ${r.attempts}/${r.max_attempts} attempts`
        : staleClaim(r, 'sending', DELIVERY_STALE_CLAIM_MS)
          ? `sending claim older than ${Math.round(DELIVERY_STALE_CLAIM_MS / 60000)} minutes — orphaned, awaiting recovery`
          : `${r.status} · attempt ${r.attempts + 1}/${r.max_attempts}`,
      at: iso(r.failed_at || r.created_at),
    })),
    ...pdfs.map((r) => ({
      id: `pdf:${r.id}`,
      title: `Report PDF · record ${String(r.service_record_id || '').slice(0, 8)}`,
      status: r.status === 'failed' ? 'failed' : staleClaim(r, 'rendering', PDF_STALE_CLAIM_MS) ? 'parked' : 'pending',
      detail: r.status === 'failed'
        ? 'render failed'
        : staleClaim(r, 'rendering', PDF_STALE_CLAIM_MS)
          ? `rendering claim older than ${Math.round(PDF_STALE_CLAIM_MS / 60000)} minutes — orphaned, awaiting recovery`
          : r.status,
      at: iso(r.failed_at || r.created_at),
    })),
  ];
  return finish(items, {
    truncated: [
      ...capped(dFailed, 'failed'), ...capped(pFailed, 'failed'),
      ...capped(dClaimed, 'parked', 'pending'), ...capped(pClaimed, 'parked', 'pending'),
      ...capped(dQueued, 'pending'), ...capped(pQueued, 'pending'),
    ],
  });
}

async function laneFollowUps() {
  const rows = await db('dispatch_alerts')
    .where('type', 'follow_up_needed')
    .whereNull('resolved_at')
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'severity', 'payload', 'created_at');
  const items = rows.map((r) => {
    const p = typeof r.payload === 'string' ? (() => { try { return JSON.parse(r.payload); } catch { return {}; } })() : (r.payload || {});
    // Keys as written by typed-followup-obligation.parkFollowupAlert.
    const who = p.customerName || 'customer';
    const what = p.serviceType ? String(p.serviceType).replace(/_/g, ' ') : 'follow-up visit';
    const due = p.suggestedFollowupDate ? ` · suggested ${p.suggestedFollowupDate}` : '';
    return {
      id: r.id,
      title: `${who} · ${what}`,
      status: 'parked',
      detail: `follow-up not yet scheduled${due}${r.severity && r.severity !== 'info' ? ` · ${r.severity}` : ''}`,
      at: iso(r.created_at),
      href: '/admin/dispatch',
    };
  });
  return finish(items, { truncated: capped(rows, 'parked') });
}

async function laneAdminAlerts() {
  // Open, plus snoozed alerts whose snooze has elapsed — they are due again.
  const due = (b) => b.whereNot('type', 'lawn_protocol_readiness').where(function whereDue() {
    this.where('status', 'open')
      .orWhere(function whereSnoozeElapsed() {
        this.where('status', 'snoozed').where('snoozed_until', '<=', new Date());
      });
  });
  const aCols = ['id', 'type', 'status', 'severity', 'title', 'href', 'detected_at', 'last_seen_at'];
  // High/critical (the failed rows) scanned separately from the rest.
  const hot = await due(db('admin_alerts')).whereIn('severity', ['critical', 'high']).orderBy('last_seen_at', 'desc').limit(SCAN_LIMIT).select(aCols);
  const rest = await due(db('admin_alerts')).whereNotIn('severity', ['critical', 'high']).orderBy('last_seen_at', 'desc').limit(SCAN_LIMIT).select(aCols);
  const rows = [...hot, ...rest];
  const items = rows.map((r) => ({
    id: r.id,
    title: r.title || String(r.type || '').replace(/_/g, ' '),
    status: r.severity === 'critical' || r.severity === 'high' ? 'failed' : 'parked',
    detail: `${r.severity} · ${String(r.type || '').replace(/_/g, ' ')}${r.status === 'snoozed' ? ' · snooze elapsed' : ''}`,
    at: iso(r.last_seen_at || r.detected_at),
    href: r.href || null,
  }));
  return finish(items, { truncated: [...capped(hot, 'failed'), ...capped(rest, 'parked')] });
}

const LANES = [
  { key: 'jobs', label: 'Scheduled jobs', run: laneScheduledJobs },
  { key: 'calls', label: 'Call processing', run: laneCallProcessing },
  { key: 'content', label: 'Content engine parks', run: laneContentParks },
  { key: 'approvals', label: 'Email-reply approvals', run: laneEmailApprovals },
  { key: 'ib', label: 'Intelligence Bar confirmations', run: laneIbPendingActions },
  { key: 'reports', label: 'Service report delivery', run: laneReportDelivery },
  { key: 'followups', label: 'Follow-up visits owed', run: laneFollowUps },
  { key: 'alerts', label: 'Open admin alerts', run: laneAdminAlerts },
];

async function getOpsQueue() {
  const lanes = await Promise.all(LANES.map(async ({ key, label, run }) => {
    try {
      const r = await run();
      return { key, label, error: null, ...r };
    } catch (err) {
      logger.warn(`[ops-queue] lane ${key} failed: ${err.message}`);
      return { key, label, error: err.message, pending: 0, parked: 0, failed: 0, total: 0, truncated: false, truncatedStatuses: [], items: [] };
    }
  }));
  const truncatedStatuses = [...new Set(lanes.flatMap((l) => l.truncatedStatuses || []))];
  const totals = lanes.reduce((acc, l) => ({
    pending: acc.pending + l.pending,
    parked: acc.parked + l.parked,
    failed: acc.failed + l.failed,
  }), { pending: 0, parked: 0, failed: 0 });
  totals.truncated = truncatedStatuses.length > 0;
  totals.truncatedStatuses = truncatedStatuses;
  return { generatedAt: new Date().toISOString(), totals, lanes };
}

module.exports = { getOpsQueue, LANES, ITEM_LIMIT };
