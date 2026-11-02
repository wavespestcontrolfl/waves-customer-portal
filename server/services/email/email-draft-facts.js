/**
 * Facts for the Gmail auto-draft reply (GATE_EMAIL_DRAFT_FACTS).
 *
 * The draft model only sees the customer's email, so it wrote blanks such as
 * [STATUS UPDATE] and [PHONE NUMBER] and quoted a visit date that had moved.
 * This module computes the answers from our own records, as plain text for the
 * TRUSTED system channel. The model writes sentences around the facts.
 *
 * Reads only (never writes): visits, the Waves line, texts Waves already sent,
 * and the en-route text settings (notification_prefs, the account channel, a
 * saved property's primary flag, the callback-number hold) that decide whether
 * the tracking-text promise holds. It never includes customer-written text
 * (notes, inbound texts, access or gate codes).
 * Fail-soft: any error logs a warning and returns '' so the draft goes ahead
 * without facts.
 */
const defaultDb = require('../../models/db');
const logger = require('../logger');
const {
  parseETDateTime, formatETDay, formatETDate, formatETDayDate, formatETTime, etCalendarDayOf, etDateString, addETDays,
} = require('../../utils/datetime-et');

const VISIT_LOOKBACK_DAYS = 2;
const VISIT_LOOKAHEAD_DAYS = 21;
const VISIT_LIMIT = 6;
const SMS_LOOKBACK_HOURS = 72;
const SMS_LIMIT = 5;
const SMS_BODY_MAX = 240;
// A cancelled visit is a fact only when it was cancelled recently; older cancellations are housekeeping (a consolidated
// duplicate, a hygiene close-out) and would only confuse the reply.
const RECENT_CANCEL_DAYS = 7;

function etTime(value) {
  if (!value) return '';
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? '' : formatETTime(at);
}

function etWhen(value) {
  const at = value instanceof Date ? value : new Date(value);
  return `${formatETDayDate(at)}, ${formatETTime(at)}`;
}

// Plain-words status. A moment is appended only when the row carries one.
function statusWords(row) {
  const status = String(row.status || '').toLowerCase();
  const since = (label, stamp) => {
    const t = etTime(stamp);
    return t ? `${label} ${t}` : '';
  };
  let words;
  switch (status) {
    case 'pending':
    case 'confirmed':
      return 'scheduled';
    case 'en_route':
      words = ['technician on the way', since('since', row.en_route_at)];
      break;
    case 'on_site':
      words = ['technician on site', since('since', row.arrived_at)];
      break;
    case 'completed':
      words = ['completed', since('at', row.completed_at)];
      break;
    case 'cancelled':
      return 'cancelled';
    default:
      return String(row.status || 'unknown');
  }
  return words.filter(Boolean).join(' ');
}

function isRelevantVisit(row) {
  if (String(row.status || '').toLowerCase() !== 'cancelled') return true;
  const at = row.cancelled_at ? new Date(row.cancelled_at) : null;
  return !!at && !Number.isNaN(at.getTime()) && Date.now() - at.getTime() <= RECENT_CANCEL_DAYS * 86400000;
}

