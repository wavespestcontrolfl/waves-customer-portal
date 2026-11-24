'use strict';

/**
 * The first-visit times and the booking of one new home on the mail list (mailer step 2d, server half). The page
 * /h/:token (routes/mail-home-public.js) calls these two functions; GATE_MAIL_HOME_PAGE guards the route.
 *
 *   getHomeTimes(token)        the open first-visit offers of the home's address, soonest first
 *   bookHome(token, input)     a REAL booking from the home's stored facts: estimate + customer + first visit
 *
 * Nothing here is a second implementation of anything:
 *   - the times come from the /book funnel's own finder (routes/booking.js availabilityForPin, built by
 *     buildFunnelAvailability, the one finder that mints the signed offers /confirm accepts), at the pin
 *     resolveOfferCoords gives the address, for the funnel's pest service;
 *   - the estimate is the portal's canonical save (admin-estimate-persistence createOrReuseAdminEstimate, NOT a dry run)
 *     built from the stored home facts exactly as the shadow price was (home-quote.js estimateBody + engineInputFor).
 *     No paid property lookup. The live price must still be the one the page showed (priceHome, the shadow price pass's
 *     own verdict: a clean server price of one pest line, and no member of Waves at the address);
 *   - the booking is createSelfBooking (routes/booking.js), the function /book's POST /confirm is a thin adapter over,
 *     with pricing_estimate_id + a handoff token minted for that estimate, so every /book check (the signed offer, the
 *     customers-only handoff pass, the customer mint, the visit insert, the confirmation text and email) runs unchanged.
 *
 * The estimate is written as a quote-wizard draft (source 'quote_wizard', status 'draft'): that is the shape the /book
 * handoff accepts (wizardDraftSelfServeBookable). Its lead_source is 'mail_new_home'. The visit's source is
 * 'mail_new_home' too (self_booked_appointments.source and scheduled_services.source are free text).
 *
 * A repeat tap reuses the estimate: its id comes from the home and the typed contact, and the save reuses a draft of
 * that id with the same inputs. A repeat of a booking that committed answers through createSelfBooking's own replay.
 *
 * No logging of a name, phone, email, address or token: codes only.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { toPrice } = require('../prospects/mail-list');
const { TOKEN_RE } = require('./home-page');

const LIST_KEY = 'new_home';
const SERVICE_KEY = 'pest_control'; // the /book funnel's service id for the pest plan
const SERVICE_LABEL = 'Pest Control';
const SERVICE_MINUTES = 60; // the funnel catalog's pest duration (ignored by the server for a known service)
const RECURRING_PATTERN = 'quarterly';
const LEAD_SOURCE = 'mail_new_home';
const LEAD_SOURCE_DETAIL = 'new_home_postcard';
const MAX_OFFERS = 30;
// The page shows a monthly price from the stored annual; anything under this many dollars of annual is rounding.
const PRICE_TOLERANCE = 0.5;
const SLOT_CONFLICT_CODES = new Set(['SLOT_TAKEN', 'SLOT_UNAVAILABLE', 'SELF_SERVE_NOTICE']);

// Each outside dependency a test did not inject, loaded when used (booking.js is a large router).
const REAL = {
  booking: () => require('../../routes/booking')._internals,
  gates: () => require('../../config/feature-gates'),
  save: () => (body) => require('../admin-estimate-persistence').createOrReuseAdminEstimate({
    database: db, body, technicianId: null, technician: null, requireLivePricing: true,
  }),
  buildEngineInput: () => require('../estimator-engine/draft-builder').buildEngineInput,
  handoffToken: () => require('../../utils/estimate-handoff-token').mintEstimateHandoffToken,
  quote: () => require('./home-quote'),
};

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// The live, priced home of this token, or null: the page's own rule (an eligible row of the list whose price pass
// settled as priced). A home without a price, a held-back home, an unknown token and a malformed one are all null.
async function loadHome(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = await db('mail_prospects')
    .where({ page_token: token, list_key: LIST_KEY, status: 'eligible', price_status: 'priced' })
    .first('id', 'address_line1', 'city', 'state', 'zip', 'price_annual', 'price_setup_fee', 'home_sqft', 'home_sqft_source',
      'home_stories', 'lot_sqft');
  if (!row) return null;
  const price = toPrice(row);
  if (price.annual == null) return null;
  const facts = {
    homeSqft: numOrNull(row.home_sqft), homeSqftSource: row.home_sqft_source, stories: numOrNull(row.home_stories), lotSqft: numOrNull(row.lot_sqft),
  };
  if (facts.homeSqft == null || facts.stories == null || facts.lotSqft == null || !facts.homeSqftSource) return null;
  return { row, facts, price };
}

const selfBookingLive = (deps) => (deps.gates || REAL.gates()).isEnabled('selfBooking');

// The pin the offers are signed for: the funnel's own address resolution (an existing customer's pin, else the geocode).
async function pinOf(row, booking) {
  const where = await booking.resolveOfferCoords({
    address: row.address_line1, city: row.city, state: row.state || 'FL', zip: row.zip,
  });
  const lat = Number(where && where.lat);
  const lng = Number(where && where.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0 ? { lat, lng } : null;
}

// The finder's days flattened to one list, soonest first. Only the fields the booking replays leave this module.
function offersOf(availability) {
  const offers = [];
  for (const day of (availability && availability.days) || []) {
    for (const slot of day.slots || []) {
      if (!slot.slot_sig) continue;
      offers.push({
        date: day.date,
        start_time: slot.start_time,
        end_time: slot.end_time,
        start_label: slot.start_label || null,
        end_label: slot.end_label || null,
        technician_id: slot.technician_id || null,
        slot_sig: slot.slot_sig,
      });
    }
  }
  offers.sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  return offers.slice(0, MAX_OFFERS);
}

async function findOffers(pin, booking) {
  const availability = await booking.availabilityForPin({ lat: pin.lat, lng: pin.lng, serviceKey: SERVICE_KEY });
  return availability ? offersOf(availability) : null;
}

/**
 * @returns {Promise<null | { error: 'not_available' } | { offers: Array<{ date, start_time, end_time, start_label, end_label,
 *   technician_id, slot_sig }> }>} null = the same 404 as an unknown token.
 */
