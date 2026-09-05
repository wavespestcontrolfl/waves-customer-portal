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
const psl = require('psl');
const { lintComms } = require('../comms-lint');
const { canonicalEmail } = require('../ads/ad-audience-consent');
const { SERVICE_CONTACT_SLOTS } = require('../customer-contact');
const { isValidEmail } = require('./link-prospect-worker');
const { addETDaysAtWallClock } = require('../../utils/datetime-et');

// The commitments §6.4 keeps out of an automatic send. Conservative by design:
// a false positive costs one owner click; a false negative sends a promise.
const CLASSIFIER_RULES = Object.freeze([
  { flag: 'reciprocal_promise', re: /\b(link\s*back|in\s+return|in\s+exchange|reciprocal|link\s+(?:to|at)\s+you|we(?:'ll|\s+will)\s+link|link\s+swap|link\s+exchange|exchange\s+links|(?:can|could|would|will|happy\s+to|glad\s+to|able\s+to)\s+(?:also\s+)?(?:add|include|place|feature|put|give)\s+(?:a\s+|the\s+|your\s+)?link|link\s+(?:to|for)\s+your|we(?:'ll|\s+will|\s+can|\s+could|\s+would)?\s+(?:also\s+)?(?:promote|mention|feature|showcase|highlight|recommend|share)\s+(?:you|your)|(?:promote|mention|feature|showcase|highlight|recommend)\s+your\s+(?:site|website|business|page|brand|company|content|guide)|on\s+ours|(?:publish|host|run|post)(?:ing)?\s+(?:a\s+|the\s+|your\s+)?(?:guest\s+post|article|piece|content)|your\s+(?:guest\s+post|article|content)\s+on\s+our|we(?:'ll|\s+will|\s+can|\s+could|\s+would)\s+(?:also\s+)?(?:add|include|list|place)\s+(?:you|your|a\s+link|the\s+link)|add\s+your\s+(?:link|site|website|url|business|listing))\b/i },
  { flag: 'payment', re: /(\$\s?\d|\b(?:pay(?:ment|ing)?|paid|fee|fees|sponsor(?:ed|ship)?|compensat(?:e|ion)|invoice|budget\s+for|rate\s+card|purchas(?:e|ed|ing)|buy(?:ing)?|bought|price|pricing|cost(?:s)?|charge(?:s|d)?|rates?\s+for|(?:our|flat|monthly|annual|placement|listing)\s+rates?)\b)/i },
  { flag: 'discount', re: /\b(discount(?:ed|s)?|reduced\s+(?:rate|price|pricing|fee|cost)|(?:special|lower|preferred|introductory)\s+(?:rate|price|pricing)|%\s*off|percent\s+off|coupon|complimentary|free\s+(?:service|treatment|inspection|month|visit)|on\s+the\s+house|no\s+charge)\b/i },
  // `100%` needs no trailing boundary: `%` and the space after it are both non-word characters, so a `\b` there never matches
  { flag: 'guarantee', re: /\b(?:guarantee[ds]?|we\s+promise|promise\s+to|assure\s+you)\b|\b100\s?%/i },
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
  return reviewDraft({ to: p.outreach_to_email, subject: p.outreach_subject, body: p.outreach_body });
}
/**
 * The same verdict for the FOLLOW-UP draft (§6.4): drafted, addressed to the thread's recipient, lint-clean, no flag —
 * AND the follow-up's own deterministic shape (the prompt asks for it; the drafter accepts any parseable JSON, so the
 * review is what AUTO_OUTREACH relies on): the subject is exactly `Re: <the pitch's subject>` (it answers the thread —
 * a new subject reads as a second pitch) and the body is a nudge, not another pitch (FOLLOW_UP_MAX_WORDS).
 */
const FOLLOW_UP_MAX_WORDS = 160;
const followUpShape = (p) => {
  const flags = [];
  if (String(p.follow_up_subject || '').trim() !== `Re: ${String(p.outreach_subject || '').trim()}`) flags.push('follow_up_subject');
  if (String(p.follow_up_body || '').trim().split(/\s+/).length > FOLLOW_UP_MAX_WORDS) flags.push('follow_up_length');
  return flags;
};
function followUpReview(placement) {
  const p = placement || {};
  if (p.follow_up_status !== 'drafted') return { clean: false, flags: [], lint: [], reason: 'no follow-up draft' };
  const text = reviewDraft({ to: p.outreach_to_email, subject: p.follow_up_subject, body: p.follow_up_body });
  const shape = followUpShape(p);
  const flags = [...text.flags, ...shape];
  const reasons = [text.reason, ...shape].filter(Boolean);
  // a stable refusal of an AUTOMATIC attempt routes the follow-up to the owner (§6.4: never sent by default) — the
  // text may be clean, the SEND is not automatic: a failed reply check, or a recipient sharing a domain with a
  // customer / lead contact (§13: acknowledged only by the owner's click)
  const marker = OWNER_MARKER_REASONS[p.follow_up_skipped_reason];
  if (marker) reasons.push(marker);
  const clean = text.clean && shape.length === 0 && !marker;
  return { clean, flags, lint: text.lint, reason: clean ? null : reasons.join(', ') };
}
// the markers the sender stamps on follow_up_skipped_reason (the draft stays drafted) when an automatic attempt was
// refused for a reason only the owner resolves — followUpReview reads them as unclean, the selection re-selects the
// domain on them, the bridge re-decides the follow-up OWNER_OUTREACH, the auto sender refuses while one stands
const REPLY_CHECK_FAILED = 'reply_check_failed';
const RECIPIENT_REVIEW_REQUIRED = 'recipient_review_required';
const OWNER_MARKER_REASONS = Object.freeze({
  [REPLY_CHECK_FAILED]: 'reply check failed on the automatic attempt — the owner sends it',
  [RECIPIENT_REVIEW_REQUIRED]: 'the recipient shares a domain with a customer or lead contact — the owner reviews the match and sends it',
});
const OWNER_MARKERS = Object.freeze(Object.keys(OWNER_MARKER_REASONS));
/** The mandate verdict over a bare draft — the sender re-reviews the LOCKED text of either send with it. */
function reviewDraft({ to, subject, body }) {
  if (!isValidEmail(to)) return { clean: false, flags: [], lint: [], reason: 'invalid recipient' };
  if (!subject || !body) return { clean: false, flags: [], lint: [], reason: 'incomplete draft' };
  const flags = [...new Set([...classifyDraft(subject), ...classifyDraft(body)])];
  const lint = lintDraft({ subject, body });
  const clean = flags.length === 0 && lint.length === 0;
  return { clean, flags, lint, reason: clean ? null : [...flags, ...lint.map((l) => `lint:${l.rule}`)].join(', ') };
}

const sha256 = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
// lower + trim; gmail / googlemail additionally drop dots and the +tag (the same canonical form Customer Match hashes)
const normalizeEmail = (e) => (canonicalEmail(e) || String(e || '').trim().toLowerCase()).replace(/@googlemail\.com$/, '@gmail.com'); // googlemail IS gmail
const GOOGLE_HOSTS = Object.freeze(['gmail.com', 'googlemail.com']);
// the stored column in the recipient's canonical form: gmail hosts compare the dot-less, tag-less local part
// the stored column in the recipient's form: lower-cased with EVERY whitespace character removed (the recipient side
// strips them all — a stored "first last@x.com" is the same address), never TRIM alone
const STORED_SQL = "LOWER(REGEXP_REPLACE(??, '\\s', '', 'g'))";
const GMAIL_CANONICAL_SQL = `/* gmail-canonical */ split_part(${STORED_SQL}, '@', 2) = ANY(?) AND REPLACE(split_part(split_part(${STORED_SQL}, '@', 1), '+', 1), '.', '') = ANY(?)`;
const domainOf = (e) => { const s = normalizeEmail(e); const i = s.lastIndexOf('@'); return i === -1 ? '' : s.slice(i + 1); };
// the ORGANIZATION a mail host belongs to: its registrable domain (mail.publisher.com and publisher.com are one
// business — a customer mailbox on either side of that line is the same shared-domain match); a host psl cannot
// place (an IP, a bare label) is its own organization
const registrableOf = (host) => (host ? psl.get(host) || host : '');
const orgDomainOf = (e) => registrableOf(domainOf(e));
// consumer mail is exempt by its host or by its registrable domain (tampabay.rr.com is listed as the host it is)
const consumerMail = (host) => SHARED_MAIL_DOMAINS.has(host) || SHARED_MAIL_DOMAINS.has(registrableOf(host));

/** sha256(recipient, subject, body) — the outreach_send action hash (§3.6b). */
function draftHash({ outreach_to_email: to, outreach_subject: subject, outreach_body: body } = {}) {
  return sha256([normalizeEmail(to), String(subject || ''), String(body || '')]);
}
/** The outreach_followup action hash: the same shape over the follow-up draft (its recipient is the thread's). */
function followUpHash({ outreach_to_email: to, follow_up_subject: subject, follow_up_body: body } = {}) {
  return draftHash({ outreach_to_email: to, outreach_subject: subject, outreach_body: body });
}
/** Which draft a send acts on — the initial pitch or the follow-up — as the sender's `draft` shape. */
const draftOf = (placement, followUp = false) => (followUp
  ? { outreach_to_email: placement.outreach_to_email, outreach_subject: placement.follow_up_subject, outreach_body: placement.follow_up_body }
  : { outreach_to_email: placement.outreach_to_email, outreach_subject: placement.outreach_subject, outreach_body: placement.outreach_body });

// §6.4 — the follow-up: ONE per outreach cycle, due 10 ET calendar days after the pitch at the pitch's ET wall-clock
// time — never raw elapsed milliseconds, which land an hour early or late across a DST seam (the America/New_York
// discipline: every day-offset goes through datetime-et)
const FOLLOW_UP_DELAY_DAYS = 10;
const followUpDueAt = (sentAt) => addETDaysAtWallClock(sentAt, FOLLOW_UP_DELAY_DAYS);
// the lifecycle statuses a follow-up may act on: `contacted` (the initial send left the row there), plus the
// Judge-owned statuses on a SUBMIT-FIRST path (the policy's submitFirst: an outreach path whose acquire step exists AND
// precedes the pitch — `execution_after_send` alone is persisted on every path and means nothing without the step), where
// the acquisition moved the row on before the pitch — a follow-up there is claimable and never demotes the row (the
// follow-up writes its own columns). The path needs acquisition_type, account_required and execution_after_send.
// FOLLOW_UP_STATUSES_ANY is the widest set, for a query that narrows per path afterwards.
const FOLLOW_UP_JUDGE_STATUSES = Object.freeze(['placed', 'live', 'indexed']);
const FOLLOW_UP_STATUSES_ANY = Object.freeze(['contacted', ...FOLLOW_UP_JUDGE_STATUSES]);
// §6.4 — why a pending follow-up can never be composed, authorized or sent on its pinned route, or null: the route GONE
// (the path deleted — FK SET NULL — or superseded: a sent conversation is pinned to its path, the mover never re-paths
// it), the domain RE-RANKED to another path (the conversation frozen off the best path: no authority is ever decided for
// it, domainRefusal refuses the old path), or the placement OUT of the path's follow-up lifecycle (a send-first row the
// verifier promoted to live). ONE reader for the lease, the drafter's report, the send and the reconcile — the places
// that retire it (`skipped`, the reason stamped) so the conversation completes and the closure sweep releases the inbox.
// …and a follow-up exists under the authority contract ONLY (§6.4: its instance, its approval and its reply check are the
// contract's): with GATE_LINK_AUTHORITY off nothing can ever send it — read at every visit, not only when the pitch
// schedules it (followUpSchedule), so a follow-up scheduled before the gate was turned off settles the same way
const GATE_OFF_REASON = 'GATE_LINK_AUTHORITY off — follow-ups send under the authority contract only';
// a submit-first placement's ONE follow-up still OWED past its outcome (§6.4): on a submit-first path the Judge-owned
// row (placed / live / indexed, FOLLOW_UP_STATUSES(path)) still has the follow-up to send — scheduled (a due date),
// due, or drafted — so its conversation is not over: the inbox guard and the domain guard both hold it (a send-first
// row that reached live has no follow-up left: the sender refuses it by the same rule). ONE reader for both guards.
const initialSendOwed = (row, path) => FOLLOW_UP_JUDGE_STATUSES.includes(row.status)
  && Boolean(path) && require('./link-authority-policy').submitFirst(path)
  && !row.outreach_sent_at && row.outreach_status !== 'sent';
const followUpOwed = (row, path) => row.outreach_status === 'sent'
  && (['due', 'drafted'].includes(row.follow_up_status) || (row.follow_up_status === 'none' && Boolean(row.follow_up_due_at)))
  && FOLLOW_UP_JUDGE_STATUSES.includes(row.status) && FOLLOW_UP_STATUSES(path).includes(row.status);
function followUpRetirement({ row, path, domain = null }) {
  if (!require('../../config/feature-gates').isEnabled('linkAuthority')) return GATE_OFF_REASON;
  if (!path) return 'acquisition path deleted before the follow-up';
  if (path.superseded_by) return 'acquisition path superseded before the follow-up';
  if (domain && domain.best_path_id && row.path_id && domain.best_path_id !== row.path_id) return 'domain re-ranked to another path before the follow-up';
  if (!FOLLOW_UP_STATUSES(path).includes(row.status)) return `placement left the follow-up lifecycle (${row.status})`;
  return null;
}
const FOLLOW_UP_STATUSES = (path) => Object.freeze(['contacted', ...(path && require('./link-authority-policy').submitFirst(path) ? FOLLOW_UP_JUDGE_STATUSES : [])]);
// a follow-up the bridge must DECIDE (the communication/followup instance exists for it): drafted — while the
// placement is still in the lifecycle a follow-up may act on for ITS path (FOLLOW_UP_STATUSES: a send-first row the
// verifier promoted to live has left it; the sender refuses the draft by the same rule, so the instance is no longer
// required and the bridge ends it) — or in flight / ambiguous after the claim, whatever the lifecycle (the instance
// stays pinned until the reconcile settles it)
const followUpPending = (placement, path) => Boolean(placement) && placement.outreach_status === 'sent'
  && (['sending', 'send_error'].includes(placement.follow_up_status)
    || (placement.follow_up_status === 'drafted' && FOLLOW_UP_STATUSES(path).includes(placement.status)));

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

const groupByDomain = (recipients) => recipients.reduce((m, r) => { const d = orgDomainOf(r); if (d) (m.get(d) || m.set(d, []).get(d)).push(r); return m; }, new Map());
/**
 * One contact source's hits, each landed on the recipient it matches, as flat [recipient, { source, id }] pairs:
 * `exact` = the stored address equals the recipient (normalized the same way — case + every whitespace character;
 * the stored value comes back so each hit lands on its own recipient) or is its gmail-canonical form at a google
 * host; `shared` = the stored address shares the recipient's business organization (registrable domain: the
 * exact host or any subdomain of it — `accounts@mail.publisher.com` shares `editor@publisher.com`'s).
 */
async function sourceHits(q, src, { recipients, googleLocals, domains, recipientsByDomain }) {
  const idCol = src.idColumn || 'id';
  const cols = [`${idCol} as id`, `${src.column} as email`];
  const onRecipient = (rows) => rows.map((h) => [normalizeEmail(h.email), { source: src.source, id: h.id }]).filter(([r]) => recipients.has(r));
  const exact = onRecipient(await q(src.table).whereRaw(`${STORED_SQL} = ANY(?)`, [src.column, [...recipients]]).select(...cols));
  const canon = googleLocals.length ? onRecipient(await q(src.table).whereRaw(GMAIL_CANONICAL_SQL, [src.column, GOOGLE_HOSTS, src.column, googleLocals]).select(...cols)) : [];
  const byDomain = domains.length
    ? await q(src.table).whereRaw(`split_part(${STORED_SQL}, '@', 2) = ANY(?) OR split_part(${STORED_SQL}, '@', 2) LIKE ANY(?)`, [src.column, domains, src.column, domains.map((d) => `%.${d}`)]).select(...cols)
    : [];
  // the two lookups are separate statements: a contact re-addressed to the recipient between them is seen only here, so
  // a domain hit whose stored address EQUALS a recipient is an exact match — promoted, never recorded as a shared-domain
  // one (an acknowledged shared match would otherwise carry the now-exact customer address past the hard block)
  const late = onRecipient(byDomain);
  const shared = [];
  for (const h of byDomain) if (!recipients.has(normalizeEmail(h.email))) for (const r of recipientsByDomain.get(orgDomainOf(h.email)) || []) shared.push([r, { source: src.source, id: h.id }]);
  return { exact: [...exact, ...canon, ...late], shared };
}

/**
 * One review per recipient — { kind: 'clear' | 'customer' | 'ambiguous', recipient, matched: [{ source, id }],
 * lookup_hash } — for a whole list in three queries per contact source (exact, shared domain, gmail-canonical),
 * so a queue of N drafts never issues N × sources round trips. Throws on any lookup failure — the send claim
 * fails closed on it (§13: a lookup error routes the draft to the owner, never past the check).
 */
async function recipientReviews(q, emails) {
  const recipients = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  if (!recipients.length) return [];
  // the recipients' business ORGANIZATIONS (registrable domains) — consumer mail never makes a shared-domain match
  const domains = [...new Set(recipients.filter((r) => !consumerMail(domainOf(r))).map(orgDomainOf).filter(Boolean))];
  const googleLocals = [...new Set(recipients.filter((r) => GOOGLE_HOSTS.includes(domainOf(r))).map((r) => r.slice(0, r.lastIndexOf('@'))))];
  const exact = new Map(recipients.map((r) => [r, []]));
  const shared = new Map(recipients.map((r) => [r, []]));
  const lookup = { recipients: new Set(recipients), googleLocals, domains, recipientsByDomain: groupByDomain(recipients) };
  const seen = (list, hit) => list.some((e) => e.source === hit.source && e.id === hit.id);
  for (const src of CONTACT_SOURCES) {
    const hits = await sourceHits(q, src, lookup);
    for (const [r, hit] of hits.exact) if (!seen(exact.get(r), hit)) exact.get(r).push(hit);
    // a shared-domain hit that is already an exact hit for the recipient is the same contact, not a second one
    for (const [r, hit] of hits.shared) if (!seen(exact.get(r), hit)) shared.get(r).push(hit);
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

// a send whose outcome the Sent-folder reconcile has not settled: claimed `sending`, or errored before it — Gmail may
// have delivered the pitch, so the inbox stays held and the authority it was claimed under stays pinned until then
const AMBIGUOUS_SEND_STATUSES = Object.freeze(['sending', 'send_error']);

module.exports = { AMBIGUOUS_SEND_STATUSES, REPLY_CHECK_FAILED, RECIPIENT_REVIEW_REQUIRED, OWNER_MARKERS, FOLLOW_UP_MAX_WORDS, draftReview, followUpReview, reviewDraft, classifyDraft, lintDraft, draftHash, followUpHash, draftOf, followUpDueAt, FOLLOW_UP_DELAY_DAYS, FOLLOW_UP_STATUSES, FOLLOW_UP_STATUSES_ANY, FOLLOW_UP_JUDGE_STATUSES, followUpRetirement, GATE_OFF_REASON, initialSendOwed, followUpOwed, followUpPending, recipientReview, recipientReviews, reviewByEmail, normalizeEmail, STORED_SQL, CLASSIFIER_RULES, CONTACT_SOURCES, SHARED_MAIL_DOMAINS, GOOGLE_HOSTS, LINT_CONTEXT };
