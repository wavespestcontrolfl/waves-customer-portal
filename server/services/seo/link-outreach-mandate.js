/**
 * Bounded outreach mandate — the inputs plan v2 §6.4 / §13 add to an outreach
 * SEND (Backlink Manager step 4, PR 3a):
 *
 *   draftReview(placement)      — is the parked draft LINT-CLEAN and free of the
 *                                 commitments the mandate forbids (a reciprocal
 *                                 promise, payment, a discount, a guarantee, an
 *                                 unusual commitment)? The §6.3 2c decision
 *                                 grants AUTO_OUTREACH only on a clean draft; an
 *                                 unclean one routes to the owner's send click.
 *   draftHash(placement)        — the §3.6b `action_hash` an outreach_send
 *                                 approval binds to: sha256(recipient, subject,
 *                                 body). Recomputed by the send claim, so text
 *                                 the owner never read is never sent under the
 *                                 owner's approval.
 *   recipientReview(q, email)   — the fail-closed customer exclusion (§13):
 *                                 the recipient against EVERY real contact
 *                                 source — customers.email, every slot in
 *                                 SERVICE_CONTACT_SLOTS (built from the export,
 *                                 so a new slot is covered automatically),
 *                                 notification_prefs.billing_email, leads.email.
 *                                 An exact match is a hard block; a shared
 *                                 business domain is ambiguous (the owner
 *                                 reviews the match; the approval binds its
 *                                 lookup_hash); a lookup error is the caller's
 *                                 to fail closed on (it throws).
 *
 * Deterministic on purpose: the classifier is a regex table, not a model call,
 * so the same draft always gets the same verdict and the test corpus pins it.
 */
const crypto = require('crypto');
const { lintComms } = require('../comms-lint');
const { canonicalEmail } = require('../ads/ad-audience-consent');
const { SERVICE_CONTACT_SLOTS } = require('../customer-contact');
const { isValidEmail } = require('./link-prospect-worker');

