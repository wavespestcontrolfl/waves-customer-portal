/**
 * HMAC-signed slot offers — proof a public commit request replays a slot the
 * availability generator ACTUALLY offered (booking-audit round 2, both
 * surfaces). Constraint mirrors (hours / horizon / grid / lunch / active
 * tech) stay in place as defense-in-depth, but the signature is the decisive
 * check: the generator signs each slot it returns over
 *
 *   {surface, scopeId, serviceKey, locationKey, date, startMinutes,
 *    technicianId-or-null, durationMinutes} + an expiry timestamp
 *
 * and the commit paths refuse anything that doesn't verify.
 *
 * serviceKey/locationKey (canonical string v2, booking-audit round 3): the
 * /book surface's scopeId is '' (anonymous funnel), so v1 offers bound only
 * the slot tuple — a caller could fetch offers for one address/service and
 * confirm a different one. The /book generator now binds the normalized
 * funnel service id and a rounded-coordinate location key into the signature
 * (see routes/booking.js); the estimate surface leaves both '' because its
 * scopeId (the estimate id) already pins service + address context.
 *
 * Two carrier shapes, one canonical string:
 *   - Estimate surface: the sig + exp ride INSIDE the slotId string
 *     (`<date>_<HH-MM>_<techId>.<exp>.<sig>`), because the estimate clients
 *     (SlotPicker/EstimateViewPage, the server-rendered estimate page) only
 *     ever send `{ slotId }` — no client change needed. scopeId = estimate id,
 *     so an offer minted for one estimate can't reserve under another.
 *   - /book surface: the funnel posts explicit slot fields, so the offer is a
 *     separate `slot_sig` field shaped `<exp>.<sig>` that the client passes
 *     through untouched. scopeId = '' (the funnel is anonymous; /availability
 *     is public, so the offer binds WHAT was offered, not who fetched it).
 *
 * Key derivation: purpose-specific key = SHA-256('waves:slot-offer:v1:' +
 * secret), where secret is the server's existing required JWT_SECRET (same
 * fallback chain as routes/booking.js's capture token — index.js fails closed
 * on a missing JWT_SECRET in production). No new env var is introduced.
 *
 * Expiry: offers stay redeemable for 45 minutes — longer than any real
 * pick-a-slot session (the estimate slot cache TTL is 5 min, so even a cached
 * offer has ≥40 min left), short enough to cap replay of a harvested list.
 * Expired/unsigned offers surface as the same "slot unavailable" errors the
 * clients already recover from by refreshing availability.
 *
 * Also home to the CSPRNG booking confirmation-code generator (moved from
 * routes/booking.js) so EVERY writer of confirmation_code — the public /book
 * confirm AND services/availability.js's zone-engine confirmBooking — shares
 * one implementation; codes are the only factor on GET /booking/status/:code.
 */
const crypto = require('crypto');

const RAW_SECRET = process.env.JWT_SECRET || process.env.BOOKING_CAPTURE_SECRET || 'waves-booking-capture-dev';
const OFFER_KEY = crypto.createHash('sha256').update(`waves:slot-offer:v1:${RAW_SECRET}`).digest();

const SLOT_OFFER_TTL_MS = 45 * 60 * 1000;
// Tolerance when rejecting implausibly-far-future (forged) expiries — covers
// clock skew between app instances that mint and verify.
const EXP_SKEW_MS = 60 * 1000;

function canonicalOfferString(payload = {}) {
  return [
    // v2: serviceKey + locationKey joined the signed scope (round 3). The tag
    // bump makes every v1 offer fail verification outright rather than
    // depending on field-count coincidences.
    'waves-slot-offer.v2',
    String(payload.surface || ''),
    String(payload.scopeId ?? ''),
    String(payload.serviceKey ?? ''),
    String(payload.locationKey ?? ''),
    String(payload.date || ''),
    String(Number(payload.startMinutes)),
    String(payload.technicianId || ''),
    String(Number(payload.durationMinutes)),
    String(Number(payload.exp)),
  ].join('|');
}

/**
 * Sign a slot offer. `payload`: { surface, scopeId, serviceKey, locationKey,
 * date, startMinutes, technicianId (null for unassigned), durationMinutes }.
 * serviceKey/locationKey default '' for surfaces whose scopeId already binds
 * that context. Returns { exp, sig }.
 */
