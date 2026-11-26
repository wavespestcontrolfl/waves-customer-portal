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
 * The customer comes first, as in the quote wizard: a contact that is already a customer (the wizard's own matcher,
 * findExistingCustomerByContact) is not booked here (409 contact_on_file); a new contact gets the wizard's pre-customer
 * row (new_lead, lead_source mail_new_home), and the estimate is saved with its customer_id so the /book handoff can price
 * the visit. A repeat tap finds its own row again (same phone, same address, still pre-customer) and reuses it.
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
// The first touch of every /h booking: the visitor came from the printed postcard, whose link is /h/<token>. Sent to
// createSelfBooking as the booking's attribution, so the booking row keeps it (with the offline source evidence) and
// attributeSelfBooking writes its funnel row under the 'new_home_postcard' print source (services/print-lead-sources.js,
// lead_sources row seeded by 20261124150000_print_lead_sources.js). The shape is the browser capture's: utm_source from
// the print source table, utm_medium print, observed true. No click id, so it can never read as paid.
const POSTCARD_ATTRIBUTION = Object.freeze({
  observed: true,
  utm: Object.freeze({ source: 'new_home_postcard', medium: 'print' }),
});
const HOLD_LABEL = 'Postcard price held';
const HOLD_REASON = 'mail_new_home: printed postcard price held 60 days';
const MAX_OFFERS = 30;
const CONTACT_ON_FILE = 'CONTACT_ON_FILE';
const DEAD_VISIT_STATUSES = ['cancelled', 'skipped', 'rescheduled'];
const SLOT_CONFLICT_CODES =new Set(['SLOT_TAKEN', 'SLOT_UNAVAILABLE', 'SELF_SERVE_NOTICE']);

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
      'home_stories', 'lot_sqft', 'mailed_at', 'mailed_price');
  if (!row) return null;
  const price = rowPriceOf(row);
  if (!price || price.annual == null) return null;
  const facts = {
    homeSqft: numOrNull(row.home_sqft), homeSqftSource: row.home_sqft_source, stories: numOrNull(row.home_stories), lotSqft: numOrNull(row.lot_sqft),
  };
  if (facts.homeSqft == null || facts.stories == null || facts.lotSqft == null || !facts.homeSqftSource) return null;
  return { row, facts, price, held: priceIsHeld(row.mailed_at) };
}

// The price the page shows for this row (home-page.js): a mailed home's PRINTED price (the frozen snapshot, never the
// columns), else the row's own price. Null when a mailed home's snapshot cannot be read (the page shows no price then).
function rowPriceOf(row) {
  if (!row.mailed_at) return toPrice(row);
  return require('./mailed-record').printedPriceOf(row);
}

// The postcard's price hold (the card says "Held 60 days"): a mailed home, through the Eastern day heldUntilOf gives
// (mailed-record.js, PRICE_HOLD_DAYS after the day it was marked mailed). Owner 2026-09-26: a quote already sent is
// honored as sent; owner 2026-11-25 (pick A): never more than the card, and the lower live price when ours went down.
function priceIsHeld(mailedAt, now = new Date()) {
  const { heldUntilOf } = require('./mailed-record');
  const { etDateString } = require('../../utils/datetime-et');
  const until = heldUntilOf(mailedAt);
  return !!until && etDateString(now) <= until;
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

const timeToMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * The funnel's own signed-offer check (createSelfBooking's verifySlotOfferField call, booking.js), run before anything is
 * written: the offer must be one the finder minted for this pin, this service and this duration, and not expired. The
 * booking re-runs it and the commit-time slot checks.
 */
async function offerIsSigned(offer, pin, deps) {
  const booking = deps.booking || REAL.booking();
  const verify = deps.verifySlotOfferField || require('../../utils/slot-offer-token').verifySlotOfferField;
  const config = await booking.loadBookingConfig();
  return !!verify({
    surface: 'booking',
    scopeId: '',
    serviceKey: SERVICE_KEY,
    locationKey: booking.bookingOfferLocationKey(pin.lat, pin.lng),
    date: offer.date,
    startMinutes: timeToMinutes(offer.start),
    technicianId: offer.technicianId || null,
    durationMinutes: booking.resolveBookingDuration(SERVICE_MINUTES, config, SERVICE_KEY),
    policy: booking.bookOfferPolicyLive(offer.sig),
  }, offer.sig);
}

// ---- the price the page showed ----------------------------------------------------------------------------------------

