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
 *   - The body is matched with the shared slug builder (home-slug.js): a street type is dropped ("101 Example Trl" is
 *     "101-example"), a trailing 5-digit ZIP selects the ZIP form ("101 Example 34211" is "101-example-34211"). The slug
 *     must equal a live row's page_slug exactly (list_key new_home, status eligible or held_back). A bare address whose
 *     home only has the ZIP form is not guessed: no reply, the text is handled as any other.
 *   - Any other text (most of them) costs no database read: the shape check alone turns it away.
 *   - One reply per sender, home and office line per 24 hours, read from the outbound sms_log.
 *   - No lead and no customer is created here; the booking page creates the customer. No counter: no existing column fits.
 *   - Logs carry the slug and ids only, never an address or a phone.
 */

const db = require('../../models/db');
const logger = require('../logger');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { mailHomePageLive, mailHomeTextBookLive } = require('../../config/feature-gates');
const { buildBaseSlug, SLUG_RE, MAX_SLUG_LENGTH } = require('./home-slug');
const { publicPortalUrl } = require('../../utils/portal-url');

const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const LIVE_STATUSES = ['eligible', 'held_back'];
const ENTRY_POINT = 'mail_home_text_to_book';
const REPLY_WINDOW_HOURS = 24;
// A house number, a street, at most a street type, a directional and a ZIP: more words than this is a sentence.
const MAX_WORDS = 8;
const MAX_BODY_LENGTH = 80;
const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

const errCode = (err) => String((err && (err.code || err.name)) || 'error').slice(0, 32);

/**
 * The slugs a text may name, best first, and the ZIP it gave; null when the text is not that shape.
 *   "101 example"        -> { candidates: ['101-example'], zip: null }
 *   "101 Example Trl"    -> { candidates: ['101-example'], zip: null }
 *   "101 EXAMPLE 34211"  -> { candidates: ['101-example-34211', '101-example'], zip: '34211' }
 * The plain slug after a ZIP is only a candidate: the caller accepts it when the home's own ZIP is the one typed.
 */
