/**
 * Inbound referral confirm (GATE_REFERRAL_INBOUND_CONFIRM, owner 2026-10-26
 * "YES GO").
 *
 * The program pays $25 to each side after a referred customer's first recurring
 * service (referral-engine creditReferralOnFirstService), but only a referral
 * row starts that path, and nothing makes one for a friend who comes in on
 * their own: the referral link only leaves ?ref=CODE on the customer's landing
 * page URL, and a caller's "Jane sent me" only becomes the customer's
 * lead_source_detail ("Referred by Jane", call-recording-processor). The
 * office's "Add referral" (submitReferral) refuses anyone who already has a
 * customer row, and every intake path makes one at first contact.
 *
 * This module lists those customers once they are on a WaveGuard plan (so
 * every card can pay) and lets the office confirm the referrer or mark the
 * customer "not a referral". Listing, confirming and dismissing send nothing:
 *  - confirm makes the referral row with the referrer the office chose and
 *    runs the existing conversion (convertReferral stages the reward until the
 *    first recurring service). That step keeps its own messages: the
 *    milestone text at 3, 5 and 10 conversions, and the reward text and email
 *    only when require_service_completion is off (it is on);
 *  - when a performed recurring visit is already on record, the existing
 *    first-service credit runs at once with notify:false, so both $25 credits
 *    post with no text or email; otherwise the completion flow credits at the
 *    next performed recurring visit, as today.
 */
const db = require('../models/db');
const logger = require('./logger');
const engine = require('./referral-engine');
const { isMembershipTier } = require('./billing-lane');
const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');
const { isPromoterPhoneCollision } = require('./referral-errors');
const { toE164, isLikelyE164, phoneMatchDigits } = require('../utils/phone');

// A completed visit whose closeout performed no service (complete-scheduled-service.js
// referralVisitPerformed; the same list paf-prepay-release.js reads back).
const NOT_PERFORMED_OUTCOMES = ['inspection_only', 'customer_declined', 'incomplete'];
const LIST_LIMIT = 50;
const SUGGESTION_LIMIT = 5;
// Same shape the /r/:code route accepts (routes/referral-links.js CODE_RE).
const CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;
const SPOKEN_NAME_RE = /^Referred by\s+(.+)$/i;
const UNNAMED_RE = /^Referral \(unnamed\)/i;

function inboundError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizePhone(phone) {
  const normalized = toE164(phone);
  return isLikelyE164(normalized) ? normalized : null;
}

function fullName(c) {
  return [c.first_name, c.last_name].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
}

function onPlan(c) {
  return c.active !== false && isMembershipTier(c.waveguard_tier) && Number(c.monthly_rate) > 0;
}

