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
 * PR 2b (GATE_MOVING_PAUSE) adds the move pause (owner Q4): a daily job sends
 * one reminder text a week before move-out to a customer with no new address,
 * pauses every plan at the house left for the visits after move-out, and closes the
 * move when no address comes in within 60 days (see the Move pause section).
 *
 * Apply on accept (GATE_MOVING_AUTO_APPLY, owner 2026-11-04 option A): once
 * the customer accepts the new-home estimate, a job applies the move through
 * Apply move's own preview and confirm, with no office click.
 *
 * The old-house stop (GATE_MOVING_STOP_AT_MOVE_OUT, owner 2026-11-04) runs the
 * same pause step for a customer who gave the new address but whose move is not
 * applied by the move-out day: the plans at the house left stop after the
 * move-out date, and the move stays open for the new-home estimate and Apply
 * move.
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
const { movingEstimateLive, movingApplyLive, movingAutoApplyLive, movingPauseLive, movingStopAtMoveOutLive } = require('../config/feature-gates');

const TOKEN_RE = /^[a-f0-9]{48}$/;
const DAILY_CHECK_CAP = 10;
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 200;
const DATE_PAST_DAYS = 60;
const DATE_FUTURE_DAYS = 400;
const LIVE_STATUSES = ['open', 'submitted'];
// One advisory key per move, shared by Apply move (a session lock held for the
// whole apply) and the customer's submit (a transaction lock), so a resubmit
// waits for a running Apply instead of changing the move under it.
const MOVE_FENCE_NS = 'customer-move-apply';
// The longest move pause (owner Q4): move-out + 60 days.
const PAUSE_DAYS = 60;
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

function requestDescription({ typed, normalized, verdict, moveOut, moveIn, services, billing = null }) {
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
  if (billing) lines.push(billing);
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
    // (notification-bell-policy.js step 1b).
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

async function saveSubmit(move, { checkId, moveOut, moveIn, services, billing = null, now }) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [MOVE_FENCE_NS, String(move.id)]);
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    if (!locked || locked.status === 'closed') throw new MoveError('closed', 'This link is no longer open.', 404);
    // Read the checked address from the LOCKED row, never from the copy loaded
    // at the start of the request: a check that landed in between is the one
    // the customer just confirmed.
    const address = addressForSubmit(locked, checkId);
    checkSubmitInput({ typed: address.typed, moveOut });
    const customer = await trx('customers').where({ id: locked.customer_id }).first('id', 'first_name', 'last_name');
    const hasAddress = !!address.typed;
    const description = requestDescription({ ...address, moveOut, moveIn, services, billing });
    const subject = requestSubject(address.normalized, hasAddress);
    // Moving PR B1: a new-home estimate was priced for the address on file. A
    // resubmitted address that is not that house takes the estimate off the
    // customer's surfaces (moveLinkBlock) and frees the card for a new one.
    const estimateSuperseded = !!locked.estimate_id
      && !addressMatchesMove(addressLine(parseJson(locked.normalized_address)), { normalized_address: address.normalized });
    // Moving PR 2b: the pause already stopped the old-house visits after the
    // old move-out date. A new date leaves those visits to the office to
    // check, and the job never ends this move on the old date's deadline.
    // The app-made new-home estimate (GATE_MOVING_AUTO_ESTIMATE) tries the
    // address on file once: an attempt for another address, finished or still
    // running, is cleared, so the new address gets its own. A running attempt
    // then finds its claim gone and ends without marking the move.
    const autoEstimateReset = !!(locked.auto_estimate_state || locked.auto_estimate_at)
      && (addressLine(parseJson(locked.normalized_address)) || '') !== (addressLine(address.normalized) || '');
    const oldMoveOut = dateOnlyString(locked.move_out_date) || null;
    const pauseNote = locked.pause_state === 'paused' && oldMoveOut !== moveOut
      ? `The customer changed the move-out date to ${prettyDate(moveOut) || 'not known yet'} after the pause stopped the old-house visits after ${prettyDate(oldMoveOut)}. Check those visits against the new date.`
      : null;
    const request = await writeOfficeItem(trx, {
      move: locked,
      subject,
      description: [estimateSuperseded
        ? `${description}\nThe new address is not the one the new-home estimate was made for, so the customer can no longer open or accept that estimate. Make a new estimate from the Moving card.`
        : description, pauseNote].filter(Boolean).join('\n'),
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
      ...(pauseNote ? { pause_state: 'office', pause_note: pauseNote.slice(0, 300) } : {}),
      ...(autoEstimateReset ? { auto_estimate_at: null, auto_estimate_state: null, auto_estimate_note: null } : {}),
    }).returning('*');
    await trx('activity_log').insert({
      customer_id: locked.customer_id,
      action: 'moving_submitted',
      description: `Customer sent their move: ${subject.replace(/^Moving: /, '')}`,
      metadata: JSON.stringify({ move_id: locked.id, service_request_id: request.id, address_verdict: address.verdict || null }),
    });
    return { updated, request, customer, description: pauseNote ? `${description}\n${pauseNote}` : description, address };
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
  // A failed read leaves the line out; it never blocks the customer's submit.
  const billing = await billingLine(db, move.customer_id, now).catch((err) => {
    logger.warn(`[customer-moves] billing line read failed for move ${move.id} (${errCode(err)})`);
    return null;
  });
  const saved = await saveSubmit(move, { checkId: checkId || null, moveOut, moveIn, services, billing, now });
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
  return {
    move: saved.updated,
    request: saved.request,
    view: await publicMoveView(saved.updated),
    pauseLane: await pauseLane(saved.updated),
  };
}

