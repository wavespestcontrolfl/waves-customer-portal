'use strict';

/**
 * Customer moving flow, PR 1 (owner 2026-11-02, dark behind GATE_MOVING_FLOW).
 *
 * The office sends a customer a moving link (email or text, always by a staff
 * click). The link opens /moving/:token, where the customer types a new
 * address, checks it, and gives move-out and move-in dates. A submit makes one
 * office item (a service_requests row, category 'moving') and one admin alert.
 *
 * What this service never does: create a property, move or cancel a visit,
 * change a primary property, or send a message by itself.
 *
 * PR B1 (GATE_MOVING_ESTIMATE) adds the new-home estimate checks: which moves
 * may get an estimate for the new house, the $99 setup-fee waiver the estimate
 * save stamps on it (owner Q2), and the link from the move to that estimate.
 *
 * PR B2 (GATE_MOVING_APPLY) adds "Apply move": once the customer has accepted
 * the new-home estimate, the office's confirm makes the new home the primary
 * property and stops the old house's plans after the move-out date (see the
 * Apply move section). It sends nothing to the customer.
 *
 * Spend: Google Address Validation is a paid call. Each link allows at most
 * DAILY_CHECK_CAP checks per Eastern day (claimed atomically BEFORE the call),
 * and the same typed address is answered from the row for 24 hours. Submit can
 * only use the address the SERVER checked (customer_moves.last_check); a
 * verdict from the browser is never read.
 *
 * Public view contract (same as routes/price-change-public.js): first name,
 * the plan's service names, the move status and dates, and only the CITY of a
 * submitted new address. Never the current street address, a phone number, an
 * email address or money.
 */

const crypto = require('crypto');
// A knex error message carries the query's bindings (typed addresses, link
// tokens): log the code only (AGENTS.md, no PII in logs).
const errCode = (err) => String(err?.code || err?.name || 'error');
const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough } = require('./short-url');
const { etDateString, addETDays, dateOnlyString } = require('../utils/datetime-et');
const { raiseAdminAlert, cutAtWord, MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { validateAddress, STATUSES } = require('./address-validation');
const { moveVerdictLabel } = require('./move-address-verdict');
const { movingEstimateLive, movingApplyLive } = require('../config/feature-gates');

const TOKEN_RE = /^[a-f0-9]{48}$/;
const DAILY_CHECK_CAP = 10;
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 200;
const DATE_PAST_DAYS = 60;
const DATE_FUTURE_DAYS = 400;
const LIVE_STATUSES = ['open', 'submitted'];
const REQUEST_TERMINAL_STATUSES = ['resolved', 'closed', 'cancelled'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// An error the public route can show as-is: a plain message and an HTTP status.
class MoveError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MoveError';
    this.code = code;
    this.status = status;
  }
}

function stripHtml(s) {
  return String(s || '').replace(/[<>]/g, '');
}

// "Nov 15, 2026" from an ISO date string, with no time-zone hop.
function prettyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// ── Open a move and its link ────────────────────────────────────────────────

async function primaryPropertyId(customerId, conn = db) {
  const row = await conn('customer_properties')
    .where({ customer_id: customerId, active: true, is_primary: true })
    .orderBy('created_at', 'asc')
    .first('id');
  return row ? row.id : null;
}

async function liveMoveFor(customerId, conn = db) {
  return conn('customer_moves')
    .where({ customer_id: customerId })
    .whereIn('status', LIVE_STATUSES)
    .first();
}

/**
 * The customer's open or submitted move, or a new one with a fresh token. The
 * partial unique index makes a race safe: the loser re-reads the winner's row.
 */
