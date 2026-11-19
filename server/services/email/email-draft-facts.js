/**
 * Facts for the Gmail auto-draft reply.
 *
 * The draft model only sees the customer's email, so it wrote blanks such as
 * [STATUS UPDATE] and [PHONE NUMBER] and quoted a visit date that had moved.
 * This module computes the answers from our own records, as plain text for the
 * TRUSTED system channel. The model writes sentences around the facts.
 *
 * Reads only (never writes): visits, the Waves line, the customer's estimate
 * (only when it is the one estimate ever sent to them: our fixed service label
 * and its valid-until or accepted day; never a price, owner ruling: prices
 * only on the estimate page), and
 * texts Waves already sent. It never includes customer-written text (notes, inbound texts, access or
 * gate codes). It states no future contact promise ("we will text you"): whether
 * a text reaches someone depends on the en-route sender's whole recipient chain,
 * so the prompt rules forbid any contact promise the facts do not state.
 * Fail-soft: any error logs a warning and returns '' so the draft goes ahead
 * without facts.
 */
const defaultDb = require('../../models/db');
const logger = require('../logger');
const { parseEstimateData } = require('../estimate-service-lines');
const { estimateOffCustomerSurface, callSideBlockForEstimateData } = require('../../utils/estimate-claim-sql');
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
// Estimates: the open ones (sent or viewed) and any accepted in the last 30 days, newest first. Oct 2026: a draft
// told a customer "your estimate expires on [EXPIRATION DATE]" and was sent with the blank.
const ESTIMATE_ACCEPTED_LOOKBACK_DAYS = 30;

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
      'ss.id', 'ss.service_type', 'ss.scheduled_date', 'ss.window_start', 'ss.reservation_service_mix',
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

