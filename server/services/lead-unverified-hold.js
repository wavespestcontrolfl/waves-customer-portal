/**
 * Hold for a website lead form that arrived with NO Turnstile token while
 * GATE_LEAD_TURNSTILE is enforcing (GATE_LEAD_UNVERIFIED_HOLD, default on).
 *
 * Why: the Astro forms wait a few seconds for Cloudflare's background check and
 * then post without a token when it has not finished (slow phone, in-app
 * browser, blocked challenge script). The webhook used to answer 403 before any
 * write, so a real visitor's request was lost with no record (2026-10-04: two
 * refusals ten seconds apart from the homepage quote form, nothing saved).
 *
 * What the hold does: ONE customer-less `leads` row, one lead activity, one
 * bell for the office. What it never does: create a customer, a draft estimate
 * or a lead-intake state, text or email the visitor, start the Lead Response
 * Agent, the auto-bridge call or the drip. Those are the paid / customer-facing
 * side effects the Turnstile gate exists to keep bots away from, so they stay
 * behind a verified token. A person decides what happens to a held lead.
 *
 * The submitted phone and email are NOT proven to belong to the submitter, so
 * they never land in leads.phone / leads.email: every reader that trusts a
 * lead's contact (ad audiences, the email spam-blocker's "known lead" bypass,
 * the outbound-call and collections consent probes, call/SMS lead matching)
 * keys on those columns. They are kept in extracted_data.unverified_contact
 * and quoted on the lead activity; the office types them onto the lead after
 * it has confirmed them with the person. first_contact_channel is
 * 'form_unverified', which no customer-originated-contact allowlist contains.
 *
 * Only `missing_token` is held. A token Cloudflare rejected, an oversized token
 * and a host with no widget are forged or spent credentials and keep the 403.
 */

const db = require('../models/db');
const logger = require('./logger');
const { zipToCity } = require('../utils/zip-to-city');
const { urgencyForTimeline } = require('./lead-timeline');
const { formatAddress } = require('../utils/address-normalizer');

const HOLD_STAGE = 'lead_webhook_unverified';
// Deliberately not one of the customer-originated channels the consent probes
// allowlist (collections/consent-provenance, outbound-call-reason).
const HOLD_CHANNEL = 'form_unverified';
// A retry of the same form (the visitor taps the button again) must not mint a
// second row or ring twice.
const HOLD_DEDUPE_HOURS = 24;
// The visitor's own words, kept for the office. Capped like other stored
// free text; whitespace collapsed so a pasted block reads as one line.
const MESSAGE_MAX = 1000;
function holdMessage(value) {
  // Cut by code point: a UTF-16 slice can split an emoji and leave a lone
  // surrogate, which jsonb rejects.
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, MESSAGE_MAX).join('').trim();
}
const HOLD_WHY = 'The website bot check did not finish, so no automatic reply went out.';

function holdPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  return digits.length === 10 ? `+1${digits}` : '';
}

async function ringHeldLead({ lead, name, serviceInterest }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    await raiseAdminAlert('lead', {
      area: 'Leads',
      action: fitAction('Leads', name, [
        (who) => `call ${who} about a web quote request`,
        (who) => `call ${who} about a web quote`,
        (who) => `call ${who}`,
      ]),
      why: HOLD_WHY,
      severity: 'needs-you',
      link: `/admin/leads?lead=${lead.id}`,
      subject: { type: 'lead', id: String(lead.id) },
      doneWhen: 'lead_contacted',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `lead-unverified-hold:${lead.id}`,
      detail: `Unverified website request${serviceInterest ? ` for ${serviceInterest}` : ''}. No customer profile, estimate, text or email was created. The submitted phone and email are on the lead's activity note; confirm them with the person, then add them to the lead.`,
      metadata: { leadId: lead.id, hold: HOLD_STAGE },
    });
  } catch (err) {
    logger.warn(`[lead-unverified-hold] bell failed for lead=${lead.id}: ${err.code || err.name || 'error'}`);
  }
}

/**
 * @param {object} args
 * @param {object} args.intake        buildLeadWebhookIntake(body)
 * @param {?string} args.leadSourceId resolved lead_sources id, or null
 * @param {string} args.reason        the Turnstile failure reason being held
 * @param {object} [args.commercialFields] is_commercial / is_residential from the route's commercial verdict
 * @returns {Promise<{held: boolean, leadId?: string, deduped?: boolean, reason?: string}>}
 *   held:false means the submission is not holdable and the caller keeps its 403.
 */