function parseAddressText(body) {
  if (typeof body !== 'string') return null;
  const text = body.trim().replace(/\s+/g, ' ').toUpperCase().replace(/[.!]+$/, '');
  if (!text || text.length > MAX_BODY_LENGTH) return null;
  // Digits first, then letters, digits and the few marks an address carries; no "?", no URL, no sentence.
  if (!/^\d+ [A-Z0-9 .,'-]+$/.test(text)) return null;
  if (text.split(' ').length > MAX_WORDS) return null;

  let street = text;
  let zip = null;
  const withZip = /^(.+ .+) (\d{5})$/.exec(text);
  if (withZip) {
    street = withZip[1];
    zip = withZip[2];
  }
  const base = buildBaseSlug(street);
  if (!base) return null;
  const candidates = zip ? [`${base}-${zip}`, base] : [base];
  return { candidates: candidates.filter((slug) => slug.length <= MAX_SLUG_LENGTH && SLUG_RE.test(slug)), zip };
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

const zip5Of = (zip) => (String(zip == null ? '' : zip).match(/\d{5}/) || [null])[0];

async function findLiveHome({ candidates, zip }) {
  if (!candidates.length) return null;
  const rows = await db('mail_prospects')
    .where({ list_key: LIST_KEY })
    .whereIn('status', LIVE_STATUSES)
    .whereIn('page_slug', candidates)
    .select('page_slug', 'address_line1', 'zip');
  const bySlug = new Map(rows.map((row) => [row.page_slug, row]));
  for (const slug of candidates) {
    const row = bySlug.get(slug);
    if (!row) continue;
    // The plain slug after a typed ZIP belongs to a home of that ZIP only; another ZIP is another home's address.
    if (zip && slug === candidates[candidates.length - 1] && slug !== candidates[0] && zip5Of(row.zip) !== zip) continue;
    return row;
  }
  return null;
}

const digits10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

async function repliedRecently({ from, to, slug }) {
  // The reply carries the link as its own line, so the slug ends at white space or the end of the body.
  const row = await db('sms_log')
    .where({ direction: 'outbound', message_type: ENTRY_POINT })
    .whereRaw("RIGHT(regexp_replace(to_phone, '[^0-9]', '', 'g'), 10) = ?", [digits10(from)])
    .whereRaw("RIGHT(regexp_replace(from_phone, '[^0-9]', '', 'g'), 10) = ?", [digits10(to)])
    .whereRaw("message_body ~ ('/nh/' || ? || '(\\s|$)')", [slug])
    .whereRaw(`created_at > now() - interval '${REPLY_WINDOW_HOURS} hours'`)
    .first('id');
  return Boolean(row);
}

function replyBody({ address, slug }) {
  return `Here's your Waves page for ${address}: ${publicPortalUrl()}/nh/${slug}\n\nPick a time and you're booked. Reply STOP to opt out.`;
}

/**
 * Answer a postcard text. Resolves { handled: true } only when a reply was handed to the provider (sent or uncertain),
 * so the webhook can keep the AI auto-reply from answering the same text; every other outcome is { handled: false } and
 * the text goes on through the normal inbound handling. Never throws.
 */
async function handleHomeTextToBook({ from, to, body }) {
  try {
    if (!mailHomePageLive() || !mailHomeTextBookLive()) return { handled: false };
    // Only the office location lines (the GBP numbers the card prints); never the AI line, a tech line or a tracking line.
    // findByNumber alone is not enough: it also reports the AI chat line (the toll-free number) as a location.
    const line = Object.entries(TWILIO_NUMBERS.locations).find(([, loc]) => loc.number === to);
    if (!line) return { handled: false };
    const locationId = line[0];
    const parsed = parseAddressText(body);
    if (!parsed) return { handled: false };
    const home = await findLiveHome(parsed);
    if (!home) return { handled: false };
    if (await repliedRecently({ from, to, slug: home.page_slug })) {
      logger.info(`[mail-home-text-to-book] repeat text for ${home.page_slug} inside ${REPLY_WINDOW_HOURS} h, no second reply`);
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
        identityTrustLevel: 'phone_provided_unverified',
        consentBasis: { status: 'transactional_allowed', source: ENTRY_POINT },
        entryPoint: 'mail_home_text_to_book', // a literal: staff-reply-surfaces-interlock.test.js reads it from the source
        metadata: {
          original_message_type: ENTRY_POINT,
          templateKey: ENTRY_POINT,
          // The reply leaves from the line the text came to.
          fromNumber: to,
        },
      });
    } catch (err) {
      result = err && err.providerOutcome && typeof err.providerOutcome === 'object' ? err.providerOutcome : null;
      if (!result) {
        logger.warn(`[mail-home-text-to-book] send threw for ${home.page_slug} (${errCode(err)})`);
        return { handled: false };
      }
    }
    if (result && result.sent && isRealProviderSend(result)) {
      logger.info(`[mail-home-text-to-book] replied for ${home.page_slug} from the ${locationId} line`);
      return { handled: true, slug: home.page_slug };
    }
    if (isAmbiguousProviderOutcome(result)) {
      logger.warn(`[mail-home-text-to-book] reply for ${home.page_slug} left uncertain; not retried`);
      return { handled: true, slug: home.page_slug };
    }
    logger.info(`[mail-home-text-to-book] reply for ${home.page_slug} not sent (${String((result && result.code) || 'refused').slice(0, 40)})`);
    return { handled: false };
  } catch (err) {
    logger.warn(`[mail-home-text-to-book] failed (${errCode(err)})`);
    return { handled: false };
  }
}

module.exports = { handleHomeTextToBook, ENTRY_POINT, _test: { parseAddressText, displayAddress, replyBody, findLiveHome } };
