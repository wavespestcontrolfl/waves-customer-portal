/**
 * Technician Visit Brief: the customer's texts of the last 7 days (GATE_TECH_VISIT_TEXTS).
 *
 * Read-only. One customer, one window (ET midnight 7 days before the visit date, up to now), sms_log only: no call_log,
 * no transcript, no model call. Every row is sorted into one of three bins by textVerdict():
 *   show    a plain customer reply, or an office text of a visit-related type with no money word in it;
 *   hidden  money or unknown: counted, the body never leaves this module;
 *   skip    noise the technician does not need (reminders, tapbacks, opt-in words, failed sends): not counted.
 * A card number, a labeled card / bank detail or a link hides the whole text. An outbound type that is in neither list is hidden, so a type added later stays out until someone lists it here.
 */
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { scrubPansDetailed, scrubSegments } = require('../utils/pan-scrub');
const { scrubNoteText } = require('../utils/note-secret-scrubber');
const { scrubSecretText } = require('../utils/secret-text-scrubber');
const { isSmsReaction } = require('./sms-intent');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { isPaymentScopedText } = require('./payment-status-contract');
const { findShortenerHost } = require('./comms-lint');
const { normalizeForLinkCheck } = require('./messaging/sms-link-policy');
const psl = require('psl');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

const WINDOW_DAYS = 7;
const MAX_TEXTS = 40;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
// Only these image types are ever signed: a PDF or any other document is never linked.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']);

const SHOW_INBOUND_TYPES = new Set(['inbound', 'domain_lead', 'van_lead', 'reschedule_reply']);
const SHOW_OUTBOUND_TYPES = new Set([
  'manual', 'ai_approved', 'ai_revised', 'ai_autosent', 'ai_assistant_reply', 'auto_reply', 'customer_reply',
  'appointment_rescheduled', 'appointment_cancelled', 'reschedule_reply', 'reschedule_series_confirmation',
  'rain_out_moved_v2', 'rain_out_moved_v3', 'rain_out_moved_day_v1', 'rain_out_moved_custom_v1', 'rain_out_customer_pick_v1',
  'prep_info', 'prep_guide', 'lawn_watering_instruction',
]);
// Not money, and not worth a technician's attention: dropped without a count.
const QUIET_TYPES = new Set([
  'sms_reaction', 'opt_in', 'opt_out', 'help_request', 'recipient_optin_request',
  'appointment_reminder', 'appointment_reminder_72h', 'reminder', 'reminder_24h', 'reminder_72h',
  'confirmation', 'appointment_confirmation', 'tech_en_route', 'review_request', 'review', 'review_followup',
]);
// Statuses an outbound text may carry once it left (customer-activity-timeline.js OUTBOUND_LEFT).
const OUTBOUND_LEFT = ['', 'sent', 'queued', 'accepted', 'delivered', 'read', 'failed', 'undelivered'];
// An outbound text is shown only in a state that reached the customer: the timeline's list without its two failure states and without
// the blank legacy status (a blank status proves nothing reached anyone).
const SENT_STATUSES = new Set(OUTBOUND_LEFT.filter((status) => status !== '' && status !== 'failed' && status !== 'undelivered'));

// bill, invoice, charge, card, payment, pay, paid, refund, price, cost, balance, owe, a dollar amount; plus the plain
// forms of the same words a customer types (autopay, receipt, deposit, cash, venmo, zelle, fee).
const MONEY_WORDS = /\b(bills?|billed|billing|invoices?|invoiced|charges?|charged|charging|cards?|payments?|pay|pays|paying|paid|payable|refunds?|refunded|prices?|priced|pricing|costs?|balance|balances|owe|owes|owed|owing|autopay|receipts?|deposits?|cash|venmo|zelle|fees?)\b/i;
const DOLLAR_AMOUNT = /\$\s?\d|\b\d[\d,]*(\.\d{1,2})?\s*(dollars?|bucks)\b/i;