const toCents = (dollars) => Math.round(Number(dollars) * 100);

/** The price the page showed ({ annual, setupFee } as GET /:token returned it), in integer cents, or null. */
function validShownPrice(price) {
  if (!price || typeof price !== 'object' || Array.isArray(price)) return null;
  // Both fields, both JSON numbers (never a boolean, string, array or a missing field), in whole cents.
  const { annual, setupFee } = price;
  const isCents = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e7 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
  if (!isCents(annual) || !isCents(setupFee) || annual <= 0) return null;
  return { annualCents: toCents(annual), setupCents: toCents(setupFee) };
}

// ---- the estimate ---------------------------------------------------------------------------------------------------

// A v4-shaped UUID from the home and the typed contact: the same home and contact reach the same draft id, so a repeat
// tap reuses the estimate (createOrReuseAdminEstimate reuses a draft of the id with the same inputs); another contact
// at the same home is another draft, and so is another price: a draft a slot conflict left behind is keyed to the price it
// was saved at, so a repriced home starts a fresh draft instead of being handed the old one (and refused price_changed for
// good).
function draftIdFor(prospectId, contact, shown) {
  const hex = crypto.createHash('sha256')
    // A held price's discount and capped setup fee are part of the key (only when there is one, so every other id is
    // unchanged): a draft saved against one live price is never reused after the live price moved again.
    .update(`mail-home-book:${prospectId}:${contact.phone10}:${contact.email}:${contact.name.toLowerCase()}:${shown.annualCents}:${shown.setupCents}${heldKeyOf(shown)}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// The part of the draft key a held price adds: its discount, and the engine's setup fee when the card caps it.
function heldKeyOf(terms) {
  const discount = terms.discountCents > 0 ? `:held-${terms.discountCents}` : '';
  const fee = Number.isFinite(terms.liveSetupCents) && terms.liveSetupCents !== terms.setupCents ? `:fee-${terms.liveSetupCents}` : '';
  return `${discount}${fee}`;
}

const httpStatus = (err) => Number(err && (err.statusCode || err.status)) || 0;
const codeOf = (err) => (err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown');

/**
 * The price check before anything is written: the shadow price pass's own verdict (home-quote priceHome: the member check,
 * then a dry run of the canonical save). Returns { ok: true, terms } (termsFor) or { refuse: { status, error } }.
 */
async function checkLivePrice(home, shown, deps) {
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
  const terms = termsFor(home, shown, { annualCents: toCents(result.priceAnnual), setupCents: toCents(result.priceSetupFee) });
  return terms ? { ok: true, terms } : { refuse: { status: 409, error: 'price_changed' } };
}

/**
 * The terms this booking is made on, in integer cents, or null (the price changed and no hold applies).
 *   - the live price is the one the page showed: those amounts, no discount;
 *   - it differs and the home's printed price is held: each of the annual price and the setup fee is the LOWER of the
 *     printed and the live amount. A live annual above the printed one is brought down by a fixed discount on the
 *     estimate (discountCents); a lower live price is simply the price.
 * liveSetupCents is the engine's own setup fee, the one the saved estimate must still carry. held says the terms rely on
 * the hold (the commit guard checks the hold again inside the booking transaction).
 */
function termsFor(home, shown, live) {
  if (![live.annualCents, live.setupCents].every(Number.isFinite) || live.annualCents <= 0 || live.setupCents < 0) return null;
  const same = live.annualCents === shown.annualCents && live.setupCents === shown.setupCents;
  if (!same && !home.held) return null;
  const annualCents = Math.min(shown.annualCents, live.annualCents);
  return {
    annualCents,
    setupCents: Math.min(shown.setupCents, live.setupCents),
    discountCents: live.annualCents - annualCents,
    liveSetupCents: live.setupCents,
    // These terms stand only while the printed price is held (the live price is not the one shown).
    held: !same,
  };
}

// ---- the customer ---------------------------------------------------------------------------------------------------
// The quote wizard always has a customer on its draft before the visitor books (public-quote.js, the customers upsert):
// the /book handoff prices a visit only when estimate.customer_id belongs to the booking customer
// (estimateBelongsToCustomerAccount). So this module does the same: a contact that is already a customer is not booked
// here; a new contact gets the wizard's own pre-customer row (pipeline_stage new_lead) before the estimate is saved.

const phone10Of = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// The row an earlier tap of this page minted for this contact and this home (lead_source mail_new_home, still a
// pre-customer stage, same phone, same address), so a repeat tap reuses it. Null when there is none.
async function findOwnCustomer(home, contact, deps) {
  const conn = deps.db || db;
  const { PRE_CUSTOMER_PIPELINE_STAGES } = require('../booking-contact-linked-handoff');
  const booking = deps.booking || REAL.booking();
  const rows = await conn('customers')
    .where({ lead_source: LEAD_SOURCE })
    .whereIn('pipeline_stage', [...PRE_CUSTOMER_PIPELINE_STAGES])
    .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${contact.phone10}`])
    .whereNull('deleted_at')
    .limit(5)
    .select('id', 'phone', 'email', 'address_line1', 'address_line2', 'zip');
  // An exact retry: the same phone, the same email and this home. A changed email is another contact (the existing-contact
  // check then runs and refuses on the row this phone owns).
  const own = rows.find((r) => phone10Of(r.phone) === contact.phone10
    && String(r.email || '').trim().toLowerCase() === contact.email
    && booking.addressMatchesCustomer(r, home.row.address_line1, home.row.zip, null));
  return own ? own.id : null;
}

