// Nightly check: did a bill reach its customer already past due?
//
// Owner 2026-11-06: an annual prepay bill reached its customer a week after its
// due date, so it read past due on the day it arrived, and the overdue and
// collections surfaces counted it late from that first day. A bill's first
// delivery now moves a due date before the send day to the send day, at each
// send claim and delivery stamp (invoice-helpers.js firstDeliveryDueDate). This
// job reads the open self-pay bills (open-balance.js applyOpenSelfPayPredicates)
// first delivered in the last 7 days whose due date is before the Eastern day of
// their first delivery stamp. A hit is a delivery path that skipped the move. It
// posts one engineering FIX row to the ops digest that lists those bills, and
// the row retires itself on the first clean night (ops-digest-fall-off.js).
//
// Read-only: it writes no business record, texts or emails no customer, and
// calls no paid API. Its only write is the ops digest row (or, when the in-app
// feed is off, one email to the internal ops inbox).

const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const { applyOpenSelfPayPredicates } = require('./open-balance');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');

const OPS_KEY = 'late-sent-bill';
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LISTED_MAX = 25;
const LINK = '/admin/invoices';
const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

// The bill's first delivery: the earliest of its stamps (Postgres LEAST skips a NULL).
const FIRST_DELIVERY_SQL = 'LEAST(invoices.sent_at, invoices.sms_sent_at, invoices.email_sent_at)';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Open self-pay bills first delivered since `since` whose due date is before that delivery's Eastern day.
function readLateSentBills(knex, since) {
  return applyOpenSelfPayPredicates(knex('invoices'))
    .whereNotNull('invoices.due_date')
    .whereRaw(`${FIRST_DELIVERY_SQL} >= ?`, [since])
    .whereRaw(`invoices.due_date < (${FIRST_DELIVERY_SQL} AT TIME ZONE 'America/New_York')::date`)
    .orderByRaw(`${FIRST_DELIVERY_SQL} ASC`)
    .select(
      'invoices.id',
      'invoices.invoice_number',
      'invoices.due_date',
      'invoices.annual_prepay_term_id',
      knex.raw(`${FIRST_DELIVERY_SQL} AS first_delivered_at`),
    );
}

function findingLine(row) {
  const sent = new Date(row.first_delivered_at);
  const due = formatDateOnly(dateOnlyString(row.due_date), { month: 'short', year: undefined });
  const prepay = row.annual_prepay_term_id ? ', an annual prepay bill' : '';
  return `${row.invoice_number}${prepay}: due ${due}, first sent ${formatETDayDate(sent)} ${formatETTime(sent)} ET (invoice ${row.id})`;
}

function composeDigest(rows) {
  const n = rows.length;
  const bills = `bill${n === 1 ? '' : 's'}`;
  const listed = rows.slice(0, LISTED_MAX).map(findingLine);
  const more = n > LISTED_MAX ? [`… and ${n - LISTED_MAX} more.`] : [];
  const cause = 'A first delivery moves a due date before the send day to the send day (server/services/invoice-helpers.js firstDeliveryDueDate, at the send claims and delivery stamps in server/services/invoice.js). Each bill above went out on a path that skipped it. Find that path, and move each bill\'s due date to its first send day without moving its reminders.';
  return {
    subject: `FIX: ${n} ${bills} reached the customer already past due`,
    headline: `Billing — fix ${n} ${bills} sent already past due`,
    summary: `${n} open ${bills} first sent in the last 7 days had a due date before the day ${n === 1 ? 'it was' : 'they were'} sent.`,
    text: [`${n} open ${bills} first sent in the last 7 days had a due date before the day ${n === 1 ? 'it was' : 'they were'} sent:`, '', ...listed.map((line) => `- ${line}`), ...more, '', cause].join('\n'),
    html: [
      `<p><strong>${n}</strong> open ${bills} first sent in the last 7 days had a due date before the day ${n === 1 ? 'it was' : 'they were'} sent:</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${listed.map((line) => `<li style="margin:0 0 6px 0;">${esc(line)}</li>`).join('')}</ul>`,
      ...more.map((line) => `<p>${esc(line)}</p>`),
      `<p>${esc(cause)}</p>`,
    ].join('\n'),
  };
}

function postDigest(rows, mailer) {
  const composed = composeDigest(rows);
  return deliverOpsDigest({
    fallOff: true, // retired by retireIfClean on the first clean night
    key: OPS_KEY,
    subject: composed.subject,
    headline: composed.headline,
    summary: composed.summary,
    html: composed.html,
    text: composed.text,
    link: LINK,
    count: rows.length,
    itemKeys: rows.map((row) => String(row.id)),
    dedupeKey: OPS_KEY,
    refreshOnDedupe: true,
    // Fallback only: the in-app feed is off, or the row write failed.
    sendEmail: async () => {
      if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
        throw new Error('mailer not configured');
      }
      return mailer.sendOne({
        to: OPS_INBOX,
        fromEmail: fromEmail(),
        fromName: FROM_NAME,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        categories: ['ops', OPS_KEY],
        suppressErrorLog: true,
      });
    },
  });
}

/**
 * One nightly run over the 7 days before `now`. A failed read throws, so runExclusive records a
 * failed run and the standing row stays: a check that did not run proves nothing.
 * Returns { found, delivery? }.
 */
async function runLateSentBillCheck({ knex = db, now = new Date(), mailer = sendgrid } = {}) {
  const rows = await readLateSentBills(knex, new Date(now.getTime() - WINDOW_MS));
  if (!rows.length) {
    await retireIfClean(OPS_KEY);
    return { found: 0 };
  }
  logger.warn(`[late-sent-bill] ${rows.length} open bill(s) reached the customer already past due`);
  const delivery = await postDigest(rows, mailer);
  return { found: rows.length, delivery };
}

module.exports = {
  runLateSentBillCheck,
  OPS_KEY,
  _private: { readLateSentBills, composeDigest, findingLine },
};