// The fixed sentences the page shows after a submit. No model writes these.
// `pauseLane` (pauseLane below): what the daily move job will do after the
// move-out date (the pause with no new address, the old-house stop with one),
// so the receipt never promises a pause or a stop the job will not run.
function receiptFor(view, pauseLane = null) {
  const first = view.firstName;
  const day = prettyDate(view.moveOutDate);
  if (!view.addressOnFile) {
    if (pauseLane === 'auto' && day) {
      return [`Thanks, ${first}. We have your move dates. We pause your visits after ${day} until we have your new address, for up to ${PAUSE_DAYS} days. When you know it, open this same link and add it.`];
    }
    if (pauseLane === 'office' && day) {
      return [`Thanks, ${first}. We have your move dates. We will contact you about the visits booked after ${day}. When you know your new address, open this same link and add it.`];
    }
    return [`Thanks, ${first}. We have your move dates. When you know your new address, open this same link and add it.`];
  }
  if (view.verdict === 'out_of_area') {
    return [`Thanks, ${first}. We do not serve that address yet. We will contact you about your last visit and ending your plan on your move-out date.`];
  }
  // The old-house stop cancels the visits after move-out whether or not the
  // customer approves the new price, so the receipt says so.
  const base = pauseLane === 'auto' && day
    ? `Thanks, ${first}. We have your move. We will price your new home and send it to you to review. Your plan at the new home starts when you approve it. We cancel the visits booked at your old home after ${day}.`
    : `Thanks, ${first}. We have your move. We will price your new home and send it to you to review. Nothing changes until you approve it.`;
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
    .select('id', 'customer_id', 'status', 'closed_reason', 'closed_at', 'link_sent_at', 'link_channel', 'submitted_at', 'typed_address',
      'normalized_address', 'address_verdict', 'move_out_date', 'move_in_date', 'service_request_id', 'estimate_id', 'applied_at',
      'pause_reminder_at', 'pause_reminder_sent', 'pause_state', 'paused_at', 'pause_ends_on', 'pause_note');
  return rows.map((row) => ({
    ...row,
    move_out_date: dateOnlyString(row.move_out_date) || null,
    move_in_date: dateOnlyString(row.move_in_date) || null,
    pause_ends_on: dateOnlyString(row.pause_ends_on) || null,
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
const UNDERWAY_STATUSES = ['en_route', 'on_site'];
const DEAD_ESTIMATE_STATUSES = ['declined', 'expired'];
const MOVE_WAIVER_REASON = 'Customer is moving: the $99 setup fee is waived for every move (owner 2026-11-02, Q2).';
const NEW_HOME_REFUSALS = {
  gate_off: 'New-home estimates are off.',
  not_found: 'That move was not found for this customer.',
  not_submitted: 'The customer has not sent the new address yet.',
  out_of_area: 'The new address is outside our service area.',
  no_address: 'The new address is not complete.',
  customer_gone: 'This customer record is not active.',
  prepay: 'This customer prepays for the year. The new home\'s price starts with next year\'s prepay, so make no estimate now.',
  monthly: 'This customer pays a monthly membership. Set the new home\'s price by hand, never with an estimate.',
  billing: 'This customer\'s billing plan is not one the new-home estimate handles yet.',
  no_plan: 'This customer has no recurring plan to move. Make a normal estimate instead.',
  estimate_exists: 'This move already has a new-home estimate. Open that one instead.',
};
// What the office does by hand for a move the flow refuses on billing (owner
// 2026-11-04, B3 "A"). A paid annual prepay keeps its paid price, and the new
// home's price starts with next year's prepay; a monthly member's new price is
// set by hand. An accepted estimate would switch a prepay to per-visit billing,
// book a second plan and close the year-end prepay bell, and would add a
// monthly member's new price on top of the old one. The Edit appointment
// address change moves every open visit of the plan, so it waits for the last
// visit before move-out.
const MOVE_VISITS_STEPS = [
  'Add the new home with Add service address on this customer\'s page.',
  'After the last visit at the old house before move-out is done, open the next visit\'s Edit appointment and pick the new home under Service address. That moves the plan\'s remaining visits.',
  'Termite, misting and palm treatments stay with the old house.',
];
const BILLING_STEPS = {
  prepay: [
    'Send no estimate the customer can accept this year.',
    ...MOVE_VISITS_STEPS,
    'The moved visits keep their paid price: nothing is charged or refunded.',
    'At year end the prepay bell asks for next year\'s prepay. Send it at the new home\'s price: the visits times the new visit price, less 5%.',
  ],
  monthly: [
    'Send no estimate: an accept adds the new price on top of the old one.',
    ...MOVE_VISITS_STEPS,
    'On the first billing day after move-out, set the new monthly price by hand.',
  ],
};
// A refusal's steps, for the card: { steps } or nothing.
const billingSteps = (code) => (BILLING_STEPS[code] ? { steps: BILLING_STEPS[code] } : {});
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
  return billingBlock(conn, move.customer_id);
}

// Why this customer's billing is not one the moving flow handles yet (a
// NEW_HOME_REFUSALS code), or null for a customer billed per visit.
async function billingBlock(conn, customerId) {
  const customer = await conn('customers')
    .where({ id: customerId })
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
    .where({ customer_id: customerId })
    .whereNotNull('annual_prepay_term_id')
    .whereIn('status', LIVE_VISIT_STATUSES)
    .first('id');
  return prepaid ? 'prepay' : null;
}

// The last day of the customer's paid, live prepay year (not a termite plan's),
// as YYYY-MM-DD, or null.
async function prepayPaidThrough(conn, customerId, today) {
  const row = await require('./annual-prepay-renewals').coveredTermsAsOf(conn, today)
    .where('t.customer_id', customerId)
    .whereNull('t.annual_plan_version')
    .first(conn.raw("to_char(max(t.term_end), 'YYYY-MM-DD') as term_end"));
  return (row && row.term_end) || null;
}

// The office item's billing line (owner 2026-11-04, B3 "A"), so whoever
// answers the move sees a prepaid year or a monthly membership before pricing
// the new home. Null when there is no plan to describe.
async function billingLine(conn, customerId, now = new Date()) {
  const block = await billingBlock(conn, customerId);
  if (block === null) return 'Billing: per visit.';
  if (block === 'prepay') {
    const through = prettyDate(await prepayPaidThrough(conn, customerId, etDateString(now)));
    return `Billing: annual prepay${through ? `, paid through ${through}` : ''}. Make no estimate the customer can accept this year: follow the steps on the Moving card.`;
  }
  if (block === 'monthly') return 'Billing: monthly membership. Set the new price by hand, never with an estimate: follow the steps on the Moving card.';
  return null;
}

/** The Moving card's new-home action for one move: null, or { action, estimateId, reason, steps? }. */
async function newHomeAction(move, conn = db) {
  if (!movingEstimateLive() || !move || move.status !== 'submitted') return null;
  const existing = await liveMoveEstimate(move, conn);
  if (existing) return { action: 'open', estimateId: existing.id, reason: null };
  const block = await newHomeBlock(move, conn);
  if (block) return { action: 'blocked', estimateId: null, reason: NEW_HOME_REFUSALS[block], ...billingSteps(block) };
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
  prepay: 'This customer prepays for the year. Apply move does not move a prepaid plan: follow the steps.',
  monthly: 'This customer pays a monthly membership. Apply move does not move a monthly plan: follow the steps.',
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
  apply_in_progress: 'This move is busy: Apply move or a customer update is running. Wait a moment, then refresh.',
  apply_lock_unavailable: 'Apply move could not start. Try again in a moment.',
};
const SETTLED_VISIT_STATUSES = ['cancelled', 'skipped'];

function applyError(code, status = 409, message = null) {
  return new MoveError(code, message || APPLY_REFUSALS[code] || 'This move cannot be applied.', status);
}

// The calendar date `days` after a YYYY-MM-DD date.
function plusDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const nextDay = (iso) => plusDays(iso, 1);

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
// A visit of a recurring series: a child of one, or a root marked recurring.
// 'one_time' is the codebase's one-time cadence marker (area add-on rows,
// hand-repaired rows; recurring-schedule-audit and visit-prep skip it), never a plan.
const ONE_TIME_PATTERN = 'one_time';
const inSeries = (row) => !!(row.recurring_parent_id
  || ((row.is_recurring || row.recurring_pattern) && row.recurring_pattern !== ONE_TIME_PATTERN));

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
  // The primary change's own preview: its refusals (a tenant account, a home
  // recorded as a rental, an incomplete address) come before anything is
  // written, and its version binds the write to what the office confirmed.
  const primaryVersion = flipped ? null : await require('./customer-properties')
    .previewManualPropertyChange(customerId, 'primary', {}, to.id, conn)
    .then((preview) => preview._version, (err) => {
      throw err.statusCode < 500 ? applyError(err.code || 'primary_unavailable', 409, err.message) : err;
    });
  return { estimate, to, from, flipped, primaryVersion };
}

// The accepted estimate's live series at the new home, as plan lines, and the
// ids of every series that estimate seeded (never an old-house plan).
async function newHomePlan(conn, customerId, { estimate, to, from, flipped }) {
  const roots = await conn('scheduled_services as r')
    .where({ 'r.customer_id': customerId, 'r.source_estimate_id': estimate.id })
    .whereNull('r.recurring_parent_id')
    .where((q) => q.where('r.is_recurring', true).orWhereNotNull('r.recurring_pattern'))
    .where((q) => q.whereNull('r.recurring_pattern').orWhereNot('r.recurring_pattern', ONE_TIME_PATTERN))
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
// open visits dated between a past move-out and today. `to` is null for the
// move pause (no new home yet).
async function oldHousePlans(conn, customerId, { to, from, flipped, today, cutFrom, cancelFrom }, newRootIds) {
  // Every plan still running, plus any series with a live visit after move-out.
  const ongoing = await conn('scheduled_services')
    .where({ customer_id: customerId, recurring_ongoing: true })
    .whereNull('recurring_parent_id')
    .select('id');
  // A legacy NULL status is a live visit too (20260829000050's rule), and so is
  // one under way (en route, on site).
  const afterRows = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .where((q) => q.whereIn('status', [...LIVE_VISIT_STATUSES, ...UNDERWAY_STATUSES]).orWhereNull('status'))
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
      .first('id', 'service_type', 'is_recurring', 'recurring_pattern', 'recurring_ongoing', 'recurring_parent_id');
    // A one-time visit flagged ongoing is not a plan: it is listed with the one-time visits.
    if (!root || !inSeries(root)) continue;
    const house = await seriesHouseId(conn, rootId, customerId, from, { primaryIsFrom: !flipped });
    if (to && sameId(house, to.id)) continue;
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
  // The series cancel only cancels pending, confirmed and rescheduled visits:
  // a plan visit under way, or a legacy one with no status, would stay active
  // after its plan stopped, so Apply waits for it.
  const named = (rows) => rows.map((r) => `${planItem(r).name} ${prettyDate(visitDay(r))}`).join(', ');
  const planVisits = stops.flatMap((st) => st.targets);
  const underway = planVisits.filter((r) => UNDERWAY_STATUSES.includes(r.status));
  if (underway.length) {
    throw applyError('visit_underway', 409, `A visit at the old house is under way: ${named(underway)}. Let the technician finish it first.`);
  }
  const noStatus = planVisits.filter((r) => r.status == null);
  if (noStatus.length) {
    throw applyError('legacy_visits', 409, `These visits at the old house have no status: ${named(noStatus)}. Give each one a status on the schedule first.`);
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
        `The ${prettyDate(visitDay(first))} ${planItem(first).name} visit at the old house is ${reason}. Handle the billing first.`);
    }
  }
  const { findPendingPrepayInvoice } = require('./admin-cancellation');
  const { familyOfServiceRow } = require('./cancellation-processor');
  for (const stop of stops) {
    const family = familyOfServiceRow({ service_type: stop.serviceType });
    const pending = await findPendingPrepayInvoice(customerId, family ? [family] : null, conn);
    if (pending) {
      throw applyError('pending_prepay_invoice', 409,
        `An unpaid annual-prepay invoice (${pending.invoice.invoice_number || pending.invoice.id}) is still payable for ${stop.name}. Void it first.`);
    }
  }
}

// Stop one plan at the house left, after the move-out date: Apply move's and
// the move pause's cancel, through the dispatch board's series cancel. No
// customer text and no late-cancel fee. Linked follow-ups (call visit 2,
// package visit 2) are not part of the plan: they are listed with the one-time
// visits, so none is cancelled. Under the series locks it re-checks exactly
// the visits the plan approved (same date and status), and that every live
// visit of the series, the root and the ones that stay included, is still at
// the house left (`primaryIsHouse(trx)`: whether an unstamped visit reads as
// that house, decided inside the cancel's transaction).
async function stopHousePlan(stop, { customerId, cancelFrom, note, actorId, source, house, primaryIsHouse, changed }) {
  const { cancelSeriesRemainder } = require('./recurring-series-cancel');
  return cancelSeriesRemainder({
    parentId: stop.rootId,
    customerId,
    serviceType: stop.serviceType,
    recurringPattern: stop.recurringPattern,
    scope: 'following',
    fromDate: cancelFrom,
    notifyCustomer: false,
    notes: note,
    actorId,
    waiveFee: true,
    source,
    allowEmpty: true,
    linkedChildren: [],
    checkTargets: async (locked, trx) => {
      const approved = new Map(stop.targets.map((t) => [String(t.id), `${visitDay(t)}|${t.status}`]));
      const same = locked.length === approved.size
        && locked.every((t) => approved.get(String(t.id)) === `${visitDay(t)}|${t.status}`);
      if (!same) return changed;
      const series = await trx('scheduled_services')
        .where((q) => q.where('id', stop.rootId).orWhere('recurring_parent_id', stop.rootId))
        .where((q) => q.whereNull('status').orWhereNotIn('status', SETTLED_VISIT_STATUSES))
        .select('property_id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip');
      const unstampedAtHouse = await primaryIsHouse(trx);
      return series.every((v) => visitAtHouse(v, house, { primaryIsHouse: unstampedAtHouse })) ? null : changed;
    },
  });
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
    plan.move.id, new Date(plan.move.updated_at).toISOString(), plan.estimate.id, plan.to.id, plan.from.id, plan.cancelFrom, plan.primaryVersion,
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
    const res = await conn.query('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2::text)) AS locked', [MOVE_FENCE_NS, String(moveId)]);
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
      await conn.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2::text))', [MOVE_FENCE_NS, String(moveId)]);
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
// is still the submission and the estimate the plan was read from.
async function closeAppliedMove(plan, { actorId, summary, now }) {
  const submittedAt = (row) => new Date(row.submitted_at).getTime();
  await db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: plan.move.id }).forUpdate().first();
    if (!locked || locked.status !== 'submitted' || !sameId(locked.estimate_id, plan.estimate.id)
      || submittedAt(locked) !== submittedAt(plan.move)) {
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
        // The confirmed preview's version: the locked write refuses a change since (409 preview_changed).
        await require('./customer-properties').changePrimaryProperty(customerId, plan.to.id, { actorId, expectedVersion: plan.primaryVersion });
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

    // The note every visit Apply cancels carries (job_status_history). It names
    // only this move (never its dates, which a resubmit can change), so a later
    // attempt finds what an earlier one cancelled.
    const note = `Customer moved; plan stopped after the move-out date (moving flow, Apply move ${plan.move.id})`;
    const cancelledNow = new Set();
    for (const stop of plan.stops) {
      await step('plans', async () => {
        const out = await stopHousePlan(stop, {
          customerId, cancelFrom: plan.cancelFrom, note, actorId, source: 'moving-apply', house: plan.from,
          // The primary is the new home by now: an old-house visit must be pinned to the old house.
          primaryIsHouse: async () => false,
          changed: `${stop.name} changed while Apply move was running. Read the new preview, then apply again.`,
        });
        for (const t of out.targets) cancelledNow.add(String(t.id));
        progress.plansStopped += 1;
        progress.visitsCancelled += out.cancelledCount;
      });
    }
    // An earlier attempt whose cancel committed but whose follow-through did
    // not finish (the process stopped) left visits cancelled without their
    // invoice void, card release or tracker cancel: replay it (the same
    // repair as cancellation-processor priorCancelledVisits; every step of the
    // follow-through finds nothing left to do when it already ran).
    await step('plans', async () => {
      const { priorCancelledVisits } = require('./cancellation-processor');
      const earlier = (await priorCancelledVisits(customerId, note)).filter((v) => !cancelledNow.has(String(v.id)));
      if (!earlier.length) return;
      await require('./visit-cancellation-followthrough').runVisitCancellationFollowThrough({
        targetIds: earlier.map((v) => v.id), actorId, waiveFee: true, reason: note, source: 'moving-apply', linkedChildren: [],
      });
    });

    if (plan.stations) {
      await step('termite', async () => {
        const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
        const task = await raiseTermiteRetrievalTask(customerId, plan.move.service_request_id, { retrieveAfter: plan.moveOut });
        progress.stationTask = task.raised === true;
      });
    }

    const summary = [
      opts.auto ? 'Applied by the app after the customer accepted the new-home estimate.' : '',
      `New home is primary: ${propertyLine(plan.to)}.`,
      `Old-house plans stopped after ${prettyDate(plan.moveOut)}: ${plan.stops.length} (${progress.visitsCancelled} visits cancelled, no customer text, no fee).`,
      progress.stationTask ? 'Termite station pickup task opened.' : '',
    ].join(' ').trim();
    await step('close', () => closeAppliedMove(plan, { actorId, summary, now: opts.now || new Date() }));
    await require('./portal-inbox')
      .resolveRequestQuietly(plan.move.service_request_id, customerId,
        opts.auto ? 'Move applied by the app after the customer accepted the new-home estimate.' : 'Move applied from the Moving card.',
        { notAfter: new Date(), now: new Date() })
      .catch((err) => logger.warn(`[customer-moves] office item close failed for move ${moveId} (${errCode(err)})`));
    logger.info(`[customer-moves] applied move ${moveId} for customer ${customerId} by ${opts.auto ? 'the app (accepted estimate)' : (actorId || 'unknown')}`);
    return { applied: true, ...progress, oneOffs: plan.oneOffs, pastOpen: plan.pastOpen, summary };
  } finally {
    await release();
  }
}

