/**
 * Digital business card — one tokenized card per customer for life, minted on
 * their FIRST completed visit and fronted by the tech on record for that
 * service (owner spec 2026-07-11).
 *
 * Surfaces:
 *   • /card/:share_token (client page, routes/card-public.js serves its data)
 *   • the review QR — a /l short code (kind='card') targeting the Google
 *     review URL of the GBP nearest the customer, so scans are click-tracked
 *     and the target stays swappable without reissuing cards
 *   • the card.issued email — DARK behind GATE_DIGITAL_BUSINESS_CARD; the
 *     mint itself is ungated (a row + page reachable only by token).
 *
 * The card is a PASSIVE ask: nothing here sends SMS, and active review asks
 * stay in the review-request lanes. The card page hides its review section
 * for customers already flagged has_left_google_review.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { gates } = require('../config/feature-gates');
const { WAVES_LOCATIONS, nearestLocation } = require('../config/locations');
const { createTrackedShortLink } = require('./short-url');
const { publicPortalUrl } = require('../utils/portal-url');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function firstNameOf(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

/**
 * Customer-since year on the ET calendar (Codex P3 #2592): member_since is a
 * pg DATE (arrives as a UTC-midnight Date or 'YYYY-MM-DD' string — the ISO
 * year IS the calendar year), but the created_at fallback is timestamptz —
 * a Dec 31 evening ET signup is a Jan 1 UTC instant, so getFullYear() on the
 * server would show next year.
 */
