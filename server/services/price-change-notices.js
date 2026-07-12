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
 *              (billing.price_change_notice, service_operational stream —
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
const { whereLiveCustomer } = require('./customer-stages');
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

function formatMoney(cents) {
  const n = Number(cents || 0) / 100;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

// Targets: LIVE customers (canonical pipeline-stage predicate) who actually
// pay a recurring rate — a price change is meaningless for anyone else.
// Location scoping mirrors the segment-send rules: stored office first, city
// routing for null-location rows, Bradenton as the default bucket.
function targetsQuery({ locationId = null } = {}) {
  let q = db('customers')
    .modify(whereLiveCustomer)
    .where('monthly_rate', '>', 0);
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

async function previewPriceChange({ locationId = null, increase } = {}) {
  const inc = parseIncrease(increase);
  const loc = parseLocation(locationId);
  const customers = await targetsQuery({ locationId: loc })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'monthly_rate')
    .orderBy('last_name', 'asc')
    .orderBy('first_name', 'asc');
  const rows = noticeRowsFor(customers, inc);
  const invalid = rows.filter((r) => r.newCents <= 0);
  return {
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

async function sendNoticeEmail({ customer, notice, vars }) {
  try {
    const EmailTemplateLibrary = require('./email-template-library');
    const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
    const [recipient] = getInvoiceEmailRecipients(customer, prefs || {});
    const to = String(recipient?.email || '').trim();
    if (!to || !to.includes('@')) return false;
    const firstName = String(recipient?.name || customer.first_name || '').trim().split(/\s+/)[0] || 'there';
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'billing.price_change_notice',
      to,
      recipientType: 'customer',
      recipientId: customer.id,
      suppressionGroupKey: 'service_operational',
      categories: ['billing', 'price_change_notice'],
      idempotencyKey: `price_change:${notice.batch_id}:${customer.id}`,
      suppressProviderErrorLog: true,
      payload: {
        ...vars,
        first_name: firstName,
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: SERVICE_EMAIL,
      },
    });
    return !!result?.sent;
  } catch (err) {
    logger.error(`[price-change] email failed for customer ${customer.id} (${err?.name || 'Error'})`);
    return false;
  }
}

async function sendNoticeSms({ customer, vars, actorId, hasEmailLeg }) {
  try {
    const { renderSmsTemplate } = require('./sms-template-renderer');
    const { sendCustomerMessage } = require('./messaging/send-customer-message');
    const phone = String(customer.phone || '').trim();
    if (!phone) return false;
    const firstName = String(customer.first_name || '').trim().split(/\s+/)[0] || 'there';
    const body = await renderSmsTemplate('price_change_notice', {
      first_name: firstName,
      effective_date: vars.effective_date,
      price_change_url: vars.price_change_url,
    }, { workflow: 'price_change_notice', entity_type: 'customer', entity_id: customer.id });
    if (!body) return false;
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
    return !!res.sent;
  } catch (err) {
    logger.error(`[price-change] SMS failed for customer ${customer.id}: ${err.message}`);
    return false;
  }
}

async function createAndSendBatch({ locationId = null, increase, effectiveDate, cadenceLabel = 'month', expectedCount, actorId = null } = {}) {
  const inc = parseIncrease(increase);
  const loc = parseLocation(locationId);
  const effective = validateEffectiveDate(effectiveDate);
  const cadence = String(cadenceLabel || 'month').slice(0, 40);

  const customers = await targetsQuery({ locationId: loc })
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'monthly_rate')
    .orderBy('id', 'asc');

  if (customers.length !== Number(expectedCount)) {
    return { ok: false, reason: 'count_drift', count: customers.length };
  }
  if (customers.length === 0) return { ok: false, reason: 'empty' };
  if (customers.length > BATCH_CAP) return { ok: false, reason: 'over_cap', count: customers.length };

  const rows = noticeRowsFor(customers, inc);
  if (rows.some((r) => r.newCents <= 0)) {
    return { ok: false, reason: 'invalid_amounts' };
  }

  const batchId = crypto.randomUUID();
  const effectiveLabel = formatDisplayDate(effective, { fallback: effective });
  const byId = new Map(customers.map((c) => [c.id, c]));
  const summary = { created: 0, emailed: 0, texted: 0, unreachable: 0, failed: 0 };

  for (let i = 0; i < rows.length; i += SEND_CONCURRENCY) {
    const batch = rows.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      try {
        const token = crypto.randomBytes(16).toString('hex');
        const [notice] = await db('price_change_notices').insert({
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
        }).returning('*');
        summary.created += 1;

        const customer = byId.get(row.customerId);
        const vars = {
          current_price: formatMoney(row.currentCents),
          new_price: formatMoney(row.newCents),
          effective_date: effectiveLabel,
          cadence_label: cadence,
          price_change_url: portalUrl(`/price-change/${token}`),
        };
        const emailed = await sendNoticeEmail({ customer, notice, vars });
        const texted = await sendNoticeSms({ customer, vars, actorId, hasEmailLeg: emailed });
        if (emailed) summary.emailed += 1;
        if (texted) summary.texted += 1;
        if (!emailed && !texted) summary.unreachable += 1;

        await db('price_change_notices').where({ id: notice.id }).update({
          email_sent: emailed,
          sms_sent: texted,
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
      description: `Price-change notices (${inc.type === 'percent' ? `${inc.value}%` : formatMoney(Math.round(inc.value * 100))}${loc ? ` @ ${loc}` : ''}, effective ${effective}): ${summary.created} created, ${summary.emailed} emailed, ${summary.texted} texted, ${summary.unreachable} unreachable, ${summary.failed} failed.`,
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
