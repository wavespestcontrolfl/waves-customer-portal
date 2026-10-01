/**
 * Single source of truth for the estimate ACCEPTANCE terms — the one-line
 * authorization rendered directly above the public estimate's Accept button
 * and the short terms drawer it expands into (owner ruling 2026-08-28: same
 * number of steps, as few words as possible, no extra page — the Accept tap
 * IS the acceptance; the drawer opens inline).
 *
 * This is deliberately NOT a service contract: pest/lawn stay cancel-anytime
 * (termite/WDO keep their signed contract via the contracts lane). It is the
 * text a customer saw when they tapped Accept, recorded verbatim on the
 * `estimate_acceptances` row so the acceptance stays interpretable forever
 * even after the copy changes.
 *
 * If you edit ANY line you MUST bump ACCEPTANCE_TERMS_VERSION. The accept
 * route refuses a stale version from the client (409 TERMS_VERSION_STALE) so
 * a tab that rendered older copy can never be recorded as accepting this one.
 *
 * No late fee / interest / collection-cost clause lives here on purpose
 * (Florida: fees must be in the terms BEFORE acceptance, prospectively).
 * If one is ever adopted it lands as a new version; downstream copy (dunning,
 * the collections voice agent) gates on customers.accepted_terms_version.
 *
 * The client has NO copy of this text: the estimate page renders what the
 * public /data endpoint serves and attests the served version on accept.
 * Pinned by server/tests/estimate-acceptance-terms.test.js.
 *
 * v2026-10 (owner ruling 2026-09-30, annual rate review disclosed up front):
 * the Services drawer line gains one sentence — rates are reviewed once a
 * year after the first 12 months, with at least 30 days' written notice
 * before any change — in the 'plan' SCOPE only. The one-liner above Accept
 * is byte-identical to v2026-09 (owner ruling 2026-08-28: same steps, least
 * words).
 *
 * SCOPE (codex #5434 r1 P0): the rate review is a recurring residential
 * PLAN term, so one version carries two drawer variants and the record
 * stores the one the customer read:
 *   'plan'  the accept is a recurring residential plan — every service
 *           carries the plan terms (pest, lawn, mosquito, tree & shrub:
 *           the page's own plan-terms scope, never rodent, commercial,
 *           termite or unclassifiable work) and at least one service
 *           recurs. The Services line carries the rate review sentence.
 *   'base'  every other cancel-anytime accept — rodent, a one-time-only
 *           estimate, the customer's one-time toggle on a plan estimate —
 *           has no rate to review: the Services line is the v2026-09 text.
 * The /data route serves the estimate's scope (plus the 'base' lines a
 * one-time toggle swaps in) and the accept route re-derives it from the
 * same rule, refusing an attestation that names the other scope — a tab
 * can never be recorded under a line it did not render.
 */

const ACCEPTANCE_TERMS_VERSION = 'v2026-10';

const ACCEPTANCE_TERMS_SCOPES = Object.freeze(['plan', 'base']);

// Rendered as one line above the Accept CTA. 17 words.
const ACCEPTANCE_LINE = 'Accepting authorizes these services at the price shown. Cancel anytime — completed visits are still due.';

// The annual rate review sentence (verbatim owner copy, 2026-09-30): the
// 'plan' scope's Services line ends with it; the 'base' scope never
// carries it.
const RATE_REVIEW_SENTENCE = 'Rates are reviewed once a year after your first 12 months, with at least 30 days’ written notice before any change.';

// Rendered inside the inline "View terms" drawer. Five short lines; the
// Services line has its 'plan' variant beside the base text.
const ACCEPTANCE_TERMS = [
  {
    label: 'Services',
    text: 'at the price and frequency shown, until you cancel. No contract.',
    planText: `at the price and frequency shown, until you cancel. No contract. ${RATE_REVIEW_SENTENCE}`,
  },
  { label: 'Payment', text: 'due when each service is completed. Auto Pay is a separate authorization you can change in your portal.' },
  { label: 'Unpaid balances', text: 'stay due; we’ll remind you, and service may pause until you’re current.' },
  { label: 'Canceling', text: 'anytime. Completed visits are still due. Termite/WDO has its own agreement.' },
  { label: 'Accepting', text: 'counts as your signature. We keep the version, time and device, and email you a copy. You’ll get service and billing messages by text, email and phone (reply STOP to end texts).' },
];

