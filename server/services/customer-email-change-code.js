'use strict';

// The proof step of a customer-typed email change (GATE_CUSTOMER_PROFILE_EDIT, routes/customer-profile.js).
// The new address is NOT written anywhere until the customer types back the 6-digit code mailed to it: an
// unproven address must not receive invoices, signing links or queued sends, and a typo must not mail a stranger.
//
//   issueRequest   inside the caller's transaction: replace the customer's open request with a new one
//                  (new code, 15 minutes, attempts 0) and return the plain code once, for the email.
//   checkCode      inside the caller's transaction, under the request row lock: judge a typed code.
//                  Outcomes: ok | missing | expired | stale | attempts | wrong. `stale` = the customer's stored
//                  email is no longer the one recorded when the code was issued (the request is consumed).
//                  A wrong code adds one attempt (the caller MUST commit, not roll back, or the attempt is
//                  lost); 5 attempts end the request.
//   sendCode       the email: short plain copy, tracking off (the code is a credential), sent to the NEW address.
//
// Storage: customer_email_change_requests (migration 20261126190000). Only an HMAC of the code is stored.

const crypto = require('crypto');
const config = require('../config');
const sendgrid = require('./sendgrid-mail');
const { wrapEmail } = require('./email-template');

const CODE_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
// The send runs after the transaction commits, but a stuck provider must not hold the request open.
const SEND_TIMEOUT_MS = 10_000;
const TABLE = 'customer_email_change_requests';

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(requestId, code) {
  return crypto.createHmac('sha256', String(config.jwt.secret || '')).update(`${requestId}:${code}`).digest('hex');
}

function sameHash(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function emailKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

async function issueRequest(trx, { customerId, newEmail, fromEmail = null }) {
  // One open row per customer (partial unique index): drop the open one and any consumed leftovers first.
  await trx(TABLE).where({ customer_id: customerId }).del();
  const id = crypto.randomUUID();
  const code = generateCode();
  await trx(TABLE).insert({
    id,
    customer_id: customerId,
    new_email: emailKey(newEmail),
    from_email: emailKey(fromEmail) || null,
    code_hash: hashCode(id, code),
    expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
  });
  return { id, code, expiresInMinutes: CODE_TTL_MINUTES };
}

async function markSent(trx, id) {
  await trx(TABLE).where({ id }).update({ sent_at: trx.fn.now(), updated_at: trx.fn.now() });
}

async function dropRequest(trx, id) {
  await trx(TABLE).where({ id }).del();
}

async function checkCode(trx, { customerId, code, currentEmail }) {
  const request = await trx(TABLE).where({ customer_id: customerId }).whereNull('consumed_at').forUpdate().first();
  if (!request) return { outcome: 'missing' };
  // The address on file moved since the code was issued (staff edit, another confirm): this code must not overwrite
  // that change, whatever the typed code is.
  if (emailKey(request.from_email) !== emailKey(currentEmail)) {
    await consume(trx, request.id);
    return { outcome: 'stale', request };
  }
  if (new Date(request.expires_at).getTime() <= Date.now()) return { outcome: 'expired', request };
  if (Number(request.attempts) >= MAX_ATTEMPTS) return { outcome: 'attempts', request };
  if (sameHash(request.code_hash, hashCode(request.id, String(code || '').trim()))) return { outcome: 'ok', request };
  const attempts = Number(request.attempts) + 1;
  await trx(TABLE).where({ id: request.id }).update({ attempts, updated_at: trx.fn.now() });
  return { outcome: 'wrong', request, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) };
}

async function consume(trx, id) {
  await trx(TABLE).where({ id }).update({ consumed_at: trx.fn.now(), updated_at: trx.fn.now() });
}

function buildCodeEmail(code) {
  const sentence = `Your Waves code to confirm this email is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`;
  const html = wrapEmail({
    preheader: sentence,
    heading: 'Confirm your email',
    intro: sentence,
    lines: [['Code', code, true]],
    footerNote: 'If you did not ask for this, you can ignore this email. Nothing changes until the code is typed in the Waves app.',
  });
  const text = `${sentence}\n\nIf you did not ask for this, you can ignore this email. Nothing changes until the code is typed in the Waves app.`;
  return { subject: 'Your Waves confirmation code', html, text };
}

// Throws on a send failure; the caller drops the request and tells the customer to try again.
async function sendCode({ to, code }) {
  const { subject, html, text } = buildCodeEmail(code);
  return sendgrid.sendOne({
    to,
    fromEmail: 'contact@wavespestcontrol.com',
    subject,
    html,
    text,
    categories: ['customer_email_change_code'],
    disableTracking: true,
    suppressErrorLog: true,
    timeoutMs: SEND_TIMEOUT_MS,
  });
}

module.exports = {
  CODE_TTL_MINUTES, MAX_ATTEMPTS, issueRequest, markSent, dropRequest, checkCode, consume, sendCode, buildCodeEmail, hashCode, generateCode,
};