function formatPhone(number) {
  const TWILIO_NUMBERS = require('../../config/twilio-numbers');
  const listed = TWILIO_NUMBERS.findByNumber?.(number)?.formatted
    || (TWILIO_NUMBERS.mainLine.number === number ? TWILIO_NUMBERS.mainLine.formatted : '');
  if (listed) return listed;
  const d = String(number || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
}

// Fail-soft on its own: a failed line lookup drops only this fact, never the visits or texts.
// The drafter passes the customer's full row: deriveOutboundNumber reads its location from that row instead of a
// second read whose failure would silently answer the default office line.
async function wavesLine(customer) {
  try {
    const number = await require('../twilio').deriveOutboundNumber({ customerId: customer.id, customer });
    return formatPhone(number);
  } catch (e) {
    logger.warn(`[email-draft-facts] Waves line unavailable: ${e.message}`);
    return '';
  }
}

// Links leave the facts in every form our texts use: with a scheme, www., or a bare host with a path
// ("portal.wavespestcontrol.com/l/abc123", the form most Waves texts carry).
const SCHEME_LINK_RE = /https?:\/\/\S+/gi;
const WWW_LINK_RE = /\bwww\.\S+/gi;
const BARE_HOST_PATH_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\/\S*/gi;

function cleanTextBody(body) {
  const text = String(body || '')
    .replace(SCHEME_LINK_RE, '')
    .replace(WWW_LINK_RE, '')
    .replace(BARE_HOST_PATH_RE, '')
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

// Every estimate the customer could mean, at any age and whatever became of it (declined, expired, archived): every
// one ever published to them. That is this customer's; any emailed to their address, whoever owns it (estimates go
// out to customer_email, so a sender who received another account's estimate may be asking about it; 11-19 prod: 44
// of the 76 lead-only estimates published in 120 days shared an email with a customer record); and any lead-only one
// under their phone. Another customer's row counts for its email only, never for a shared phone, and nameable() never
// names it. Published means delivery evidence (sent_at, viewed_at,
// or the send path's handoff record deliveryState.firstDeliveredAt, the witness the dashboard and call checks also
// read: an estimate accepted or declined while its send was in flight can hold only that) or a delivery status
// ('sending', 'sent', 'viewed'). A terminal status alone is no evidence: the expiry
// worker marks unsent drafts expired, staff can decline an unsent draft, and a one-tap purchase is an internal draft
// marked accepted on confirmation (never an estimate the customer was sent, so it never counts). Two rows are read:
// a second means the customer could mean either.
const PHONE_DIGITS_SQL = "right(regexp_replace(customer_phone, '\\D', '', 'g'), 10) = ?";
const FIRST_HANDOFF_SQL = "(estimate_data #>> '{deliveryState,firstDeliveredAt}') IS NOT NULL";
async function fetchEstimates(conn, customer, email) {
  const phone = String(customer.phone || '').replace(/\D/g, '').slice(-10);
  return conn('estimates')
    .where((who) => {
      who.where('customer_id', customer.id).orWhereRaw('lower(trim(customer_email)) = ?', [email]);
      if (phone.length === 10) who.orWhere((lead) => lead.whereNull('customer_id').whereRaw(PHONE_DIGITS_SQL, [phone]));
    })
    .where((published) => published.whereNotNull('sent_at').orWhereNotNull('viewed_at')
      .orWhereRaw(FIRST_HANDOFF_SQL)
      .orWhereIn('status', ['sending', 'sent', 'viewed']))
    .where((real) => real.whereNull('source').orWhereNot('source', 'one_tap_purchase'))
    .limit(2)
    .select('customer_id', 'estimate_data', 'status', 'archived_at', 'estimate_group_id', 'accepted_at', 'expires_at');
}

// What the one estimate can say: open (sent or viewed, not past expires_at: the nightly sweep may not have closed it
// yet, and the page already treats it as expired) or accepted in the last 30 days. Only the customer's own row: a
// lead-only one, or another account's emailed to them, counts above but is never named. An archived row's page is gone, a
// 'sending' row's dates are not settled, and a declined or expired one has no date to quote. A property-group offer
// is never named: its siblings cover other homes, and a sibling may not carry this customer's id.
function nameable(row, customer, now) {
  if (String(row.customer_id || '') !== String(customer.id)) return false;
  if (row.archived_at || row.estimate_group_id) return false;
  const status = String(row.status || '');
  const at = (value) => (value ? new Date(value).getTime() : NaN);
  if (status === 'accepted') return now.getTime() - at(row.accepted_at) <= ESTIMATE_ACCEPTED_LOOKBACK_DAYS * 86400000;
  if (!['sent', 'viewed'].includes(status)) return false;
  return !row.expires_at || at(row.expires_at) > now.getTime();
}

// Whether the customer's own estimate page shows the row. The page's view gate (estimate-public.js
// handleEstimateView) runs two verdicts beyond status, archive and expiry (the query): the estimate-side markers
// (estimateOffCustomerSurface: a wrong-lead hold, full or pending; an unverified address; a re-price hold; and any
// marker added to it later) and the call-side hold (callSideBlockForEstimateData), which can be the only record of a
// wrong-lead verdict. Stored data that cannot be parsed hides its markers. Fails closed.
async function shownOnEstimatePage(conn, row) {
  try {
    const data = parseEstimateData(row.estimate_data);
    if (row.estimate_data != null && data == null) return false;
    if (estimateOffCustomerSurface(row)) return false;
    return !(await callSideBlockForEstimateData(conn, data, { estimateStatus: row.status }));
  } catch {
    return false;
  }
}

// "Thursday, October 29": the long form the visit lines use.
const etDayDate = (value) => {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? `${formatETDay(at)}, ${formatETDate(at)}` : '';
};

// "- Estimate | valid until Thursday, November 5, 2:04 PM". Only the deadline: no sent, dated or opened claim, since
// each can disagree with what the customer holds (a report cross-sell stamps sent_at without contacting anyone, the
// proposal prints its creation day, an emailed PDF can be read without opening the tracked page). No service name
// either: service_interest can name a service the quoted lines do not carry, or text a web visitor typed, and the
// customer's own email says which service they mean.
function estimateLine(row) {
  const parts = ['Estimate'];
  if (String(row.status || '') === 'accepted') {
    const accepted = etDayDate(row.accepted_at);
    // Only the acceptance: a one-time job or an add-on to a plan is accepted too, so it never says "signed up".
    parts.push(accepted ? `accepted ${accepted}` : 'accepted');
    return `- ${parts.join(' | ')}`;
  }
  const expires = etDayDate(row.expires_at);
  if (expires) parts.push(`valid until ${expires}, ${formatETTime(new Date(row.expires_at))}`);
  return `- ${parts.join(' | ')}`;
}

// The drafter takes the first customer whose email matches the sender. When two profiles share the address, the
// other profile's estimate is one the sender could mean too, so none is named.
async function soleProfile(conn, customer, email) {
  const rows = await conn('customers').whereRaw('lower(trim(email)) = ?', [email]).limit(2).select('id');
  return rows.length === 1 && String(rows[0].id) === String(customer.id);
}

// One estimate or none: it is named only when the sender has one profile, it is the one estimate they could mean, it
// can say something (above), and the customer's estimate page shows it. Any other case leaves the section out, and
// the draft keeps a placeholder, as before these facts: with two, a reply could give the wrong one's dates.
async function estimateLines(conn, customer, now) {
  // The profile check needs the address; the drafter matched the customer by it.
  const email = String(customer.email || '').trim().toLowerCase();
  if (!email) return [];
  let rows;
  try {
    if (!(await soleProfile(conn, customer, email))) return [];
    rows = await fetchEstimates(conn, customer, email);
  } catch (e) {
    // Only this section is lost: the visits, the phone line and the texts still reach the draft.
    logger.warn(`[email-draft-facts] estimates unavailable, drafting without them (${e?.code || 'no code'})`);
    return [];
  }
  if (rows.length !== 1 || !nameable(rows[0], customer, now)) return [];
  if (!(await shownOnEstimatePage(conn, rows[0]))) return [];
  return [estimateLine(rows[0])];
}

async function section(title, work) {
  const lines = await work();
  return lines.length ? [title, ...lines].join('\n') : '';
}

async function buildEmailDraftFacts({ customer, receivedAt, conn = defaultDb, now = new Date() } = {}) {
  if (!customer?.id) return '';
  try {
    const at = receivedAt ? new Date(receivedAt) : new Date();
    const when = Number.isNaN(at.getTime()) ? new Date() : at;
    const blocks = [];
    const visits = await fetchVisits(conn, customer.id, when);
    blocks.push(await section('Visits:', () => visitLines(conn, visits)));
    const phone = await wavesLine(customer);
    if (phone) blocks.push(`Phone for this customer to call or text Waves: ${phone}`);
    // A plain heading: a report cross-sell or plan restart publishes an estimate without contacting anyone.
    blocks.push(await section('Estimate:', () => estimateLines(conn, customer, now)));
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
