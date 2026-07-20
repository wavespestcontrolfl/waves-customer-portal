/**
 * WDO report attention sweep — exception-based ops guard for the WDO lane.
 *
 * The report-lifecycle automation only covered payment-hold releases; nothing
 * noticed a WDO that stalled BEFORE send. The July 2026 audit found three
 * flavors sitting silently in prod: inspections stuck on_site/pending days
 * past their date with no report ever created, reports signed and then never
 * sent, and (potentially) paid holds whose release keeps failing. Each is a
 * legal filing a realtor/closing is waiting on — this sweep rings ONE admin
 * bell when any of them exists.
 *
 * Exception-based by design (owner's standing rule): quiet when the lane is
 * clean, one deduped notification when it isn't. A bell re-rings only when a
 * NEW item appears that no prior bell covered, or when the newest covering
 * bell is older than REMIND_DAYS (a stuck item shouldn't go silent forever).
 *
 * Gate: wdoReportAttention (GATE_WDO_REPORT_ATTENTION). Reads projects +
 * scheduled_services; writes nothing but admin notifications.
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { etDateString } = require('../utils/datetime-et');

const SIGNED_UNSENT_HOURS = 48;
const STUCK_APPT_HOURS = 24;
const HOLD_ATTENTION_ATTEMPTS = 5;
const REMIND_DAYS = 7;
const CATEGORY = 'wdo_report_attention';

// Query failures propagate — a schema/connection outage must surface as a
// failed sweep in the scheduler's error log, never as clean:true (this sweep
// exists to catch silence; it can't be allowed to produce it).
async function findAttentionItems(now = new Date()) {
  // Signed but never sent: the licensee did their part and the filing is
  // sitting in drafts. 48h grace covers the normal same-week office send.
  // Aged from the signature's own signed_at — updated_at moves on every
  // unrelated edit or staleness bookkeeping write, which would restart the
  // clock and postpone the alert indefinitely. Legacy signatures without a
  // signed_at fall back to updated_at.
  // sent_at IS NULL, not status='draft': the /close path permits closing a
  // signed WDO without a successful send, and that filing is exactly as
  // stalled as a draft one.
  const signedUnsent = await db('projects')
    .where({ project_type: 'wdo_inspection' })
    .whereNull('sent_at')
    .whereNotNull('wdo_signature')
    // Pay-before-report holds park signed drafts INTENTIONALLY (status stays
    // 'draft' until the invoice is paid) — those aren't stalled, and failing
    // holds already ring via the stuck-hold bucket. Excluding them keeps
    // this bucket exception-only.
    .whereRaw("coalesce(report_hold_status, '') NOT IN ('held', 'releasing')")
    .whereRaw("coalesce((wdo_signature->>'signed_at')::timestamptz, updated_at) < ?", [
      new Date(now.getTime() - SIGNED_UNSENT_HOURS * 3600e3),
    ])
    .select('id', 'customer_id', 'project_date', 'updated_at');

  // Inspection happened (or was due) and the visit is still in an ACTIVE
  // state — allowlist, not a terminal-state blocklist, so rescheduled /
  // skipped / any future terminal status can never ring a false alarm.
  // A linked project row does NOT exempt the visit: a past-date on_site
  // WITH a draft report is a half-finished closeout, still a stall.
  // scheduled_date is an ET wall-clock DATE — compare it to an ET calendar
  // date, never a UTC instant (a JS timestamp cutoff would flag a visit on
  // its own scheduled evening once UTC rolls past midnight).
  const stuckApptCutoff = etDateString(new Date(now.getTime() - STUCK_APPT_HOURS * 3600e3));
  const stuckAppts = await db('scheduled_services as ss')
    // LEFT join + service_type fallback: legacy rows carry a null service_id
    // with only the free-text service_type — an inner join would silently
    // drop exactly the old compliance visits most likely to be stalled.
    .leftJoin('services as s', 's.id', 'ss.service_id')
    .where((q) => q
      .where('s.name', 'ilike', '%wdo%')
      .orWhere((legacy) => legacy.whereNull('ss.service_id').where('ss.service_type', 'ilike', '%wdo%')))
    .where('ss.scheduled_date', '<', stuckApptCutoff)
    .whereIn('ss.status', ['pending', 'confirmed', 'en_route', 'on_site'])
    .select('ss.id', 'ss.status', 'ss.scheduled_date', 'ss.customer_id');

  // A paid-for held report whose release keeps failing retries forever by
  // design (no terminal cap) — after enough attempts a human needs to look
  // at report_hold_last_error instead of waiting out the backoff.
  const stuckHolds = await db('projects')
    .whereIn('project_type', ['wdo_inspection', 'pre_treatment_termite_certificate'])
    .where('report_hold_status', 'held')
    .where('report_hold_attempts', '>=', HOLD_ATTENTION_ATTEMPTS)
    .select('id', 'report_hold_attempts', 'report_hold_last_error');

  return { signedUnsent, stuckAppts, stuckHolds };
}

function itemIds({ signedUnsent, stuckAppts, stuckHolds }) {
  return [
    ...signedUnsent.map((p) => `signed_unsent:${p.id}`),
    ...stuckAppts.map((a) => `stuck_appt:${a.id}`),
    ...stuckHolds.map((p) => `stuck_hold:${p.id}`),
  ].sort();
}

// Every current item already covered by a bell newer than REMIND_DAYS → stay
// quiet. Any uncovered item, or only-stale coverage → ring (with the full
// current picture, not just the delta).
async function priorBellCovers(currentIds, now = new Date()) {
  const since = new Date(now.getTime() - REMIND_DAYS * 24 * 3600e3);
  // Propagates on failure (same contract as findAttentionItems): a broken
  // dedupe read must fail the sweep loudly, not silently re-ring or go quiet.
  const priors = await db('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .where('created_at', '>', since)
    .select('metadata');
  const covered = new Set();
  for (const row of priors) {
    let meta = row.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    for (const id of meta?.item_ids || []) covered.add(id);
  }
  return currentIds.every((id) => covered.has(id));
}

function summarize({ signedUnsent, stuckAppts, stuckHolds }) {
  const parts = [];
  if (signedUnsent.length) {
    parts.push(`${signedUnsent.length} WDO report${signedUnsent.length === 1 ? '' : 's'} signed but never sent`);
  }
  if (stuckAppts.length) {
    parts.push(`${stuckAppts.length} WDO inspection${stuckAppts.length === 1 ? '' : 's'} past date without a completed report`);
  }
  if (stuckHolds.length) {
    parts.push(`${stuckHolds.length} held report${stuckHolds.length === 1 ? '' : 's'} failing release`);
  }
  return parts.join(' · ');
}

async function runWdoReportAttentionSweep({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('wdoReportAttention')) return { skipped: true, reason: 'gated_off' };

  // Read-then-notify with no unique constraint — serialize across replicas
  // and deploy overlap the same way the call-ingest watchdog does.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('wdo-report-attention', async () => {
    const items = await findAttentionItems(now);
    const ids = itemIds(items);
    if (!ids.length) return { ok: true, clean: true };
    if (await priorBellCovers(ids, now)) return { ok: true, deduped: true, items: ids.length };

    const summary = summarize(items);
    const bell = await NotificationService.notifyAdmin(
      CATEGORY,
      'WDO reports need attention',
      `${summary}. Open the projects list to finish and send them — each is a dated FDACS filing someone is waiting on.`,
      {
        link: '/admin/projects',
        metadata: {
          dedupeKey: `${CATEGORY}:${ids.join('|').slice(0, 200)}`,
          item_ids: ids,
          signed_unsent: items.signedUnsent.map((p) => p.id),
          stuck_appointments: items.stuckAppts.map((a) => a.id),
          stuck_holds: items.stuckHolds.map((p) => p.id),
        },
      },
    );
    // notifyAdmin returns null when the insert fails (its create() swallows
    // the error) — a bell that didn't land must fail the sweep loudly, not
    // record a ring and go quiet for six hours. (Intentional suppression
    // returns a truthy sentinel and correctly counts as rung.)
    if (!bell) throw new Error('admin notification insert failed — bell not recorded');
    logger.info(`[wdo-report-attention] rang: ${summary}`);
    return { ok: true, rang: true, items: ids.length };
  });
}

module.exports = { runWdoReportAttentionSweep, _private: { findAttentionItems, itemIds, priorBellCovers, summarize } };
