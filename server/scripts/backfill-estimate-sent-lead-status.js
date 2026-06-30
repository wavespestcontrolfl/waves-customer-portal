/**
 * One-off backfill (PR #2214): advance leads that are stuck at an open pipeline
 * status even though a STANDALONE estimate matching their contact was already
 * SENT or VIEWED.
 *
 * Before #2214, markLinkedLeadEstimateSent/Viewed only advanced a lead when the
 * estimate was FK-linked (`leads.estimate_id`) — which only happens when the
 * estimate is built via the lead's own "Create Estimate" button. An estimate
 * created any other way (Estimates tab, after Convert to Customer, typed fresh)
 * left the matching lead at "new". #2214 fixes that going forward with a contact/
 * mirror rescue; this script nudges the leads whose estimate was sent/viewed
 * BEFORE the fix shipped.
 *
 * Self-discovering — NO committed target list. It scans estimates currently in
 * status 'sent' or 'viewed' that have NO FK-linked lead, then reuses the SHIPPED
 * resolver (`resolveEstimateEventLeads`) to find a single unambiguous open,
 * never-linked, never-converted contact (or public-quote mirror) match, and
 * replays the exact live `markLinkedLeadEstimateSent` / `...Viewed` path (link +
 * status advance + activity). Every production guard therefore applies: 0 or 2+
 * matches are skipped, a lead already on another estimate is never stolen, a
 * closed/converted lead is never linked (open-status stamp guard), and the status
 * transition is SQL-gated so it can't move a lead backward.
 *
 * IDEMPOTENT: a second run finds the lead now FK-linked, so the resolver returns
 * it via the FK branch (rescued=false) and this script skips it (no duplicate
 * activity).
 *
 *   node server/scripts/backfill-estimate-sent-lead-status.js            # dry-run
 *   node server/scripts/backfill-estimate-sent-lead-status.js --commit   # apply
 *   node server/scripts/backfill-estimate-sent-lead-status.js --limit=200
 *
 * SAFE BY DEFAULT: dry-run unless `--commit`. Writes to whatever DATABASE_URL
 * points at, so run it deliberately (break-glass on prod, per the waves-db
 * policy). Logs estimate/lead ids only (uuids, not PII) — never phone/email.
 */
require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const {
  resolveEstimateEventLeads,
  markLinkedLeadEstimateSent,
  markLinkedLeadEstimateViewed,
} = require('../services/lead-estimate-link');

const COMMIT = process.argv.includes('--commit');
const PERFORMED_BY = 'backfill-2214';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const LIMIT = Math.max(1, parseInt(argValue('limit') || '5000', 10));
const shortId = (id) => String(id || '').slice(0, 8);

async function main() {
  // Candidate estimates: actually sent or viewed, with NO FK-linked lead. The
  // FK-linked ones already advanced on their original send/view — only the
  // standalone (unlinked) estimates need a nudge.
  const candidates = await db('estimates')
    .whereIn('status', ['sent', 'viewed'])
    .whereNotExists(function whereNoFkLinkedLead() {
      this.select(db.raw('1')).from('leads').whereRaw('leads.estimate_id = estimates.id');
    })
    .orderBy('created_at', 'asc')
    .limit(LIMIT)
    .select('id', 'status');

  const summary = { scanned: candidates.length, advanced: 0, linkedOnly: 0, ambiguousOrNone: 0, errors: 0 };
  logger.info(`[backfill-2214] ${COMMIT ? 'COMMIT' : 'DRY-RUN'} — scanning ${candidates.length} standalone sent/viewed estimate(s) (limit ${LIMIT})`);

  for (const est of candidates) {
    try {
      // Read-only preview using the exact shipped resolver. Pre-filtered to
      // estimates with no FK-linked lead, so a result here is always the
      // mirror/contact rescue path: rescued=true + exactly one lead, or nothing.
      const { leads, rescued } = await resolveEstimateEventLeads(db, est.id);
      if (!rescued || leads.length !== 1) { summary.ambiguousOrNone += 1; continue; }
      const lead = leads[0];

      // Mirror the SQL gate the mark fns apply, so the preview counts match the
      // commit: 'viewed' advances new/contacted/estimate_sent; 'sent' advances
      // new/contacted. Anything else is linked but not status-changed.
      const advanceable = est.status === 'viewed'
        ? ['new', 'contacted', 'estimate_sent'].includes(lead.status)
        : ['new', 'contacted'].includes(lead.status);
      const target = est.status === 'viewed' ? 'estimate_viewed' : 'estimate_sent';

      logger.info(`[backfill-2214] est ${shortId(est.id)} (${est.status}) → lead ${shortId(lead.id)} status=${lead.status} ${advanceable ? `=> ${target}` : '(link only — status not eligible)'}`);

      if (COMMIT) {
        if (est.status === 'viewed') {
          await markLinkedLeadEstimateViewed({ estimateId: est.id, performedBy: PERFORMED_BY });
        } else {
          await markLinkedLeadEstimateSent({ estimateId: est.id, sendMethod: 'backfill', performedBy: PERFORMED_BY });
        }
      }
      if (advanceable) summary.advanced += 1; else summary.linkedOnly += 1;
    } catch (err) {
      summary.errors += 1;
      logger.warn(`[backfill-2214] est ${shortId(est.id)} failed: ${err.message}`);
    }
  }

  logger.info(`[backfill-2214] done — scanned=${summary.scanned} advanced=${summary.advanced} linkedOnly=${summary.linkedOnly} ambiguousOrNone=${summary.ambiguousOrNone} errors=${summary.errors}${COMMIT ? '' : ' (DRY-RUN — no writes)'}`);
}

main()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[backfill-2214] fatal: ${err.message}`);
    return db.destroy().finally(() => process.exit(1));
  });