/** The Moving card's Apply action for one move: null, or { action: 'review' | 'blocked' | 'applied', reason, steps? }. */
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
      return { action: 'blocked', reason: err.message, ...billingSteps(err.code) };
    }
    logger.warn(`[customer-moves] apply action read failed for move ${move.id} (${errCode(err)})`);
    return null;
  }
}

// ── Apply on accept (GATE_MOVING_AUTO_APPLY) ───────────────────────────────
//
// Owner 2026-11-04 (option A of the hands-off moves page: "App applies the
// move, with the same preview checks as the office button"): once the
// customer accepts the new-home estimate, the app applies the move itself. A
// job every 15 minutes reads Apply move's own preview for each submitted move
// whose estimate is accepted, and confirms it on that preview's version, as
// an office click would. A refusal the office must handle rings one office
// item per move and refusal, and the Moving card keeps its Apply button. A
// run that stops partway resumes on the next run, like a second confirm.

// Refusals that mean "not yet" or "try again": no office item, the next run
// reads the preview again. A visit under way finishes on its own.
const AUTO_APPLY_WAIT = new Set(['gate_off', 'not_found', 'already_applied', 'not_submitted', 'no_estimate',
  'estimate_not_accepted', 'apply_in_progress', 'apply_lock_unavailable', 'apply_changed', 'visit_underway',
  // A step's own "changed since the preview" (the primary change, a plan's series).
  'preview_changed', 'series_changed']);
