const TWILIO_NUMBERS = require('../../config/twilio-numbers');

exports.up = async function (knex) {
  const sources = [];

  // ── Pest Control Domain Tracking Numbers ──────────────────────
  for (const d of TWILIO_NUMBERS.domainTracking) {
    sources.push({
      name: `${d.domain} — ${d.area}`,
      source_type: 'phone_tracking',
      channel: 'website_organic',
      twilio_phone_number: d.number,
      domain: d.domain,
      landing_page_url: d.page || null,
      cost_type: 'per_month',
      monthly_cost: 2.50, // $1.15 Twilio + $1.35 domain
      is_active: true,
    });
  }

  // ── Lawn Care Domain Tracking Numbers ─────────────────────────
  for (const d of TWILIO_NUMBERS.lawnDomainTracking) {
    sources.push({
      name: `${d.domain} — ${d.area} Lawn`,
      source_type: 'phone_tracking',
      channel: 'website_organic',
      twilio_phone_number: d.number,
      domain: d.domain,
      cost_type: 'per_month',
      monthly_cost: 2.50,
      is_active: true,
    });
  }

  // ── Location Lines ────────────────────────────────────────────
  for (const [locId, loc] of Object.entries(TWILIO_NUMBERS.locations)) {
    // Skip if already added as a domain tracking number
    const alreadyAdded = sources.some(s => s.twilio_phone_number === loc.number);
    if (!alreadyAdded) {
      sources.push({
        name: `${loc.label} — Direct Line`,
        source_type: 'phone_tracking',
        channel: 'direct',
        twilio_phone_number: loc.number,
        cost_type: 'per_month',
        monthly_cost: 1.15,
        is_active: true,
      });
    }
  }

  // ── Van Wrap Tracking ─────────────────────────────────────────
  sources.push({
    name: 'Van Wrap Tracking Number',
    source_type: 'phone_tracking',
    channel: 'offline',
    twilio_phone_number: TWILIO_NUMBERS.tracking.vanWrap.number,
    cost_type: 'per_month',
    monthly_cost: 1.15,
    is_active: true,
  });

  // ── Toll-Free / Customer Chat ─────────────────────────────────
  sources.push({
    name: 'Customer Chat (Toll-Free)',
    source_type: 'phone_tracking',
    channel: 'website_organic',
    twilio_phone_number: TWILIO_NUMBERS.tollFree.number,
    cost_type: 'per_month',
    monthly_cost: 1.15,
    is_active: true,
  });

  // ── Unassigned Numbers ────────────────────────────────────────
  for (const u of TWILIO_NUMBERS.unassigned) {
    sources.push({
      name: `Unassigned — ${u.formatted}`,
      source_type: 'phone_tracking',
      channel: 'other',
      twilio_phone_number: u.number,
      cost_type: 'per_month',
      monthly_cost: 1.15,
      is_active: false,
    });
  }

  // ── Non-Phone Sources ─────────────────────────────────────────
  sources.push({
    name: 'Google Business Profile',
    source_type: 'website_organic',
    channel: 'google',
    cost_type: 'free',
    monthly_cost: 0,
    is_active: true,
    notes: 'GBP calls, messages, and direction requests',
  });

  sources.push({
    name: 'Nextdoor',
    source_type: 'marketplace',
    channel: 'social_organic',
    cost_type: 'free',
    monthly_cost: 0,
    is_active: true,
    notes: 'Nextdoor business page and recommendations',
  });

  sources.push({
    name: 'Customer Referral',
    source_type: 'referral',
    channel: 'referral',
    cost_type: 'per_lead',
    cost_per_lead: 0,
    monthly_cost: 0,
    is_active: true,
    notes: 'Word-of-mouth and referral program leads',
  });

  sources.push({
    name: 'Walk-In',
    source_type: 'walk_in',
    channel: 'offline',
    cost_type: 'free',
    monthly_cost: 0,
    is_active: true,
    notes: 'Customers who walk in or flag down techs',
  });

  sources.push({
    name: 'Yelp',
    source_type: 'marketplace',
    channel: 'marketplace',
    cost_type: 'free',
    monthly_cost: 0,
    is_active: true,
    notes: 'Yelp business listing',
  });

  // Insert all sources
  await knex('lead_sources').insert(sources);
};

exports.down = async function (knex) {
  await knex('lead_sources').del();
};