async function getHomeTimes(token, deps = {}) {
  const home = await loadHome(token);
  if (!home) return null;
  if (!selfBookingLive(deps)) return { error: 'not_available' };
  const booking = deps.booking || REAL.booking();
  const pin = await pinOf(home.row, booking);
  if (!pin) return { error: 'not_available' };
  const offers = await findOffers(pin, booking);
  return offers ? { offers } : { error: 'not_available' };
}

// ---- the contact ----------------------------------------------------------------------------------------------------

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) return null;
  const [first, ...rest] = name.split(' ');
  return { name, first, last: rest.join(' ') };
}

/** The typed contact, or { invalid: field }. Phone: a US number, as booking and the other intake paths store it. */
function validContact(input) {
  const { cleanValidEmailOrNull, normalizeNanpPhone } = require('../../utils/intake-normalize');
  const name = cleanName(input && input.name);
  if (!name) return { invalid: 'name' };
  const e164 = typeof (input && input.phone) === 'string' && input.phone.length <= 40 ? normalizeNanpPhone(input.phone) : null;
  if (!e164) return { invalid: 'phone' };
  const email = typeof (input && input.email) === 'string' && input.email.length <= 254 ? cleanValidEmailOrNull(input.email) : null;
  if (!email) return { invalid: 'email' };
  return { name: name.name, first: name.first, last: name.last, phone: e164, phone10: e164.slice(2), email };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The offer exactly as getHomeTimes returned it (the booking replays date, start, end, technician and signature). */
function validOffer(offer) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return null;
  const { date, start_time: start, end_time: end, technician_id: tech, slot_sig: sig } = offer;
  if (typeof date !== 'string' || !DATE_RE.test(date) || typeof start !== 'string' || !TIME_RE.test(start)) return null;
  if (end != null && (typeof end !== 'string' || !TIME_RE.test(end))) return null;
  if (tech != null && (typeof tech !== 'string' || !UUID_RE.test(tech))) return null;
  if (typeof sig !== 'string' || sig.length < 8 || sig.length > 300) return null;
  return { date, start, end: end || null, technicianId: tech || null, sig };
}

