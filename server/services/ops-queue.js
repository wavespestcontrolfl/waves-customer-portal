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

const ITEM_LIMIT = 25;
const SCAN_LIMIT = 200;
const RECENT_DAYS = 7;

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

// `truncated` = a scan hit SCAN_LIMIT, so counts are a floor, not a total;
// the tab renders them as "200+". Cheaper and more honest than a second
// count query per lane on a view that refreshes on demand.
function finish(items, { truncated = false, total = null } = {}) {
  const rank = { failed: 0, parked: 1, pending: 2 };
  const sorted = [...items].sort((a, b) => {
    const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (r !== 0) return r;
    return String(b.at || '').localeCompare(String(a.at || ''));
  });
  return { ...tally(sorted), total: total ?? sorted.length, truncated, items: sorted.slice(0, ITEM_LIMIT) };
}

function hitCap(rows) {
  return Array.isArray(rows) && rows.length >= SCAN_LIMIT;
}

async function laneScheduledJobs() {
  const health = await getScheduledJobHealth();
  if (health?.error) throw new Error(health.error);
  const items = (health.jobs || [])
    .filter((j) => j.state !== 'healthy')
    .map((j) => ({
      id: j.job,
      title: j.job,
      status: j.state === 'running' ? 'pending' : j.state === 'stale' ? 'parked' : 'failed',
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
  const rows = await db('call_log')
    .where(function whereOpen() {
      this.where(function whereLive() {
        this.where(function liveStatus() {
          this.whereNull('processing_status').orWhereIn('processing_status', ['pending', 'processing']);
        })
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
      }).orWhere(function whereFailedRecent() {
        this.whereIn('processing_status', ['extraction_failed', 'no_transcription'])
          .whereNotNull('recording_url')
          .where('created_at', '>', since(RECENT_DAYS));
      });
    })
    // Oldest claim first: a stuck call is by definition old, and a
    // newest-first cap would hide exactly the rows this lane exists for.
    .orderByRaw('COALESCE(processing_heartbeat_at, processing_started_at, updated_at, created_at) ASC')
    .limit(SCAN_LIMIT)
    .select('id', 'from_phone', 'direction', 'processing_status', 'processing_heartbeat_at', 'processing_started_at', 'updated_at', 'created_at', 'extraction_attempts', 'recording_url', 'recording_duration_seconds', 'duration_seconds', 'transcription', 'transcription_metadata');
  // One stall definition, the watchdog's (grace window, live-claim heartbeat,
  // alert ceiling, eligibility) — the tab must never disagree with the bell.
  const stalledIds = new Set(computeStalledCalls(rows).map((r) => r.id));
  const items = rows.map((r) => {
    const ps = r.processing_status || 'pending';
    let status = 'pending';
    let detail = ps === 'processing' ? 'transcribing / extracting' : 'waiting for the processor';
    if (ps === 'extraction_failed' || ps === 'no_transcription') {
      status = 'failed';
      detail = ps === 'no_transcription' ? 'no transcript could be produced' : `extraction failed (${r.extraction_attempts || 0} attempt${r.extraction_attempts === 1 ? '' : 's'})`;
    } else if (stalledIds.has(r.id)) {
      status = 'parked';
      detail = `stalled in ${ps} — the watchdog's stall rule`;
    }
    return {
      id: r.id,
      title: `${r.direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${r.from_phone || 'unknown number'}`,
      status,
      detail,
      at: iso(r.created_at),
      href: '/admin/communications#tab=calls',
    };
  });
  return finish(items, { truncated: hitCap(rows) });
}

async function laneContentParks() {
  const { listReviewItems } = require('./content/autonomous-review-queue');
  const result = await listReviewItems({ status: 'pending_review', limit: SCAN_LIMIT });
  if (result?.unavailable) throw new Error('review tables unavailable');
  const reviews = Array.isArray(result?.items) ? result.items : [];
  const items = reviews.map((it) => ({
    id: it.id,
    title: it.brief?.title || it.brief?.topic || it.opportunity_key || it.key || `Opportunity ${String(it.id).slice(0, 8)}`,
    status: 'parked',
    detail: it.skip_reason ? `parked: ${String(it.skip_reason).replace(/_/g, ' ')}` : 'awaiting review',
    at: iso(it.run?.completed_at || it.run?.claimed_at || it.updated_at || it.mined_at),
    href: '/admin/blog?tab=autopilot',
  }));
  // listReviewItems caps its page (100) below SCAN_LIMIT but returns exact
  // per-status counts alongside — use them for the true total.
  const exact = Number(result?.counts?.pending_review);
  const total = Number.isFinite(exact) ? Math.max(exact, items.length) : items.length;
  return finish(items, { truncated: total > items.length, total });
}

async function laneEmailApprovals() {
  const rows = await db('content_email_approvals')
    .where(function whereOpen() {
      this.whereIn('status', ['awaiting_reply', 'executing'])
        .orWhere(function whereFailed() {
          this.where('status', 'failed').where('updated_at', '>', since(RECENT_DAYS));
        });
    })
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'token', 'kind', 'status', 'last_error', 'email_sent_at', 'created_at');
  const items = rows.map((r) => ({
    id: r.id,
    title: `${r.token} · ${String(r.kind || '').replace(/_/g, ' ')}`,
    status: r.status === 'failed' ? 'failed' : r.status === 'executing' ? 'pending' : 'parked',
    detail: r.status === 'failed'
      ? `approval failed${r.last_error ? ` — ${String(r.last_error).slice(0, 140)}` : ''}`
      : r.status === 'executing' ? 'reply received, executing' : (r.email_sent_at ? 'awaiting an email reply' : 'approval email not yet sent'),
    at: iso(r.created_at),
  }));
  return finish(items, { truncated: hitCap(rows) });
}

async function laneIbPendingActions() {
  const rows = await db('ib_pending_actions')
    .where('status', 'pending')
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'tool_name', 'summary', 'context', 'expires_at', 'created_at');
  const items = rows.map((r) => ({
    id: r.id,
    title: r.summary || String(r.tool_name || '').replace(/_/g, ' '),
    status: 'parked',
    detail: `awaiting confirmation on the card${r.context ? ` · ${r.context}` : ''} · expires ${iso(r.expires_at)}`,
    at: iso(r.created_at),
  }));
  return finish(items, { truncated: hitCap(rows) });
}

async function laneReportDelivery() {
  const deliveries = await db('service_report_deliveries')
    .where(function whereOpen() {
      this.whereIn('status', ['queued', 'sending'])
        .orWhere(function whereFailed() {
          this.where('status', 'failed').where('failed_at', '>', since(RECENT_DAYS));
        });
    })
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'service_record_id', 'channel', 'status', 'attempts', 'max_attempts', 'next_attempt_at', 'failed_at', 'created_at');
  const pdfs = await db('service_report_pdf_jobs')
    .where(function whereOpen() {
      this.whereIn('status', ['queued', 'rendering'])
        .orWhere(function whereFailed() {
          this.where('status', 'failed').where('failed_at', '>', since(RECENT_DAYS));
        });
    })
    .orderBy('created_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'service_record_id', 'status', 'failed_at', 'created_at');
  const items = [
    ...deliveries.map((r) => ({
      id: `delivery:${r.id}`,
      title: `Report ${r.channel || 'email'} delivery · record ${String(r.service_record_id || '').slice(0, 8)}`,
      status: r.status === 'failed' ? 'failed' : 'pending',
      detail: r.status === 'failed'
        ? `failed after ${r.attempts}/${r.max_attempts} attempts`
        : `${r.status} · attempt ${r.attempts + 1}/${r.max_attempts}`,
      at: iso(r.failed_at || r.created_at),
    })),
    ...pdfs.map((r) => ({
      id: `pdf:${r.id}`,
      title: `Report PDF · record ${String(r.service_record_id || '').slice(0, 8)}`,
      status: r.status === 'failed' ? 'failed' : 'pending',
      detail: r.status === 'failed' ? 'render failed' : r.status,
      at: iso(r.failed_at || r.created_at),
    })),
  ];
  return finish(items, { truncated: hitCap(deliveries) || hitCap(pdfs) });
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
    const who = p.customerName || p.customer_name || 'customer';
    const what = p.serviceName || p.service_name || 'follow-up visit';
    return {
      id: r.id,
      title: `${who} · ${what}`,
      status: 'parked',
      detail: `follow-up not yet scheduled${r.severity && r.severity !== 'info' ? ` · ${r.severity}` : ''}`,
      at: iso(r.created_at),
      href: '/admin/dispatch',
    };
  });
  return finish(items, { truncated: hitCap(rows) });
}

