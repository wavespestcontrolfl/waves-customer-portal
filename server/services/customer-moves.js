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
const { movingEstimateLive } = require('../config/feature-gates');

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
    .select('id', 'customer_id', 'status', 'link_sent_at', 'link_channel', 'submitted_at', 'typed_address', 'normalized_address',
      'address_verdict', 'move_out_date', 'move_in_date', 'service_request_id', 'estimate_id');
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
 * YYYY-MM-DD, or null. `lock` share-locks the row for a booking transaction,
 * so a moving-page submit cannot change the dates until that commit.
 */
async function moveForEstimate(estimateId, conn = db, { lock = false } = {}) {
  if (!movingEstimateLive() || !estimateId) return null;
  const query = conn('customer_moves')
    .where({ estimate_id: estimateId, status: 'submitted', address_verdict: 'in_area' });
  if (lock) query.forShare();
  const move = await query.first('id', 'customer_id', 'normalized_address', 'move_out_date', 'move_in_date', 'from_property_id');
  if (!move) return null;
  return {
    ...move,
    normalized_address: parseJson(move.normalized_address),
    move_out_date: dateOnlyString(move.move_out_date) || null,
    move_in_date: dateOnlyString(move.move_in_date) || null,
  };
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
  _private: { cleanDate, cleanTyped, typedUnit, normalizedFrom, reusableCheck, requestDescription, requestSubject, alertWhy, prettyDate, raiseMoveAlert },
};