// Any customer the wizard's own matcher finds by the typed phone or email (a unique phone match, a same-person cluster
// of several, or a unique email match).
async function findExistingCustomer(home, contact, deps) {
  const find = require('../../routes/public-quote')._internals.findExistingCustomerByContact;
  return find(deps.db || db, { contactPhone: contact.phone10, contactEmail: contact.email }, {
    first_name: contact.first, last_name: contact.last, address_line1: home.row.address_line1, address_line2: null,
    city: home.row.city || '', zip: home.row.zip || '',
  });
}

// The pre-customer row, with the columns the wizard sets for a new contact that apply here. No lot or property size
// (measured only), no landing page or UTM (none). Returns the new customer's id.
//
// One transaction, taken under the phone fence (ensureCustomerAccount lockPhone, the same fence quick-add uses), spans the
// account, the contact recheck and the profile insert: two taps at once cannot both mint, and a refusal rolls the account
// back. Fail closed: an account that is not brand new (ensureCustomerAccount attached to one, or refused on a phone or
// email match), or any customer the wizard's matcher finds once the fence is held, is a CONTACT_ON_FILE refusal.
async function mintCustomer(home, contact, pin, deps) {
  const conn = deps.db || db;
  const { ensureCustomerAccount } = require('../../routes/admin-customers');
  const onFile = () => Object.assign(new Error('contact on file'), { code: CONTACT_ON_FILE });
  try {
    return await conn.transaction(async (trx) => {
      const account = await ensureCustomerAccount(trx, {
        firstName: contact.first, lastName: contact.last, phone: contact.phone10, email: contact.email, lockPhone: true,
        // The helper's own email match (off by default): a customer with this email, in one account or several, refuses.
        matchEmail: true,
      });
      if (!account || account.created !== true) throw onFile();
      // The email fence (the lock every email writer takes), held to the commit with the phone fence: two different phones
      // claiming one new email cannot both pass the check below. Then the check itself, which sees every live profile with
      // this email (the wizard matcher returns nothing when several profiles share one).
      await require('../../utils/customer-comms-lock').lockCustomerEmail(trx, contact.email);
      if (await trx('customers').whereRaw("LOWER(TRIM(COALESCE(email, ''))) = ?", [contact.email]).whereNull('deleted_at').first('id')) throw onFile();
      if (await (deps.findExistingCustomer || findExistingCustomer)(home, contact, { ...deps, db: trx })) throw onFile();
      const customerId = await insertCustomer(trx, account, home, contact, pin);
      // Born reachable and complete, as the quote wizard's customers are: the notification_prefs row the consent check
      // reads (without it every send, the booking confirmation included, fails NO_CONSENT_RECORD) and the property
      // preferences. The same helper the wizard and createSelfBooking use; idempotent.
      await require('../customer-default-rows').createDefaultCustomerRows(trx, customerId);
      return customerId;
    });
  } catch (err) {
    // ensureCustomerAccount's own phone or email refusals (409) are the same answer.
    if (err && (err.code === CONTACT_ON_FILE || (httpStatus(err) === 409 && /^(PHONE_MATCH|EMAIL_MATCH)/.test(String(err.code || ''))))) throw onFile();
    throw err;
  }
}

