/**
 * Consultation-booking block for the new_lead automation email
 * (lead-inspection-link-scope.md §2 "PR 3 / Email block", off-repo — the
 * design is restated in the PR brief; dark behind GATE_LEAD_INSPECTION_LINK).
 *
 * `{{consultation_booking}}` / `{{consultation_booking_text}}` in the
 * new_lead step's html_body/text_body (see migration
 * 20260924020000_new_lead_consultation_booking_placeholder.js) are replaced
 * by automation-runner.js's renderAutomationStepContent with this module's
 * output — '' on either side whenever the block is hidden, so an
 * unaffected send renders byte-identical to today.
 *
 * Shown ONLY to a lead who wants a recurring plan (leadWantsRecurringPlan) —
 * everyone else (one-time, unknown, blank) gets the email exactly as today.
 * Renders empty on ANY of: gate off, no lead id, lead not found/open, lead
 * phone not a US number, no bookable slots, or any error — fail closed,
 * never lets a block failure fail the email send.
 *
 * Sender voice is "Waves" (never a person's name — owner ruling: Adam is
 * not the only tech). Links are minted with channel 'email' (never 'sms' —
 * that channel is a phone-delivery proof and must never be claimed for an
 * email send); verifyLeadConsultationToken accepts any channel string
 * generically, so an 'email'-channeled token verifies normally without
 * being treated as phone-verification evidence.
 */

const db = require('../models/db');
const logger = require('./logger');
const { leadInspectionLinkLive } = require('../config/feature-gates');
const { isOpenLeadRow } = require('./lead-statuses');
const { isUsPhone } = require('./lead-consultation-link');
const { leadWantsRecurringPlan } = require('./lead-recurring-intent');
const { mintLeadConsultationToken } = require('../utils/lead-consultation-token');
const { publicPortalUrl } = require('../utils/portal-url');
const { ctaButton, blockPalette } = require('./email-template');

const EMPTY_BLOCK = { html: '', text: '' };
const HEADING = 'Pick a time for us to stop by';
const SENTENCE = "A free consultation — we'll look at the property, answer questions, and price it on the spot. No commitment.";
const SEE_ALL_LABEL = 'See all open times';

function slotUrl(baseUrl, slot) {
  return `${baseUrl}?slot=${encodeURIComponent(`${slot.date}|${slot.start_time}`)}`;
}

function slotLabel(slot) {
  return `${slot.dayOfWeek}, ${slot.month} ${slot.dayNum} · ${slot.start_label}`;
}

function renderHtml(baseUrl, slots) {
  const P = blockPalette();
  const buttons = slots.map((slot) => ctaButton(slotUrl(baseUrl, slot), slotLabel(slot))).join('<div style="height:10px;"></div>');
  return `
<h2 style="color:${P.heading};font-family:${P.font};">${HEADING}</h2>
<p style="color:${P.text};font-family:${P.font};">${SENTENCE}</p>
${buttons ? `<div style="margin:16px 0;">${buttons}</div>` : ''}
<p style="color:${P.text};font-family:${P.font};margin-top:${buttons ? '4px' : '16px'};"><a href="${baseUrl}" style="color:${P.footerLink};">${SEE_ALL_LABEL}</a></p>`;
}

function renderText(baseUrl) {
  return `Pick a time for us to stop by for a free consultation: ${baseUrl}`;
}

// The lead row this block needs, or null when it isn't eligible for the
// block at all (gate handled by the caller — this only checks the lead
// itself). Kept separate from slot computation so an ineligible lead never
// spends a DB round-trip on availability.
async function eligibleLead(leadId) {
  const lead = await db('leads').where({ id: leadId }).whereNull('deleted_at')
    .first('id', 'phone', 'service_interest', 'status', 'converted_at');
  if (!lead) return null;
  if (!isOpenLeadRow(lead)) return null;
  if (!isUsPhone(lead.phone)) return null;
  if (!leadWantsRecurringPlan(lead)) return null;
  return lead;
}

async function buildConsultationEmailBlock({ leadId } = {}) {
  if (!leadInspectionLinkLive() || !leadId) return EMPTY_BLOCK;
  try {
    const lead = await eligibleLead(leadId);
    if (!lead) return EMPTY_BLOCK;

    // Reused verbatim from the /inspection/:token page's own availability
    // engine (server/routes/inspection-public.js `_internals`) so the email
    // can never offer a slot the page would refuse.
    const { computeConsultationSlotsForLead } = require('../routes/inspection-public')._internals;
    const result = await computeConsultationSlotsForLead(lead.id, { count: 3 });
    if (!result.ok) return EMPTY_BLOCK;
    if (!result.needsAddress && result.slots.length === 0) return EMPTY_BLOCK;

    const token = mintLeadConsultationToken(lead.id, undefined, 'email');
    if (!token) return EMPTY_BLOCK;
    const baseUrl = `${publicPortalUrl()}/inspection/${token}`;

    return {
      html: renderHtml(baseUrl, result.needsAddress ? [] : result.slots),
      text: renderText(baseUrl),
    };
  } catch (err) {
    logger.warn(`[lead-consultation-email-block] build failed for lead ${leadId}: ${err.message}`);
    return EMPTY_BLOCK;
  }
}

module.exports = { buildConsultationEmailBlock };