function memberSinceYearET(customer = {}) {
  const ms = customer.member_since;
  if (ms) {
    const iso = ms instanceof Date ? ms.toISOString() : String(ms);
    const m = /^(\d{4})/.exec(iso);
    if (m) return Number(m[1]);
  }
  if (customer.created_at) {
    try {
      const { etParts } = require('../utils/datetime-et');
      return etParts(new Date(customer.created_at)).year;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Share/referral destination for a customer — shared by the card payload and
 * the Wallet pass so the two surfaces can't drift (Codex P2 #2592).
 * Attribution order: promoter row → rebuild from customers.referral_code →
 * only then the generic portal refer tab. Never the personal card token.
 */
async function referralShareUrl(customer) {
  let referralUrl = null;
  try {
    const promoter = await db('referral_promoters')
      .where({ customer_id: customer.id })
      .first('referral_link');
    if (promoter?.referral_link) referralUrl = promoter.referral_link;
  } catch { /* table optional in older envs */ }
  if (!referralUrl && customer.referral_code) {
    try {
      const { getPromoterReferralLink, getSettings } = require('./referral-engine');
      const settings = await getSettings().catch(() => ({}));
      referralUrl = getPromoterReferralLink({ referral_code: customer.referral_code }, settings) || null;
    } catch { /* settings/table unavailable — generic fallback below */ }
  }
  return referralUrl || `${publicPortalUrl()}/?tab=refer`;
}

/**
 * Office for a customer: geodata first (nearest GBP), then the review-routing
 * city map (review-request.js — includes its review-only overrides like
 * palmetto → bradenton), which itself defaults to Bradenton.
 */
function pickCardLocation(customer = {}) {
  // Null/blank-guard BEFORE Number(): Number(null) === 0, which would route
  // every un-geocoded customer to the office nearest (0,0) instead of falling
  // back to city routing (Codex P2 on PR #2588).
  const rawLat = customer.latitude;
  const rawLng = customer.longitude;
  const lat = rawLat == null || rawLat === '' ? NaN : Number(rawLat);
  const lng = rawLng == null || rawLng === '' ? NaN : Number(rawLng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const geo = nearestLocation(lat, lng);
    if (geo) return geo;
  }
  // Stored office next: tracking-number leads store an AREA label in city
  // ("North Port / Port Charlotte") with the true office in
  // nearest_location_id — same precedence the review cadence uses
  // (Codex P2 #2588 r4).
  const stored = WAVES_LOCATIONS.find((l) => l.id === customer.nearest_location_id);
  if (stored) return stored;
  const ReviewService = require('./review-request');
  const locationId = ReviewService.resolveReviewLocationId(customer);
  return WAVES_LOCATIONS.find((l) => l.id === locationId) || WAVES_LOCATIONS[0];
}

/**
 * Tech on record for a completion — service_records.technician_id with the
 * same scheduled_services fallback the review lane uses (legacy rows or
 * completions where the tech wasn't tagged on the record).
 */
async function resolveTechnicianId({ serviceRecordId, scheduledServiceId }) {
  if (serviceRecordId) {
    const sr = await db('service_records')
      .where({ id: serviceRecordId })
      .first('technician_id', 'scheduled_service_id');
    if (sr?.technician_id) return sr.technician_id;
    if (sr?.scheduled_service_id && !scheduledServiceId) {
      scheduledServiceId = sr.scheduled_service_id;
    }
  }
  if (scheduledServiceId) {
    const ss = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('technician_id');
    if (ss?.technician_id) return ss.technician_id;
  }
  return null;
}

/**
 * Mint (or complete) the customer's card off a completed visit. Idempotent:
 * one card per customer, ever (unique customer_id). Never throws for the
 * caller's benefit — the dispatch completion flow fire-and-forgets this.
 */
async function ensureCardForCompletion({ customerId, serviceRecordId = null, scheduledServiceId = null }) {
  if (!customerId) return null;

  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer || customer.deleted_at) return null;

  let card = await db('customer_cards').where({ customer_id: customerId }).first();

  if (!card) {
    const technicianId = await resolveTechnicianId({ serviceRecordId, scheduledServiceId })
      .catch(() => null);
    const location = pickCardLocation(customer);

    const insertRow = {
      customer_id: customerId,
      share_token: generateToken(),
      technician_id: technicianId,
      service_record_id: serviceRecordId,
      location_id: location.id,
      review_target_url: location.googleReviewUrl,
      first_visit_completed_at: new Date(),
    };
    // Race-safe: a concurrent completion inserts first → ignore and re-read.
    await db('customer_cards').insert(insertRow).onConflict('customer_id').ignore();
    card = await db('customer_cards').where({ customer_id: customerId }).first();
    if (!card) return null;

    // Make sure a referral link exists so the card's Share action has a real
    // destination. enrollPromoter is get-or-create with no sends.
    try {
      const { enrollPromoter } = require('./referral-engine');
      await enrollPromoter(customerId);
    } catch (err) {
      // PII: error class/code only — a unique-violation message here can echo
      // customer phone/email values from Postgres details (Codex P1 #2588 r2).
      logger.warn(`[customer-card] promoter enroll skipped (customerId=${customerId} errType=${err?.name || 'Error'} code=${err?.code || 'n/a'})`);
    }

    logger.info(`[customer-card] Minted card (customerId=${customerId} cardId=${card.id} location=${card.location_id})`);
  } else if (!card.first_visit_completed_at) {
    await db('customer_cards').where({ id: card.id }).update({
      first_visit_completed_at: new Date(),
      updated_at: new Date(),
    });
    card = { ...card, first_visit_completed_at: new Date() };
  }

  // Short-link the review target so QR scans are click-tracked and the
  // destination stays swappable. Runs OUTSIDE the mint branch so a card
  // whose mint hit a degraded shortener heals on a later completion
  // instead of staying untracked forever (Codex P2 #2588 r4). Never blocks
  // — on failure the card keeps the long g.page URL.
  if (!card.review_short_code && card.review_target_url) {
    const { code, shortUrl } = await createTrackedShortLink(card.review_target_url, {
      kind: 'card',
      purpose: 'card_review',
      entityType: 'customer_cards',
      entityId: card.id,
      customerId,
    });
    if (code) {
      await db('customer_cards').where({ id: card.id }).update({
        review_short_code: code,
        review_short_url: shortUrl,
        updated_at: new Date(),
      });
      card = { ...card, review_short_code: code, review_short_url: shortUrl };
    }
  }

  await maybeSendCardEmail(card, customer);
  return card;
}

/**
 * card.issued email — DARK until GATE_DIGITAL_BUSINESS_CARD=true. Idempotent
 * twice over: email_sent_at on the row, plus a customer-scoped idempotency
 * key at the send layer (same pattern as referral-invite-email.js).
 */
async function maybeSendCardEmail(card, customer) {
  if (!gates.digitalBusinessCard) return null;
  if (!card || card.email_sent_at) return null;

  const email = String(customer?.email || '').trim();
  if (!email || !email.includes('@')) return null;

  let techFirstName = 'Your Waves tech';
  if (card.technician_id) {
    const tech = await db('technicians').where({ id: card.technician_id }).first('name');
    const first = firstNameOf(tech?.name);
    if (first) techFirstName = first;
  }

  try {
    const EmailTemplateLibrary = require('./email-template-library');
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'card.issued',
      to: email,
      payload: {
        first_name: String(customer.first_name || '').trim() || 'there',
        tech_first_name: techFirstName,
        card_url: `${publicPortalUrl()}/card/${card.share_token}`,
      },
      recipientType: 'customer',
      recipientId: customer.id,
      // One card email per customer — but the key carries a blocked-attempt
      // generation because the email library dedupes terminally on 'blocked'
      // rows. Same generation ⇒ concurrent attempts collapse to one send;
      // a blocked result bumps the generation below so a LATER completion
      // can retry once the suppression is corrected (Codex P2 #2588 r2).
      idempotencyKey: `card.issued:customer:${customer.id}:b${card.email_blocked_count || 0}`,
      triggerEventId: `card.issued:first_completion:${customer.id}`,
      categories: ['digital_card'],
      suppressProviderErrorLog: true,
    });
    // sendTemplate reports suppressions as { sent: false, blocked: true }
    // instead of throwing — don't stamp those, so the send retries on a
    // later completion if the suppression is corrected (Codex P2 on #2588).
    if (!result?.sent) {
      if (result?.blocked) {
        await db('customer_cards').where({ id: card.id }).update({
          email_blocked_count: db.raw('COALESCE(email_blocked_count, 0) + 1'),
          updated_at: new Date(),
        }).catch((err) => logger.warn(`[customer-card] blocked-count bump failed (cardId=${card.id} errType=${err?.name || 'Error'})`));
      }
      logger.info(`[customer-card] card.issued not sent (customerId=${customer.id} blocked=${!!result?.blocked} reason=${result?.reason || 'unknown'})`);
      return null;
    }
    await db('customer_cards').where({ id: card.id }).update({
      email_sent_at: new Date(),
      updated_at: new Date(),
    });
    logger.info(`[customer-card] card.issued sent (customerId=${customer.id} cardId=${card.id})`);
    return true;
  } catch (err) {
    const reason = err.status
      ? `provider ${err.status}`
      : require('./email-template-library').redactEmailAddresses(err.message);
    logger.warn(`[customer-card] card.issued failed (customerId=${customer.id}): ${reason}`);
    return null;
  }
}