function signSlotOffer(payload, now = Date.now()) {
  const exp = now + SLOT_OFFER_TTL_MS;
  const sig = crypto.createHmac('sha256', OFFER_KEY)
    .update(canonicalOfferString({ ...payload, exp }))
    .digest('base64url');
  return { exp, sig };
}

/**
 * Verify a slot offer. `payload` carries the same fields as signSlotOffer
 * PLUS the exp the offer was minted with (the expiry is bound into the signed
 * string, so a shifted exp fails the HMAC even before the bounds checks).
 * Constant-time compare; rejects expired and implausibly-far-future expiries.
 */
function verifySlotOffer(payload, sig, now = Date.now()) {
  const exp = Number(payload && payload.exp);
  if (!Number.isFinite(exp)) return false;
  if (now > exp) return false; // expired offer
  if (exp > now + SLOT_OFFER_TTL_MS + EXP_SKEW_MS) return false; // forged far-future exp
  if (!sig || typeof sig !== 'string') return false;
  const expected = crypto.createHmac('sha256', OFFER_KEY)
    .update(canonicalOfferString(payload))
    .digest('base64url');
  try {
    return sig.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---- estimate-surface carrier: sig+exp inside the slotId ----

function appendOfferToSlotId(slotId, { exp, sig }) {
  return `${slotId}.${exp}.${sig}`;
}

// exp is a ms-epoch integer; sig is base64url. The base slotId never contains
// a '.' (dates/times/uuids), so the two trailing segments are unambiguous.
const SIGNED_SLOT_ID_RE = /^(.+)\.(\d+)\.([A-Za-z0-9_-]+)$/;

/** Split `<base>.<exp>.<sig>` → { baseSlotId, exp, sig }, or null when unsigned. */
function splitSignedSlotId(slotId) {
  const m = typeof slotId === 'string' ? slotId.match(SIGNED_SLOT_ID_RE) : null;
  if (!m) return null;
  return { baseSlotId: m[1], exp: Number(m[2]), sig: m[3] };
}

// ---- /book-surface carrier: standalone `<exp>.<sig>` field ----

function mintSlotOfferField(payload, now = Date.now()) {
  const { exp, sig } = signSlotOffer(payload, now);
  return `${exp}.${sig}`;
}

function verifySlotOfferField(payload, field, now = Date.now()) {
  if (typeof field !== 'string' || !field.includes('.')) return false;
  const dot = field.indexOf('.');
  const exp = Number(field.slice(0, dot));
  const sig = field.slice(dot + 1);
  return verifySlotOffer({ ...payload, exp }, sig, now);
}

// ---- calendar round-trip ----

/**
 * True only for a REAL calendar day. The YYYY-MM-DD regexes upstream admit
 * impossible dates like 2026-09-31, which sit lexically inside every bound
 * check and only explode later inside Postgres — after side effects (e.g. the
 * /book confirm created its customer row first). Round-trip through Date.UTC
 * (which normalizes overflow: Sep 31 → Oct 1) and require equality.
 */
function isRealCalendarDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.toISOString().slice(0, 10) === dateStr;
}

// ---- confirmation codes ----

// Confirmation codes are the ONLY factor on GET /booking/status/:code, which
// returns booking + customer details — so they must be unguessable. 10 chars
// from a 32-symbol alphabet ≈ 50 bits via a CSPRNG (32 divides 256, so the
// modulo is unbiased). Legacy 4-char codes already in customers' hands still
// resolve; the dedicated /status rate limiter bounds enumeration of those.
const CONFIRMATION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CONFIRMATION_CODE_LENGTH = 10;
function generateConfirmationCode() {
  const bytes = crypto.randomBytes(CONFIRMATION_CODE_LENGTH);
  let code = 'WPC-';
  for (let i = 0; i < CONFIRMATION_CODE_LENGTH; i += 1) {
    code += CONFIRMATION_CODE_ALPHABET[bytes[i] % CONFIRMATION_CODE_ALPHABET.length];
  }
  return code;
}

module.exports = {
  SLOT_OFFER_TTL_MS,
  signSlotOffer,
  verifySlotOffer,
  appendOfferToSlotId,
  splitSignedSlotId,
  mintSlotOfferField,
  verifySlotOfferField,
  isRealCalendarDate,
  generateConfirmationCode,
};