// Saved by the accept itself: right after it, a missing new home or new plan
// is a write still landing, not a refusal yet.
const AUTO_APPLY_SETTLING = new Set(['no_new_property', 'no_new_plan']);
const AUTO_APPLY_SETTLE_MS = 60 * 60 * 1000;

// Submitted moves whose new-home estimate the customer accepted.
function acceptedEstimateMoves() {
  return db('customer_moves')
    .where({ status: 'submitted' })
    .whereNotNull('estimate_id')
    .whereExists(function acceptedEstimate() {
      this.select(db.raw('1')).from('estimates as e')
        .whereRaw('e.id = customer_moves.estimate_id')
        .where('e.status', 'accepted')
        .whereNull('e.archived_at');
    });
}

// One ringing office item per move and refusal code (the key dedupes for
// good): a refusal that persists rings once, a new one rings again.
async function raiseAutoApplyAlert(move, err) {
  const customer = await db('customers').where({ id: move.customer_id }).first('first_name', 'last_name');
  const name = [customer && customer.first_name, customer && customer.last_name].filter(Boolean).join(' ').trim() || 'a customer';
  const notif = await raiseAdminAlert('service', {
    area: 'Customers',
    action: cutAtWord(`apply ${name}'s move by hand`, MAX_HEADLINE_CHARS - 'Customers — '.length),
    why: cutAtWord('They accepted the new-home estimate, but the app could not apply the move; the item says why.', MAX_WHY_CHARS),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(move.customer_id)}`,
    subject: { type: 'customer', id: move.customer_id },
    doneWhen: 'move_handled',
    who: 'person',
  }, {
    detail: `${err.message} Then press Apply move on the Moving card.`,
    icon: '🚚',
    bell: true,
    dedupeKey: `moving_auto_apply_${err.code}:${move.id}`,
    metadata: { customerId: move.customer_id, moveId: move.id, kind: 'moving_auto_apply', code: err.code },
  });
  if (!notif || notif.suppressed) logger.warn(`[customer-moves] auto-apply office item did not persist for move ${move.id}; the next run tries again`);
}

// The old-house visits Apply never cancels (one-time visits after move-out,
// open visits dated between move-out and today): an office click reads them
// on the preview, so with no click the office gets them in one ringing item,
// written BEFORE the move closes. A list that changes refreshes the item.
async function raiseAutoApplyLeftBooked(move, preview, left) {
  const customer = await db('customers').where({ id: move.customer_id }).first('first_name', 'last_name');
  const name = [customer && customer.first_name, customer && customer.last_name].filter(Boolean).join(' ').trim() || 'a customer';
  const notif = await raiseAdminAlert('service', {
    area: 'Customers',
    action: cutAtWord(`check ${name}'s old-house visits`, MAX_HEADLINE_CHARS - 'Customers — '.length),
    why: cutAtWord(`They accepted the new-home estimate, and ${left.length === 1 ? '1 visit at the old house stays' : `${left.length} visits at the old house stay`} booked.`, MAX_WHY_CHARS),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(move.customer_id)}`,
    subject: { type: 'customer', id: move.customer_id },
    doneWhen: 'move_handled',
    who: 'person',
  }, {
    detail: `Still booked at ${preview.fromAddress}: ${left.map((v) => `${v.name} ${prettyDate(v.date)}`).join(', ')}. Apply move never cancels these. Cancel any that should not run.`,
    icon: '🚚',
    bell: true,
    dedupeKey: `moving_auto_apply_left_booked:${move.id}`,
    refreshOnDedupe: true,
    metadata: { customerId: move.customer_id, moveId: move.id, kind: 'moving_auto_apply_left_booked' },
  });
  if (!notif || notif.suppressed) throw new Error('moving auto-apply left-booked item did not persist');
}

// When the move's estimate was accepted, or null.
async function acceptedAt(move) {
  const row = await db('estimates').where({ id: move.estimate_id }).first('accepted_at');
  return row && row.accepted_at ? new Date(row.accepted_at) : null;
}

/**
 * Apply one move whose new-home estimate is accepted: Apply move's preview,
 * then its confirm on that preview's version. Returns 'applied', 'waiting'
 * (not ready, busy or changed: the next run reads it again) or 'office'.
 */
async function autoApplyMove(moveId, { now }) {
  const move = await db('customer_moves').where({ id: moveId }).first('id', 'customer_id', 'status', 'estimate_id');
  if (!move || move.status !== 'submitted' || !move.estimate_id) return 'waiting';
  try {
    const preview = await applyMovePreview(move.customer_id, move.id);
    const left = [...(preview.oneOffs || []), ...(preview.pastOpen || [])];
    // No item, no apply this run: the office hears before the move closes.
    if (left.length) await raiseAutoApplyLeftBooked(move, preview, left);
    const result = await applyMove(move.customer_id, move.id, { version: preview.version, actorId: null, now, auto: true });
    return result && result.applied ? 'applied' : 'waiting';
  } catch (err) {
    if (!(err instanceof MoveError)) throw err;
    if (AUTO_APPLY_WAIT.has(err.code)) return 'waiting';
    if (AUTO_APPLY_SETTLING.has(err.code)) {
      const accepted = await acceptedAt(move);
      if (!accepted || now.getTime() - accepted.getTime() < AUTO_APPLY_SETTLE_MS) return 'waiting';
    }
    await raiseAutoApplyAlert(move, err);
    return 'office';
  }
}

/** The apply-on-accept job (scheduler, every 15 minutes). Off with GATE_MOVING_AUTO_APPLY. */
async function autoApplyAcceptedMoves({ now = new Date() } = {}) {
  if (!movingAutoApplyLive()) return { skipped: true };
  const out = { applied: 0, waiting: 0, office: 0, failed: 0 };
  await forEachMove(acceptedEstimateMoves(), async (id) => {
    try {
      const outcome = await autoApplyMove(id, { now });
      if (outcome in out) out[outcome] += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`[customer-moves] auto-apply failed for move ${id} (${errCode(err)}); the next run tries again`);
    }
  });
  return out;
}

// ── Move pause (moving PR 2b, GATE_MOVING_PAUSE) ────────────────────────────
//
// Owner Q4 (2026-11-02 "yes to all"): a customer who moves out before giving
// the new address has every plan at the house left paused, pest included, for
// up to 60 days, with nothing charged, and gets one reminder text a week
// before move-out asking for the address. The daily job (scheduler, 10:20 ET)
// runs three passes over submitted moves with no new address on file:
//   1. reminder: move-out 0 to 7 days ahead, submitted before today: one text
//      with the moving link, claimed before the send so it goes at most once;
//   2. pause: on the move-out day (or the first run after it), every plan at
//      the house left stops through Apply move's cancel (visits after
//      move-out cancelled from today on, no customer text, no late-cancel
//      fee; the move-out day's own visit stays), the termite pickup task
//      opens when Waves-owned stations are rented, and the move records the
//      pause and its last day (move-out + 60). The move stays submitted: an
//      address the customer adds later goes through the new-home estimate and
//      Apply move, which then finds nothing left to stop;
//   3. end: a pause past its last day with still no address closes the move
//      (pause_expired), and the office gets one item.
// Customers billed per visit only (pauseLane 'auto'): only they get the
// reminder and read the pause on the receipt. Annual prepay and monthly
// members, and a pause the job cannot run (a visit under way, a paid visit, a
// plan it cannot tie to the house), go to the office once instead
// (pause_state 'office'). Every office item is written in the same
// transaction as the move-row change it reports.
// The job never cancels a one-time visit after move-out or an open visit
// dated between move-out and today: the office gets those in one item.
// The old-house stop (GATE_MOVING_STOP_AT_MOVE_OUT, owner 2026-11-04 "YES app
// cancel those old-house visits") runs pass 2 for a submitted move WITH a new
// address too, when the move is not applied by the move-out day: the same
// cancel, with the office words for a stop. Such a move gets no reminder and
// never ends in pass 3: it stays open for the new-home estimate and Apply move,
// which then finds nothing left to stop. A plan the move's new-home estimate
// booked is never stopped.

const REMINDER_DAYS = 7;
const PAUSE_PASS_LIMIT = 50;
const REMINDER_TEMPLATE = 'moving_address_reminder';
// Why the office has a pause, by billingBlock code.
const PAUSE_OFFICE_NOTES = {
  prepay: 'They prepay for the year, so the automatic pause skipped them. Pause their visits by hand.',
  monthly: 'They pay a monthly membership, so the automatic pause skipped them. Pause their visits and dues by hand.',
  billing: 'Their billing plan is not one the automatic pause handles. Pause their visits by hand.',
};
// The same for a move with a new address (the old-house stop). A prepaid or
// monthly plan moves to the new home by hand (BILLING_STEPS), so the item
// points to the Moving card's steps.
const STOP_OFFICE_NOTES = {
  prepay: 'They prepay for the year, so the app did not stop their old-house visits. Move them to the new home: follow the steps on the Moving card.',
  monthly: 'They pay a monthly membership, so the app did not stop their old-house visits. Move them to the new home: follow the steps on the Moving card.',
  billing: 'Their billing plan is not one the app handles, so it did not stop their old-house visits. Stop or move them by hand.',
};
const officeNotesFor = (move) => (move.normalized_address ? STOP_OFFICE_NOTES : PAUSE_OFFICE_NOTES);

// The note every visit the pause or the old-house stop cancels carries
// (job_status_history). Like Apply move's, it names only the move, so a later
// run finds what an earlier one cancelled. The first pause note (2b) is still
// replayed: a pause started before this note came in finishes on it.
const pauseVisitNote = (moveId) => `Customer moved out; plan stopped after the move-out date (moving flow, move pause ${moveId})`;
const firstPauseVisitNote = (moveId) => `Customer moved out with no new address; plan paused after the move-out date (moving flow, move pause ${moveId})`;

// Submitted moves with a move-out date and no new address on file (the
// "no address" the moving page's receipt and the new-home estimate read).
function noAddressMoves() {
  return db('customer_moves')
    .where({ status: 'submitted' })
    .whereNull('normalized_address')
    .whereNotNull('move_out_date');
}

// Every move `query` matches, a page at a time in id order: a move a pass
// leaves due (skipped, busy or failed) never holds back the ones after it.
async function forEachMove(query, fn) {
  let afterId = null;
  for (;;) {
    const page = query.clone();
    if (afterId) page.where('id', '>', afterId);
    const rows = await page.orderBy('id', 'asc').limit(PAUSE_PASS_LIMIT).select('id');
    for (const { id } of rows) await fn(id);
    if (rows.length < PAUSE_PASS_LIMIT) return;
    afterId = rows[rows.length - 1].id;
  }
}

// The move pause runs on the move-out day itself, for the visits after it. A
// move with a new address joins only with the old-house stop on.
function pauseDue(move, today) {
  return !!(move && move.status === 'submitted' && (!move.normalized_address || movingStopAtMoveOutLive()) && !move.pause_state
    && move.move_out_date && dateOnlyString(move.move_out_date) <= today);
}

/**
 * What the move pause (or, for a move with a new address, the old-house stop)
 * will do for this move: 'auto' (the job stops the plans: a customer billed
 * per visit), 'office' (annual prepay, monthly or another billing plan: the
 * office acts by hand), or null (gate off, no move-out date, no plan or no
 * customer, or an address on file with the old-house stop off).
 */
async function pauseLane(move, conn = db) {
  if (!movingPauseLive() || !move || !move.move_out_date) return null;
  if (move.normalized_address && !movingStopAtMoveOutLive()) return null;
  // A pause that ended (or went to the office) decides it; one still running promises nothing.
  if (move.pause_state) return move.pause_state === 'paused' ? 'auto' : 'office';
  if (move.paused_at) return null;
  const block = await billingBlock(conn, move.customer_id);
  if (!block) return 'auto';
  return PAUSE_OFFICE_NOTES[block] ? 'office' : null;
}

// One office item per move and kind, written in the SAME transaction as the
// move-row change it reports (notifyAdmin's `trx`): a failed write rolls the
// change back and the next run does that step again, so an item is never
// lost behind a recorded state. It rings: the bell policy drops a plain
// service row, and each kind asks the office to act on one customer.
async function raisePauseAlert(trx, move, kind, { action, why, detail }) {
  const customer = await trx('customers').where({ id: move.customer_id }).first('first_name', 'last_name');
  const name = [customer && customer.first_name, customer && customer.last_name].filter(Boolean).join(' ').trim() || 'a customer';
  const notif = await raiseAdminAlert('service', {
    area: 'Customers',
    action: cutAtWord(action(name), MAX_HEADLINE_CHARS - 'Customers — '.length),
    why: cutAtWord(why, MAX_WHY_CHARS),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(move.customer_id)}`,
    subject: { type: 'customer', id: move.customer_id },
    doneWhen: 'move_handled',
    who: 'person',
  }, {
    trx,
    detail,
    icon: '🚚',
    bell: true,
    dedupeKey: `moving_pause_${kind}:${move.id}`,
    metadata: { customerId: move.customer_id, moveId: move.id, kind: `moving_pause_${kind}` },
  });
  if (!notif || notif.suppressed) throw new Error(`moving pause ${kind} item did not persist`);
}