async function laneAdminAlerts() {
  const rows = await db('admin_alerts')
    .where('status', 'open')
    .orderBy('last_seen_at', 'desc')
    .limit(SCAN_LIMIT)
    .select('id', 'type', 'severity', 'title', 'href', 'detected_at', 'last_seen_at');
  const items = rows.map((r) => ({
    id: r.id,
    title: r.title || String(r.type || '').replace(/_/g, ' '),
    status: r.severity === 'critical' || r.severity === 'high' ? 'failed' : 'parked',
    detail: `${r.severity} · ${String(r.type || '').replace(/_/g, ' ')}`,
    at: iso(r.last_seen_at || r.detected_at),
    href: r.href || null,
  }));
  return finish(items, { truncated: hitCap(rows) });
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
      return { key, label, error: err.message, pending: 0, parked: 0, failed: 0, total: 0, truncated: false, items: [] };
    }
  }));
  const totals = lanes.reduce((acc, l) => ({
    pending: acc.pending + l.pending,
    parked: acc.parked + l.parked,
    failed: acc.failed + l.failed,
    truncated: acc.truncated || l.truncated === true,
  }), { pending: 0, parked: 0, failed: 0, truncated: false });
  return { generatedAt: new Date().toISOString(), totals, lanes };
}

module.exports = { getOpsQueue, LANES, ITEM_LIMIT };