// Card or bank details a customer may text: a labeled CVV / security code / expiry, a routing or account number.
const CREDENTIAL_WORDS = /\b(?:cvv2?|cvc2?|cid|security code|card code|expir(?:y|es|ation|ing)|exp\.? date|valid (?:thru|through)|routing)\b|\bexp\b\.?[^\n]{0,12}?\d{1,2}\s*[/-]\s*\d{2,4}|\b(?:account|acct|acc|bank|checking|savings)\b[^\n]{0,24}?\d(?:[\s.-]?\d){5,}|\b(?:account|acct)\.?\s*(?:number|no\.?|#)|\b\d{8,17}\b/i;
// A link: a customer-action link (reschedule, pay, estimate, portal) works without a login, and a technician must never
// read one that belongs to another visit of the customer. Any text carrying a URL, a www. address or a short link is held back.
const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|us|app|link|ly|me|info|biz)\b/i;

function hasMoneyWords(body) {
  const text = String(body || '');
  return MONEY_WORDS.test(text) || DOLLAR_AMOUNT.test(text);
}

// A card number (the repo's PAN detector, spoken and spaced forms included) or a labeled card / bank detail.
// A scheme-less address on any real public suffix (photos.example.dev/yard, example.dev): every dotted host-shaped token, read from a
// normalized copy (full-width dots, zero-width joins, percent-encoding), is checked against the public suffix list. A token whose last
// label is not a listed suffix ("done.Thanks") is prose. Over-hiding a sentence that glues two words around a real suffix is accepted.
function hasPublicHost(body) {
  const lower = normalizeForLinkCheck(String(body || '')).toLowerCase();
  const hosts = lower.match(/(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/g) || [];
  return hosts.some((host) => psl.parse(host).listed);
}

function hasLink(body) {
  // A bare shortened link (is.gd/abc, rb.gy/x) has no scheme and may sit outside the list below: the repo's shortener recognizer
  // (comms-lint.js: its host list plus the short-host fingerprint) covers the rest.
  return LINK.test(String(body || '')) || Boolean(findShortenerHost(body)) || hasPublicHost(body);
}

// A sign-in or verification code (a bank, Google, a login): the access-code reader's own verification wording, plus login and
// passcode forms it does not list. A gate or door code ("gate code is 1234") is not one of these.
const SIGN_IN_CODE = /\botp\b|\b(?:log[- ]?in|sign[- ]?in|passcode|pass code|login)\b[^.?!\n]{0,24}\bcodes?\b|\bpasscodes?\b|\bcodes?\b[^.?!\n]{0,24}\b(?:log[- ]?in|sign[- ]?in)\b/i;
function hasSignInCode(body) {
  const text = String(body || '');
  return SIGN_IN_CODE.test(text) || require('./access-code-capture').VERIFICATION_CONTEXT.test(text);
}

// One reading of a body for every number screen: NFKC (full-width digits and letters), zero-width characters removed, typographic
// dashes as "-".
function normalizedBody(body) {
  return String(body || '').normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-');
}

// What cannot be a credential: a clock time (h:mm, h:mm am/pm), a numeric date (11/26, 11/26/2026) and a month-name date (Nov 26).
// "1030am" is not exempt.
const TIME_OF_DAY = /\b\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?(?!\d)/gi;
const NUMERIC_DATE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?!\d)/g;
const NAMED_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?!\d)/gi;

// A run of 3 or more digits, spaces, dashes and dots between digits collapsed first ("12 34", "1-2-3"). A gate or door code, a house
// number, a phone number or a ZIP all land here: the texts list never carries a number that could open something, and the brief's own
// access block (which enforces property and visit) is where a technician gets a code.
function hasNumberRun(body) {
  const text = normalizedBody(body).replace(NAMED_DATE, ' x ').replace(NUMERIC_DATE, ' x ').replace(TIME_OF_DAY, ' x ');
  return /\d{3,}/.test(text.replace(/(?<=\d)[\s.-]{1,3}(?=\d)/g, ''));
}