// ── Pass 1: the reminder text ──

async function sendMoveReminder(move) {
  const customer = await db('customers').where({ id: move.customer_id }).whereNull('deleted_at').first('first_name', 'phone');
  if (!customer || !customer.phone) return false;
  const { renderRequiredSmsTemplate } = require('./sms-template-renderer');
  const { sendCustomerMessage } = require('./messaging/send-customer-message');
  const { gsmSafeName } = require('./messaging/gsm-normalize');
  const body = await renderRequiredSmsTemplate(REMINDER_TEMPLATE, {
    first_name: gsmSafeName(customer.first_name),
    move_out_date: prettyDate(dateOnlyString(move.move_out_date)),
    moving_link: await movingLinkFor(move),
  }, { workflow: REMINDER_TEMPLATE, entity_type: 'customer_move', entity_id: move.id });
  const result = await sendCustomerMessage({
    to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'support_resolution',
    customerId: move.customer_id, identityTrustLevel: 'phone_matches_customer', entryPoint: REMINDER_TEMPLATE,
    metadata: { original_message_type: REMINDER_TEMPLATE, move_id: move.id },
  });
  return !!(result && result.sent);
}

// A move whose reminder is due today: no reminder yet, move-out 0 to 7 days
// ahead, and submitted before today (never on the day the customer said they
// do not know the address yet).
function reminderDue(query, today) {
  return query
    .whereNull('pause_reminder_at')
    .whereNull('paused_at')
    .where('move_out_date', '>=', today)
    .where('move_out_date', '<=', plusDays(today, REMINDER_DAYS))
    .whereRaw("(submitted_at AT TIME ZONE 'America/New_York')::date < ?::date", [today]);
}

