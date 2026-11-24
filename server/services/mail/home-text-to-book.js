'use strict';

/**
 * Text to book, the answer to a new-home postcard (mailer step 2d-3, owner 2026-11-23). The card prints
 * "Text 101 EXAMPLE to (941) 297-2817": the house number and street name of the home, sent to the nearest office line.
 * A text to one of the four office location lines whose whole body is that address gets one reply from the same line
 * with the home's short link (GET /nh/:slug, routes/mail-home-short-link.js), which opens the home's page.
 *
 * Dark behind GATE_MAIL_HOME_TEXT_BOOK (it texts a person; the flip is the owner's) and GATE_MAIL_HOME_PAGE (the page the
 * link opens). Hooked in routes/twilio-webhook.js after STOP/HELP/START and after the lead-intake machine.
 *
 *   - The body is matched with the shared slug builder (home-slug.js). The words as typed are tried first ("88 LAKE VIEW"
 *     is "88-lake-view", a street whose name ends in a suffix word); then the type-stripped form ("101 Example Trl" is
 *     "101-example"), which must also agree with the home's own address line, so "88 LAKE VIEW" never lands on "88 LAKE ST".
 *     A trailing 5-digit ZIP selects the ZIP form ("101-example-34211"); a typed ZIP must be the home's own ZIP on every
 *     match that does not carry the ZIP in its slug. The slug must equal a live row's page_slug exactly (list_key
 *     new_home, status eligible or held_back). A bare address whose home only has the ZIP form is not guessed.
 *   - A text that names a unit ("101 Example Apt 9") gets no reply: the unit is never silently dropped and matched to
 *     another unit's home (the card prints house number and street name only).
 *   - Only a US/NANP sender (+1) is answered: the card is mailed to SW Florida homes. Any other number gets no reply and no read.
 *   - Any other text (most of them) costs no database read: the shape check alone turns it away.
 *   - One reply per sender, office line and home per 24 hours, and at most MAX_REPLIES_PER_SENDER (3) per sender per 24 hours
 *     across every home and office line (sendCustomerMessage has no recipient-wide daily cap for a customer-less
 *     conversational send). The reply is CLAIMED before the provider call (mail_home_text_replies, keyed by the home's
 *     prospect id), under one advisory lock per sender, so the cap and the per-home rule are checked and the row inserted
 *     atomically: two texts at the same moment send once for a home and never pass the cap. A sent or uncertain reply
 *     keeps its claim, a provable non-send releases it. sms_log is not the witness: link wrapping can rewrite the link in
 *     the stored body, and an uncertain handoff may have no row.
 *   - One copy for every home (the link, then the STOP line): no promise of a time or a price.
 *   - No lead and no customer is created here; the booking page creates the customer. No counter: no existing column fits.
 *   - Logs carry the prospect id and error codes only, never an address, a slug or a phone.
 */

const db = require('../../models/db');
const logger = require('../logger');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { mailHomePageLive, mailHomeTextBookLive } = require('../../config/feature-gates');
const { buildBaseSlug, hasUnitPart, streetWords, SLUG_RE, MAX_SLUG_LENGTH, STREET_SUFFIXES } = require('./home-slug');
const { USPS_STREET_SUFFIXES } = require('../property-lookup/usps-street-suffixes');
const { findOnlyKnownCallerCustomer, KNOWN_CALLER_PHONE_COLS } = require('../../utils/known-caller-phone');
const { phoneIdentityKey } = require('../../utils/phone');
const { contactPhoneSmsTrust } = require('../contact-notification-prefs');
const { publicPortalUrl } = require('../../utils/portal-url');

const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const LIVE_STATUSES = ['eligible', 'held_back'];
const ENTRY_POINT = 'mail_home_text_to_book';
const CLAIM_TABLE = 'mail_home_text_replies';
const REPLY_WINDOW_HOURS = 24;
// Replies one sender can get in the window, across every home and office line: sendCustomerMessage has no recipient-wide
// daily cap for a customer-less conversational send, so the claim table enforces it.
const MAX_REPLIES_PER_SENDER = 3;
// The body is bounded by length only: a street name of any word count fits the 60-character slug, and the exact live-slug
// match is the real filter. 120 covers a 60-character slug plus its street type, a ZIP and punctuation.
const MAX_BODY_LENGTH = 120;
// The postcard goes to SW Florida homes: only a US/NANP sender (+1, a valid area code and exchange) is answered. Any other
// number gets no reply and no table read; it never reaches the recipient normalizer of the SMS pipeline, which would read
// ten international digits as a +1 number.
const NANP_SENDER = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

