/**
 * Stale-visit sweep — exception-based ops guard for past-dated open visits.
 *
 * The 6PM missed-appointment check only looks at a yesterday→today window of
 * pending/confirmed rows, and the late/unassigned detectors are today-scoped —
 * anything that slips past them just accumulates silently. The July 2026 audit
 * found 250 past-dated scheduled_services still sitting in an open status
 * (pending/confirmed/en_route/on_site) with no surface listing them anywhere.
 * This sweep rings ONE admin bell summarizing that backlog.
 *
 * Detection-only by design (owner's standing rule: hands-off + exception-based
 * — green auto-applies, exceptions park for review): the sweep NEVER mutates
 * the rows. Closing a stale visit out stays a human call — complete it (the
 * dispatch backfill path), reschedule it, or cancel it.
 *
 * Quiet when clean, quiet when unchanged: the bell re-rings only when the
 * backlog summary differs from the last bell's, or when that bell is older
 * than REMIND_DAYS (a frozen backlog shouldn't go silent forever).
 *
 * Gate: staleVisitSweep (GATE_STALE_VISIT_SWEEP). Reads scheduled_services;
 * writes nothing but admin notifications.
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { etDateString } = require('../utils/datetime-et');

const OPEN_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
const REMIND_DAYS = 7;
const CATEGORY = 'stale_visit_sweep';

// Query failures propagate — a schema/connection outage must surface as a
// failed sweep in the scheduler's error log, never as clean:true (this sweep
// exists to catch silence; it can't be allowed to produce it).
async function findStaleVisits(now = new Date()) {
  // scheduled_date is an ET wall-clock DATE — compare it to an ET calendar
  // date string, never a UTC instant (a JS timestamp cutoff would flag a
  // visit on its own scheduled evening once UTC rolls past midnight). No age
  // floor on purpose: same-day misses belong to the 6PM checker; by this
  // sweep's definition every match is at least a day past.
  const today = etDateString(now);
  return db('scheduled_services')
    .whereIn('status', OPEN_STATUSES)
    .where('scheduled_date', '<', today)
    .select('id', 'status', 'scheduled_date', 'customer_id');
}

// Plain DATE columns come back from pg as Date objects — normalize to the
// YYYY-MM-DD string the summary/signature compare on.
function dateOnly(value) {
  return value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null;
}

function countsByStatus(visits) {
  const counts = {};
  for (const status of OPEN_STATUSES) counts[status] = 0;
  for (const v of visits) {
    if (counts[v.status] == null) counts[v.status] = 0;
    counts[v.status] += 1;
  }
  return counts;
}

function oldestDate(visits) {
  let oldest = null;
  for (const v of visits) {
    const d = dateOnly(v.scheduled_date);
    if (d && (!oldest || d < oldest)) oldest = d;
  }
  return oldest;
}

// Stable fingerprint of the backlog picture: total + per-status counts +
// oldest date. Identical picture two nights running → no second bell.
function summarySignature(visits) {
  const counts = countsByStatus(visits);
  const parts = Object.keys(counts).sort().map((s) => `${s}:${counts[s]}`);
  return `total:${visits.length}|${parts.join('|')}|oldest:${oldestDate(visits) || 'none'}`;
}

function summarize(visits) {
  const counts = countsByStatus(visits);
  const breakdown = OPEN_STATUSES
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s.replace('_', ' ')}`)
    .join(', ');
  const oldest = oldestDate(visits);
  return `${visits.length} past-dated visit${visits.length === 1 ? '' : 's'} still open (${breakdown})${oldest ? `, oldest ${oldest}` : ''}`;
}

// Latest prior bell for this category — the dedupe baseline. Propagates on
// failure (same contract as findStaleVisits): a broken dedupe read must fail
// the sweep loudly, not silently re-ring or go quiet.
async function lastBell() {
  const prior = await db('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .orderBy('created_at', 'desc')
    .first('metadata', 'created_at');
  if (!prior) return null;
  let meta = prior.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return { signature: meta?.summary_signature || null, createdAt: prior.created_at };
}

function etDayNumber(value) {
  const date = value instanceof Date ? value : new Date(value);
  const [y, m, d] = etDateString(date).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function priorBellCovers(prior, signature, now = new Date()) {
  if (!prior || prior.signature !== signature) return false;
  // ET calendar days, not elapsed hours — the cron fires at a fixed ET
  // wall-clock time, and a DST transition would otherwise stretch the
  // seven-night window to an eighth night.
  return etDayNumber(now) - etDayNumber(prior.createdAt) < REMIND_DAYS;
}

async function runStaleVisitSweep({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('staleVisitSweep')) return { skipped: true, reason: 'gated_off' };

  // Read-then-notify with no unique constraint — serialize across replicas
  // and deploy overlap the same way the WDO attention sweep does.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('stale-visit-sweep', async () => {
    const visits = await findStaleVisits(now);
    if (!visits.length) return { ok: true, clean: true };

    const signature = summarySignature(visits);
    if (priorBellCovers(await lastBell(), signature, now)) {
      return { ok: true, deduped: true, items: visits.length };
    }

    const summary = summarize(visits);
    const bell = await NotificationService.notifyAdmin(
      CATEGORY,
      'Stale visits need attention',
      `${summary}. Each is a past day the schedule still shows as open — complete (backfill), reschedule, or cancel them from the dashboard's Stale visits card.`,
      {
        link: '/admin/dashboard',
        metadata: {
          dedupeKey: `${CATEGORY}:${signature}`.slice(0, 200),
          summary_signature: signature,
          counts: countsByStatus(visits),
          total: visits.length,
          oldest_date: oldestDate(visits),
        },
      },
    );
    // notifyAdmin returns null when the insert fails (its create() swallows
    // the error) — a bell that didn't land must fail the sweep loudly, not
    // record a ring and go quiet until the picture changes. (Intentional
    // suppression returns a truthy sentinel and correctly counts as rung.)
    if (!bell) throw new Error('admin notification insert failed — bell not recorded');
    logger.info(`[stale-visit-sweep] rang: ${summary}`);
    return { ok: true, rang: true, items: visits.length };
  });
}

module.exports = {
  runStaleVisitSweep,
  _private: { findStaleVisits, countsByStatus, oldestDate, summarySignature, summarize, priorBellCovers },
};
