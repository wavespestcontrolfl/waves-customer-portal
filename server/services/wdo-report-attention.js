/**
 * WDO report attention sweep — exception-based ops guard for the WDO lane.
 *
 * Nothing noticed a WDO that stalled BEFORE send. The July 2026 audit found
 * two flavors sitting silently in prod: inspections stuck on_site/pending
 * days past their date with no report ever created, and reports signed and
 * then never sent. Each is a legal filing a realtor/closing is waiting on —
 * this sweep rings ONE admin bell when any of them exists.
 *
 * Exception-based by design (owner's standing rule): quiet when the lane is
 * clean, one deduped notification when it isn't. A bell re-rings only when a
 * NEW item appears that no prior bell covered, or when the newest covering
 * bell is older than REMIND_DAYS (a stuck item shouldn't go silent forever).
 *
 * Gate: wdoReportAttention (GATE_WDO_REPORT_ATTENTION). Reads projects +
 * scheduled_services; writes nothing but admin notifications.
 *
 * GATE_WDO_ATTENTION_RINGS (owner 2026-11-05, wdoAttentionRingsLive): the bell
 * rings again. The category has no default under GATE_ADMIN_BELL_POLICY, so
 * the policy muted every ring (notifyAdmin returned a sentinel and wrote no
 * row), the sweep counted that as rung, and the last real alert row is from
 * August. On: the ring carries bellDefault (a saved owner "off" still wins), a
 * muted result is not a ring, the sweep closes its own open rows when nothing
 * is stalled, and a standing row is kept true when the set changes.
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
// Used through the module object, so a unit test can stand them in for their SQL.
const episodes = require('./admin-alert-episodes');
const { etDateString } = require('../utils/datetime-et');

const SIGNED_UNSENT_HOURS = 48;
const STUCK_APPT_HOURS = 24;
const REMIND_DAYS = 7;
const CATEGORY = 'wdo_report_attention';
const CLEARED_RESOLUTION = 'All WDO reports are sent and no WDO inspection is waiting.';
const SUPERSEDED_RESOLUTION = 'Replaced by a newer WDO alert.';

// GATE_WDO_ATTENTION_RINGS, read at call time; a missing or throwing reader reads as off.
function ringsLive() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.wdoAttentionRingsLive === 'function' && gates.wdoAttentionRingsLive() === true;
  } catch { return false; }
}

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
  // A report an admin marked "sent another way" (sent_outside_portal_at, set
  // by POST /api/admin/projects/:id/mark-sent-outside) left by some other
  // route, so it is not stalled: sent_at stays NULL for it, and this sweep
  // skips it.
  const signedUnsent = await db('projects')
    .where({ project_type: 'wdo_inspection' })
    .whereNull('sent_at')
    .whereNull('sent_outside_portal_at')
    .whereNotNull('wdo_signature')
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

  return { signedUnsent, stuckAppts };
}

function itemIds({ signedUnsent, stuckAppts }) {
  return [
    ...signedUnsent.map((p) => `signed_unsent:${p.id}`),
    ...stuckAppts.map((a) => `stuck_appt:${a.id}`),
  ].sort();
}

// Every current item already covered by a bell newer than REMIND_DAYS → stay
// quiet. Any uncovered item, or only-stale coverage → ring (with the full
// current picture, not just the delta).
// skipCleared (GATE_WDO_ATTENTION_RINGS): a row this sweep closed because the lane was clean no longer
// covers anything, so an item that comes back rings again.
async function priorBellCovers(currentIds, now = new Date(), { skipCleared = false } = {}) {
  const since = new Date(now.getTime() - REMIND_DAYS * 24 * 3600e3);
  // Propagates on failure (same contract as findAttentionItems): a broken
  // dedupe read must fail the sweep loudly, not silently re-ring or go quiet.
  let query = db('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .where('created_at', '>', since);
  if (skipCleared) query = query.whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'");
  const priors = await query.select('metadata');
  const covered = new Set();
  for (const row of priors) {
    let meta = row.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    for (const id of meta?.item_ids || []) covered.add(id);
  }
  return currentIds.every((id) => covered.has(id));
}

function summarize({ signedUnsent, stuckAppts }) {
  const parts = [];
  if (signedUnsent.length) {
    parts.push(`${signedUnsent.length} WDO report${signedUnsent.length === 1 ? '' : 's'} signed but never sent`);
  }
  if (stuckAppts.length) {
    parts.push(`${stuckAppts.length} WDO inspection${stuckAppts.length === 1 ? '' : 's'} past date without a completed report`);
  }
  return parts.join(' · ');
}

const dedupeKeyFor = (ids) => `${CATEGORY}:${ids.join('|').slice(0, 200)}`;

function bodyFor(items) {
  return `${summarize(items)}. Open the projects list to finish and send them — each is a dated FDACS filing someone is waiting on.`;
}

function bellMetadata(items, ids) {
  return {
    dedupeKey: dedupeKeyFor(ids),
    item_ids: ids,
    signed_unsent: items.signedUnsent.map((p) => p.id),
    stuck_appointments: items.stuckAppts.map((a) => a.id),
  };
}

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const m = JSON.parse(metadata); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

const sameIds = (stored, ids) => Array.isArray(stored) && JSON.stringify([...stored].sort()) === JSON.stringify(ids);

// Gate on: this sweep's rows that are still open (not done, not closed by a sweep), newest first.
async function standingRows() {
  const rows = await db('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereNull('done_at')
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'")
    .orderBy('created_at', 'desc')
    .select('id', 'metadata');
  return rows.map((r) => ({ id: r.id, meta: parseMeta(r.metadata) }));
}

// Gate on, nothing stalled: close every row this sweep left open, done by a person or not, so the bell does not keep
// an alert about reports that are sent. A person's earlier Done keeps its own stamps (closeAdminAlertKeys).
async function closeClearedRows(now) {
  const keys = await episodes.openAdminAlertKeys(db, `${CATEGORY}:`);
  const closed = keys.length
    ? await episodes.closeAdminAlertKeys(db, keys, 'wdo_reports_clear', { now, resolution: CLEARED_RESOLUTION })
    : 0;
  if (closed) logger.info(`[wdo-report-attention] lane clean, closed ${closed} standing alert row(s)`);
  return { ok: true, clean: true, closed };
}

// Gate on: an open row whose item set is not the current one is stale. When nothing new rang (items given: the
// current set is covered, so it only SHRANK), the newest stale row is rewritten in place and quietly to the current
// picture, so its count is true and the bell does not ring again for work the owner just did. Every other stale row,
// and every stale row after a new ring, is closed as replaced. A row already showing exactly the current set is
// left alone.
async function settleStandingRows(standing, { ids, now, items = null }) {
  const stale = standing.filter((r) => !sameIds(r.meta.item_ids, ids));
  if (!stale.length) return { refreshed: 0, closed: 0 };
  const rewrite = items && !standing.some((r) => sameIds(r.meta.item_ids, ids)) ? stale[0] : null;
  if (rewrite) {
    await db('notifications').where({ id: rewrite.id }).whereNull('done_at').update({
      ...NotificationService.adminBodyColumns(CATEGORY, bodyFor(items)),
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(bellMetadata(items, ids))]),
    });
  }
  const currentKey = dedupeKeyFor(ids);
  const keys = stale.filter((r) => r !== rewrite).map((r) => r.meta.dedupeKey).filter((k) => k && k !== currentKey);
  const closed = keys.length
    ? await episodes.closeAdminAlertKeys(db, keys, 'wdo_superseded', { now, resolution: SUPERSEDED_RESOLUTION })
    : 0;
  return { refreshed: rewrite ? 1 : 0, closed };
}

async function runWdoReportAttentionSweep({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('wdoReportAttention')) return { skipped: true, reason: 'gated_off' };

  // Read-then-notify with no unique constraint — serialize across replicas
  // and deploy overlap the same way the call-ingest watchdog does.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('wdo-report-attention', async () => {
    const live = ringsLive();
    const items = await findAttentionItems(now);
    const ids = itemIds(items);
    if (!ids.length) return live ? closeClearedRows(now) : { ok: true, clean: true };
    // Read once, before anything is written: the rows this run may close or rewrite.
    const standing = live ? await standingRows() : [];
    if (await priorBellCovers(ids, now, { skipCleared: live })) {
      if (!live) return { ok: true, deduped: true, items: ids.length };
      const settled = await settleStandingRows(standing, { ids, now, items });
      return { ok: true, deduped: true, items: ids.length, ...settled };
    }

    const summary = summarize(items);
    const bell = await NotificationService.notifyAdmin(
      CATEGORY,
      'WDO reports need attention',
      bodyFor(items),
      {
        link: '/admin/projects',
        // bellDefault: ring unless the owner saved "off" for the category (that override sits above it).
        ...(live ? { bellDefault: true } : {}),
        metadata: bellMetadata(items, ids),
      },
    );
    // notifyAdmin returns null when the insert fails (its create() swallows
    // the error) — a bell that didn't land must fail the sweep loudly, not
    // record a ring and go quiet for six hours. (Intentional suppression
    // returns a truthy sentinel and correctly counts as rung.)
    if (!bell) throw new Error('admin notification insert failed — bell not recorded');
    // Gate on: the sentinel ({ id: null, suppressed: true }, the bell policy or an internal test customer) wrote no
    // row, so nothing rang. Not recorded as a ring; the next run tries again.
    if (live && bell.suppressed === true) {
      logger.warn(`[wdo-report-attention] not rung: the alert was muted (${ids.length} item(s) wait)`);
      return { ok: true, rang: false, suppressed: true };
    }
    logger.info(`[wdo-report-attention] rang: ${summary}`);
    if (live) await settleStandingRows(standing, { ids, now });
    return { ok: true, rang: true, items: ids.length };
  });
}

module.exports = { runWdoReportAttentionSweep, _private: { findAttentionItems, itemIds, priorBellCovers, summarize, standingRows, settleStandingRows, closeClearedRows } };