function firstToken(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

async function arrivalPhrase(conn, row) {
  const { arrivalStartForService } = require('../reservation-arrival');
  const { spokenArrivalWindow } = require('../../utils/sms-time-format');
  const start = await arrivalStartForService(conn, row);
  return spokenArrivalWindow(String(start || '').slice(0, 5));
}

// The visits in the window, old housekeeping cancellations left out IN THE QUERY (before the limit), so they can never
// crowd a live appointment out of the six rows. isRelevantVisit repeats the rule on the rows read.
async function fetchVisits(conn, customerId, receivedAt) {
  const from = etDateString(addETDays(receivedAt, -VISIT_LOOKBACK_DAYS));
  const to = etDateString(addETDays(receivedAt, VISIT_LOOKAHEAD_DAYS));
  const cancelCutoff = new Date(Date.now() - RECENT_CANCEL_DAYS * 86400000);
  const rows = await conn('scheduled_services as ss')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .where('ss.customer_id', customerId)
    .whereBetween('ss.scheduled_date', [from, to])
    .where(function recentOrNotCancelled() {
      this.whereNot('ss.status', 'cancelled').orWhere('ss.cancelled_at', '>=', cancelCutoff);
    })
    .orderBy('ss.scheduled_date')
    .orderBy('ss.window_start')
    .limit(VISIT_LIMIT)
    .select(
      'ss.id', 'ss.service_type', 'ss.scheduled_date', 'ss.window_start', 'ss.reservation_service_mix', 'ss.property_id',
      'ss.status', 'ss.en_route_at', 'ss.arrived_at', 'ss.completed_at', 'ss.cancelled_at', 't.name as tech_name',
    );
  return rows.filter(isRelevantVisit);
}

async function visitLine(conn, row) {
  let arrival = '';
  try { arrival = await arrivalPhrase(conn, row); } catch { arrival = ''; }
  const day = parseETDateTime(`${etCalendarDayOf(row.scheduled_date)}T12:00`);
  const tech = firstToken(row.tech_name);
  const parts = [
    row.service_type || 'Service visit',
    `${formatETDay(day)}, ${formatETDate(day)}`,
    arrival,
    statusWords(row),
    tech ? `technician ${tech}` : '',
  ].filter(Boolean);
  return `- ${parts.join(' | ')}`;
}

async function visitLines(conn, rows) {
  const lines = [];
  for (const row of rows) lines.push(await visitLine(conn, row));
  return lines;
}

const OPEN_VISIT_STATUSES = new Set(['pending', 'confirmed', 'en_route', 'on_site']);

// The live-tracking text promise, only when the en-route text would really go out as a text: the same reads the
// sender (twilio.js sendTechEnRoute) makes, all read-only. The customer's notification_prefs row (no row = no
// en-route text there either) must have tech_en_route and sms_enabled on, the account-level channel must be sms or
// both, the phone must not be a known landline, and the next visit must carry no callback-number hold. A visit at a
// NON-primary saved property can carry its own toggles, which this does not resolve: no promise then. Any failed or
// unknown read = no promise.
// A visit at a NON-primary saved property can carry its own toggles, which this does not resolve (true = unknown).
async function nextVisitHasOwnToggles(conn, customer, nextVisit) {
  if (!nextVisit?.property_id) return false;
  const property = await conn('customer_properties')
    .where({ id: nextVisit.property_id, customer_id: customer.id })
    .first('is_primary', 'active');
  return !property || (property.active !== false && property.is_primary !== true);
}

// The customer row's toggles and the account-level channel, as the sender reads them.
async function enRouteTextOn(customer, prefs) {
  if (!prefs?.tech_en_route || !prefs?.sms_enabled) return false;
  const AppointmentReminders = require('../appointment-reminders');
  const channelRow = await AppointmentReminders.resolveChannelPrefsRow(customer.id, prefs, customer);
  if (!channelRow || channelRow.__prefsUnavailable) return false;
  const channel = AppointmentReminders.apptChannel(channelRow.en_route_channel);
  return channel === 'sms' || channel === 'both';
}

async function trackingTextPromised(conn, customer, nextVisit) {
  if (!customer.phone || String(customer.line_type || '').toLowerCase() === 'landline') return false;
  try {
    if (await nextVisitHasOwnToggles(conn, customer, nextVisit)) return false;
    const prefs = await conn('notification_prefs').where({ customer_id: customer.id }).first();
    if (!(await enRouteTextOn(customer, prefs))) return false;
    const { callbackNumberHoldActiveForVisit } = require('../appointment-reminders');
    return !(nextVisit?.id && await callbackNumberHoldActiveForVisit(nextVisit.id));
  } catch (e) {
    logger.warn(`[email-draft-facts] tracking-text eligibility unknown, leaving the promise out: ${e.message}`);
    return false;
  }
}

function formatPhone(number) {
  const TWILIO_NUMBERS = require('../../config/twilio-numbers');
  const listed = TWILIO_NUMBERS.findByNumber?.(number)?.formatted
    || (TWILIO_NUMBERS.mainLine.number === number ? TWILIO_NUMBERS.mainLine.formatted : '');
  if (listed) return listed;
  const d = String(number || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
}

// Fail-soft on its own: a failed line lookup drops only this fact, never the visits or texts.
async function wavesLine(customerId) {
  try {
    const number = await require('../twilio').deriveOutboundNumber({ customerId });
    return formatPhone(number);
  } catch (e) {
    logger.warn(`[email-draft-facts] Waves line unavailable: ${e.message}`);
    return '';
  }
}

function cleanTextBody(body) {
  const text = String(body || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > SMS_BODY_MAX ? `${text.slice(0, SMS_BODY_MAX - 1).trimEnd()}…` : text;
}

// The window ends NOW, not at the email time: staff may text the customer after the email arrives and before the draft runs.
async function sentTextLines(conn, customerId) {
  const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
  const since = new Date(Date.now() - SMS_LOOKBACK_HOURS * 3600000);
  const query = conn('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .whereIn('status', ['sent', 'delivered'])
    .where('created_at', '>=', since);
  const rows = await excludeUnresolvedSendReservations(query)
    .orderBy('created_at', 'desc')
    .limit(SMS_LIMIT)
    .select('created_at', 'message_body');
  // A text that carries a gate, door or lockbox code never reaches the model (same detector as the report copy).
  const { containsReportAccessCode } = require('../service-report/technician-report-copy');
  return rows.reverse()
    .filter((r) => !containsReportAccessCode(String(r.message_body || '')))
    .map((r) => ({ at: r.created_at, body: cleanTextBody(r.message_body) }))
    .filter((r) => r.body)
    .map((r) => `- ${etWhen(r.at)}: ${r.body}`);
}

async function section(title, work) {
  const lines = await work();
  return lines.length ? [title, ...lines].join('\n') : '';
}

async function buildEmailDraftFacts({ customer, receivedAt, conn = defaultDb } = {}) {
  if (!customer?.id) return '';
  try {
    const at = receivedAt ? new Date(receivedAt) : new Date();
    const when = Number.isNaN(at.getTime()) ? new Date() : at;
    const blocks = [];
    const visits = await fetchVisits(conn, customer.id, when);
    blocks.push(await section('Visits:', () => visitLines(conn, visits)));
    const phone = await wavesLine(customer.id);
    if (phone) blocks.push(`Phone for this customer to call or text Waves: ${phone}`);
    const nextVisit = visits.find((v) => OPEN_VISIT_STATUSES.has(String(v.status || '').toLowerCase())) || null;
    if (await trackingTextPromised(conn, customer, nextVisit)) {
      blocks.push('When the technician heads out, Waves sends a text with a live tracking link.');
    }
    blocks.push(await section(
      `Texts Waves already sent this customer in the last ${SMS_LOOKBACK_HOURS} hours (oldest first, ET):`,
      () => sentTextLines(conn, customer.id),
    ));
    return blocks.filter(Boolean).join('\n');
  } catch (e) {
    logger.warn(`[email-draft-facts] facts unavailable, drafting without them: ${e.message}`);
    return '';
  }
}

module.exports = { buildEmailDraftFacts };
