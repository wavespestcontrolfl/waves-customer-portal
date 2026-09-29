/**
 * SMS portal-link wrap — every portal link in an outbound customer/lead text
 * becomes a tracked /l/<code> short link tied to the text it went out in.
 *
 * Why: click tracking (short_codes.click_count, short_code_clicks) only exists
 * for links a sender chose to shorten. A manual text typed with a full
 * https://portal.wavespestcontrol.com/prep/<token> link, or any sender that
 * builds a raw portal URL, went out untracked. sendCustomerMessage is the one
 * choke point for customer SMS, so the rewrite lives there, behind
 * GATE_SMS_LINK_WRAP (feature-gates.js smsLinkWrapLive, default OFF).
 *
 * Contract:
 *   - Customer/lead audiences on the SMS channel only; MMS bodies, internal
 *     briefings and every other audience are never touched (the caller passes
 *     the eligibility facts; this module re-checks them).
 *   - Recognition is composer-customer-links.js's ownedPortalLinkSpans — the
 *     same run/host judgement the bearer send fences use, not a second parser.
 *     Non-portal hosts and links that are already /l/ short links are left
 *     alone. So are reschedule and inspection links (EVIDENCE_LINKED_FAMILIES):
 *     their own senders mint the entity linkage delivery-evidence readers rely
 *     on, which a generic code would hide. Review-ask (/rate/) links likewise
 *     (their fence recognizes them by kind 'review').
 *   - review_request and missed_call_followup sends are skipped whole
 *     (BODY_RECONCILED_PURPOSES): they stamp their exact body before the send
 *     and later search the provider for it to reconcile a stranded send.
 *   - NEVER blocks a send. Any mint failure (or a recognition failure) keeps
 *     the original link and logs a warn. Bearer-token links (prep, pay,
 *     secure, ...) mint through createShortCode directly rather than the
 *     passthrough helpers, so a failure is an explicit branch here, not a
 *     swallowed one — but it degrades to the original link, exactly what the
 *     text carried before this seam existed.
 *   - The rewrite happens before countSegments, so the audit row and segment
 *     count describe what is actually sent. The replacement is scheme-stripped
 *     like every other SMS link (sms-link-policy.js).
 *   - Each code is stamped with the carrying message after an accepted
 *     send: message_ref = 'sms_log:<id>' (click-followup.js's 'table:id'
 *     convention), or 'twilio_sid:<sid>' if the sms_log row cannot be read.
 *   - Every attempt mints its own code (no reuse across attempts): a code is
 *     only ever attributed to the one text that carried it. An attempt that is
 *     blocked, held or uncertain leaves its code unstamped — an inert
 *     redirect to the customer's own page that no one was sent. Codes are
 *     never deleted, so a body already handed to a provider or reservation
 *     never points at a vanished link. A retry is a new attempt with a new
 *     code; every reservation/audit in that attempt is built from the body it
 *     actually sends.
 *   - Log lines carry the link family and an error code/name only — never a
 *     URL, token or raw error message (Knex embeds SQL bindings, target_url
 *     included, in err.message).
 */

const logger = require('../logger');
const { stripSmsUrlScheme } = require('./sms-link-policy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wrapGateLive() {
  const gates = require('../../config/feature-gates');
  return typeof gates.smsLinkWrapLive === 'function' && gates.smsLinkWrapLive();
}

// Customer/lead SMS with no (authorized) media. `hasMedia` is the caller's own
// mediaUrlsAllowed-based verdict, so an unauthorized-media send the provider
// downgrades to plain SMS is still wrapped.
function eligible({ body, channel, audience, hasMedia }) {
  return channel === 'sms'
    && typeof body === 'string'
    && ['customer', 'lead'].includes(audience)
    && !hasMedia;
}

// Links whose own senders mint the code with entity linkage that later
// delivery-evidence readers depend on: reschedule-link-promises.js matches a
// sent reschedule link by kind 'reschedule' + scheduled_services/<visit id>
// (or the raw URL in the body), and call-booking-link-text.js matches a sent
// consultation link by kind 'consultation' + leads/<lead id> (or the raw
// /inspection/ URL). A generic wrapper code carries neither, so wrapping a
// raw one would hide a delivered link from those dedupe checks and let
// automation send it again. They stay as typed; their own senders track them.
const EVIDENCE_LINKED_FAMILIES = new Set(['reschedule', 'inspection']);

// Review-ask links: admin-communications.js's scheduledSmsLinkRefusal
// recognizes a shortened review link only by kind 'review', so a generic code
// would hide one from the immediate-only review claim/cooldown fence.
const REVIEW_LINK_RE = /^https:\/\/[^/]+(?:\/api)?\/rate\//i;

