const db = require('../models/db');
const logger = require('./logger');
const { INVOICE_UNCOLLECTIBLE_STATUSES, invoiceAmountDue } = require('./invoice-helpers');
const { customerOnAutopay, isPaused } = require('./autopay-eligibility');
const { technicianReportCustomerCopy } = require('./service-report/technician-report-copy');
const { etDateString } = require('../utils/datetime-et');
const { arrivalWindowRange } = require('../utils/sms-time-format');

// Statuses that represent a real, confidently-stated upcoming visit. This is
// an ALLOW-list (fail-closed) on purpose: a deny-list of cancelled/completed
// would leak phantom rows into customer-facing facts. 'rescheduled' keeps the
// STALE date/window until the office actions it through SmartRebooker
// (admin-schedule.js:1069-1075), and 'skipped'/'no_show' are terminal — none
// is a visit we can promise a date for. pending+confirmed are the live set
// (545/545 upcoming in prod); en_route/on_site cover the same-day in-progress
// case a texting customer may hit.
const UPCOMING_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

// Calls the extractor affirmatively classified as not-a-real-conversation
// with this customer — their summaries must never ground an SMS reply.
const EXCLUDED_CALL_TYPES = new Set(['spam', 'wrong_number']);
// V2-enriched natures that are affirmatively NOT a conversation with this
// customer (Codex r8): a shadow-mode V2 can classify a call spam while the
// legacy signals stay silent — a valid V2 verdict wins.
const EXCLUDED_V2_NATURES = new Set(['spam_solicitation', 'robocall', 'wrong_number', 'vendor_or_partner']);

