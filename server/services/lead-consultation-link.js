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
 * no phone, or no token can be minted (no secret configured). `line` is a
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

async function buildLeadConsultationLink(leadOrId, { channel } = {}) {
  try {
    if (!leadInspectionLinkLive()) {
      return { url: null, line: '', reason: 'Consultation links are switched off (GATE_LEAD_INSPECTION_LINK)' };
    }
    const leadId = typeof leadOrId === 'string' ? leadOrId : leadOrId?.id;
    if (!leadId) return { url: null, line: '', reason: 'No lead to build a consultation link for' };

    // Always re-resolve from the DB (never trust a caller-supplied object's
    // phone/deleted_at) so a stale in-memory lead can't mint a link for a
    // since-deleted or since-edited row.
    const lead = await db('leads').where({ id: leadId }).whereNull('deleted_at').first('id', 'phone');
    if (!lead) return { url: null, line: '', reason: 'Lead not found' };
    if (!lead.phone) return { url: null, line: '', reason: 'Lead has no phone number' };

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
    return { url: shortUrl, line: consultationSmsLineFor(shortUrl) };
  } catch (err) {
    logger.warn(`[lead-consultation-link] build failed: ${err.message}`);
    return { url: null, line: '', reason: 'Could not build a consultation link' };
  }
}

module.exports = { buildLeadConsultationLink, consultationUrlForLead, consultationSmsLineFor };
