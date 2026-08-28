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
const BOND_KEYS = ['termite_bond_1yr', 'termite_bond_5yr', 'termite_bond_10yr'];
const RENEWAL_WINDOW_DAYS = 30;
const GRACE_DAYS = 7; // still notify up to a week past renews_at (missed runs)

const FALLBACK_PORTAL_HOME_URL = 'https://portal.wavespestcontrol.com';

// Same gate + same shared parser as GET /api/property/termite-bond
// (routes/property.js): the renewal CTA deep-links to the My Plan bond
// card only once that card is live. While the gate is dark the email
// keeps the legacy login landing, so a customer never gets steered to a
// tab with no bond on it (codex #3362 P2). Read at send time, so a
// Railway gate flip takes effect on the next sweep without a deploy.
const { gateEnvValue } = require('../config/feature-gates');

function termYearsFrom(serviceType) {
  const m = String(serviceType || '').match(/(\d+)\s*-\s*Year/i);
  return m ? Number(m[1]) : 1;
}

// Identity-first term derivation (2026-08-25 audit): the label regex above
// DEFAULTS TO 1 YEAR on any parse miss, so a renamed or merged label would
// silently mint every bond as 1-year. The visit's durable catalog evidence
// (service_key_snapshot, then the linked catalog row's service_key) names
// the term outright; the label regex stays as the legacy fallback for
// name-only history.
// Returns null when the visit is provably NOT a bond.
function termYearsForVisit(v) {
  // The LINKED catalog row outranks the snapshot — the same precedence
  // completion identity uses (service_id first), and pre-fix combined
  // promotions changed service_id without restamping the snapshot, so the
  // two can disagree on real rows (codex #3485 r10 P1). And it is
  // authoritative BOTH ways: a resolved link that names a non-bond service
  // means the visit was repointed — falling through to the stale snapshot
  // or label would mint a warranty for non-bond work (pre-push P1).
  const linked = String(v.catalog_service_key || '');
  if (linked) {
    const m = linked.match(/^termite_bond_(\d+)yr$/);
    if (m) return Number(m[1]);
    // Combined bait+bond accepts link to the BAIT catalog row BY DESIGN (no
    // combined catalog row exists — see COMBINED_SERVICE_ROUTES) and encode
    // the bond term only in the label; the label is the term authority for
    // exactly that route (pre-push P1 follow-up).
    if (linked === 'termite_bait' && /termite bond/i.test(String(v.service_type || ''))) {
      return termYearsFrom(v.service_type);
    }
    return null;
  }
  // Same authority contract for the snapshot tier (pre-push P1): with no
  // link, a non-bond snapshot is the visit's durable identity — a stale
  // "Termite Bond" label must not out-vote it. The combined bait+bond
  // exception applies here too (promotions restamp the snapshot to
  // 'termite_bait' with the term in the label).
  const snap = String(v.service_key_snapshot || '');
  if (snap) {
    const m = snap.match(/^termite_bond_(\d+)yr$/);
    if (m) return Number(m[1]);
    if (snap === 'termite_bait' && /termite bond/i.test(String(v.service_type || ''))) {
      return termYearsFrom(v.service_type);
    }
    return null;
  }
  // Label tier: termYearsFrom defaults to 1 on ANY parse miss, so it can
  // only run when the label actually names a termite bond — a visit
  // reclassified under the lock (identity cleared, label now
  // 'Pest Control') must not mint a one-year bond (codex #3485 r20 P2).
  return /termite\s*bond/i.test(String(v.service_type || ''))
    ? termYearsFrom(v.service_type)
    : null;
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
    // Candidates by durable identity OR label: a bond visit whose label
    // drifted from the "%Termite Bond%" shape (rename, merged label) is
    // still a bond when its snapshot/catalog key says so (2026-08-25 audit).
    .where(function bondCandidate() {
      this.where('scheduled_services.service_type', 'ilike', BOND_MATCH)
        .orWhereIn('scheduled_services.service_key_snapshot', BOND_KEYS)
        // A visit whose only bond evidence is its LINKED catalog row (valid
        // service_id, no snapshot, drifted label) must still be a candidate
        // — otherwise termYearsForVisit never sees it (codex #3485 r1 P2).
        .orWhereIn('services.service_key', BOND_KEYS);
    })
    // The resolved link is authoritative the other way too: a visit whose
    // service_id names a NON-bond catalog row was repointed, and its stale
    // snapshot/label must not mint a warranty (pre-push P1). One documented
    // exception: combined bait+bond accepts link to the termite_bait row by
    // design with the bond term in the label — those stay candidates when
    // the label proves the bond.
    .where(function linkedRowAuthority() {
      this.whereNull('services.service_key')
        .orWhereIn('services.service_key', BOND_KEYS)
        .orWhere(function combinedBaitBond() {
          this.where('services.service_key', 'termite_bait')
            .andWhere('scheduled_services.service_type', 'ilike', BOND_MATCH);
        });
    })
    // Quarterly bond FOLLOW-UPS copy the parent service_type (recurring
    // seeder) — only the establishing anchor visit starts a bond term, or a
    // 1-year bond would get a renewal notice per quarterly child.
    .whereNull('scheduled_services.recurring_parent_id')
    .leftJoin('termite_bonds', 'termite_bonds.scheduled_service_id', 'scheduled_services.id')
    .whereNull('termite_bonds.id')
    .leftJoin('services', 'services.id', 'scheduled_services.service_id')
    .select(
      'scheduled_services.id',
      'scheduled_services.customer_id',
      'scheduled_services.service_type',
      'scheduled_services.service_key_snapshot',
      'services.service_key as catalog_service_key',
      'scheduled_services.completed_at',
      'scheduled_services.actual_end_time',
      'scheduled_services.check_out_time',
      'scheduled_services.scheduled_date',
    );
  // Completion timing lives in actual_end_time / check_out_time on the
  // closeout path (completed_at is often null there). Real timestamps get
  // the ET-calendar conversion — a visit completed after 8 PM Eastern is
  // already on the next UTC day. The DATE-only scheduled_date fallback is
  // already a calendar date: converting it through a timezone would shift
  // it BACK a day (UTC midnight → 7/8 PM ET the previous evening), so it
  // is used verbatim.
  const bondStartDateEt = (row) => {
    const completionTs = row.actual_end_time || row.check_out_time || row.completed_at;
    if (completionTs) {
      const started = new Date(completionTs);
      return Number.isNaN(started.getTime()) ? null : etDateString(started);
    }
    if (row.scheduled_date) {
      return typeof row.scheduled_date === 'string'
        ? row.scheduled_date.slice(0, 10)
        : new Date(row.scheduled_date).toISOString().slice(0, 10);
    }
    return null;
  };
  let inserted = 0;
  for (const v of visits) {
    if (!v.customer_id) continue;
    // Cheap pre-lock skips (belt-and-braces with the query's filters): a
    // null term means the durable identity disproved the bond, a null start
    // means no usable timing. Both re-derive under the lock — the unlocked
    // values never reach the insert.
    if (!bondStartDateEt(v) || !termYearsForVisit(v)) continue;
    try {
      // Owner from the LOCKED visit row (Codex #3109 r27): a merge-undo
      // can reverse-repoint the visit between the sweep's unlocked read
      // and this insert — the FOR UPDATE serializes with that repoint so
      // the bond always binds the visit's CURRENT customer.
      const bondInserted = await db.transaction(async (trx) => {
        const lockedVisit = await trx('scheduled_services')
          .where({ id: v.id }).forUpdate()
          .first('customer_id', 'service_id', 'service_type', 'service_key_snapshot',
            'status', 'completed_at', 'actual_end_time', 'check_out_time', 'scheduled_date');
        if (!lockedVisit || !lockedVisit.customer_id) return false;
        // Status, identity, AND timing all re-derive from the LOCKED row
        // (codex #3485 r18 P2): an un-complete or timing edit landing
        // before the lock must not mint a bond, or date it, from the stale
        // candidate read.
        if (lockedVisit.status !== 'completed') return false;
        const startedEt = bondStartDateEt(lockedVisit);
        if (!startedEt) return false;
        // Re-derive the bond identity from the LOCKED row (pre-push P1):
        // a repoint landing between the unlocked candidate read and this
        // lock would otherwise mint from the stale identity — the exact
        // hole the non-bond veto closes on the read side.
        const lockedCatalogKey = lockedVisit.service_id
          ? (await trx('services').where({ id: lockedVisit.service_id }).first('service_key'))?.service_key || null
          : null;
        const lockedYears = termYearsForVisit({
          catalog_service_key: lockedCatalogKey,
          service_key_snapshot: lockedVisit.service_key_snapshot,
          service_type: lockedVisit.service_type,
        });
        if (!lockedYears) return false;
        // Add the term years with UTC-safe date math (Feb 29 → Mar 1).
        const [ly, lm, ld] = startedEt.split('-').map(Number);
        const lockedRenewsEt = new Date(Date.UTC(ly + lockedYears, lm - 1, ld)).toISOString().slice(0, 10);
        await trx('termite_bonds').insert({
        customer_id: lockedVisit.customer_id,
        scheduled_service_id: v.id,
        service_type: lockedVisit.service_type,
        term_years: lockedYears,
        started_at: startedEt,
        renews_at: lockedRenewsEt,
        status: 'active',
        });
        return true;
      });
      if (bondInserted) inserted += 1;
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
  const EmailTemplateLibrary = require('./email-template-library');
  for (const bond of due) {
    const email = String(bond.email || '').trim();
    if (!email || !email.includes('@')) {
      logger.info(`[lifecycle-sweeps] bond ${bond.id}: no usable email; skipping`);
      continue;
    }
    try {
      const sendArgs = (idempotencyKey) => ({
        templateKey: 'termite.bond_renewal',
        to: email,
        payload: {
          first_name: String(bond.first_name || '').trim() || 'there',
          bond_term: bond.service_type,
          renewal_date: displayDate(bond.renews_at),
          // Gate on: land on the My Plan tab, where the bond card lives.
          // Unauthenticated clicks survive the round-trip: ProtectedRoute
          // redirects to /login?next=<this path> and LoginPage navigates
          // back after the SMS code.
          renewal_url: gateEnvValue('GATE_PORTAL_TERMITE_BOND')
            ? `${FALLBACK_PORTAL_HOME_URL}/?tab=documents`
            : `${FALLBACK_PORTAL_HOME_URL}/login`,
          customer_portal_url: `${FALLBACK_PORTAL_HOME_URL}/login`,
          company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        },
        recipientType: 'customer',
        recipientId: bond.customer_id,
        idempotencyKey,
        triggerEventId: `termite.bond_renewal:${bond.id}`,
        categories: ['termite_bond_renewal'],
        // This loop iterates real recipient addresses — SendGrid 4xx bodies
        // can echo the offending address, so keep provider errors out of the
        // logs and log a redacted reason ourselves below.
        suppressProviderErrorLog: true,
      });
      // Stable key first: a sent-but-unstamped row (stamp write failed
      // after the send) dedupes here as sent:true, so the stamp below gets
      // retried WITHOUT emailing the customer twice.
      const baseKey = `termite.bond_renewal:${bond.id}:${String(bond.renews_at).slice(0, 10)}`;
      let sendResult = await EmailTemplateLibrary.sendTemplate(sendArgs(baseKey));
      if (!sendResult?.sent && sendResult?.blocked && sendResult?.deduped) {
        // The stable key hit a PRIOR attempt's blocked row — 'blocked' is
        // in DEDUPE_STATUSES, so under the fixed key that row dedupes
        // forever and the once-ever notice could never send even after the
        // suppression cleared. Before retrying under a day-scoped key,
        // check whether an EARLIER day's retry already sent and only the
        // bond stamp failed — re-sending would email the customer twice;
        // a sent-ish retry row settles it as sent so the stamp is retried
        // instead. (A stable ':retry' key can't do this: still-suppressed
        // retries would park a second blocked row under it and re-wedge.)
        const priorRetrySent = await db('email_messages')
          .where('idempotency_key', 'like', `${baseKey}:%`)
          .whereIn('status', ['sent', 'delivered', 'opened', 'clicked'])
          .first();
        sendResult = priorRetrySent
          ? { sent: true, deduped: true, message: priorRetrySent }
          // Still nothing delivered: day-scoped retry — still blocked → a
          // fresh blocked row for today; cleared → the notice finally
          // goes out and gets stamped.
          : await EmailTemplateLibrary.sendTemplate(sendArgs(`${baseKey}:${etDateString()}`));
      }
      if (!sendResult?.sent) {
        // Suppression blocks (and inactive templates) return {sent:false}
        // WITHOUT throwing. Stamping here would permanently record the
        // once-ever notice as delivered when nothing went out — leave the
        // bond due so tomorrow's sweep retries (bounded by GRACE_DAYS).
        logger.warn(`[lifecycle-sweeps] bond ${bond.id} (customer ${bond.customer_id}): renewal notice NOT sent (${sendResult?.blocked ? 'suppression-blocked' : (sendResult?.reason || 'unsent')}); left un-notified for retry`);
        continue;
      }
      await db('termite_bonds').where({ id: bond.id }).update({
        renewal_notified_at: new Date(),
        updated_at: new Date(),
      });
      sent += 1;
    } catch (err) {
      const reason = err.status
        ? `SendGrid ${err.status}`
        : EmailTemplateLibrary.redactEmailAddresses(err.message);
      logger.error(`[lifecycle-sweeps] bond renewal email failed for bond ${bond.id} (customer ${bond.customer_id}): ${reason}`);
    }
  }
  if (sent) logger.info(`[lifecycle-sweeps] sent ${sent} bond renewal notice(s)`);
  return { sent };
}

// Acceptance copy catch-up (GATE_ESTIMATE_ACCEPTANCE_TERMS; pre-push Codex
// P1): the accept route's post-commit onboarding email — which carries the
// promised copy of the accepted terms — is fire-and-forget, so a crash or a
// provider failure between commit and send would leave a recorded
// acceptance with no emailed copy. Fulfilment is tracked ON THE RECORD
// (estimate_acceptances.copy_emailed_at, stamped by the sender): every
// unfulfilled acceptance is re-attempted daily with no time limit — the
// stable key first (a sent-but-unstamped race dedupes harmlessly and gets
// stamped), then a day-scoped retry key when the stable key is wedged on a
// failed/blocked row (the bond-renewal pattern above). An acceptance with
// no usable email at all cannot be fulfilled by mail: after
// ACCEPTANCE_COPY_ESCALATE_DAYS the office is notified ONCE
// (copy_escalated_at) so a person can hand over the copy — the accepted
// page and PDF carry the same record — instead of the promise silently
// lapsing (rule 14: exceptions park and surface).
const ACCEPTANCE_COPY_SETTLE_MINUTES = 30; // give the post-commit send time to land
const ACCEPTANCE_COPY_ESCALATE_DAYS = 7;
const SENT_ISH = ['sent', 'delivered', 'opened', 'clicked'];

// Does the ACTIVE estimate.accepted_onboarding version reference the
// acceptance_note variable (block or text body)?
async function activeOnboardingTemplateCarriesNote() {
  try {
    const { loadTemplateByKey } = require('./email-template-library');
    const loaded = await loadTemplateByKey('estimate.accepted_onboarding');
    const v = loaded?.activeVersion;
    if (!v) return false;
    const blocks = typeof v.blocks === 'string' ? v.blocks : JSON.stringify(v.blocks || []);
    return blocks.includes('acceptance_note') || String(v.text_body || '').includes('acceptance_note');
  } catch (err) {
    logger.warn(`[lifecycle-sweeps] could not inspect the active onboarding template: ${err.message}`);
    return false;
  }
}

async function runAcceptanceCopySweep() {
  if (!(await db.schema.hasTable('estimate_acceptances'))) return { sent: 0, checked: 0, escalated: 0 };
  const now = Date.now();
  const rows = await db('estimate_acceptances')
    .whereNull('copy_emailed_at')
    .where('accepted_at', '<=', new Date(now - ACCEPTANCE_COPY_SETTLE_MINUTES * 60000))
    .orderBy('accepted_at', 'asc')
    .select('id', 'estimate_id', 'customer_id', 'accepted_at', 'copy_escalated_at');
  const seen = new Set();
  let sent = 0;
  let checked = 0;
  let escalated = 0;
  let templateCarriesNote = null; // resolved once per run, lazily
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    checked += 1;
    const { sendEstimateAcceptedOnboarding, acceptedOnboardingKey, ACCEPTANCE_COPY_MARKER } = require('./estimate-accepted-email');
    // Keyed per acceptance EVENT: a re-accept after a revision is its own
    // row with its own copy, never deduped against the earlier one.
    const baseKey = acceptedOnboardingKey(row.estimate_id, row.id);
    // Surface an exception ONCE (copy_escalated_at), and only when the admin
    // notification row actually persisted (bell policy can silence the
    // category; then the next sweep retries).
    const escalate = async (estimate, body) => {
      const NotificationService = require('./notification-service');
      // dedupeKey: once per acceptance — a crash between this insert and
      // the copy_escalated_at stamp must not re-ring tomorrow (GH Codex r9 P2).
      const notification = await NotificationService.notifyAdmin('estimate', `Acceptance copy not delivered: ${estimate?.customer_name || 'customer'}`, body, { dedupeKey: `acceptance_copy_escalation:${row.id}` });
      if (notification?.id) {
        await db('estimate_acceptances').where({ id: row.id }).update({ copy_escalated_at: new Date() });
        escalated += 1;
      } else {
        logger.warn(`[lifecycle-sweeps] acceptance copy escalation for estimate ${row.estimate_id} not persisted (${notification?.reason || 'suppressed'}); will retry next sweep`);
      }
    };
    try {
      // EVERY sent-ish attempt under this key (initial + corrective): any one
      // carrying the copy fulfils the promise (GH Codex r9 P2).
      const deliveredRows = await db('email_messages')
        .where('idempotency_key', 'like', `${baseKey}%`)
        .whereIn('status', SENT_ISH)
        .select('id', 'text_snapshot', 'html_snapshot');
      const delivered = deliveredRows[0] || null;
      if (delivered) {
        const carriesCopy = deliveredRows.some((m) => [m.text_snapshot, m.html_snapshot]
          .some((b) => typeof b === 'string' && b.includes(ACCEPTANCE_COPY_MARKER)));
        if (carriesCopy) {
          // Sent earlier, stamp missed (crash between send and stamp): fulfil now.
          await db('estimate_acceptances').where({ id: row.id }).whereNull('copy_emailed_at')
            .update({ copy_emailed_at: new Date() });
          continue;
        }
        // Sent WITHOUT the copy: the active template version lacked the
        // {{acceptance_note}} block. Surface once (operator fix); and once
        // the active version carries the block again, re-send under a
        // distinct key so the corrective copy actually goes out (pre-push
        // Codex P1) — never a daily duplicate while it is still missing.
        if (!row.copy_escalated_at) {
          const estimate = await db('estimates').where({ id: row.estimate_id }).first('id', 'customer_name', 'address');
          await escalate(estimate, `${estimate?.address || 'no address'} — the onboarding email went out without the accepted-terms copy: the active estimate.accepted_onboarding template version has no {{acceptance_note}} block. Restore the block (Email Templates) and the copy will be re-sent; meanwhile the accepted estimate page / PDF carries the same record.`);
        }
        if (templateCarriesNote === null) templateCarriesNote = await activeOnboardingTemplateCarriesNote();
        if (!templateCarriesNote) continue;
        // fall through: corrective resend under the day-scoped copy key
      }
      const wedged = delivered ? { id: delivered.id } : await db('email_messages').where({ idempotency_key: baseKey }).first('id', 'status');
      const estimate = await db('estimates').where({ id: row.estimate_id }).first('id', 'customer_id', 'customer_name', 'address', 'estimate_data');
      if (!estimate) continue;
      const EstimateConverter = require('./estimate-converter');
      let estData = estimate.estimate_data;
      if (typeof estData === 'string') { try { estData = JSON.parse(estData); } catch { estData = {}; } }
      const firstService = (EstimateConverter.recurringServicesFromEstimateData(estData || {})[0]
        || EstimateConverter.estimateOneTimeItemsFromData(estData || {})[0]) || null;
      const result = await sendEstimateAcceptedOnboarding({
        customerId: row.customer_id || estimate.customer_id || null,
        estimateId: estimate.id,
        serviceLabel: firstService?.name || firstService?.label || 'service',
        appointment: null,
        acceptanceId: row.id,
        idempotencyKey: delivered ? `${baseKey}:copy:${etDateString()}` : (wedged ? `${baseKey}:${etDateString()}` : baseKey),
      });
      if (result?.sent && !result?.copyMissing) { sent += 1; continue; }
      if (result?.copyMissing) {
        // Sent WITHOUT the copy (template version lacks the block) — surface now.
        if (!row.copy_escalated_at) {
          await escalate(estimate, `${estimate.address || 'no address'} — the onboarding email went out without the accepted-terms copy: the active estimate.accepted_onboarding template version has no {{acceptance_note}} block. Restore the block (Email Templates) and the copy will be re-sent; meanwhile the accepted estimate page / PDF carries the same record.`);
        }
        continue;
      }
      // Outcomes (GH Codex r3 P1): no usable address anywhere, or a
      // suppression block (bounced/unsubscribed — the provider will not
      // deliver) are NOT mail problems a retry can fix → surface once so a
      // person delivers the copy. A transient failure ({outcome:'failed'})
      // is left for tomorrow's retry and never escalated as "no email".
      const undeliverable = result?.outcome === 'no_address' || result?.blocked === true;
      const ageDays = (now - new Date(row.accepted_at).getTime()) / 86400000;
      if (undeliverable && !row.copy_escalated_at && ageDays >= ACCEPTANCE_COPY_ESCALATE_DAYS) {
        await escalate(estimate, `${estimate.address || 'no address'} — accepted ${String(row.accepted_at).slice(0, 10)}; ${result?.blocked ? 'their email is suppressed (bounced/unsubscribed)' : 'no usable email on the customer or the estimate'}. The promised copy of the accepted terms is on the accepted estimate page / PDF; please get it to them another way.`);
      }
    } catch (err) {
      logger.error(`[lifecycle-sweeps] acceptance copy resend failed for estimate ${row.estimate_id}: ${err.message}`);
    }
  }
  if (sent || escalated) logger.info(`[lifecycle-sweeps] acceptance copies: ${sent} re-sent, ${escalated} escalated (${checked} checked)`);
  return { sent, checked, escalated };
}

// Acceptance ownership reconciliation (pre-push Codex P1): the /book fan-out
// for a customer-less accepted estimate is best-effort inside the booking
// request, so a transient failure there must not leave the record unowned
// forever. Every acceptance row still without a customer is re-examined
// daily: if its estimate has since gained a customer, the row and the
// customer stamp follow; if a booking that proved ownership stamped
// scheduled_services.source_estimate_id, the shared claim runs again.
async function runAcceptanceOwnershipSweep() {
  if (!(await db.schema.hasTable('estimate_acceptances'))) return { attached: 0, checked: 0 };
  const { attachAcceptanceOwnership } = require('./estimate-acceptance-record');
  const rows = await db('estimate_acceptances').whereNull('customer_id').select('id', 'estimate_id', 'terms_version');
  let attached = 0;
  let checked = 0;
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.estimate_id)) continue;
    seen.add(row.estimate_id);
    checked += 1;
    try {
      const estimate = await db('estimates').where({ id: row.estimate_id }).first('id', 'customer_id', 'status', 'terms_version');
      if (!estimate) continue;
      let customerId = estimate.customer_id || null;
      if (!customerId) {
        // Candidates = every customer whose committed booking links this
        // estimate. More than one is a race the request path already lost
        // on both sides — refuse rather than pick one (pre-push Codex P1).
        const booked = await db('scheduled_services').where({ source_estimate_id: row.estimate_id }).whereNotNull('customer_id').select('customer_id');
        const candidates = [...new Set(booked.map((b) => String(b.customer_id)))];
        if (candidates.length > 1) {
          logger.warn(`[lifecycle-sweeps] acceptance ownership for estimate ${row.estimate_id} is ambiguous (${candidates.length} booking customers) — left for the office`);
          continue;
        }
        customerId = candidates[0] || null;
      }
      if (!customerId) continue;
      // Whoever owns (or now claims) the estimate: no other customer's visit
      // may keep correlating to it.
      const clearOtherLinks = async (ownerId) => db('scheduled_services')
        .where({ source_estimate_id: row.estimate_id })
        .whereNot({ customer_id: ownerId })
        .update({ source_estimate_id: null });
      if (!estimate.customer_id) {
        const claim = await attachAcceptanceOwnership(db, { estimateId: row.estimate_id, customerId });
        if (claim.attached) { attached += 1; await clearOtherLinks(customerId); }
        continue;
      }
      await clearOtherLinks(customerId);
      // Estimate already owned (accept-time customer or a later admin link):
      // bring the acceptance rows and the customer stamp along.
      await db.transaction(async (trx) => {
        await trx('estimate_acceptances').where({ estimate_id: row.estimate_id }).whereNull('customer_id').update({ customer_id: customerId });
        if (estimate.terms_version) {
          await trx('customers').where({ id: customerId })
            .where((q) => q.whereNull('accepted_terms_version').orWhere('accepted_terms_version', '<', estimate.terms_version))
            .update({ accepted_terms_version: estimate.terms_version });
        }
      });
      attached += 1;
    } catch (err) {
      logger.error(`[lifecycle-sweeps] acceptance ownership reconcile failed for estimate ${row.estimate_id}: ${err.message}`);
    }
  }
  if (attached) logger.info(`[lifecycle-sweeps] attached ${attached} acceptance record(s) to their customer (${checked} checked)`);
  return { attached, checked };
}

// Each sweep is attempted every day regardless of the others (pre-push Codex
// P1): a persistent bond-sync failure must not silently stall the acceptance
// copy promise, and vice versa.
async function runDailySweeps() {
  const attempt = async (name, fn, empty) => {
    try {
      return await fn();
    } catch (err) {
      logger.error(`[lifecycle-sweeps] ${name} failed: ${err.message}`);
      return empty;
    }
  };
  const bond = await attempt('bond renewal', runBondRenewalSweep, { sent: 0 });
  const ownership = await attempt('acceptance ownership', runAcceptanceOwnershipSweep, { attached: 0, checked: 0 });
  const acceptanceCopies = await attempt('acceptance copies', runAcceptanceCopySweep, { sent: 0, checked: 0, escalated: 0 });
  return { bondRenewalsSent: bond.sent, acceptanceOwnershipAttached: ownership.attached, acceptanceCopiesSent: acceptanceCopies.sent };
}

module.exports = { runDailySweeps, runBondRenewalSweep, runAcceptanceCopySweep, runAcceptanceOwnershipSweep, syncTermiteBonds, _private: { termYearsFrom, termYearsForVisit, displayDate } };
