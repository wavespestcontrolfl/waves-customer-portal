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

const ITEM_LIMIT = 25;
const SCAN_LIMIT = 200;
const RECENT_DAYS = 7;
// Mirrors call-processing-stall-watchdog: a claim older than this with no
// terminal status is a stall, not work in progress.
const CALL_STALL_MINUTES = 10;

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

function finish(items) {
  const rank = { failed: 0, parked: 1, pending: 2 };
  const sorted = [...items].sort((a, b) => {
    const r = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    if (r !== 0) return r;
    return String(b.at || '').localeCompare(String(a.at || ''));
  });
  return { ...tally(sorted), total: sorted.length, items: sorted.slice(0, ITEM_LIMIT) };
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
  const rows = await db('call_log')
    .whereNotNull('recording_url')
    .where('created_at', '>', since(RECENT_DAYS))
    .where(function whereOpen() {
      this.whereNull('processing_status')
        .orWhereIn('processing_status', ['pending', 'processing', 'extraction_failed', 'no_transcription']);
    })
    // Oldest claim first: a stuck call is by definition old, and a
    // newest-first cap would hide exactly the rows this lane exists for.
    .orderByRaw('COALESCE(processing_heartbeat_at, processing_started_at, updated_at, created_at) ASC')
    .limit(SCAN_LIMIT)
    .select('id', 'from_phone', 'direction', 'processing_status', 'processing_heartbeat_at', 'processing_started_at', 'updated_at', 'created_at', 'extraction_attempts');
  const stallBefore = Date.now() - CALL_STALL_MINUTES * 60000;
  const items = rows.map((r) => {
    const ps = r.processing_status || 'pending';
    let status = 'pending';
    let detail = ps === 'processing' ? 'transcribing / extracting' : 'waiting for the processor';
    if (ps === 'extraction_failed' || ps === 'no_transcription') {
      status = 'failed';
      detail = ps === 'no_transcription' ? 'no transcript could be produced' : `extraction failed (${r.extraction_attempts || 0} attempt${r.extraction_attempts === 1 ? '' : 's'})`;
    } else {
      // The heartbeat is the authoritative liveness signal (the processor
      // stamps it mid-run); start/updated are the fallback for old rows.
      const lastAlive = new Date(r.processing_heartbeat_at || r.processing_started_at || r.updated_at || r.created_at).getTime();
      if (lastAlive && lastAlive < stallBefore) {
        status = 'parked';
        detail = `stalled in ${ps} for over ${CALL_STALL_MINUTES} minutes`;
      }
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
  return finish(items);
}

async function laneContentParks() {
  const { listReviewItems } = require('./content/autonomous-review-queue');
  const reviews = await listReviewItems({ status: 'pending_review', limit: SCAN_LIMIT });
  const items = (reviews || []).map((it) => ({
    id: it.id,
    title: it.brief?.title || it.brief?.topic || it.opportunity_key || it.key || `Opportunity ${String(it.id).slice(0, 8)}`,
    status: 'parked',
    detail: it.skip_reason ? `parked: ${String(it.skip_reason).replace(/_/g, ' ')}` : 'awaiting review',
    at: iso(it.run?.completed_at || it.run?.claimed_at || it.updated_at || it.mined_at),
    href: '/admin/blog?tab=autopilot',
  }));
  return finish(items);
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
  return finish(items);
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
  return finish(items);
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
  return finish(items);
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
  return finish(items);
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
  return finish(items);
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
      return { key, label, error: err.message, pending: 0, parked: 0, failed: 0, total: 0, items: [] };
    }
  }));
  const totals = lanes.reduce((acc, l) => ({
    pending: acc.pending + l.pending,
    parked: acc.parked + l.parked,
    failed: acc.failed + l.failed,
  }), { pending: 0, parked: 0, failed: 0 });
  return { generatedAt: new Date().toISOString(), totals, lanes };
}

module.exports = { getOpsQueue, LANES, ITEM_LIMIT };
