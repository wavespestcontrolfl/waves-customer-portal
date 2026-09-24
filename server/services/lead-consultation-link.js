/**
 * Lead consultation-booking deep link — "Pick a time for us to stop by for
 * a free consultation" (scope doc lead-inspection-link-scope.md §4). Long
 * URL: {portal}/inspection/{mintLeadConsultationToken(lead.id)}, short-wrapped
 * through the branded short-url service (kind 'consultation') the same way
 * reservice-link and the other composer builders are.
 *
 * Contract mirrors composer-customer-links.js / reservice-link.js:
 * buildLeadConsultationLink returns { url, line, reason } — url null + a
 * `reason` sentence when the gate is off, the lead is missing/deleted, has
 * already converted or closed (isOpenLeadRow, lead-statuses.js — the
 * chokepoint every caller inherits, pre-push Codex P1), has no phone, or
 * no token can be minted (no secret configured). `line` is a
 * self-contained plain-ASCII SMS clause ending in '\n\n'.
 *
 * The /inspection/:token page itself (route trio + ScheduleFlowPage flow) is
 * a later PR in this lane — this builder only mints the link. Best-effort:
 * never throws; callers treat { url: null, reason } as "no link to insert".
 */

const db = require('../models/db');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');
const { createShortCode } = require('./short-url');
const { leadInspectionLinkLive } = require('../config/feature-gates');
const { mintLeadConsultationToken, smsChannelFor, TTL_SECONDS } = require('../utils/lead-consultation-token');
// The chokepoint (pre-push Codex P1): every caller of this module —
// composer-customer-links.js's buildConsultationLink, admin-communications.js's
// resolveConsultationLeadOnly, and admin-leads.js's GET
// /:id/consultation-link — resolves a lead id from a different angle
// (customer-owned, phone-only, or a UI row) and had its own copy of the
// eligibility gap before this. Enforcing isOpenLeadRow HERE, on the lead
// buildLeadConsultationLink itself re-resolves, means every caller inherits
// the rule regardless of how it got the id; a caller's own predicate
// (applyOpenLeadPredicate on a picking query, or its own isOpenLeadRow
// early-check) stays purely an efficiency/messaging early filter, never
// the only enforcement.
const { isOpenLeadRow } = require('./lead-statuses');

function consultationSmsLineFor(url) {
  return url ? `Pick a time for us to stop by for a free consultation: ${url}\n\n` : '';
}

// The long URL for a lead id, independent of the short-url wrapper — the
// recurring-lead email PR renders this (or a shortened form of it) directly
// into the send-time template. `channel` (round 11, Codex pre-push P1,
// 2026-09-24) is an OPTIONAL delivery-channel claim minted into the token
// itself (server/utils/lead-consultation-token.js) — omitted here (the
// default), a link is UNVERIFIED delivery; an SMS send passes `'sms'` to
// buildLeadConsultationLink, which signs it as smsChannelFor(lead.phone) so
// inspection-public.js's leadContactVerified can trust that this exact link
// reached the lead's CURRENT phone. Never set it for an email send —
// only an SMS send is evidence the phone itself received the link.
function consultationUrlForLead(leadId, channel) {
  const token = mintLeadConsultationToken(leadId, undefined, channel);
  if (!token) return null;
  return `${publicPortalUrl()}/inspection/${token}`;
}