// Claim, then send: a reminder that did not go out is never retried (one text
// per move, owner Q4). The card shows whether it went. Only a move the job
// will pause gets it: the text says the visits pause.
async function remindMove(moveId, { today, now }) {
  const current = await db('customer_moves').where({ id: moveId }).first();
  if ((await pauseLane(current)) !== 'auto') return 'skipped';
  const [move] = await reminderDue(noAddressMoves().where({ id: moveId }), today)
    .update({ pause_reminder_at: now, updated_at: now })
    .returning('*');
  if (!move) return 'not_due';
  const sent = await sendMoveReminder(move).catch((err) => {
    logger.error(`[customer-moves] reminder text failed for move ${moveId} (${errCode(err)})`);
    return false;
  });
  await db('customer_moves').where({ id: moveId }).update({ pause_reminder_sent: sent });
  return sent ? 'sent' : 'not_sent';
}

async function sendDueMoveReminders({ today, now }) {
  const out = { reminded: 0, reminderNotSent: 0 };
  await forEachMove(reminderDue(noAddressMoves(), today), async (id) => {
    try {
      const outcome = await remindMove(id, { today, now });
      if (outcome === 'sent') out.reminded += 1;
      if (outcome === 'not_sent') out.reminderNotSent += 1;
    } catch (err) {
      logger.error(`[customer-moves] reminder failed for move ${id} (${errCode(err)})`);
    }
  });
  return out;
}

// ── Pass 2: the pause ──

// Every series the move's new-home estimate booked (accepted, Apply not run
// yet): the new home's plan, which the old-house stop never touches.
async function estimateSeriesIds(customerId, estimateId) {
  if (!estimateId) return new Set();
  const rows = await db('scheduled_services')
    .where({ customer_id: customerId, source_estimate_id: estimateId })
    .whereNull('recurring_parent_id')
    .select('id');
  return new Set(rows.map((r) => String(r.id)));
}

// What the pause would stop for this move, read-only, or a MoveError saying
// why it cannot run (Apply move's own old-house reading, with no new home).
async function pausePlan(move, today) {
  const customerId = move.customer_id;
  const moveOut = dateOnlyString(move.move_out_date);
  const cutFrom = nextDay(moveOut);
  const from = await activeProperty(db, customerId, move.from_property_id);
  if (!from) throw applyError('from_unknown');
  const primaryIsFrom = sameId(await primaryPropertyId(customerId), from.id);
  const ctx = { to: null, from, flipped: !primaryIsFrom, today, cutFrom, cancelFrom: cutFrom > today ? cutFrom : today };
  const old = await oldHousePlans(db, customerId, ctx, await estimateSeriesIds(customerId, move.estimate_id));
  await assertOldVisitsUnpaid(db, customerId, old.stops);
  const { rentedTermiteStationState } = require('./cancellation-processor');
  const stationState = await rentedTermiteStationState(customerId);
  return { ...ctx, ...old, moveOut, stations: stationState.rented.length > 0 || stationState.flaggedRental === true };
}

// A pause that started and has not finished: paused_at is set before the
// first cancel (claimPause), pause_state only at its end (settlePause).
const pauseStarted = (move) => !!(move && move.paused_at && !move.pause_state);

