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
 */

const ACCEPTANCE_TERMS_VERSION = 'v2026-09';

// Rendered as one line above the Accept CTA. 17 words.
const ACCEPTANCE_LINE = 'Accepting authorizes these services at the price shown. Cancel anytime — completed visits are still due.';

// Rendered inside the inline "View terms" drawer. Five short lines.
const ACCEPTANCE_TERMS = [
  { label: 'Services', text: 'at the price and frequency shown, until you cancel. No contract.' },
  { label: 'Payment', text: 'due when each service is completed. Auto Pay is a separate authorization you can change in your portal.' },
  { label: 'Unpaid balances', text: 'stay due; we’ll remind you, and service may pause until you’re current.' },
  { label: 'Canceling', text: 'anytime. Completed visits are still due. Termite/WDO has its own agreement.' },
  { label: 'Accepting', text: 'counts as your signature. We keep the version, time and device, and email you a copy. You’ll get service and billing messages by text, email and phone (reply STOP to end texts).' },
];

/** Verbatim snapshot stored on the acceptance row. */
function acceptanceTermsSnapshot() {
  return [ACCEPTANCE_LINE, ...ACCEPTANCE_TERMS.map((t) => `${t.label} — ${t.text}`)].join('\n');
}

/** Payload shape the public /data endpoint serves the estimate page. */
function acceptanceTermsPayload() {
  return {
    version: ACCEPTANCE_TERMS_VERSION,
    line: ACCEPTANCE_LINE,
    terms: ACCEPTANCE_TERMS.map((t) => ({ label: t.label, text: t.text })),
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
  const browser = /Edg\//i.test(ua) ? 'Edge'
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
  ACCEPTANCE_LINE,
  ACCEPTANCE_TERMS,
  acceptanceTermsSnapshot,
  acceptanceTermsPayload,
  maskIpForCustomer,
  deviceLabelFromUserAgent,
};
