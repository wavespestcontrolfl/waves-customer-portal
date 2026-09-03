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
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
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
 * { kind: 'clear' | 'customer' | 'ambiguous', recipient, matched: [{ source, id }], lookup_hash }.
 * Throws on any lookup failure — the send claim fails closed on it (§13: a
 * lookup error routes the draft to the owner, never past the check).
 */
async function recipientReview(q, email) {
  const recipient = normalizeEmail(email);
  const domain = domainOf(recipient);
  const exact = [];
  const shared = [];
  for (const src of CONTACT_SOURCES) {
    const idCol = src.idColumn || 'id';
    const hits = await q(src.table).whereRaw(`LOWER(??) = ?`, [src.column, recipient]).select(`${idCol} as id`);
    for (const h of hits) exact.push({ source: src.source, id: h.id });
    if (domain && !SHARED_MAIL_DOMAINS.has(domain)) {
      const byDomain = await q(src.table).whereRaw(`LOWER(split_part(??, '@', 2)) = ?`, [src.column, domain]).select(`${idCol} as id`);
      for (const h of byDomain) if (!exact.some((e) => e.source === src.source && e.id === h.id)) shared.push({ source: src.source, id: h.id });
    }
  }
  const kind = exact.length ? 'customer' : shared.length ? 'ambiguous' : 'clear';
  const matched = kind === 'customer' ? exact : shared;
  return { kind, recipient, matched, lookup_hash: sha256({ recipient, kind, matched }) };
}

module.exports = { draftReview, classifyDraft, lintDraft, draftHash, recipientReview, CLASSIFIER_RULES, CONTACT_SOURCES, SHARED_MAIL_DOMAINS, LINT_CONTEXT };