async function openMoveForCustomer(customerId, { actorId = null } = {}) {
  if (!customerId) throw new MoveError('no_customer', 'Customer is required', 400);
  const existing = await liveMoveFor(customerId);
  if (existing) return existing;
  const fromPropertyId = await primaryPropertyId(customerId);
  try {
    const [row] = await db('customer_moves').insert({
      customer_id: customerId,
      token: crypto.randomBytes(24).toString('hex'),
      status: 'open',
      from_property_id: fromPropertyId,
    }).returning('*');
    logger.info(`[customer-moves] opened move ${row.id} for customer ${customerId}${actorId ? ` by ${actorId}` : ''}`);
    return row;
  } catch (err) {
    if (err && err.code === '23505') {
      const winner = await liveMoveFor(customerId);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * The link the office sends: the long portal URL, shortened through the branded
 * short-url service. Best-effort: a shortener failure returns the long URL.
 */
async function movingLinkFor(move) {
  const longUrl = portalUrl(`/moving/${move.token}`);
  try {
    return await shortenOrPassthrough(longUrl, {
      kind: 'moving',
      entityType: 'customer_moves',
      entityId: move.id,
      customerId: move.customer_id,
      // Never expires: the move row owns whether the link still works.
      expiresAt: null,
    });
  } catch (err) {
    logger.warn(`[customer-moves] short link failed for move ${move.id} (${errCode(err)})`);
    return longUrl;
  }
}

async function loadMoveByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const row = await db('customer_moves').where({ token }).first();
  if (!row || row.status === 'closed') return null;
  return row;
}

// ── Address check (paid) ────────────────────────────────────────────────────

function typedKey(typed) {
  return typed.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanTyped(raw) {
  const typed = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (typed.length < ADDRESS_MIN || typed.length > ADDRESS_MAX) {
    throw new MoveError('bad_address', `Enter the full address, ${ADDRESS_MIN} to ${ADDRESS_MAX} characters.`, 400);
  }
  return typed;
}

// A unit the customer typed ("Apt 4B", "#12", "Unit 3") that Google may drop.
const UNIT_RE = /(?:^|[\s,])((?:apt|apartment|unit|ste|suite|lot|bldg|building|#)\.?\s*#?\s*[\w-]+)(?=\s*(?:,|$))/i;

function typedUnit(typed) {
  const m = UNIT_RE.exec(typed);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function normalizedFrom(verdict, typed) {
  const n = (verdict && verdict.normalized) || {};
  const unit = typedUnit(typed);
  return {
    line1: n.street_line_1 || null,
    line2: unit || null,
    city: n.city || null,
    state: n.state || null,
    zip: n.postal_code || null,
  };
}

// The stored answer for the same typed text, if it is under 24 hours old and
// the provider actually answered (an outage is not worth keeping).
function reusableCheck(move, key, now) {
  const last = parseJson(move.last_check);
  if (!last || last.key !== key || !last.id || !last.result || last.providerAnswered !== true) return null;
  const age = now.getTime() - new Date(last.checked_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age >= REUSE_WINDOW_MS) return null;
  return last;
}

// Claim one check slot for today (ET), atomically, before the paid call. The
// UPDATE matches no row once today's calls reach the cap.
async function claimCheckSlot(moveId, today) {
  const rows = await db('customer_moves')
    .where({ id: moveId })
    .where(function underCap() {
      this.whereRaw('validation_day IS DISTINCT FROM ?::date', [today]).orWhere('validation_calls', '<', DAILY_CHECK_CAP);
    })
    .update({
      validation_calls: db.raw('CASE WHEN validation_day = ?::date THEN validation_calls + 1 ELSE 1 END', [today]),
      validation_day: today,
      updated_at: new Date(),
    })
    .returning('id');
  return rows.length === 1;
}

/**
 * Check a typed new address. Returns { typed, normalized, verdict, reused }.
 * Throws MoveError('check_cap', ..., 429) when the link's daily cap is reached.
 */
async function checkMoveAddress(move, rawAddress, { now = new Date() } = {}) {
  const typed = cleanTyped(rawAddress);
  const key = typedKey(typed);
  const fresh = await db('customer_moves').where({ id: move.id }).first('id', 'last_check');
  const reused = fresh ? reusableCheck(fresh, key, now) : null;
  if (reused) return { ...reused.result, checkId: reused.id, reused: true };

  const today = etDateString(now);
  if (!(await claimCheckSlot(move.id, today))) {
    throw new MoveError('check_cap', 'We have checked that address a few times today. Please try again tomorrow, or call us.', 429);
  }

  const verdict = await validateAddress({ addressLines: [typed] });
  const label = moveVerdictLabel(verdict, STATUSES);
  const providerAnswered = !!verdict && verdict.status !== STATUSES.API_UNAVAILABLE && verdict.status !== STATUSES.NOT_ATTEMPTED;
  const result = { typed, normalized: normalizedFrom(verdict, typed), verdict: label };
  // The page confirms THIS check and names it on submit, so a check made later
  // in another tab never stands in for the one the customer saw.
  const checkId = crypto.randomBytes(8).toString('hex');
  await db('customer_moves').where({ id: move.id }).update({
    last_check: JSON.stringify({ id: checkId, key, checked_at: now.toISOString(), providerAnswered, result }),
    updated_at: new Date(),
  });
  return { ...result, checkId, reused: false };
}

// ── Public view ─────────────────────────────────────────────────────────────

async function planServiceNames(customerId, conn = db) {
  const rows = await conn('scheduled_services')
    .where({ customer_id: customerId, recurring_ongoing: true })
    .where(function notCallback() { this.whereNull('is_callback').orWhere('is_callback', false); })
    .whereNotNull('service_type')
    .distinct('service_type')
    .orderBy('service_type');
  return rows.map((r) => String(r.service_type || '').trim()).filter(Boolean);
}

/** The public page's payload. Nothing but the fields below leaves this function. */
async function publicMoveView(move) {
  const customer = await db('customers').where({ id: move.customer_id }).first('first_name');
  const firstName = String((customer && customer.first_name) || '').trim().split(/\s+/)[0] || 'there';
  const services = await planServiceNames(move.customer_id);
  const normalized = parseJson(move.normalized_address);
  return {
    firstName,
    services,
    status: move.status,
    // DATE columns: the calendar date as stored. Never through an Eastern
    // instant: pg parses a DATE at midnight in the process zone (UTC on
    // Railway), and etDateString would show the day before.
    moveOutDate: dateOnlyString(move.move_out_date) || null,
    moveInDate: dateOnlyString(move.move_in_date) || null,
    newCity: (normalized && normalized.city) || null,
    verdict: move.address_verdict || null,
    addressOnFile: !!normalized,
  };
}

// ── Submit ──────────────────────────────────────────────────────────────────

function cleanDate(value, label, now) {
  if (value == null || value === '') return null;
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const valid = m && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
  if (!valid) throw new MoveError('bad_date', `Enter the ${label} as a date.`, 400);
  const earliest = etDateString(addETDays(now, -DATE_PAST_DAYS));
  const latest = etDateString(addETDays(now, DATE_FUTURE_DAYS));
  if (s < earliest || s > latest) throw new MoveError('bad_date', `That ${label} is too far away. Check the date.`, 400);
  return s;
}

function addressLine(normalized) {
  if (!normalized) return '';
  const cityLine = [normalized.city, [normalized.state, normalized.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [normalized.line1, normalized.line2, cityLine].filter(Boolean).join(', ');
}

const VERDICT_WORDS = {
  in_area: 'inside our service area',
  out_of_area: 'outside our service area',
  unverified: 'could not be confirmed, so check it with the customer',
};

function requestDescription({ typed, normalized, verdict, moveOut, moveIn, services }) {
  const lines = [];
  if (typed) {
    const google = addressLine(normalized);
    lines.push(`New address as typed: ${stripHtml(typed)}.`);
    if (google) lines.push(`Google's version: ${stripHtml(google)}.`);
    lines.push(`The address is ${VERDICT_WORDS[verdict] || VERDICT_WORDS.unverified}.`);
  } else {
    lines.push('New address: not known yet. The customer can add it with the same link.');
  }
  lines.push(`Move-out date: ${prettyDate(moveOut) || 'not known yet'}.`);
  lines.push(`Move-in date: ${prettyDate(moveIn) || 'not known yet'}.`);
  lines.push(services.length ? `Current plan: ${services.join(', ')}.` : 'Current plan: no recurring service on file.');
  return lines.join('\n');
}

function requestSubject(normalized, hasAddress) {
  if (!hasAddress) return 'Moving: address not known yet';
  return `Moving: ${stripHtml((normalized && normalized.city) || 'new address')}`;
}

// What the submit will store: the server-checked address when the customer used
// it, else whatever an earlier submit already stored.
const CHECK_ID_RE = /^[a-f0-9]{16}$/;

// checkId = "use the address check I confirmed". It must be the check the
// server holds now; one replaced since (another tab or device) is refused,
// never swapped in. No checkId keeps the address already saved.
function addressForSubmit(move, checkId) {
  if (checkId) {
    const last = parseJson(move.last_check);
    if (!CHECK_ID_RE.test(String(checkId)) || !last || !last.result || !last.result.typed) {
      throw new MoveError('no_checked_address', 'Check the address first, then confirm it.', 400);
    }
    if (last.id !== checkId) {
      throw new MoveError('stale_check', 'That address changed in another window. Check it again, then confirm it.', 409);
    }
    return { typed: last.result.typed, normalized: last.result.normalized, verdict: last.result.verdict };
  }
  return {
    typed: move.typed_address || null,
    normalized: parseJson(move.normalized_address),
    verdict: move.address_verdict || null,
  };
}

async function writeOfficeItem(trx, { move, subject, description, now }) {
  const existing = move.service_request_id
    ? await trx('service_requests').where({ id: move.service_request_id }).forUpdate().first()
    : null;
  if (!existing) {
    const [row] = await trx('service_requests').insert({
      customer_id: move.customer_id,
      category: 'moving',
      source: 'moving_page',
      subject,
      description,
      urgency: 'routine',
      status: 'new',
      metadata: JSON.stringify({ moveId: move.id }),
      created_at: now,
      updated_at: now,
    }).returning('*');
    return row;
  }
  const reopen = REQUEST_TERMINAL_STATUSES.includes(existing.status);
  // One request row per move, but each submit is a new customer submission:
  // the Portal inbox ages, sorts and bulk-closes requests by created_at
  // (portal-inbox.js listOpen / closeRequestsOlder), so the row takes the
  // submit time. The move and activity_log keep the history.
  const [row] = await trx('service_requests').where({ id: existing.id }).update({
    subject,
    description,
    created_at: now,
    ...(reopen
      ? { status: 'new', resolved_at: null, status_version: trx.raw('status_version + 1') }
      : {}),
    updated_at: now,
  }).returning('*');
  return row;
}

function alertWhy(normalized, hasAddress, verdict) {
  if (!hasAddress) return 'Moving soon, new address not known yet.';
  const city = normalized && normalized.city ? `New home in ${normalized.city}` : 'New home';
  const area = { in_area: ', in our area', out_of_area: ', outside our area', unverified: ', address not confirmed' }[verdict] || '';
  return cutAtWord(`${city}${area}.`, MAX_WHY_CHARS);
}

async function raiseMoveAlert({ move, customer, request, normalized, hasAddress, verdict, description, submittedAt = new Date() }) {
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'a customer';
  const action = `review ${name}'s move`;
  const notif = await raiseAdminAlert('service', {
    area: 'Customers',
    action: cutAtWord(action, MAX_HEADLINE_CHARS - 'Customers — '.length),
    why: alertWhy(normalized, hasAddress, verdict),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(move.customer_id)}`,
    subject: { type: 'customer', id: move.customer_id },
    doneWhen: 'request_answered',
    who: 'person',
    // A customer reached us: with GATE_ADMIN_BELL_POLICY on, a plain
    // 'service' alert is silenced; a declared contact rings
    // (notification-bell-policy.js step 1b, GATE_CUSTOMER_ALERTS_RING).
    contact: true,
  }, {
    detail: `Category: moving\nSubject: ${request.subject}\n\n${description}`,
    icon: '🚚',
    dedupeKey: `moving:${move.id}`,
    refreshOnDedupe: true,
    // Each submit is a new revision of the one request (its created_at and
    // updated_at = this submit): the version makes the standing alert refresh
    // and ring, and askedAt moves its close boundary to this submit, so an
    // answer to this revision resolves both the alert and the request
    // (admin-alert-relevance resolveRequestOf -> portal-inbox
    // resolveRequestQuietly: updated_at <= askedAt).
    dedupeVersion: submittedAt.toISOString(),
    metadata: {
      askedAt: submittedAt.toISOString(),
      requestId: request.id,
      customerId: move.customer_id,
      moveId: move.id,
      category: 'moving',
      urgency: 'routine',
    },
  });
  if (!notif) {
    logger.error(`[customer-moves] admin alert did not persist for move ${move.id}; the office item ${request.id} is durable`);
  } else if (notif.suppressed) {
    logger.warn(`[customer-moves] admin alert suppressed (${notif.reason || 'no reason'}) for move ${move.id}; the office item ${request.id} is durable`);
  }
}

function checkSubmitInput({ typed, moveOut }) {
  if (!typed && !moveOut) {
    throw new MoveError('need_something', 'Add a checked address or a move-out date.', 400);
  }
}

async function saveSubmit(move, { checkId, moveOut, moveIn, services, now }) {
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    if (!locked || locked.status === 'closed') throw new MoveError('closed', 'This link is no longer open.', 404);
    // Read the checked address from the LOCKED row, never from the copy loaded
    // at the start of the request: a check that landed in between is the one
    // the customer just confirmed.
    const address = addressForSubmit(locked, checkId);
    checkSubmitInput({ typed: address.typed, moveOut });
    const customer = await trx('customers').where({ id: locked.customer_id }).first('id', 'first_name', 'last_name');
    const hasAddress = !!address.typed;
    const description = requestDescription({ ...address, moveOut, moveIn, services });
    const subject = requestSubject(address.normalized, hasAddress);
    // Moving PR B1: a new-home estimate was priced for the address on file. A
    // resubmitted address that is not that house takes the estimate off the
    // customer's surfaces (moveLinkBlock) and frees the card for a new one.
    const estimateSuperseded = !!locked.estimate_id
      && !addressMatchesMove(addressLine(parseJson(locked.normalized_address)), { normalized_address: address.normalized });
    const request = await writeOfficeItem(trx, {
      move: locked,
      subject,
      description: estimateSuperseded
        ? `${description}\nThe new address is not the one the new-home estimate was made for, so the customer can no longer open or accept that estimate. Make a new estimate from the Moving card.`
        : description,
      now,
    });
    const [updated] = await trx('customer_moves').where({ id: locked.id }).update({
      typed_address: address.typed,
      normalized_address: address.normalized ? JSON.stringify(address.normalized) : null,
      address_verdict: address.typed ? address.verdict : null,
      move_out_date: moveOut,
      move_in_date: moveIn,
      service_request_id: request.id,
      status: 'submitted',
      submitted_at: now,
      updated_at: now,
    }).returning('*');
    await trx('activity_log').insert({
      customer_id: locked.customer_id,
      action: 'moving_submitted',
      description: `Customer sent their move: ${subject.replace(/^Moving: /, '')}`,
      metadata: JSON.stringify({ move_id: locked.id, service_request_id: request.id, address_verdict: address.verdict || null }),
    });
    return { updated, request, customer, description, address };
  });
}

/**
 * Save the customer's move. `checkId` names the address check the customer
 * confirmed (the /check answer); the browser never sends an address or a
 * verdict. Returns { move, request, view }.
 */
async function submitMove(move, { checkId = null, moveOutDate, moveInDate } = {}, { now = new Date() } = {}) {
  const moveOut = cleanDate(moveOutDate, 'move-out date', now);
  const moveIn = cleanDate(moveInDate, 'move-in date', now);
  const services = await planServiceNames(move.customer_id);
  const saved = await saveSubmit(move, { checkId: checkId || null, moveOut, moveIn, services, now });
  try {
    await raiseMoveAlert({
      move: saved.updated,
      customer: saved.customer,
      request: saved.request,
      normalized: saved.address.normalized,
      hasAddress: !!saved.address.typed,
      verdict: saved.address.verdict,
      description: saved.description,
      submittedAt: now,
    });
  } catch (err) {
    logger.error(`[customer-moves] alert failed for move ${move.id} (${errCode(err)})`);
  }
  return { move: saved.updated, request: saved.request, view: await publicMoveView(saved.updated) };
}

// The fixed sentences the page shows after a submit. No model writes these.
function receiptFor(view) {
  const first = view.firstName;
  if (!view.addressOnFile) {
    return [`Thanks, ${first}. We have your move dates. When you know your new address, open this same link and add it.`];
  }
  if (view.verdict === 'out_of_area') {
    return [`Thanks, ${first}. We do not serve that address yet. We will contact you about your last visit and ending your plan on your move-out date.`];
  }
  const base = `Thanks, ${first}. We have your move. We will price your new home and send it to you to review. Nothing changes until you approve it.`;
  return view.verdict === 'unverified'
    ? [base, 'We could not confirm that address, so we will check it with you.']
    : [base];
}

// ── Office email ────────────────────────────────────────────────────────────

/**
 * Email the moving link to the customer, on a staff click. The sender keeps the
 * same recipient and opt-out checks as the other account emails. On success the
 * move records when, by whom and how the link went out.
 */
async function sendMovingEmail({ customerId, actorId = null }) {
  const move = await openMoveForCustomer(customerId, { actorId });
  const url = await movingLinkFor(move);
  const AccountMembershipEmail = require('./account-membership-email');
  const result = await AccountMembershipEmail.sendMovingLink({ customerId, moveId: move.id, movingUrl: url, actorId });
  if (result && result.ok) await markLinkSent([move.id], { channel: 'email', actorId });
  return { ok: !!(result && result.ok), sent: !!(result && result.ok), reason: result && !result.ok ? (result.reason || 'email_not_sent') : null, moveId: move.id };
}

// Record that the link went out ('email' from the card, 'sms' from a real
// composer send that carried it), for the card's status line. A closed move
// is left alone.
async function markLinkSent(moveIds, { channel, actorId = null, now = new Date() } = {}) {
  const ids = [...new Set((moveIds || []).filter(Boolean).map(String))];
  if (!ids.length) return 0;
  return db('customer_moves')
    .whereIn('id', ids)
    .whereNot({ status: 'closed' })
    .update({ link_sent_at: now, link_sent_by: actorId || null, link_channel: channel, updated_at: now });
}

// Where the card's "Text moving link" opens: the customer's SMS thread when
// one exists, else a new text to their phone (PortalInboxTabV2.replyHref and
// portal-inbox.js HAS_TEXTS_SQL pick the same way).
async function textTarget(customerId) {
  const row = await db('customers as c')
    .where('c.id', customerId)
    .first('c.phone', db.raw('EXISTS (SELECT 1 FROM sms_log sl WHERE sl.customer_id = c.id) AS has_texts'));
  return { phone: (row && row.phone) || null, hasTexts: !!(row && row.has_texts) };
}

// The latest moves for the Customer 360 Moving card.
async function recentMoves(customerId, limit = 5) {
  const rows = await db('customer_moves')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'customer_id', 'status', 'closed_reason', 'link_sent_at', 'link_channel', 'submitted_at', 'typed_address',
      'normalized_address', 'address_verdict', 'move_out_date', 'move_in_date', 'service_request_id', 'estimate_id', 'applied_at');
  return rows.map((row) => ({
    ...row,
    move_out_date: dateOnlyString(row.move_out_date) || null,
    move_in_date: dateOnlyString(row.move_in_date) || null,
  }));
}


// ── New-home estimate (moving PR B1, GATE_MOVING_ESTIMATE) ──────────────────
//
// The office starts the new house's estimate from the Moving card. The server
// owns three things: which moves may get one, the $99 setup-fee waiver on it
// (owner Q2: waived for every move), and the link back to the move. B1 serves
// customers billed per visit; an annual prepay (owner Q3: keeps its paid price
// until renewal) and a monthly membership move in a later PR, so both are
// refused here.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The billing lanes a new-home estimate serves (billing-lane.js resolveBillingLane).
const NEW_HOME_BILLING_MODES = new Set(['per_application', 'per_visit']);
const LIVE_VISIT_STATUSES = ['pending', 'confirmed', 'rescheduled'];
const DEAD_ESTIMATE_STATUSES = ['declined', 'expired'];
const MOVE_WAIVER_REASON = 'Customer is moving: the $99 setup fee is waived for every move (owner 2026-11-02, Q2).';
const NEW_HOME_REFUSALS = {
  gate_off: 'New-home estimates are off.',
  not_found: 'That move was not found for this customer.',
  not_submitted: 'The customer has not sent the new address yet.',
  out_of_area: 'The new address is outside our service area.',
  no_address: 'The new address is not complete.',
  customer_gone: 'This customer record is not active.',
  prepay: 'This customer prepays for the year. New-home estimates for prepay plans come in a later update.',
  monthly: 'This customer pays a monthly membership. New-home estimates for monthly plans come in a later update.',
  billing: 'This customer\'s billing plan is not one the new-home estimate handles yet.',
  no_plan: 'This customer has no recurring plan to move. Make a normal estimate instead.',
  estimate_exists: 'This move already has a new-home estimate. Open that one instead.',
};
// Plan services the new-home estimate does not copy, and why.
const LEFT_OUT = [
  { re: /termite/i, reason: 'Termite stations and treatments stay with the old house.' },
  { re: /mist/i, reason: 'The misting system stays with the old house.' },
  { re: /palm/i, reason: 'Palm treatments depend on the palms at the new home. Add them after counting.' },
];

function newHomeError(code, status = 409) {
  return new MoveError(code, NEW_HOME_REFUSALS[code] || 'This move is not ready for a new-home estimate.', status);
}

function addressComplete(n) {
  return !!(n && n.line1 && n.city && n.state && n.zip);
}

// The move's live estimate, or null: not declined, expired or archived, and
// the move still stands behind its stamp (moveRowBlock, the same rule the
// customer-surface guard reads), so the card and the guard never disagree.
async function liveMoveEstimate(move, conn = db) {
  if (!move || !move.estimate_id) return null;
  const estimate = await conn('estimates')
    .where({ id: move.estimate_id })
    .whereNull('archived_at')
    .whereNotIn('status', DEAD_ESTIMATE_STATUSES)
    .first('id', 'status', 'estimate_data');
  const stamp = estimate && (parseJson(estimate.estimate_data) || {}).move;
  if (!stamp || typeof stamp !== 'object' || moveRowBlock(move, stamp)) return null;
  return { id: estimate.id, status: estimate.status };
}

// Why this move cannot get a new-home estimate (a NEW_HOME_REFUSALS code), or null.
async function newHomeBlock(move, conn = db) {
  if (move.status !== 'submitted') return 'not_submitted';
  if (move.address_verdict !== 'in_area') return 'out_of_area';
  if (!addressComplete(parseJson(move.normalized_address))) return 'no_address';
  const customer = await conn('customers')
    .where({ id: move.customer_id })
    .whereNull('deleted_at')
    .first('id', 'billing_mode', 'waveguard_tier', 'monthly_rate');
  if (!customer) return 'customer_gone';
  // The billing code's own lane rule: a legacy row with no mode, a real tier
  // and a monthly rate is a monthly member, not a per-visit customer.
  const { mode } = require('./billing-lane').resolveBillingLane(customer);
  if (mode === 'annual_prepay') return 'prepay';
  if (mode === 'monthly_membership') return 'monthly';
  if (mode === 'one_time') return 'no_plan';
  if (!NEW_HOME_BILLING_MODES.has(mode)) return 'billing';
  // A prepaid visit still on the books is a live prepay term, whatever the mode says.
  const prepaid = await conn('scheduled_services')
    .where({ customer_id: move.customer_id })
    .whereNotNull('annual_prepay_term_id')
    .whereIn('status', LIVE_VISIT_STATUSES)
    .first('id');
  return prepaid ? 'prepay' : null;
}

/** The Moving card's new-home action for one move: null, or { action, estimateId, reason }. */
async function newHomeAction(move, conn = db) {
  if (!movingEstimateLive() || !move || move.status !== 'submitted') return null;
  const existing = await liveMoveEstimate(move, conn);
  if (existing) return { action: 'open', estimateId: existing.id, reason: null };
  const block = await newHomeBlock(move, conn);
  if (block) return { action: 'blocked', estimateId: null, reason: NEW_HOME_REFUSALS[block] };
  return { action: 'start', estimateId: null, reason: null };
}

/**
 * Does this estimate address name the move's new house? Same street (unit-aware)
 * and at least one matching locality field (city or ZIP) on both sides.
 */
function addressMatchesMove(address, move) {
  return sameAddressLine(addressLine(parseJson(move && move.normalized_address)), address);
}

// Two one-line addresses name the same house: same street (unit-aware) and at
// least one matching locality field (city or ZIP) on both sides.
function sameAddressLine(a, b) {
  const { makeEstimateScopeKeys, sameScopeKey, scopeKeysShareLocality } = require('./estimate-property-linkage');
  const x = makeEstimateScopeKeys(String(a || ''));
  const y = makeEstimateScopeKeys(String(b || ''));
  if (!x || !y || !x.estimateKey || !y.estimateKey) return false;
  return sameScopeKey(x.estimateKey, y.estimateKey) && scopeKeysShareLocality(x.estimateKey, y.estimateKey);
}

// The newest accepted builder estimate, preferring the house being left.
async function sourceEstimateFor(move, conn = db) {
  const rows = await conn('estimates')
    .where({ customer_id: move.customer_id, status: 'accepted' })
    .orderBy([{ column: 'accepted_at', order: 'desc', nulls: 'last' }, { column: 'created_at', order: 'desc' }])
    .limit(10)
    .select('id', 'property_id', 'estimate_data');
  const usable = rows
    .map((row) => ({ row, inputs: (parseJson(row.estimate_data) || {}).inputs }))
    .filter(({ inputs }) => inputs && typeof inputs === 'object' && !Array.isArray(inputs));
  const pick = usable.find(({ row }) => move.from_property_id && String(row.property_id || '') === String(move.from_property_id))
    || usable[0];
  return pick ? { estimateId: pick.row.id, inputs: pick.inputs } : null;
}

// Today's live recurring plan, one line per service and cadence.
async function planServicesFor(customerId, conn = db) {
  const rows = await conn('scheduled_services')
    .where({ customer_id: customerId, recurring_ongoing: true })
    .where(function notCallback() { this.whereNull('is_callback').orWhere('is_callback', false); })
    .whereNotNull('service_type')
    .distinct('service_type', 'recurring_pattern')
    .orderBy('service_type');
  return rows
    .map((r) => ({
      name: String(r.service_type || '').trim(),
      frequency: String(r.recurring_pattern || '').replace(/_/g, ' ').trim() || null,
    }))
    .filter((r) => r.name);
}

/**
 * Everything the estimator needs to start the new house's estimate. Throws a
 * MoveError (404 / 409) when the move cannot get one; 409 estimate_exists
 * carries the live estimate's id.
 */
async function moveEstimateSource(customerId, moveId, conn = db) {
  if (!movingEstimateLive()) throw newHomeError('gate_off', 404);
  if (!UUID_RE.test(String(moveId || ''))) throw newHomeError('not_found', 404);
  const move = await conn('customer_moves').where({ id: moveId, customer_id: customerId }).first();
  if (!move) throw newHomeError('not_found', 404);
  const existing = await liveMoveEstimate(move, conn);
  if (existing) {
    const err = newHomeError('estimate_exists');
    err.estimateId = existing.id;
    throw err;
  }
  const block = await newHomeBlock(move, conn);
  if (block) throw newHomeError(block);
  const { isActivePlanCustomer } = require('./waveguard-existing-services');
  const [customer, source, planServices, recurring] = await Promise.all([
    conn('customers').where({ id: customerId }).first('id', 'first_name', 'last_name', 'phone', 'email'),
    sourceEstimateFor(move, conn),
    planServicesFor(customerId, conn),
    isActivePlanCustomer(conn, customerId).catch(() => false),
  ]);
  const leftOut = [];
  for (const svc of planServices) {
    const rule = LEFT_OUT.find(({ re }) => re.test(svc.name));
    if (rule && !leftOut.some((x) => x.name === svc.name)) leftOut.push({ name: svc.name, reason: rule.reason });
  }
  return {
    move: {
      id: move.id,
      address: addressLine(parseJson(move.normalized_address)),
      moveOutDate: dateOnlyString(move.move_out_date) || null,
      moveInDate: dateOnlyString(move.move_in_date) || null,
    },
    customer: {
      id: customer.id,
      name: [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim(),
      phone: customer.phone || null,
      email: customer.email || null,
    },
    isRecurringCustomer: recurring === true,
    source,
    planServices,
    leftOut,
  };
}

/**
 * Read-only check for a preview or a save that names a move: the move row, or
 * a MoveError. The create transaction repeats it under a row lock
 * (lockMoveForEstimate).
 */
async function verifyMoveForEstimate({ moveId, customerId, address }, conn = db) {
  if (!movingEstimateLive()) throw newHomeError('gate_off');
  if (!UUID_RE.test(String(moveId || ''))) throw newHomeError('not_found', 404);
  const move = await conn('customer_moves').where({ id: moveId }).first();
  if (!move || String(move.customer_id) !== String(customerId || '')) throw newHomeError('not_found', 404);
  const block = await newHomeBlock(move, conn);
  if (block) throw newHomeError(block);
  if (!addressMatchesMove(address, move)) {
    throw new MoveError('move_address', `This estimate must be for the new address: ${addressLine(parseJson(move.normalized_address))}.`, 409);
  }
  return move;
}

/**
 * The create transaction's check: locks the move row, repeats every check,
 * refuses a second live estimate, and records the house the customer leaves
 * (their primary property now) so the Multi-Home count can skip it.
 */
async function lockMoveForEstimate(trx, { moveId, customerId, address }) {
  if (!UUID_RE.test(String(moveId || ''))) throw newHomeError('not_found', 404);
  await trx('customer_moves').where({ id: moveId }).forUpdate().first('id');
  const move = await verifyMoveForEstimate({ moveId, customerId, address }, trx);
  const existing = await liveMoveEstimate(move, trx);
  if (existing) {
    const err = newHomeError('estimate_exists');
    err.estimateId = existing.id;
    throw err;
  }
  const primaryId = await primaryPropertyId(move.customer_id, trx);
  if (primaryId && String(primaryId) !== String(move.from_property_id || '')) {
    await trx('customer_moves').where({ id: move.id }).update({ from_property_id: primaryId, updated_at: trx.fn.now() });
    move.from_property_id = primaryId;
  }
  return move;
}

async function attachMoveEstimate(trx, moveId, estimateId) {
  await trx('customer_moves').where({ id: moveId }).update({ estimate_id: estimateId, updated_at: trx.fn.now() });
}

// estimate_data.move: server-owned, carried across every revise. The address
// is the one the estimate was made for (moveLinkBlock compares it).
function moveEstimateStamp(move) {
  return {
    moveId: move.id,
    address: addressLine(parseJson(move.normalized_address)),
    moveOutDate: dateOnlyString(move.move_out_date) || null,
    moveInDate: dateOnlyString(move.move_in_date) || null,
  };
}

/**
 * A new-home estimate's customer-surface verdict, read by the shared estimate
 * guard (utils/estimate-claim-sql.js callSideBlockForEstimateData): null while
 * its move still stands behind it; a reason once the move is gone, was
 * cancelled, or now names another address. Fails closed.
 */
async function moveLinkBlock(conn, data) {
  const stamp = data && data.move;
  if (!stamp || typeof stamp !== 'object' || !stamp.moveId) return null;
  try {
    const move = await conn('customer_moves')
      .where({ id: stamp.moveId })
      .first('id', 'status', 'closed_reason', 'estimate_id', 'normalized_address');
    return moveRowBlock(move, stamp);
  } catch (err) {
    logger.warn(`[customer-moves] move link verdict failed (${errCode(err)})`);
    return 'move_verdict_unavailable';
  }
}

// The linkage rules both readers share: null while the move still stands
// behind the stamped estimate. A replacement estimate (the move now links
// another id) supersedes it for good, even if the address later returns.
function moveRowBlock(move, stamp) {
  if (!move) return 'move_missing';
  if (move.status === 'closed' && move.closed_reason !== 'applied') return 'move_closed';
  if (stamp.estimateId && String(move.estimate_id || '') !== String(stamp.estimateId)) return 'move_superseded';
  if (stamp.address && !addressMatchesMove(stamp.address, move)) return 'move_address_changed';
  return null;
}

/**
 * The conversion-time check every accept path runs (estimate-converter
 * convertEstimate, inside the accept's own transaction). Share-locks the
 * stamped move, so a moving-page resubmit waits for this commit; a move that
 * no longer stands behind the estimate refuses the conversion (409, rolled
 * back with the accept). Returns the move that places the first visit (gate
 * on, submitted, in area) or null.
 */
async function lockMoveForConversion(conn, data) {
  const stamp = data && data.move;
  if (!stamp || typeof stamp !== 'object' || !stamp.moveId) return null;
  const move = await conn('customer_moves')
    .where({ id: stamp.moveId })
    .forShare()
    .first('id', 'customer_id', 'status', 'closed_reason', 'estimate_id', 'address_verdict', 'normalized_address',
      'move_out_date', 'move_in_date', 'from_property_id');
  const block = moveRowBlock(move, stamp);
  if (block) {
    throw Object.assign(new Error('This estimate is no longer available.'), {
      code: 'MOVE_ESTIMATE_STALE', reason: block, status: 409, statusCode: 409, isOperational: true,
    });
  }
  if (!movingEstimateLive() || move.status !== 'submitted' || move.address_verdict !== 'in_area') return null;
  return {
    ...move,
    normalized_address: parseJson(move.normalized_address),
    move_out_date: dateOnlyString(move.move_out_date) || null,
    move_in_date: dateOnlyString(move.move_in_date) || null,
  };
}

// estimate_data.operatorPriceAdjustment with the setup fee waived. `base` is
// the stored row's adjustment on a revise (its other fields are kept), or null
// on a create (a browser never supplies this field for a move).
function withMoveSetupWaiver(base) {
  const adj = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  return {
    type: adj.type === 'PERCENT' || adj.type === 'FIXED' ? adj.type : null,
    value: Number(adj.value) > 0 ? Number(adj.value) : 0,
    label: adj.label || null,
    internalReason: adj.internalReason || MOVE_WAIVER_REASON,
    floorBreachAcknowledged: adj.floorBreachAcknowledged === true,
    waiveSetupFee: true,
  };
}

/**
 * The submitted move this estimate was made for (gate on), with dates as
 * YYYY-MM-DD, or null. A plain read for offers; every commit reads the move
 * under a share lock through lockMoveForConversion instead.
 */
async function moveForEstimate(estimateId, conn = db) {
  if (!movingEstimateLive() || !estimateId) return null;
  const move = await conn('customer_moves')
    .where({ estimate_id: estimateId, status: 'submitted', address_verdict: 'in_area' })
    .first('id', 'customer_id', 'normalized_address', 'move_out_date', 'move_in_date', 'from_property_id');
  if (!move) return null;
  return {
    ...move,
    normalized_address: parseJson(move.normalized_address),
    move_out_date: dateOnlyString(move.move_out_date) || null,
    move_in_date: dateOnlyString(move.move_in_date) || null,
  };
}


// ── Apply move (moving PR B2, GATE_MOVING_APPLY) ────────────────────────────
//
// After the customer accepts the new-home estimate, the office presses "Apply
// move" on the Moving card, reads the preview, and confirms. Apply then:
//   1. makes the new home the primary property (customer-properties
//      changePrimaryProperty: the account address, coordinates and measurements
//      follow it; old-house visits stay pinned to the old house) and saves the
//      estimate's confirmed lawn size on it;
//   2. stops every plan at the old house after the move-out date through the
//      dispatch board's own series cancel (services/recurring-series-cancel.js):
//      visits after move-out are cancelled with no customer text and no
//      late-cancel fee, and the plan stops; visits on or before move-out stay;
//   3. opens the termite station pickup task when Waves-owned stations are
//      rented (cancellation-processor raiseTermiteRetrievalTask, dated after
//      move-out);
//   4. closes the move as applied.
// One-time visits at the old house after move-out are listed for the office,
// never cancelled here. Each step commits on its own and is safe to run again,
// so an Apply that stops partway resumes where it stopped on the next confirm.
// Customers billed per visit only, like B1; annual prepay and monthly members
// are refused until a later PR.

const APPLY_REFUSALS = {
  gate_off: 'Apply move is off.',
  not_found: NEW_HOME_REFUSALS.not_found,
  already_applied: 'This move is already applied.',
  not_submitted: NEW_HOME_REFUSALS.not_submitted,
  out_of_area: NEW_HOME_REFUSALS.out_of_area,
  no_address: NEW_HOME_REFUSALS.no_address,
  customer_gone: NEW_HOME_REFUSALS.customer_gone,
  prepay: 'This customer prepays for the year. Apply move for prepay plans comes in a later update.',
  monthly: 'This customer pays a monthly membership. Apply move for monthly plans comes in a later update.',
  billing: 'This customer\'s billing plan is not one Apply move handles yet.',
  no_plan: 'This customer has no recurring plan to move.',
  no_move_out: 'The customer has not given a move-out date. Ask them to add it with the same moving link.',
  no_estimate: 'Make the new-home estimate first.',
  estimate_not_accepted: 'The customer has not accepted the new-home estimate yet.',
  no_new_property: 'The new home is not saved as a property yet. Check the accepted estimate\'s address.',
  no_new_plan: 'The accepted estimate put no recurring plan on the new home.',
  from_unknown: 'The house the customer is leaving is not saved as a property.',
  primary_changed: 'The customer\'s primary property is not the house they are leaving. Check the properties first.',
  apply_changed: 'The customer, the move or the plans changed since this preview. Read the new preview, then apply again.',
  apply_in_progress: 'Apply move is already running for this move. Wait for it to finish, then refresh.',
  apply_lock_unavailable: 'Apply move could not start. Try again in a moment.',
};
const APPLY_LOCK_NS = 'customer-move-apply';
const SETTLED_VISIT_STATUSES = ['cancelled', 'skipped'];

function applyError(code, status = 409, message = null) {
  return new MoveError(code, message || APPLY_REFUSALS[code] || 'This move cannot be applied.', status);
}

// The calendar day after a YYYY-MM-DD date.
function nextDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function propertyLine(p) {
  if (!p) return '';
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.address_line1, p.address_line2, cityLine].filter(Boolean).join(', ');
}

function visitAddressKey(v) {
  const { addressKey } = require('./customer-properties');
  return addressKey({
    address_line1: v.service_address_line1, address_line2: v.service_address_line2,
    city: v.service_address_city, zip: v.service_address_zip,
  });
}

// Is this visit at the old house? Linked to it, stamped with its address, or
// (before the primary change) unstamped: an unstamped visit reads as the
// primary, and the primary change pins it to the old house.
function visitAtHouse(v, house, { primaryIsHouse }) {
  const { addressKey } = require('./customer-properties');
  if (v.property_id) return String(v.property_id) === String(house.id);
  if (v.service_address_line1) return visitAddressKey(v) === addressKey(house);
  return primaryIsHouse;
}

// Which saved property a series belongs to: customer-properties'
// seriesAgreedPropertyId, plus the case it cannot decide because no live
// visit is linked to a property: every visit at the old house by the rule
// above. Anything else is null (unresolved).
async function seriesHouseId(conn, rootId, customerId, from, { primaryIsFrom }) {
  const { seriesAgreedPropertyId } = require('./customer-properties');
  const agreed = await seriesAgreedPropertyId(rootId, customerId, conn);
  if (agreed) return String(agreed);
  const visits = await conn('scheduled_services')
    .where((q) => q.where('id', rootId).orWhere('recurring_parent_id', rootId))
    .where({ customer_id: customerId })
    .where((q) => q.whereNull('status').orWhereNotIn('status', SETTLED_VISIT_STATUSES))
    .select('property_id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
  if (!visits.length || visits.some((v) => v.property_id)) return null;
  return visits.every((v) => visitAtHouse(v, from, { primaryIsHouse: primaryIsFrom })) ? String(from.id) : null;
}

const SERIES_ROW_COLUMNS = ['id', 'status', 'customer_id', 'service_type', 'scheduled_date', 'annual_prepay_term_id', 'prepaid_amount',
  'recurring_parent_id', 'is_recurring', 'recurring_pattern', 'property_id', 'service_address_line1', 'service_address_line2',
  'service_address_city', 'service_address_zip'];

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const visitDay = (row) => dateOnlyString(row.scheduled_date);
const inSeries = (row) => !!(row.recurring_parent_id || row.is_recurring || row.recurring_pattern);

// One plan or visit in plain words: { name, frequency }.
function planItem(row) {
  return {
    name: String(row.service_type || '').trim() || 'Service',
    frequency: String(row.recurring_pattern || '').replace(/_/g, ' ').trim() || null,
  };
}

function visitView(row) {
  return { id: row.id, date: visitDay(row), name: planItem(row).name };
}

async function activeProperty(conn, customerId, id) {
  if (!id) return null;
  return conn('customer_properties').where({ id, customer_id: customerId, active: true }).first();
}

// The move and its dates, or the refusal that needs no house. Visits after
// move-out stop, but only from today on: an open visit dated between a past
// move-out and today may have been done and not closed out, so it is listed
// for the office and never cancelled here.
async function applyMoveRow(conn, customerId, moveId) {
  if (!movingApplyLive()) throw applyError('gate_off', 404);
  if (!UUID_RE.test(String(moveId || ''))) throw applyError('not_found', 404);
  const move = await conn('customer_moves').where({ id: moveId, customer_id: customerId }).first();
  if (!move) throw applyError('not_found', 404);
  if (move.status === 'closed' && move.closed_reason === 'applied') throw applyError('already_applied');
  const block = await newHomeBlock(move, conn);
  if (block) throw applyError(block);
  const moveOut = dateOnlyString(move.move_out_date);
  if (!moveOut) throw applyError('no_move_out');
  const today = etDateString();
  const cutFrom = nextDay(moveOut);
  return { move, moveOut, today, cutFrom, cancelFrom: cutFrom > today ? cutFrom : today };
}

// The accepted new-home estimate, the house left (from) and the new home (to),
// and whether the primary already moved (a resumed Apply), or the refusal.
async function applyHouses(conn, customerId, move) {
  const estimate = move.estimate_id
    ? await conn('estimates').where({ id: move.estimate_id, customer_id: customerId }).first('id', 'status', 'property_id', 'address', 'estimate_data')
    : null;
  const stamp = estimate ? (parseJson(estimate.estimate_data) || {}).move : null;
  if (!stamp || typeof stamp !== 'object' || moveRowBlock(move, stamp)) throw applyError('no_estimate');
  if (estimate.status !== 'accepted') throw applyError('estimate_not_accepted');
  const to = await activeProperty(conn, customerId, estimate.property_id);
  if (!to || !sameAddressLine(propertyLine(to), addressLine(parseJson(move.normalized_address)))) throw applyError('no_new_property');
  const from = await activeProperty(conn, customerId, move.from_property_id);
  if (!from || sameId(from.id, to.id)) throw applyError('from_unknown');
  const primaryId = await primaryPropertyId(customerId, conn);
  const flipped = sameId(primaryId, to.id);
  if (!flipped && !sameId(primaryId, from.id)) throw applyError('primary_changed');
  if (!flipped) {
    // The primary change's own refusals (a tenant account, a home recorded as
    // a rental, an incomplete address) come before anything is written.
    const { previewManualPropertyChange } = require('./customer-properties');
    await previewManualPropertyChange(customerId, 'primary', {}, to.id, conn).catch((err) => {
      throw err.statusCode < 500 ? applyError(err.code || 'primary_unavailable', 409, err.message) : err;
    });
  }
  return { estimate, to, from, flipped };
}

// The accepted estimate's live series at the new home, as plan lines, and the
// ids of every series that estimate seeded (never an old-house plan).
async function newHomePlan(conn, customerId, { estimate, to, from, flipped }) {
  const roots = await conn('scheduled_services as r')
    .where({ 'r.customer_id': customerId, 'r.source_estimate_id': estimate.id })
    .whereNull('r.recurring_parent_id')
    .where((q) => q.where('r.is_recurring', true).orWhereNotNull('r.recurring_pattern'))
    .where((q) => q.where('r.recurring_ongoing', true).orWhereExists(function liveVisit() {
      this.select(conn.raw('1')).from('scheduled_services as c')
        .whereRaw('(c.id = r.id OR c.recurring_parent_id = r.id)')
        .whereIn('c.status', LIVE_VISIT_STATUSES);
    }))
    .select('r.id', 'r.service_type', 'r.recurring_pattern');
  const plan = [];
  for (const root of roots) {
    if (sameId(await seriesHouseId(conn, root.id, customerId, from, { primaryIsFrom: !flipped }), to.id)) plan.push(planItem(root));
  }
  if (!plan.length) throw applyError('no_new_plan');
  return { plan, rootIds: new Set(roots.map((r) => String(r.id))) };
}

// The old house's plans: which stop (with the visits they cancel and the ones
// before move-out that stay), which belong to another property, and the
// old-house visits left alone: one-time visits from the cancel date on, and
// open visits dated between a past move-out and today.
async function oldHousePlans(conn, customerId, { to, from, flipped, today, cutFrom, cancelFrom }, newRootIds) {
  // Every plan still running, plus any series with a live visit after move-out.
  const ongoing = await conn('scheduled_services')
    .where({ customer_id: customerId, recurring_ongoing: true })
    .whereNull('recurring_parent_id')
    .select('id');
  const afterRows = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', LIVE_VISIT_STATUSES)
    .where('scheduled_date', '>=', cutFrom)
    .orderBy([{ column: 'scheduled_date', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select(SERIES_ROW_COLUMNS);
  const rootIds = [...new Set([
    ...ongoing.map((r) => String(r.id)),
    ...afterRows.filter(inSeries).map((r) => String(r.recurring_parent_id || r.id)),
  ])].filter((id) => !newRootIds.has(id)).sort();

  const stops = [];
  const others = [];
  const unresolved = [];
  for (const rootId of rootIds) {
    const root = await conn('scheduled_services').where({ id: rootId, customer_id: customerId })
      .first('id', 'service_type', 'recurring_pattern', 'recurring_ongoing');
    if (!root) continue;
    const house = await seriesHouseId(conn, rootId, customerId, from, { primaryIsFrom: !flipped });
    if (sameId(house, to.id)) continue;
    if (!sameId(house, from.id)) {
      (house ? others : unresolved).push(planItem(root));
      continue;
    }
    const afterMoveOut = afterRows.filter((r) => String(r.recurring_parent_id || r.id) === rootId);
    if (!afterMoveOut.length && root.recurring_ongoing !== true) continue;
    const kept = await conn('scheduled_services')
      .where((q) => q.where('id', rootId).orWhere('recurring_parent_id', rootId))
      .where({ customer_id: customerId })
      .whereIn('status', LIVE_VISIT_STATUSES)
      .where('scheduled_date', '>=', today)
      .where('scheduled_date', '<', cutFrom)
      .count({ n: '*' })
      .first();
    const targets = afterMoveOut.filter((r) => visitDay(r) >= cancelFrom);
    stops.push({
      rootId, ...planItem(root), serviceType: root.service_type, recurringPattern: root.recurring_pattern,
      targets,
      pastOpen: afterMoveOut.filter((r) => visitDay(r) < cancelFrom),
      cancelCount: targets.length,
      firstCancelDate: targets.length ? visitDay(targets[0]) : null,
      keepCount: Number(kept.n) || 0,
    });
  }
  if (unresolved.length) {
    throw applyError('unresolved_series', 409,
      `These plans could not be tied to one house: ${[...new Set(unresolved.map((u) => u.name))].join(', ')}. Fix their visit addresses first, or move them by hand.`);
  }
  const oldOneOffs = afterRows.filter((r) => !inSeries(r) && visitAtHouse(r, from, { primaryIsHouse: !flipped }));
  return {
    stops,
    others,
    oneOffs: oldOneOffs.filter((r) => visitDay(r) >= cancelFrom).map(visitView),
    pastOpen: [...stops.flatMap((st) => st.pastOpen), ...oldOneOffs.filter((r) => visitDay(r) < cancelFrom)]
      .sort((a, b) => visitDay(a).localeCompare(visitDay(b)) || String(a.id).localeCompare(String(b.id)))
      .map(visitView),
  };
}

// Money already taken for a visit Apply would cancel, or a payable prepay
// invoice: the series cancel refuses both, so the preview refuses first.
async function assertOldVisitsUnpaid(conn, customerId, stops) {
  const targets = stops.flatMap((st) => st.targets);
  if (targets.length) {
    const { findBillingCoveredVisits } = require('../routes/admin-schedule');
    const covered = await findBillingCoveredVisits(conn, targets, { feeRails: false });
    if (covered.size > 0) {
      const [firstId, reason] = [...covered.entries()][0];
      const first = targets.find((t) => t.id === firstId);
      throw applyError('paid_visits', 409,
        `The ${prettyDate(visitDay(first))} ${planItem(first).name} visit at the old house is ${reason}. Handle the billing first, then apply.`);
    }
  }
  const { findPendingPrepayInvoice } = require('./admin-cancellation');
  const { familyOfServiceRow } = require('./cancellation-processor');
  for (const stop of stops) {
    const family = familyOfServiceRow({ service_type: stop.serviceType });
    const pending = await findPendingPrepayInvoice(customerId, family ? [family] : null, conn);
    if (pending) {
      throw applyError('pending_prepay_invoice', 409,
        `An unpaid annual-prepay invoice (${pending.invoice.invoice_number || pending.invoice.id}) is still payable for ${stop.name}. Void it first, then apply.`);
    }
  }
}

/**
 * What Apply move would do for this move, read-only, or a MoveError saying why
 * it cannot run. `version` binds the office's confirm to these facts.
 */
async function applyPlan(customerId, moveId, conn = db) {
  const ctx = await applyMoveRow(conn, customerId, moveId);
  Object.assign(ctx, await applyHouses(conn, customerId, ctx.move));
  const newHome = await newHomePlan(conn, customerId, ctx);
  const old = await oldHousePlans(conn, customerId, ctx, newHome.rootIds);
  await assertOldVisitsUnpaid(conn, customerId, old.stops);
  const { rentedTermiteStationState } = require('./cancellation-processor');
  const stationState = await rentedTermiteStationState(customerId);
  const stations = stationState.rented.length || stationState.flaggedRental
    ? { count: stationState.rented.length, flagged: stationState.flaggedRental === true }
    : null;
  const plan = { ...ctx, ...old, stations, newPlan: newHome.plan };
  // Every fact the preview shows, plus each visit Apply would cancel (its id,
  // date and status) and the rows it acts on, so a confirm made from an older
  // preview is refused (apply_changed).
  plan.version = crypto.createHash('sha256').update(JSON.stringify([
    applyPreviewFacts(plan),
    plan.move.id, new Date(plan.move.updated_at).toISOString(), plan.estimate.id, plan.to.id, plan.from.id, plan.cancelFrom,
    plan.stops.map((st) => [st.rootId, st.targets.map((t) => [String(t.id), visitDay(t), t.status])]),
  ])).digest('hex');
  return plan;
}

// The facts the Moving card's preview shows: plain words, no internal rows.
function applyPreviewFacts(plan) {
  return {
    moveId: plan.move.id,
    fromAddress: propertyLine(plan.from),
    toAddress: propertyLine(plan.to),
    moveOutDate: plan.moveOut,
    moveInDate: dateOnlyString(plan.move.move_in_date) || null,
    primaryChange: !plan.flipped,
    newPlan: plan.newPlan,
    stops: plan.stops.map((s) => ({
      name: s.name, frequency: s.frequency, cancelCount: s.cancelCount, firstCancelDate: s.firstCancelDate, keepCount: s.keepCount,
    })),
    others: plan.others,
    oneOffs: plan.oneOffs,
    pastOpen: plan.pastOpen,
    stations: plan.stations,
  };
}

/** The Apply move preview for the Moving card, or a MoveError. */
async function applyMovePreview(customerId, moveId) {
  const plan = await applyPlan(customerId, moveId);
  return { ...applyPreviewFacts(plan), version: plan.version };
}

// One Apply per move at a time: a session advisory lock on its own pooled
// connection (the same pattern as admin-cancellation acquireCancelCommitLock),
// so the steps can run their own transactions while it is held.
async function acquireApplyLock(moveId) {
  let conn = null;
  try {
    conn = await db.client.acquireConnection();
    const res = await conn.query('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2::text)) AS locked', [APPLY_LOCK_NS, String(moveId)]);
    if (!(res && res.rows && res.rows[0] && res.rows[0].locked === true)) {
      const held = conn;
      conn = null;
      try { await db.client.releaseConnection(held); } catch { /* pool reaps */ }
      throw applyError('apply_in_progress');
    }
  } catch (err) {
    if (conn) { try { await db.client.releaseConnection(conn); } catch { /* pool reaps */ } }
    if (err instanceof MoveError) throw err;
    logger.error(`[customer-moves] apply lock unavailable for move ${moveId} (${errCode(err)})`);
    throw applyError('apply_lock_unavailable', 503);
  }
  return async function release() {
    try {
      await conn.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', [APPLY_LOCK_NS, String(moveId)]);
    } catch (err) {
      // A session still holding the lock must not go back to the pool: knex
      // destroys a __knex__disposed connection, and ending it frees the lock.
      conn.__knex__disposed = err;
      logger.warn(`[customer-moves] apply lock release failed for move ${moveId} (${errCode(err)}); connection disposed`);
    }
    try { await db.client.releaseConnection(conn); } catch { /* pool reaps */ }
  };
}

// The last step: the move closes as applied, under its row lock, only if it
// still names the estimate the plan was read from.
async function closeAppliedMove(plan, { actorId, summary, now }) {
  await db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: plan.move.id }).forUpdate().first();
    if (!locked || locked.status !== 'submitted' || String(locked.estimate_id || '') !== String(plan.estimate.id)) {
      throw applyError('apply_changed');
    }
    await trx('customer_moves').where({ id: locked.id }).update({
      status: 'closed',
      closed_reason: 'applied',
      closed_at: now,
      applied_at: now,
      applied_by: actorId || null,
      to_property_id: plan.to.id,
      updated_at: now,
    });
    await trx('activity_log').insert({
      customer_id: locked.customer_id,
      admin_user_id: actorId || null,
      action: 'moving_applied',
      description: summary,
      metadata: JSON.stringify({
        move_id: locked.id, estimate_id: plan.estimate.id, from_property_id: plan.from.id, to_property_id: plan.to.id,
        move_out_date: plan.moveOut,
      }),
    });
  });
}

// A step that failed: where Apply stopped and what it already did. A refusal
// from the step (a MoveError, the series cancel's 409, the primary change's
// 409) keeps its code and message; anything else is a plain stop.
function applyStepError(err, step, progress) {
  let out = err;
  if (!(err instanceof MoveError)) {
    const status = Number(err.statusCode || err.status) || 500;
    const refused = status < 500;
    out = applyError(refused ? String(err.code || 'apply_refused') : 'apply_failed', refused ? 409 : 500,
      refused ? ((err.body && err.body.error) || err.message) : `Apply move stopped at ${step}. Try again; it resumes where it stopped.`);
  }
  out.progress = progress;
  out.step = step;
  return out;
}

/**
 * Apply the move the office confirmed. `version` is the preview's; a plan
 * that no longer matches it is refused (409 apply_changed) before any write.
 * A step that fails throws a MoveError carrying `progress` (what already
 * happened); confirming again resumes from there.
 */
async function applyMove(customerId, moveId, opts = {}) {
  if (!movingApplyLive()) throw applyError('gate_off', 404);
  if (!UUID_RE.test(String(moveId || ''))) throw applyError('not_found', 404);
  const actorId = opts.actorId || null;
  const release = await acquireApplyLock(moveId);
  const progress = { primaryChanged: false, lawn: null, plansStopped: 0, visitsCancelled: 0, stationTask: false };
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      throw applyStepError(err, name, progress);
    }
  };
  try {
    const plan = await applyPlan(customerId, moveId);
    if (String(opts.version || '') !== plan.version) throw applyError('apply_changed');

    if (!plan.flipped) {
      await step('primary', async () => {
        const { previewManualPropertyChange, changePrimaryProperty } = require('./customer-properties');
        const preview = await previewManualPropertyChange(customerId, 'primary', {}, plan.to.id);
        await changePrimaryProperty(customerId, plan.to.id, { actorId, expectedVersion: preview._version });
        progress.primaryChanged = true;
      });
    }
    // The lawn size is a convenience the office can set by hand: never stop Apply for it.
    progress.lawn = await require('./lawn-size-sync').applyEstimateLawnSqft(db, {
      customerId, estimate: plan.estimate, estimateData: plan.estimate.estimate_data, trigger: 'move_apply', actorId,
    }).then((lawn) => (lawn ? lawn.status : null), (err) => {
      logger.warn(`[customer-moves] lawn size after apply failed for move ${moveId} (${errCode(err)})`);
      return 'failed';
    });

    const { cancelSeriesRemainder } = require('./recurring-series-cancel');
    for (const stop of plan.stops) {
      await step('plans', async () => {
        const out = await cancelSeriesRemainder({
          parentId: stop.rootId,
          customerId,
          serviceType: stop.serviceType,
          recurringPattern: stop.recurringPattern,
          scope: 'following',
          fromDate: plan.cancelFrom,
          notifyCustomer: false,
          notes: `Customer moved out on ${plan.moveOut} (moving flow, Apply move)`,
          actorId,
          waiveFee: true,
          source: 'moving-apply',
          allowEmpty: true,
          // Under the series locks: the same visits the preview approved, still at the old house.
          checkTargets: (locked) => {
            const approved = new Set(stop.targets.map((t) => String(t.id)));
            const same = locked.length === approved.size && locked.every((t) => approved.has(String(t.id)));
            return same && locked.every((t) => visitAtHouse(t, plan.from, { primaryIsHouse: false }))
              ? null
              : `${stop.name} changed while Apply move was running. Read the new preview, then apply again.`;
          },
        });
        progress.plansStopped += 1;
        progress.visitsCancelled += out.cancelledCount;
      });
    }

    if (plan.stations) {
      await step('termite', async () => {
        const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
        const task = await raiseTermiteRetrievalTask(customerId, plan.move.service_request_id, { retrieveAfter: plan.moveOut });
        progress.stationTask = task.raised === true;
      });
    }

    const summary = [
      `New home is primary: ${propertyLine(plan.to)}.`,
      `Old-house plans stopped after ${prettyDate(plan.moveOut)}: ${plan.stops.length} (${progress.visitsCancelled} visits cancelled, no customer text, no fee).`,
      progress.stationTask ? 'Termite station pickup task opened.' : '',
    ].join(' ').trim();
    await step('close', () => closeAppliedMove(plan, { actorId, summary, now: opts.now || new Date() }));
    await require('./portal-inbox')
      .resolveRequestQuietly(plan.move.service_request_id, customerId, 'Move applied from the Moving card.', { notAfter: new Date(), now: new Date() })
      .catch((err) => logger.warn(`[customer-moves] office item close failed for move ${moveId} (${errCode(err)})`));
    logger.info(`[customer-moves] applied move ${moveId} for customer ${customerId} by ${actorId || 'unknown'}`);
    return { applied: true, ...progress, oneOffs: plan.oneOffs, pastOpen: plan.pastOpen, summary };
  } finally {
    await release();
  }
}

/** The Moving card's Apply action for one move: null, or { action: 'review' | 'blocked' | 'applied', reason }. */
async function applyAction(move, conn = db) {
  if (!movingApplyLive() || !move) return null;
  if (move.status === 'closed') return move.closed_reason === 'applied' ? { action: 'applied', reason: null } : null;
  if (move.status !== 'submitted' || !move.estimate_id) return null;
  try {
    await applyPlan(move.customer_id, move.id, conn);
    return { action: 'review', reason: null };
  } catch (err) {
    if (err instanceof MoveError) {
      // Nothing to apply yet: the estimate step owns those moves.
      if (['no_estimate', 'estimate_not_accepted'].includes(err.code)) return null;
      return { action: 'blocked', reason: err.message };
    }
    logger.warn(`[customer-moves] apply action read failed for move ${move.id} (${errCode(err)})`);
    return null;
  }
}

module.exports = {
  MoveError,
  TOKEN_RE,
  DAILY_CHECK_CAP,
  REUSE_WINDOW_MS,
  openMoveForCustomer,
  movingLinkFor,
  loadMoveByToken,
  checkMoveAddress,
  submitMove,
  publicMoveView,
  receiptFor,
  sendMovingEmail,
  markLinkSent,
  recentMoves,
  textTarget,
  planServiceNames,
  NEW_HOME_REFUSALS,
  newHomeAction,
  addressMatchesMove,
  sameAddressLine,
  moveEstimateSource,
  verifyMoveForEstimate,
  lockMoveForEstimate,
  attachMoveEstimate,
  moveEstimateStamp,
  moveLinkBlock,
  lockMoveForConversion,
  withMoveSetupWaiver,
  moveForEstimate,
  APPLY_REFUSALS,
  applyAction,
  applyMovePreview,
  applyMove,
  _private: { cleanDate, cleanTyped, typedUnit, normalizedFrom, reusableCheck, requestDescription, requestSubject, alertWhy, prettyDate, raiseMoveAlert, applyPlan, nextDay, visitAtHouse },
};
