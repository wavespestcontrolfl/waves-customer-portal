/**
 * One-off cleanup for the Pipeline>Leads audit (2026-07-01), fix #8:
 * the backlog the three forward-acting lanes don't reach.
 *
 *   A. BOOKED-BUT-UN-WON — leads whose linked customer has a real (non-
 *      cancelled/non-rescheduled) scheduled service but whose lead row was
 *      never converted (the AI-call booking path didn't convert until
 *      PR #2262). Open/unresponsive leads convert; human-closed rows
 *      (lost/disqualified) are reported instead — unlike the live booking
 *      path, a backfill can't know whether the human decision came after
 *      the booking. `converted_at` is BACKDATED to the earliest qualifying
 *      scheduled_services.created_at so ads offline-conversion windows
 *      (data-manager reads COALESCE(converted_at, …)) don't see 72 stale
 *      leads as conversions minted on the run date.
 *
 *   B. JUNK EMAIL LEADS — quarantine (soft-delete) leads whose CONTACT
 *      email is an automated sender (the Santos class: twimlets voicemail
 *      relay, Thumbtack do-not-reply, the retired payment processor's
 *      messenger bot). Matches the guard list shipped in the
 *      email-lead-guards lane. Requires leads.deleted_at (the soft-delete
 *      migration) — this part aborts with a message if the column is
 *      missing. A junk-pattern lead that is won or customer-linked is
 *      NEVER touched — reported for a human instead.
 *
 *   C. EXACT DUPES — same normalized contact (phone last-10, else email)
 *      AND same normalized name, more than one live row: every open-status
 *      row except the "best" one (highest status rank, then newest) is
 *      marked status `duplicate`. A losing row holding an estimate_id or
 *      customer_id is reported, not touched.
 *
 * SAFE BY DEFAULT: dry-run unless `--commit`. Writes to whatever
 * DATABASE_URL points at, so run deliberately (break-glass on prod via
 * `railway ssh`, per the waves-db policy). Logs lead ids/statuses/dates
 * only — never names, phones, or emails.
 *
 *   node server/scripts/cleanup-leads-pipeline-audit.js             # dry-run
 *   node server/scripts/cleanup-leads-pipeline-audit.js --commit    # apply
 *   node server/scripts/cleanup-leads-pipeline-audit.js --limit=50  # cap per part
 *   --junk-domains=a.com,b.com   # extra junk relay domains for Part B
 *                                # (retired-tool domains are passed here at
 *                                # run time, never committed to the repo)
 */
require('dotenv').config();
const db = require('../models/db');

const COMMIT = process.argv.includes('--commit');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(parseInt(limitArg.split('=')[1], 10) || 0, 0) : 0;

const SCRIPT_TAG = 'cleanup-leads-pipeline-audit';

// The LIVE booking path (convertCallLeadOnPhoneBooking) converts everything
// but won/duplicate because at booking time the deal IS closing. A backfill
// months later can't know whether a human marked a lead lost/disqualified
// AFTER the booking (plan cancelled, mistaken identity) — so those are
// reported for a human instead of auto-converted.
const CONVERT_ELIGIBLE_STATUSES = ['new', 'contacted', 'estimate_sent', 'estimate_viewed', 'unresponsive'];
const CONVERT_HUMAN_STATUSES = ['lost', 'disqualified'];
// Visit rows that do NOT prove a standing booking (a reschedule is replaced
// by a live row that still matches) — same set the staleness sweep uses.
const NON_EVIDENCE_VISIT_STATUSES = ['cancelled', 'rescheduled'];

// Junk contact-email matchers — aligned with the email-lead-guards lane
// (LEAD_HARD_SKIP_SENDERS + AUTOMATED_SENDER_LOCAL_PARTS/RELAY usage).
// Retired-tool domains (e.g. the phased-out payment processor's messaging
// domain) are deliberately NOT committed here — pass them at run time:
//   --junk-domains=example-relay.com,other.com
const junkDomainsArg = process.argv.find((a) => a.startsWith('--junk-domains='));
const EXTRA_JUNK_DOMAINS = junkDomainsArg
  ? junkDomainsArg.split('=')[1].split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  : [];