function hasCardCredentials(body) {
  // Typographic dashes and full-width digits read as the plain ones, as the card and SSN screens expect.
  const text = normalizedBody(body);
  // scrubNoteText reads a normalized copy (typographic dashes, full-width digits) and also finds SSNs, tokens and keys.
  // scrubSecretText: labelled secrets in prose ("My OTP is 123456", "password: x", a PIN) and known secret formats.
  return CREDENTIAL_WORDS.test(text) || hasSignInCode(text) || scrubSecretText(text).removed > 0 || scrubPansDetailed(text).count > 0 || scrubNoteText(text).removed > 0;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

function mediaOf(row) {
  const media = parseMetadata(row.metadata).media;
  return Array.isArray(media) ? media : [];
}

const isImageType = (type) => IMAGE_TYPES.has(String(type || '').split(';')[0].trim().toLowerCase());

// The customer's image attachments, counted by content type even when the upload left no stored object, so a missing photo is
// reported. Only an item with a stored key can be signed (signedPhotos).
function photosOf(row) {
  if (row.direction !== 'inbound') return [];
  return mediaOf(row).filter((item) => item && isImageType(item.contentType));
}

// An app notification a device accepted is logged in sms_log (status 'sent', from_phone 'push', metadata.channel 'push'): it is
// not a text, so it is neither shown nor counted (the same check customer-activity-timeline.js makes).
function isPushProof(row) {
  return String(row.from_phone || '').toLowerCase() === 'push' || String(parseMetadata(row.metadata).channel || '').toLowerCase() === 'push';
}

// The tech-line composer (services/tech-line-texts.js) sends 'manual' from the technician's own line with his id as the sender
// (sms_log.admin_user_id), and leaves no metadata mark on the row. Both of those are what the row records, and an automated
// send of type 'manual' has no technician id: so a manual text with a sender id from a registered technician line is his own.
const isTechLineText = (row) => Boolean(row.admin_user_id) && TWILIO_NUMBERS.fieldTech.some((line) => line.number === row.from_phone);

const isEnforcedSpam = (row) => parseMetadata(row.metadata).spam_verdict?.enforced === true;

// Noise that is neither shown nor counted: quiet types, push records, tapbacks, screened spam, texts that never left.
function isNoise(row) {
  const inbound = row.direction === 'inbound';
  if (QUIET_TYPES.has(row.message_type || '') || isPushProof(row)) return true;
  if (inbound) return isSmsReaction(row.message_body) || isEnforcedSpam(row);
  if (!SENT_STATUSES.has(String(row.status || '').toLowerCase())) return true;
  // 'manual' is also what marketing, retention and follow-up sends are stored as: it counts as written by a person only with the
  // composer's metadata.human_authored stamp (as sms-gratitude-context.js reads it) or as a technician's own text from his line.
  return (row.message_type || '') === 'manual' && parseMetadata(row.metadata).human_authored !== true && !isTechLineText(row);
}

// Held back and counted: a type off the allow-list, money, card or bank details, a number, a link, or one of the customer's STORED
// access codes (every property's, job-card.js's own matcher: case-insensitive, whole token). `codes` is that matcher as a RegExp, null
// when there is nothing stored, or false when the stored codes could not be read: then fail closed on any digit or all-caps token.
function mentionsStoredCode(body, codes) {
  const text = normalizedBody(body);
  if (codes === false) return /\d|\b[A-Z]{3,}\b/.test(text);
  return Boolean(codes) && codes.test(text);
}

function isHeldBack(row, codes = null) {
  if (!(row.direction === 'inbound' ? SHOW_INBOUND_TYPES : SHOW_OUTBOUND_TYPES).has(row.message_type || '')) return true;
  const body = row.message_body;
  return hasMoneyWords(body) || hasCardCredentials(body) || hasNumberRun(body) || hasLink(body) || isPaymentScopedText(body) || mentionsStoredCode(body, codes);
}

// 'show' | 'hidden' | 'skip' for one sms_log row ({ direction, message_type, status, message_body, metadata }).
// `withPhotos` (GATE_TECH_VISIT_TEXT_PHOTOS): a customer's photo with no words shows, as its image only.
function textVerdict(row, { withPhotos = false, codes = null } = {}) {
  if (isNoise(row)) return 'skip';
  if (isHeldBack(row, codes)) return 'hidden';
  // No words: shown only as a customer's image, and only with the photo switch on. Words that a screen above hid keep the row hidden.
  if (!String(row.message_body || '').trim()) return withPhotos && photosOf(row).length ? 'show' : 'skip';
  return 'show';
}

// ET midnight, 7 ET calendar days before the visit's scheduled date. Never a fixed UTC offset.
function windowStart(scheduledDate) {
  const day = dateOnlyString(scheduledDate);
  if (!day) return null;
  const noon = parseETDateTime(`${day}T12:00`);
  return parseETDateTime(`${etDateString(addETDays(noon, -WINDOW_DAYS))}T00:00`);
}

// The photos the customer sent (GATE_TECH_VISIT_TEXT_PHOTOS), as short-lived signed links. Only a stored object (S3 key) is
// ever linked: a provider URL is never returned, and a photo that cannot be signed is left out.
async function signedPhotos(row, sign) {
  const media = photosOf(row).filter((item) => item.key);
  if (!media.length) return [];
  // Stored objects only: any url / providerUrl on the item is dropped first, so a failed signature can never fall back to one.
  const signed = await sign(media.map(({ url, providerUrl, ...stored }) => stored));
  return signed
    .filter((item) => item.url)
    .map((item) => ({ url: item.url, contentType: item.contentType || null }));
}

// A scheduled send is two rows: the queue parent (promoted to 'sent' when the text leaves) and the provider row that names
// it in metadata.scheduled_sms_log_id (as customer-activity-timeline.js). Keep the provider row, drop the parent.
function withoutQueueParents(rows) {
  const parents = new Set(rows.map((row) => parseMetadata(row.metadata).scheduled_sms_log_id).filter(Boolean).map(String));
  return rows.filter((row) => !parents.has(String(row.id)));
}

// One customer's sms_log rows in the window, the way every sms_log reader builds them: no recruiting threads, no unresolved
// send reservations, and a scheduled send's queue parent left out when its provider row is there.
function visibleWindowQuery(db, customerId, start, now) {
  const query = db('sms_log as sl')
    .where('sl.customer_id', customerId)
    .where('sl.created_at', '>=', start)
    .where('sl.created_at', '<=', now)
    .whereNotExists(function providerTwin() {
      this.select(1).from('sms_log as twin')
        .where('twin.direction', 'outbound')
        .whereRaw('twin.customer_id = sl.customer_id')
        .whereRaw('twin.id <> sl.id')
        .whereRaw("twin.metadata->>'scheduled_sms_log_id' = sl.id::text")
        .whereRaw(`LOWER(COALESCE(twin.status, '')) IN (${OUTBOUND_LEFT.map(() => '?').join(', ')})`, OUTBOUND_LEFT)
        .modify((q) => excludeUnresolvedSendReservations(q, 'twin'));
    });
  return excludeUnresolvedSendReservations(excludeRecruitingSmsLog(query, 'sl.message_type'), 'sl');
}

// The window's rows, newest first, read in pages (at most MAX_PAGES x PAGE_SIZE) so a run of reminders newer than a
// customer's instruction cannot push it out of view. Classification happens after, over every row read.
async function windowRows(db, customerId, start, now) {
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await visibleWindowQuery(db, customerId, start, now)
      .orderBy('sl.created_at', 'desc')
      .orderBy('sl.id', 'desc')
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE)
      .select('sl.id', 'sl.direction', 'sl.message_body', 'sl.message_type', 'sl.status', 'sl.from_phone', 'sl.admin_user_id', 'sl.metadata', 'sl.created_at');
    for (const row of batch) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    if (batch.length < PAGE_SIZE) break;
  }
  return withoutQueueParents(rows);
}

