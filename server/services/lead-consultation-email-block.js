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
const { leadLinkRefusal } = require('./lead-consultation-link');
const { leadWantsRecurringPlan } = require('./lead-recurring-intent');
const { mintLeadConsultationToken, TTL_SECONDS } = require('../utils/lead-consultation-token');
const { publicPortalUrl } = require('../utils/portal-url');
const { createShortCode } = require('./short-url');
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

// FAIL CLOSED (GH Codex #4702 r1 P1, same rule as lead-consultation-link.js):
// the long URL carries the bearer token, so it must never ride an email
// raw. Every link — see-all and each slot — goes through the short_codes
// chokepoint (kind 'consultation', 14-day expiry matching the token). The
// /l/:code redirect does not forward a query string, so each ?slot= link
// needs its own code. createShortCode throws on insert failure and the
// caller's catch turns that into the empty block, never the credential.
async function shortWrap(longUrl, leadId, expiresAt) {
  const { shortUrl } = await createShortCode(longUrl, {
    kind: 'consultation',
    entityType: 'leads',
    entityId: leadId,
    leadId,
    expiresAt,
  });
  if (!shortUrl || shortUrl === longUrl) throw new Error('short-wrap failed');
  return shortUrl;
}

async function shortLinksFor(longBase, leadId, slots) {
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
  const seeAllUrl = await shortWrap(longBase, leadId, expiresAt);
  const wrapped = [];
  for (const slot of slots) {
    wrapped.push({ ...slot, url: await shortWrap(slotUrl(longBase, slot), leadId, expiresAt) });
  }
  return { seeAllUrl, slots: wrapped };
}

function renderHtml(baseUrl, slots) {
  const P = blockPalette();
  const buttons = slots.map((slot) => ctaButton(slot.url, slotLabel(slot))).join('<div style="height:10px;"></div>');
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
// block at all (gate handled by the caller). Refusal is the SAME rule set
// the text link's mint/probe/send share — leadLinkRefusal in
// lead-consultation-link.js (open lead, US phone, linked customer live and
// still on the lead's phone by full phone identity) — so the email never
// mints a bearer the text path would refuse (pre-push audit P1). Recurring
// intent is the email-only narrowing on top. Kept separate from slot
// computation so an ineligible lead never spends a round-trip on
// availability.
async function eligibleLead(leadId) {
  const lead = await db('leads').where({ id: leadId }).whereNull('deleted_at')
    .first('id', 'phone', 'service_interest', 'status', 'converted_at', 'customer_id');
  if (!lead) return null;
  if (await leadLinkRefusal(lead)) return null;
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
    const longBase = `${publicPortalUrl()}/inspection/${token}`;
    const links = await shortLinksFor(longBase, lead.id, result.needsAddress ? [] : result.slots);

    return {
      html: renderHtml(links.seeAllUrl, links.slots),
      text: renderText(links.seeAllUrl),
    };
  } catch (err) {
    logger.warn(`[lead-consultation-email-block] build failed for lead ${leadId}: ${err.message}`);
    return EMPTY_BLOCK;
  }
}

module.exports = { buildConsultationEmailBlock };
