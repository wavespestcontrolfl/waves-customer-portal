/**
 * Collections contact policy — the single gate every balance-related outreach
 * decision consults (PR A: policy + shadow only; NOTHING here sends, dials,
 * or messages — it only answers "would contacting this customer on this
 * channel, for this purpose, right now be allowed?").
 *
 * FAIL CLOSED: any thrown error or unknown state evaluates to NOT ALLOWED
 * with an explicit denial reason. The reads here gate outbound contact, so a
 * DB blip must read as "no", never as "yes".
 *
 * Denial reasons are stable identifiers (tests pin them):
 *   unknown_channel, unknown_purpose, customer_not_found, customer_archived,
 *   no_eligible_balance,
 *   flag_<flag> (one per active collections_flags row covering the channel),
 *   suppression_<reason> (canonical messaging_suppression row covering the channel),
 *   contact_within_24h, voice_contact_within_7d, live_conversation_within_7d,
 *   outside_call_window,
 *   pilot_requires_single_invoice, pilot_balance_below_minimum,
 *   pilot_balance_above_maximum, pilot_not_overdue_long_enough,
 *   pilot_overdue_too_long, pilot_insufficient_dunning_history,
 *   pilot_awaiting_microdeposit_verification,
 *   line_type_unknown, line_type_not_mobile, commercial_customer,
 *   consent_no_evidence, rnd_check_required,
 *   policy_evaluation_error
 */

const db = require('../../models/db');
const logger = require('../logger');
const { openBalanceInvoices } = require('../open-balance');
const { invoiceAmountDue } = require('../invoice-helpers');
const { etParts, etDateString, etCalendarDayOf } = require('../../utils/datetime-et');
const ConsentProvenance = require('./consent-provenance');

const CHANNELS = new Set(['sms', 'email', 'voice', 'manual_call']);

// Strict purpose allowlist (codex 2026-08-14 r2 ruling): an unknown purpose
// on ANY channel is a denial, never an unrestricted allow — before this, any
// voice purpose other than 'late_payment' skipped the pilot caps entirely
// and returned allowed. Call-shaped channels know ONLY 'late_payment' today;
// sms/email additionally know 'balance_reminder' (the balance-reminder and
// previsit rails). Adding a purpose here is a deliberate policy decision.
const KNOWN_PURPOSES_BY_CHANNEL = {
  voice: ['late_payment'],
  manual_call: ['late_payment'],
  sms: ['late_payment', 'balance_reminder'],
  email: ['late_payment', 'balance_reminder'],
};

// Which channels each active flag blocks. Absolute flags block everything —
// including manual_call, so even a human dial-sheet consumer sees the denial.
const ALL_CHANNELS = ['sms', 'email', 'voice', 'manual_call'];
const FLAG_BLOCKED_CHANNELS = {
  do_not_collect: ALL_CHANNELS,
  collection_hold: ALL_CHANNELS,
  attorney_represented: ALL_CHANNELS,
  bankruptcy: ALL_CHANNELS,
  wrong_number: ALL_CHANNELS,
  do_not_call: ['voice', 'manual_call'],
  do_not_text: ['sms'],
  do_not_email: ['email'],
  automated_voice_consent_revoked: ['voice'],
};

// Voice pilot caps (owner-scoped): ONE invoice, $50.00–$500.00, 14–60 days
// overdue, ≥2 delivered dunning touches, mobile line, residential only.
const PILOT_MIN_BALANCE_CENTS = 5000;
const PILOT_MAX_BALANCE_CENTS = 50000;
const PILOT_MIN_DAYS_OVERDUE = 14;
const PILOT_MAX_DAYS_OVERDUE = 60;
const PILOT_MIN_DUNNING_TOUCHES = 2;

// Voice contact window: 9:00–17:59 ET, Monday–Friday.
const CALL_WINDOW_START_HOUR = 9;
const CALL_WINDOW_END_HOUR = 18; // exclusive