const JUNK_EMAIL_DOMAINS = ['twimlets.com', ...EXTRA_JUNK_DOMAINS];
const JUNK_EMAIL_EXACT = ['do-not-reply@thumbtack.com'];
const JUNK_LOCAL_PARTS = ['do-not-reply', 'no-reply', 'noreply', 'donotreply', 'notifications'];

// Higher rank wins the dupe group; everything else in the group is the dupe.
const STATUS_RANK = {
  won: 100, estimate_viewed: 80, estimate_sent: 70, contacted: 60,
  new: 50, unresponsive: 30, lost: 20, disqualified: 10, duplicate: 0,
};
const OPEN_STATUSES = ['new', 'contacted', 'estimate_sent', 'estimate_viewed'];

function normalizedEmail(value) {
  const v = String(value || '').trim().toLowerCase();
  return v.includes('@') ? v : null;
}

function phoneLast10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function isJunkEmail(value) {
  const email = normalizedEmail(value);
  if (!email) return false;
  if (JUNK_EMAIL_EXACT.includes(email)) return true;
  const [localPart, domain] = email.split('@');
  if (JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return JUNK_LOCAL_PARTS.includes(localPart);
}

function cap(rows) {
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

async function hasDeletedAtColumn() {
  return db.schema.hasColumn('leads', 'deleted_at').catch(() => false);
}

// ── Part A: booked-but-un-won → won ────────────────────────────────────────
async function partABookedUnwon({ softDelete }) {
  let query = db('leads')
    .whereIn('leads.status', [...CONVERT_ELIGIBLE_STATUSES, ...CONVERT_HUMAN_STATUSES])
    .whereNotNull('leads.customer_id')
    .whereNull('leads.converted_at')
    .join('scheduled_services as ss', 'ss.customer_id', 'leads.customer_id')
    .whereNotIn('ss.status', NON_EVIDENCE_VISIT_STATUSES)
    // Evidence must postdate the lead: an existing customer's OLD services
    // must not "win" a NEW inquiry lead (and backdating converted_at to a
    // pre-lead booking would corrupt attribution). 1-day grace covers the
    // call-processing flow where the booking row can precede the lead row
    // inside one processing run.
    .whereRaw("ss.created_at >= COALESCE(leads.first_contact_at, leads.created_at) - interval '1 day'")
    .groupBy('leads.id', 'leads.status', 'leads.customer_id')
    .select(
      'leads.id',
      'leads.status',
      'leads.customer_id',
      db.raw('MIN(ss.created_at) as first_booking_at'),
      db.raw('(ARRAY_AGG(ss.id ORDER BY ss.created_at ASC))[1] as evidence_service_id'),
    )
    .orderBy('first_booking_at', 'asc');
  if (softDelete) query = query.whereNull('leads.deleted_at');

  const all = await query;
  const humanReview = all.filter((r) => CONVERT_HUMAN_STATUSES.includes(r.status));
  const rows = cap(all.filter((r) => CONVERT_ELIGIBLE_STATUSES.includes(r.status)));
  console.log(`\n── Part A: booked-but-un-won leads → won (${rows.length} actionable, ${humanReview.length} human-closed for review)`);
  for (const row of rows) {
    console.log(`  lead ${row.id} status=${row.status} booked=${new Date(row.first_booking_at).toISOString()}`);
  }
  for (const row of humanReview) {
    console.log(`  NEEDS HUMAN (human-closed after booking?, not touched): lead ${row.id} status=${row.status}`);
  }
  if (!COMMIT || !rows.length) return { candidates: rows.length, applied: 0 };

  let applied = 0;
  for (const row of rows) {
    // Per-lead transaction, stamp gated on the still-unconverted state so a
    // concurrent live-path conversion can't be double-logged.
    // eslint-disable-next-line no-await-in-loop
    await db.transaction(async (trx) => {
      let stampQuery = trx('leads')
        .where({ id: row.id })
        .whereIn('status', CONVERT_ELIGIBLE_STATUSES)
        .whereNull('converted_at');
      if (softDelete) stampQuery = stampQuery.whereNull('deleted_at');
      const stamped = await stampQuery.update({
        status: 'won',
        converted_at: new Date(row.first_booking_at),
        is_qualified: true,
        updated_at: new Date(),
      });
      if (!stamped) return;
      await trx('lead_activities').insert({
        lead_id: row.id,
        activity_type: 'converted',
        description: `Converted to customer (${row.customer_id}) — appointment booked (audit backfill)`,
        performed_by: 'system',
        metadata: JSON.stringify({
          triggerSource: 'backfill_appointment_booked',
          scheduledServiceId: row.evidence_service_id,
          script: SCRIPT_TAG,
        }),
      });
      applied += 1;
    });
  }
  console.log(`  → converted ${applied} lead(s)`);
  return { candidates: rows.length, applied };
}

// ── Part B: junk email leads → quarantine (soft delete) ────────────────────
async function partBJunkEmails({ softDelete }) {
  if (!softDelete) {
    console.log('\n── Part B: SKIPPED — leads.deleted_at missing (soft-delete lane not deployed yet)');
    return { candidates: 0, applied: 0, skippedForHuman: 0 };
  }

  const rows = await db('leads')
    .whereNull('deleted_at')
    .whereNotNull('email')
    .select('id', 'status', 'email', 'customer_id', 'created_at');

  const junk = rows.filter((r) => isJunkEmail(r.email));
  const untouchable = junk.filter((r) => r.status === 'won' || r.customer_id);
  const actionable = cap(junk.filter((r) => r.status !== 'won' && !r.customer_id));

  console.log(`\n── Part B: junk automated-sender leads → quarantine (${actionable.length} actionable, ${untouchable.length} linked/won for human review)`);
  for (const row of actionable) {
    console.log(`  lead ${row.id} status=${row.status} created=${new Date(row.created_at).toISOString()}`);
  }
  for (const row of untouchable) {
    console.log(`  NEEDS HUMAN (won or customer-linked, not touched): lead ${row.id} status=${row.status}`);
  }
  if (!COMMIT || !actionable.length) {
    return { candidates: actionable.length, applied: 0, skippedForHuman: untouchable.length };
  }

  let applied = 0;
  for (const row of actionable) {
    // deleted_by is deliberately not written: it stays NULL (its default) —
    // the system actor is recorded on the activity row instead, and probing
    // only deleted_at keeps the guard aligned with what the script writes.
    // eslint-disable-next-line no-await-in-loop
    await db.transaction(async (trx) => {
      const stamped = await trx('leads')
        .where({ id: row.id })
        .whereNull('deleted_at')
        .whereNot('status', 'won')
        .whereNull('customer_id')
        .update({ deleted_at: new Date(), updated_at: new Date() });
      if (!stamped) return;
      await trx('lead_activities').insert({
        lead_id: row.id,
        activity_type: 'deleted',
        description: 'Quarantined by leads-pipeline-audit cleanup — automated-sender contact email',
        performed_by: 'system',
        metadata: JSON.stringify({ script: SCRIPT_TAG, reason: 'junk_automated_sender_email' }),
      });
      applied += 1;
    });
  }
  console.log(`  → quarantined ${applied} lead(s)`);
  return { candidates: actionable.length, applied, skippedForHuman: untouchable.length };
}

// ── Part C: exact dupes → status duplicate ─────────────────────────────────
function normalizedName(row) {
  return `${String(row.first_name || '').trim().toLowerCase()} ${String(row.last_name || '').trim().toLowerCase()}`.trim();
}

async function partCDupes({ softDelete }) {
  let query = db('leads').select(
    'id', 'status', 'first_name', 'last_name', 'email', 'phone',
    'estimate_id', 'customer_id', 'first_contact_at', 'created_at',
  );
  if (softDelete) query = query.whereNull('deleted_at');
  const rows = await query;

  const groups = new Map();
  for (const row of rows) {
    const contact = phoneLast10(row.phone) || normalizedEmail(row.email);
    const name = normalizedName(row);
    if (!contact || !name) continue; // fuzzy/no-contact rows are never auto-marked
    const key = `${contact}|${name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const toMark = [];
  const needsHuman = [];
  let groupCount = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    groupCount += 1;
    const ranked = [...group].sort((a, b) => {
      const rankDiff = (STATUS_RANK[b.status] ?? 40) - (STATUS_RANK[a.status] ?? 40);
      if (rankDiff) return rankDiff;
      const aTs = new Date(a.first_contact_at || a.created_at || 0).getTime();
      const bTs = new Date(b.first_contact_at || b.created_at || 0).getTime();
      return bTs - aTs;
    });
    const keeper = ranked[0];
    for (const loser of ranked.slice(1)) {
      if (!OPEN_STATUSES.includes(loser.status)) continue; // closed rows stay as-is
      if (loser.estimate_id || loser.customer_id) {
        needsHuman.push({ loser, keeper });
      } else {
        toMark.push({ loser, keeper });
      }
    }
  }

  const actionable = cap(toMark);
  console.log(`\n── Part C: exact same-contact same-name dupes → duplicate (${groupCount} group(s); ${actionable.length} actionable, ${needsHuman.length} linked for human review)`);
  for (const { loser, keeper } of actionable) {
    console.log(`  lead ${loser.id} status=${loser.status} → duplicate (keeper ${keeper.id} status=${keeper.status})`);
  }
  for (const { loser, keeper } of needsHuman) {
    console.log(`  NEEDS HUMAN (holds estimate/customer link, not touched): lead ${loser.id} (keeper ${keeper.id})`);
  }
  if (!COMMIT || !actionable.length) {
    return { candidates: actionable.length, applied: 0, skippedForHuman: needsHuman.length };
  }

  let applied = 0;
  for (const { loser, keeper } of actionable) {
    // eslint-disable-next-line no-await-in-loop
    await db.transaction(async (trx) => {
      let stampQuery = trx('leads')
        .where({ id: loser.id })
        .whereIn('status', OPEN_STATUSES)
        .whereNull('estimate_id')
        .whereNull('customer_id');
      if (softDelete) stampQuery = stampQuery.whereNull('deleted_at');
      const stamped = await stampQuery.update({ status: 'duplicate', updated_at: new Date() });
      if (!stamped) return;
      await trx('lead_activities').insert({
        lead_id: loser.id,
        activity_type: 'status_change',
        description: `Marked duplicate of lead ${keeper.id} by leads-pipeline-audit cleanup`,
        performed_by: 'system',
        metadata: JSON.stringify({ script: SCRIPT_TAG, keeperLeadId: keeper.id }),
      });
      applied += 1;
    });
  }
  console.log(`  → marked ${applied} duplicate(s)`);
  return { candidates: actionable.length, applied, skippedForHuman: needsHuman.length };
}

async function main() {
  console.log(`[${SCRIPT_TAG}] mode=${COMMIT ? 'COMMIT' : 'dry-run'}${LIMIT ? ` limit=${LIMIT}/part` : ''}`);
  const softDelete = await hasDeletedAtColumn();
  if (!softDelete) {
    console.log('[warn] leads.deleted_at not found — Part B disabled; Parts A/C run without the soft-delete guard');
  }

  const a = await partABookedUnwon({ softDelete });
  const b = await partBJunkEmails({ softDelete });
  const c = await partCDupes({ softDelete });

  console.log('\n── Summary');
  console.log(`  A booked-but-un-won: ${a.candidates} candidate(s), ${a.applied} converted`);
  console.log(`  B junk quarantine:   ${b.candidates} candidate(s), ${b.applied} quarantined, ${b.skippedForHuman} need human`);
  console.log(`  C dupes:             ${c.candidates} candidate(s), ${c.applied} marked, ${c.skippedForHuman} need human`);
  if (!COMMIT) console.log('  (dry-run — re-run with --commit to apply)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${SCRIPT_TAG}] failed: ${err.message}`);
    process.exit(1);
  });