/**
 * Public payload for GET /api/card/:token. Returns null for unknown tokens
 * and archived customers. Tech identity re-reads the technicians row so a
 * fresh photo upload shows without re-minting.
 */
async function getCardData(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const card = await db('customer_cards').where({ share_token: token }).first();
  if (!card) return null;

  const customer = await db('customers')
    .where({ id: card.customer_id })
    .first('id', 'first_name', 'member_since', 'created_at', 'has_left_google_review', 'deleted_at', 'referral_code');
  if (!customer || customer.deleted_at) return null;

  const location = WAVES_LOCATIONS.find((l) => l.id === card.location_id) || WAVES_LOCATIONS[0];

  let tech = null;
  if (card.technician_id) {
    const row = await db('technicians')
      .where({ id: card.technician_id })
      .first('name', 'photo_url', 'photo_s3_key');
    if (row) {
      const { resolveTechPhotoUrl } = require('./tech-photo');
      tech = {
        name: row.name || null,
        firstName: firstNameOf(row.name) || null,
        photoUrl: await resolveTechPhotoUrl(row.photo_s3_key, row.photo_url),
      };
    }
  }

  const referralUrl = await referralShareUrl(customer);

  return {
    customer: {
      firstName: customer.first_name || null,
      memberSinceYear: memberSinceYearET(customer),
      hasLeftGoogleReview: !!customer.has_left_google_review,
    },
    tech,
    phone: {
      display: location.phone,
      e164: location.phoneRaw,
    },
    reviewUrl: card.review_short_url || card.review_target_url || location.googleReviewUrl,
    referralUrl,
    firstVisitCompletedAt: card.first_visit_completed_at,
    // True only when pass-signing certs are configured — the page renders the
    // Add-to-Wallet button off this so a tap can never 404.
    walletAvailable: require('./wallet-pass').walletConfigured(),
  };
}

/**
 * vCard for the card's Save-contact action. Pure string builder — unit
 * tested without a DB. Escapes per RFC 6350 (backslash, comma, semicolon,
 * newline) so a name like "O'Brien; Sons" can't break the file.
 */
function vcardEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function buildVcard({ techName, phoneE164, licenseLine, addressLine }) {
  const name = String(techName || '').trim() || 'Waves Pest Control';
  const parts = name.split(/\s+/);
  const first = parts[0] || '';
  const last = parts.slice(1).join(' ');
  // "13649 Luxe Ave #110, Bradenton, FL 34211" → street / city / state+zip
  const [street = '', city = '', stateZip = ''] = String(addressLine || '').split(',').map((s) => s.trim());
  const [state = '', zip = ''] = stateZip.split(/\s+/);

  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vcardEscape(last)};${vcardEscape(first)};;;`,
    `FN:${vcardEscape(name)}`,
    'ORG:Waves Pest Control',
    'TITLE:Your Waves Technician',
    `TEL;TYPE=WORK,VOICE:${vcardEscape(phoneE164)}`,
    'EMAIL;TYPE=WORK:contact@wavespestcontrol.com',
    'URL:https://wavespestcontrol.com',
    `ADR;TYPE=WORK:;;${vcardEscape(street)};${vcardEscape(city)};${vcardEscape(state)};${vcardEscape(zip)};USA`,
    `NOTE:${vcardEscape(`${licenseLine} — save this card to reach Waves any time.`)}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

module.exports = {
  ensureCardForCompletion,
  getCardData,
  buildVcard,
  referralShareUrl,
  memberSinceYearET,
  __private: { pickCardLocation, vcardEscape, firstNameOf },
};