// Reassigned-number staleness: no customer-initiated contact from the number
// within 90 days ⇒ an RND check is required before any automated voice
// contact (the RND query itself is PR B / manual — here it is only a denial).
const RND_STALENESS_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole ET calendar days between a due value (date column or timestamp) and
// `now` — overdue age is COMPUTED from due_date, never read off a status.
function daysOverdueOn(now, dueValue) {
  const dueStr = etCalendarDayOf(dueValue);
  const nowStr = etDateString(now);
  const [dy, dm, dd] = dueStr.split('-').map(Number);
  const [ny, nm, nd] = nowStr.split('-').map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(dy, dm - 1, dd)) / DAY_MS);
}

function isVoiceLike(channel) {
  return channel === 'voice' || channel === 'manual_call';
}

// Delivered dunning touches for ONE invoice: the per-invoice follow-up
// sequence's touches_sent (only incremented when a channel actually
// delivered) plus the legacy late-payment-checker's activity_log rows (one
// per delivered tier; metadata carries the invoice id).
async function deliveredDunningTouches(invoice) {
  let touches = 0;
  const seq = await db('invoice_followup_sequences')
    .where({ invoice_id: invoice.id })
    .first('touches_sent');
  if (seq) touches += Number(seq.touches_sent) || 0;

  // JSON operator, NOT a ::text LIKE (codex 2026-08-14 r2 P1): activity_log
  // .metadata is JSONB, and Postgres renders JSONB text with a space after
  // each colon ('{"invoiceId": "..."}'), so a '"invoiceId":"..."' substring
  // match never hits — legitimate touches would be ignored and voice cases
  // wrongly denied pilot_insufficient_dunning_history. Parameterized binding
  // (knex.raw eats bare ?s — always the bindings array).
  const [row] = await db('activity_log')
    .where({ action: 'late_payment_reminder' })
    .whereRaw("metadata->>'invoiceId' = ?", [String(invoice.id)])
    .count('* as count');
  touches += parseInt(row?.count || 0, 10);

  // The balance-reminder WORKFLOW's late-payment touches live only in the
  // collections ledger (codex gh-r1) — without this arm, customers it
  // dunned can never satisfy the floor. Source allowlist is exactly the
  // late-payment leg: the checker (activity_log) and followups engine
  // (touches_sent) are already counted above, and the workflow's PAYLINK
  // leg (source balance_reminder_workflow, purpose balance_reminder) is a
  // pre-visit balance nudge, not dunning history — deliberately excluded
  // (codex r2: a purpose filter that silently zeroed a listed source was
  // the bug; the ruling is the source doesn't belong). A ledger ROW is a
  // reservation, not a delivery (codex gh-r2): only rows the rail
  // positively stamped delivered count, and the SMS + email legs of one
  // reminder run share a template_key so a dual-channel run is ONE touch.
  // A missing best-effort stamp under-counts ⇒ voice denied — the safe
  // direction.
  const [led] = await db('collections_contact_ledger')
    .whereRaw('invoice_ids @> ?::jsonb', [JSON.stringify([invoice.id])])
    .whereIn('channel', ['sms', 'email'])
    .where({ purpose: 'late_payment' })
    .whereIn('source', ['balance_reminder_late_payment_check'])
    .whereRaw("metadata->>'delivered' = 'true'")
    .select(db.raw("COUNT(DISTINCT COALESCE(metadata->>'template_key', id::text)) as count"));
  touches += parseInt(led?.count || 0, 10);
  return touches;
}