// The commitments §6.4 keeps out of an automatic send. Conservative by design:
// a false positive costs one owner click; a false negative sends a promise.
const CLASSIFIER_RULES = Object.freeze([
  { flag: 'reciprocal_promise', re: /\b(link\s*back|in\s+return|in\s+exchange|reciprocal|link\s+(?:to|at)\s+you|we(?:'ll|\s+will)\s+link|link\s+swap|link\s+exchange|exchange\s+links)\b/i },
  { flag: 'payment', re: /(\$\s?\d|\b(?:pay(?:ment|ing)?|paid|fee|fees|sponsor(?:ed|ship)?|compensat(?:e|ion)|invoice|budget\s+for|rate\s+card)\b)/i },
  { flag: 'discount', re: /\b(discount|%\s*off|percent\s+off|coupon|complimentary|free\s+(?:service|treatment|inspection|month|visit)|on\s+the\s+house|no\s+charge)\b/i },
  { flag: 'guarantee', re: /\b(guarantee[ds]?|we\s+promise|promise\s+to|assure\s+you|100%)\b/i },
  { flag: 'commitment', re: /\b(exclusive|exclusivity|contract|agreement|commit(?:ment)?\s+to|retainer|partnership\s+deal|ongoing\s+(?:fee|payment|arrangement))\b/i },
]);

function classifyDraft(text) {
  const body = String(text || '');
  return CLASSIFIER_RULES.filter((r) => r.re.test(body)).map((r) => r.flag);
}

// comms-lint for a business recipient over email: the rules that apply to every
// audience (no shortener, the company name) plus the email channel's.
const LINT_CONTEXT = Object.freeze({ channel: 'email', audience: 'business' });
function lintDraft({ subject, body }) {
  const failures = [];
  for (const [part, text] of [['subject', subject], ['body', body]]) {
    const r = lintComms(String(text || ''), LINT_CONTEXT);
    for (const f of r.failures) failures.push({ part, rule: f.rule, reason: f.reason });
  }
  return failures;
}

/**
 * { clean, flags, lint } for the draft parked on a placement. `clean` is true
 * ONLY for a complete, validly addressed, drafted message with no lint failure
 * and no classifier hit — every other state (no draft, an ambiguous send in
 * reconciliation, a sent row) is not clean: nothing there is sendable
 * automatically.
 */
function draftReview(placement) {
  const p = placement || {};
  if (p.outreach_status !== 'drafted') return { clean: false, flags: [], lint: [], reason: 'no draft' };
  if (!isValidEmail(p.outreach_to_email)) return { clean: false, flags: [], lint: [], reason: 'invalid recipient' };
  if (!p.outreach_subject || !p.outreach_body) return { clean: false, flags: [], lint: [], reason: 'incomplete draft' };
  const flags = [...new Set([...classifyDraft(p.outreach_subject), ...classifyDraft(p.outreach_body)])];
  const lint = lintDraft({ subject: p.outreach_subject, body: p.outreach_body });
  const clean = flags.length === 0 && lint.length === 0;
  return { clean, flags, lint, reason: clean ? null : [...flags, ...lint.map((l) => `lint:${l.rule}`)].join(', ') };
}

const sha256 = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
// lower + trim; gmail / googlemail additionally drop dots and the +tag (the same canonical form Customer Match hashes)
const normalizeEmail = (e) => (canonicalEmail(e) || String(e || '').trim().toLowerCase()).replace(/@googlemail\.com$/, '@gmail.com'); // googlemail IS gmail
const GOOGLE_HOSTS = Object.freeze(['gmail.com', 'googlemail.com']);
// the stored column in the recipient's canonical form: gmail hosts compare the dot-less, tag-less local part
const GMAIL_CANONICAL_SQL = "/* gmail-canonical */ LOWER(split_part(TRIM(??), '@', 2)) = ANY(?) AND REPLACE(split_part(split_part(LOWER(TRIM(??)), '@', 1), '+', 1), '.', '') = ANY(?)";
const domainOf = (e) => { const s = normalizeEmail(e); const i = s.lastIndexOf('@'); return i === -1 ? '' : s.slice(i + 1); };

/** sha256(recipient, subject, body) — the outreach_send action hash (§3.6b). */
function draftHash({ outreach_to_email: to, outreach_subject: subject, outreach_body: body } = {}) {
  return sha256([normalizeEmail(to), String(subject || ''), String(body || '')]);
}

// Consumer mail providers: a shared domain there says nothing about identity, so
// only an EXACT address match can be a customer at these hosts.
const SHARED_MAIL_DOMAINS = Object.freeze(new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net', 'att.net', 'verizon.net', 'bellsouth.net',
  'protonmail.com', 'proton.me', 'sbcglobal.net', 'cox.net', 'earthlink.net', 'frontier.com', 'tampabay.rr.com',
]));

// every real contact source, built from the shared slot export
const CONTACT_SOURCES = Object.freeze([
  { source: 'customers.email', table: 'customers', column: 'email' },
  ...SERVICE_CONTACT_SLOTS.map((slot) => ({ source: `customers.${slot.email}`, table: 'customers', column: slot.email })),
  { source: 'notification_prefs.billing_email', table: 'notification_prefs', column: 'billing_email', idColumn: 'customer_id' },
  { source: 'leads.email', table: 'leads', column: 'email' },
]);

/**
 * One review per recipient — { kind: 'clear' | 'customer' | 'ambiguous', recipient, matched: [{ source, id }],
 * lookup_hash } — for a whole list in three queries per contact source (exact, shared domain, gmail-canonical),
 * so a queue of N drafts never issues N × sources round trips. Throws on any lookup failure — the send claim
 * fails closed on it (§13: a lookup error routes the draft to the owner, never past the check).
 */
async function recipientReviews(q, emails) {
  const recipients = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  if (!recipients.length) return [];
  const domains = [...new Set(recipients.map(domainOf).filter((d) => d && !SHARED_MAIL_DOMAINS.has(d)))];
  const googleLocals = [...new Set(recipients.filter((r) => GOOGLE_HOSTS.includes(domainOf(r))).map((r) => r.slice(0, r.lastIndexOf('@'))))];
  const exact = new Map(recipients.map((r) => [r, []]));
  const shared = new Map(recipients.map((r) => [r, []]));
  for (const src of CONTACT_SOURCES) {
    const idCol = src.idColumn || 'id';
    // stored addresses are normalized the same way as the recipient (case + surrounding whitespace); the
    // stored value comes back so each hit lands on its own recipient
    const hits = await q(src.table).whereRaw('LOWER(TRIM(??)) = ANY(?)', [src.column, recipients]).select(`${idCol} as id`, `${src.column} as email`);
    for (const h of hits) { const r = normalizeEmail(h.email); if (exact.has(r)) exact.get(r).push({ source: src.source, id: h.id }); }
    if (googleLocals.length) {
      const canon = await q(src.table).whereRaw(GMAIL_CANONICAL_SQL, [src.column, GOOGLE_HOSTS, src.column, googleLocals]).select(`${idCol} as id`, `${src.column} as email`);
      for (const h of canon) { const r = normalizeEmail(h.email); if (exact.has(r) && !exact.get(r).some((e) => e.source === src.source && e.id === h.id)) exact.get(r).push({ source: src.source, id: h.id }); }
    }
    if (domains.length) {
      const byDomain = await q(src.table).whereRaw("LOWER(split_part(TRIM(??), '@', 2)) = ANY(?)", [src.column, domains]).select(`${idCol} as id`, `${src.column} as email`);
      for (const h of byDomain) {
        const d = domainOf(h.email);
        for (const r of recipients) if (domainOf(r) === d && !exact.get(r).some((e) => e.source === src.source && e.id === h.id)) shared.get(r).push({ source: src.source, id: h.id });
      }
    }
  }
  // deterministic: the queries carry no ORDER BY, and the hash the owner acknowledges must equal the one the locked send recomputes
  const bySourceId = (a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  return recipients.map((recipient) => {
    const kind = exact.get(recipient).length ? 'customer' : shared.get(recipient).length ? 'ambiguous' : 'clear';
    const matched = (kind === 'customer' ? exact.get(recipient) : shared.get(recipient)).slice().sort(bySourceId);
    return { kind, recipient, matched, lookup_hash: sha256({ recipient, kind, matched }) };
  });
}
async function recipientReview(q, email) {
  const [r] = await recipientReviews(q, [email]);
  return r || { kind: 'clear', recipient: normalizeEmail(email), matched: [], lookup_hash: sha256({ recipient: normalizeEmail(email), kind: 'clear', matched: [] }) };
}
// reviews keyed by the address as given, for a list of rows (the queue, the pending endpoint)
async function reviewByEmail(q, emails) {
  const list = await recipientReviews(q, emails);
  const byCanonical = new Map(list.map((r) => [r.recipient, r]));
  return new Map((emails || []).filter(Boolean).map((e) => [e, byCanonical.get(normalizeEmail(e)) || null]));
}

module.exports = { draftReview, classifyDraft, lintDraft, draftHash, recipientReview, recipientReviews, reviewByEmail, normalizeEmail, CLASSIFIER_RULES, CONTACT_SOURCES, SHARED_MAIL_DOMAINS, GOOGLE_HOSTS, LINT_CONTEXT };
