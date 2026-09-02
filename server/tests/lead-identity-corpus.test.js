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

const fs = require('fs');
const path = require('path');

const corpus = require('../fixtures/lead-identity-corpus.json');
const { toE164 } = require('../utils/phone');
const { normalizeEmail } = require('../utils/contact-normalize');
const { EMAIL_RE } = require('../utils/workable-lead-signal');
const { splitStreetLineUnit, normalizeStreetLine } = require('../utils/address-normalizer');
const { _test } = require('../services/call-recording-processor');

const { extractedNameMatchesCustomer, sameFirstName, isUsableContactPhone } = _test;

// The corpus's phone key: toE164-normalized, then the call path's OWN
// usability predicate (isUsableContactPhone) — prose comes back raw from
// toE164 and fails isLikelyE164 inside it, and the Twilio caller-ID digit
// sentinels (+266696687 ANONYMOUS, +7378742833 RESTRICTED, …) are explicitly
// rejected so two blocked callers never share a key. NOTE the normalization
// is the #3137 TARGET semantic; production's findReusableCallLead compares
// literally (see header + the gap test below).
function phoneKey(value) {
  const e164 = toE164(value);
  return e164 && isUsableContactPhone(e164) ? e164 : null;
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
  // Exact key allowlists — a fixture cannot smuggle real lead data in an
  // uninspected field (street_address, company_name, notes, a nested
  // payload): every key must be known to the hygiene guards below, and
  // every contact value must be a scalar string.
  const CASE_FIELDS = new Set(['id', 'a', 'b', 'expected', 'rationale', 'checks']);
  const CHECK_FIELDS = new Set(['firstNameVariant', 'sameStreet']);
  const CONTACT_FIELDS = new Set(['first_name', 'last_name', 'phone', 'email', 'address']);

  test('the RAW fixture JSON has no duplicate keys — a duplicate would let an overwritten value hide from every guard below', () => {
    // require() keeps only the LAST value of a duplicated key, so an
    // earlier real email/phone would stay committed in the file while
    // every parsed-object assertion sees the reserved replacement. Walk
    // the raw text with an object/array stack and reject any repeat.
    const raw = fs.readFileSync(path.join(__dirname, '../fixtures/lead-identity-corpus.json'), 'utf8');
    const stack = [];
    const dupes = [];
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') {
        let j = i + 1;
        let str = '';
        while (j < raw.length && raw[j] !== '"') {
          if (raw[j] === '\\') { str += raw[j]; j += 1; }
          str += raw[j]; j += 1;
        }
        let k = j + 1;
        while (k < raw.length && /\s/.test(raw[k])) k += 1;
        if (raw[k] === ':' && stack.length && stack[stack.length - 1].keys) {
          const top = stack[stack.length - 1];
          // Compare DECODED keys — "email" and "email" are the same
          // JSON key even though their source spellings differ.
          let decoded = str;
          try { decoded = JSON.parse(`"${str}"`); } catch (e) { /* raw fallback */ }
          if (top.keys.has(decoded)) dupes.push(decoded);
          top.keys.add(decoded);
        }
        i = j + 1;
        continue;
      }
      if (c === '{') stack.push({ keys: new Set() });
      else if (c === '[') stack.push({});
      else if (c === '}' || c === ']') stack.pop();
      i += 1;
    }
    expect(dupes).toEqual([]);
  });

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

  test('no unknown fields: root, case, checks, and contact keys are exact allowlists; contact values are scalar strings (or null — the nameless-shell cases)', () => {
    // The fixture ROOT too — a top-level sibling of `cases` would carry data
    // no hygiene loop ever inspects.
    expect(Object.keys(corpus).sort()).toEqual(['$comment', 'cases']);
    for (const c of CASES) {
      for (const k of Object.keys(c)) {
        expect({ id: c.id, key: k, known: CASE_FIELDS.has(k) })
          .toEqual({ id: c.id, key: k, known: true });
      }
      for (const [k, v] of Object.entries(c.checks || {})) {
        // Boolean-only values — an object here would carry data no PII loop
        // traverses, and the annotation tests skip non-boolean values.
        expect({ id: c.id, checkKey: k, known: CHECK_FIELDS.has(k), boolean: typeof v === 'boolean' })
          .toEqual({ id: c.id, checkKey: k, known: true, boolean: true });
      }
      for (const rec of [c.a, c.b]) {
        // Plain object with at least one non-empty identity field — an empty
        // (or array) contact would sail through every hygiene loop and count
        // toward the corpus minimum while exercising nothing.
        expect({ id: c.id, isArray: Array.isArray(rec) }).toEqual({ id: c.id, isArray: false });
        const hasIdentity = ['first_name', 'last_name', 'phone', 'email']
          .some((k) => typeof rec[k] === 'string' && rec[k].trim().length > 0);
        expect({ id: c.id, hasIdentity }).toEqual({ id: c.id, hasIdentity: true });
        for (const [k, v] of Object.entries(rec)) {
          const scalar = typeof v === 'string' || v === null;
          expect({ id: c.id, field: k, known: CONTACT_FIELDS.has(k), scalar })
            .toEqual({ id: c.id, field: k, known: true, scalar: true });
        }
      }
    }
  });

  // Digit-free sentinels the corpus may use in the phone field (exercise the
  // garbage-key rejection path). Anything containing a digit must be a FULLY
  // reserved NANP fictional number — see the guard below.
  const NON_PHONE_SENTINELS = new Set(['anonymous', 'call me', 'unknown']);
  // The Twilio suppressed-caller-ID digit sentinels (PHONE_SENTINELS in
  // call-recording-processor). Not real numbers — allowed so the corpus can
  // pin isUsableContactPhone's rejection of them.
  const NUMERIC_PHONE_SENTINELS = new Set(['266696687', '7378742833', '86282452253']);
  // Non-email garbage the corpus may use in the email field. Same rule as
  // phones: an explicit allowlist, so a real identifier copied in as a
  // malformed email (missing its @domain) cannot slip past the guard.
  const NON_EMAIL_SENTINELS = new Set(['unknown']);
  // Email LOCAL PARTS are an explicit synthetic vocabulary too — replacing
  // a real address's domain with example.com must not keep its local part.
  const SYNTHETIC_EMAIL_LOCALS = new Set([
    'beatrix.la', 'emeka.s', 'marisol.q', 'office', 'p.havlicek', 'petra.h',
    'priyanka.vellore', 'ravi.moorcroft', 'rtremontaine', 'shared.inbox',
    'sofia', 'sofia.marchetti', 'thornehousehold',
  ]);

  test('every contact value is synthetic: reserved NANP 555-01xx phones (or allowlisted non-phone sentinels), example.com emails', () => {
    for (const c of CASES) {
      for (const rec of [c.a, c.b]) {
        if (rec.phone != null) {
          const v = String(rec.phone).trim();
          // The COMPLETE trimmed value must be ONE allowed form — a reserved
          // NANP fixture number (NXX-555-01xx) in common punctuation, an
          // exact numeric caller-ID sentinel, or an allowlisted word
          // sentinel. Digit-stripping alone would let prose (a name, a
          // street) ride in front of a reserved number and pass.
          // A '+' requires the FULL +1 country code — '+' directly on the
          // area code (+5415550101) is an international E.164 shape that
          // could be a real number, never a reserved NANP fixture.
          const ok = /^(?:\+1|1)?[\s.-]?\(?[2-9]\d\d\)?[\s.-]?555[\s.-]?01\d\d$/.test(v)
            || (/^\+?\d+$/.test(v) && NUMERIC_PHONE_SENTINELS.has(v.replace('+', '')))
            || NON_PHONE_SENTINELS.has(v.toLowerCase());
          expect({ id: c.id, phone: rec.phone, ok })
            .toEqual({ id: c.id, phone: rec.phone, ok: true });
        }
        if (rec.email != null) {
          const normalized = normalizeEmail(rec.email);
          // With an @: the ENTIRE value must be one syntactically valid
          // address on a reserved domain — example.com or a subdomain of it
          // (the typo'd-domain case uses typo.example.com — still reserved).
          // Fully anchored, single @, no whitespace: a value smuggling a real
          // address alongside a reserved suffix fails. Without an @:
          // allowlisted sentinel strings only.
          const ok = normalized.includes('@')
            ? /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*example\.com$/.test(normalized)
              && SYNTHETIC_EMAIL_LOCALS.has(normalized.split('@')[0])
            : NON_EMAIL_SENTINELS.has(normalized);
          expect({ id: c.id, email: rec.email, ok })
            .toEqual({ id: c.id, email: rec.email, ok: true });
        }
      }
    }
  });

  // Names are an explicit synthetic vocabulary, same deliberate declaration
  // the phone/email sentinels make: adding a fixture person means adding
  // their name HERE too, so a real customer name cannot slip in silently.
  // Compared via namePart, so case/punctuation/hyphen variants of one name
  // ('Sofia'/'SOFIA', 'Okonkwo-Reyes'/'Okonkwo Reyes') are one entry.
  const SYNTHETIC_FIRST_NAMES = new Set([
    'anneliese', 'beatrix', 'bill', 'bob', 'cornelius', 'dario', 'desmond',
    'elizabeth', 'emeka', 'gunnar', 'harriet', 'ingrid', 'liz', 'lucian',
    'marisol', 'meredith', 'michael', 'mike', 'ngozi', 'oluwaseun', 'petra',
    'priyanka', 'ravindra', 'renata', 'robert', 'sofia', 'tobias', 'william',
    'yusuf',
  ]);
  const SYNTHETIC_LAST_NAMES = new Set([
    'abernathy', 'achterberg', 'adebayolindqvist', 'ashworthvane',
    'brightwater', 'delacroixostrowski', 'fairweather', 'ferreira',
    'halvorsen', 'havlicek', 'lindgrenamato', 'marchetti', 'moorcroft',
    'nakagawa', 'okonkwo', 'okonkworeyes', 'ostrowski', 'pemberly',
    'quintero', 'sandovalibsen', 'sorensen', 'szczepanik', 'tremontaine',
    'vasquezthorne', 'vellore', 'wrencastellanos',
  ]);

  test('names come from the synthetic vocabulary; every address declares itself fictional', () => {
    for (const c of CASES) {
      for (const rec of [c.a, c.b]) {
        if (rec.first_name) {
          const ok = SYNTHETIC_FIRST_NAMES.has(namePart(rec.first_name));
          expect({ id: c.id, first_name: rec.first_name, ok })
            .toEqual({ id: c.id, first_name: rec.first_name, ok: true });
        }
        if (rec.last_name) {
          const ok = SYNTHETIC_LAST_NAMES.has(namePart(rec.last_name));
          expect({ id: c.id, last_name: rec.last_name, ok })
            .toEqual({ id: c.id, last_name: rec.last_name, ok: true });
        }
        if (rec.address != null) {
          // FULL reserved shape built from an EXPLICIT street vocabulary
          // (add a fixture street by adding it here — same ceremony as the
          // name vocabulary) plus a numeric-only unit tail, so neither the
          // street words nor the unit can smuggle a name. Position matters —
          // a real street with an appended marker fails.
          const ok = /^\d{1,5} (?:Fictional Palm Way|Imaginary Cove Blvd)(?:,? (?:Unit|Apt|Ste) ?\d{1,4}| ?#\d{1,4})?$/
            .test(String(rec.address));
          expect({ id: c.id, address: rec.address, ok })
            .toEqual({ id: c.id, address: rec.address, ok: true });
        }
      }
    }
  });

  // Descriptive strings ($comment, case ids, rationales) get pattern-level
  // hygiene: prose can't be allowlisted like the contact fields, but the two
  // machine-checkable PII classes — an email-shaped token, a phone-length
  // digit run — must still be reserved values wherever they appear.
  function assertDescriptiveStringClean(where, text) {
    // Strings only — an object here would flatten to '[object Object]' and
    // hide its nested values from every pattern below.
    expect({ where, type: typeof text }).toEqual({ where, type: 'string' });
    // Unicode-aware: an internationalized address (josé@example.net) is an
    // email-shaped token too, and must pass the same synthetic rules.
    // …and so is an RFC domain literal (person@[192.0.2.10]).
    // …and a QUOTED local part ("customer.name"@example.net).
    // The token must be the WHOLE whitespace-delimited word (wrapping
    // punctuation stripped): `real'office@example.com` is one word whose
    // email-shaped tail happens to be allowlisted — the cut prefix is real.
    const str = String(text);
    // (a quoted local may contain spaces: "customer name"@example.net)
    for (const m of str.matchAll(/(?:"[^"@\n]+"|[\p{L}\p{N}_.+%-]+)@(?:[\p{L}\p{N}_.-]+|\[[^\]\s]+\])/gu)) {
      const email = m[0];
      let ws = m.index;
      while (ws > 0 && !/\s/.test(str[ws - 1])) ws -= 1;
      let we = m.index + email.length;
      while (we < str.length && !/\s/.test(str[we])) we += 1;
      const word = str.slice(ws, we).replace(/^[^\p{L}\p{N}"[]+|[^\p{L}\p{N}\]]+$/gu, '');
      const ok = word === email
        && /@(?:[a-z0-9-]+\.)*example\.com$/i.test(email)
        && SYNTHETIC_EMAIL_LOCALS.has(email.toLowerCase().split('@')[0]);
      expect({ where, email, word, ok }).toEqual({ where, email, word, ok: true });
    }
    // Unicode dashes (en/em/figure/nonbreaking hyphen, minus) and
    // nonbreaking/figure/narrow spaces normalize to ASCII first, and the
    // separator class includes `/` — `941–555–2091` and `941/555/2091`
    // are phone spellings too.
    // Unicode DECIMAL digits (Arabic-Indic, fullwidth, …) map to ASCII too:
    // Nd digits come in runs of ten, so the value is the offset from the
    // run's zero.
    const asciiDigit = (ch) => {
      let z = ch.codePointAt(0);
      while (/\p{Nd}/u.test(String.fromCodePoint(z - 1))) z -= 1;
      return String((ch.codePointAt(0) - z) % 10);
    };
    const normalized = String(text)
      .replace(/\p{Nd}/gu, (ch) => (/[0-9]/.test(ch) ? ch : asciiDigit(ch)))
      .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u00A0\u2007\u202F]/g, ' ');
    for (const run of normalized.match(/\+?\d[\d\s().\/-]{5,}\d/g) || []) {
      const digits = run.replace(/\D/g, '');
      if (digits.length < 7) continue;
      // Same +1 rule as the contact validator: a '+' not followed by the
      // full country code (+5415550101) is an international shape that
      // could be real, even when its digits happen to fit the NANP mask.
      const nanp = /^1?[2-9]\d\d55501\d\d$/.test(digits)
        && (!run.trim().startsWith('+') || /^\+1/.test(run.trim()));
      const ok = NUMERIC_PHONE_SENTINELS.has(digits) || nanp;
      expect({ where, run, ok }).toEqual({ where, run, ok: true });
    }
  }

  test('descriptive fields ($comment, ids, rationales) carry no unreserved emails or phone-length digit runs', () => {
    assertDescriptiveStringClean('$comment', corpus.$comment);
    for (const c of CASES) {
      assertDescriptiveStringClean(`${c.id} :: id`, c.id);
      assertDescriptiveStringClean(`${c.id} :: rationale`, c.rationale);
    }
  });

  test('descriptive text is FROZEN by content hash — prose PII (a name, a street) cannot be pattern-matched, so editing it is a reviewed act', () => {
    // Update procedure: change the fixture, run
    //   node -e "const crypto=require('crypto');const c=require('./fixtures/lead-identity-corpus.json');console.log(crypto.createHash('sha256').update(JSON.stringify([c.$comment,...c.cases.map((x)=>[x.id,x.rationale])])).digest('hex'))"
    // from server/, and paste the new hash HERE in the same PR — the diff of
    // this line is what makes the reviewer read the new prose.
    const crypto = require('crypto');
    const canonical = JSON.stringify([corpus.$comment, ...CASES.map((c) => [c.id, c.rationale])]);
    expect(crypto.createHash('sha256').update(canonical).digest('hex'))
      .toBe('de285bf0153d1e9e009b83ad03f814d32f29403d2e1cffd48cd97349c2911a5f');
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

  test('checks.sameStreet — the annotation matches the computed street equality, true OR false', () => {
    const annotated = CASES.filter((c) => c.checks && typeof c.checks.sameStreet === 'boolean');
    expect(annotated.length).toBeGreaterThan(0);
    for (const c of annotated) {
      const a = splitStreetLineUnit(c.a.address);
      const b = splitStreetLineUnit(c.b.address);
      // Evaluated for BOTH values — a false annotation asserts the streets
      // genuinely differ, it is not silently skipped.
      const same = normalizeStreetLine(a.street) === normalizeStreetLine(b.street);
      expect({ id: c.id, same }).toEqual({ id: c.id, same: c.checks.sameStreet });
      if (c.checks.sameStreet) {
        // At least one side actually carried a unit, or the check is vacuous.
        expect({ id: c.id, unitSeen: Boolean(a.unit || b.unit) }).toEqual({ id: c.id, unitSeen: true });
      }
    }
  });
});
