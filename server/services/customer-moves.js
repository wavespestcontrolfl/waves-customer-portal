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
 * change a price, change a primary property, or send a message by itself.
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
const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough } = require('./short-url');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { raiseAdminAlert, cutAtWord, MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { validateAddress, STATUSES } = require('./address-validation');
const { moveVerdictLabel } = require('./move-address-verdict');

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

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return etDateString(value);
  return String(value).slice(0, 10);
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
    logger.warn(`[customer-moves] short link failed for move ${move.id}: ${err.message}`);
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
  if (!last || last.key !== key || !last.result || last.providerAnswered !== true) return null;
  const age = now.getTime() - new Date(last.checked_at).getTime();
  if (!Number.isFinite(age) || age < 0 || age >= REUSE_WINDOW_MS) return null;
  return last.result;
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
  if (reused) return { ...reused, reused: true };

  const today = etDateString(now);
  if (!(await claimCheckSlot(move.id, today))) {
    throw new MoveError('check_cap', 'We have checked that address a few times today. Please try again tomorrow, or call us.', 429);
  }

  const verdict = await validateAddress({ addressLines: [typed] });
  const label = moveVerdictLabel(verdict, STATUSES);
  const providerAnswered = !!verdict && verdict.status !== STATUSES.API_UNAVAILABLE && verdict.status !== STATUSES.NOT_ATTEMPTED;
  const result = { typed, normalized: normalizedFrom(verdict, typed), verdict: label };
  await db('customer_moves').where({ id: move.id }).update({
    last_check: JSON.stringify({ key, checked_at: now.toISOString(), providerAnswered, result }),
    updated_at: new Date(),
  });
  return { ...result, reused: false };
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
    moveOutDate: isoDate(move.move_out_date),
    moveInDate: isoDate(move.move_in_date),
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
function addressForSubmit(move, useCheckedAddress) {
  if (useCheckedAddress) {
    const last = parseJson(move.last_check);
    if (!last || !last.result || !last.result.typed) {
      throw new MoveError('no_checked_address', 'Check the address first, then confirm it.', 400);
    }
    return { typed: last.result.typed, normalized: last.result.normalized, verdict: last.result.verdict };
  }
  return {
    typed: move.typed_address || null,
    normalized: parseJson(move.normalized_address),
    verdict: move.address_verdict || null,
  };
}

async function writeOfficeItem(trx, { move, subject, description }) {
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
    }).returning('*');
    return row;
  }
  const reopen = REQUEST_TERMINAL_STATUSES.includes(existing.status);
  const [row] = await trx('service_requests').where({ id: existing.id }).update({
    subject,
    description,
    ...(reopen
      ? { status: 'new', resolved_at: null, status_version: trx.raw('status_version + 1') }
      : {}),
    updated_at: new Date(),
  }).returning('*');
  return row;
}

function alertWhy(normalized, hasAddress, verdict) {
  if (!hasAddress) return 'Moving soon, new address not known yet.';
  const city = normalized && normalized.city ? `New home in ${normalized.city}` : 'New home';
  const area = { in_area: ', in our area', out_of_area: ', outside our area', unverified: ', address not confirmed' }[verdict] || '';
  return cutAtWord(`${city}${area}.`, MAX_WHY_CHARS);
}

async function raiseMoveAlert({ move, customer, request, normalized, hasAddress, verdict, description }) {
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
  }, {
    detail: `Category: moving\nSubject: ${request.subject}\n\n${description}`,
    icon: '🚚',
    dedupeKey: `moving:${move.id}`,
    refreshOnDedupe: true,
    metadata: {
      requestId: request.id,
      customerId: move.customer_id,
      moveId: move.id,
      category: 'moving',
      urgency: 'routine',
    },
  });
  if (!notif) {
    logger.error(`[customer-moves] admin alert did not persist for move ${move.id}; the office item ${request.id} is durable`);
  }
}

function checkSubmitInput({ typed, moveOut }) {
  if (!typed && !moveOut) {
    throw new MoveError('need_something', 'Add a checked address or a move-out date.', 400);
  }
}

async function saveSubmit(move, { useCheckedAddress, moveOut, moveIn, services, now }) {
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    if (!locked || locked.status === 'closed') throw new MoveError('closed', 'This link is no longer open.', 404);
    // Read the checked address from the LOCKED row, never from the copy loaded
    // at the start of the request: a check that landed in between is the one
    // the customer just confirmed.
    const address = addressForSubmit(locked, useCheckedAddress);
    checkSubmitInput({ typed: address.typed, moveOut });
    const customer = await trx('customers').where({ id: locked.customer_id }).first('id', 'first_name', 'last_name');
    const hasAddress = !!address.typed;
    const description = requestDescription({ ...address, moveOut, moveIn, services });
    const subject = requestSubject(address.normalized, hasAddress);
    const request = await writeOfficeItem(trx, { move: locked, subject, description });
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
 * Save the customer's move. `useCheckedAddress` means "use the address the
 * server last checked for this link"; the browser never sends an address or a
 * verdict. Returns { move, request, view }.
 */
async function submitMove(move, { useCheckedAddress = false, moveOutDate, moveInDate } = {}, { now = new Date() } = {}) {
  const moveOut = cleanDate(moveOutDate, 'move-out date', now);
  const moveIn = cleanDate(moveInDate, 'move-in date', now);
  const services = await planServiceNames(move.customer_id);
  const saved = await saveSubmit(move, { useCheckedAddress: useCheckedAddress === true, moveOut, moveIn, services, now });
  try {
    await raiseMoveAlert({
      move: saved.updated,
      customer: saved.customer,
      request: saved.request,
      normalized: saved.address.normalized,
      hasAddress: !!saved.address.typed,
      verdict: saved.address.verdict,
      description: saved.description,
    });
  } catch (err) {
    logger.error(`[customer-moves] alert failed for move ${move.id}: ${err.message}`);
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
  if (result && result.ok) {
    await db('customer_moves').where({ id: move.id }).update({
      link_sent_at: new Date(),
      link_sent_by: actorId || null,
      link_channel: 'email',
      updated_at: new Date(),
    });
  }
  return { ok: !!(result && result.ok), sent: !!(result && result.ok), reason: result && !result.ok ? (result.reason || 'email_not_sent') : null, moveId: move.id };
}

// The latest moves for the Customer 360 Moving card.
async function recentMoves(customerId, limit = 5) {
  return db('customer_moves')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'status', 'link_sent_at', 'link_channel', 'submitted_at', 'typed_address', 'normalized_address',
      'address_verdict', 'move_out_date', 'move_in_date', 'service_request_id');
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
  recentMoves,
  planServiceNames,
  _private: { cleanDate, cleanTyped, typedUnit, normalizedFrom, reusableCheck, requestDescription, requestSubject, alertWhy, prettyDate },
};
