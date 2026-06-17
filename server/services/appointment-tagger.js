const db = require('../models/db');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const logger = require('./logger');
const MODELS = require('../config/models');
const { lookupPropertyFromAITrio } = require('./property-lookup/ai-property-lookup');
const { sendNewRecurringWelcome } = require('./new-recurring-welcome-sms');
const { renderSmsTemplate } = require('./sms-template-renderer');

class AppointmentTagger {

  async onServiceScheduled(scheduledServiceId) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', scheduledServiceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.email', 'customers.address_line1',
        'customers.city', 'customers.zip', 'customers.waveguard_tier',
        'customers.nearest_location_id')
      .first();

    if (!service) return;

    const type = this.classifyAppointmentType(service.service_type);
    await db('scheduled_services').where({ id: scheduledServiceId }).update({ appointment_type: type.tag });

    try {
      switch (type.tag) {
        case 'wdo_inspection': await this.triggerWDOPrep(service); break;
        case 'german_roach': case 'cockroach': await this.triggerPestPrep(service, 'cockroach'); break;
        case 'bed_bug': await this.triggerPestPrep(service, 'bed_bug'); break;
      }
    } catch (err) {
      logger.error('[appointment-tagger] Appointment automation failed', {
        appointmentType: type.tag,
        serviceId: scheduledServiceId,
        errorName: err?.name || 'Error',
      });
    }

    // Welcome text on the customer's first RECURRING service. All WaveGuard
    // tiers are included (Bronze too) so the experience matches the
    // estimate-converter self-accept path; the is_recurring guard keeps the
    // auto_new_recurring text off one-time/standalone first appointments
    // (onServiceScheduled runs for those jobs as well). Idempotent via
    // sendNewRecurringWelcome.
    if (service.waveguard_tier && service.is_recurring) {
      const prevCount = await db('service_records').where({ customer_id: service.customer_id }).count('* as count').first();
      if (parseInt(prevCount?.count || 0) === 0) {
        await this.triggerWelcomeSequence(service);
      }
    }
  }

  classifyAppointmentType(serviceType) {
    const s = (serviceType || '').toLowerCase();
    if (s.includes('wdo') || s.includes('wood destroying') || s.includes('termite inspection') || s.includes('real estate inspection')) return { tag: 'wdo_inspection', label: 'WDO Inspection' };
    if (s.includes('german') || (s.includes('roach') && s.includes('interior'))) return { tag: 'german_roach', label: 'German Roach Treatment' };
    if (s.includes('cockroach') || s.includes('roach')) return { tag: 'cockroach', label: 'Cockroach Treatment' };
    if (s.includes('bed bug')) return { tag: 'bed_bug', label: 'Bed Bug Treatment' };
    if (s.includes('fumigat') || s.includes('tent')) return { tag: 'tent_fumigation', label: 'Tent Fumigation' };
    if (s.includes('termite') && !s.includes('inspect') && !s.includes('monitor')) return { tag: 'termite_treatment', label: 'Termite Treatment' };
    if (s.includes('rodent') && s.includes('exclusion')) return { tag: 'rodent_exclusion', label: 'Rodent Exclusion' };
    if (s.includes('mosquito')) return { tag: 'mosquito', label: 'Mosquito Treatment' };
    if (s.includes('lawn')) return { tag: 'lawn', label: 'Lawn Care' };
    if (s.includes('tree') || s.includes('shrub')) return { tag: 'tree_shrub', label: 'Tree & Shrub' };
    if (s.includes('pest')) return { tag: 'pest_general', label: 'Pest Control' };
    return { tag: 'general', label: 'General Service' };
  }

  // WDO — AI property search + AI pre-inspection brief
  async triggerWDOPrep(service) {
    const address = `${service.address_line1}, ${service.city}, FL ${service.zip}`;

    try {
      const propertyData = await lookupPropertyFromAITrio(address).catch((err) => {
        logger.warn('[appointment-tagger] WDO property search failed', {
          serviceId: service.id,
          errorName: err?.name || 'Error',
        });
        return null;
      });

      // Generate brief (simplified — uses template if no Claude API key)
      let brief;
      if (process.env.ANTHROPIC_API_KEY) {
        brief = await this.generateWDOBriefAI(service, propertyData);
      } else {
        brief = this.generateWDOBriefTemplate(service, propertyData);
      }

      await db('scheduled_services').where({ id: service.id }).update({
        pre_service_brief: JSON.stringify(brief),
        pre_service_brief_type: 'wdo_inspection',
        pre_service_brief_generated_at: new Date(),
      });

      await db('customer_interactions').insert({
        customer_id: service.customer_id, interaction_type: 'note',
        subject: 'WDO pre-inspection brief generated',
        body: `Risk: ${brief.risk_score}. Priorities: ${(brief.top_3_priorities || []).join(', ')}`,
      });

      logger.info('[appointment-tagger] WDO brief generated', { serviceId: service.id });
    } catch (err) {
      logger.error('[appointment-tagger] WDO prep failed', {
        serviceId: service.id,
        errorName: err?.name || 'Error',
      });
    }
  }

  generateWDOBriefTemplate(service, rc) {
    const yearBuilt = rc?.yearBuilt || 'Unknown';
    const sqft = rc?.squareFootage || 'Unknown';
    const stories = rc?.stories || 1;
    const foundation = rc?.foundationType || 'Unknown';
    const exterior = rc?.exteriorType || rc?.constructionMaterial || 'Unknown';
    const pool = rc?.features?.pool || rc?.hasPool || false;
    const garage = rc?.garageType || 'Unknown';

    const age = yearBuilt !== 'Unknown' ? new Date().getFullYear() - parseInt(yearBuilt) : null;
    let riskScore = 'Low';
    const vulnerabilities = [];

    if (age && age > 20) { riskScore = 'Moderate'; vulnerabilities.push('Structure 20+ years old — increased exposure time'); }
    if (age && age > 40) { riskScore = 'High'; vulnerabilities.push('Structure 40+ years old — significantly increased risk'); }
    if (String(foundation).toLowerCase().includes('slab')) vulnerabilities.push('Slab foundation — concealed below-grade termite entry possible');
    if (String(exterior).toLowerCase().includes('stucco')) vulnerabilities.push('Stucco exterior — may mask moisture damage at penetrations');
    if (String(exterior).toLowerCase().includes('wood')) { riskScore = 'High'; vulnerabilities.push('Wood exterior — direct WDO target'); }
    if (pool) vulnerabilities.push('Pool area — increased moisture, conducive conditions near deck/cage');

    if (vulnerabilities.length >= 3) riskScore = 'High';
    else if (vulnerabilities.length >= 1) riskScore = 'Moderate';

    return {
      property_summary: { address: `${service.address_line1}, ${service.city}, FL ${service.zip}`, yearBuilt, sqft, stories, foundation, exterior, pool, garage },
      risk_score: riskScore,
      risk_reason: vulnerabilities.length ? vulnerabilities[0] : 'No significant risk factors identified from available data.',
      top_3_priorities: [
        'Inspect foundation perimeter and slab edges for mud tubes',
        `Check ${exterior} to foundation transition for moisture entry`,
        'Inspect garage, utility penetrations, and any wood-to-soil contact',
      ],
      top_3_unknowns: [
        'Prior termite treatment history (ask homeowner)',
        'Attic accessibility and condition',
        'Any additions or modifications since original construction',
      ],
      vulnerabilities,
      homeowner_questions: [
        'Any prior termite treatment or bait stations?',
        'History of roof leaks or plumbing leaks?',
        'Is the attic fully accessible?',
        'Any wood fencing, pergola, or detached structures?',
        'Any areas where you\'ve noticed moisture or soft wood?',
      ],
      property_data: rc ? { yearBuilt: rc.yearBuilt, sqft: rc.squareFootage, lot: rc.lotSize, stories: rc.stories, foundation: rc.foundationType, exterior } : null,
    };
  }

  async generateWDOBriefAI(service, rc) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const resp = await client.messages.create({
        model: MODELS.FLAGSHIP, max_tokens: 4000,
        system: 'You are a pre-inspection research assistant for a Florida pest control company. Analyze public property data and return a JSON WDO pre-inspection brief with: risk_score (Low/Moderate/High), risk_reason, top_3_priorities, top_3_unknowns, vulnerabilities, homeowner_questions. Return VALID JSON ONLY.',
        messages: [{ role: 'user', content: `WDO brief for ${service.address_line1}, ${service.city}, FL ${service.zip}. Client: ${service.first_name} ${service.last_name}. Date: ${service.scheduled_date}.\n\nProperty data: ${JSON.stringify(rc)}` }],
      });

      const text = resp.content[0].text.replace(/```json|```/g, '').trim();
      return JSON.parse(text);
    } catch (err) {
      logger.error('[appointment-tagger] AI WDO brief failed', {
        serviceId: service.id,
        errorName: err?.name || 'Error',
      });
      return this.generateWDOBriefTemplate(service, rc);
    }
  }

  // Pest prep — SMS (Beehiiv email if configured)
  async triggerPestPrep(service, pestType) {
    const prepSMS = await this.getPrepSMS(pestType, service);
    if (!prepSMS) return;

    const prepResult = await sendCustomerMessage({
      to: service.phone,
      body: prepSMS,
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment',
      customerId: service.customer_id,
      appointmentId: service.id,
      identityTrustLevel: 'phone_matches_customer',
      metadata: { original_message_type: 'prep_info', pest_type: pestType },
    });
    if (!prepResult.sent) {
      logger.warn(`[appointment-tagger] Prep SMS blocked/failed for customer ${service.customer_id}: ${prepResult.code || prepResult.reason || 'unknown'}`);
      return;
    }

    // Beehiiv tag if email available
    if (service.email && process.env.BEEHIIV_API_KEY) {
      try {
        await fetch(`https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/subscriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: service.email, reactivate_existing: true, send_welcome_email: false,
            tags: [`prep_${pestType}`],
            custom_fields: [{ name: 'first_name', value: service.first_name }, { name: 'service_date', value: service.scheduled_date }],
          }),
        });
      } catch (e) { logger.error(`Beehiiv tag failed: ${e.message}`); }
    }

    await db('customer_interactions').insert({
      customer_id: service.customer_id, interaction_type: 'sms_outbound',
      subject: `${pestType} prep info sent`, body: `Prep SMS sent for ${pestType} treatment.`,
    });
  }

  async getPrepSMS(pestType, service) {
    // Knex returns DATE columns as Date objects at UTC midnight — formatting
    // that directly in ET names the previous day. Recover the calendar date
    // string and anchor at noon (same as the string branch), guarding both
    // shapes so the template never renders "Invalid Date" in a customer SMS.
    let date = '';
    try {
      const raw = service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString().split('T')[0]
        : service.scheduled_date;
      const d = raw ? new Date(String(raw).split('T')[0] + 'T12:00:00') : null;
      if (d && !isNaN(d.getTime())) {
        date = d.toLocaleDateString('en-US', {
          weekday: 'long', month: 'short', day: 'numeric',
          timeZone: 'America/New_York',
        });
      }
    } catch { date = ''; }
    if (!date) date = 'your scheduled date';

    const templateKey = pestType === 'cockroach'
      ? 'pest_prep_cockroach'
      : pestType === 'bed_bug'
        ? 'pest_prep_bed_bug'
        : null;
    if (!templateKey) return null;
    const body = await renderSmsTemplate(templateKey, {
      first_name: service.first_name || 'there',
      service_date: date,
    }, {
      workflow: 'appointment_tagger_prep',
      entity_type: 'scheduled_service',
      entity_id: service.id,
    });
    if (!body) {
      logger.warn(`[appointment-tagger] ${templateKey} template missing/disabled; prep SMS skipped for service ${service.id}`);
    }
    return body;
  }

  // Welcome sequence for new recurring customers
  async triggerWelcomeSequence(service) {
    const welcomeResult = await sendNewRecurringWelcome({
      customer: {
        id: service.customer_id,
        first_name: service.first_name,
        last_name: service.last_name,
        phone: service.phone,
      },
      scheduledServiceId: service.id,
      recurringPattern: service.recurring_pattern,
      entryPoint: 'appointment_tagger_welcome',
    });
    if (!welcomeResult.sent) {
      return;
    }
  }
}

module.exports = new AppointmentTagger();
