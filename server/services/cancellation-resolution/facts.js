'use strict';

/**
 * Facts loader — everything the resolver may read about a customer, all of
 * it already stored in the portal. Hard facts only (tenure, paid visits,
 * balance, findings, callbacks, prior offers); never a churn/risk score
 * (owner ruling 2026-08-29: that signal is broken and nothing keys on it).
 *
 * Every leg is wrapped: a failed query yields null/0 for that fact and the
 * resolver's slot validators simply drop the cards that needed it. A facts
 * miss can never surface an invented number and can never block a cancel.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('../invoice-helpers');

const COMPLAINT_CATEGORIES = ['pest_issue', 'lawn_concern', 'billing'];
const OPEN_REQUEST_STATUSES = ['new', 'open', 'in_progress'];
const COMPLAINT_KEYWORDS = /\b(late|missed|no[- ]show|didn'?t show|never (came|showed)|gate|rushed|skipped|still seeing|still have|not (working|better)|damage|broke)\b/i;
const DAY_MS = 86400000;

function daysAgo(n, now) {
  return new Date(now.getTime() - n * DAY_MS);
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString ? value.toISOString().slice(0, 10) : null;
}

function laneForServiceLine(line) {
  const s = String(line || '').toLowerCase();
  if (s.startsWith('lawn')) return 'lawn';
  if (s.startsWith('pest')) return 'pest';
  return null;
}

async function leg(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`[cancellation-resolution] facts.${name} failed: ${err.message}`);
    return fallback;
  }
}

function num(row, key) {
  return Number((row && row[key]) || 0) || 0;
}

async function loadFamilies(customerId, today) {
  const {
    detectWaveGuardPlanKeys, serviceRowCountsTowardWaveGuard, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  const rows = await db('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where('s.scheduled_date', '>=', today)
    .whereNotIn('s.status', ['cancelled', 'completed'])
    .select('s.*', 'sv.service_key', 'sv.service_name');
  const keys = [];
  for (const row of rows) {
    if (!serviceRowCountsTowardWaveGuard(row)) continue;
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!keys.includes(key)) keys.push(key);
  }
  return uniqueServiceFamilies(keys);
}

async function loadCancellationFacts(customerId, { now = new Date() } = {}) {
  if (!customerId) throw new Error('loadCancellationFacts requires customerId');
  const today = etDateString();
  const since12mo = daysAgo(365, now);

  const customer = await db('customers')
    .where({ id: customerId })
    .first('id', 'member_since', 'created_at', 'waveguard_tier', 'monthly_rate', 'billing_mode', 'termite_stations_rented', 'autopay_enabled');
  if (!customer) return null;

  const memberSince = customer.member_since || customer.created_at;
  const tenureDays = memberSince ? Math.max(0, Math.floor((now.getTime() - new Date(memberSince).getTime()) / DAY_MS)) : 0;

  const [
    visitCounts, visits12mo, callbacks12mo, reschedules12mo, savings12mo, pastDue, failedPayment,
    findings, complaintRequest, lastComplaint, priorOffer, shownCases, termite, properties, prefs, callbackLanes, families,
  ] = await Promise.all([
    leg('visitCounts', () => db('scheduled_services')
      .where({ customer_id: customerId, status: 'completed' })
      .whereRaw('COALESCE(is_callback, false) = false')
      .count({ n: '*' }).first(), null),
    leg('visits12mo', () => db('scheduled_services')
      .where({ customer_id: customerId, status: 'completed' })
      .whereRaw('COALESCE(is_callback, false) = false')
      .where('scheduled_date', '>=', dateOnly(since12mo))
      .count({ n: '*' }).first(), null),
    leg('callbacks12mo', () => db('scheduled_services')
      .where({ customer_id: customerId, status: 'completed', is_callback: true })
      .where('scheduled_date', '>=', dateOnly(since12mo))
      .count({ n: '*' }).first(), null),
    leg('reschedules12mo', () => db('job_status_history as h')
      .join('scheduled_services as s', 's.id', 'h.job_id')
      .where('s.customer_id', customerId)
      .where('h.to_status', 'rescheduled')
      .where('h.transitioned_at', '>=', since12mo)
      .count({ n: '*' }).first(), null),
    leg('savings12mo', () => db('invoices')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'prepaid'])
      .where('created_at', '>=', since12mo)
      .where('discount_label', 'ilike', '%WaveGuard%')
      .sum({ n: 'discount_amount' }).first(), null),
    leg('pastDue', () => db('invoices')
      .where({ customer_id: customerId })
      .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
      .whereNotNull('due_date')
      .where('due_date', '<', today)
      .whereRaw('COALESCE(total, 0) - COALESCE(credit_applied, 0) > 0')
      .first('id'), null),
    leg('failedPayment', () => db('payments')
      .where({ customer_id: customerId, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .first('id'), null),
    leg('findings', () => db('service_findings as f')
      .join('service_records as r', 'r.id', 'f.service_record_id')
      .where('r.customer_id', customerId)
      .orderBy([{ column: 'r.service_date', order: 'desc' }, { column: 'f.created_at', order: 'desc' }])
      .limit(50)
      .select('f.title', 'f.detail', 'f.category', 'f.severity', 'r.service_date', 'r.service_line'), []),
    leg('complaintRequest', () => db('service_requests')
      .where({ customer_id: customerId })
      .whereIn('category', COMPLAINT_CATEGORIES)
      .whereIn('status', OPEN_REQUEST_STATUSES)
      .where('created_at', '>=', daysAgo(60, now))
      .first('id'), null),
    leg('lastComplaint', () => db('messages as m')
      .join('conversations as c', 'c.id', 'm.conversation_id')
      .where('c.customer_id', customerId)
      .where('m.direction', 'inbound')
      .where('m.channel', 'sms')
      .where('m.created_at', '>=', daysAgo(60, now))
      .orderBy('m.created_at', 'desc')
      .limit(20)
      .select('m.body', 'm.created_at'), []),
    leg('priorOffer', () => db('retention_offers')
      .where({ customer_id: customerId })
      .orderBy('granted_at', 'desc')
      .first('granted_at'), null),
    leg('shownCases', () => db('cancellation_cases')
      .where({ customer_id: customerId })
      .whereNotNull('resolution_template_id')
      .where('created_at', '>=', since12mo)
      .select('resolution_template_id'), []),
    leg('termite', () => db('termite_stations')
      .where({ customer_id: customerId, program: 'termite', owned_by: 'waves' })
      .whereRaw('COALESCE(is_active, true) = true')
      .first('id'), null),
    leg('properties', () => db('customer_properties')
      .where({ customer_id: customerId, active: true })
      .count({ n: '*' }).first(), null),
    leg('prefs', () => db('property_preferences')
      .where({ customer_id: customerId })
      .first('preferred_day', 'preferred_time', 'property_gate_code', 'neighborhood_gate_code'), null),
    leg('callbackLanes', async () => {
      const { openReserviceCallbacks } = require('../reservice-scheduler');
      return Object.keys(await openReserviceCallbacks(customerId));
    }, []),
    leg('families', () => loadFamilies(customerId, today), []),
  ]);

  const findingRows = Array.isArray(findings) ? findings : [];
  const toFinding = (row) => (row ? {
    text: [row.title, row.detail].filter(Boolean).join(' — ').slice(0, 160),
    lane: laneForServiceLine(row.service_line),
    date: dateOnly(row.service_date),
  } : null);
  const lastFinding = toFinding(findingRows[0]);
  const firstFinding = toFinding(findingRows[findingRows.length - 1]);

  const complaintMsg = (Array.isArray(lastComplaint) ? lastComplaint : []).find((m) => COMPLAINT_KEYWORDS.test(String(m.body || '')));

  const prepay = customer.billing_mode === 'annual_prepay';

  return {
    customerId,
    memberSince: dateOnly(memberSince),
    tenureDays,
    completedVisits: num(visitCounts, 'n'),
    completedPaidVisits: num(visitCounts, 'n'),
    visits12mo: num(visits12mo, 'n'),
    callbacks12mo: num(callbacks12mo, 'n'),
    reschedules12mo: num(reschedules12mo, 'n'),
    savings12mo: Math.round(num(savings12mo, 'n') * 100) / 100,
    accountCurrent: !pastDue && !failedPayment,
    openComplaint: !!complaintRequest,
    openCallbackLanes: Array.isArray(callbackLanes) ? callbackLanes : [],
    lastFinding,
    firstFinding: firstFinding && lastFinding && firstFinding.text === lastFinding.text && findingRows.length === 1 ? lastFinding : firstFinding,
    lastComplaint: complaintMsg
      ? { date: dateOnly(complaintMsg.created_at), quote: String(complaintMsg.body).trim().slice(0, 140) }
      : null,
    priorRetentionOfferAt: priorOffer && priorOffer.granted_at ? new Date(priorOffer.granted_at).toISOString() : null,
    manualPriceOverrideAt: null,
    cardsShown12mo: (Array.isArray(shownCases) ? shownCases : []).map((r) => r.resolution_template_id).filter(Boolean),
    tier: customer.waveguard_tier || null,
    monthlyRate: Number(customer.monthly_rate) || 0,
    billingMode: customer.billing_mode || null,
    prepay,
    autopay: customer.autopay_enabled === true,
    termiteRental: !!termite || customer.termite_stations_rented === true,
    multiProperty: num(properties, 'n') > 1,
    hasPreferredWindow: !!(prefs && prefs.preferred_day && prefs.preferred_day !== 'no_preference'),
    families: Array.isArray(families) ? families : [],
  };
}

module.exports = { loadCancellationFacts, laneForServiceLine, COMPLAINT_KEYWORDS };