// Inbound texts that must be withheld because of the texts around them: a card number sent a few digits at a time (the repo's
// cross-segment detector reads the customer's inbound texts in order, on normalized bodies; each text it masks or empties took part), and
// a reply of only 1-2 digits right after an inbound text that a credential, secret, sign-in, card or number screen held back ("my
// verification code is" ... "48").
const SHORT_DIGITS_ONLY = /^[^\p{L}\p{N}]*\d{1,2}[^\p{L}\p{N}]*$/u;
function sequenceHeldIds(rows) {
  const inbound = rows
    .filter((row) => row.direction === 'inbound' && typeof row.message_body === 'string' && row.message_body)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || String(a.id).localeCompare(String(b.id)));
  const bodies = inbound.map((row) => normalizedBody(row.message_body));
  const { segments } = scrubSegments(bodies.map((text) => ({ text })));
  const held = new Set();
  let previousHeld = false;
  inbound.forEach((row, i) => {
    const sequence = segments[i].text !== bodies[i] || (SHORT_DIGITS_ONLY.test(bodies[i]) && previousHeld);
    if (sequence) held.add(row.id);
    previousHeld = sequence || hasCardCredentials(bodies[i]) || hasNumberRun(bodies[i]);
  });
  return held;
}

// The customer's stored access codes as job-card.js's matcher: every property's gate, garage and lockbox codes (property_preferences) and
// every code filed in customer_access_codes (any status: a dismissed code is still a code). null = none stored; false = a read failed.
async function storedCodePattern(db, customerId) {
  try {
    const jobCard = require('./job-card');
    const prefs = await db('property_preferences').where({ customer_id: customerId })
      .select('neighborhood_gate_code', 'property_gate_code', 'garage_code', 'lockbox_code');
    const filed = await db('customer_access_codes').where({ customer_id: customerId }).whereNotNull('code').select('code');
    const codes = [...prefs.flatMap((row) => jobCard.accessCodes(row)), ...filed.map((row) => ({ code: row.code }))];
    return jobCard.knownCodePattern(codes, 'i');
  } catch {
    return false;
  }
}

