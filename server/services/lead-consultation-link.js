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
const { mintLeadConsultationToken, TTL_SECONDS } = require('../utils/lead-consultation-token');

function consultationSmsLineFor(url) {
  return url ? `Pick a time for us to stop by for a free consultation: ${url}\n\n` : '';
}

// The long URL for a lead id, independent of the short-url wrapper — the
// recurring-lead email PR renders this (or a shortened form of it) directly
// into the send-time template.
function consultationUrlForLead(leadId) {
  const token = mintLeadConsultationToken(leadId);
  if (!token) return null;
  return `${publicPortalUrl()}/inspection/${token}`;
}

async function buildLeadConsultationLink(leadOrId) {
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

    const longUrl = consultationUrlForLead(lead.id);
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
  const built = await buildLeadConsultationLink(leadOrId);
  if (!built.url) return built;
  const unavailable = (reason) => ({ url: null, line: '', reason });
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

module.exports = { buildLeadConsultationLink, buildLeadConsultationSmsLine, consultationUrlForLead, consultationSmsLineFor };