// Deterministic access-code redaction (Codex r1, PR #3076): free-text fields
// REALLY carry code values — call-profile-enrichment persists strings like
// "front gate code is 4545" into access_notes — so presence-booleans on the
// dedicated code columns are not enough. Any 3-8 digit run within a short
// window after a code-ish keyword is masked before the text can reach a
// prompt (and therefore facts_block rows and sealed-eval items).
const ACCESS_CODE_KEYWORDS = 'gate|garage|door|lock\\s*box|keypad|entry|access|alarm|pin|code|combo|combination|passcode|password|passphrase';
const ACCESS_CODE_RE = new RegExp(`\\b(${ACCESS_CODE_KEYWORDS})\\b([^\\n]{0,40}?)\\b(\\d{3,8})\\b`, 'gi');
// Reverse order too (Codex r5): "4545 is the gate code" — digits first,
// keyword within the following window.
const ACCESS_CODE_REVERSE_RE = new RegExp(`\\b(\\d{3,8})\\b([^\\n]{0,40}?)\\b(${ACCESS_CODE_KEYWORDS})\\b`, 'gi');
// Non-numeric credentials (Codex r6: "gate code BLUE", "door pin BLUE 1234"):
// inside any segment that carries BOTH an access keyword and a code noun,
// every value-shaped token (digit run, ALLCAPS word, letter+digit mix) is
// masked. Over-redaction is the safe direction for access text; the keyword
// words themselves stay legible.
const ACCESS_CODE_NOUN_RE = /\b(?:code|pin|combo|combination|passcode|password|passphrase)\b/i;
const ACCESS_CODE_CONTEXT_RE = new RegExp(`\\b(?:${ACCESS_CODE_KEYWORDS})\\b`, 'i');
const ACCESS_CODE_VALUE_RE = /\b(?:\d{3,8}|[A-Z]{2,10}|[A-Za-z]*\d[A-Za-z0-9#*]*)\b/g;
// Lowercase credentials (Codex r7: "gate code blue", "the gate code is
// waves") can't be shape-detected — they're masked POSITIONALLY: the 1-2
// tokens directly following the code noun (with optional is/: connector),
// and the token directly before "is/= the … code" phrasing.
// Up to FOUR value tokens (Codex r10): spoken credentials arrive as number
// words — "four five four five" — and a two-token cap leaked the tail.
const ACCESS_CODE_AFTER_NOUN_RE = /\b(code|pin|combo|combination|passcode|password|passphrase)\b(\s*(?:is|:|=|-)?\s*)((?:["'\u201c\u2018]?[A-Za-z0-9#*]{1,12}["'\u201d\u2019]?\s*){1,4})/gi;
// Up to FOUR reverse-order tokens + password nouns (Codex r11): "four five
// four five is the gate code" / "waves is the gate password".
const ACCESS_CODE_BEFORE_NOUN_RE = /((?:["'“‘]?[A-Za-z0-9#*]{1,12}["'”’]?\s+){1,4})((?:is|=)\s+(?:the\s+)?[^.\n]{0,20}?\b(?:code|pin|combo|combination|passcode|password|passphrase)\b)/gi;
const ACCESS_CODE_STOPWORDS = new Set(['gate', 'garage', 'door', 'lockbox', 'lock', 'box', 'keypad', 'entry', 'access', 'alarm', 'pin', 'code', 'combo', 'combination', 'passcode', 'password', 'passphrase', 'is', 'the', 'a', 'an', 'use', 'tech', 'only', 'for', 'to', 'and', 'or', 'needed', 'required', 'broken', 'works', 'not', 'no', 'none', 'unknown', 'same', 'new', 'old']);
// Structured sensitive identifiers (Codex r11): SSNs and card-number runs
// spoken on calls or typed into notes must never reach a prompt or a
// persisted facts_block. Deterministic shapes: dashed SSN, keyword-adjacent
// digit runs, and 12-19 digit runs with optional separators.
const SSN_DASHED_RE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;
const SSN_KEYWORD_RE = /\b(ssn|social(?:\s+security)?(?:\s+number)?)\b([^.\n]{0,20}?)\b(\d[\d- ]{7,13}\d)\b/gi;
const CARD_NUMBER_RE = /\b(?:\d[ -]?){12,19}\b/g;
const CVV_RE = /\b(cvv2?|cvc|security\s+code|card\s+code)\b([^.\n]{0,15}?)\b(\d{3,4})\b/gi;
function redactSensitiveIdentifiers(text) {
  return String(text || '')
    .replace(SSN_DASHED_RE, '[redacted]')
    .replace(SSN_KEYWORD_RE, (m, kw, mid) => `${kw}${mid}[redacted]`)
    .replace(CARD_NUMBER_RE, (m) => (m.replace(/[^\d]/g, '').length >= 12 ? '[redacted]' : m))
    .replace(CVV_RE, (m, kw, mid) => `${kw}${mid}[redacted]`);
}

function redactAccessCodes(text) {
  let out = String(text || '');
  // repeat until stable: "gate code 1234 and garage 5678" needs both masked
  for (let i = 0; i < 5; i += 1) {
    const next = out
      .replace(ACCESS_CODE_RE, (m, kw, mid) => `${kw}${mid}[redacted]`)
      .replace(ACCESS_CODE_REVERSE_RE, (m, digits, mid, kw) => `[redacted]${mid}${kw}`);
    if (next === out) break;
    out = next;
  }
  // Alphanumeric credential pass, per sentence-ish segment.
  out = out.split(/([.;\n])/).map((seg) => {
    if (!ACCESS_CODE_CONTEXT_RE.test(seg) || !ACCESS_CODE_NOUN_RE.test(seg)) return seg;
    let masked = seg.replace(ACCESS_CODE_VALUE_RE, (tok) => (
      ACCESS_CODE_STOPWORDS.has(tok.toLowerCase()) ? tok : '[redacted]'
    ));
    // Positional lowercase pass (Codex r7): the tokens adjacent to the code
    // noun are the credential regardless of casing.
    masked = masked.replace(ACCESS_CODE_AFTER_NOUN_RE, (m, noun, mid, tokens) => {
      const maskedTokens = String(tokens || '').replace(/["'\u201c\u2018]?[A-Za-z0-9#*]{1,12}["'\u201d\u2019]?/g, (tok) => {
        const bare = tok.replace(/["'\u201c\u201d\u2018\u2019]/g, '').toLowerCase();
        return ACCESS_CODE_STOPWORDS.has(bare) ? tok : tok.replace(/[A-Za-z0-9#*]+/, '[redacted]');
      });
      return `${noun}${mid}${maskedTokens}`;
    });
    masked = masked.replace(ACCESS_CODE_BEFORE_NOUN_RE, (m, tokens, rest) => {
      const maskedTokens = String(tokens || '').replace(/["'“‘]?[A-Za-z0-9#*]{1,12}["'”’]?/g, (tok) => {
        const bare = tok.replace(/["'“”‘’]/g, '').toLowerCase();
        return ACCESS_CODE_STOPWORDS.has(bare) ? tok : tok.replace(/[A-Za-z0-9#*]+/, '[redacted]');
      });
      return `${maskedTokens}${rest}`;
    });
    return masked;
  }).join('');
  return redactSensitiveIdentifiers(out);
}

// Canonical lawn scoring, mirrored from routes/lawn-health.js:39-59 (the
// route exports only its router). Modern rows trust the stored overall_score;
// legacy rows recompute under the four-category weighting so this fact can
// never disagree with the portal/report score.
function lawnStressDamage(row = {}) {
  if (row.stress_damage != null) return row.stress_damage;
  return Math.min(row.fungus_control ?? 100, row.thatch_level ?? 100);
}
function lawnOverall(row = {}) {
  if (row.overall_score != null && row.stress_damage != null) return row.overall_score;
  return Math.round(
    (row.turf_density || 0) * 0.30 +
    (row.weed_suppression || 0) * 0.25 +
    (row.color_health || 0) * 0.25 +
    lawnStressDamage(row) * 0.20
  );
}

// The ONLY sanctioned customer copy inside technician_notes is the reviewed
// WHAT WE DID / WHAT WE FOUND parse (owner ruling 2026-07-16; the raw field
// carries access codes, billing notes, and candid remarks). Anything that
// doesn't parse renders as NO notes — never the raw text.
function customerSafeVisitNotes(notes) {
  try {
    const parsed = technicianReportCustomerCopy(notes);
    // Contract (Codex r5 — the earlier did/found read silently discarded
    // EVERY approved note): the parser returns { whatWeDid, whatWeFound,
    // body, violations } and body is already the vetted joined copy — null
    // when the banned-copy guard flagged it, which stays null here.
    return parsed?.body || null;
  } catch { return null; }
}

// How each resolved lane may be described to the customer (codex #3128 r8).
//
// Every lane gets its OWN truthful sentence. A blanket "not monthly, quote per
// application" was wrong for annual prepay — that plan is already paid for the
// year, so a per-application price is not what they owe either. And note
// per_visit's copy: the lane is an internal billing mechanism (invoice on
// completion), NOT customer wording — recurring work is always described "per
// application", never "per visit".
//
// `short` is the CUSTOMER-SAFE name, and the only form that may be serialized
// into buildSummary — which IS the managed agent's context snapshot
// (managed-assistant.js stores ctx.summary verbatim). Echoing the raw mode
// there put the forbidden word "per visit" into authoritative grounding
// (codex #3128 r9).
const BILLING_LANE_COPY = {
  monthly_membership: {
    monthlyBilled: true,
    short: 'monthly membership',
    copy: 'MONTHLY MEMBERSHIP — dues are charged monthly, so this customer\'s monthly rate IS their price. State it plainly.',
  },
  annual_prepay: {
    monthlyBilled: false,
    short: 'annual prepay (paid for the year)',
    copy: 'ANNUAL PREPAY — already paid up front for the year. Never describe a monthly charge, and never quote a per-application price as something they owe.',
  },
  per_application: {
    monthlyBilled: false,
    short: 'per application',
    copy: 'PER APPLICATION — quote the per-application price and the number of applications a year.',
  },
  per_visit: {
    monthlyBilled: false,
    // NOT "per visit" — the mode name is an internal billing mechanism
    // (invoice on completion); the customer-facing unit is the application.
    short: 'per application',
    copy: 'PER APPLICATION (invoiced after each service) — quote the per-application price; never say "per visit" to a customer.',
  },
  one_time: {
    monthlyBilled: false,
    short: 'one-time job',
    copy: 'ONE-TIME — a single job with no recurring billing relationship.',
  },
};

// An EXPLICIT monthly_membership row with no positive rate is UNPRICED, not
// free (codex #3141 r1): the dues cron only selects monthly_rate > 0
// (billing-cron.js) and chargeMonthly refuses a non-positive rate outright,
// so NO monthly charge can run for that row — asserting "dues are charged
// monthly" describes a charge that does not exist, and the amount line that
// would have qualified it is omitted precisely because there is no amount.
// The INFERRED lane cannot reach this state: resolveBillingLane requires a
// positive rate before it will infer membership at all.
const UNPRICED_MEMBERSHIP_COPY = {
  monthlyBilled: false,
  short: 'monthly membership, no rate set',
  copy: 'MONTHLY MEMBERSHIP BUT UNPRICED — no dues amount is set on this account, so nothing is charged monthly. Never state a monthly amount; give the plan and cadence and let the office confirm their price.',
};

// "Already paid up front for the year" is a claim about COVERAGE, not about
// the lane (codex #3141 r4). A customer keeps billing_mode 'annual_prepay'
// after a term expires naturally — the renewal flow owns collection from
// there — so the unconditional copy told the assistant an expired or
// renewal-pending customer was paid up, contradicting the very invoice facts
// sitting below it in the same block. Coverage is resolved against the same
// authority the billing cron suppresses on, and anything unconfirmed fails
// closed to the no-claim wording.
const ANNUAL_PREPAY_COPY_BY_COVERAGE = {
  covered: BILLING_LANE_COPY.annual_prepay,
  not_covered: {
    monthlyBilled: false,
    short: 'annual prepay, coverage not current',
    copy: 'ANNUAL PREPAY, COVERAGE NOT CURRENT — the prepaid year is not active right now (it ended, or a renewal invoice is still open). Never say they are paid up for the year and never state a monthly amount; give the plan and cadence, use the invoice facts for anything owed, and let the office confirm.',
  },
  unknown: {
    monthlyBilled: false,
    short: 'annual prepay, coverage unconfirmed',
    copy: 'ANNUAL PREPAY, COVERAGE UNCONFIRMED — this account is on the annual plan, but whether the prepaid year is currently active could not be confirmed. Never say they are paid up for the year and never state a monthly amount; let the office confirm.',
  },
};

// The billing lane as a customer-facing FACT (codex #3128 r6, r8).
//
// r6 carried only the EXPLICIT lane and reported an inferred one as "not
// stated". That was too narrow (codex r8): resolveBillingLane's inference is
// the SAME rule the dues cron bills by (MONTHLY_LANE_SQL), so a NULL-mode
// account with a real tier and a positive rate genuinely IS charged monthly —
// refusing to quote it withheld a true price. Provenance still travels with
// the fact, since the two are not equally certain.
//
// Fail-closed: an unresolvable lane reads as "not stated", never as monthly.
function resolveBillingLaneFacts(customer, annualCoverage = 'unknown') {
  try {
    const { resolveBillingLane } = require('./billing-lane');
    const { mode, source } = resolveBillingLane(customer);
    const explicit = source === 'explicit';
    // An unpriced explicit membership is NOT a monthly-billed account — see
    // UNPRICED_MEMBERSHIP_COPY (codex #3141 r1).
    const unpricedMembership = mode === 'monthly_membership'
      && !(Number(customer?.monthly_rate || 0) > 0);
    let laneCopy;
    if (unpricedMembership) laneCopy = UNPRICED_MEMBERSHIP_COPY;
    // Annual prepay's paid-up-for-the-year claim depends on live coverage,
    // which the caller resolves; unsupplied means unconfirmed, never paid up.
    else if (mode === 'annual_prepay') {
      laneCopy = ANNUAL_PREPAY_COPY_BY_COVERAGE[annualCoverage] || ANNUAL_PREPAY_COPY_BY_COVERAGE.unknown;
    } else laneCopy = BILLING_LANE_COPY[mode];
    if (!laneCopy) {
      return {
        resolvedMode: mode || null,
        mode: null,
        explicit,
        monthlyBilled: false,
        monthlyDues: null,
        label: 'not stated on the account — never state a monthly amount; give the plan and cadence and let the office confirm',
      };
    }
    const provenance = explicit
      ? 'owner-set'
      : 'not explicitly set — inferred by the same rule billing itself uses';
    return {
      resolvedMode: mode,
      mode,
      explicit,
      monthlyBilled: laneCopy.monthlyBilled,
      // Customer-safe short form for the managed-agent context snapshot.
      shortLabel: laneCopy.short,
      label: `${laneCopy.copy} (${provenance})`,
      annualCoverage: mode === 'annual_prepay' ? annualCoverage : null,
      // The AMOUNT is never derived here: what a monthly member is actually
      // charged depends on the payment method the charge will run against
      // (credit-card surcharge), which needs a query. getContextForCustomer
      // fills this in; a sync caller fails closed to no amount at all.
      monthlyDues: null,
    };
  } catch {
    return {
      resolvedMode: null,
      mode: null,
      explicit: false,
      monthlyBilled: false,
      monthlyDues: null,
      label: 'unavailable right now — never state a monthly amount',
    };
  }
}

// Is a monthly dues charge actually COLLECTING on this account right now?
//
// Active autopay is not proof that one is (codex #3141 r2). The monthly cron
// suppresses several populations before it ever reaches chargeMonthly, and
// customerOnAutopay sees none of them: service_paused_at is filtered out of
// the cron's own SELECT (billing-cron.js:121-125), a paused autopay is logged
// skipped_paused and passed over, and annual-prepay coverage (GUARD 4) or an
// open annual-prepay commitment (GUARD 5) both suppress the dues too.
//
// Every non-'active' answer is a REASON, not a silence: a paused autopay is
// not the same claim as "the office bills these", and neither is an unknown.
// Fail-closed — anything we cannot confirm resolves to 'unknown'.
// Is the prepaid year actually current? Same authority the billing cron
// suppresses on (codex #3141 r4) — a naturally expired term keeps
// billing_mode 'annual_prepay' while the renewal flow owns collection, so the
// lane alone cannot support "already paid for the year". Fail-closed: any
// error is 'unknown', which does not make the claim either.
async function resolveAnnualCoverageState(customer) {
  try {
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    const covered = await AnnualPrepayRenewals.getActivelyCoveredCustomerIds();
    return covered?.has(String(customer.id)) ? 'covered' : 'not_covered';
  } catch {
    return 'unknown';
  }
}

// Could the ENROLLMENT POINTER still collect on its own? customerOnAutopay
// requires a default row, but stripe.charge honors a valid enabled
// autopay_payment_method_id before it ever looks for one (stripe.js:1690-1737)
// — so in the supported legacy state where the pointer is chargeable and no
// default row remains, the cron really does charge an account the predicate
// calls inactive (codex #3141 r5). Unreadable counts as "cannot rule it out".
async function pointerCouldStillCollect(customer) {
  if (!customer?.autopay_payment_method_id) return false;
  try {
    const row = await db('payment_methods')
      .where({
        id: customer.autopay_payment_method_id,
        customer_id: customer.id,
        processor: 'stripe',
        autopay_enabled: true,
      })
      .whereNotNull('stripe_payment_method_id')
      .first('id');
    return !!row;
  } catch {
    return true;
  }
}

async function resolveDuesCollectionState(customer, autopayState, opts = {}) {
  // Eligibility itself was unreadable — never speak to collection at all.
  if (!autopayState) return 'unknown';
  // The cron's SELECT is the first gate, and it filters on more than the
  // pause columns (codex #3141 r3): `active: true` and `deleted_at IS NULL`
  // are part of the same WHERE, and getContextForCustomer can resolve a row
  // that fails either one. None of these customers is ever loaded, so none of
  // them is charged.
  //
  // `active` is NULLABLE and the cron matches `active = true`, so anything
  // that is not literally true is outside the billed population — a legacy
  // import with a NULL there is never charged (codex #3141 r4). Testing for
  // === false let exactly those rows publish a charge.
  if (customer?.active !== true || customer?.deleted_at) return 'account_inactive';
  if (customer?.service_paused_at) return 'service_paused';
  if (autopayState.paused) return 'autopay_paused';
  if (autopayState.on !== true) {
    // "Not auto-collecting" is a claim too, and it is wrong for a legacy
    // pointer-only account the cron still charges (codex #3141 r5). When a
    // pointer could collect on its own, claim NEITHER: no charge total is
    // published, and the copy says the collection state is unconfirmed
    // rather than asserting nothing collects.
    const pointerChargeable = opts.pointerChargeable !== undefined
      ? opts.pointerChargeable
      : await pointerCouldStillCollect(customer);
    return pointerChargeable ? 'unknown' : 'autopay_off';
  }
  try {
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    const id = String(customer.id);
    const [covered, pending] = await Promise.all([
      AnnualPrepayRenewals.getActivelyCoveredCustomerIds(),
      AnnualPrepayRenewals.getPaymentPendingCustomerIds(),
    ]);
    if (covered?.has(id)) return 'annual_prepay_covered';
    if (pending?.has(id)) return 'annual_prepay_pending';
  } catch {
    return 'unknown';
  }
  return 'active';
}

// The customer-visible monthly dues FACT, derived through the SAME pricing
// authority the charge itself runs through (codex #3141 r1).
//
// Serializing monthly_rate raw understated every confirmed-credit autopay
// account: chargeMonthly hands that base to stripe.charge, where
// computeChargeAmount adds the credit-card surcharge — so "$98.50 is what
// you're charged" was false against both the PaymentIntent and the payment
// row it writes.
//
// Two amounts, two different claims. `base` is the plan price (the dues
// themselves) and is always true when a positive rate exists. `total` is what
// actually collects, and it is published only when BOTH halves are certain:
// that a charge is collecting at all (see resolveDuesCollectionState), and
// that every method which could collect it prices the same.
//
// That second rule is why `methods` is a LIST and not the one row this used to
// resolve (codex #3141 r2): stripe.charge honors customers.autopay_payment_
// method_id first and only falls back to the default+enabled lookup
// (stripe.js:1690-1737), so pricing the default row could publish one total
// while the pointer method was charged another. Rather than re-deriving that
// selection here — a second copy of a money rule, free to drift — every
// candidate the charge path could pick is priced, and the total is published
// only when they AGREE. Then it is right whichever one collection selects,
// and a genuinely ambiguous account withholds instead of guessing.
//
// Pure (the caller supplies the already-fetched rows) so all of it is
// unit-testable without a database.
function resolveMonthlyDuesFact({ monthlyRate, collection, methods }) {
  const base = Number(monthlyRate || 0);
  if (!(base > 0)) return null;
  const withheld = (basis) => ({ base, surcharge: 0, total: null, surcharged: false, basis });
  // Not collecting (or not confirmably collecting) — the dues are still the
  // plan price and still quotable; what must not be claimed is a charge.
  const state = collection || 'unknown';
  if (state !== 'active') return withheld(state);
  if (!Array.isArray(methods) || methods.length === 0) return withheld('method_unknown');
  try {
    const { computeChargeAmount, isCardMethodType } = require('./stripe-pricing');
    const quotes = methods.map((m) => {
      const funding = m?.card_funding || null;
      // A card whose funding has never been resolved is genuinely uncertain:
      // stripe.charge backfills it from Stripe at charge time and surcharges
      // if it comes back 'credit'.
      if (isCardMethodType(m?.method_type) && !funding) return null;
      return computeChargeAmount(base, m?.method_type, { funding });
    });
    if (quotes.some((q) => !q)) return withheld('unknown_funding');
    if (new Set(quotes.map((q) => q.totalCents)).size > 1) return withheld('method_ambiguous');
    const quote = quotes[0];
    return {
      base: quote.baseCents / 100,
      surcharge: quote.surchargeCents / 100,
      total: quote.totalCents / 100,
      surcharged: quote.surchargeCents > 0,
      basis: quote.surchargeCents > 0 ? 'credit_card_surcharge' : 'no_surcharge',
    };
  } catch {
    // Pricing authority unreadable — never guess a total.
    return withheld('unknown_funding');
  }
}

// The one-phrase form of a dues fact that is NOT publishing a charge total,
// for the managed-agent context snapshot (codex #3141 r3). The snapshot is
// all that agent gets — it never sees the shadow drafter's facts block — so
// serializing "$98.50/mo dues" while dropping the reason no charge is
// collecting let it answer a current-charge question from a rate alone.
const DUES_NO_COLLECTION_SHORT = {
  // The exact surcharge-inclusive total is deliberately NOT in this snapshot
  // (codex #3141 r4). managed-assistant.js sends the snapshot once, at session
  // creation, and the session lives ~30 minutes — long enough for the customer
  // to switch between an ACH/debit and a credit method, at which point a
  // frozen total is simply the wrong number. The dues (the plan price) are far
  // more stable and stay; the exact charge belongs to the shadow drafter's
  // facts block, which is rebuilt for every single message.
  credit_card_surcharge: 'card fee applies at charge — state dues only',
  autopay_paused: 'autopay paused, not collecting',
  autopay_off: 'autopay off, not auto-collecting',
  service_paused: 'billing paused, not collecting',
  account_inactive: 'account not active, not collecting',
  annual_prepay_covered: 'annual prepay active, not collecting',
  annual_prepay_pending: 'annual prepay invoice open, not collecting',
  unknown_funding: 'charge total unconfirmed',
  method_ambiguous: 'charge total unconfirmed',
  method_unknown: 'charge total unconfirmed',
};

// The monthly-dues amounts THIS context actually published, in cents.
//
// One definition, because there are two amount guards and they had already
// drifted (codex #3141 r3): the drafter authorizes figures at draft time, and
// the scheduler re-authorizes them against a freshly built context at fire
// time, so a reviewed dues reply that sat in the queue was retired as a stale
// amount. Both now ask this.
//
// Exactly what the facts state and nothing more: the dues base whenever a
// monthly lane published dues, and the total plus the fee it breaks out only
// when the surcharge was actually resolved and published.
function authorizedDuesCents(context) {
  const lane = context?.customer?.billingLane;
  const dues = lane?.monthlyBilled ? lane.monthlyDues : null;
  if (!dues) return [];
  const cents = (v) => Math.round(Number(v) * 100);
  const out = [cents(dues.base)];
  if (dues.surcharged && dues.total != null) out.push(cents(dues.total), cents(dues.surcharge));
  return out.filter((v) => Number.isFinite(v));
}

// Every saved method the charge path could collect these dues from: the
// enrollment pointer stripe.charge honors first, plus the default+enabled
// rows it falls back to. Deliberately UNFILTERED beyond "could be charged at
// all" — an extra row only ever makes the fact more conservative, while
// re-implementing the charge path's eligibility predicate here could drop the
// very row collection picks and turn a real charge into "nothing collects".
async function fetchDuesChargeCandidates(customer) {
  const rows = await db('payment_methods')
    .where({ customer_id: customer.id, processor: 'stripe', autopay_enabled: true })
    .whereNotNull('stripe_payment_method_id')
    .where(function pointerOrDefault() {
      this.where('is_default', true);
      if (customer.autopay_payment_method_id) this.orWhere('id', customer.autopay_payment_method_id);
    })
    .select('id', 'method_type', 'card_funding', 'is_default');
  return rows;
}

class ContextAggregator {
  async getFullCustomerContext(phone) {
    const clean = (phone || '').replace(/\D/g, '');
    const variants = [clean, `1${clean}`, `+1${clean}`, clean.slice(-10)];

    const customer = await db('customers').where(function () {
      for (const v of variants) this.orWhere('phone', v).orWhere('phone', `+${v}`);
    }).first();

    if (!customer) return { known: false, phone: clean, summary: 'Unknown number — no customer record.' };

    return this.getContextForCustomer(customer);
  }

  // Build context from an already-matched customer row. Callers like the
  // inbound SMS webhook resolve a single active customer with deleted_at and
  // shared-number protection — re-looking up by phone here could silently
  // pick a different (or deleted) account that shares the number.
  async getContextForCustomer(customer) {
    // Parallel data fetch
    const [smsHistory, serviceHistory, upcomingServices, propertyPrefs, payments, interactions, complaints, reschedules, pendingEstimate, activeCancelSave, compliance, recentCalls, allInvoices, lawnAssessments, cardOnFile] = await Promise.all([
      db('sms_log').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(20),
      // completed visits only (Codex r8): an 'incomplete' closeout must not
      // answer "what did you do last time" as though the work happened.
      db('service_records').where({ customer_id: customer.id, status: 'completed' }).orderBy('service_date', 'desc').limit(5),
      db('scheduled_services as ss').leftJoin('technicians as tech', 'ss.technician_id', 'tech.id').where('ss.customer_id', customer.id).where('ss.scheduled_date', '>=', etDateString()).whereIn('ss.status', UPCOMING_SERVICE_STATUSES).orderBy('ss.scheduled_date').limit(3).select('ss.service_type', 'ss.scheduled_date', 'ss.window_display', 'ss.window_start', 'ss.window_end', 'ss.time_window', 'ss.status', 'tech.name as technician_name'),
      db('property_preferences').where({ customer_id: customer.id }).first(),
      // 'upcoming' filtered IN SQL (Codex r8) — post-limit JS filtering let
      // five future autopay rows empty the history.
      db('payments').where({ 'payments.customer_id': customer.id }).whereNot('status', 'upcoming').orderBy('payment_date', 'desc').limit(5),
      db('customer_interactions').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(10),
      db('customer_interactions').where({ customer_id: customer.id, interaction_type: 'complaint' }).where('created_at', '>', new Date(Date.now() - 90 * 86400000)),
      db('reschedule_log').where({ customer_id: customer.id }).where('created_at', '>', new Date(Date.now() - 30 * 86400000)).count('* as count').first(),
      // whereNull(archived_at): an archived sent/viewed row is a courtship
      // that already closed some other way — not a pending estimate.
      db('estimates').where({ customer_id: customer.id }).whereIn('status', ['sent', 'viewed']).whereNull('archived_at').orderBy('created_at', 'desc').first(),
      db('sms_sequences').where({ customer_id: customer.id, sequence_type: 'cancellation_save', status: 'active' }).first(),
      this.getCompliance(customer.id),
      this.getRecentCalls(customer.id),
      // Newest invoice a customer could actually be asked about: unpaid and
      // not voided. payer_id kept in the row — a third-party-billed invoice
      // is a FACT the drafter needs (the customer cannot pay it), never a
      // reason to hide it. Fail-soft like every other leg.
      db('invoices').where({ customer_id: customer.id })
        // Canonical uncollectible set (invoice-helpers — processing/refunded/
        // canceled included, Codex r2) + draft (not yet sent; the customer
        // has never seen it, so it must not ground a reply about
        // "your invoice"). LIST, not first (Codex r5): the newest row can be
        // payer-billed while the customer still owes an older own invoice —
        // and the canonical balance sums collectible own invoices.
        // ALL statuses fetched (Codex r10 — the r9 consolidation edit missed;
        // a visible-only fetch left draftOwnInvoiceIds permanently empty and
        // payer classification blind to settled payer rows). The visible
        // sent/viewed/overdue slice is derived in JS below; 300-row sanity
        // ceiling, far above any real account.
        .orderBy('created_at', 'desc')
        .limit(300)
        .select('id', 'title', 'status', 'total', 'credit_applied', 'due_date', 'payer_id', 'created_at')
        // FAIL CLOSED (Codex r11): a lone invoice-query failure must not
        // read as "no invoices" — null marks billing UNAVAILABLE and the
        // facts render a visible unknown instead of "Balance: Current".
        .catch(() => null),
      // v10: lawn health scores — "how's my lawn doing" is a routine text.
      db('lawn_assessments').where({ customer_id: customer.id })
        // Tech-confirmed only (Codex r2): the customer lawn-health routes all
        // filter on confirmed_by_tech — provisional AI scores must not ground
        // a customer-facing text.
        .where({ confirmed_by_tech: true })
        .orderBy('service_date', 'asc')
        .select('service_date', 'turf_density', 'weed_suppression', 'fungus_control', 'thatch_level', 'color_health', 'overall_score', 'stress_damage')
        // FAIL CLOSED (Codex r12): a query failure must not read as "no
        // assessments on file" — null renders a visible unavailable.
        .catch(() => null),
      // v10: the card on file (designated autopay card first). Brand + last4
      // only — never a full number anywhere in this system.
      db('payment_methods').where({ customer_id: customer.id })
        // Stripe-backed methods only (Codex r7): legacy-processor rows are
        // preserved by migration but nothing can charge them — a legacy
        // default must not read as the current card on file.
        .where({ processor: 'stripe' })
        .whereNotNull('stripe_payment_method_id')
        // The DEFAULT method is the canonical card-on-file (Codex r5):
        // savePaymentMethod clears only is_default on old rows, so a stale
        // row can keep autopay_enabled=true — ordering by autopay first
        // would resurrect it.
        .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'desc' }])
        .first('card_brand', 'last_four', 'exp_month', 'exp_year', 'autopay_enabled', 'is_default', 'method_type')
        // FAIL CLOSED (Codex r12): customerOnAutopay swallows DB errors into
        // "no chargeable method" → false — a transient payment_methods
        // failure would render "Autopay: not active" as fact. Our own query
        // hits the same table; an error sentinel here forces the UNKNOWN
        // autopay rendering below.
        .catch(() => 'unavailable'),
    ]);

    const lastService = serviceHistory[0] || null;
    // Third-party Bill-To (Codex r2, mirrors billing-v2 /balance): a payment
    // against a payer-billed invoice is the PAYER's even though the row sits
    // under the homeowner's customer_id — exclude those from both the
    // balance and the recent-payments facts.
    const billingUnavailable = allInvoices === null;
    const invoiceRows = allInvoices || [];
    const VISIBLE_INVOICE_STATUSES = new Set(['sent', 'viewed', 'overdue']);
    const payerInvoiceIds = new Set(invoiceRows.filter((r) => r.payer_id).map((r) => String(r.id)));
    const draftOwnInvoiceIds = new Set(invoiceRows.filter((r) => !r.payer_id && String(r.status) === 'draft').map((r) => String(r.id)));
    const paymentInvoiceId = (p) => {
      try {
        const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
        return m && m.invoice_id != null ? String(m.invoice_id) : null;
      } catch { return null; }
    };
    const ownPayments = payments.filter((p) => {
      const invId = paymentInvoiceId(p);
      return !(invId && payerInvoiceIds.has(invId));
    });
    // Canonical balance (Codex r5, mirrors billing-v2 /balance): the sum of
    // collectible OWN invoices (net of credit) plus failed standalone
    // attempts — a customer with a sent-but-unpaid invoice and no failed
    // attempt is NOT "Current". Invoice-linked failed attempts are excluded
    // (the invoice itself already counts — double-count guard). Superseded
    // failed attempts were collected by their retry's own row.
    const ownInvoices = invoiceRows.filter((inv) => !inv.payer_id && VISIBLE_INVOICE_STATUSES.has(String(inv.status)));
    const ownInvoiceIds = new Set(ownInvoices.map((inv) => String(inv.id)));
    const invoiceBalance = ownInvoices.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);
    const failedStandalone = ownPayments
      .filter(p => ['failed', 'pending', 'overdue'].includes(p.status) && !p.superseded_by_payment_id)
      // Invoice-linked failures are excluded (Codex r8, billing-v2 canon) —
      // the invoice lifecycle owns that money — EXCEPT when the linked
      // invoice is still a DRAFT (Codex r9, billing-v2:605-608): the visible
      // allow-list never sums drafts, so dropping the failed
      // completion-autopay row too would show $0 owed on a still-collectible
      // debt.
      .filter(p => { const invId = paymentInvoiceId(p); return !invId || draftOwnInvoiceIds.has(invId); })
      .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = invoiceBalance + failedStandalone;
    // Newest own invoice with a POSITIVE due (Codex r8): a fully-credited
    // newest row must not present "$0.00 due" while an older invoice carries
    // the balance.
    const openInvoice = ownInvoices.find((inv) => invoiceAmountDue(inv) > 0) || null;
    const hasPayerBilledOpen = invoiceRows.some((inv) => inv.payer_id && VISIBLE_INVOICE_STATUSES.has(String(inv.status)));
    // The BILLING LANE, resolved once and carried as an explicit FACT. The
    // per-application copy rule lets a monthly amount be spoken only when the
    // account says the lane is monthly membership — but nothing produced that
    // fact, so every genuine monthly member fell into the office-confirmation
    // fallback (codex #3128 r6). Feeds buildSummary (the managed-agent
    // snapshot) and the shadow drafter's BILLING block.
    let billingLane = resolveBillingLaneFacts(customer);
    // The annual lane's paid-up claim needs live coverage, so it is resolved
    // and the fact rebuilt with it (codex #3141 r4). Only that lane pays for
    // the lookup.
    if (billingLane.mode === 'annual_prepay') {
      billingLane = resolveBillingLaneFacts(customer, await resolveAnnualCoverageState(customer));
    }
    // Canonical autopay state (Codex r1): the raw autopay_enabled flag lies
    // when the default method is missing/expired/unhealthy, and a stale
    // autopay_paused_until must not read as paused — customerOnAutopay +
    // isPaused are the same predicates the customer autopay endpoint serves.
    // Fail-closed: an eligibility error renders the state UNKNOWN, never on.
    let autopayState = null;
    const paymentMethodsUnavailable = cardOnFile === 'unavailable';
    try {
      if (paymentMethodsUnavailable) throw new Error('payment_methods unreadable — autopay state unknowable');
      const paused = isPaused(customer);
      // next_charge_date is only real for the monthly-membership lane
      // (Codex r9, customer-autopay canon): per-application / prepay /
      // one-time accounts can carry a stale date the cron will never act on
      // — advertising it would promise a charge that isn't coming. The
      // RESOLVED lane (explicit or inferred) is the right test here: the 8AM
      // cron bills the inferred lane too (billing-lane MONTHLY_LANE_SQL).
      // monthlyBilled, not resolvedMode: an UNPRICED membership is filtered
      // out by the cron's monthly_rate > 0 and never charged either, so its
      // next_charge_date is the same empty promise (codex #3141 r1; mirrors
      // customer-autopay's `!hasMonthlyRate → null`).
      const monthlyLane = billingLane.monthlyBilled;
      autopayState = {
        on: paused ? false : await customerOnAutopay(customer),
        paused,
        pausedUntil: paused ? customer.autopay_paused_until : null,
        nextChargeDate: monthlyLane ? (customer.next_charge_date || null) : null,
      };
    } catch (err) {
      logger.warn(`[context] autopay eligibility failed for customer ${customer.id}: ${err.message}`);
    }

    // The dues AMOUNT the monthly lane authorizes, priced through the charge
    // path's own authority rather than the raw rate (codex #3141 r1). Only
    // the monthly lane pays for these queries — for every other lane the
    // stored rate is an artifact nobody is charged, so there is nothing to
    // price. Every failure here resolves to a withheld total, never a guess:
    // an eligibility failure above already leaves autopayState null, which
    // reads as an unconfirmed collection state.
    if (billingLane.monthlyBilled) {
      const collection = await resolveDuesCollectionState(customer, autopayState);
      let methods = null;
      if (collection === 'active') {
        try { methods = await fetchDuesChargeCandidates(customer); } catch { methods = null; }
      }
      billingLane.monthlyDues = resolveMonthlyDuesFact({
        monthlyRate: customer.monthly_rate,
        collection,
        methods,
      });
    }

    // Build flags
    const flags = [];
    if (balance > 0) flags.push({ type: 'overdue_balance', severity: balance > 200 ? 'high' : 'medium', detail: `$${balance.toFixed(2)} outstanding` });
    if (complaints.length > 0) flags.push({ type: 'open_complaint', severity: 'high', detail: complaints[0].subject });
    if (propertyPrefs?.pet_details) flags.push({ type: 'pet_alert', severity: 'info', detail: propertyPrefs.pet_details });
    if (propertyPrefs?.chemical_sensitivities) flags.push({ type: 'sensitivity', severity: 'medium', detail: propertyPrefs.chemical_sensitivity_details || 'Yes' });
    if (parseInt(reschedules?.count || 0) > 1) flags.push({ type: 'reschedule_history', severity: 'medium', detail: `${reschedules.count} reschedules in 30 days` });
    if (['at_risk', 'churned'].includes(customer.pipeline_stage)) flags.push({ type: 'churn_risk', severity: 'high', detail: `Stage: ${customer.pipeline_stage}` });
    if (activeCancelSave) flags.push({ type: 'cancel_save_active', severity: 'high', detail: `Cancel save step ${activeCancelSave.step}` });
    // No amount in the flag (Codex r5 + per-application rule): this detail
    // renders into ACCOUNT FLAGS, which is verifier-approved grounding.
    if (pendingEstimate) flags.push({ type: 'pending_estimate', severity: 'info', detail: `${pendingEstimate.waveguard_tier || 'estimate'} pending (priced per application)` });

    const summary = this.buildSummary(customer, flags, lastService, upcomingServices, balance, billingLane);

    return {
      known: true,
      customer: {
        id: customer.id, name: `${customer.first_name} ${customer.last_name}`,
        firstName: customer.first_name, phone: customer.phone, email: customer.email,
        address: `${customer.address_line1}, ${customer.city}, FL ${customer.zip}`,
        tier: customer.waveguard_tier, monthlyRate: parseFloat(customer.monthly_rate || 0),
        pipelineStage: customer.pipeline_stage, leadScore: customer.lead_score,
        customerSince: customer.customer_since,
        // The lane that decides whether monthlyRate above may ever be spoken
        // as this customer's price (codex #3128 r6).
        billingLane,
      },
      smsHistory: smsHistory.map(m => ({ direction: m.direction, body: m.message_body, date: m.created_at, type: m.message_type })),
      // technician_notes is INTERNAL (owner ruling 2026-07-16: access codes,
      // billing notes, candid remarks live there) — only the reviewed
      // WHAT WE DID / WHAT WE FOUND parse may reach customer-facing prompts
      // (Codex r1); unparseable notes render as none, never raw.
      lastService: lastService ? { type: lastService.service_type, date: lastService.service_date, notes: customerSafeVisitNotes(lastService.technician_notes) } : null,
      // v10 grounding: the last few visits with reviewed notes + areas —
      // "what did you do last time" is a routine customer text.
      serviceHistory: serviceHistory.slice(0, 3).map(s => ({
        type: s.service_type,
        date: s.service_date,
        notes: customerSafeVisitNotes(s.technician_notes),
        areasServiced: Array.isArray(s.areas_serviced) ? s.areas_serviced : null,
      })),
      upcomingServices: upcomingServices.map(s => ({ type: s.service_type, date: s.scheduled_date, window: this.deriveWindow(s), status: s.status, tech: s.technician_name || null, isToday: this.calendarDay(s.scheduled_date) === etDateString() })),
      billing: {
        // invoice grounding failed → the whole money picture is unknowable
        unavailable: billingUnavailable,
        outstandingBalance: balance,
        // completed/attempted history only (Codex r5): 'upcoming' autopay
        // rows are FUTURE charges, not payments the customer made.
        recentPayments: ownPayments.filter((p) => String(p.status || '').toLowerCase() !== 'upcoming').slice(0, 3),
        // v10: real autopay state (canonical eligibility, null = unknown).
        autopay: autopayState,
        // v10: the newest sent-and-unpaid invoice. payerBilled=true means a
        // third party pays it — the customer cannot, and a draft must never
        // ask them to.
        // The customer's OWN newest collectible invoice (payer-billed rows
        // can never shadow it — Codex r5); the payer-billed note rides
        // separately so both facts surface.
        openInvoice: openInvoice ? {
          title: openInvoice.title || null,
          status: openInvoice.status,
          // Net of applied credit (invoice-helpers.invoiceAmountDue) — the
          // gross total over-states what Stripe will collect (Codex r2).
          amountDue: invoiceAmountDue(openInvoice),
          dueDate: openInvoice.due_date || null,
        } : null,
        payerBilledInvoice: hasPayerBilledOpen,
        // v10: payment method on file — brand/bank + last4 only, never a
        // full number. ACH methods store bank last4 with a null card_brand
        // (Codex r2) — label them a bank account, never "card".
        cardOnFile: cardOnFile && cardOnFile !== 'unavailable' && cardOnFile.last_four ? {
          type: String(cardOnFile.method_type || '').toLowerCase().includes('bank') || String(cardOnFile.method_type || '').toLowerCase().includes('ach') || (!cardOnFile.card_brand && cardOnFile.method_type) ? 'bank' : 'card',
          brand: cardOnFile.card_brand || null,
          last4: cardOnFile.last_four,
          expMonth: cardOnFile.exp_month || null,
          expYear: cardOnFile.exp_year || null,
          // the autopay label requires the CANONICAL on-state (Codex r11) —
          // stale row flags on an expired/paused/blocked method must not
          // present as the active charge method.
          isAutopayCard: Boolean(cardOnFile.is_default && cardOnFile.autopay_enabled && autopayState?.on),
        } : null,
      },
      // v10: lawn health — latest vs baseline, same scoring the AI-number
      // assistant's get_lawn_health tool reports.
      lawnHealth: (() => {
        if (lawnAssessments === null) return { unavailable: true };
        const rows = (lawnAssessments || []).filter((r) => r && r.service_date);
        if (!rows.length) return null;
        // Only the four technician-confirmed categories (Codex r5): fungus/
        // thatch are retained AI sub-reads the tech does NOT correct — a low
        // raw sub-read must not become a texted diagnosis. Stress is the
        // consolidated confirmed metric.
        const shape = (row) => ({
          date: row.service_date,
          overall: lawnOverall(row),
          turfDensity: row.turf_density ?? null,
          weedSuppression: row.weed_suppression ?? null,
          colorHealth: row.color_health ?? null,
          stressDamage: lawnStressDamage(row),
        });
        return { baseline: shape(rows[0]), latest: shape(rows[rows.length - 1]), assessments: rows.length };
      })(),
      // v10: pending estimate as a first-class fact (was only a flag detail).
      pendingEstimate: pendingEstimate ? {
        status: pendingEstimate.status,
        monthlyTotal: pendingEstimate.monthly_total != null ? parseFloat(pendingEstimate.monthly_total) : null,
        tier: pendingEstimate.waveguard_tier || null,
        // authoritative send stamp ONLY (Codex r5) — a draft-then-sent
        // estimate must never report its creation date as the send date.
        sentAt: pendingEstimate.sent_at || null,
      } : null,
      propertyPrefs: propertyPrefs || {},
      // v10: property facts the drafter may draw on. Access CODES are
      // presence-booleans ONLY — the values never enter a prompt (they would
      // persist into facts_block rows and sealed-eval items; "it's on file"
      // is the only customer-facing answer anyway).
      // Free-text preference fields run through the deterministic access-
      // code redactor (Codex r1) — call-profile enrichment writes literal
      // code values into access_notes.
      propertyProfile: propertyPrefs ? {
        pets: redactAccessCodes(propertyPrefs.pet_details) || null,
        petsSecuredPlan: redactAccessCodes(propertyPrefs.pets_secured_plan) || null,
        irrigation: Boolean(propertyPrefs.irrigation_system),
        irrigationNotes: redactAccessCodes(propertyPrefs.irrigation_schedule_notes) || null,
        hoaName: propertyPrefs.hoa_name || null,
        hoaRestrictions: redactAccessCodes(propertyPrefs.hoa_restrictions) || null,
        accessNotes: redactAccessCodes(propertyPrefs.access_notes) || null,
        parkingNotes: redactAccessCodes(propertyPrefs.parking_notes) || null,
        specialInstructions: redactAccessCodes(propertyPrefs.special_instructions) || null,
        gateCodeOnFile: Boolean(propertyPrefs.property_gate_code || propertyPrefs.neighborhood_gate_code),
        garageCodeOnFile: Boolean(propertyPrefs.garage_code),
        lockboxOnFile: Boolean(propertyPrefs.lockbox_code),
      } : null,
      flags, compliance,
      recentInteractions: interactions.slice(0, 5).map(i => ({ type: i.interaction_type, subject: i.subject, date: i.created_at })),
      recentCalls: recentCalls.map(c => ({ summary: c.call_summary, direction: c.direction, outcome: c.call_outcome, date: c.created_at, transcript: c.transcript || null, nature: c.enriched_nature || null })),
      summary,
    };
  }

  // Last few phone calls that produced an AI summary (call-recording-processor
  // writes call_log.call_summary after transcription). Customers routinely
  // text about what "we discussed on the phone" — without these the drafter
  // is blind to the other channel and invents what was said. Summaries only:
  // raw transcripts are long and speaker-attribution on legacy rows is
  // unreliable, while summaries exist on ~half of recent calls in prod.
  async getRecentCalls(customerId) {
    try {
      const rows = await db('call_log')
        .where({ customer_id: customerId })
        // v10: 60-day window, 4 calls — customers reference calls older than
        // a month ("when we talked last month about the ants…").
        .where('created_at', '>', new Date(Date.now() - 60 * 86400000))
        .whereNotNull('call_summary')
        .whereRaw("length(trim(call_summary)) > 0")
        // The voice webhook links customer_id by caller ID BEFORE the call is
        // classified, so spam/wrong-number calls can carry this customer's id
        // — their summaries must never ground a reply. NULL outcome stays
        // eligible (NOT IN is UNKNOWN on NULL and would drop real calls that
        // simply haven't been assigned an outcome; same rule as the corpus
        // miner's Codex P2).
        .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
        .orderBy('created_at', 'desc')
        // over-fetch: the extraction-classified misdials below are filtered
        // in JS (ai_extraction is a TEXT column in prod — casting to jsonb in
        // SQL throws on any malformed row), and a filtered row must not
        // silently shrink the pick below 4 real calls.
        .limit(10)
        .select('direction', 'call_outcome', 'call_summary', 'created_at', 'ai_extraction', 'processing_status', 'transcription', 'ai_extraction_enriched', 'v2_extraction_status');
      const eligible = rows.filter((r) => !this.isExcludedCall(r)).slice(0, 4);
      // v10: the NEWEST call also carries its transcript (owner directive:
      // the drafter should see what was actually said, not only the
      // summary). One call only — transcripts are long — and capped here to
      // bound the context object; the drafter caps and sanitizes again at
      // render. Older calls stay summary-only.
      // Spoken code values ("my gate code is 4545") get the same
      // deterministic redaction as property notes before either the summary
      // or the transcript can reach a prompt.
      // Validated v2 extraction (Codex r2): when the enriched extraction is
      // 'valid', surface its customer-relevant classification alongside the
      // raw transcript — a truncated/ambiguous transcript shouldn't be the
      // only structured read of the call. Whitelisted scalar only; the rest
      // of the enriched payload (dispositions, internal codes) stays out of
      // customer-facing grounding.
      const enrichedNature = (r) => {
        if (String(r.v2_extraction_status || '') !== 'valid') return null;
        try {
          const obj = typeof r.ai_extraction_enriched === 'string' ? JSON.parse(r.ai_extraction_enriched) : r.ai_extraction_enriched;
          const nature = String(obj?.call_nature || '').trim();
          return nature ? nature.slice(0, 60) : null;
        } catch { return null; }
      };
      return eligible.map((r, i) => ({
        ...r,
        enriched_nature: enrichedNature(r),
        call_summary: redactAccessCodes(r.call_summary),
        transcript: i === 0 && typeof r.transcription === 'string' && r.transcription.trim()
          ? redactAccessCodes(r.transcription.slice(0, 4000))
          : null,
      }));
    } catch (err) {
      logger.warn(`[context] recent-call lookup failed for customer ${customerId}: ${err.message}`);
      return [];
    }
  }

  // Extracted call_type from a call_log.ai_extraction value (TEXT column
  // holding JSON.stringify output; tolerate an already-parsed object and
  // malformed rows). Returns '' when unknown — unknown stays ELIGIBLE, the
  // exclusion is only for calls the extractor affirmatively classified as
  // not-this-customer's-business.
  extractedCallType(raw) {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return String(obj?.call_type || '').trim().toLowerCase();
    } catch { return ''; }
  }

  // A call is excluded from grounding on ANY affirmative not-a-real-
  // conversation signal, because the processor persists them inconsistently
  // (Codex P2 rounds 2-3): the spam skip path stamps processing_status='spam'
  // + ai_extraction.is_spam WITHOUT call_outcome (and call_type may be
  // missing/invalid there), while other paths only set call_type. is_lead is
  // NOT a signal — existing customers' real calls are all is_lead=false.
  isExcludedCall(row) {
    if (String(row?.processing_status || '').trim().toLowerCase() === 'spam') return true;
    if (EXCLUDED_CALL_TYPES.has(this.extractedCallType(row?.ai_extraction))) return true;
    // Valid V2 verdicts count (Codex r8) — legacy signals may be silent.
    if (String(row?.v2_extraction_status || '') === 'valid') {
      try {
        const enriched = typeof row.ai_extraction_enriched === 'string' ? JSON.parse(row.ai_extraction_enriched) : row.ai_extraction_enriched;
        if (EXCLUDED_V2_NATURES.has(String(enriched?.call_nature || '').trim().toLowerCase())) return true;
      } catch { /* malformed enriched → fall through to legacy signals */ }
    }
    try {
      const obj = typeof row?.ai_extraction === 'string' ? JSON.parse(row.ai_extraction) : row?.ai_extraction;
      return obj?.is_spam === true;
    } catch { return false; }
  }

  // Calendar day 'YYYY-MM-DD' of a Postgres DATE value. pg hands DATE columns
  // over as Date objects at local midnight, so the local calendar parts are
  // the true day (same idiom as the shadow drafter's formatEtDate); strings
  // pass through their date prefix. Never treat these as instants — a UTC
  // reparse shifts the day.
  calendarDay(value) {
    if (!value) return null;
    if (value instanceof Date) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
    return m ? m[1] : null;
  }

  // The arrival window lives in window_start (Postgres `time`, ET wall-clock
  // strings like '13:00:00') on nearly every row — booking and admin-schedule
  // both write it, while window_display is set by only a few legacy paths
  // (1 of 545 upcoming in prod). The CUSTOMER-FACING window is ALWAYS
  // window_start + 2 hours (owner directive; see utils/sms-time-format.js) —
  // window_end is the internal job-duration block that drives scheduling and
  // must never be quoted to a customer. Everything this context feeds is a
  // customer-facing SMS surface, so derive start+2h here; time_window
  // ('morning'/'afternoon') is the coarse fallback.
  deriveWindow(s) {
    // window_start derivation comes FIRST (Codex P2): some writers (e.g. the
    // call processor's phone-booking path) set window_display to a bare start
    // time like '9:00 AM' alongside window_start — letting a display string
    // short-circuit would quote a point time instead of the required 2-hour
    // window. window_display only speaks when there is no derivable start.
    const range = arrivalWindowRange((s.window_start || '').toString());
    if (range) {
      const [rs, re] = range.split('-');
      return `${this.formatClockTime(rs)}–${this.formatClockTime(re)}`;
    }
    const display = (s.window_display || '').toString().trim();
    if (display) return display;
    const tw = (s.time_window || '').toString().trim();
    if (tw) return tw.charAt(0).toUpperCase() + tw.slice(1);
    return null;
  }

  // 'HH:MM:SS' (already ET wall clock, no tz) → '1:00 PM'. Returns null on a
  // shape it can't parse so deriveWindow falls through rather than guessing.
  formatClockTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec((t || '').toString());
    if (!m) return null;
    let h = parseInt(m[1], 10);
    if (Number.isNaN(h)) return null;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m[2]} ${ampm}`;
  }

  buildSummary(c, flags, lastSvc, upcoming, balance, billingLane) {
    // No rate amount here (Codex r3 + the per-application display rule):
    // monthly_rate is an internal figure, not customer billing copy — with
    // amount-bearing drafts now sendable, "($X/mo)" in the summary would let
    // a per-application customer be quoted a monthly price.
    let s = `${c.first_name} ${c.last_name} | ${c.waveguard_tier || 'No tier'} | ${c.pipeline_stage}`;
    // …but the LANE itself must travel, or a genuine monthly member can never
    // be told their real price (codex #3128 r6). This summary IS the managed
    // agent's context snapshot, so the fact has to live here to reach it.
    // Recomputed when absent so a direct buildSummary caller still fails
    // closed to "not stated" rather than dropping the fact entirely.
    const lane = billingLane || resolveBillingLaneFacts(c);
    // shortLabel, never the raw mode (codex #3128 r9): this string IS the
    // managed agent's context snapshot, and `per_visit` spelled out would put
    // the one unit the house voice forbids into authoritative grounding.
    s += ` | Billing lane: ${lane.shortLabel
      ? `${lane.shortLabel}${lane.explicit ? '' : ' (inferred)'}`
      : 'not stated — no monthly amount'}`;
    // The monthly lane is the one case where a plan price may be spoken, so
    // the amount has to travel WITH it — the house voice forbids computing or
    // inventing figures, so "state it plainly" without the number just
    // produces a deferral (codex #3128 r9). The amount comes from the priced
    // dues fact, NEVER from c.monthly_rate: the raw rate is the base, and a
    // confirmed-credit card on file is charged that base plus the surcharge
    // (codex #3141 r1). No priced fact (sync caller, unpriced row) = no
    // amount in the snapshot at all.
    const dues = lane.monthlyBilled ? lane.monthlyDues : null;
    if (dues) {
      // The dues amount travels; the exact charge total does NOT (see
      // DUES_NO_COLLECTION_SHORT — this string outlives the account state it
      // describes). The REASON travels with the amount, or this snapshot says
      // "monthly membership, $98.50" about an account nothing is collecting
      // from (codex #3141 r3).
      const why = DUES_NO_COLLECTION_SHORT[dues.basis]
        || (dues.basis === 'no_surcharge' ? null : 'collection state unconfirmed');
      s += ` ($${dues.base.toFixed(2)}/mo dues${why ? ` — ${why}` : ''})`;
    }
    if (lastSvc) s += ` | Last: ${lastSvc.service_type} ${new Date(lastSvc.service_date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;
    if (upcoming.length) s += ` | Next: ${upcoming[0].service_type} ${new Date(upcoming[0].scheduled_date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;
    if (balance > 0) s += ` | ⚠️ $${balance.toFixed(2)} overdue`;
    if (flags.some(f => f.type === 'open_complaint')) s += ` | ⚠️ Open complaint`;
    if (flags.some(f => f.type === 'cancel_save_active')) s += ` | 🚨 Cancel save active`;
    return s;
  }

  async getCompliance(customerId) {
    try {
      const LimitChecker = require('./application-limits');
      return await LimitChecker.getPropertyComplianceStatus(customerId);
    } catch { return null; }
  }
}

module.exports = new ContextAggregator();
module.exports.UPCOMING_SERVICE_STATUSES = UPCOMING_SERVICE_STATUSES;
module.exports.redactAccessCodes = redactAccessCodes;
module.exports.lawnOverall = lawnOverall;
module.exports.customerSafeVisitNotes = customerSafeVisitNotes;
module.exports.resolveBillingLaneFacts = resolveBillingLaneFacts;
module.exports.resolveMonthlyDuesFact = resolveMonthlyDuesFact;
module.exports.resolveDuesCollectionState = resolveDuesCollectionState;
module.exports.authorizedDuesCents = authorizedDuesCents;
module.exports.resolveAnnualCoverageState = resolveAnnualCoverageState;
