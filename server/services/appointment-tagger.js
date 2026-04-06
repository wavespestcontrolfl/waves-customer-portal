const db = require('../models/db');
const TwilioService = require('./twilio');
const logger = require('./logger');

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
        case 'termite_treatment': await this.triggerPestPrep(service, 'termite'); break;
        case 'rodent_exclusion': await this.triggerPestPrep(service, 'rodent'); break;
        case 'tent_fumigation': await this.triggerPestPrep(service, 'fumigation'); break;
      }
    } catch (err) {
      logger.error(`Appointment automation failed for ${type.tag}: ${err.message}`);
    }

    // Check if first service for a recurring customer
    if (service.waveguard_tier && service.waveguard_tier !== 'Bronze') {
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

  // WDO — RentCast + AI pre-inspection brief
  async triggerWDOPrep(service) {
    const address = `${service.address_line1}, ${service.city}, FL ${service.zip}`;

    try {
      // Fetch RentCast data
      const rcResp = await fetch(`https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`, {
        headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY || '6dfcb2eaa9f34bf285e101b74e1a3ef6', Accept: 'application/json' },
      });
      let rentcastData = null;
      if (rcResp.ok) {
        const d = await rcResp.json();
        rentcastData = Array.isArray(d) ? d[0] : d;
      }

      // Generate brief (simplified — uses template if no Claude API key)
      let brief;
      if (process.env.ANTHROPIC_API_KEY) {
        brief = await this.generateWDOBriefAI(service, rentcastData);
      } else {
        brief = this.generateWDOBriefTemplate(service, rentcastData);
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

      logger.info(`WDO brief generated for ${service.address_line1}`);
    } catch (err) {
      logger.error(`WDO prep failed: ${err.message}`);
    }
  }

  generateWDOBriefTemplate(service, rc) {
    const yearBuilt = rc?.yearBuilt || 'Unknown';
    const sqft = rc?.squareFootage || 'Unknown';
    const stories = rc?.stories || 1;
    const foundation = rc?.foundationType || 'Unknown';
    const exterior = rc?.exteriorType || 'Unknown';
    const pool = rc?.features?.pool || false;
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
      rentcast_data: rc ? { yearBuilt: rc.yearBuilt, sqft: rc.squareFootage, lot: rc.lotSize, stories: rc.stories, foundation: rc.foundationType, exterior: rc.exteriorType } : null,
    };
  }

  async generateWDOBriefAI(service, rc) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const resp = await client.messages.create({
        model: 'claude-sonnet-4-20250514', max_tokens: 4000,
        system: 'You are a pre-inspection research assistant for a Florida pest control company. Analyze RentCast data and return a JSON WDO pre-inspection brief with: risk_score (Low/Moderate/High), risk_reason, top_3_priorities, top_3_unknowns, vulnerabilities, homeowner_questions. Return VALID JSON ONLY.',
        messages: [{ role: 'user', content: `WDO brief for ${service.address_line1}, ${service.city}, FL ${service.zip}. Client: ${service.first_name} ${service.last_name}. Date: ${service.scheduled_date}.\n\nRentCast: ${JSON.stringify(rc)}` }],
      });

      const text = resp.content[0].text.replace(/```json|```/g, '').trim();
      return JSON.parse(text);
    } catch (err) {
      logger.error(`AI WDO brief failed: ${err.message}`);
      return this.generateWDOBriefTemplate(service, rc);
    }
  }

  // Pest prep — SMS (Beehiiv email if configured)
  async triggerPestPrep(service, pestType) {
    const prepSMS = this.getPrepSMS(pestType, service);
    if (!prepSMS) return;

    await TwilioService.sendSMS(service.phone, prepSMS, {
      customerId: service.customer_id, messageType: 'prep_info',
    });

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

  getPrepSMS(pestType, service) {
    const date = new Date(service.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const msgs = {
      cockroach: `Hi ${service.first_name}! Your cockroach treatment is ${date}. To prep:\n• Clear under sinks and behind appliances\n• Remove items from cabinet bases\n• Clean food debris, take out trash night before\n• Leave home 2-4h after treatment (pets too)\n• Don't clean treated areas for 2 weeks\nQuestions? Reply here. — Waves`,
      bed_bug: `Hi ${service.first_name}! Bed bug treatment prep for ${date} is CRITICAL:\n• Strip bedding — wash/dry on HIGH HEAT (130°F+)\n• Remove items from nightstands/dressers near bed\n• Pull beds 6" from walls\n• Bag all clothing — wash/dry HIGH HEAT\n• Vacuum mattress, box spring, baseboards — empty vacuum outside\n• DO NOT move items to other rooms\nQuestions? Reply here. — Adam, Waves`,
      termite: `Hi ${service.first_name}! Termite treatment on ${date}. To prep:\n• Clear items 18" from interior perimeter walls\n• Move items from garage walls\n• Trim vegetation 12" from foundation\n• Ensure all rooms accessible\n• We may drill through garage concrete — clear vehicle access\nTreatment takes 3-5h. You can stay home. — Waves`,
      rodent: `Hi ${service.first_name}! Rodent exclusion on ${date}. To prep:\n• Note where you've heard/seen activity\n• Clear around exterior foundation for inspection\n• Clear path to attic access\n• Secure pet food in sealed containers\n• Save photos of droppings/gnaw marks\nInspection takes 60-90 min. — Waves`,
      fumigation: `Hi ${service.first_name}! Tent fumigation on ${date}. CRITICAL PREP:\n• Vacate home 2-3 days (ALL pets, plants, fish)\n• Double-bag ALL food/medicine in Nylofume bags (we provide)\n• Open all interior doors, drawers, cabinets\n• Turn off all gas/pilot lights\n• Remove bedding from mattresses\n• Trim vegetation 18" from structure\n• Arrange lodging\nCall (941) 318-7612 with questions. — Adam, Waves`,
    };
    return msgs[pestType];
  }

  // Welcome sequence for new recurring customers
  async triggerWelcomeSequence(service) {
    const sent = await db('sms_sequences').where({ customer_id: service.customer_id, sequence_type: 'new_customer_welcome' }).first();
    if (sent) return;

    const tier = service.waveguard_tier;
    const perks = { Platinum: 'unlimited callbacks, priority scheduling, 30% off, $500K termite guarantee', Gold: 'unlimited callbacks, priority scheduling, 20% off', Silver: 'unlimited callbacks, 15% off', Bronze: 'unlimited callbacks, 10% off' }[tier] || 'regular scheduled service';

    await TwilioService.sendSMS(service.phone,
      `Welcome to the Waves family, ${service.first_name}! 🌊\n\nYour first ${service.service_type || 'service'} is coming up. Your WaveGuard ${tier || ''} includes ${perks}.\n\nYour tech will text when en route. After service, you'll get a detailed report.\n\nPortal: wavespestcontrol.com/portal\nQuestions? Reply here. — Adam, Waves`,
      { customerId: service.customer_id, messageType: 'welcome' }
    );

    await db('sms_sequences').insert({ customer_id: service.customer_id, sequence_type: 'new_customer_welcome', status: 'completed' });
    await db('customer_interactions').insert({ customer_id: service.customer_id, interaction_type: 'sms_outbound', subject: 'Welcome SMS sent' });
  }
}

module.exports = new AppointmentTagger();
