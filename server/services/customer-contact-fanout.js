/**
 * Fan a customer NAME or PHONE edit out to the rows that snapshot those
 * fields at creation time instead of reading customers.* live (the same
 * problem — and the same guards — as customer-email-fanout and
 * customer-address-fanout):
 *
 * NAME copies:
 *   - leads.first_name/last_name — captured at intake; the Leads UI and
 *     follow-up greetings read them directly.
 *   - estimates.customer_name — captured at creation; the public estimate
 *     page renders it on every view and the send path greets from it, so a
 *     corrected customer record still shows the misspelling on the estimate
 *     the customer already has. An authored proposal snapshots its own copy
 *     (estimate_data.proposal.preparedFor) which normalizeProposal PREFERS
 *     over the column — it syncs under the same guard.
 *   - automation_enrollments.first_name/last_name — denormalized at
 *     enrollment; every remaining step greets with them.
 *   - newsletter_subscribers.first_name — campaign/DOI greetings.
 *   - referral_promoters.first_name/last_name — reward emails greet from
 *     them.
 *   - customer_contracts.recipient_name — delivery/reminder emails address
 *     it. signed_name and the *_snapshot columns are NEVER touched: they are
 *     the legal record of what was signed, exactly as signed.
 *   - booking_intents.first_name/last_name — the abandoned-booking recovery
 *     touches greet from them.
 *   - email_template_automation_runs.payload name keys — queued runs render
 *     their body from the stored payload, so a greeting variable captured
 *     before the correction would still print the old name.
 *
 * PHONE copies (column-only everywhere — no snapshot JSON carries a phone):
 *   - leads.phone — the Leads UI and call-back workflows read it directly.
 *   - estimates.customer_phone — the accept flow matches/creates the
 *     customer record from it, and admin surfaces display it.
 *   - customer_contracts.recipient_phone — non-terminal packets only.
 *   - referral_promoters.customer_phone — the promoter identity key
 *     (UNIQUE); a conflict with an existing promoter row is SKIPPED, never
 *     merged — promoter rows carry reward balances and merging money is not
 *     a fan-out's call.
 *   - booking_intents.phone — the recovery SMS targets it; only rows still
 *     awaiting that touch are rewritten.
 *   - sms_log.to_phone — admin/inbox-scheduled SMS freeze the recipient at
 *     schedule time and the cron sends to the snapshot; not-yet-claimed
 *     ('scheduled') rows retarget, claimed/sent rows are history.
 *
 * A snapshot is only rewritten when it still matches the customer's OLD
 * value (names compare case-insensitively with whitespace collapsed; phones
 * compare by NANP digits, so "+19415551234" matches "(941) 555-1234") — an
 * intentionally different contact on a lead or estimate (a tenant's estimate
 * under a landlord's record, a spouse's number) is never clobbered. Removing
 * the value is not propagated: blanking copies would destroy the only
 * remaining record of who/where contact was promised. Terminal rows are
 * historical documents and stay untouched. Errors PROPAGATE so a
 * transactional caller rolls the whole edit back rather than leaving the
 * record and its copies half-synced.
 *
 * Deliberately NOT fanned out: dispatch_jobs / ical_appointments (legacy
 * imports with no customer link), tax and banking customer_name columns
 * (financial audit trail), sms_messages / call_log (message history), and
 * bulk_update_customers (writing one name/phone onto many customers is not
 * a correction scenario — mirrors the email fan-out's scope).
 *
 * Origin: 2026-07-26, a customer's estimate kept rendering her old name
 * after the Customer 360 record was corrected — the estimate page reads its
 * own customer_name snapshot on every view and nothing ever rewrote it.
 */

const db = require('../models/db');
const logger = require('./logger');
const { cleanText } = require('../utils/intake-normalize');

// Mirrors customer-email-fanout / customer-address-fanout (which mirror
// SENDABLE_ESTIMATE_STATUSES in routes/admin-estimates.js and CLOSED_STATUSES
// in intelligence-bar/leads-tools.js). 'sending' name rows get a COLUMN-ONLY
// sync below (no estimate_data touch under an active send claim) — this
// service is diff-gated like the email fan-out, so a skipped row could never
// heal on a later pass.
const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'send_failed'];
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];
// Mirrors document-contract-delivery TERMINAL_STATUSES (same list the email
// fan-out uses for recipient_email).
const TERMINAL_CONTRACT_STATUSES = ['signed', 'cancelled', 'voided'];

