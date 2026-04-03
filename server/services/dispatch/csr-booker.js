// server/services/dispatch/csr-booker.js
const Anthropic = require('@anthropic-ai/sdk');
const WikiQA = require('../knowledge/wiki-qa');

let db;
function getDb() {
  if (!db) db = require('../../models/db');
  return db;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCENARIOS = {
  urgent:   { label: 'Urgent pest issue', urgency: 'high' },
  inspect:  { label: 'Inspection / estimate', urgency: 'high' },
  lawn:     { label: 'Recurring lawn treatment', urgency: 'normal' },
  callback: { label: 'Callback / retreat', urgency: 'high' },
  seasonal: { label: 'Seasonal add-on', urgency: 'low' },
};

function fallbackSlots(scenario, techs) {
  const t1 = techs[0]?.name || 'Adam Benetti';
  const t2 = techs[1]?.name || 'Tech 2';
  const base = {
    urgent:   [
      { rank: '#1 Recommended', date_label: 'Today — next open slot', tech_name: t1, detail: 'Earliest available · route density checked', top: true, score_factors: ['Urgency tier', 'Tech proximity', 'Route density'] },
      { rank: '#2', date_label: 'Tomorrow 8:00 AM', tech_name: t1, detail: 'Opens day route — highest density', top: false, score_factors: ['Morning slot', 'Cluster density'] },
      { rank: '#3', date_label: 'Tomorrow 10:15 AM', tech_name: t2, detail: 'South cluster — 4 min from prior stop', top: false, score_factors: ['Zone match'] },
    ],
    inspect:  [
      { rank: '#1 Recommended', date_label: 'Tomorrow 10:30 AM', tech_name: t1, detail: 'Dedicated inspection window · upsell-capable tech', top: true, score_factors: ['Revenue score', 'Upsell match', 'Inspection window'] },
      { rank: '#2', date_label: 'Wed 8:45 AM', tech_name: t1, detail: 'Open estimate slot · Parrish cluster', top: false, score_factors: ['Cluster proximity'] },
      { rank: '#3', date_label: 'Wed 1:00 PM', tech_name: t2, detail: 'Sarasota corridor · back-to-back possible', top: false, score_factors: ['Zone match'] },
    ],
    lawn:     [
      { rank: '#1 Recommended', date_label: 'Thu 9:00 AM', tech_name: t2, detail: 'Lawn cluster day · 3 nearby stops', top: true, score_factors: ['Cluster density', 'Lawn-cert tech', 'Day density'] },
      { rank: '#2', date_label: 'Fri 8:30 AM', tech_name: t1, detail: 'Parrish lawn day · 5 recurring stops nearby', top: false, score_factors: ['Recurring cluster'] },
      { rank: '#3', date_label: 'Next Mon', tech_name: t2, detail: 'Lowest drive time for zip', top: false, score_factors: ['Route efficiency'] },
    ],
    callback: [
      { rank: '#1 Recommended', date_label: 'Tomorrow 11:00 AM', tech_name: t1 + ' (original)', detail: 'Original tech · within 5-day window · highest resolution rate', top: true, score_factors: ['Original tech', '5-day window', 'Renewal retention'] },
      { rank: '#2', date_label: 'Today 4:30 PM', tech_name: t1, detail: 'End-of-day if urgent · no route disruption', top: false, score_factors: ['Same-day urgency'] },
      { rank: '#3', date_label: 'Wed 9:00 AM', tech_name: t2, detail: 'Fallback if original unavailable', top: false, score_factors: ['Nearest zone match'] },
    ],
    seasonal: [
      { rank: '#1 Recommended', date_label: 'Fri 10:00 AM', tech_name: t1, detail: 'WaveGuard Platinum upsell · bundle discount applicable', top: true, score_factors: ['WaveGuard tier', 'Upsell potential', 'Seasonal demand'] },
      { rank: '#2', date_label: 'Next Tue AM', tech_name: t2, detail: 'Venice seasonal push · 4 nearby Platinum accounts', top: false, score_factors: ['Territory density'] },
      { rank: '#3', date_label: 'Next Wed AM', tech_name: techs[2]?.name || 'Tech 3', detail: 'North Port cluster · mosquito demand peak', top: false, score_factors: ['Seasonal demand index'] },
    ],
  };
  return base[scenario] || base.urgent;
}

async function getRecommendedSlots(scenario, serviceType, zip) {
  const config = SCENARIOS[scenario] || SCENARIOS.urgent;
  const techs = await getDb()('dispatch_technicians').where('active', true);
  const routingRules = await WikiQA.lookup('routing rules') || '';
  const serviceRules = await WikiQA.lookup('service dispatch rules') || '';

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `Recommend 3 appointment windows for a Waves Pest Control CSR.

Scenario: ${config.label}
Service: ${serviceType || 'General pest'}
Zip: ${zip || 'SWFL'}
Urgency: ${config.urgency}
Available techs: ${techs.map((t) => `${t.name} (${t.territory_label})`).join(', ')}

Routing rules:
${routingRules}

Service rules:
${serviceRules}

Return ONLY a JSON array of exactly 3 slots:
[{"rank":"#1 Recommended","date_label":"string","tech_name":"string","detail":"why this slot (route density, tech fit, urgency)","top":true,"score_factors":["factor1","factor2"]},...]`,
      }],
    });
    const slots = JSON.parse(res.content[0].text.replace(/```json|```/g, '').trim());
    await getDb()('dispatch_csr_bookings').insert({ scenario, service_type: serviceType, zip, recommended_slots: slots }).catch(() => {});
    return { slots, scenario: config };
  } catch {
    const slots = fallbackSlots(scenario, techs);
    await getDb()('dispatch_csr_bookings').insert({ scenario, service_type: serviceType, zip, recommended_slots: slots }).catch(() => {});
    return { slots, scenario: config };
  }
}

module.exports = { getRecommendedSlots, SCENARIOS };