/** 'plan' | 'base', or null for anything else (an absent or unknown attestation). */
function normalizeAcceptanceTermsScope(value) {
  return ACCEPTANCE_TERMS_SCOPES.includes(value) ? value : null;
}

function assertScope(scope) {
  if (!ACCEPTANCE_TERMS_SCOPES.includes(scope)) throw new Error(`acceptance terms: unknown scope "${scope}"`);
}

/** The drawer lines for one scope, in order. */
function acceptanceTermsLines(scope) {
  assertScope(scope);
  return ACCEPTANCE_TERMS.map((t) => ({
    label: t.label,
    text: scope === 'plan' && t.planText ? t.planText : t.text,
  }));
}

/** Verbatim snapshot stored on the acceptance row: the line + every drawer line the customer could read, for one scope. */
function acceptanceTermsSnapshot(scope) {
  return [ACCEPTANCE_LINE, ...acceptanceTermsLines(scope).map((t) => `${t.label} — ${t.text}`)].join('\n');
}

/**
 * Payload shape the public /data endpoint serves the estimate page, for the
 * estimate's own scope. A 'plan' payload also carries `oneTimeTerms` — the
 * 'base' drawer lines — so the page can swap them in when the customer
 * toggles a plan estimate to a one-time visit (no rate to review) and
 * attest 'base' for that accept.
 */
function acceptanceTermsPayload(scope) {
  assertScope(scope);
  return {
    version: ACCEPTANCE_TERMS_VERSION,
    scope,
    line: ACCEPTANCE_LINE,
    terms: acceptanceTermsLines(scope),
    ...(scope === 'plan' ? { oneTimeTerms: acceptanceTermsLines('base') } : {}),
  };
}

/**
 * Customer-facing IP for the acceptance record: first two IPv4 octets
 * (IPv4-mapped IPv6 `::ffff:a.b.c.d` is normalized first — pre-push Codex
 * P1) or the first two IPv6 groups. Null when unparseable.
 */
function maskIpForCustomer(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  if (ip.includes(':')) {
    const g = ip.split(':').filter(Boolean);
    return g.length >= 2 ? `${g[0]}:${g[1]}:…` : null;
  }
  return null;
}

/** Coarse device label for the acceptance record ("iPhone · Safari"). */
function deviceLabelFromUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const device = /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
      : /Android/i.test(ua) ? 'Android'
        : /Macintosh/i.test(ua) ? 'Mac'
          : /Windows/i.test(ua) ? 'Windows'
            : 'Device';
  // iOS Chrome/Firefox carry CriOS/FxiOS (plus a Safari/ token) — matched
  // before the Safari fallback so provenance names the real browser.
  const browser = /Edg\/|EdgiOS\/|EdgA\//i.test(ua) ? 'Edge'
    : /CriOS\//i.test(ua) ? 'Chrome'
      : /FxiOS\//i.test(ua) ? 'Firefox'
        : /Chrome\//i.test(ua) && !/Chromium/i.test(ua) ? 'Chrome'
          : /Firefox\//i.test(ua) ? 'Firefox'
            : /Safari\//i.test(ua) ? 'Safari'
              : 'Browser';
  return `${device} · ${browser}`;
}

module.exports = {
  ACCEPTANCE_TERMS_VERSION,
  ACCEPTANCE_TERMS_SCOPES,
  ACCEPTANCE_LINE,
  ACCEPTANCE_TERMS,
  RATE_REVIEW_SENTENCE,
  normalizeAcceptanceTermsScope,
  acceptanceTermsLines,
  acceptanceTermsSnapshot,
  acceptanceTermsPayload,
  maskIpForCustomer,
  deviceLabelFromUserAgent,
};