// Case-insensitive, whitespace-collapsed compare key for names. The SQL-side
// equivalent is LOWER(regexp_replace(TRIM(col), '\s+', ' ', 'g')).
function nameKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const NAME_KEY_SQL = (col) => `LOWER(regexp_replace(TRIM(COALESCE(${col}, '')), '\\s+', ' ', 'g'))`;

// NANP digit key: last 10 digits when a leading country '1' is present.
// Loose on the OLD side (the stored copy may itself be malformed — that is
// exactly what gets corrected); the NEW phone must key to a full 10 digits
// before it fans out anywhere.
function phoneKey(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// Both stored spellings of the same number ("9415551234" and "19415551234")
// must match the SQL digit compare.
function phoneDigitVariants(value) {
  const key = phoneKey(value);
  if (!key) return [];
  return key.length === 10 ? [key, `1${key}`] : [key];
}

const PHONE_DIGITS_SQL = (col) => `regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g')`;

/**
 * @param {object} opts
 *   before — customer row before the edit (id, first_name, last_name)
 *   after  — customer row after the edit (id, first_name, last_name)
 * @param {object} conn — knex connection or transaction
 * @returns counts { leads, estimates, enrollments, newsletter, promoters,
 *   contracts, bookingIntents, templateRuns } — all zero when the display
 *   name did not actually change or the new first name is empty.
 */
async function propagateCustomerNameChange({ before, after }, conn = db) {
  const counts = { leads: 0, estimates: 0, enrollments: 0, newsletter: 0, promoters: 0, contracts: 0, bookingIntents: 0, templateRuns: 0 };
  const customerId = (after && after.id) || (before && before.id);
  const newFirst = cleanText(after && after.first_name) || '';
  const newLast = cleanText(after && after.last_name) || '';
  const newFull = `${newFirst} ${newLast}`.trim();
  const oldFirst = cleanText(before && before.first_name) || '';
  const oldLast = cleanText(before && before.last_name) || '';
  const oldFull = `${oldFirst} ${oldLast}`.trim();
  // Diff-gate is case-SENSITIVE ("cathy nunes" → "Cathy Nunes" is a real
  // display fix); the copy-match guards below stay case-insensitive.
  if (!customerId || !newFirst || !oldFull || oldFull === newFull) return counts;

  const oldFirstKey = nameKey(oldFirst);
  const oldLastKey = nameKey(oldLast);
  const oldFullKey = nameKey(oldFull);
  const now = new Date();

  // Split-column copies match on the (first, last) PAIR — a lead captured
  // under only a first name, or under a different family member, is never
  // adopted by a half-matching edit.
  const pairMatch = (q) => q
    .whereRaw(`${NAME_KEY_SQL('first_name')} = ?`, [oldFirstKey])
    .whereRaw(`${NAME_KEY_SQL('last_name')} = ?`, [oldLastKey]);
  // No-op rows are excluded: a case-only edit (old key == new key) also
  // matches copies that ALREADY hold the exact new spelling, and rewriting
  // those would bump updated_at (staleness/follow-up queries key on it) for
  // nothing.
  const pairDiff = (last) => (q) => q.where((w) => w
    .whereRaw('first_name IS DISTINCT FROM ?', [newFirst])
    .orWhereRaw('last_name IS DISTINCT FROM ?', [last]));

  counts.leads += await pairDiff(newLast || null)(pairMatch(
    conn('leads')
      .where({ customer_id: customerId })
      .whereNull('deleted_at')
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
  )).update({ first_name: newFirst, last_name: newLast || null, updated_at: now });

  // Estimates snapshot ONE display string, and an authored proposal snapshots
  // its own preparedFor which the PDF prints — per-row so the proposal patch
  // can be guarded against a concurrent proposal save (address fan-out
  // discipline: re-assert the exact values the row was selected with).
  const estimateRows = await conn('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES)
    .whereNull('archived_at')
    .whereRaw(`${NAME_KEY_SQL('customer_name')} = ?`, [oldFullKey])
    .select('id', 'customer_name', 'estimate_data');
  for (const row of estimateRows) {
    const data = typeof row.estimate_data === 'string'
      ? (() => { try { return JSON.parse(row.estimate_data); } catch { return null; } })()
      : row.estimate_data;
    const targetName = newFull.slice(0, 100);
    const preparedFor = data?.proposal?.preparedFor;
    const patchPreparedFor = !!(preparedFor && nameKey(preparedFor) === oldFullKey && preparedFor !== targetName);
    // A case-only edit (old key == new key) also matches rows that ALREADY
    // hold the exact new spelling everywhere — nothing displayed changes on
    // those, so they get no write (and keep their delivery marker).
    if (row.customer_name === targetName && !patchPreparedFor) continue;
    // The delivery marker drops only when the PDF-visible name actually
    // moves: preparedFor matching the old name gets patched, and a MISSING
    // preparedFor means the synthesized PDF fell back to customer_name — the
    // one being rewritten. A CUSTOM preparedFor (a landlord's estimate
    // addressed to the tenant) leaves the PDF untouched, so its "PDF
    // emailed" state survives a column-only sync. jsonb minus is a no-op
    // when the key is absent and NULL stays NULL.
    const dropDelivery = patchPreparedFor || !preparedFor;
    const expr = patchPreparedFor
      ? "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{proposal,preparedFor}', to_jsonb(?::text)) - 'proposalDelivery'"
      : "estimate_data - 'proposalDelivery'";
    const bindings = patchPreparedFor ? [targetName] : [];
    let guarded = conn('estimates')
      .where({ id: row.id, customer_id: customerId, customer_name: row.customer_name })
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNull('archived_at');
    if (patchPreparedFor) {
      // The preparedFor patch was decided from the SELECTed estimate_data — a
      // proposal save committing in between must not have its fresh copy
      // rewritten from that stale read.
      guarded = guarded.whereRaw("estimate_data #>> '{proposal,preparedFor}' IS NOT DISTINCT FROM ?", [preparedFor]);
    }
    const n = await guarded.update({
      customer_name: targetName,
      ...(dropDelivery ? { estimate_data: conn.raw(expr, bindings) } : {}),
      updated_at: now,
    });
    counts.estimates += n;
    if (!n && patchPreparedFor) {
      // The proposal moved under us — sync the column alone and leave the
      // fresh proposal (and any delivery marker the concurrent save just
      // stamped) untouched. COLUMN-ONLY: dropping proposalDelivery here
      // would be acting on the stale read the guard just rejected.
      counts.estimates += await conn('estimates')
        .where({ id: row.id, customer_id: customerId, customer_name: row.customer_name })
        .whereIn('status', OPEN_ESTIMATE_STATUSES)
        .whereNull('archived_at')
        .update({ customer_name: targetName, updated_at: now });
    }
  }

  // COLUMN-ONLY catch-up over every open + in-flight state: 'sending' rows
  // sync here because the active send claim owns estimate_data (see the email
  // fan-out's verification against the send path), and rows that RACED
  // through the per-row pass — claimed into 'sending' after the select, or
  // settled back to sent/send_failed before this query — still key-match the
  // old name and heal here. Diff-gating means a stranded row could never heal
  // later, so this pass must not depend on the status observed at select
  // time.
  counts.estimates += await conn('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', [...OPEN_ESTIMATE_STATUSES, 'sending'])
    .whereNull('archived_at')
    .whereRaw(`${NAME_KEY_SQL('customer_name')} = ?`, [oldFullKey])
    .whereRaw('customer_name IS DISTINCT FROM ?', [newFull.slice(0, 100)])
    .update({ customer_name: newFull.slice(0, 100), updated_at: now });

  // Guarded preparedFor repair — keyed on the PROPOSAL'S OWN copy, not the
  // column, so it reaches rows the per-row pass could not touch: a row inside
  // (or racing through) a 'sending' claim, or a copy left half-synced by an
  // earlier race. Proposal rendering PREFERS preparedFor over the column, so
  // leaving it would keep the old name on the public estimate indefinitely
  // (this service is diff-gated — a later resave cannot heal it). Patching
  // preparedFor UNDER a 'sending' claim is safe: the send rendered its PDF
  // into memory before the claim, and the settle write merges only its OWN
  // top-level keys (sendSnapshot/deliveryState/proposalDelivery via jsonb ||,
  // explicitly preserving a concurrent `proposal`, see sendEstimateNow in
  // routes/admin-estimates.js). proposalDelivery drops only for NON-sending
  // rows — an in-flight send is about to stamp it for the send it actually
  // made; that marker refers to a PDF with the old spelling, the same
  // bounded one-send residual the email fan-out accepts.
  const repairRows = await conn('estimates')
    .where({ customer_id: customerId })
    .whereIn('status', [...OPEN_ESTIMATE_STATUSES, 'sending'])
    .whereNull('archived_at')
    .whereRaw(`${NAME_KEY_SQL("(estimate_data #>> '{proposal,preparedFor}')")} = ?`, [oldFullKey])
    .select('id', 'estimate_data');
  for (const row of repairRows) {
    const data = typeof row.estimate_data === 'string'
      ? (() => { try { return JSON.parse(row.estimate_data); } catch { return null; } })()
      : row.estimate_data;
    const preparedFor = data?.proposal?.preparedFor;
    const targetName = newFull.slice(0, 100);
    if (!preparedFor || nameKey(preparedFor) !== oldFullKey || preparedFor === targetName) continue;
    // The keep-or-drop decision for the delivery marker is made IN the
    // update from the status AT UPDATE TIME (a row selected as 'sending' can
    // settle — its fresh settle-stamped marker refers to a PDF with the old
    // name and must drop; a row claimed into 'sending' after the select must
    // keep the marker its in-flight send is about to stamp). A select-time
    // JS decision would act on a stale status either way.
    counts.estimates += await conn('estimates')
      .where({ id: row.id, customer_id: customerId })
      .whereIn('status', [...OPEN_ESTIMATE_STATUSES, 'sending'])
      .whereNull('archived_at')
      .whereRaw("estimate_data #>> '{proposal,preparedFor}' IS NOT DISTINCT FROM ?", [preparedFor])
      .update({
        estimate_data: conn.raw(
          "CASE WHEN status = 'sending' "
          + "THEN jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{proposal,preparedFor}', to_jsonb(?::text)) "
          + "ELSE jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{proposal,preparedFor}', to_jsonb(?::text)) - 'proposalDelivery' END",
          [targetName, targetName]
        ),
        updated_at: now,
      });
  }

  // Active enrollments greet every remaining step from their denormalized
  // name; terminal enrollments are history.
  counts.enrollments += await pairDiff(newLast || null)(pairMatch(
    conn('automation_enrollments').where({ customer_id: customerId, status: 'active' })
  )).update({ first_name: newFirst, last_name: newLast || null, updated_at: now });

  // Newsletter greetings only carry a first name.
  if (oldFirstKey) {
    counts.newsletter += await conn('newsletter_subscribers')
      .where({ customer_id: customerId })
      .whereRaw(`${NAME_KEY_SQL('first_name')} = ?`, [oldFirstKey])
      .whereRaw('first_name IS DISTINCT FROM ?', [newFirst])
      .update({ first_name: newFirst, updated_at: now });
  }

  // Promoter name columns are NOT NULL — an empty new last name stores ''.
  counts.promoters += await pairDiff(newLast)(pairMatch(
    conn('referral_promoters').where({ customer_id: customerId })
  )).update({ first_name: newFirst, last_name: newLast, updated_at: now });

  // Delivery/reminder emails address recipient_name; signed_name and the
  // legal *_snapshot columns are never rewritten (see header).
  counts.contracts += await conn('customer_contracts')
    .where({ customer_id: customerId })
    .whereNotIn('status', TERMINAL_CONTRACT_STATUSES)
    .whereRaw(`${NAME_KEY_SQL('recipient_name')} = ?`, [oldFullKey])
    .whereRaw('recipient_name IS DISTINCT FROM ?', [newFull.slice(0, 180)])
    .update({ recipient_name: newFull.slice(0, 180), updated_at: now });

  // Recovery touches (SMS and ~24h email) greet from the intent row — only
  // rows still awaiting a touch matter. IS NOT TRUE mirrors the recovery
  // sender's own pending predicates (the flags are nullable).
  counts.bookingIntents += await pairDiff(newLast || null)(pairMatch(
    conn('booking_intents')
      .where({ customer_id: customerId })
      .whereRaw('suppressed IS NOT TRUE')
      .whereNull('converted_at')
      .where((q) => q.whereRaw('followup_sms_sent IS NOT TRUE').orWhereRaw('followup_email_sent IS NOT TRUE'))
  )).update({ first_name: newFirst, last_name: newLast || null, updated_at: now });

  // Queued template runs render their body from the stored payload — greeting
  // variables captured before the correction would print the old name. Same
  // rules as the email fan-out: recipient-linked rows only, not-yet-claimed
  // states only, per-row with the state re-asserted so a concurrent claim
  // wins. Only payload keys whose value still matches the OLD name move.
  const runRows = await conn('email_template_automation_runs')
    .whereIn('status', ['queued', 'scheduled', 'retry_scheduled'])
    .where({ recipient_id: String(customerId) })
    .select('id', 'payload');
  for (const row of runRows) {
    const payload = row.payload && typeof row.payload === 'object' ? { ...row.payload } : null;
    if (!payload) continue;
    let payloadPatched = false;
    for (const key of ['first_name', 'firstName']) {
      if (nameKey(payload[key]) === oldFirstKey && oldFirstKey && payload[key] !== newFirst) {
        payload[key] = newFirst;
        payloadPatched = true;
      }
    }
    for (const key of ['customer_name', 'customerName', 'name']) {
      if (nameKey(payload[key]) === oldFullKey && payload[key] !== newFull) {
        payload[key] = newFull;
        payloadPatched = true;
      }
    }
    if (!payloadPatched) continue;
    counts.templateRuns += await conn('email_template_automation_runs')
      .where({ id: row.id, recipient_id: String(customerId) })
      .whereIn('status', ['queued', 'scheduled', 'retry_scheduled'])
      .update({ payload: JSON.stringify(payload), updated_at: now });
  }

  if (Object.values(counts).some(Boolean)) {
    // Counts only — never the name values (PII stays out of logs).
    logger.info(`[contact-fanout] customer ${customerId} name: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s), ${counts.enrollments} enrollment(s), ${counts.newsletter} newsletter, ${counts.promoters} promoter(s), ${counts.contracts} contract(s), ${counts.bookingIntents} booking intent(s), ${counts.templateRuns} template run(s)`);
  }
  return counts;
}

/**
 * @param {object} opts
 *   before — customer row before the edit (id, phone)
 *   after  — customer row after the edit (id, phone)
 * @param {object} conn — knex connection or transaction
 * @returns counts { leads, estimates, contracts, promoters, promoterSkipped,
 *   bookingIntents, scheduledSms } — all zero when the phone did not actually
 *   change (by digit key) or the new phone is not a full 10-15 digit number.
 */
async function propagateCustomerPhoneChange({ before, after }, conn = db) {
  const counts = { leads: 0, estimates: 0, contracts: 0, promoters: 0, promoterSkipped: 0, bookingIntents: 0, scheduledSms: 0 };
  const customerId = (after && after.id) || (before && before.id);
  const oldVariants = phoneDigitVariants(before && before.phone);
  const newPhone = cleanText(after && after.phone) || '';
  const newKey = phoneKey(newPhone);
  // The NEW phone must be a full number before it fans out; the OLD side only
  // needs to have been something (that is what gets corrected). 10 digits =
  // NANP; up to 15 covers the international numbers the repository's phone
  // handling explicitly preserves (normalizePhoneForStorage keeps non-NANP
  // input verbatim) — shorter fragments never propagate.
  if (!customerId || !oldVariants.length || newKey.length < 10 || newKey.length > 15 || oldVariants.includes(newKey)) return counts;

  const now = new Date();
  const digitPlaceholders = oldVariants.map(() => '?').join(', ');
  const matchOld = (col) => (q) => q.whereRaw(`${PHONE_DIGITS_SQL(col)} IN (${digitPlaceholders})`, oldVariants);

  counts.leads += await matchOld('phone')(
    conn('leads')
      .where({ customer_id: customerId })
      .whereNull('deleted_at')
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
  ).update({ phone: newPhone, updated_at: now });

  // Column-only for every estimate state including 'sending' — no phone lives
  // in estimate_data, so there is nothing an in-flight send could lose.
  counts.estimates += await matchOld('customer_phone')(
    conn('estimates')
      .where({ customer_id: customerId })
      .whereIn('status', [...OPEN_ESTIMATE_STATUSES, 'sending'])
      .whereNull('archived_at')
  ).update({ customer_phone: newPhone.slice(0, 20), updated_at: now });

  counts.contracts += await matchOld('recipient_phone')(
    conn('customer_contracts')
      .where({ customer_id: customerId })
      .whereNotIn('status', TERMINAL_CONTRACT_STATUSES)
  ).update({ recipient_phone: newPhone.slice(0, 40), updated_at: now });

  // referral_promoters.customer_phone is the promoter identity key (UNIQUE).
  // Check-first instead of update-and-catch: a caught unique violation would
  // poison the caller's transaction (Postgres aborts it). A promoter row
  // already existing under the NEW number is a conflict this fan-out must
  // not resolve — promoter rows carry reward balances, and merging balances
  // is an owner decision, not a side effect. Skip and log.
  const ownPromoter = await matchOld('customer_phone')(
    conn('referral_promoters').where({ customer_id: customerId })
  ).first();
  if (ownPromoter) {
    const newVariants = phoneDigitVariants(newPhone);
    // The conflict check lives INSIDE the update statement (NOT EXISTS), so a
    // promoter row claiming the new number between a separate select and this
    // update can no longer force a 23505 that aborts the caller's whole edit.
    // n=0 means either a conflict or a concurrently moved own-row — both are
    // "leave it alone". The statement runs inside a SAVEPOINT (knex nested
    // transaction) because a conflict row can still commit mid-statement and
    // raise the unique violation past the guard — without the savepoint that
    // poisons the caller's transaction, and the callers' generic 23505
    // handlers would report a phone-only edit as an ADDRESS collision. The
    // race resolves to the same designed outcome as the guard: skip and log.
    let n = 0;
    try {
      n = await conn.transaction((sp) => sp('referral_promoters')
        .where({ id: ownPromoter.id, customer_phone: ownPromoter.customer_phone })
        .whereNotExists(
          sp('referral_promoters')
            .select(sp.raw('1'))
            .whereRaw(`${PHONE_DIGITS_SQL('customer_phone')} IN (${newVariants.map(() => '?').join(', ')})`, newVariants)
            .whereNot({ id: ownPromoter.id })
        )
        .update({ customer_phone: newPhone.slice(0, 20), updated_at: now }));
    } catch (e) {
      if (!e || e.code !== '23505') throw e;
    }
    counts.promoters += n;
    if (!n) {
      // Promoter rows carry reward balances — a collision is never merged by
      // a fan-out; it is logged and left for the owner.
      counts.promoterSkipped += 1;
      logger.warn(`[contact-fanout] customer ${customerId}: promoter phone NOT synced — another promoter row already holds the new number (or promoter ${ownPromoter.id} moved concurrently); merge is an owner decision`);
    }
  }

  // The recovery SMS targets booking_intents.phone — only rows still awaiting
  // that touch are rewritten (unconverted, SMS unsent, not suppressed).
  counts.bookingIntents += await matchOld('phone')(
    conn('booking_intents')
      .where({ customer_id: customerId })
      .whereRaw('suppressed IS NOT TRUE')
      .whereRaw('followup_sms_sent IS NOT TRUE')
      .whereNull('converted_at')
  ).update({ phone: newPhone, updated_at: now });

  // Queued admin/inbox SMS freeze to_phone at schedule time and the cron
  // sends to that snapshot (resolveScheduledRecipient re-reads the customer
  // row ONLY for the deposit refresh_customer_phone flag) — retarget
  // customer-linked rows still awaiting their claim. The status predicate
  // re-asserts 'scheduled' at update time, so a concurrent cron claim
  // ('sending', recipient already read into memory) wins; sent/failed rows
  // are message history and stay frozen.
  counts.scheduledSms += await matchOld('to_phone')(
    conn('sms_log')
      .where({ customer_id: customerId, direction: 'outbound', status: 'scheduled' })
  ).update({ to_phone: newPhone.slice(0, 20), updated_at: now });

  if (Object.values(counts).some(Boolean)) {
    // Counts only — never the phone values (PII stays out of logs).
    logger.info(`[contact-fanout] customer ${customerId} phone: synced ${counts.leads} lead(s), ${counts.estimates} estimate(s), ${counts.contracts} contract(s), ${counts.promoters} promoter(s) (${counts.promoterSkipped} skipped), ${counts.bookingIntents} booking intent(s), ${counts.scheduledSms} scheduled SMS`);
  }
  return counts;
}

// Operator-facing disclosure of everything this fan-out touches. The IB
// confirmation-card summary AND the update_customer tool description both
// render THIS string, so the disclosure can never silently drift from the
// service's actual side effects — extend it in the same commit that adds a
// new synced surface.
const CONTACT_FANOUT_DISCLOSURE = 'a name or phone change also updates every open copy still carrying the old value (leads, estimates, contracts, referral promoter, booking recovery, active automations, newsletter greeting, queued template sends, scheduled SMS)';

module.exports = {
  propagateCustomerNameChange,
  propagateCustomerPhoneChange,
  nameKey,
  phoneKey,
  CONTACT_FANOUT_DISCLOSURE,
};