async function insertCustomer(conn, account, home, contact, pin) {
  const { applyContactNormalization } = require('../../utils/intake-normalize');
  const code = `WAVES-${Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')}`;
  const [created] = await conn('customers').insert(applyContactNormalization({
    account_id: account.accountId,
    is_primary_profile: !account.existingCustomer,
    profile_label: account.existingCustomer ? 'Additional property' : 'Primary',
    first_name: contact.first,
    last_name: contact.last,
    email: contact.email,
    phone: contact.phone10,
    address_line1: home.row.address_line1,
    address_line2: null,
    city: home.row.city || '',
    state: home.row.state || 'FL',
    zip: home.row.zip || '',
    latitude: pin.lat,
    longitude: pin.lng,
    pipeline_stage: 'new_lead',
    pipeline_stage_changed_at: new Date(),
    lead_source: LEAD_SOURCE,
    lead_source_detail: LEAD_SOURCE_DETAIL,
    lead_source_area: home.row.city ? String(home.row.city).slice(0, 50) : null,
    lead_service_interest: SERVICE_LABEL,
    referral_code: code,
    last_contact_date: new Date(),
    last_contact_type: LEAD_SOURCE,
    active: true,
  })).returning(['id']);
  return created.id || created;
}

/** The canonical save of the estimate: the shadow price's body plus the typed contact and the customer's id. */
async function saveEstimate(home, contact, customerId, terms, deps) {
  const quote = deps.quote || REAL.quote();
  const buildEngineInput = deps.buildEngineInput || REAL.buildEngineInput();
  const save = deps.saveEstimate || REAL.save();
  const body = {
    ...quote.estimateBody(home.row, home.facts, quote.engineInputFor(home.facts, buildEngineInput)),
    customerId,
    customerName: contact.name,
    customerPhone: contact.phone,
    customerEmail: contact.email,
    clientDraftId: draftIdFor(home.row.id, contact, terms),
  };
  // The held postcard price: the engine's own manual-discount path (estimate_data.operatorPriceAdjustment, replayed on
  // every reprice of the draft), a fixed dollar amount off the one recurring pest line. Server-made, never from a request.
  if (terms.discountCents > 0) {
    body.estimateData = {
      ...body.estimateData,
      operatorPriceAdjustment: { type: 'FIXED', value: terms.discountCents / 100, label: HOLD_LABEL, internalReason: HOLD_REASON },
    };
  }
  return save(body);
}

// The save's own price must be the terms just settled and still a clean server price (the judge the shadow pass uses):
// the annual total to the cent (after the hold's discount, when there is one), and the engine's own setup fee.
function savedPriceHolds(saved, terms, deps) {
  const quote = deps.quote || REAL.quote();
  const verdict = quote.judge({ estimate: saved.estimate, memberLinkageWarning: saved.memberLinkageWarning });
  return !!verdict.price && toCents(verdict.price.annual) === terms.annualCents && toCents(verdict.price.setupFee) === terms.liveSetupCents;
}