// The office item for a pause (or an old-house stop) the office takes over.
const officeItem = (move, note, why) => ({
  action: (name) => (move.normalized_address ? `handle ${name}'s old-house visits by hand` : `pause ${name}'s plan by hand`),
  why,
  detail: note,
});

// The office takes a pause (or an old-house stop) that never started (annual
// prepay, monthly or another billing plan), once: nothing more runs for it
// automatically.
async function handPauseToOffice(move, note, { now }) {
  return db.transaction(async (trx) => {
    const updated = await trx('customer_moves')
      .where({ id: move.id, status: 'submitted' })
      .whereNull('pause_state')
      .whereNull('paused_at')
      .update({ pause_state: 'office', paused_at: now, pause_note: note.slice(0, 300), updated_at: now });
    if (!updated) return 'not_due';
    await trx('activity_log').insert({
      customer_id: move.customer_id,
      action: 'moving_pause_office',
      description: `Move pause left to the office: ${note}`,
      metadata: JSON.stringify({ move_id: move.id }),
    });
    const day = prettyDate(dateOnlyString(move.move_out_date));
    await raisePauseAlert(trx, move, 'office', officeItem(move, note, move.normalized_address
      ? `Their move-out is ${day} and the move is not applied yet; the app did not stop the old-house visits.`
      : `Their move-out is ${day} with no new address on file; the automatic pause did not run.`));
    return 'office';
  });
}

// Claims the pause before any cancel, under the move's row lock and only
// while it is still due: paused_at and its last day (move-out + 60).
async function claimPause(move, today, now) {
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    if (!pauseDue(locked, today) || locked.paused_at) return null;
    const [claimed] = await trx('customer_moves').where({ id: move.id }).update({
      paused_at: now, pause_ends_on: plusDays(dateOnlyString(locked.move_out_date), PAUSE_DAYS), updated_at: now,
    }).returning('*');
    return claimed;
  });
}

// Ends a started pause under the move's row lock, only if the move still has
// the status, move-out date and address the run acted on, with its office
// items in the same transaction.
async function settlePause(move, facts, { state, note = null, summary = null, why = null, left = [], house = null, now }) {
  return db.transaction(async (trx) => {
    const locked = await trx('customer_moves').where({ id: move.id }).forUpdate().first();
    if (!pauseStarted(locked) || locked.status !== facts.status
      || (dateOnlyString(locked.move_out_date) || null) !== facts.moveOut || !!locked.normalized_address !== facts.hasAddress) return 'not_due';
    await trx('customer_moves').where({ id: move.id }).update({
      pause_state: state, ...(note ? { pause_note: note.slice(0, 300) } : {}), updated_at: now,
    });
    await trx('activity_log').insert({
      customer_id: move.customer_id,
      action: state === 'paused' ? 'moving_paused' : 'moving_pause_office',
      description: summary || `Move pause left to the office: ${note}`,
      metadata: JSON.stringify({ move_id: move.id, move_out_date: facts.moveOut }),
    });
    if (state === 'office' && why) await raisePauseAlert(trx, locked, 'office', officeItem(locked, note, why));
    if (left.length) {
      await raisePauseAlert(trx, locked, 'left_booked', {
        action: (name) => `check ${name}'s old-house visits`,
        why: `The plans ${facts.hasAddress ? 'stopped' : 'paused'} after the move-out, but ${left.length} visit${left.length === 1 ? ' is' : 's are'} still booked at the old house.`,
        detail: `Still booked at ${propertyLine(house)}: ${left.map((v) => `${v.name} ${prettyDate(v.date)}`).join(', ')}. Cancel any that should not run.`,
      });
    }
    return state;
  });
}

// An earlier run's cancels whose follow-through did not finish (the process
// stopped): replayed, found by the visit note naming the move (the same
// repair as Apply move's; each step finds nothing left to do when it ran).
async function replayPauseFollowThrough(move) {
  const { priorCancelledVisits } = require('./cancellation-processor');
  for (const note of [pauseVisitNote(move.id), firstPauseVisitNote(move.id)]) {
    const earlier = await priorCancelledVisits(move.customer_id, note);
    if (!earlier.length) continue;
    await require('./visit-cancellation-followthrough').runVisitCancellationFollowThrough({
      targetIds: earlier.map((v) => v.id), actorId: null, waiveFee: true, reason: note, source: 'moving-pause', linkedChildren: [],
    });
  }
}

// Stops every plan at the house left and opens the termite task. A refusal
// from a cancel returns with what already stopped; any other failure throws
// and the next run resumes the claimed pause.
async function runPause(move, plan) {
  const customerId = move.customer_id;
  const note = pauseVisitNote(move.id);
  const progress = { plansStopped: 0, visitsCancelled: 0, stopped: [], stationTask: false };
  for (const stop of plan.stops) {
    try {
      const out = await stopHousePlan(stop, {
        customerId, cancelFrom: plan.cancelFrom, note, actorId: null, source: 'moving-pause', house: plan.from,
        primaryIsHouse: async (trx) => sameId(await primaryPropertyId(customerId, trx), plan.from.id),
        changed: `${stop.name} changed while the pause was running.`,
      });
      progress.plansStopped += 1;
      progress.visitsCancelled += out.cancelledCount;
      progress.stopped.push(stop.name);
    } catch (err) {
      const status = Number(err.statusCode || err.status) || 500;
      if (status >= 500) throw err;
      progress.refusal = `${stop.name}: ${(err.body && err.body.error) || err.message}`;
      return progress;
    }
  }
  if (plan.stations) {
    const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
    const task = await raiseTermiteRetrievalTask(customerId, move.service_request_id, { retrieveAfter: plan.moveOut });
    progress.stationTask = task.raised === true;
  }
  return progress;
}