// A US destination for the consultation bearer rule: 10 digits, or 11
// starting with 1 — any other explicit +country code is not. Shared with
// admin-leads.js's send route so mint, probe and send agree.
function isUsPhone(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length === 11 && digits.startsWith('1');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

// Why a lead cannot get a consultation link, or null — the ONE rule set the
// builder and the availability probe share, mirroring the send check
// (Codex #4709 r17 + r18 P2s): open lead, a US phone, and a linked customer
// (if any) that is live and still on the lead's phone. Nothing is minted
// that the send would refuse.
async function leadLinkRefusal(lead) {
  if (!lead) return 'Lead not found';
  if (!isOpenLeadRow(lead)) return 'That lead has already converted or closed';
  if (!lead.phone) return 'Lead has no phone number';
  if (!isUsPhone(lead.phone)) return 'Consultation links go to US numbers only';
  if (!lead.customer_id) return null;
  const owner = await db('customers').where({ id: lead.customer_id }).whereNull('deleted_at').first('phone');
  if (!owner) return "This lead's customer record is archived — update the lead first";
  // Full phone identity, never a last-10 suffix (Codex #4709 r19 P1): an
  // international number sharing a US number's last ten digits is not it.
  const { phoneIdentityKey } = require('../utils/phone');
  if (!phoneIdentityKey(owner.phone) || phoneIdentityKey(owner.phone) !== phoneIdentityKey(lead.phone)) {
    return "This lead's customer has a different phone on file now — update the lead first";
  }
  return null;
}

async function buildLeadConsultationLink(leadOrId, { channel } = {}) {
  try {
    if (!leadInspectionLinkLive()) {
      return { url: null, line: '', reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)' };
    }
    const leadId = typeof leadOrId === 'string' ? leadOrId : leadOrId?.id;
    if (!leadId) return { url: null, line: '', reason: 'No lead to build a consultation link for' };

    // Always re-resolve from the DB (never trust a caller-supplied object's
    // phone/deleted_at) so a stale in-memory lead can't mint a link for a
    // since-deleted or since-edited row. status/converted_at ride along for
    // the isOpenLeadRow check below — the CHOKEPOINT for every caller
    // (pre-push Codex P1): a won/lost/closed lead must never mint a
    // free-consultation invitation, however its id reached this function.
    const lead = await db('leads').where({ id: leadId }).whereNull('deleted_at').first('id', 'phone', 'status', 'converted_at', 'customer_id');
    const refusal = await leadLinkRefusal(lead);
    if (refusal) return { url: null, line: '', reason: refusal };

    // 'sms' is signed as the phone-bound claim (smsChannelFor of this fresh
    // row's phone) — the only form inspection-public.js's
    // leadContactVerified accepts (Codex #4737 r1 P1 follow-through).
    const signedChannel = channel === 'sms' ? smsChannelFor(lead.phone) : channel;
    if (channel === 'sms' && !signedChannel) {
      return { url: null, line: '', reason: 'Lead phone is not a valid 10-digit number' };
    }
    const longUrl = consultationUrlForLead(lead.id, signedChannel);
    if (!longUrl) return { url: null, line: '', reason: 'Could not build a consultation link (no signing secret configured)' };

    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
    // FAIL CLOSED (GH Codex #4702 r1 P1): the long URL carries the bearer
    // token, so it must never ride an SMS or email raw. createShortCode
    // throws when the short_codes insert fails; the catch below turns that
    // into the no-link result instead of passing the credential through.
    const { shortUrl } = await createShortCode(longUrl, {
      kind: 'consultation',
      entityType: 'leads',
      entityId: lead.id,
      leadId: lead.id,
      // Matches the 14-day token TTL — a short code outliving its token
      // would just redirect to a long URL the page rejects as expired.
      expiresAt,
    });
    // expiresAt (the 14-day token TTL) + immediateOnly ride to the composer
    // the same way the other expiring bearer links do (pre-push Codex P1):
    // the server-side scheduled-link fence (composer-customer-links.js
    // immediateOnlyLinkSendCheck) refuses to schedule this kind past the
    // window a queued send could deliver an already-expired token in.
    return { url: shortUrl, line: consultationSmsLineFor(shortUrl), expiresAt, immediateOnly: true };
  } catch (err) {
    logger.warn(`[lead-consultation-link] build failed: ${err.message}`);
    return { url: null, line: '', reason: 'Could not build a consultation link' };
  }
}

// The admin-editable SMS template Virginia's send actually uses (PR "Piece
// 2, Virginia's link" — lead-inspection-link-scope.md §4).
const CONSULTATION_SMS_TEMPLATE_KEY = 'lead_consultation_link';

/**
 * Availability probe for the Leads-page row expand (GET
 * /:id/consultation-link) — reports whether a consultation link COULD be
 * minted, without minting one. createShortCode is a real DB insert that
 * hands out a live 14-day bearer token; simply expanding a lead row to
 * look at it must not spend one (pre-push Codex P2) — the mint only
 * happens from the Send consultation link click (POST
 * /:id/consultation-link, buildLeadConsultationSmsLine below).
 *
 * Checks the same four things buildLeadConsultationLink /
 * buildLeadConsultationSmsLine gate a real mint on — gate live, the lead
 * exists/is still open/has a phone, the template is active — but never
 * calls createShortCode. consultationUrlForLead (token mint) IS safe to
 * call here: it is pure HMAC computation with no DB write, unlike the
 * short_codes insert that follows it in the real builder.
 */
// `enabled` tells the Leads page whether to render the control at all
// (Codex #4709 r3 P1): false only when the gate is dark, so staff never see
// a consultation button while the feature is off.
async function consultationLinkAvailable(leadOrId) {
  if (!leadInspectionLinkLive()) {
    return { enabled: false, available: false, reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)' };
  }
  return { enabled: true, ...(await probeLeadConsultationLink(leadOrId)) };
}

async function probeLeadConsultationLink(leadOrId) {
  const leadId = typeof leadOrId === 'string' ? leadOrId : leadOrId?.id;
  if (!leadId) return { available: false, reason: 'No lead to build a consultation link for' };
  const lead = await db('leads').where({ id: leadId }).whereNull('deleted_at').first('id', 'phone', 'status', 'converted_at', 'customer_id');
  const refusal = await leadLinkRefusal(lead);
  if (refusal) return { available: false, reason: refusal };
  if (!consultationUrlForLead(lead.id)) {
    return { available: false, reason: 'Could not build a consultation link (no signing secret configured)' };
  }
  try {
    const row = await db('sms_templates').where({ template_key: CONSULTATION_SMS_TEMPLATE_KEY }).first('is_active');
    if (row && row.is_active === false) {
      return { available: false, reason: 'template disabled' };
    }
  } catch (err) {
    logger.warn(`[lead-consultation-link] availability check failed: ${err.message}`);
    return { available: false, reason: 'Could not check consultation link availability' };
  }
  return { available: true };
}

/**
 * Same contract as buildLeadConsultationLink — { url, line, reason } — but
 * `line` is the full lead_consultation_link SMS template body (greeting +
 * "Reply STOP to opt out." disclosure already included) rendered with
 * {first_name, consultation_url}, collapsed to one line and flagged
 * `standalone: true` so a caller inserting it into a composer (rather than
 * sending it directly) knows to use it as-is instead of wrapping it in a
 * generic greeting — same reason and shape as Auto Pay's rendered setup
 * text (composer-customer-links.js buildAutopaySetupLink).
 *
 * firstName: the lead's first name for the {first_name} placeholder — the
 * caller supplies it (this module's own DB reads intentionally select only
 * id/phone for buildLeadConsultationLink's stale-object-mistrust rule
 * above).
 *
 * NO fallback to a hardcoded/bare clause on ANY template failure — an
 * admin-DISABLED template (is_active: false, checked BEFORE getTemplate,
 * same pre-check composer-customer-links.js's autopaySmsLever uses), a
 * MISSING template row, a body that lost its required {consultation_url}
 * placeholder, or a render that throws all return the same shape a
 * missing lead does: { url: null, line: '', reason }. This is the SAME
 * class of bug as the disabled-template case (pre-push Codex P1 x2): the
 * old bare buildLeadConsultationLink clause has no "Reply STOP to opt
 * out." footer, so falling back to it for ANY template defect — not just
 * a deliberate disable — was a keep-list violation on a first-contact
 * lead text. The admin-editable template plus the keep-list is the ONLY
 * source of this copy; there is no second, hardcoded stand-in for it.
 * Both callers (buildConsultationLink's composer path and the Leads-page
 * GET /:id/consultation-link route) already treat `url: null` as "nothing
 * to insert" and surface `reason` — no caller change needed.
 */
async function buildLeadConsultationSmsLine(leadOrId, firstName) {
  const unavailable = (reason) => ({ url: null, line: '', reason });
  // Nothing is minted until everything that could still refuse has passed
  // (Codex #4709 r9 P2): first the cheap availability probe (gate, open
  // lead, phone, signing secret, template switched on — no render), then a
  // dry render of the template with a placeholder URL, then the mint and
  // the real render below. A disabled, missing or STOP-less template never
  // leaves a live, unused 14-day short code behind.
  const availability = await consultationLinkAvailable(leadOrId);
  if (!availability.available) return unavailable(availability.reason);
  try {
    const row = await db('sms_templates').where({ template_key: CONSULTATION_SMS_TEMPLATE_KEY }).first('is_active');
    if (!row || row.is_active === false) return unavailable('template disabled');
    const templates = require('../routes/admin-sms-templates');
    const dry = await templates.getTemplate(CONSULTATION_SMS_TEMPLATE_KEY, {
      first_name: firstName || 'there',
      consultation_url: 'https://wavespest.co/l/preview',
    }, {}, { requiredVars: ['consultation_url'] });
    if (!dry) return unavailable('Consultation text template is unavailable');
    if (!templates.hasStopLine(dry)) {
      return unavailable('Consultation text is missing the required "Reply STOP to opt out." disclosure');
    }
  } catch (err) {
    logger.warn(`[lead-consultation-link] template pre-check failed: ${err.message}`);
    return unavailable('Consultation text template is unavailable');
  }
  const built = await buildLeadConsultationLink(leadOrId);
  if (!built.url) return built;
  try {
    const row = await db('sms_templates').where({ template_key: CONSULTATION_SMS_TEMPLATE_KEY }).first('is_active');
    if (row && row.is_active === false) {
      return unavailable('template disabled');
    }
    const templates = require('../routes/admin-sms-templates');
    const body = await templates.getTemplate(CONSULTATION_SMS_TEMPLATE_KEY, {
      first_name: firstName || 'there',
      consultation_url: built.url,
    }, {}, { requiredVars: ['consultation_url'] });
    if (!body) {
      // getTemplate itself already audited WHY (missing table/row, a body
      // that lost {consultation_url}, or unresolved placeholders) — this
      // is the composer-facing reason, not a duplicate of that audit.
      return unavailable('Consultation text template is unavailable');
    }
    // Render-time re-check of the keep-list disclosure (pre-push Codex
    // P1): save-time validation (admin-sms-templates.js) already refuses
    // an edit that drops it, but a row written before that check existed,
    // or edited directly, must not silently render without it — the SAME
    // hasStopLine function both points use, so they can never disagree.
    if (!templates.hasStopLine(body)) {
      return unavailable('Consultation text is missing the required "Reply STOP to opt out." disclosure');
    }
    return {
      url: built.url,
      line: `${String(body).replace(/\s*\n+\s*/g, ' ').trim()}\n\n`,
      standalone: true,
      expiresAt: built.expiresAt || null,
      immediateOnly: built.immediateOnly,
    };
  } catch (err) {
    logger.warn(`[lead-consultation-link] template render failed: ${err.message}`);
    return unavailable('Could not render the consultation text template');
  }
}

module.exports = {
  isUsPhone,
  buildLeadConsultationLink, buildLeadConsultationSmsLine, consultationUrlForLead, consultationSmsLineFor, consultationLinkAvailable };