// Purposes whose senders stamp the exact body BEFORE the send and later ask
// the provider whether that text arrived (TwilioService.findOutboundMessageSince
// by body fragment: missed-call-text-back.js reconcileStaleClaim,
// review-request.js's ask-token search). Rewriting the body in between would
// make a stranded, accepted send read as absent and release its one-shot
// claim. These flows keep the body they stamped.
const BODY_RECONCILED_PURPOSES = new Set(['review_request', 'missed_call_followup']);

function familyLabel(family) {
  const clean = String(family || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return clean || 'other';
}

// A log-safe error label: never err.message (a Knex error embeds the bound
// target_url — a bearer link — in its message).
function errLabel(err) {
  return String((err && (err.code || err.name)) || 'error').slice(0, 40);
}

/**
 * Rewrite eligible portal links in `body`. Returns { body, codes } — `codes`
 * are the short codes minted for THIS body, to stamp after an accepted send.
 * With the gate off, an ineligible send or no portal link, returns the body
 * untouched and codes [].
 */
async function wrapPortalLinks({ body, channel, audience, purpose = null, hasMedia = false, customerId = null, leadId = null }) {
  const unchanged = { body, codes: [] };
  if (!eligible({ body, channel, audience, hasMedia }) || BODY_RECONCILED_PURPOSES.has(purpose) || !wrapGateLive()) return unchanged;

  let spans;
  try {
    spans = require('../composer-customer-links').ownedPortalLinkSpans(body);
  } catch (err) {
    logger.warn(`[sms-link-wrap] link recognition failed, body unchanged: ${errLabel(err)}`);
    return unchanged;
  }
  spans = spans.filter((span) => !EVIDENCE_LINKED_FAMILIES.has(String(span.family)) && !REVIEW_LINK_RE.test(span.url));
  if (!spans.length) return unchanged;

  const { createShortCode } = require('../short-url');
  const customer = UUID_RE.test(String(customerId || '')) ? customerId : null;
  const lead = audience === 'lead' && UUID_RE.test(String(leadId || '')) ? leadId : null;
  const codes = [];
  const minted = new Map(); // one code per distinct target within a body
  const replacements = [];
  for (const span of spans) {
    let entry = minted.get(span.url);
    if (!entry) {
      try {
        const { code, shortUrl } = await createShortCode(span.url, {
          kind: 'other',
          entityType: `portal:${familyLabel(span.family)}`,
          customerId: customer,
          leadId: lead,
          channel: 'sms',
          purpose: 'sms_link_wrap',
        });
        entry = { shortUrl: stripSmsUrlScheme(shortUrl) };
        minted.set(span.url, entry);
        codes.push(code);
      } catch (err) {
        // Keep the link the text already carried; the send goes out untracked.
        logger.warn(`[sms-link-wrap] shorten failed for a ${familyLabel(span.family)} link, original kept: ${errLabel(err)}`);
        minted.set(span.url, (entry = { shortUrl: null }));
      }
    }
    if (entry.shortUrl) replacements.push({ start: span.start, end: span.end, text: entry.shortUrl });
  }
  if (!replacements.length) return unchanged;

  let out = body;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`;
  }
  return { body: out, codes };
}

/**
 * After an accepted send: stamp every code with the carrying message. Any
 * other outcome leaves the codes unstamped (inert; a retry mints its own).
 * Best-effort and self-contained — never throws, callers do not await it on
 * the send path.
 */
async function settleWrappedLinks(codes, outcome = {}) {
  if (!Array.isArray(codes) || !codes.length) return;
  const accepted = outcome.sent === true && outcome.deliveryOutcome === 'accepted'
    && outcome.deduped !== true && !!outcome.providerMessageId;
  if (!accepted) return;
  try {
    const db = require('../../models/db');
    let ref = `twilio_sid:${outcome.providerMessageId}`;
    try {
      const row = await db('sms_log').where({ twilio_sid: outcome.providerMessageId }).first('id');
      if (row && row.id) ref = `sms_log:${row.id}`;
    } catch (err) {
      logger.warn(`[sms-link-wrap] sms_log lookup failed, stamping the provider id: ${errLabel(err)}`);
    }
    await db('short_codes').whereIn('code', codes).whereNull('message_ref')
      .update({ message_ref: ref.slice(0, 60), updated_at: new Date() });
  } catch (err) {
    logger.warn(`[sms-link-wrap] message_ref stamp failed: ${errLabel(err)}`);
  }
}

module.exports = { wrapPortalLinks, settleWrappedLinks, _internals: { eligible, familyLabel } };
