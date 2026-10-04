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
 * Only `missing_token` is held. A token Cloudflare rejected, an oversized token
 * and a host with no widget are forged or spent credentials and keep the 403.
 */

const db = require('../models/db');
const logger = require('./logger');
const { zipToCity } = require('../utils/zip-to-city');

const HOLD_STAGE = 'lead_webhook_unverified';
// A retry of the same form (the visitor taps the button again) must not mint a
// second row or ring twice.
const HOLD_DEDUPE_HOURS = 24;
// The visitor's own words, kept for the office. Capped like other stored
// free text; whitespace collapsed so a pasted block reads as one line.
const MESSAGE_MAX = 1000;
function holdMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);
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
      detail: `Unverified website request${serviceInterest ? ` for ${serviceInterest}` : ''}. No customer profile, estimate, text or email was created. Confirm the request with the person before quoting.`,
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
 * @returns {Promise<{held: boolean, leadId?: string, deduped?: boolean, reason?: string}>}
 *   held:false means the submission is not holdable and the caller keeps its 403.
 */
async function holdUnverifiedLead({ intake, leadSourceId = null, reason = 'missing_token' }) {
  const phone = holdPhone(intake.rawPhone);
  const firstName = String(intake.firstName || '').trim();
  // Same floor the verified path enforces before it writes: a reachable phone
  // and an address whose unit is not ambiguous.
  if (!phone) return { held: false, reason: 'not_reachable' };
  if (intake.normalizedAddress?.unitConflict) return { held: false, reason: 'unit_conflict' };

  const lastName = String(intake.lastName || '').trim();
  const address = intake.normalizedAddress || {};
  const message = holdMessage(intake.message);
  const stage = {
    stage: HOLD_STAGE,
    verification: { turnstile: reason },
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
      .where({ phone })
      .whereNull('deleted_at')
      .where('created_at', '>=', since)
      .whereRaw("extracted_data->>'stage' = ?", [HOLD_STAGE])
      .first('id');
    if (prior) return { lead: prior, deduped: true };

    const [lead] = await trx('leads').insert({
      first_name: firstName,
      last_name: lastName,
      phone,
      email: intake.email || null,
      address: intake.fullAddress || '',
      // Free-text addresses arrive with no city; recover it from the ZIP.
      city: address.city || zipToCity(address.zip) || '',
      lead_source_id: leadSourceId,
      lead_type: 'form_submission',
      service_interest: intake.serviceInterest || null,
      extracted_data: JSON.stringify(stage),
      first_contact_at: new Date(),
      first_contact_channel: 'form',
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
    }).returning('*');

    await trx('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'created',
      description: 'Unverified website request: the bot check did not finish. No automatic reply, customer profile or estimate was created.'
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

module.exports = { holdUnverifiedLead, HOLD_STAGE };