async function visitTexts(db, svc, { now = new Date(), sign = null, withPhotos = false } = {}) {
  const start = windowStart(svc.scheduled_date);
  if (!svc.customer_id || !start) return { texts: [], hidden: 0 };
  const signer = sign || ((media) => require('./sms-media').signMediaForClient(media));
  const rows = await windowRows(db, svc.customer_id, start, now);
  let hidden = 0;
  const shown = [];
  const codes = await storedCodePattern(db, svc.customer_id);
  const sequenceRows = sequenceHeldIds(rows);
  for (const row of rows) {
    const verdict = sequenceRows.has(row.id) ? 'hidden' : textVerdict(row, { withPhotos, codes });
    if (verdict === 'hidden') hidden += 1;
    else if (verdict === 'show') shown.push(row);
  }
  const texts = await Promise.all(shown.slice(0, MAX_TEXTS).reverse().map(async (row) => ({
    id: row.id,
    direction: row.direction,
    at: row.created_at,
    body: row.message_body || '',
    photos: withPhotos ? await signedPhotos(row, signer) : [],
    photoCount: photosOf(row).length,
  })));
  return { texts, hidden };
}

module.exports = { textVerdict, hasMoneyWords, hasCardCredentials, hasLink, hasNumberRun, windowStart, visitTexts, WINDOW_DAYS, MAX_TEXTS, MAX_PAGES, PAGE_SIZE };
