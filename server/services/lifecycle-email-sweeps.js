/**
 * Daily lifecycle email sweeps (owner directives 2026-07-06). Runs from
 * the index.js cron fleet (GATE_CRON_JOBS + runExclusive), 10:05 AM ET.
 *
 * Bond renewal (termite.bond_renewal template):
 *   1. Sync: every COMPLETED visit whose service_type matches
 *      "Termite Bond Service" gets a termite_bonds row (term parsed
 *      from "(N-Year Term)", default 1; renews_at = completion + term).
 *      Self-healing — no completion-path hooks required.
 *   2. Notify: active bonds entering the 30-day pre-renewal window get
 *      ONE email (renewal_notified_at stamps the send; the send itself
 *      is also idempotent per bond + renewal date).
 *
 * The referral invite deliberately does NOT live here — it fires on
 * positive review submission (review-request.js submitRating), the
 * warmest moment, per the owner's trigger call.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

// Matches BOTH naming generations: legacy "…Termite Bond Service…" and the
// live admin-schedule catalog's "Termite Bond (Billed Quarterly | N-Year
// Term)" (admin-schedule.js termite category). Term still parses from the
// "(N-Year" fragment; names without one default to 1 year.
const BOND_MATCH = '%Termite Bond%';
const RENEWAL_WINDOW_DAYS = 30;
const GRACE_DAYS = 7; // still notify up to a week past renews_at (missed runs)

const FALLBACK_PORTAL_HOME_URL = 'https://portal.wavespestcontrol.com';

function termYearsFrom(serviceType) {
  const m = String(serviceType || '').match(/(\d+)\s*-\s*Year/i);
  return m ? Number(m[1]) : 1;
}

function displayDate(d) {
  // DATE columns arrive as 'YYYY-MM-DD' (or Date at UTC midnight); parsing
  // those through a TZ-aware formatter shifts them back a day in ET — the
  // classic date-only trap. Format from the parts instead.
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${Number(m[1])}`;
}

// Insert termite_bonds rows for completed bond visits that don't have one.
async function syncTermiteBonds() {
  if (!(await db.schema.hasTable('termite_bonds'))) return { inserted: 0 };
  const visits = await db('scheduled_services')
    .where('scheduled_services.status', 'completed')
    .where('scheduled_services.service_type', 'ilike', BOND_MATCH)
    .leftJoin('termite_bonds', 'termite_bonds.scheduled_service_id', 'scheduled_services.id')
    .whereNull('termite_bonds.id')
    .select(
      'scheduled_services.id',
      'scheduled_services.customer_id',
      'scheduled_services.service_type',
      'scheduled_services.completed_at',
      'scheduled_services.actual_end_time',
      'scheduled_services.check_out_time',
      'scheduled_services.scheduled_date',
    );
  let inserted = 0;
  for (const v of visits) {
    if (!v.customer_id) continue;
    // Completion timing lives in actual_end_time / check_out_time on the
    // closeout path (completed_at is often null there). Real timestamps get
    // the ET-calendar conversion — a visit completed after 8 PM Eastern is
    // already on the next UTC day. The DATE-only scheduled_date fallback is
    // already a calendar date: converting it through a timezone would shift
    // it BACK a day (UTC midnight → 7/8 PM ET the previous evening), so it
    // is used verbatim.
    const completionTs = v.actual_end_time || v.check_out_time || v.completed_at;
    let startedEt = null;
    if (completionTs) {
      const started = new Date(completionTs);
      if (!Number.isNaN(started.getTime())) startedEt = etDateString(started);
    } else if (v.scheduled_date) {
      startedEt = typeof v.scheduled_date === 'string'
        ? v.scheduled_date.slice(0, 10)
        : new Date(v.scheduled_date).toISOString().slice(0, 10);
    }
    if (!startedEt) continue;
    const years = termYearsFrom(v.service_type);
    // Add the term years with UTC-safe date math (Feb 29 normalizes to Mar 1).
    const [sy, sm, sd] = startedEt.split('-').map(Number);
    const renewsEt = new Date(Date.UTC(sy + years, sm - 1, sd)).toISOString().slice(0, 10);
    try {
      await db('termite_bonds').insert({
        customer_id: v.customer_id,
        scheduled_service_id: v.id,
        service_type: v.service_type,
        term_years: years,
        started_at: startedEt,
        renews_at: renewsEt,
        status: 'active',
      });
      inserted += 1;
    } catch (e) {
      // Unique race with a concurrent run — fine, the row exists.
      logger.warn(`[lifecycle-sweeps] bond insert skipped for visit ${v.id}: ${e.message}`);
    }
  }
  if (inserted) logger.info(`[lifecycle-sweeps] synced ${inserted} new termite bond(s)`);
  return { inserted };
}

async function runBondRenewalSweep() {
  if (!(await db.schema.hasTable('termite_bonds'))) return { sent: 0 };
  await syncTermiteBonds();

  const today = new Date();
  const windowEnd = new Date(today.getTime() + RENEWAL_WINDOW_DAYS * 86400000);
  const graceStart = new Date(today.getTime() - GRACE_DAYS * 86400000);

  const due = await db('termite_bonds')
    .where('termite_bonds.status', 'active')
    .whereNull('termite_bonds.renewal_notified_at')
    .where('termite_bonds.renews_at', '<=', windowEnd.toISOString().slice(0, 10))
    .where('termite_bonds.renews_at', '>=', graceStart.toISOString().slice(0, 10))
    .join('customers', 'customers.id', 'termite_bonds.customer_id')
    // Soft-deleted customers keep their FK-backed bond rows and email —
    // same guard the renewal-reminder workflow applies.
    .whereNull('customers.deleted_at')
    .select(
      'termite_bonds.*',
      'customers.first_name',
      'customers.email',
    );

  let sent = 0;
  for (const bond of due) {
    const email = String(bond.email || '').trim();
    if (!email || !email.includes('@')) {
      logger.info(`[lifecycle-sweeps] bond ${bond.id}: no usable email; skipping`);
      continue;
    }
    try {
      const EmailTemplateLibrary = require('./email-template-library');
      await EmailTemplateLibrary.sendTemplate({
        templateKey: 'termite.bond_renewal',
        to: email,
        payload: {
          first_name: String(bond.first_name || '').trim() || 'there',
          bond_term: bond.service_type,
          renewal_date: displayDate(bond.renews_at),
          renewal_url: `${FALLBACK_PORTAL_HOME_URL}/login`,
          customer_portal_url: `${FALLBACK_PORTAL_HOME_URL}/login`,
          company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        },
        recipientType: 'customer',
        recipientId: bond.customer_id,
        idempotencyKey: `termite.bond_renewal:${bond.id}:${String(bond.renews_at).slice(0, 10)}`,
        triggerEventId: `termite.bond_renewal:${bond.id}`,
        categories: ['termite_bond_renewal'],
      });
      await db('termite_bonds').where({ id: bond.id }).update({
        renewal_notified_at: new Date(),
        updated_at: new Date(),
      });
      sent += 1;
    } catch (err) {
      logger.error(`[lifecycle-sweeps] bond renewal email failed for bond ${bond.id}: ${err.message}`);
    }
  }
  if (sent) logger.info(`[lifecycle-sweeps] sent ${sent} bond renewal notice(s)`);
  return { sent };
}

async function runDailySweeps() {
  const bond = await runBondRenewalSweep();
  return { bondRenewalsSent: bond.sent };
}

module.exports = { runDailySweeps, runBondRenewalSweep, syncTermiteBonds, _private: { termYearsFrom, displayDate } };