// The quote-wizard draft shape the /book handoff accepts, the postcard lead source, and the setup fee the page disclosed,
// frozen as the wizard freezes it (estimate_data.setupFeeQuote = { amount, kind: 'waveguard_membership' }, public-quote.js
// decideSetupFeeQuote). booking.js bills a pest setup fee only from that field (stampDisclosedSetupFee reads
// estimate_data.setupFeeQuote.amount), never from result.oneTime.membershipFee. A zero fee writes no quote, as the wizard
// writes none; here a zero fee is frozen as an explicit 0, so conversion adds none. Only a live draft is touched.
//
// The draft also carries the prospect it was made for (estimate_data.mailProspectId, written here, never from a request):
// the server-side link the first-booking claim and the retry recovery follow, instead of any string a caller can send.
//
// mailShownKey is the id a draft of this contact at the SHOWN price has (draftIdFor): with a held price the draft's own id
// follows the terms, so the retry recovery finds a committed booking's draft by this key.
async function markEstimate(estimateId, prospectId, terms, shownKey, deps) {
  const conn = deps.db || db;
  const set = { source: 'quote_wizard', lead_source: LEAD_SOURCE, lead_source_detail: LEAD_SOURCE_DETAIL };
  const merged = { mailProspectId: String(prospectId), mailShownKey: shownKey };
  // Always explicit, a ZERO too: an absent quote reads as a legacy estimate, and a later conversion of this solo pest
  // draft would add the live WaveGuard fee the page never showed (estimate-converter
  // shouldIncludeWaveGuardSetupFeeForRecurring: amount 0 = the quote disclosed no fee).
  merged.setupFeeQuote = { amount: terms.setupCents / 100, kind: 'waveguard_membership' };
  set.estimate_data = conn.raw("COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify(merged)]);
  await conn('estimates').where({ id: estimateId, status: 'draft' }).whereNull('archived_at').update(set);
}

// The visits this postcard has booked: a /book visit (self_booking_id set) linked to a draft made for this prospect
// (scheduled_services.source_estimate_id = the draft, which bookingPayload sends as source_estimate_id; the draft carries
// the prospect id), still live. A customer's other bookings are not this postcard's. Live is read from the scheduled visit
// itself, not only the booking row (staff cancel the visit and leave the booking row as it was): cancelled, skipped and
// rescheduled visits are not live, as createSelfBooking's own replay reads them. No address matching and no candidate cap.
function liveProspectVisits(conn, prospectId) {
  return conn('scheduled_services as ss')
    .join('self_booked_appointments as sba', 'sba.id', 'ss.self_booking_id')
    .join('estimates as e', 'e.id', 'ss.source_estimate_id')
    .whereRaw("e.estimate_data->>'mailProspectId' = ?", [String(prospectId)])
    .whereNot('sba.status', 'cancelled')
    .whereNotIn('ss.status', DEAD_VISIT_STATUSES);
}

// An earlier tap of this booking that COMMITTED (a lost response, then an identical retry): a live visit linked to THIS draft
// (`estimateId`, the contact's and price's own) at this slot whose customer has this phone, whatever stage the booking has
// since moved the customer to. Its customer id, or null. The retry then goes to createSelfBooking unchanged, whose own
// replay (same customer, same slot, a live visit of the same estimate) answers it.
async function findCommittedBookingCustomer(home, contact, offer, shownKey, deps) {
  const conn = deps.db || db;
  const rows = await liveProspectVisits(conn, home.row.id)
    // The draft of this contact at the shown price: its id is the key, or (a held price: the id follows the terms) it
    // carries the key.
    .where((q) => q.where('ss.source_estimate_id', shownKey).orWhereRaw("e.estimate_data->>'mailShownKey' = ?", [shownKey]))
    .join('customers as c', 'c.id', 'ss.customer_id')
    .where('sba.date', offer.date)
    .where('sba.start_time', offer.start)
    .whereNull('c.deleted_at')
    .whereRaw("regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${contact.phone10}`])
    .limit(5)
    .select('c.id', 'c.phone', 'ss.source_estimate_id');
  const own = rows.find((r) => phone10Of(r.phone) === contact.phone10);
  return own ? { customerId: own.id, estimateId: own.source_estimate_id } : null;
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
async function prepareEstimate(home, contact, pin, shown, deps) {
  const refuse = (status, error) => ({ refuse: { status, body: { error } } });
  // The price the page showed is the one on the row now (annual and setup fee, to the cent).
  if (toCents(home.price.annual) !== shown.annualCents || toCents(home.price.setupFee || 0) !== shown.setupCents) {
    return refuse(409, 'price_changed');
  }
  // Our own earlier mint is reused; any other customer at this phone or email is not booked here.
  let customerId = await (deps.findOwnCustomer || findOwnCustomer)(home, contact, deps);
  if (!customerId && await (deps.findExistingCustomer || findExistingCustomer)(home, contact, deps)) return refuse(409, 'contact_on_file');
  const priced = await checkLivePrice(home, shown, deps);
  if (priced.refuse) return refuse(priced.refuse.status, priced.refuse.error);
  const { terms } = priced;
  if (!customerId) {
    try {
      customerId = await (deps.mintCustomer || mintCustomer)(home, contact, pin, deps);
    } catch (err) {
      if (err && err.code === CONTACT_ON_FILE) return refuse(409, 'contact_on_file');
      throw err;
    }
  }

  let saved;
  try {
    saved = await saveEstimate(home, contact, customerId, terms, deps);
  } catch (err) {
    const status = httpStatus(err);
    if (status >= 400 && status < 500) return refuse(409, 'not_available');
    throw err;
  }
  if (!savedPriceHolds(saved, terms, deps)) return refuse(409, 'price_changed');
  const estimateId = saved.estimate.id;
  await markEstimate(estimateId, home.row.id, terms, draftIdFor(home.row.id, contact, shown), deps);

  const estimateToken = (deps.handoffToken || REAL.handoffToken())(estimateId);
  return estimateToken ? { estimateId, estimateToken, customerId, terms } : refuse(503, 'not_available');
}

/**
 * The retry of a booking that committed: the customer, the draft id and a token for it, or null (then the normal path
 * runs). The draft must still exist.
 */
async function recoverCommitted(home, contact, offer, shown, deps) {
  const shownKey = draftIdFor(home.row.id, contact, shown);
  const found = await (deps.findCommittedBookingCustomer || findCommittedBookingCustomer)(home, contact, offer, shownKey, deps);
  if (!found) return null;
  // A test double may answer with the customer id alone: then the draft is the shown-price one.
  const customerId = typeof found === 'object' ? found.customerId : found;
  const estimateId = (typeof found === 'object' && found.estimateId) || shownKey;
  const draft = await (deps.db || db)('estimates').where({ id: estimateId }).first('id', 'annual_total', 'estimate_data');
  const estimateToken = draft && (deps.handoffToken || REAL.handoffToken())(estimateId);
  if (!estimateToken) return null;
  // The terms the committed booking was made on, read from its draft, so the retry's answer shows the same price.
  const data = typeof draft.estimate_data === 'string' ? (() => { try { return JSON.parse(draft.estimate_data); } catch { return null; } })() : draft.estimate_data;
  const committed = draftTermsOf(draft, data);
  return { estimateId, estimateToken, customerId, committedTerms: committed || null };
}

// The check createSelfBooking runs inside its transaction, after its own replay and conflict checks, before the visit is
// inserted: the mail gate and /book are still on, and the prospect row, share-locked until the booking commits, is still
// a live priced home at the price the page showed, and no other first booking of this home is live.
//
// The first-booking claim is a transaction-scoped advisory lock on the prospect, taken HERE, inside the booking
// transaction: the visit insert and the commit happen in that one transaction, and it is the only unit that spans both,
// so a lock taken here is held exactly until the visit is committed (or rolled back). A second household member's booking
// waits at this point; when the first commits, its visit is committed and READ COMMITTED shows it to the check below, so
// the second is refused. A lock taken before createSelfBooking (the mint and estimate commit in their own transactions
// first) would not span the visit insert. An exact replay never gets here (createSelfBooking answers it earlier).
//
// Every pre-commit check lives here, in the one place that runs on the booking transaction just before the insert:
//   1. the mail gate and /book still on;
//   2. the prospect row (locked) still live at the shown price;
//   3. the draft (locked) still holding the shown annual and setup fee as a server price;
//   4. still no member of Waves at the address, strict, read on this transaction (the office can activate a plan at the
//      address after the price check; a plan found now is not new-customer terms);
//   5. with pay-at-visit on, the price this booking is about to stamp on the visit and its follow-ups is exactly the one
//      resolveBookingVisitPrice gives for the locked draft, linked to that draft (ctx is what createSelfBooking resolved);
//   6. no other live visit of this prospect's drafts.
function commitGuardFor(home, shown, estimateId, deps, terms = shown) {
  return async (trx, ctx = {}) => {
    const gates = deps.gates || REAL.gates();
    if (typeof gates.mailHomePageLive !== 'function' || !gates.mailHomePageLive() || !gates.isEnabled('selfBooking')) return false;
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['mail-home-first-booking', String(home.row.id)]);
    const row = await trx('mail_prospects')
      .where({ id: home.row.id, list_key: LIST_KEY, status: 'eligible', price_status: 'priced' })
      .forShare()
      .first('price_annual', 'price_setup_fee', 'mailed_at', 'mailed_price');
    // The same price the page shows: a mailed home's printed snapshot, else the columns.
    const rowPrice = row && rowPriceOf(row);
    if (!rowPrice || rowPrice.annual == null || toCents(rowPrice.annual) !== shown.annualCents || toCents(rowPrice.setupFee || 0) !== shown.setupCents) return false;
    // The hold is read from the locked row (a home marked mailed after the page loaded gets its hold; never the reverse).
    if (terms.held && !priceIsHeld(row.mailed_at)) return false;
    const draft = await draftHoldingShownPrice(trx, estimateId, terms);
    if (!draft) return false;
    if (!(await noMemberAtHome(trx, home, deps))) return false;
    if (gates.isEnabled('bookingPayAtVisit') && !stampedPriceIsDrafts(ctx, draft, estimateId, deps)) return false;
    return !(await liveProspectVisits(trx, home.row.id).first('ss.id'));
  };
}

// The draft the visit is priced from, read FOR SHARE on the booking transaction (a staff revision takes the row FOR UPDATE,
// so it cannot land between this check and the commit): its annual total and its frozen setup fee are the ones the customer
// confirmed, to the cent, and it is still a server price. The locked row, or null.
async function draftHoldingShownPrice(trx, estimateId, shown) {
  const draft = await trx('estimates').where({ id: estimateId }).forShare().first();
  if (!draft || draft.pricing_authority !== 'SERVER') return null;
  const data = typeof draft.estimate_data === 'string' ? (() => { try { return JSON.parse(draft.estimate_data); } catch { return null; } })() : draft.estimate_data;
  const terms = draftTermsOf(draft, data);
  return terms && terms.annualCents === shown.annualCents && terms.setupCents === shown.setupCents ? draft : null;
}

// The annual total and the FROZEN setup fee a draft holds, in cents, or null. The fee must be there explicitly, a zero too
// (markEstimate always writes it): a draft whose setupFeeQuote was dropped would convert with the live fee.
function draftTermsOf(draft, data) {
  const quote = data && data.setupFeeQuote;
  if (!quote || quote.amount === null || quote.amount === undefined || quote.amount === '') return null;
  const setupFee = Number(quote.amount);
  const annual = Number(draft.annual_total);
  if (!Number.isFinite(setupFee) || setupFee < 0 || !Number.isFinite(annual) || annual <= 0) return null;
  return { annualCents: toCents(annual), setupCents: toCents(setupFee) };
}

// The strict member-at-address check the price pass ran (home-quote memberStatusOf), on the booking transaction. A member, a
// near member, or a check that cannot finish all refuse.
async function noMemberAtHome(trx, home, deps) {
  const quote = deps.quote || REAL.quote();
  try {
    return (await quote.memberStatusOf(home.row, quote.memberAtAddressOn(trx))) === null;
  } catch (err) {
    logger.warn(`[mail-home-book] member recheck failed (code=${codeOf(err)})`);
    return false;
  }
}

// What createSelfBooking resolved for the visit (ctx) against what resolveBookingVisitPrice gives for the locked draft (the
// same call booking.js makes, for the same service and the quarterly series): present, pay-at-visit, linked to this draft,
// and cent-exact on the first and the follow-up amounts. A price that failed to resolve is a refusal, never an unpriced visit.
function stampedPriceIsDrafts(ctx, draft, estimateId, deps) {
  const resolve = deps.resolveBookingVisitPrice || require('../booking-pay-at-visit').resolveBookingVisitPrice;
  const expected = resolve({ estimate: draft, serviceKey: SERVICE_KEY, bookingVisits: 4 });
  if (!expected || !(Number(expected.amount) > 0)) return false;
  const followUp = expected.followUpAmount ?? expected.amount;
  return ctx.paymentPref === 'pay_at_visit'
    && String(ctx.sourceEstimateId || '') === String(estimateId)
    && toCents(ctx.visitPrice) === toCents(expected.amount)
    && toCents(ctx.followUpVisitPrice) === toCents(followUp);
}

// The payload of /book's POST /confirm, with the flags it sets after the body spread: no bearer identity, never a
// callback visit.
function bookingPayload({ home, contact, offer, pin, gates, estimate }) {
  return {
    // The pre-customer row: with customers-only on, the handoff binds it by address; with it off, customer_id plus the
    // typed phone resolve it (the phone-on-file check accepts the id of the row that owns the phone).
    customer_id: estimate.customerId,
    pricing_estimate_id: estimate.estimateId,
    estimate_token: estimate.estimateToken,
    // The visit links to its draft whatever the gates (without pay-at-visit pricing the handoff does not stamp it): the
    // first-booking claim, the retry recovery and the replay all follow this link.
    source_estimate_id: estimate.estimateId,
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
    attribution: { observed: POSTCARD_ATTRIBUTION.observed, utm: { ...POSTCARD_ATTRIBUTION.utm } },
    new_customer: {
      first_name: contact.first,
      last_name: contact.last,
      // The phone as the minted row stores it (applyContactNormalization writes E.164): createSelfBooking resolves
      // customer_id by the digits of this value, so ten digits would miss the row and mint a second profile.
      phone: contact.phone,
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
 *   | { status: 200, body: { booked: true, date: string, window: { start: string, end: string|null },
 *       price?: { annual: number, monthly: number, setupFee: number } } }
 *   | { status: number, body: { error: string, offers?: object[], field?: string } }>}
 *   null = the same 404 as an unknown token.
 */
async function bookHome(token, input, deps = {}) {
  const home = await loadHome(token);
  if (!home) return null;
  const gates = deps.gates || REAL.gates();
  if (!gates.isEnabled('selfBooking')) return { status: 503, body: { error: 'not_available' } };
  const typed = validInput(input);
  if (typed.refuse) return typed.refuse;
  const { contact, offer, shown } = typed;

  const booking = deps.booking || REAL.booking();
  const pin = await pinOf(home.row, booking);
  if (!pin) return { status: 503, body: { error: 'not_available' } };
  // The signed offer is checked before any contact lookup or write (an unsigned or expired one reveals and writes nothing).
  if (!(await offerIsSigned(offer, pin, deps))) return { status: 400, body: { error: 'invalid_offer' } };

  // A retry of a booking that already committed goes straight to createSelfBooking's own replay: the customer has since
  // moved out of the pre-customer stage and is a member at the address, so the contact and price checks below no longer
  // apply to it.
  const prepared = await recoverCommitted(home, contact, offer, shown, deps) || await prepareEstimate(home, contact, pin, shown, deps);
  if (prepared.refuse) return prepared.refuse;

  const result = await booking.createSelfBooking({
    ...bookingPayload({ home, contact, offer, pin, gates, estimate: prepared }),
    // Re-read inside the booking transaction: the gate, the prospect row (locked) and the price it still holds.
    commitGuard: commitGuardFor(home, shown, prepared.estimateId, deps, prepared.terms || shown),
  });
  // A recovered retry answers with the committed draft's terms; a fresh booking with its own, unless createSelfBooking
  // answered it as the replay of another submission (then this submission's terms are not the committed ones).
  const replayed = !!(result.body && result.body.replayed);
  return answerOf(result, offer, pin, booking, prepared.committedTerms || (replayed ? null : prepared.terms));
}

/** The typed body: { contact, offer, shown } or { refuse } (a 400 naming what is wrong). */
function validInput(input) {
  const contact = validContact(input);
  if (contact.invalid) return { refuse: { status: 400, body: { error: 'invalid_contact', field: contact.invalid } } };
  const offer = validOffer(input && input.offer);
  if (!offer) return { refuse: { status: 400, body: { error: 'invalid_offer' } } };
  const shown = validShownPrice(input && input.price);
  if (!shown) return { refuse: { status: 400, body: { error: 'invalid_price' } } };
  return { contact, offer, shown };
}

// createSelfBooking's result as this page's answer.
async function answerOf(result, offer, pin, booking, terms) {
  if (!result.ok) {
    const refusal = refusalOf(result);
    if (refusal.error !== 'slot_taken') return { status: refusal.status, body: { error: refusal.error } };
    // The times that are open now, so the page can offer the next ones.
    let offers = [];
    try { offers = (await findOffers(pin, booking)) || []; } catch (err) { logger.warn(`[mail-home-book] next times failed (code=${codeOf(err)})`); }
    return { status: 409, body: { error: 'slot_taken', offers } };
  }
  // The customer's arrival window, from the committed start (AGENTS.md: the start plus the arrival window, never the
  // visit's own end). The scheduling end stays internal.
  const start = String((result.body && result.body.booking && result.body.booking.start_time) || offer.start).slice(0, 5);
  const [from, to] = (require('../../utils/sms-time-format').arrivalWindowRange(start) || `${start}-`).split('-');
  // The row the booking wrote has no column for the mail list (mail_prospects has none that fits): nothing is recorded there.
  const body = { booked: true, date: offer.date, window: { start: from, end: to || null } };
  // The price this booking was made on (the lower of the card's and today's while the card's price is held), so the page
  // can show it. A retry of a committed booking carries that booking's price (from its draft); a concurrent submission
  // answered as a replay carries none.
  if (terms) body.price = { annual: terms.annualCents / 100, monthly: Math.round(terms.annualCents / 12) / 100, setupFee: terms.setupCents / 100 };
  return { status: 200, body };
}

module.exports = {
  getHomeTimes, bookHome, loadHome, draftIdFor, validContact, validOffer, validShownPrice, offersOf, findOwnCustomer, mintCustomer,
  findCommittedBookingCustomer, commitGuardFor, offerIsSigned, termsFor, priceIsHeld,
};
