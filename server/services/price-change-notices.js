/**
 * Price-change notice workflow (owner policy 2026-07-12).
 *
 * Not a renewal system: Waves' recurring service has no fixed term, so the
 * only communication that matters is CLEAR ADVANCE NOTICE when the price
 * changes. One batch = one operator-confirmed change event:
 *
 *   preview  → live list of affected recurring payers with current → new
 *              price per customer (percent or flat-dollar adjustment on
 *              monthly_rate);
 *   confirm  → per-customer notice rows (tokened page), short email
 *              (billing.price_change_notice, transactional_required stream —
 *              a billing-terms notice must always deliver) + SMS, both
 *              linking to /price-change/:token; delivery flags + activity
 *              log retained.
 *
 * Policy encoded: the effective date must be at least 30 days out (owner:
 * a price change never first appears on a charge). The workflow does NOT
 * apply the new rate — monthly_rate changes stay a deliberate, separate
 * admin action.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { CITY_TO_LOCATION } = require('../config/locations');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const SERVICE_EMAIL = 'contact@wavespestcontrol.com';
const NOTICE_LOCATIONS = new Set(['bradenton', 'parrish', 'sarasota', 'venice']);
const MIN_NOTICE_DAYS = 30;
const BATCH_CAP = 2000;
const SEND_CONCURRENCY = 10;
// A 'sending' row older than this is a crashed attempt, safe to reclaim.
const CLAIM_STALE_MS = 15 * 60 * 1000;

function formatMoney(cents) {
  const n = Number(cents || 0) / 100;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

// Targets: exactly the population the monthly billing cron charges — its
// selection predicate (active, monthly_rate > 0, not paused, not deleted;
// billing-cron.js) plus its GUARD 3b billing-mode skip. NOT the pipeline
// -stage whereLiveCustomer helper: booked customers can legitimately sit in
// earlier stages and would then be charged the new rate while absent from
// both preview and send. If the cron's eligibility changes, change this too.
// Location scoping mirrors the segment-send rules: stored office first, city
// routing for null-location rows, Bradenton as the default bucket.
function targetsQuery({ locationId = null, excludeCustomerIds = [] } = {}) {
  let q = db('customers')
    .where({ active: true })
    .where('monthly_rate', '>', 0)
    .whereNull('service_paused_at')
    .whereNull('deleted_at')
    // per_application and annual_prepay customers are skipped by the
    // monthly billing cron even when a monthly_rate is on file, so a
    // "per month" price notice would misstate their billing.
    .where(function monthlyBilledOnly() {
      this.whereNull('billing_mode').orWhereNotIn('billing_mode', ['per_application', 'annual_prepay']);
    });
  if (excludeCustomerIds.length) q = q.whereNotIn('id', excludeCustomerIds);
  if (locationId) {
    q = q.where(function locationMatch() {
      this.where('nearest_location_id', locationId)
        .orWhere(function cityFallback() {
          this.whereNull('nearest_location_id');
          if (locationId === 'bradenton') {
            const otherCities = Object.entries(CITY_TO_LOCATION)
              .filter(([, locId]) => locId !== 'bradenton')
              .map(([city]) => city);
            this.whereRaw("LOWER(TRIM(COALESCE(city, ''))) <> ALL(?)", [otherCities]);
          } else {
            const ownCities = Object.entries(CITY_TO_LOCATION)
              .filter(([, locId]) => locId === locationId)
              .map(([city]) => city);
            this.whereRaw("LOWER(TRIM(COALESCE(city, ''))) = ANY(?)", [ownCities]);
          }
        });
    });
  }
  return q;
}

// The billing cron also suppresses monthly charges for customers whose
// annual-prepay TERM is active or payment-pending, regardless of
// billing_mode (pre-existing terms were never billing_mode-backfilled).
// Those customers must not get a "per month" notice either.
async function annualPrepayExcludedIds() {
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const [covered, pending] = await Promise.all([
    AnnualPrepayRenewals.getActivelyCoveredCustomerIds(etDateString()),
    AnnualPrepayRenewals.getPaymentPendingCustomerIds(),
  ]);
  return [...new Set([...(covered || []), ...(pending || [])])];
}

function parseIncrease(increase) {
  const type = String(increase?.type || '');
  const value = Number(increase?.value);
  if (!['percent', 'amount'].includes(type)) throw badInput('increase.type must be percent or amount');
  if (!Number.isFinite(value) || value === 0) throw badInput('increase.value must be a non-zero number');
  if (type === 'percent' && (value <= -100 || value > 100)) throw badInput('increase.value percent must be between -100 and 100');
  if (type === 'amount' && Math.abs(value) > 500) throw badInput('increase.value dollars must be within ±$500');
  return { type, value };
}

function parseLocation(locationId) {
  const loc = locationId ? String(locationId) : null;
  if (loc && !NOTICE_LOCATIONS.has(loc)) throw badInput('locationId is not a known location');
  return loc;
}

function badInput(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function computeNewCents(currentCents, increase) {
  const next = increase.type === 'percent'
    ? Math.round(currentCents * (1 + increase.value / 100))
    : currentCents + Math.round(increase.value * 100);
  return next;
}

function noticeRowsFor(customers, increase) {
  return customers.map((c) => {
    const currentCents = Math.round(Number(c.monthly_rate || 0) * 100);
    return {
      customerId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unnamed customer',
      currentCents,
      newCents: computeNewCents(currentCents, increase),
      hasEmail: !!String(c.email || '').trim(),
      hasPhone: !!String(c.phone || '').trim(),
    };
  });
}

// Digest of the exact reviewed set — who gets a notice and at what amounts.
// Sorted by customer id so preview (name order) and send (id order) agree.
// The send endpoint refuses when this changes, so same-count membership or
// amount drift between Preview and Send can never ship an unreviewed list.
function previewDigest(rows) {
  const h = crypto.createHash('sha256');
  const sorted = [...rows].sort((a, b) => String(a.customerId).localeCompare(String(b.customerId)));
  for (const r of sorted) h.update(`${r.customerId}:${r.currentCents}:${r.newCents}\n`);
  return h.digest('hex');
}

async function previewPriceChange({ locationId = null, increase } = {}) {
  const inc = parseIncrease(increase);
  const loc = parseLocation(locationId);
  const excludeCustomerIds = await annualPrepayExcludedIds();
  const customers = await targetsQuery({ locationId: loc, excludeCustomerIds })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'monthly_rate')
    .orderBy('last_name', 'asc')
    .orderBy('first_name', 'asc');
  const rows = noticeRowsFor(customers, inc);
  const invalid = rows.filter((r) => r.newCents <= 0);
  return {
    digest: previewDigest(rows),
    rows: rows.map((r) => ({
      customerId: r.customerId,
      name: r.name,
      current: formatMoney(r.currentCents),
      next: formatMoney(r.newCents),
      hasEmail: r.hasEmail,
      hasPhone: r.hasPhone,
    })),
    count: rows.length,
    cap: BATCH_CAP,
    overCap: rows.length > BATCH_CAP,
    invalidCount: invalid.length,
    minNoticeDays: MIN_NOTICE_DAYS,
  };
}

function validateEffectiveDate(effectiveDate) {
  const dateStr = String(effectiveDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw badInput('effectiveDate must be YYYY-MM-DD');
  const minDate = etDateString(addETDays(new Date(), MIN_NOTICE_DAYS));
  if (dateStr < minDate) {
    throw badInput(`Policy: the effective date must be at least ${MIN_NOTICE_DAYS} days out (earliest allowed: ${minDate}). A price change never first appears on a charge.`);
  }
  return dateStr;
}

// Returns { sent, attempted }. attempted=true means a real recipient was
// resolved (primary OR billing contact via getInvoiceEmailRecipients) and
// the failure was at the provider/template layer — that is the retryable
// class. A suppression BLOCK (library refuses pre-provider: global bounce
// / do-not-email; the library already fires the office "collect a working
// address" alert) returns attempted=false: rerunning cannot fix it, only
// a corrected address can — and because the idempotency key includes the
// resolved recipient, a corrected address mints a fresh key and sends,
// while same-address retries keep deduping against the prior attempt.
async function sendNoticeEmail({ customer, idempotencyKeyBase, vars }) {
  let attempted = false;
  try {
    const EmailTemplateLibrary = require('./email-template-library');
    const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
    const [recipient] = getInvoiceEmailRecipients(customer, prefs || {});
    const to = String(recipient?.email || '').trim();
    if (!to || !to.includes('@')) return { sent: false, attempted: false };
    attempted = true;
    const recipientHash = crypto.createHash('sha256').update(to.toLowerCase()).digest('hex').slice(0, 10);
    const firstName = String(recipient?.name || customer.first_name || '').trim().split(/\s+/)[0] || 'there';
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'billing.price_change_notice',
      to,
      recipientType: 'customer',
      recipientId: customer.id,
      // Required billing-terms notice: transactional_required is the only
      // stream the library exempts from group unsubscribes — an optional
      // -stream suppression must not block a customer's advance notice
      // (global bounce suppression still blocks, correctly).
      suppressionGroupKey: 'transactional_required',
      categories: ['billing', 'price_change_notice'],
      idempotencyKey: `${idempotencyKeyBase}:${recipientHash}`,
      suppressProviderErrorLog: true,
      payload: {
        ...vars,
        first_name: firstName,
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: SERVICE_EMAIL,
      },
    });
    if (result?.blocked) return { sent: false, attempted: false };
    return { sent: !!result?.sent, attempted };
  } catch (err) {
    logger.error(`[price-change] email failed for customer ${customer.id} (${err?.name || 'Error'})`);
    return { sent: false, attempted };
  }
}

// Same { sent, attempted } contract as the email leg — a phone on file
// with a template/provider failure is retryable, no phone is not.
async function sendNoticeSms({ customer, vars, actorId, hasEmailLeg }) {
  let attempted = false;
  try {
    const { renderSmsTemplate } = require('./sms-template-renderer');
    const { sendCustomerMessage } = require('./messaging/send-customer-message');
    const phone = String(customer.phone || '').trim();
    if (!phone) return { sent: false, attempted: false };
    attempted = true;
    const firstName = String(customer.first_name || '').trim().split(/\s+/)[0] || 'there';
    const body = await renderSmsTemplate('price_change_notice', {
      first_name: firstName,
      effective_date: vars.effective_date,
      price_change_url: vars.price_change_url,
    }, { workflow: 'price_change_notice', entity_type: 'customer', entity_id: customer.id });
    if (!body) return { sent: false, attempted };
    const res = await sendCustomerMessage({
      to: phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'billing',
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      // Declares the paired email leg so the billing channel-preference gate
      // can suppress the SMS for email-preferring customers without
      // silencing SMS-only ones (policy.js 'opt_in' channelGate contract).
      hasEmailLeg: !!hasEmailLeg,
      metadata: { original_message_type: 'price_change_notice', adminUserId: actorId || undefined },
    });
    // A policy block (sms_enabled=false, STOP suppression, billing pref)
    // is not a provider failure — rerunning cannot deliver it, so it must
    // not hold the notice in the retryable class forever.
    if (res.blocked) return { sent: false, attempted: false };
    return { sent: !!res.sent, attempted };
  } catch (err) {
    logger.error(`[price-change] SMS failed for customer ${customer.id}: ${err.message}`);
    return { sent: false, attempted };
  }
}

async function createAndSendBatch({ locationId = null, increase, effectiveDate, cadenceLabel = 'month', expectedCount, expectedDigest = null, actorId = null } = {}) {
  const inc = parseIncrease(increase);
  const loc = parseLocation(locationId);
  const effective = validateEffectiveDate(effectiveDate);
  const cadence = String(cadenceLabel || 'month').slice(0, 40);

  const excludeCustomerIds = await annualPrepayExcludedIds();
  const customers = await targetsQuery({ locationId: loc, excludeCustomerIds })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'monthly_rate')
    .orderBy('id', 'asc');

  if (customers.length !== Number(expectedCount)) {
    return { ok: false, reason: 'count_drift', count: customers.length };
  }
  if (customers.length === 0) return { ok: false, reason: 'empty' };
  if (customers.length > BATCH_CAP) return { ok: false, reason: 'over_cap', count: customers.length };

  const rows = noticeRowsFor(customers, inc);
  // The count can stay identical while one customer enters and another
  // leaves the segment (or an amount changes) between Preview and Send —
  // the digest pins the exact reviewed membership + amounts.
  if (String(expectedDigest || '') !== previewDigest(rows)) {
    return { ok: false, reason: 'list_changed', count: customers.length };
  }
  if (rows.some((r) => r.newCents <= 0)) {
    return { ok: false, reason: 'invalid_amounts' };
  }

  const batchId = crypto.randomUUID();
  const effectiveLabel = formatDisplayDate(effective, { fallback: effective });
  const byId = new Map(customers.map((c) => [c.id, c]));
  const summary = { created: 0, emailed: 0, texted: 0, unreachable: 0, alreadyNotified: 0, failed: 0 };

  for (let i = 0; i < rows.length; i += SEND_CONCURRENCY) {
    const batch = rows.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      try {
        // Retry idempotency: the change EVENT for a customer is identified
        // by (customer, effective date, current → new amount), not by
        // batch_id — a re-run of the same confirmed change after a partial
        // failure must not re-notice customers who already got theirs.
        const existing = await db('price_change_notices')
          .where({
            customer_id: row.customerId,
            effective_date: effective,
            current_amount_cents: row.currentCents,
            new_amount_cents: row.newCents,
          })
          .orderBy('created_at', 'desc')
          .first();
        if (existing && ['sent', 'viewed'].includes(existing.status)) {
          summary.alreadyNotified += 1;
          return;
        }

        let notice = existing;
        let token = existing ? existing.notice_token : null;
        if (!notice) {
          token = crypto.randomBytes(16).toString('hex');
          // onConflict on the event tuple (unique index): if a concurrent
          // /send won the insert race between our lookup and here, we get
          // nothing back — the winner is already sending, so skip rather
          // than double-text the customer.
          const inserted = await db('price_change_notices').insert({
            batch_id: batchId,
            customer_id: row.customerId,
            current_amount_cents: row.currentCents,
            new_amount_cents: row.newCents,
            cadence_label: cadence,
            effective_date: effective,
            notice_token: token,
            status: 'draft',
            created_by: actorId || null,
            metadata: JSON.stringify({ increase: inc, location_id: loc }),
          }).onConflict(['customer_id', 'effective_date', 'current_amount_cents', 'new_amount_cents']).ignore().returning('*');
          if (!inserted.length) {
            summary.alreadyNotified += 1;
            return;
          }
          notice = inserted[0];
          summary.created += 1;
        }

        // Atomically claim the row for this attempt (draft → sending): two
        // admins retrying the same change can both pass the lookup above,
        // and the SMS leg has no provider idempotency key, so only the
        // claim winner may send. A crash mid-send leaves 'sending', which
        // becomes reclaimable once stale.
        const claimed = await db('price_change_notices')
          .where({ id: notice.id })
          .where(function claimable() {
            // 'unreachable' stays claimable: if the office later adds a
            // phone/email or clears a block, rerunning the same change
            // re-attempts delivery instead of skipping the customer.
            this.whereIn('status', ['draft', 'unreachable'])
              .orWhere(function staleSending() {
                this.where({ status: 'sending' })
                  .where('updated_at', '<', new Date(Date.now() - CLAIM_STALE_MS));
              });
          })
          .update({ status: 'sending', updated_at: new Date() });
        if (!claimed) {
          summary.alreadyNotified += 1;
          return;
        }

        const customer = byId.get(row.customerId);
        const vars = {
          current_price: formatMoney(row.currentCents),
          new_price: formatMoney(row.newCents),
          effective_date: effectiveLabel,
          cadence_label: cadence,
          price_change_url: portalUrl(`/price-change/${token}`),
        };
        // Keyed to the change event (stable across retry batches) so the
        // email library dedupes even if a crash left the row in 'draft'
        // after the email went out; the email leg appends a hash of the
        // resolved recipient so a corrected address sends fresh.
        const idempotencyKeyBase = `price_change:${row.customerId}:${effective}:${row.currentCents}:${row.newCents}`;
        const email = await sendNoticeEmail({ customer, idempotencyKeyBase, vars });
        const sms = await sendNoticeSms({ customer, vars, actorId, hasEmailLeg: email.sent });
        if (email.sent) summary.emailed += 1;
        if (sms.sent) summary.texted += 1;

        if (!email.sent && !sms.sent) {
          if (email.attempted || sms.attempted) {
            // A resolvable recipient (incl. billing-contact email) with
            // zero delivered legs is a provider or template failure —
            // release the claim back to 'draft' so a retry of the same
            // change resumes it instead of skipping a customer who never
            // got their advance notice.
            summary.failed += 1;
            await db('price_change_notices').where({ id: notice.id }).update({ status: 'draft', updated_at: new Date() });
          } else {
            // No contact at all, or every leg policy-blocked (bounce
            // suppression, STOP). NOT 'sent' — the row stays claimable so
            // adding contact info and rerunning the same change delivers;
            // until then it surfaces in the unreachable count for office
            // follow-up.
            summary.unreachable += 1;
            await db('price_change_notices').where({ id: notice.id }).update({ status: 'unreachable', updated_at: new Date() });
          }
          return;
        }

        await db('price_change_notices').where({ id: notice.id }).update({
          email_sent: email.sent,
          sms_sent: sms.sent,
          status: 'sent',
          sent_at: new Date(),
          updated_at: new Date(),
        });
      } catch (err) {
        summary.failed += 1;
        logger.error(`[price-change] notice failed for customer ${row.customerId}: ${err.message}`);
      }
    }));
  }

  try {
    await db('activity_log').insert({
      admin_user_id: actorId || null,
      action: 'price_change_batch_sent',
      description: `Price-change notices (${inc.type === 'percent' ? `${inc.value}%` : formatMoney(Math.round(inc.value * 100))}${loc ? ` @ ${loc}` : ''}, effective ${effective}): ${summary.created} created, ${summary.emailed} emailed, ${summary.texted} texted, ${summary.unreachable} unreachable, ${summary.alreadyNotified} already notified, ${summary.failed} failed.`,
      metadata: JSON.stringify({ batch_id: batchId, increase: inc, location_id: loc, effective_date: effective, summary }),
    });
  } catch (auditErr) {
    logger.warn(`[price-change] audit log failed: ${auditErr.message}`);
  }

  logger.info(`[price-change] batch ${batchId}: ${JSON.stringify(summary)}`);
  return { ok: summary.failed === 0, batchId, ...summary };
}

module.exports = {
  previewPriceChange,
  createAndSendBatch,
  formatMoney,
  MIN_NOTICE_DAYS,
};