// Runs a claimed pause to its end, whatever changed since the claim. It first
// replays an earlier run's unfinished cancel follow-through. A move closed
// since, or with a new move-out date, goes to the office (no more cancels),
// and so does a customer whose billing lane is no longer one the pause
// handles. Otherwise every plan at the house left stops, as the run that
// claimed it would have done: an address the customer added since does not
// stop it (the move-out passed; Apply move later finds nothing left to stop).
// A refused cancel goes to the office with what already stopped. A move with
// a new address reads as the old-house stop in every note and item.
async function finishPause(move, { today, now }) {
  const claimedMoveOut = plusDays(dateOnlyString(move.pause_ends_on), -PAUSE_DAYS);
  const facts = { status: move.status, moveOut: dateOnlyString(move.move_out_date) || null, hasAddress: !!move.normalized_address };
  const why = facts.hasAddress
    ? `The automatic stop of the old-house visits for the move-out on ${prettyDate(claimedMoveOut)} did not finish; the item says what stopped.`
    : `The automatic pause for the move-out on ${prettyDate(claimedMoveOut)} did not finish; the item says what stopped.`;
  await replayPauseFollowThrough(move);
  if (move.status !== 'submitted') {
    return settlePause(move, facts, { state: 'office', note: 'The move closed while the pause was running.', now });
  }
  if (facts.moveOut !== claimedMoveOut) {
    const note = `The customer changed the move-out date to ${prettyDate(facts.moveOut) || 'not known yet'} while the pause for ${prettyDate(claimedMoveOut)} was running. Check the old-house visits against the new date.`;
    return settlePause(move, facts, { state: 'office', note, why, now });
  }
  // The billing lane again before any further cancel: a customer who became
  // a monthly or prepay member (or lost their plan) since the claim goes to
  // the office with what already stopped.
  const block = await billingBlock(db, move.customer_id);
  if (block) {
    const note = officeNotesFor(move)[block] || 'Their account changed while the pause was running. Check the old-house visits by hand.';
    return settlePause(move, facts, { state: 'office', note, why, now });
  }
  let plan;
  try {
    plan = await pausePlan(move, today);
  } catch (err) {
    if (!(err instanceof MoveError)) throw err;
    return settlePause(move, facts, { state: 'office', note: err.message, why, now });
  }
  const progress = await runPause(move, plan);
  if (progress.refusal) {
    const done = progress.stopped.length ? `Stopped: ${progress.stopped.join(', ')}. ` : '';
    return settlePause(move, facts, { state: 'office', note: `${done}Not stopped: ${progress.refusal}`, why, now });
  }
  const counts = `(${progress.plansStopped} plans, ${progress.visitsCancelled} visits cancelled, no customer text, no fee)`;
  const summary = [
    facts.hasAddress
      ? `Customer moved out: plans at ${propertyLine(plan.from)} stopped after ${prettyDate(plan.moveOut)} ${counts}. The move stays open for the new-home estimate and Apply move.`
      : `Customer moved out with no new address: plans at ${propertyLine(plan.from)} paused after ${prettyDate(plan.moveOut)} ${counts}, held until ${prettyDate(dateOnlyString(move.pause_ends_on))}.`,
    progress.stationTask ? 'Termite station pickup task opened.' : '',
  ].join(' ').trim();
  return settlePause(move, facts, { state: 'paused', summary, left: [...plan.oneOffs, ...plan.pastOpen], house: plan.from, now });
}

/**
 * Pause one move whose customer moved out with no new address (or, with the
 * old-house stop on, stop the old-house plans of one with a new address that
 * is not applied), or finish one an earlier run started. Returns its outcome.
 * Every step, the office hand-off included, is awaited inside the try: the
 * move fence is released only after it commits or rolls back.
 */
async function pauseMove(moveId, { today, now }) {
  let release;
  try {
    release = await acquireApplyLock(moveId);
  } catch (err) {
    if (err instanceof MoveError) return 'busy';
    throw err;
  }
  try {
    const move = await db('customer_moves').where({ id: moveId }).first();
    if (pauseStarted(move)) return await finishPause(move, { today, now });
    if (!pauseDue(move, today)) return 'not_due';
    // The receipt's own rule (pauseLane): only 'auto' pauses; 'office' hands
    // off once; anything else (no plan, no customer) is left alone, unmarked,
    // exactly as the receipt promised nothing.
    const block = await billingBlock(db, move.customer_id);
    const notes = officeNotesFor(move);
    if (notes[block]) return await handPauseToOffice(move, notes[block], { now });
    if (block) return 'skipped';
    const claimed = await claimPause(move, today, now);
    return claimed ? await finishPause(claimed, { today, now }) : 'not_due';
  } finally {
    await release();
  }
}

async function pauseDueMoves({ today, now }) {
  const out = { paused: 0, office: 0, skipped: 0, busy: 0, failed: 0 };
  // Due moves (with a new address only when the old-house stop is on), and
  // every pause an earlier run started, whatever changed since.
  const withAddress = movingStopAtMoveOutLive();
  const due = db('customer_moves').whereNull('pause_state').where((q) => q
    .whereNotNull('paused_at')
    .orWhere((fresh) => {
      fresh.where({ status: 'submitted' }).whereNotNull('move_out_date').where('move_out_date', '<=', today);
      if (!withAddress) fresh.whereNull('normalized_address');
    }));
  await forEachMove(due, async (id) => {
    try {
      const outcome = await pauseMove(id, { today, now });
      if (outcome in out) out[outcome] += 1;
    } catch (err) {
      out.failed += 1;
      logger.error(`[customer-moves] pause failed for move ${id} (${errCode(err)}); the next run resumes it`);
    }
  });
  return out;
}

// ── Pass 3: the end of the pause ──

async function endPause(moveId, { today, now }) {
  let release;
  try {
    release = await acquireApplyLock(moveId);
  } catch (err) {
    if (err instanceof MoveError) return false;
    throw err;
  }
  try {
    const ended = await db.transaction(async (trx) => {
      const locked = await trx('customer_moves').where({ id: moveId }).forUpdate().first();
      if (!locked || locked.status !== 'submitted' || locked.normalized_address || locked.pause_state !== 'paused'
        || !(dateOnlyString(locked.pause_ends_on) < today)) return null;
      await trx('customer_moves').where({ id: moveId }).update({
        status: 'closed', closed_reason: 'pause_expired', closed_at: now, updated_at: now,
      });
      await trx('activity_log').insert({
        customer_id: locked.customer_id,
        action: 'moving_pause_ended',
        description: `Move pause ended: no new address ${PAUSE_DAYS} days after the move-out on ${prettyDate(dateOnlyString(locked.move_out_date))}. The plans stay stopped.`,
        metadata: JSON.stringify({ move_id: locked.id }),
      });
      await raisePauseAlert(trx, locked, 'ended', {
        action: (name) => `close out ${name}'s move`,
        why: `No new address ${PAUSE_DAYS} days after the move-out on ${prettyDate(dateOnlyString(locked.move_out_date))}, so their plans stay stopped.`,
        detail: 'The moving link no longer opens. Call them, or end the account.',
      });
      return locked;
    });
    if (!ended) return false;
    // The moving office item: best effort, the Moving card shows the move closed.
    await require('./portal-inbox')
      .resolveRequestQuietly(ended.service_request_id, ended.customer_id, 'Move pause ended with no new address.', { notAfter: now, now })
      .catch((err) => logger.warn(`[customer-moves] office item close failed for move ${moveId} (${errCode(err)})`));
    return true;
  } finally {
    await release();
  }
}

async function endExpiredPauses({ today, now }) {
  const out = { ended: 0 };
  await forEachMove(noAddressMoves().where({ pause_state: 'paused' }).where('pause_ends_on', '<', today), async (id) => {
    try {
      if (await endPause(id, { today, now })) out.ended += 1;
    } catch (err) {
      logger.error(`[customer-moves] pause end failed for move ${id} (${errCode(err)}); retried on the next run`);
    }
  });
  return out;
}

/**
 * The daily move-pause job (scheduler, 10:20 ET): reminders, then pauses (and,
 * with GATE_MOVING_STOP_AT_MOVE_OUT, old-house stops), then ends. Off with
 * GATE_MOVING_PAUSE.
 */
async function runMovePauseJob({ now = new Date() } = {}) {
  if (!movingPauseLive()) return { skipped: true };
  const today = etDateString(now);
  return {
    ...(await sendDueMoveReminders({ today, now })),
    ...(await pauseDueMoves({ today, now })),
    ...(await endExpiredPauses({ today, now })),
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
  BILLING_STEPS,
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
  autoApplyAcceptedMoves,
  runMovePauseJob,
  PAUSE_DAYS,
  _private: { cleanDate, cleanTyped, typedUnit, normalizedFrom, reusableCheck, requestDescription, requestSubject, alertWhy, prettyDate, raiseMoveAlert, applyPlan, nextDay, visitAtHouse, pauseLane, addressLine },
};