// The ref code on the landing page URL the website forwarded at intake.
function codeFromLanding(url) {
  try {
    const code = new URL(String(url || '').trim()).searchParams.get('ref');
    return code && CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

// What the customer row says about a referral, or null when it says nothing.
// A link code wins over a spoken name: the code names the referrer.
function evidenceFor(customer) {
  const code = codeFromLanding(customer.landing_page_url);
  if (code) return { source: 'link', code, spokenName: null };
  const detail = String(customer.lead_source_detail || '').trim();
  const named = detail.match(SPOKEN_NAME_RE);
  if (named) return { source: 'call', code: null, spokenName: named[1].trim().slice(0, 100) };
  if (UNNAMED_RE.test(detail)) return { source: 'call', code: null, spokenName: null };
  return null;
}

// Two customer rows are one household when they are the same row or share an
// account, a phone or an email (submitReferral's self-referral rule checks
// phone and email too). A household never refers itself.
function sameHousehold(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.account_id && a.account_id === b.account_id) return true;
  const email = String(a.email || '').trim().toLowerCase();
  if (email && email === String(b.email || '').trim().toLowerCase()) return true;
  const pa = phoneMatchDigits(normalizePhone(a.phone) || '');
  const pb = new Set(phoneMatchDigits(normalizePhone(b.phone) || ''));
  return pa.some((d) => pb.has(d));
}

function digitsInSql(column, variants) {
  return [`regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g') IN (${variants.map(() => '?').join(',')})`, variants];
}

const CUSTOMER_COLUMNS = [
  'id', 'first_name', 'last_name', 'phone', 'email', 'account_id', 'city', 'active',
  'monthly_rate', 'waveguard_tier', 'landing_page_url', 'lead_source_detail', 'created_at',
];

// The customer a referral code belongs to: the active promoter that owns it
// (a merged-away promoter's code follows merged_into_promoter_id, as the /r/
// route does), else the customer whose own referral_code it is (the Refer
// tab's share link). null when nobody holds it.
async function customerForCode(code, conn = db) {
  let promoter = await conn('referral_promoters').where({ referral_code: code, status: 'active' }).first('customer_id');
  if (!promoter) {
    const alias = await conn('referral_promoters')
      .where({ referral_code: code, status: 'merged' })
      .whereNotNull('merged_into_promoter_id')
      .first('merged_into_promoter_id');
    if (alias) {
      promoter = await conn('referral_promoters')
        .where({ id: alias.merged_into_promoter_id, status: 'active' })
        .first('customer_id');
    }
  }
  const query = conn('customers').whereNull('deleted_at');
  if (promoter?.customer_id) return query.where({ id: promoter.customer_id }).first(CUSTOMER_COLUMNS);
  if (promoter) return null;
  return query.where({ referral_code: code }).first(CUSTOMER_COLUMNS);
}

// Likely referrers for a spoken name. Two or more words: the same last name,
// exact first + last first. One word: that first or last name. Never the
// referred customer's own household.
async function customersForSpokenName(spokenName, referee, conn = db) {
  const words = String(spokenName || '')
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return [];
  const first = words[0];
  const last = words[words.length - 1];
  const rows = await conn('customers')
    .whereNull('deleted_at')
    .whereNot('id', referee.id)
    .where(function matchName() {
      if (words.length >= 2) this.whereRaw('LOWER(last_name) = ?', [last]);
      else this.whereRaw('LOWER(first_name) = ?', [first]).orWhereRaw('LOWER(last_name) = ?', [first]);
    })
    .orderByRaw('(LOWER(first_name) = ?) DESC', [first])
    .orderByRaw('(active AND monthly_rate > 0) DESC NULLS LAST')
    .orderBy('created_at', 'asc')
    .limit(SUGGESTION_LIMIT * 2)
    .select(CUSTOMER_COLUMNS);
  return rows
    .filter((m) => !sameHousehold(m, referee))
    .slice(0, SUGGESTION_LIMIT)
    .map((m) => ({ match: m, exact: words.length >= 2 && String(m.first_name || '').toLowerCase() === first }));
}

// Recurring visits that earn the reward, read from the visit's current closeout record: completed
// and performed, and not a quiet backfill, except an issued-invoice closeout (its invoice proves
// the service). The completion flow's own rule before it calls creditReferralOnFirstService, which
// checks only that the visit recurs.
function performedRecurringVisits(conn) {
  return conn('scheduled_services as ss')
    .where('ss.status', 'completed')
    .where(function recurring() { this.where('ss.is_recurring', true).orWhereNotNull('ss.recurring_pattern'); })
    .whereRaw(`EXISTS (
      SELECT 1 FROM service_records r
      WHERE r.id = (
        SELECT r2.id FROM service_records r2
        WHERE r2.scheduled_service_id = ss.id
        ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1
      )
        AND r.status = 'completed'
        AND COALESCE(r.structured_notes ->> 'visitOutcome', '') <> ALL(?::text[])
        AND (COALESCE(r.structured_notes ->> 'backfill', '') <> 'true'
          OR (r.structured_notes -> 'issuedInvoiceCloseout') IS NOT NULL)
    )`, [NOT_PERFORMED_OUTCOMES]);
}

function suggestionView(c, extra = {}) {
  return {
    customerId: c.id,
    name: fullName(c),
    city: c.city || null,
    phone: c.phone || null,
    onPlan: onPlan(c),
    ...extra,
  };
}

/**
 * Plan customers with referral evidence and no referral row or office answer
 * yet, newest first. Each item carries the evidence and the likely referrers.
 */
async function listInboundReferrals(conn = db) {
  const rows = await conn('customers as c')
    .whereNull('c.deleted_at')
    .where('c.active', true)
    .where('c.monthly_rate', '>', 0)
    .where(function evidence() {
      this.whereILike('c.landing_page_url', '%ref=%')
        .orWhereILike('c.lead_source_detail', 'Referred by %')
        .orWhereILike('c.lead_source_detail', 'Referral (unnamed)%');
    })
    .whereNotExists(conn('referral_inbound_reviews as v').whereRaw('v.customer_id = c.id').select(conn.raw('1')))
    .modify((qb) => {
      if (INTERNAL_TEST_CUSTOMERS.length) {
        qb.whereNotIn(conn.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"), INTERNAL_TEST_CUSTOMERS);
      }
    })
    .orderBy('c.created_at', 'desc')
    .select(CUSTOMER_COLUMNS.map((col) => `c.${col}`));

  const candidates = rows
    .map((c) => ({ customer: c, evidence: evidenceFor(c), digits: phoneMatchDigits(normalizePhone(c.phone) || '') }))
    // A referral pays by the referee's phone (creditReferralOnFirstService).
    .filter((x) => x.evidence && x.digits.length && onPlan(x.customer));
  if (!candidates.length) return [];

  // Drop anyone a referral row already names, by phone digits (the engine's
  // own match key), whatever that row's status.
  const [sql, bindings] = digitsInSql('referee_phone', [...new Set(candidates.flatMap((x) => x.digits))]);
  const referred = new Set((await conn('referrals').whereRaw(sql, bindings)
    .select(conn.raw("regexp_replace(COALESCE(referee_phone, ''), '[^0-9]', '', 'g') AS digits")))
    .map((r) => r.digits));
  const open = candidates
    .filter((x) => !x.digits.some((d) => referred.has(d)))
    .slice(0, LIST_LIMIT);
  if (!open.length) return [];

  const served = new Set((await performedRecurringVisits(conn)
    .whereIn('ss.customer_id', open.map((x) => x.customer.id))
    .distinct('ss.customer_id'))
    .map((r) => r.customer_id));

  const items = [];
  for (const { customer, evidence } of open) {
    let suggestions = [];
    let selfReferral = false;
    if (evidence.source === 'link') {
      const owner = await customerForCode(evidence.code, conn);
      if (owner && sameHousehold(owner, customer)) selfReferral = true;
      else if (owner) suggestions = [suggestionView(owner, { exact: true, viaCode: true })];
    } else if (evidence.spokenName) {
      suggestions = (await customersForSpokenName(evidence.spokenName, customer, conn))
        .map(({ match, exact }) => suggestionView(match, { exact, viaCode: false }));
    }
    items.push({
      customerId: customer.id,
      name: fullName(customer),
      phone: customer.phone,
      city: customer.city || null,
      createdAt: customer.created_at,
      plan: { tier: customer.waveguard_tier, monthlyRate: Number(customer.monthly_rate) },
      creditsNow: served.has(customer.id),
      evidence,
      selfReferral,
      suggestions,
    });
  }
  return items;
}

/**
 * The office confirms `referrerCustomerId` as the person who referred
 * `customerId`. Makes the referral row, converts it, and posts both credits
 * now (quietly) when a performed recurring visit is on record.
 */
async function confirmInboundReferral({ customerId, referrerCustomerId, reviewedBy = null }) {
  const referee = await db('customers').where({ id: customerId }).whereNull('deleted_at').first(CUSTOMER_COLUMNS);
  if (!referee) throw inboundError(404, 'NOT_FOUND', 'Customer not found');
  const evidence = evidenceFor(referee);
  if (!evidence) throw inboundError(409, 'NO_REFERRAL_EVIDENCE', 'This customer did not come in through a referral link or name a referrer');
  if (!onPlan(referee)) throw inboundError(409, 'NOT_ON_PLAN', 'This customer is not on a WaveGuard plan');
  const refereePhone = normalizePhone(referee.phone);
  const variants = phoneMatchDigits(refereePhone || '');
  if (!variants.length) throw inboundError(409, 'NO_PHONE', 'This customer has no valid phone number, so the referral cannot pay');

  const referrer = await db('customers').where({ id: referrerCustomerId }).whereNull('deleted_at').first(CUSTOMER_COLUMNS);
  if (!referrer) throw inboundError(404, 'REFERRER_NOT_FOUND', 'Referrer not found');
  if (sameHousehold(referrer, referee)) throw inboundError(400, 'SELF_REFERRAL', 'A customer cannot refer their own household');

  // Enroll (or resolve the household promoter of) the referrer. Idempotent,
  // sends nothing; a confirm refused below leaves only a normal enrollment.
  let promoter;
  try {
    ({ promoter } = await engine.resolvePromoter(referrer.id));
  } catch (err) {
    // Another account's promoter holds the referrer's phone: staff must link
    // it first (routes/referrals.js answers the same case with 409).
    if (isPromoterPhoneCollision(err)) {
      throw inboundError(409, 'REFERRER_PHONE_IN_USE', "The referrer's phone belongs to another account's referral enrollment");
    }
    throw err;
  }
  const settings = await engine.getSettings();

  const referral = await db.transaction(async (trx) => {
    // One answer per customer: the row lock serializes a double tap and a
    // confirm racing a dismissal.
    await trx('customers').where({ id: referee.id }).forUpdate().first('id');
    if (await trx('referral_inbound_reviews').where({ customer_id: referee.id }).first('id')) {
      throw inboundError(409, 'ALREADY_REVIEWED', 'This customer was already confirmed or dismissed');
    }
    const [sql, bindings] = digitsInSql('referee_phone', variants);
    if (await trx('referrals').whereRaw(sql, bindings).first('id')) {
      throw inboundError(409, 'ALREADY_REFERRED', 'A referral already names this customer');
    }
    const [row] = await trx('referrals').insert({
      referrer_customer_id: promoter.customer_id,
      referee_name: (fullName(referee) || 'Friend').slice(0, 100),
      referee_phone: refereePhone,
      referee_email: referee.email ? String(referee.email).trim().slice(0, 150) : null,
      referral_code: promoter.referral_code,
      status: 'pending',
      source: evidence.source === 'link' ? 'inbound_link' : 'inbound_call',
      promoter_id: promoter.id,
      referrer_reward_amount: settings.referrer_reward_cents / 100,
      referrer_reward_status: 'pending',
    }).returning('*');
    await trx('referral_promoters').where({ id: promoter.id })
      .increment({ total_referrals_sent: 1 })
      .update({ last_referral_at: new Date(), updated_at: new Date() });
    await trx('referral_inbound_reviews').insert({
      customer_id: referee.id,
      outcome: 'confirmed',
      referral_id: row.id,
      reviewed_by: reviewedBy,
    });
    return row;
  });

  // Post-commit, the existing steps. Each is idempotent and re-checks its own
  // guards under a row lock, so a failure here leaves a pending referral the
  // queue's Convert button can finish.
  const result = { referralId: referral.id, converted: false, creditsNow: false, credited: null, error: null };
  try {
    const conversion = await engine.convertReferral(referral.id, {
      customerId: referee.id,
      tier: referee.waveguard_tier,
      monthlyValue: Number(referee.monthly_rate) || null,
    });
    result.converted = !conversion.alreadyConverted;
  } catch (err) {
    logger.warn(`[referral-inbound] convert failed for referral ${referral.id}: ${err.code || err.message}`);
    result.error = 'convert_failed';
    return result;
  }

  const firstVisit = await performedRecurringVisits(db)
    .where('ss.customer_id', referee.id)
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.id', 'asc')
    .first('ss.id');
  result.creditsNow = Boolean(firstVisit);
  if (firstVisit && settings.require_service_completion) {
    try {
      const credit = await engine.creditReferralOnFirstService({ customerId: referee.id, serviceId: firstVisit.id, notify: false });
      result.credited = credit ? { referrerDollars: credit.referrerDollars, refereeDollars: credit.refereeDollars } : null;
    } catch (err) {
      logger.warn(`[referral-inbound] credit failed for referral ${referral.id}: ${err.code || err.message}`);
      result.error = 'credit_failed';
    }
  }
  logger.info(`[referral-inbound] referral ${referral.id} confirmed (${evidence.source}); converted=${result.converted} credited=${Boolean(result.credited)}`);
  return result;
}

// The office says this customer was not referred (or the referrer cannot be
// found). The customer leaves the list for good.
async function dismissInboundReferral({ customerId, reviewedBy = null }) {
  return db.transaction(async (trx) => {
    const referee = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first('id');
    if (!referee) throw inboundError(404, 'NOT_FOUND', 'Customer not found');
    if (await trx('referral_inbound_reviews').where({ customer_id: customerId }).first('id')) {
      throw inboundError(409, 'ALREADY_REVIEWED', 'This customer was already confirmed or dismissed');
    }
    await trx('referral_inbound_reviews').insert({ customer_id: customerId, outcome: 'dismissed', reviewed_by: reviewedBy });
    return { customerId, dismissed: true };
  });
}

module.exports = {
  listInboundReferrals,
  confirmInboundReferral,
  dismissInboundReferral,
};
