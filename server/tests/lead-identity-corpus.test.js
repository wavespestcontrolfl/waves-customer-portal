/**
 * Lead identity corpus (#3137 groundwork; no behavior change).
 *
 * Runs fixtures/lead-identity-corpus.json — SYNTHETIC contact pairs a human
 * would call the same person or different people — through the EXISTING
 * identity primitives the phone-call path uses, and asserts the verdicts:
 *
 *   phone key      utils/phone.toE164 + isLikelyE164 (what leads.phone stores)
 *   email key      utils/contact-normalize.normalizeEmail + workable-lead-signal EMAIL_RE
 *                  (findReusableCallLead's email-arm validity gate)
 *   name compat    call-recording-processor extractedNameMatchesCustomer —
 *                  normalizeNamePart + NICKNAME_GROUPS + surname agreement
 *                  (the lock-time recheck mirrored by the SQL predicate in
 *                  findReusableCallLead's phone arm, PR #3627)
 *   address        utils/address-normalizer.splitStreetLineUnit — unit-suffix
 *                  vs bare street is one property, not an identity split
 *
 * findReusableCallLead itself needs a DB (its corroboration lives in SQL), so
 * the verdict below is the PURE composition of its arms, in its precedence.
 * ONE DELIBERATE DIVERGENCE: production's phone arm compares the resolved
 * value LITERALLY (`where('phone', phone)` on resolveCallContactPhone's raw
 * output — no toE164), so a dictated "541-555-0101" against a stored
 * "+15415550101" can miss and mint a duplicate today. The corpus's phone key
 * is toE164-normalized ON PURPOSE — that is the semantic the shared #3137
 * resolver must provide — and the "documented normalization gap" test below
 * FREEZES exactly which 'same' verdicts depend on normalization production
 * does not yet do, so the gap is a tested statement, not overstated coverage.
 *   1. both records carry a usable phone → phone arm: keys equal AND names
 *      compatible (nickname-aware, blank side compatible) → same; a phone
 *      match with a name CONFLICT → different (fresh mint, #3627).
 *   2. no usable phone on either side → email arm: normalized emails equal
 *      AND POSITIVE first-name corroboration (exact, lowercase — not
 *      nickname-aware) AND non-conflicting surnames → same; else different.
 *   3. otherwise → different (name alone is never a key).
 * A case where exactly one side has a usable phone is direction-dependent in
 * production and is rejected by the shape test so the corpus stays
 * deterministic. Ownership (customer_id) filters are out of scope here.
 *
 * When #3137's ruling lands and writers adopt a shared resolver, point this
 * suite at that resolver — the corpus is the acceptance set.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const corpus = require('../fixtures/lead-identity-corpus.json');
const { toE164, isLikelyE164 } = require('../utils/phone');
const { normalizeEmail } = require('../utils/contact-normalize');
const { EMAIL_RE } = require('../utils/workable-lead-signal');
const { splitStreetLineUnit, normalizeStreetLine } = require('../utils/address-normalizer');
const { _test } = require('../services/call-recording-processor');

const { extractedNameMatchesCustomer, sameFirstName } = _test;

// The corpus's phone key: toE164-normalized, garbage (caller-ID sentinels,
// prose) comes back raw from toE164 and is rejected by isLikelyE164 — never a
// key. NOTE this is the #3137 TARGET semantic; production's
// findReusableCallLead compares literally (see header + the gap test below).
function phoneKey(value) {
  const e164 = toE164(value);
  return e164 && isLikelyE164(e164) ? e164 : null;
}

// findReusableCallLead's email gate: lowercased/trimmed AND a real email.
function emailKey(value) {
  const normalized = normalizeEmail(value);
  return normalized && EMAIL_RE.test(normalized) ? normalized : null;
}

// Mirrors normalizeNamePart's contract for the nickname lookup input.
const namePart = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
// The email arm compares LOWER(TRIM(...)) — deliberately NOT normalizeNamePart.
const emailArmName = (v) => String(v || '').trim().toLowerCase();

function emailArmCorroborates(a, b) {
  const firstA = emailArmName(a.first_name);
  const firstB = emailArmName(b.first_name);
  if (!firstA || !firstB || firstA !== firstB) return false;
  const lastA = emailArmName(a.last_name);
  const lastB = emailArmName(b.last_name);
  return !lastA || !lastB || lastA === lastB;
}

function identityVerdict(a, b) {
  const phoneA = phoneKey(a.phone);
  const phoneB = phoneKey(b.phone);
  if (phoneA && phoneB) {
    if (phoneA !== phoneB) return 'different';
    return extractedNameMatchesCustomer(a, b) ? 'same' : 'different';
  }
  if (phoneA || phoneB) {
    throw new Error('direction-dependent case (one usable phone) — not allowed in the corpus');
  }
  const emailA = emailKey(a.email);
  const emailB = emailKey(b.email);
  if (emailA && emailB && emailA === emailB && emailArmCorroborates(a, b)) return 'same';
  return 'different';
}

const CASES = corpus.cases;

describe('lead identity corpus — shape and PII hygiene', () => {
  test('at least 20 cases, unique ids, both verdicts represented, rationale on every case', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const verdicts = new Set(CASES.map((c) => c.expected));
    expect(verdicts).toEqual(new Set(['same', 'different']));
    for (const c of CASES) {
      expect(typeof c.rationale).toBe('string');
      expect(c.rationale.length).toBeGreaterThan(20);
      expect(c.a && typeof c.a).toBe('object');
      expect(c.b && typeof c.b).toBe('object');
    }
  });

  // Digit-free sentinels the corpus may use in the phone field (exercise the
  // garbage-key rejection path). Anything containing a digit must be a FULLY
  // reserved NANP fictional number — see the guard below.
  const NON_PHONE_SENTINELS = new Set(['anonymous', 'call me', 'unknown']);

  test('every contact value is synthetic: reserved NANP 555-01xx phones (or allowlisted non-phone sentinels), example.com emails', () => {
    for (const c of CASES) {
      for (const rec of [c.a, c.b]) {
        if (rec.phone != null) {
          const digits = String(rec.phone).replace(/\D/g, '');
          // Zero digits → must be an allowlisted sentinel string; any digits →
          // the COMPLETE number must be a reserved NANP fixture (NXX-555-01xx,
          // optional leading 1). A real 7-digit local number or a non-NANP
          // number merely ending in 55501xx fails here by design.
          const ok = digits.length === 0
            ? NON_PHONE_SENTINELS.has(String(rec.phone).trim().toLowerCase())
            : /^1?[2-9]\d\d55501\d\d$/.test(digits);
          expect({ id: c.id, phone: rec.phone, ok })
            .toEqual({ id: c.id, phone: rec.phone, ok: true });
        }
        if (rec.email != null) {
          const normalized = normalizeEmail(rec.email);
          const isNonEmail = !normalized.includes('@');
          // Reserved domains only: example.com or a subdomain of it (the
          // typo'd-domain case uses typo.example.com — still reserved).
          expect({ id: c.id, email: rec.email, ok: isNonEmail || /@(?:[a-z0-9-]+\.)*example\.com$/.test(normalized) })
            .toEqual({ id: c.id, email: rec.email, ok: true });
        }
      }
    }
  });

  test('no case relies on exactly one usable phone (direction-dependent in production)', () => {
    for (const c of CASES) {
      const phones = [phoneKey(c.a.phone), phoneKey(c.b.phone)].filter(Boolean).length;
      expect({ id: c.id, phones }).not.toEqual({ id: c.id, phones: 1 });
    }
  });
});

describe('lead identity corpus — verdicts through the call-path primitives', () => {
  test.each(CASES.map((c) => [c.id, c]))('%s', (_id, c) => {
    expect({ id: c.id, verdict: identityVerdict(c.a, c.b), rationale: c.rationale })
      .toEqual({ id: c.id, verdict: c.expected, rationale: c.rationale });
  });

  test('verdict is symmetric — swapping the records never changes the answer', () => {
    for (const c of CASES) {
      expect({ id: c.id, verdict: identityVerdict(c.b, c.a) }).toEqual({ id: c.id, verdict: c.expected });
    }
  });

  test("documented gap: production's findReusableCallLead phone arm is LITERAL (where('phone', phone)); these 'same' verdicts depend on the toE164 normalization the #3137 resolver must add", () => {
    const literal = (v) => String(v || '').trim();
    const reliesOnNormalization = CASES
      .filter((c) => c.expected === 'same'
        && phoneKey(c.a.phone) && phoneKey(c.b.phone)
        && literal(c.a.phone) !== literal(c.b.phone))
      .map((c) => c.id)
      .sort();
    // Frozen: every case here is a pair production can DUPLICATE today. If a
    // corpus edit changes this list, re-verify the verdict is the resolver's
    // target semantic, not an accidental claim about current behavior.
    expect(reliesOnNormalization).toEqual([
      'nickname-bill-william-same-phone',
      'nickname-liz-elizabeth-same-phone',
      'phone-format-parens-spaces-leading-1',
      'phone-format-plus1-vs-dashes',
      'shared-phone-one-side-nameless-shell',
      'typo-email-domain-but-phone-matches',
      'unit-suffixed-address-hash-spelling',
      'unit-suffixed-address-vs-bare-same-person',
    ]);
  });

  test('checks.firstNameVariant — nickname table membership matches the case annotation', () => {
    const annotated = CASES.filter((c) => c.checks && typeof c.checks.firstNameVariant === 'boolean');
    expect(annotated.length).toBeGreaterThan(0);
    for (const c of annotated) {
      const isVariant = sameFirstName(namePart(c.a.first_name), namePart(c.b.first_name));
      expect({ id: c.id, isVariant }).toEqual({ id: c.id, isVariant: c.checks.firstNameVariant });
    }
  });

  test('checks.sameStreet — unit-suffixed and bare addresses split to one normalized street line', () => {
    const annotated = CASES.filter((c) => c.checks && c.checks.sameStreet);
    expect(annotated.length).toBeGreaterThan(0);
    for (const c of annotated) {
      const a = splitStreetLineUnit(c.a.address);
      const b = splitStreetLineUnit(c.b.address);
      expect({ id: c.id, street: normalizeStreetLine(a.street) })
        .toEqual({ id: c.id, street: normalizeStreetLine(b.street) });
      // At least one side actually carried a unit, or the check is vacuous.
      expect({ id: c.id, unitSeen: Boolean(a.unit || b.unit) }).toEqual({ id: c.id, unitSeen: true });
    }
  });
});
