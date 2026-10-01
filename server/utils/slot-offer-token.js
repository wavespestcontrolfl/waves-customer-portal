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
 *     (`<date>_<HH-MM>_<techId>.<exp>.<sig>`, or, for a GRACED offer only,
 *     `<date>_<HH-MM>_<techId>.<exp>.<arrivalGrace>.<sig>` — see arrivalGrace
 *     below), because the estimate clients (SlotPicker/EstimateViewPage, the
 *     server-rendered estimate page) only ever send `{ slotId }` — no client
 *     change needed. scopeId = estimate id, so an offer minted for one
 *     estimate can't reserve under another.
 *   - /book surface: the funnel posts explicit slot fields, so the offer is a
 *     separate `slot_sig` field shaped `<exp>.<sig>` that the client passes
 *     through untouched. scopeId = '' (the funnel is anonymous; /availability
 *     is public, so the offer binds WHAT was offered, not who fetched it).
 *     /book offers take the v2 (ungraced) shape below unless GATE_BOOK_ARRIVAL_GRACE
 *     is live (owner-approved 2026-09-29): then a slot offered under a positive
 *     self-serve arrival grace (scheduling/policy.js) signs the v3 string and
 *     the field becomes `<exp>.<arrivalGrace>.<sig>` — see BOOK_ARRIVAL_GRACE_
 *     OFFER_POLICY and splitSlotOfferField below. A gate-off /book offer is
 *     byte-identical to before that lane.
 *
 * arrivalGrace (self-serve arrival grace, owner ruling 2026-09-28, Codex
 * round 2 on #5314): the estimate surface's ONLY additional signed field,
 * and OPT-IN PER OFFER (Codex round 3): an offer with arrivalGrace > 0 signs
 * the v3 canonical string (tag `waves-slot-offer.v3`, the value appended
 * before `exp`) and carries a 4th cleartext slotId segment; an UNGRACED
 * offer (arrivalGrace 0 or omitted — every /book offer, and every estimate
 * offer while capacity/grace is off or the date is excluded) signs the
 * EXACT v2 string and slotId shape this module always produced, byte for
 * byte. The first cut of this field bumped the tag and the slotId shape
 * UNCONDITIONALLY, which broke every in-flight estimate offer at deploy
 * even with grace dark (0) — "default 0 = byte-identical to before this
 * lane" has to cover the wire format too, not just the arrival-window math,
 * so an ungraced offer must verify under BOTH this code and origin/main's,
 * straddling a deploy without a single "pick another time" 409. Only a
 * genuinely graced offer takes the new shape, and only because ITS extra
 * field needs somewhere to ride: A hold is certified ONCE, at reserve —
 * never re-derived from the LIVE env value again at accept, which could
 * have changed underneath an in-flight hold (the P0 this closes: a hold
 * reserved at grace 90 must not fail acceptance because someone later
 * lowered the env to 30). reserveSlot must therefore apply the EXACT grace
 * that justified the offer, not whatever the env reads at reserve time —
 * and since that number determines whether a customer-facing leniency
 * applies, it has to ride in the tamper-proof HMAC exactly like
 * date/startMinutes/technicianId, not as a trusted-on-its-word client
 * field. Unlike duration or policy (independently re-derivable at verify
 * time from other authoritative state, so they only need to be INPUTS to
 * the signature, not readable OUTPUTS of it), arrivalGrace is a
 * point-in-time policy snapshot nothing else can reconstruct — so it also
 * rides in CLEARTEXT as its own segment (verified, not just signed) for
 * reserveSlot to read back and feed into verifyArrivalCapacity. A GRACED
 * offer in flight at deploy time still fails once, the same accepted trade
 * the v1→v2 bump made for every offer — the client's existing "pick
 * another time" 409 recovery re-signs fresh — but that window is now only
 * the rare graced case, never every offer regardless of the env value.
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

// Capacity offers are minted and redeemed under this policy tag; it rides in
// the HMAC so an offer produced by one scheduling policy cannot be redeemed
// under another (gate flipped or a mixed rolling deploy). Omitted for legacy
// offers, whose canonical string is unchanged.
const CAPACITY_OFFER_POLICY = 'capacity_2026_09_09';

// Same mechanism, for /book self-serve offers that may be inserted BETWEEN a
// day's existing stops (owner 2026-09-28, PR #5231 round 2): a gate flip
// (rollback, mixed rolling deploy) during the 45-minute offer lifetime can
// then never confirm an insertion-based offer append-only, or an
// append-only offer as if it had been insertion-verified — either mismatch
// fails the signature and falls back to the existing "pick your time again"
// 409, the same accepted trade CAPACITY_OFFER_POLICY already makes for the
// estimate surface.
const BOOK_INSERTION_OFFER_POLICY = 'book_insertion_2026_09_28';

// The one mapping /book minting (buildBookingAvailability) and /book
// verification (createSelfBooking) share, so the two sides cannot drift.
function bookInsertionOfferPolicy(insertion) {
  return insertion === true ? BOOK_INSERTION_OFFER_POLICY : undefined;
}

// GATE_BOOK_ARRIVAL_GRACE (owner-approved 2026-09-29): every /book offer
// minted while the gate is live for that build carries this tag INSTEAD of
// BOOK_INSERTION_OFFER_POLICY (grace requires insertion, so it supersedes
// it). Same mechanism as #5231: a flip in EITHER direction between mint and
// confirm changes the policy the verifier computes, fails the HMAC, and the
// customer gets the standard "pick your time again" 409 rather than a commit
// judged by a different offer/commit rule than the one that offered the slot.
const BOOK_ARRIVAL_GRACE_OFFER_POLICY = 'book_arrival_grace_2026_09_29';

// The one mapping for both sides, extending bookInsertionOfferPolicy:
// `graceLive` true → the grace tag; else exactly bookInsertionOfferPolicy.
function bookOfferPolicy({ insertion, graceLive } = {}) {
  return graceLive === true ? BOOK_ARRIVAL_GRACE_OFFER_POLICY : bookInsertionOfferPolicy(insertion);
}

// v3 is OPT-IN, per offer, on the value of arrivalGrace alone (Codex r3 on
// #5314): bumping the tag unconditionally for every offer — the first cut of
// this field — broke every in-flight ESTIMATE offer at deploy, even with
// grace dark (0), because minting always switched shape. "Default 0 = byte-
// identical to before this lane" has to mean the WIRE FORMAT too, not just
// the arrival-window math: an offer with no grace (the overwhelming common
// case — every /book offer, every estimate offer with capacity/grace off or
// the day excluded) signs the EXACT v2 string, so it verifies against BOTH
// this code and origin/main's, and an in-flight offer straddling a deploy
// never breaks. Only a genuinely graced offer (arrivalGrace > 0) opts into
// v3 — the one shape change that offer's own new field actually needs.
function canonicalOfferString(payload = {}) {
  const graced = Number(payload.arrivalGrace) > 0;
  return [
    // v2: serviceKey + locationKey joined the signed scope (round 3). The tag
    // bump makes every v1 offer fail verification outright rather than
    // depending on field-count coincidences.
    graced ? 'waves-slot-offer.v3' : 'waves-slot-offer.v2',
    String(payload.surface || ''),
    String(payload.scopeId ?? ''),
    String(payload.serviceKey ?? ''),
    String(payload.locationKey ?? ''),
    String(payload.date || ''),
    String(Number(payload.startMinutes)),
    String(payload.technicianId || ''),
    String(Number(payload.durationMinutes)),
    // arrivalGrace (self-serve arrival grace, owner ruling 2026-09-28, Codex
    // round 2 on #5314) joins the signed scope ONLY for a graced offer — an
    // ungraced one signs the identical v2 string this function always
    // produced, field for field. Also rides in cleartext
    // (appendOfferToSlotId/splitSignedSlotId) so reserveSlot can read back
    // the EXACT value that justified the offer instead of re-deriving it
    // live.
    ...(graced ? [String(Math.round(Number(payload.arrivalGrace)))] : []),
    String(Number(payload.exp)),
    ...(payload.policy ? [String(payload.policy)] : []),
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

// ---- estimate-surface carrier: sig+exp[+arrivalGrace] inside the slotId ----

// arrivalGrace rides in CLEARTEXT (not just signed) — reserveSlot reads it
// back to know the exact grace that justified this offer, never a live env
// re-read (owner ruling 2026-09-28, Codex round 2 on #5314). The segment is
// OMITTED ENTIRELY for an ungraced offer (arrivalGrace <= 0) — the resulting
// slotId is the EXACT `<base>.<exp>.<sig>` shape this function always
// produced, byte for byte, matching the v2 canonical string
// canonicalOfferString signs for the same offer (Codex r3: a mandatory 4th
// segment broke every in-flight offer at deploy even with grace dark).
function appendOfferToSlotId(slotId, { exp, sig, arrivalGrace = 0 }) {
  const grace = Math.round(Number(arrivalGrace) || 0);
  return grace > 0 ? `${slotId}.${exp}.${grace}.${sig}` : `${slotId}.${exp}.${sig}`;
}

// exp is a ms-epoch integer; sig is base64url. The base slotId never contains
// a '.' (dates/times/uuids). Two shapes, tried in order — a v3 (graced)
// offer's arrivalGrace segment is ALSO a run of digits, so it could only be
// confused with a v2 sig if a base64url signature happened to be all-digit
// (astronomically unlikely, and even then the v3 attempt's exp segment would
// still need to independently be all-digit too); trying v3 first is safe and
// unambiguous either way since a genuine v2 token has only two trailing
// dot-segments, one fewer than v3 requires.
const SIGNED_SLOT_ID_RE_V3 = /^(.+)\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/;
const SIGNED_SLOT_ID_RE_V2 = /^(.+)\.(\d+)\.([A-Za-z0-9_-]+)$/;

/** Split `<base>.<exp>.<arrivalGrace>.<sig>` (graced, v3) or
 * `<base>.<exp>.<sig>` (ungraced, v2 — arrivalGrace reads 0) →
 * { baseSlotId, exp, arrivalGrace, sig }, or null when unsigned. */
function splitSignedSlotId(slotId) {
  if (typeof slotId !== 'string') return null;
  const v3 = slotId.match(SIGNED_SLOT_ID_RE_V3);
  if (v3) return { baseSlotId: v3[1], exp: Number(v3[2]), arrivalGrace: Number(v3[3]), sig: v3[4] };
  const v2 = slotId.match(SIGNED_SLOT_ID_RE_V2);
  if (v2) return { baseSlotId: v2[1], exp: Number(v2[2]), arrivalGrace: 0, sig: v2[3] };
  return null;
}

// ---- /book-surface carrier: standalone `<exp>.<sig>` field ----


// Two shapes, mirroring the estimate slotId carrier: `<exp>.<sig>` (ungraced,
// v2 — arrivalGrace reads 0; every offer this module produced before
// GATE_BOOK_ARRIVAL_GRACE, byte for byte) and `<exp>.<arrivalGrace>.<sig>`
// (graced, v3 — only an offer minted under a positive grace). A base64url
// signature never contains '.', so the segment count is unambiguous.
const SLOT_OFFER_FIELD_RE_V3 = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/;
const SLOT_OFFER_FIELD_RE_V2 = /^(\d+)\.([A-Za-z0-9_-]+)$/;

/** Split a /book `slot_sig` field → { exp, arrivalGrace, sig } or null. */
function splitSlotOfferField(field) {
  if (typeof field !== 'string') return null;
  const v3 = field.match(SLOT_OFFER_FIELD_RE_V3);
  if (v3) return { exp: Number(v3[1]), arrivalGrace: Number(v3[2]), sig: v3[3] };
  const v2 = field.match(SLOT_OFFER_FIELD_RE_V2);
  if (v2) return { exp: Number(v2[1]), arrivalGrace: 0, sig: v2[2] };
  return null;
}

// An offer with no (or a non-positive) arrivalGrace is the exact `<exp>.<sig>`
// this function always returned.
function mintSlotOfferField(payload, now = Date.now()) {
  const grace = Math.round(Number(payload && payload.arrivalGrace) || 0);
  const { exp, sig } = signSlotOffer({ ...payload, arrivalGrace: grace > 0 ? grace : 0 }, now);
  return grace > 0 ? `${exp}.${grace}.${sig}` : `${exp}.${sig}`;
}

// `payload.arrivalGrace` is IGNORED here — the grace a field claims is read
// from the field itself and bound into the HMAC (a v3 field's cleartext grace
// is verified, not trusted: a different value fails the signature, and a
// stripped/added segment changes the canonical string's version tag).
function verifySlotOfferField(payload, field, now = Date.now()) {
  const parts = splitSlotOfferField(field);
  if (!parts) return false;
  return verifySlotOffer({ ...payload, exp: parts.exp, arrivalGrace: parts.arrivalGrace }, parts.sig, now);
}

/** The exact arrival grace (minutes) a /book slot_sig field was minted under
 * — 0 for an ungraced/unparseable field. Call ONLY after verifySlotOfferField
 * passed for the same field (the value is HMAC-bound there). */
function slotOfferFieldGrace(field) {
  const parts = splitSlotOfferField(field);
  return parts && Number.isFinite(parts.arrivalGrace) && parts.arrivalGrace > 0 ? parts.arrivalGrace : 0;
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
  CAPACITY_OFFER_POLICY,
  BOOK_INSERTION_OFFER_POLICY,
  bookInsertionOfferPolicy,
  BOOK_ARRIVAL_GRACE_OFFER_POLICY,
  bookOfferPolicy,
  SLOT_OFFER_TTL_MS,
  signSlotOffer,
  verifySlotOffer,
  appendOfferToSlotId,
  splitSignedSlotId,
  mintSlotOfferField,
  verifySlotOfferField,
  splitSlotOfferField,
  slotOfferFieldGrace,
  isRealCalendarDate,
  generateConfirmationCode,
};