// ---- the estimate ---------------------------------------------------------------------------------------------------

// A v4-shaped UUID from the home and the typed contact: the same home and contact reach the same draft id, so a repeat
// tap reuses the estimate (createOrReuseAdminEstimate reuses a draft of the id with the same inputs); another contact
// at the same home is another draft.
function draftIdFor(prospectId, contact) {
  const hex = crypto.createHash('sha256')
    .update(`mail-home-book:${prospectId}:${contact.phone10}:${contact.email}:${contact.name.toLowerCase()}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const httpStatus = (err) => Number(err && (err.statusCode || err.status)) || 0;
const codeOf = (err) => (err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown');

/**
 * The price check before anything is written: the shadow price pass's own verdict (home-quote priceHome: the member check,
 * then a dry run of the canonical save). Returns { ok: true } or { refuse: { status, error } }.
 */
async function checkLivePrice(home, deps) {
  const quote = deps.quote || REAL.quote();
  let result;
  try {
    result = await quote.priceHome(home.row, home.facts, deps.priceDeps || {});
  } catch (err) {
    logger.error(`[mail-home-book] price check failed (code=${codeOf(err)})`);
    return { refuse: { status: 503, error: 'not_available' } };
  }
  if (result.status === 'failed') return { refuse: { status: 503, error: 'not_available' } };
  // A member at the address, quote-required, review, or any line the shadow price pass would not call clean.
  if (result.status !== 'priced') return { refuse: { status: 409, error: 'not_available' } };
  if (Math.abs(result.priceAnnual - home.price.annual) > PRICE_TOLERANCE
    || Math.abs(result.priceSetupFee - (home.price.setupFee || 0)) > PRICE_TOLERANCE) {
    return { refuse: { status: 409, error: 'price_changed' } };
  }
  return { ok: true };
}

/** The canonical save of the estimate: the shadow price's body plus the typed contact. */
async function saveEstimate(home, contact, deps) {
  const quote = deps.quote || REAL.quote();
  const buildEngineInput = deps.buildEngineInput || REAL.buildEngineInput();
  const save = deps.saveEstimate || REAL.save();
  const body = {
    ...quote.estimateBody(home.row, home.facts, quote.engineInputFor(home.facts, buildEngineInput)),
    customerName: contact.name,
    customerPhone: contact.phone,
    customerEmail: contact.email,
    clientDraftId: draftIdFor(home.row.id, contact),
  };
  return save(body);
}

// The save's own price must be the one just checked and still a clean server price (the judge the shadow pass uses).
function savedPriceHolds(saved, home, deps) {
  const quote = deps.quote || REAL.quote();
  const verdict = quote.judge({ estimate: saved.estimate, memberLinkageWarning: saved.memberLinkageWarning });
  return !!verdict.price && Math.abs(verdict.price.annual - home.price.annual) <= PRICE_TOLERANCE;
}

// The quote-wizard draft shape the /book handoff accepts, and the postcard lead source. Only a live draft is touched.
async function markEstimate(estimateId, deps) {
  const conn = deps.db || db;
  await conn('estimates')
    .where({ id: estimateId, status: 'draft' })
    .whereNull('archived_at')
    .update({ source: 'quote_wizard', lead_source: LEAD_SOURCE, lead_source_detail: LEAD_SOURCE_DETAIL });
}

// ---- the booking ----------------------------------------------------------------------------------------------------

/** The /book refusal mapped to this page's friendly codes. */
function refusalOf(result) {
  if (result.status === 409 && (SLOT_CONFLICT_CODES.has(result.code) || /no longer available|already taken/i.test(result.error || ''))) {
    return { status: 409, error: 'slot_taken' };
  }
  if (result.status === 409 && /phone number is already on file/i.test(result.error || '')) return { status: 409, error: 'contact_on_file' };
  if (result.status === 400 && /slot_|time slot|pick/i.test(result.error || '')) return { status: 409, error: 'slot_taken' };
  return { status: result.status >= 500 ? 503 : 409, error: 'not_available' };
}

/**
 * The live price check, the canonical save, the draft's mark and the handoff token. Returns { refuse: { status, body } }
 * or { estimateId, estimateToken }.
 */
async function prepareEstimate(home, contact, deps) {
  const refuse = (status, error) => ({ refuse: { status, body: { error } } });
  const priced = await checkLivePrice(home, deps);
  if (priced.refuse) return refuse(priced.refuse.status, priced.refuse.error);

  let saved;
  try {
    saved = await saveEstimate(home, contact, deps);
  } catch (err) {
    const status = httpStatus(err);
    if (status >= 400 && status < 500) return refuse(409, 'not_available');
    throw err;
  }
  if (!savedPriceHolds(saved, home, deps)) return refuse(409, 'price_changed');
  const estimateId = saved.estimate.id;
  await markEstimate(estimateId, deps);

  const estimateToken = (deps.handoffToken || REAL.handoffToken())(estimateId);
  return estimateToken ? { estimateId, estimateToken } : refuse(503, 'not_available');
}

// The payload of /book's POST /confirm, with the flags it sets after the body spread: no bearer identity, never a
// callback visit.
function bookingPayload({ home, contact, offer, pin, gates, estimate }) {
  return {
    pricing_estimate_id: estimate.estimateId,
    estimate_token: estimate.estimateToken,
    slot_date: offer.date,
    slot_start: offer.start,
    slot_end: offer.end,
    technician_id: offer.technicianId,
    slot_sig: offer.sig,
    service_id: SERVICE_KEY,
    service_type: SERVICE_LABEL,
    duration_minutes: SERVICE_MINUTES,
    recurring_pattern: RECURRING_PATTERN,
    source: LEAD_SOURCE,
    new_customer: {
      first_name: contact.first,
      last_name: contact.last,
      phone: contact.phone10,
      email: contact.email,
      address_line1: home.row.address_line1,
      city: home.row.city,
      state: home.row.state || 'FL',
      zip: home.row.zip,
      lat: pin.lat,
      lng: pin.lng,
    },
    payAtVisit: gates.isEnabled('bookingPayAtVisit'),
    customersOnly: gates.isEnabled('bookingCustomersOnly'),
    authedCustomer: null,
    callbackVisit: null,
  };
}

/**
 * @param {string} token
 * @param {{ offer, name, phone, email }} input
 * @returns {Promise<null
 *   | { status: 200, body: { booked: true, date: string, window: { start: string, end: string|null } } }
 *   | { status: number, body: { error: string, offers?: object[], field?: string } }>}
 *   null = the same 404 as an unknown token.
 */
async function bookHome(token, input, deps = {}) {
  const home = await loadHome(token);
  if (!home) return null;
  const gates = deps.gates || REAL.gates();
  if (!gates.isEnabled('selfBooking')) return { status: 503, body: { error: 'not_available' } };
  const contact = validContact(input);
  if (contact.invalid) return { status: 400, body: { error: 'invalid_contact', field: contact.invalid } };
  const offer = validOffer(input && input.offer);
  if (!offer) return { status: 400, body: { error: 'invalid_offer' } };

  const booking = deps.booking || REAL.booking();
  const pin = await pinOf(home.row, booking);
  if (!pin) return { status: 503, body: { error: 'not_available' } };

  const prepared = await prepareEstimate(home, contact, deps);
  if (prepared.refuse) return prepared.refuse;

  const result = await booking.createSelfBooking(bookingPayload({ home, contact, offer, pin, gates, estimate: prepared }));
  if (!result.ok) {
    const refusal = refusalOf(result);
    if (refusal.error !== 'slot_taken') return { status: refusal.status, body: { error: refusal.error } };
    // The times that are open now, so the page can offer the next ones.
    let offers = [];
    try { offers = (await findOffers(pin, booking)) || []; } catch (err) { logger.warn(`[mail-home-book] next times failed (code=${codeOf(err)})`); }
    return { status: 409, body: { error: 'slot_taken', offers } };
  }
  // The row the booking wrote has no column for the mail list (mail_prospects has none that fits): nothing is recorded there.
  return { status: 200, body: { booked: true, date: offer.date, window: { start: offer.start, end: offer.end } } };
}

module.exports = { getHomeTimes, bookHome, loadHome, draftIdFor, validContact, validOffer, offersOf };
