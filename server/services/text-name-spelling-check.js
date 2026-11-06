// Nightly check: did a staff text spell its customer's name differently from the record?
//
// Owner 2026-11-06: a dictated text greeted the customer by another spelling
// of the record's first name. The mic now puts the record's spelling back on a
// listed spelling of the on-screen customer's first name (utils/name-spelling.js
// respellRecordName, called by routes/tech-dictation.js). This job runs the same
// rules over the last 24 hours of staff-sent texts (sms_log outbound rows with an
// admin_user_id), against the customer each text went to. A hit is a word the
// mic would have re-spelled, so the text was typed, the mic had no customer on
// screen, or the mic path failed. It posts one engineering FIX row to the ops
// digest that lists those texts, and the row retires itself on the first clean
// night (ops-digest-fall-off.js). It knows only the listed spellings
// (utils/name-match.js), the same as the mic.
//
// Read-only: it writes no business record, texts or emails no customer, and
// calls no paid API. Its only write is the ops digest row (or, when the in-app
// feed is off, one email to the internal ops inbox).

const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { deliverOpsDigest } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const { respellRecordName } = require('../utils/name-spelling');
const { formatETDayDate, formatETTime } = require('../utils/datetime-et');

const OPS_KEY = 'text-name-spelling';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const LISTED_MAX = 25;
const LINK = '/admin/communications';
const OPS_INBOX = 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || OPS_INBOX;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Staff-sent texts of the window with the name of the customer each went to.
function readStaffTexts(knex, since) {
  return knex('sms_log as s')
    .join('customers as c', 'c.id', 's.customer_id')
    .where('s.direction', 'outbound')
    .whereNotNull('s.admin_user_id')
    .whereNotNull('s.message_body')
    .where('s.created_at', '>=', since)
    .orderBy('s.created_at', 'asc')
    .select('s.id', 's.created_at', 's.message_body', 'c.first_name', 'c.last_name');
}

// [{ id, at, fixes: [{ heard, spelled }] }] for each text with a word the mic would re-spell.
function findMisspellings(rows) {
  const findings = [];
  for (const row of rows) {
    const { fixes } = respellRecordName(row.message_body, { firstName: row.first_name, lastName: row.last_name });
    if (fixes.length) findings.push({ id: String(row.id), at: new Date(row.created_at), fixes });
  }
  return findings;
}

function findingLine(finding) {
  const words = finding.fixes.map((fix) => `"${fix.heard}" for "${fix.spelled}"`).join(', ');
  return `${formatETDayDate(finding.at)} ${formatETTime(finding.at)} ET: ${words} (sms_log ${finding.id})`;
}

function composeDigest(findings) {
  const n = findings.length;
  const texts = `staff text${n === 1 ? '' : 's'}`;
  const listed = findings.slice(0, LISTED_MAX).map(findingLine);
  const more = n > LISTED_MAX ? [`… and ${n - LISTED_MAX} more.`] : [];
  const cause = 'Each word is one the mic would re-spell (server/utils/name-spelling.js): the text was typed, the mic had no customer on screen, or the mic path failed.';
  return {
    subject: `FIX: ${n} ${texts} spelled the customer's name off the record`,
    headline: `Texts — ${n} misspelled the customer's name`,
    summary: `${n} ${texts} in the last 24 hours spelled the customer's name differently from the record.`,
    text: [`${n} ${texts} in the last 24 hours spelled the customer's name differently from the record:`, '', ...listed.map((line) => `- ${line}`), ...more, '', cause].join('\n'),
    html: [
      `<p><strong>${n}</strong> ${texts} in the last 24 hours spelled the customer's name differently from the record:</p>`,
      `<ul style="margin:0 0 12px 18px;padding:0;">${listed.map((line) => `<li style="margin:0 0 6px 0;">${esc(line)}</li>`).join('')}</ul>`,
      ...more.map((line) => `<p>${esc(line)}</p>`),
      `<p>${esc(cause)}</p>`,
    ].join('\n'),
  };
}

function postDigest(findings, mailer) {
  const composed = composeDigest(findings);
  return deliverOpsDigest({
    fallOff: true, // retired by retireIfClean on the first clean night
    key: OPS_KEY,
    subject: composed.subject,
    headline: composed.headline,
    summary: composed.summary,
    html: composed.html,
    text: composed.text,
    link: LINK,
    count: findings.length,
    itemKeys: findings.map((finding) => finding.id),
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
 * One nightly run over the 24 hours before `now`. A failed read throws, so runExclusive records a
 * failed run and the standing row stays: a check that did not run proves nothing.
 * Returns { checked, findings, delivery? }.
 */
async function runTextNameSpellingCheck({ knex = db, now = new Date(), mailer = sendgrid } = {}) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const rows = await readStaffTexts(knex, since);
  const findings = findMisspellings(rows);
  if (!findings.length) {
    await retireIfClean(OPS_KEY);
    return { checked: rows.length, findings: [] };
  }
  logger.warn(`[text-name-spelling] ${findings.length} staff text(s) spelled the customer's name off the record`);
  const delivery = await postDigest(findings, mailer);
  return { checked: rows.length, findings, delivery };
}

module.exports = {
  runTextNameSpellingCheck,
  OPS_KEY,
  _private: { findMisspellings, composeDigest },
};