const errCode = (err) => String((err && (err.code || err.name)) || 'error').slice(0, 32);
const zip5Of = (zip) => (String(zip == null ? '' : zip).match(/\d{5}/) || [null])[0];

/**
 * What a text may name, or null when it is not that shape. `candidates` are slugs, best first: the words as typed, then the
 * type-stripped form (each with its ZIP form first when a ZIP was typed). `fallback` holds the slugs reachable only by
 * stripping a street type. `street` is the text without its ZIP.
 *   "101 example"        -> candidates ['101-example'], zip null
 *   "101 Example Trl"    -> candidates ['101-example-trl', '101-example'], fallback ['101-example']
 *   "101 EXAMPLE 34211"  -> candidates ['101-example-34211', '101-example'], zip '34211'
 */
function parseAddressText(body) {
  if (typeof body !== 'string') return null;
  const text = body.trim().replace(/\s+/g, ' ').toUpperCase().replace(/[.!]+$/, '');
  if (!text || text.length > MAX_BODY_LENGTH) return null;
  // A house number, then any letters (accents too: the slug builder folds them), digits and the marks a street name carries;
  // no "?", ":" or other sentence or URL punctuation, no control character.
  if (!/^\d+ [\p{L}\p{N} .,'\u2019&/()-]+$/u.test(text)) return null;

  let street = text;
  let zip = null;
  const withZip = /^(.+ .+) (\d{5})$/.exec(text);
  if (withZip) {
    street = withZip[1];
    zip = withZip[2];
  }
  // A unit in the text ("101 Example Apt 9") is not the postcard's grammar and buildBaseSlug would drop it, matching the
  // text to another unit's home: no reply.
  if (hasUnitPart(street)) return null;
  const stripped = buildBaseSlug(street);
  if (!stripped) return null;
  const exact = buildBaseSlug(street, { keepStreetType: true });
  const candidates = [];
  const fallback = new Set();
  for (const base of [...new Set([exact, stripped].filter(Boolean))]) {
    for (const slug of (zip ? [`${base}-${zip}`, base] : [base])) {
      if (slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug) || candidates.includes(slug)) continue;
      candidates.push(slug);
      if (base !== exact) fallback.add(slug);
    }
  }
  return { candidates, zip, street, fallback };
}

// "101 EXAMPLE TRL" -> "101 Example Trl" (a directional stays in capitals).
function displayAddress(addressLine1) {
  return String(addressLine1 || '').trim().replace(/\s+/g, ' ').split(' ')
    .map((word) => {
      if (DIRECTIONALS.has(word.toUpperCase())) return word.toUpperCase();
      const lower = word.toLowerCase();
      return lower.replace(/(^|[-'])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
    })
    .join(' ');
}

const canonWord = (word) => USPS_STREET_SUFFIXES[word] || word;
const sameWords = (a, b) => a.length === b.length && a.every((word, i) => word === b[i]);

/**
 * The type-stripped slug of a text only counts when the text agrees with the home's own address line: the same words, a
 * street type spelled any USPS way, or a county line that has no street type. "88 LAKE VIEW" typed for a home on
 * "88 LAKE ST" does not (VIEW is not ST). Both lines are read with the slug builder's own word rules (streetWords: accents
 * folded, punctuation and the unit part gone), so "3 CAFE DEL MAR DR" agrees with a stored "3 CAF\u00c9 DEL MAR DR".
 * A line this cannot read (a directional it cannot place) is not matched: no reply.
 */
function streetTypeAgrees(street, addressLine1) {
  const typed = streetWords(street).map(canonWord);
  const row = streetWords(addressLine1).map(canonWord);
  if (sameWords(typed, row)) return true;
  const n = typed.length;
  const typeAt = n > 2 && DIRECTIONALS.has(typed[n - 1]) && STREET_SUFFIXES.has(typed[n - 2]) ? n - 2 : n - 1;
  return sameWords(typed.filter((_, k) => k !== typeAt), row);
}

async function findLiveHome({ candidates, zip, street, fallback }) {
  if (!candidates.length) return null;
  const rows = await db('mail_prospects')
    .where({ list_key: LIST_KEY })
    .whereIn('status', LIVE_STATUSES)
    .whereIn('page_slug', candidates)
    .select('id', 'page_slug', 'address_line1', 'zip');
  const bySlug = new Map(rows.map((row) => [row.page_slug, row]));
  for (const slug of candidates) {
    const row = bySlug.get(slug);
    if (!row) continue;
    // A typed ZIP is the home's own ZIP on every match whose slug does not carry it (another ZIP is another home's address).
    if (zip && !slug.endsWith(`-${zip}`) && zip5Of(row.zip) !== zip) continue;
    if (fallback.has(slug) && !streetTypeAgrees(street, row.address_line1)) continue;
    return row;
  }
  return null;
}

/**
 * The reply claim, taken and committed before the provider call. Returns { claimId } or { refused: 'sender_cap' | 'repeat' }.
 * One advisory lock per SENDER makes both checks and the insert atomic: a sender over MAX_REPLIES_PER_SENDER claims in the
 * window (any home, any office line) is refused, then a sender with a claim for this home on this office line is refused.
 * Two texts at the same moment, for the same home or different homes, wait for each other and see the other's committed row.
 */
async function claimReply({ from, to, prospectId }) {
  // Ten-digit keys: the sender is a NANP number (NANP_SENDER) and the line is one of ours, so phoneIdentityKey is their ten digits.
  const sender = phoneIdentityKey(from);
  const key = { phone_digits: sender, line_digits: phoneIdentityKey(to), prospect_id: prospectId };
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${CLAIM_TABLE}:${sender}`]);
    const inWindow = () => trx(CLAIM_TABLE).whereRaw(`claimed_at > now() - interval '${REPLY_WINDOW_HOURS} hours'`);
    const [{ n }] = await inWindow().where({ phone_digits: sender }).count({ n: '*' });
    if (Number(n) >= MAX_REPLIES_PER_SENDER) return { refused: 'sender_cap' };
    if (await inWindow().where(key).first('id')) return { refused: 'repeat' };
    const [row] = await trx(CLAIM_TABLE).insert(key).returning('id');
    return { claimId: (row && row.id) || row };
  });
}

// A provable non-send frees the claim; a failed release keeps it (a missed reply beats a doubled one).
async function releaseClaim(claimId) {
  try {
    await db(CLAIM_TABLE).where({ id: claimId }).del();
  } catch (err) {
    logger.warn(`[mail-home-text-to-book] claim release failed (${errCode(err)})`);
  }
}

// One copy for every home. It promises nothing the page may not deliver (times, a price): the page says what is on offer.
function replyBody({ address, slug }) {
  return `Here's your Waves page for ${address}: ${publicPortalUrl()}/nh/${slug}\n\nReply STOP to opt out.`;
}

// The sender's customer, for the opt-out and consent checks. The webhook matches phones on their last ten digits, so a customer
// counts only when one of its stored numbers is the sender's NANP number (phoneIdentityKey: the same ten digits, and a stored
// international number never equals it). The webhook's primary match is verified first; otherwise (`knownContact`: a record has
// the number as a secondary or service-contact phone, or the webhook's own match failed the check) the ONE customer owning it is
// read and verified the same way. null = no record claims the number (a lead). false = a record claims it that cannot be
// confirmed as the sender's (two owners, a different number, or a failed read): no reply, consent unknown.
async function senderCustomerId(from, customer, knownContact) {
  const key = phoneIdentityKey(from);
  if (customer && phoneIdentityKey(customer.phone) === key) return customer.id;
  if (!customer && !knownContact) return null;
  const only = await findOnlyKnownCallerCustomer(db, from, ['id', ...KNOWN_CALLER_PHONE_COLS]);
  return only && KNOWN_CALLER_PHONE_COLS.some((col) => phoneIdentityKey(only[col]) === key) ? only.id : false;
}

/**
 * Answer a postcard text. `customer` is the webhook's matched customer for the sender, `knownContact` says the webhook found a
 * customer record that has the number as a secondary or service-contact phone, and `standAside` is an async predicate that
 * makes the reply stand down. Resolves { handled: true } when a reply was handed to the provider (sent, uncertain or threw
 * with no outcome: it may have gone, so the claim stays and nothing is retried), so the webhook can keep the AI auto-reply
 * from answering the same text; every other outcome is { handled: false } and the text goes on through the normal inbound
 * handling. Never throws.
 */
async function handleHomeTextToBook({ from, to, body, customer, knownContact, standAside = async () => false }) {
  try {
    if (!mailHomePageLive() || !mailHomeTextBookLive() || !NANP_SENDER.test(from)) return { handled: false };
    // Only the office location lines (the GBP numbers the card prints); never the AI line, a tech line or a tracking line.
    // findByNumber alone is not enough: it also reports the AI chat line (the toll-free number) as a location.
    const locationId = Object.keys(TWILIO_NUMBERS.locations).find((id) => TWILIO_NUMBERS.locations[id].number === to);
    const parsed = parseAddressText(body);
    // Never a staff phone (a CSR or office-manager cell, a forward number, our own lines): GATE_TECH_STAFF_GUARDS covers technicians only.
    const home = locationId && parsed && !TWILIO_NUMBERS.isInternalNumber(from) && await findLiveHome(parsed);
    if (!home) return { handled: false };

    // Checked only now, for a text that matched a live home, so an ordinary text costs no extra read: an estimate address
    // question waiting on its answer comes first, and a known contact must resolve to one customer whose consent is read.
    const customerId = await senderCustomerId(from, customer, knownContact);
    if (customerId === false || await standAside()) return { handled: false };
    // A known customer's SMS opt-out and consent are checked as for every other known-customer auto-reply; no match is a
    // lead. A number in a service-contact slot is 'service_contact_authorized' (contactPhoneSmsTrust), so the sender re-reads
    // THAT contact's own SMS choice at the provider handoff, not only the holder's.
    const who = customerId
      ? { customerId, identityTrustLevel: await contactPhoneSmsTrust(customerId, from) }
      : { identityTrustLevel: 'phone_provided_unverified' };

    const claim = await claimReply({ from, to, prospectId: home.id });
    if (!claim.claimId) {
      logger.info(`[mail-home-text-to-book] no reply for prospect ${home.id} (${claim.refused})`);
      return { handled: false };
    }

    const { sendCustomerMessage } = require('../messaging/send-customer-message');
    const { isRealProviderSend, isAmbiguousProviderOutcome } = require('../sms-auto-send');
    let result;
    try {
      result = await sendCustomerMessage({
        to: from,
        body: replyBody({ address: displayAddress(home.address_line1), slug: home.page_slug }),
        channel: 'sms',
        audience: 'lead',
        purpose: 'conversational',
        ...who,
        consentBasis: { status: 'transactional_allowed', source: ENTRY_POINT },
        entryPoint: 'mail_home_text_to_book', // a literal: staff-reply-surfaces-interlock.test.js reads it from the source
        // The reply leaves from the line the text came to.
        metadata: { original_message_type: ENTRY_POINT, templateKey: ENTRY_POINT, fromNumber: to },
      });
    } catch (err) {
      // A thrown outcome is the provider's own; a bare throw may have reached it, so it counts as uncertain.
      logger.warn(`[mail-home-text-to-book] send threw for prospect ${home.id} (${errCode(err)})`);
      result = err.providerOutcome || { deliveryOutcome: 'uncertain' };
    }
    if (isRealProviderSend(result)) {
      logger.info(`[mail-home-text-to-book] replied for prospect ${home.id} from the ${locationId} line`);
      return { handled: true, prospectId: home.id };
    }
    if (isAmbiguousProviderOutcome(result)) {
      logger.warn(`[mail-home-text-to-book] reply for prospect ${home.id} left uncertain; claim kept, not retried`);
      return { handled: true, prospectId: home.id };
    }
    await releaseClaim(claim.claimId);
    logger.info(`[mail-home-text-to-book] reply for prospect ${home.id} not sent (${String(result.code || 'refused').slice(0, 40)})`);
    return { handled: false };
  } catch (err) {
    logger.warn(`[mail-home-text-to-book] failed (${errCode(err)})`);
    return { handled: false };
  }
}

module.exports = { handleHomeTextToBook, ENTRY_POINT, _test: { parseAddressText, displayAddress, replyBody, findLiveHome, streetTypeAgrees, claimReply, MAX_REPLIES_PER_SENDER } };