async function holdUnverifiedLead({ intake, leadSourceId = null, reason = 'missing_token', commercialFields = {} }) {
  const phone = holdPhone(intake.rawPhone);
  const firstName = String(intake.firstName || '').trim();
  // Same floor the verified path enforces before it writes: a reachable phone
  // and an address whose unit is not ambiguous.
  if (!phone) return { held: false, reason: 'not_reachable' };
  if (intake.normalizedAddress?.unitConflict) return { held: false, reason: 'unit_conflict' };

  const lastName = String(intake.lastName || '').trim();
  const address = intake.normalizedAddress || {};
  const message = holdMessage(intake.message);
  // The visitor's declared timeline sets urgency, as on the verified path.
  const declaredUrgency = urgencyForTimeline(intake.timeline);
  // Staff-visible lines the verified path puts on its Customer 360 note. No
  // admin lead UI renders extracted_data, so they ride on the activity note.
  const extraProperties = intake.additionalProperties || [];
  const noteLines = [
    intake.signHost ? `Saw our yard sign at: ${intake.signHost} (neighbor page; that home gets a $25 thank-you credit after a new customer's first service).` : '',
    extraProperties.length
      ? `Visitor also asked to cover: ${extraProperties.map((p) => formatAddress({ line1: p.address_line1, line2: p.address_line2, city: p.city, state: p.state, zip: p.zip })).join('; ')}.`
      : '',
  ].filter(Boolean);
  const stage = {
    stage: HOLD_STAGE,
    verification: { turnstile: reason },
    unverified_contact: { phone, email: intake.email || null },
    service_interest: intake.serviceInterest || null,
    ...(message ? { message } : {}),
    ...(intake.timeline ? { timeline: intake.timeline } : {}),
    attribution: {
      leadSource: intake.leadSource,
      formId: intake.formId,
      formName: intake.formName,
      pageUrl: intake.pageUrl,
      landingUrl: intake.landingUrl,
      utm: {
        source: intake.utmSource,
        medium: intake.utmMedium,
        campaign: intake.utmCampaign,
        content: intake.utmContent,
        term: intake.utmTerm,
      },
    },
    address,
    ...(intake.additionalProperties && intake.additionalProperties.length
      ? { additional_properties: intake.additionalProperties } : {}),
    ...(intake.signHost ? { sign_host: intake.signHost } : {}),
  };

  const result = await db.transaction(async (trx) => {
    // Serialize same-phone submissions so a double tap cannot insert twice.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lead-unverified-hold:${phone}`]);
    const since = new Date(Date.now() - HOLD_DEDUPE_HOURS * 60 * 60 * 1000);
    const prior = await trx('leads')
      .whereNull('deleted_at')
      .where('created_at', '>=', since)
      .whereRaw("extracted_data->>'stage' = ?", [HOLD_STAGE])
      .whereRaw("extracted_data->'unverified_contact'->>'phone' = ?", [phone])
      .first('id');
    if (prior) return { lead: prior, deduped: true };

    const [lead] = await trx('leads').insert({
      first_name: firstName,
      last_name: lastName,
      // Unverified contact stays out of the identity columns (see header).
      phone: null,
      email: null,
      address: intake.fullAddress || '',
      // Free-text addresses arrive with no city; recover it from the ZIP.
      city: address.city || zipToCity(address.zip) || '',
      lead_source_id: leadSourceId,
      lead_type: 'form_submission',
      service_interest: intake.serviceInterest || null,
      ...(declaredUrgency ? { urgency: declaredUrgency } : {}),
      extracted_data: JSON.stringify(stage),
      first_contact_at: new Date(),
      first_contact_channel: HOLD_CHANNEL,
      status: 'new',
      gclid: intake.gclid || null,
      wbraid: intake.wbraid || null,
      gbraid: intake.gbraid || null,
      fbclid: intake.fbclid || null,
      fbc: intake.fbc || null,
      fbp: intake.fbp || null,
      anon_id: intake.anonId || null,
      heard_about: intake.heardAbout || null,
      heard_about_prompt: intake.heardAboutPrompt || null,
      is_residential: true,
      ...commercialFields,
    }).returning('*');

    await trx('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'created',
      description: 'Unverified website request: the bot check did not finish. No automatic reply, customer profile or estimate was created.'
        + ` Submitted contact, not verified: phone ${phone}; email ${intake.email || 'none'}. Add them to the lead after you confirm them with the person.`
        + (noteLines.length ? ` ${noteLines.join(' ')}` : '')
        + (message ? ` Visitor wrote: "${message}"` : ''),
      performed_by: 'Lead webhook',
    });
    return { lead, deduped: false };
  });

  if (!result.deduped) {
    await ringHeldLead({
      lead: result.lead,
      name: [firstName, lastName].filter(Boolean).join(' ') || 'the visitor',
      serviceInterest: intake.serviceInterest || '',
    });
  }
  logger.info(`[lead-unverified-hold] held lead=${result.lead.id}${result.deduped ? ' (repeat within 24h, no new row)' : ''}`);
  return { held: true, leadId: result.lead.id, deduped: result.deduped };
}

module.exports = { holdUnverifiedLead, HOLD_STAGE, HOLD_CHANNEL };