async function evaluate(customerId, { channel, purpose, now = new Date(), offLedgerBalanceCents = 0 } = {}) {
  const result = {
    allowed: false,
    denialReasons: [],
    eligibleInvoiceIds: [],
    eligibleBalanceCents: 0,
    nextEligibleAt: null,
    consentEvidence: null,
    activeHolds: [],
    recentContacts: [],
  };
  const deny = (reason) => {
    if (!result.denialReasons.includes(reason)) result.denialReasons.push(reason);
  };
  const proposeNextEligible = (at) => {
    if (!at) return;
    const d = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(d.getTime())) return;
    if (!result.nextEligibleAt || d.getTime() > result.nextEligibleAt.getTime()) {
      result.nextEligibleAt = d;
    }
  };

  try {
    if (!CHANNELS.has(channel)) {
      deny('unknown_channel');
      return result;
    }
    if (!KNOWN_PURPOSES_BY_CHANNEL[channel].includes(purpose)) {
      deny('unknown_purpose');
      return result;
    }

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) {
      deny('customer_not_found');
      return result;
    }
    if (customer.deleted_at) {
      deny('customer_archived');
      return result;
    }

    // ── Open-balance eligibility ────────────────────────────────────────
    // Reuse the existing open-balance authority (billing-v2 "Pay now"
    // selection, live payer re-resolution, payer/statement exclusion,
    // cents-positive remainder). Its fail-closed drop policy is inherited
    // deliberately: a row it cannot prove self-pay is not collectible here
    // either.
    // NOTE — deliberately NO stripe_payment_intent_id exclusion here (codex
    // 2026-08-14 ruling): a populated PI on an open invoice is NOT evidence
    // of an in-flight payment. PIs persist after failed, canceled, and
    // abandoned attempts, so excluding on presence would suppress those
    // invoices forever. The actual in-flight marker is invoice status
    // 'processing', which the loader above already excludes (it admits only
    // sent/viewed/overdue), same as paid/void/draft; credit-covered rows
    // fall to its cents test.
    const eligible = await openBalanceInvoices(customerId);
    // Legacy 'unpaid' status (codex r-gh2): the dunning rails
    // (latePaymentCheck/getCustomerBalance) explicitly serve it, but the
    // open-balance loader admits only sent/viewed/overdue — without this
    // arm, a customer whose only debt is a legacy-unpaid invoice is denied
    // no_eligible_balance and loses reminders the moment the gate flips.
    // Same predicates as openInvoiceQuery, same self-pay authority
    // (rowIsSelfPayDue — live payer re-resolution), merged and deduped.
    const legacyUnpaid = await db('invoices')
      .where({ customer_id: customerId, status: 'unpaid' })
      .whereNull('payer_id')
      .whereNull('payer_statement_id')
      .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
      .orderBy('created_at', 'asc')
      .select('*');
    if (legacyUnpaid.length) {
      const { rowIsSelfPayDue } = require('../open-balance');
      const seenIds = new Set(eligible.map((inv) => String(inv.id)));
      for (const row of legacyUnpaid) {
        if (seenIds.has(String(row.id))) continue;
        if (await rowIsSelfPayDue(customerId, row)) eligible.push(row);
      }
    }
    // Admin-stopped dunning sequences (codex r7): 'stopped' is documented
    // as "stop ALL automated dunning for this invoice" — such an invoice
    // can neither back a voice case nor count as dunning-eligible balance.
    // A check error EXCLUDES the invoice (fail closed).
    if (eligible.length) {
      const { isDunningStopped } = require('../invoice-followups');
      const kept = [];
      for (const inv of eligible) {
        try {
          if (!(await isDunningStopped(inv.id))) kept.push(inv);
        } catch { /* excluded — fail closed */ }
      }
      eligible.length = 0;
      eligible.push(...kept);
    }
    result.eligibleInvoiceIds = eligible.map((inv) => inv.id);
    result.eligibleBalanceCents = eligible.reduce(
      (sum, inv) => sum + Math.round(invoiceAmountDue(inv) * 100),
      0,
    );
    // Dues-only carve-out (codex 2026-08-14 P1): the previsit rail
    // legitimately reminds about late MONTHLY-MEMBERSHIP DUES with zero
    // open invoices — dues aren't invoiced until collected. The caller
    // supplies the validated dues amount; it substitutes ONLY for the
    // balance-existence check, ONLY for text/email balance_reminder
    // (call-shaped channels and late_payment purposes still require a real
    // invoice — the voice pilot is invoice-anchored by design). Flags,
    // frequency windows, and every other denial still apply.
    // Off-ledger carve-out: monthly-membership DUES (not invoiced until
    // collected — previsit rail) and a customer-selected PREPAY plan whose
    // invoice is still 'draft' (secure plan selector; codex r7) both carry
    // a validated balance no open invoice represents. Substitutes ONLY for
    // the balance-existence check, ONLY for text/email balance_reminder.
    const offLedgerQualifies = purpose === 'balance_reminder'
      && !isVoiceLike(channel)
      && Number.isFinite(offLedgerBalanceCents) && offLedgerBalanceCents > 0;
    if (!eligible.length && !offLedgerQualifies) deny('no_eligible_balance');

    // ── Hard flags ──────────────────────────────────────────────────────
    const flags = await db('collections_flags')
      .where({ customer_id: customerId })
      .whereNull('released_at')
      .select('*');
    result.activeHolds = flags;
    for (const row of flags) {
      const blocked = FLAG_BLOCKED_CHANNELS[row.flag];
      // Unknown flag string = fail closed on every channel.
      if (!blocked || blocked.includes(channel)) deny(`flag_${row.flag}`);
    }

    // ── Canonical suppression list (codex gh-r1) ────────────────────────
    // messaging_suppression is the application-wide DNC store (STOP
    // keywords, natural-language opt-outs, wrong_number, manual_dnc) and
    // its own doc declares suppression HARD across channels. The new
    // collections_flags table does not replace it — a customer with a
    // canonical DNC and no duplicate flag must still be denied. Phone-keyed
    // (one row per E.164). Mapping: manual_dnc and unknown reasons deny
    // every channel; opt-outs and wrong_number deny the phone-based
    // channels; non_mobile is an SMS-deliverability fact only (voice
    // line-type has its own pilot check). A read failure propagates into
    // evaluate's fail-closed catch.
    if (customer.phone) {
      const { toE164 } = require('../../utils/phone');
      const e164 = toE164(customer.phone) || customer.phone;
      const sup = await db('messaging_suppression')
        .where({ phone: e164, active: true })
        .first('reason');
      if (sup) {
        // The canonical semantics are HARD across every channel (the
        // suppression module's own doc; codex r3 — do not reinterpret
        // them here). The single carve-out is non_mobile: a carrier
        // deliverability fact about SMS, not a consent withdrawal.
        const reason = sup.reason || 'unknown';
        const deniedChannels = reason === 'non_mobile' ? ['sms'] : ALL_CHANNELS;
        if (deniedChannels.includes(channel)) deny(`suppression_${reason}`);
      }
    }

    // ── Rolling frequency windows (collections ledger) ──────────────────
    const windowStart = new Date(now.getTime() - 7 * DAY_MS);
    const recent = await db('collections_contact_ledger')
      .where({ customer_id: customerId })
      .where('occurred_at', '>', windowStart)
      .orderBy('occurred_at', 'desc')
      .select('*');
    // Real phone conversations live in call_log, not the collections
    // ledger (codex gh-r1): a customer who spoke with the office yesterday
    // must hit the same voice-spacing / live-conversation windows as a
    // ledger voice row. Predicate is deliberately generous (over-suppression
    // is the safe direction): completed status, not a voicemail/missed/spam
    // outcome, not machine-answered; NULL outcome/duration rows count. ⭐
    // NULL legs are explicit — bare whereNot skips NULL (SQL three-valued
    // logic, the #2177 voicemail-guard lesson).
    const liveCall = await db('call_log')
      .where({ customer_id: customerId, status: 'completed' })
      .where('created_at', '>', windowStart)
      .whereRaw("(call_outcome IS NULL OR call_outcome NOT IN ('voicemail', 'missed', 'spam'))")
      .whereRaw("(answered_by IS NULL OR answered_by <> 'voicemail')")
      .whereRaw('(duration_seconds IS NULL OR duration_seconds >= 30)')
      .orderBy('created_at', 'desc')
      .first('created_at');
    if (liveCall) {
      recent.push({ channel: 'voice', occurred_at: liveCall.created_at, source: 'call_log' });
      // Keep newest-first after the append (codex r2): find() picks the
      // FIRST qualifying row, and nextEligibleAt is derived from it — an
      // appended newer call behind an older ledger row would propose an
      // eligibility earlier than the real seven-day boundary.
      recent.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
    }
    result.recentContacts = recent;
    const within = (row, ms) => now.getTime() - new Date(row.occurred_at).getTime() < ms;
    // Voice frequency spacing applies to BOTH voice and manual_call (codex
    // 2026-08-14 P1): manual calls COUNT as voice contacts in the ledger, so
    // a dial-sheet consumer evaluating manual_call must not be authorized
    // into a back-to-back call the automated channel would be denied.
    if (isVoiceLike(channel)) {
      const any24h = recent.find((r) => within(r, DAY_MS));
      if (any24h) {
        deny('contact_within_24h');
        proposeNextEligible(new Date(new Date(any24h.occurred_at).getTime() + DAY_MS));
      }
      // A manual call IS a voice contact for spacing purposes.
      const voice7d = recent.find((r) => isVoiceLike(r.channel));
      if (voice7d) {
        deny('voice_contact_within_7d');
        proposeNextEligible(new Date(new Date(voice7d.occurred_at).getTime() + 7 * DAY_MS));
      }
    } else if (channel === 'sms' || channel === 'email') {
      // A live conversation (either direction of a real call) supersedes the
      // automated text/email cadence for a week.
      const live = recent.find((r) => isVoiceLike(r.channel));
      if (live) {
        deny('live_conversation_within_7d');
        proposeNextEligible(new Date(new Date(live.occurred_at).getTime() + 7 * DAY_MS));
      }
    }

    // ── Call-shaped checks (voice AND manual_call) ──────────────────────
    if (isVoiceLike(channel)) {
      // Quiet window: 9:00–17:59 ET, Monday–Friday, via datetime-et (never
      // raw new Date() ET math — the timestamptz trap). Applies to
      // manual_call too (codex 2026-08-14 P1): a dial sheet must not
      // authorize an after-hours collection call just because a human
      // places it.
      const et = etParts(now);
      const weekday = et.dayOfWeek >= 1 && et.dayOfWeek <= 5;
      const inHours = et.hour >= CALL_WINDOW_START_HOUR && et.hour < CALL_WINDOW_END_HOUR;
      if (!weekday || !inHours) deny('outside_call_window');
    }

    // ── Automated-voice-only checks ─────────────────────────────────────
    if (channel === 'voice') {
      if (purpose === 'late_payment') {
        if (eligible.length !== 1) {
          if (eligible.length > 1) deny('pilot_requires_single_invoice');
        } else {
          const invoice = eligible[0];
          if (result.eligibleBalanceCents < PILOT_MIN_BALANCE_CENTS) deny('pilot_balance_below_minimum');
          if (result.eligibleBalanceCents > PILOT_MAX_BALANCE_CENTS) deny('pilot_balance_above_maximum');

          // Overdue age is computed from due_date (created_at fallback — the
          // same reference the late-payment rails use), never status.
          const daysOverdue = daysOverdueOn(now, invoice.due_date || invoice.created_at);
          if (daysOverdue < PILOT_MIN_DAYS_OVERDUE) deny('pilot_not_overdue_long_enough');
          if (daysOverdue > PILOT_MAX_DAYS_OVERDUE) deny('pilot_overdue_too_long');

          const touches = await deliveredDunningTouches(invoice);
          if (touches < PILOT_MIN_DUNNING_TOUCHES) deny('pilot_insufficient_dunning_history');

          // Microdeposit-blocked invoices (codex r5 P1): the customer
          // isn't ignoring the bill — they haven't confirmed their two ACH
          // micro-deposits, and the SMS rails deliberately divert them to
          // verification copy. An automated voice call asking them to PAY
          // would contradict that. Same definitive check the rails use;
          // an error is a denial (fail closed). This denies ONLY the
          // call-shaped pilot — the invoice stays in the eligible set so
          // the SMS rails' membership check still permits their
          // verification re-nudge.
          if (invoice.stripe_payment_intent_id) {
            try {
              const StripeService = require('../stripe');
              const mdPending = await StripeService.isInvoiceAwaitingMicrodepositVerification(invoice);
              if (mdPending) deny('pilot_awaiting_microdeposit_verification');
            } catch (mdErr) {
              logger.warn(`[contact-policy] microdeposit check failed for invoice ${invoice.id}: ${mdErr.message} — denying voice`);
              deny('pilot_awaiting_microdeposit_verification');
            }
          }
        }

        // Mobile line only, from the EXISTING phone-keyed Lookup cache.
        // readCachedLineType is discriminated (hit/miss/error); its own
        // callers fail OPEN for cheap SMS, but an outbound voice policy
        // fails CLOSED: miss and error are both denials.
        const { readCachedLineType } = require('../messaging/validators/line-type');
        const lineType = await readCachedLineType(customer.phone);
        if (lineType.state !== 'hit') deny('line_type_unknown');
        else if (lineType.lineType !== 'mobile') deny('line_type_not_mobile');

        // Residential only in the pilot. 'commercial' AND 'business' — the
        // two values every billing authority treats as commercial
        // (invoice.js, tax-calculator.js, invoice-pdf.js,
        // secure-appointment-plans.js all check exactly this pair).
        // DELIBERATELY NOT fail-closed on NULL/unrecognized: property_type
        // is ~NULL across prod (commercial-taxability lane, 2026-08-09), so
        // a strict unknown⇒deny would zero out the pilot. NULL/unknown =
        // residential-presumed FOR THIS PILOT ONLY — revisit once
        // property_type is actually populated.
        if (['commercial', 'business'].includes(String(customer.property_type || '').toLowerCase())) {
          deny('commercial_customer');
        }
      }

      // Consent provenance — required for ANY automated voice purpose.
      const evidence = await ConsentProvenance.resolve(customerId, customer.phone);
      result.consentEvidence = evidence;
      if (!evidence) deny('consent_no_evidence');

      // Reassigned-number staleness: >90 days without customer-initiated
      // contact (or none ever) requires an RND check before dialing.
      const freshAt = await ConsentProvenance.freshness(customerId, customer.phone);
      const staleness = freshAt ? now.getTime() - freshAt.getTime() : Infinity;
      if (staleness > RND_STALENESS_DAYS * DAY_MS) deny('rnd_check_required');
    }

    result.allowed = result.denialReasons.length === 0;
    return result;
  } catch (err) {
    logger.error(`[contact-policy] evaluation failed for customer ${customerId}: ${err.message}`);
    // FAIL CLOSED — an error is never "allowed".
    result.allowed = false;
    deny('policy_evaluation_error');
    return result;
  }
}

module.exports = {
  evaluate,
  // Exported for tests / PR B reuse.
  PILOT_MIN_BALANCE_CENTS,
  PILOT_MAX_BALANCE_CENTS,
  PILOT_MIN_DAYS_OVERDUE,
  PILOT_MAX_DAYS_OVERDUE,
  PILOT_MIN_DUNNING_TOUCHES,
  RND_STALENESS_DAYS,
  FLAG_BLOCKED_CHANNELS,
};
